-- =====================================================================================
-- Cadastro persistente de clientes — FASE 1, PASSO 1 de 3: estrutura, sincronização
-- automática e RPCs administrativas SOMENTE LEITURA. SEM FK para orders e SEM backfill.
--   Passo 2 (transação própria, SÓ a FK):  20261009100050_add_customer_links_order_fk.sql
--   Passo 3 (transação própria, backfill): 20261009100100_backfill_customer_registry.sql
--
-- Modelo:
--   customers              — cadastro: nome + telefone irlandês normalizado (cliente
--                            "cadastrado"). Cliente sem telefone NÃO vira linha aqui: é
--                            representado pelos seus pedidos sem vínculo ("não cadastrado"),
--                            nunca agrupados automaticamente pelo nome.
--   order_customer_links   — vínculo atual de cada pedido (PK = order_id: no máximo 1).
--                            state 'excluded' = desvinculado por admin (Fase 2); a
--                            sincronização automática nunca revincula esse pedido.
--   customer_link_audit    — auditoria somente-inclusão (quem/quando/o quê).
--
-- Regra automática (ÚNICA implementação: _customer_registry_link_by_phone):
--   pedido com nome + telefone irlandês válido e sem linha em order_customer_links
--   -> cliente ativo com o mesmo (nome normalizado, telefone normalizado), criado se não
--   existir -> vínculo. Usada pelo backfill (passo 3) e por sync_phone_customer_links().
--   Pedido sem telefone NUNCA é vinculado automaticamente (mesmo nome não autoriza).
--
-- O que esta migration NÃO faz: não altera orders (nenhuma coluna, índice, trigger,
-- UPDATE ou valor), nem order_items, nem nenhuma RPC existente (criação de pedidos
-- site/WhatsApp, status, pagamentos, Kanban/Realtime, impressão Epson intocados).
--
-- Locks em orders neste passo: só ACCESS SHARE (leitura do catálogo/validação das funções
-- SQL que citam orders, order_items e order_item_selections), mantido até o COMMIT e
-- compatível com SELECT/INSERT/UPDATE/DELETE de pedidos. Conflita apenas com ACCESS
-- EXCLUSIVE (DDL pesado em orders), que não faz parte da operação do Larica.
-- O único lock que bloqueia ESCRITA em orders (SHARE ROW EXCLUSIVE da FK) fica isolado
-- no passo 2, em que o ALTER TABLE é a única instrução da transação.
--
-- Sobre lock_timeout: ele limita só o tempo de ESPERA para obter um lock — não quanto
-- tempo um lock obtido fica retido (isso vai até o COMMIT). Por isso a duração é
-- controlada pela estrutura (nenhum comando demorado depois de um lock forte e antes do
-- COMMIT) e, onde cabe, por statement_timeout.
--
-- Sem DROP / OR REPLACE / IF NOT EXISTS: se qualquer objeto com os mesmos nomes já
-- existir, a migration aborta no primeiro passo com mensagem clara e nada é alterado.
--
-- Arquivo SQL puro, SEM NENHUMA barra invertida (o escape do LIKE usa ESCAPE '#'): se
-- uma cópia exibir barra invertida antes de hífen, sublinhado, til ou asterisco, é
-- artefato de renderização Markdown — use este arquivo, não a cópia.
--
-- Aplicação manual no SQL Editor: colar o arquivo inteiro entre `begin;` e `commit;`.
-- Rollback (manual, nunca automático), em duas transações separadas e nesta ordem:
--   1) supabase/rollback/20261009100000_customer_registry_down_1_fk.sql      (só a FK)
--   2) supabase/rollback/20261009100000_customer_registry_down_2_objetos.sql (o restante)
-- =====================================================================================


-- =====================================================================================
-- 0) Guarda de conflito de nomes
-- =====================================================================================

DO $guard$
declare
  v_conflitos text;
begin
  select string_agg(obj, ', ' order by obj)
    into v_conflitos
  from (
    select format('relação public.%I (relkind %s)', c.relname, c.relkind) as obj
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
        'customers', 'customers_pkey', 'customers_identity_active_uq', 'customers_name_key_idx', 'customers_phone_e164_idx',
        'order_customer_links', 'order_customer_links_pkey', 'order_customer_links_customer_idx',
        'customer_link_audit', 'customer_link_audit_pkey', 'customer_link_audit_id_seq',
        'customer_link_audit_customer_idx', 'customer_link_audit_order_idx', 'customer_link_audit_order_deleted_uq'
      ])
    union all
    select format('tipo public.%I', t.typname)
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = any (array['customers', 'order_customer_links', 'customer_link_audit'])
      and t.typrelid = 0
    union all
    select format('função public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'normalize_customer_name', 'normalize_customer_phone',
        '_customer_link_audit_immutable', '_customer_links_audit_on_delete',
        '_customer_registry_link_by_phone', '_customer_registry_reconcile_deleted_orders',
        '_customer_orders_json', '_customer_top_products_json',
        'sync_phone_customer_links', 'get_customers_overview', 'list_customers', 'get_customer_detail'
      ])
  ) s;

  if v_conflitos is not null then
    raise exception using
      message = 'Migration de clientes interrompida: já existem objetos com estes nomes: ' || v_conflitos
                || '. Nada foi alterado — verifique esses objetos antes de prosseguir.';
  end if;
end;
$guard$;

-- Pré-condições de privilégio/RLS. As funções SECURITY DEFINER criadas aqui rodam como o
-- papel que aplica a migration (current_user = dono). Esse papel precisa: ler orders e
-- filhas, referenciar orders (FK do passo 2), executar is_admin()/auth.uid(); e as leituras
-- de orders/filhas NÃO podem ser filtradas por RLS (FORCE RLS, ou RLS ativa sem o papel ser
-- dono nem ter BYPASSRLS), senão backfill/sincronização/relatórios dariam resultado
-- incompleto em silêncio. Qualquer falha -> aborta com mensagem clara, nada é criado.
DO $precondicoes$
declare
  v_faltas text;
  v_rls text;
  v_bypass boolean;
begin
  select string_agg(item, '; ')
    into v_faltas
  from (
    select 'SELECT em public.orders' as item where not has_table_privilege(current_user, 'public.orders', 'SELECT')
    union all
    select 'REFERENCES em public.orders' where not has_table_privilege(current_user, 'public.orders', 'REFERENCES')
    union all
    select 'SELECT em public.order_items' where not has_table_privilege(current_user, 'public.order_items', 'SELECT')
    union all
    select 'SELECT em public.order_item_selections' where not has_table_privilege(current_user, 'public.order_item_selections', 'SELECT')
    union all
    select 'EXECUTE em public.is_admin()' where not has_function_privilege(current_user, 'public.is_admin()', 'EXECUTE')
    union all
    select 'EXECUTE em auth.uid()' where not has_function_privilege(current_user, 'auth.uid()', 'EXECUTE')
  ) f;

  if v_faltas is not null then
    raise exception 'Migration de clientes interrompida: o papel % não tem: %. Nada foi alterado.', current_user, v_faltas;
  end if;

  select r.rolbypassrls into v_bypass from pg_roles r where r.rolname = current_user;

  select string_agg(c.relname, ', ')
    into v_rls
  from pg_class c
  where c.oid in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.order_item_selections'::regclass)
    and c.relrowsecurity
    and (c.relforcerowsecurity or (c.relowner <> (select oid from pg_roles where rolname = current_user) and not coalesce(v_bypass, false)));

  if v_rls is not null then
    raise exception 'Migration de clientes interrompida: a RLS filtraria as leituras do papel % em: % (FORCE RLS, ou papel não é dono e não tem BYPASSRLS). As funções SECURITY DEFINER dariam resultado incompleto. Nada foi alterado.', current_user, v_rls;
  end if;
end;
$precondicoes$;

-- Nenhum comando deste passo pega lock conflitante com escrita em orders; o limite só
-- evita espera indefinida caso alguém esteja rodando DDL pesado em orders ao mesmo tempo.
SET lock_timeout = '5s';


-- =====================================================================================
-- 1) Normalização (IMMUTABLE; GRANT a PUBLIC: funções puras, sem acesso a dados)
-- =====================================================================================

-- Nome: NBSP/tab/quebras -> espaço, trim, espaços repetidos -> 1, minúsculas.
-- Acentos e variações NÃO são unificados ("João" <> "Joao", "Ana" <> "Ana Silva").
CREATE FUNCTION public.normalize_customer_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select nullif(
    lower(
      regexp_replace(
        btrim(translate(coalesce(p_name, ''), chr(160) || chr(9) || chr(10) || chr(13), '    ')),
        '[[:space:]]+', ' ', 'g'
      )
    ),
    ''
  );
$function$;

-- Telefone irlandês -> '353' + número nacional sem o 0. Aceita 087 123 4567,
-- +353 87 123 4567, 353871234567 (WhatsApp), 00353..., +353 (0)87..., 87 123 4567,
-- 01 234 5678. Qualquer outra coisa (estrangeiro, curto, lixo) -> NULL.
CREATE FUNCTION public.normalize_customer_phone(p_phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select case
    when e ~ '^353[1-9][0-9]{6,8}$' then e
    when e ~ '^0[1-9][0-9]{6,8}$' then '353' || substr(e, 2)
    when e ~ '^8[3-9][0-9]{7}$' then '353' || e
    else null
  end
  from (
    select case when d ~ '^3530' then '353' || substr(d, 5) else d end as e
    from (
      select case when d0 ~ '^00' then substr(d0, 3) else d0 end as d
      from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d0) a
    ) b
  ) c;
$function$;

GRANT EXECUTE ON FUNCTION public.normalize_customer_name(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_customer_phone(text) TO PUBLIC;


-- =====================================================================================
-- 2) Tabelas
-- =====================================================================================

CREATE TABLE public.customers (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  display_name  text        NOT NULL,
  name_key      text        GENERATED ALWAYS AS (public.normalize_customer_name(display_name)) STORED,
  phone_e164    text        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  source        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NULL,   -- auth.uid() de quem disparou (admin na sincronização); NULL = backfill da migration
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NULL,
  CONSTRAINT customers_pkey PRIMARY KEY (id),
  CONSTRAINT customers_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT customers_name_key_check CHECK (name_key IS NOT NULL),
  -- Regex (e não "= normalize_customer_phone(...)"): um CHECK que resulta NULL passa,
  -- então a comparação com a função aceitaria telefone inválido. Este regex é
  -- exatamente o conjunto de saídas válidas de normalize_customer_phone().
  CONSTRAINT customers_phone_e164_check CHECK (phone_e164 ~ '^353[1-9][0-9]{6,8}$'),
  CONSTRAINT customers_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT customers_source_check CHECK (source IN ('backfill', 'auto_phone', 'admin'))
);

-- Mesmo nome + mesmo telefone = 1 cadastro ativo. Mesmo nome com outro telefone e mesmo
-- telefone com outro nome são permitidos (sinalizados como alerta, nunca bloqueados).
CREATE UNIQUE INDEX customers_identity_active_uq ON public.customers (name_key, phone_e164) WHERE status = 'active';
CREATE INDEX customers_name_key_idx ON public.customers (name_key);
CREATE INDEX customers_phone_e164_idx ON public.customers (phone_e164);

CREATE TABLE public.order_customer_links (
  order_id      uuid        NOT NULL,
  order_number  bigint      NOT NULL,   -- snapshot: auditoria continua legível após excluir o pedido
  state         text        NOT NULL,
  customer_id   uuid        NULL,
  link_source   text        NOT NULL,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  linked_by     uuid        NULL,
  CONSTRAINT order_customer_links_pkey PRIMARY KEY (order_id),
  -- A FK para orders (ON DELETE CASCADE) é criada no passo 2, sozinha na transação, para
  -- o lock que bloqueia escrita em orders não ficar retido por nenhum outro comando.
  CONSTRAINT order_customer_links_customer_fk FOREIGN KEY (customer_id) REFERENCES public.customers (id) ON DELETE RESTRICT,
  CONSTRAINT order_customer_links_state_check CHECK (state IN ('linked', 'excluded')),
  CONSTRAINT order_customer_links_state_customer_check CHECK (
    (state = 'linked' AND customer_id IS NOT NULL) OR (state = 'excluded' AND customer_id IS NULL)
  ),
  CONSTRAINT order_customer_links_source_check CHECK (link_source IN ('backfill', 'auto_phone', 'admin'))
);

CREATE INDEX order_customer_links_customer_idx ON public.order_customer_links (customer_id) WHERE state = 'linked';

CREATE TABLE public.customer_link_audit (
  id                    bigint      GENERATED ALWAYS AS IDENTITY,
  batch_id              uuid        NOT NULL,
  action                text        NOT NULL,
  order_id              uuid        NULL,   -- sem FK: o histórico sobrevive à exclusão do pedido
  order_number          bigint      NULL,
  customer_id           uuid        NULL,   -- sem FK: o histórico nunca bloqueia operações
  previous_customer_id  uuid        NULL,
  actor                 uuid        NULL,   -- auth.uid(); NULL = sistema (backfill/migration)
  acted_at              timestamptz NOT NULL DEFAULT now(),
  reason                text        NULL,
  details               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT customer_link_audit_pkey PRIMARY KEY (id),
  CONSTRAINT customer_link_audit_action_check CHECK (action IN (
    'backfill', 'auto_link', 'customer_created', 'link', 'unlink', 'order_deleted', 'link_deleted'
  ))
);

CREATE INDEX customer_link_audit_customer_idx ON public.customer_link_audit (customer_id, acted_at DESC);
CREATE INDEX customer_link_audit_order_idx ON public.customer_link_audit (order_id, acted_at DESC);

-- Um pedido só é excluído uma vez: no máximo 1 'order_deleted' por pedido. Garantia no
-- banco (não só no código) contra duplicidade entre o trigger e a reconciliação, ou entre
-- reconciliações concorrentes. O trigger trata uma eventual violação como falha de
-- auditoria (WARNING) sem impedir a exclusão; a reconciliação usa ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX customer_link_audit_order_deleted_uq
  ON public.customer_link_audit (order_id) WHERE action = 'order_deleted';


-- =====================================================================================
-- 3) Auditoria: imutabilidade + registro de exclusões
-- =====================================================================================

-- Somente inclusão: qualquer UPDATE/DELETE de linha da auditoria é recusado.
CREATE FUNCTION public._customer_link_audit_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'Auditoria de vínculos de clientes é somente inclusão (% bloqueado).', tg_op;
end;
$function$;

CREATE TRIGGER customer_link_audit_immutable
  BEFORE UPDATE OR DELETE ON public.customer_link_audit
  FOR EACH ROW EXECUTE FUNCTION public._customer_link_audit_immutable();

-- Registra a remoção de um vínculo. Caminho esperado: DELETE em orders (Histórico, como
-- authenticated sob a RLS de orders) -> ON DELETE CASCADE. A ação em cascata da FK roda
-- como o DONO de order_customer_links e ignora RLS, então quem exclui o pedido não precisa
-- de grant nesta tabela. Esta função é SECURITY DEFINER (dono = dono das tabelas), então o
-- INSERT na auditoria também não depende de grant/RLS de quem excluiu. auth.uid() continua
-- sendo o usuário da requisição (claims da sessão), gravado como actor.
-- 'order_deleted' quando o pedido já não existe (cascata); 'link_deleted' caso contrário.
--
-- Prioridade operacional: este trigger roda DENTRO da transação de exclusão do pedido.
-- Se o INSERT na auditoria falhasse e o erro subisse, a exclusão do pedido no Histórico
-- falharia — o cadastro de clientes passaria a interferir numa funcionalidade existente.
-- Por isso o INSERT fica num bloco com EXCEPTION (subtransação): se falhar (qualquer erro
-- exceto cancelamento/timeout de comando, que continuam abortando normalmente), a exclusão
-- prossegue e o problema é registrado como WARNING no log do Postgres (com pedido, número
-- e cliente). A auditoria NÃO se perde em silêncio: _customer_registry_reconcile_deleted_orders()
-- (executada a cada sincronização) detecta vínculos auditados cujo pedido sumiu sem registro
-- de remoção e grava o 'order_deleted' faltante (details.reconciled = true; actor
-- desconhecido nesse caso raro).
CREATE FUNCTION public._customer_links_audit_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin
    insert into public.customer_link_audit
      (batch_id, action, order_id, order_number, customer_id, previous_customer_id, actor, details)
    values (
      gen_random_uuid(),
      case when exists (select 1 from public.orders o where o.id = old.order_id) then 'link_deleted' else 'order_deleted' end,
      old.order_id,
      old.order_number,
      old.customer_id,
      old.customer_id,
      auth.uid(),
      jsonb_build_object('state', old.state, 'link_source', old.link_source, 'linked_at', old.linked_at)
    );
  exception
    when others then
      raise warning 'customer_link_audit: falha ao auditar a remoção do vínculo do pedido % (#%, cliente %): % [SQLSTATE %]. A exclusão prossegue; a próxima sincronização registra a auditoria pendente.',
        old.order_id, old.order_number, old.customer_id, sqlerrm, sqlstate;
  end;
  return old;
end;
$function$;

CREATE TRIGGER customer_links_audit_on_delete
  AFTER DELETE ON public.order_customer_links
  FOR EACH ROW EXECUTE FUNCTION public._customer_links_audit_on_delete();


-- =====================================================================================
-- 4) Regra automática nome + telefone (interna — única implementação)
-- =====================================================================================
-- p_source: 'backfill' (migration) | 'auto_phone' (sincronização). p_limit NULL = todos.
-- Candidatos: pedidos (qualquer status) SEM NENHUMA linha em order_customer_links — então
-- 'excluded' (desvinculado por admin) é respeitado — com nome e telefone irlandês válidos.
-- FOR KEY SHARE SKIP LOCKED: impede que o pedido seja excluído no meio (o que quebraria a
-- FK do vínculo) e pula pedidos em exclusão; NÃO conflita com UPDATE de status/impressão/
-- pagamento (FOR NO KEY UPDATE). Nunca escreve em orders.
-- Concorrência (sem depender da RPC pública): a própria função pega o advisory lock de
-- transação 'larica.customer_registry' (bloqueante, reentrante — a sincronização já o
-- detém via TRY), então chamadas diretas pelo dono (backfill) e sincronizações se
-- serializam. Barreiras finais no banco: índice único de customers e PK de
-- order_customer_links (ON CONFLICT DO NOTHING em ambos) — mesmo sem o lock, nada duplica.
-- Recusa rodar se a FK para orders (passo 2) não existir: vínculo sem FK não seria
-- removido junto com o pedido.

CREATE FUNCTION public._customer_registry_link_by_phone(p_source text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch uuid := gen_random_uuid();
  v_limit integer := case when p_limit is null then null else greatest(p_limit, 1) end;
  v_candidatos jsonb;
  v_customers_created integer := 0;
  v_linked integer := 0;
  v_remaining integer := 0;
begin
  if p_source is null or p_source not in ('backfill', 'auto_phone') then
    raise exception 'Origem de vínculo automático inválida: %', p_source;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.order_customer_links'::regclass
      and conname = 'order_customer_links_order_fk'
  ) then
    raise exception 'Vínculo automático indisponível: a FK order_customer_links_order_fk (passo 2) ainda não foi criada.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.customer_registry'));

  with cand as (
    select o.id,
           o.order_number::bigint as order_number,
           o.created_at,
           o.customer_name,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk
    from public.orders o
    where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
      and public.normalize_customer_name(o.customer_name) is not null
      and public.normalize_customer_phone(o.customer_phone) is not null
    order by o.created_at, o.id
    limit v_limit
    for key share of o skip locked
  )
  select coalesce(jsonb_agg(to_jsonb(cand)), '[]'::jsonb) into v_candidatos from cand;

  if jsonb_array_length(v_candidatos) > 0 then
    -- Cadastros que ainda não existem (nome = original mais recente do par)
    with c as (
      select * from jsonb_to_recordset(v_candidatos)
        as x(id uuid, order_number bigint, created_at timestamptz, customer_name text, nk text, pk text)
    ),
    pares as (
      select c.pk,
             (array_agg(btrim(c.customer_name) order by c.created_at desc, c.order_number desc))[1] as nome
      from c
      group by c.nk, c.pk
    ),
    ins as (
      insert into public.customers (display_name, phone_e164, source, created_by, updated_by)
      select p.nome, p.pk, p_source, auth.uid(), auth.uid()
      from pares p
      on conflict (name_key, phone_e164) where status = 'active' do nothing
      returning id, display_name, phone_e164
    ),
    aud as (
      insert into public.customer_link_audit (batch_id, action, customer_id, actor, details)
      select v_batch, 'customer_created', ins.id, auth.uid(),
             jsonb_build_object('source', p_source, 'display_name', ins.display_name, 'phone_e164', ins.phone_e164)
      from ins
      returning 1
    )
    select count(*) into v_customers_created from aud;

    -- Vínculos (statement separado: enxerga os cadastros recém-criados)
    with c as (
      select * from jsonb_to_recordset(v_candidatos)
        as x(id uuid, order_number bigint, created_at timestamptz, customer_name text, nk text, pk text)
    ),
    ins as (
      insert into public.order_customer_links (order_id, order_number, state, customer_id, link_source, linked_by)
      select c.id, c.order_number, 'linked', cu.id, p_source, auth.uid()
      from c
      join public.customers cu
        on cu.name_key = c.nk and cu.phone_e164 = c.pk and cu.status = 'active'
      on conflict (order_id) do nothing
      returning order_id, order_number, customer_id
    ),
    aud as (
      insert into public.customer_link_audit (batch_id, action, order_id, order_number, customer_id, actor, details)
      select v_batch,
             case when p_source = 'backfill' then 'backfill' else 'auto_link' end,
             ins.order_id, ins.order_number, ins.customer_id, auth.uid(),
             jsonb_build_object('source', p_source, 'rule', 'name+phone')
      from ins
      returning 1
    )
    select count(*) into v_linked from aud;
  end if;

  select count(*) into v_remaining
  from public.orders o
  where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
    and public.normalize_customer_name(o.customer_name) is not null
    and public.normalize_customer_phone(o.customer_phone) is not null;

  return jsonb_build_object(
    'linked', v_linked,
    'customers_created', v_customers_created,
    'remaining', v_remaining,
    'batch_id', v_batch
  );
end;
$function$;


-- =====================================================================================
-- 4b) Reconciliação da auditoria de exclusões (interna)
-- =====================================================================================
-- Para cada pedido cuja ÚLTIMA criação de vínculo foi auditada (backfill/auto_link/link) e
-- que: (a) não existe mais em orders, (b) não tem linha em order_customer_links e (c) não
-- tem 'order_deleted'/'link_deleted' auditado DEPOIS dessa criação -> grava o
-- 'order_deleted' que o trigger não conseguiu gravar. Só insere na auditoria; nunca
-- lê/escreve dados de pedido além de checar existência.
-- Concorrência, sem depender do lock da RPC pública (o dono pode chamar esta função
-- direto): (1) advisory lock de transação próprio e bloqueante
-- 'larica.customer_registry.reconcile' — chamadas concorrentes se serializam e, em READ
-- COMMITTED, o INSERT da segunda já enxerga o que a primeira gravou; (2) barreira no
-- banco: índice único customer_link_audit_order_deleted_uq + ON CONFLICT DO NOTHING.
-- Ordem de locks sem ciclo: a sincronização pega 'larica.customer_registry' e depois este;
-- ninguém pega na ordem inversa.

CREATE FUNCTION public._customer_registry_reconcile_deleted_orders(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch uuid := gen_random_uuid();
  v_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('larica.customer_registry.reconcile'));

  with ultima_criacao as (
    select distinct on (a.order_id) a.id, a.order_id, a.order_number, a.customer_id
    from public.customer_link_audit a
    where a.order_id is not null
      and a.action in ('backfill', 'auto_link', 'link')
    order by a.order_id, a.id desc
  ),
  pendentes as (
    select u.*
    from ultima_criacao u
    where not exists (select 1 from public.orders o where o.id = u.order_id)
      and not exists (select 1 from public.order_customer_links l where l.order_id = u.order_id)
      and not exists (
        select 1 from public.customer_link_audit d
        where d.order_id = u.order_id
          and d.action in ('order_deleted', 'link_deleted')
          and d.id > u.id
      )
    order by u.id
    limit greatest(coalesce(p_limit, 500), 1)
  ),
  ins as (
    insert into public.customer_link_audit
      (batch_id, action, order_id, order_number, customer_id, previous_customer_id, actor, details)
    select v_batch, 'order_deleted', p.order_id, p.order_number, p.customer_id, p.customer_id, null,
           jsonb_build_object('reconciled', true,
                              'note', 'Exclusão detectada pela sincronização: o trigger não conseguiu auditar no momento da exclusão (ver WARNING no log). Autor desconhecido.')
    from pendentes p
    on conflict (order_id) where action = 'order_deleted' do nothing
    returning 1
  )
  select count(*) into v_count from ins;

  return v_count;
end;
$function$;


-- =====================================================================================
-- 5) Sincronização (RPC admin) — pedidos novos com nome + telefone
-- =====================================================================================
-- Idempotente, limitada (1..500 por chamada), não espera: se outra sincronização estiver
-- rodando, devolve skipped/busy na hora (advisory lock TRY). lock_timeout de 2s local à
-- transação: nunca fica presa atrás de lock de pedido. Qualquer erro desfaz tudo (bloco
-- com EXCEPTION = subtransação) e é devolvido ao frontend, que segue para a leitura.
-- O tempo total também é limitado pelo statement_timeout do papel authenticated.

CREATE FUNCTION public.sync_phone_customer_links(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  perform set_config('lock_timeout', '2s', true);

  if not pg_try_advisory_xact_lock(hashtext('larica.customer_registry')) then
    return jsonb_build_object('skipped', true, 'reason', 'busy', 'linked', 0, 'customers_created', 0);
  end if;

  begin
    v_result := public._customer_registry_link_by_phone('auto_phone', least(greatest(coalesce(p_limit, 200), 1), 500))
                || jsonb_build_object('reconciled_deletions', public._customer_registry_reconcile_deleted_orders(500));
  exception
    when lock_not_available then
      return jsonb_build_object('skipped', true, 'reason', 'lock_timeout', 'linked', 0, 'customers_created', 0);
  end;

  return v_result || jsonb_build_object('skipped', false);
end;
$function$;


-- =====================================================================================
-- 6) Auxiliares internas de leitura (JSON de pedidos e ranking de produtos)
-- =====================================================================================

-- Pedidos (com itens e seleções) de um conjunto de ids, mais recente primeiro.
CREATE FUNCTION public._customer_orders_json(p_order_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'order_number', p.order_number,
           'status', p.status,
           'created_at', p.created_at,
           'completed_at', p.completed_at,
           'cancelled_at', p.cancelled_at,
           'cancel_reason', p.cancel_reason,
           'customer_name', p.customer_name,
           'customer_phone', p.customer_phone,
           'fulfilment_type', p.fulfilment_type,
           'payment_method', p.payment_method,
           'subtotal', p.subtotal,
           'delivery_fee', p.delivery_fee,
           'discount_amount', p.discount_amount,
           'total', p.total,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_id', i.product_id,
                      'product_name', i.product_name,
                      'item_type', i.item_type,
                      'quantity', i.quantity,
                      'total_price', i.total_price,
                      'selections', coalesce((
                        select jsonb_agg(jsonb_build_object(
                                 'selection_type', s.selection_type,
                                 'selected_product_name', s.selected_product_name,
                                 'quantity', s.quantity,
                                 'extra_price', s.extra_price
                               ) order by s.selection_type, s.selected_product_name)
                        from public.order_item_selections s
                        where s.order_item_id = i.id
                      ), '[]'::jsonb)
                    ) order by i.item_type, i.product_name)
             from public.order_items i
             where i.order_id = p.id
           ), '[]'::jsonb)
         ) order by p.created_at desc, p.order_number desc), '[]'::jsonb)
  from public.orders p
  where p.id = any (p_order_ids);
$function$;

-- Top 10 produtos (nível order_items; combo conta como combo) dos pedidos FINALIZADOS do
-- conjunto. items_value = soma de order_items.total_price ("valor em itens": antes de
-- cupom, sem taxa de entrega — não fecha com orders.total de propósito).
CREATE FUNCTION public._customer_top_products_json(p_order_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(t order by t.quantity desc, t.product_name), '[]'::jsonb)
  from (
    select (array_agg(i.product_name order by o.created_at desc))[1] as product_name,
           sum(i.quantity) as quantity,
           count(distinct o.id) as orders_count,
           coalesce(sum(i.total_price), 0) as items_value
    from public.orders o
    join public.order_items i on i.order_id = o.id
    where o.id = any (p_order_ids)
      and o.status = 'completed'
    group by coalesce(i.product_id::text, i.product_name)
    order by sum(i.quantity) desc, 1
    limit 10
  ) t;
$function$;


-- =====================================================================================
-- 7) RPCs administrativas de leitura
-- =====================================================================================
-- Métricas: só pedidos status = 'completed' VINCULADOS (state 'linked') a cliente ativo.
-- Total 0 conta normalmente. Cancelados/em andamento aparecem só no histórico da ficha.
-- "Não cadastrado": pedido finalizado sem vínculo (ou desvinculado) que não será vinculado
-- automaticamente. "Aguardando sincronização": pedido com nome + telefone válidos ainda
-- sem linha de vínculo (a próxima sync_phone_customer_links() o vincula).

CREATE FUNCTION public.get_customers_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  with ativos as (
    select c.id, c.name_key, c.phone_e164
    from public.customers c
    where c.status = 'active'
  ),
  vinculados as (
    select l.customer_id, o.total::numeric as total
    from public.order_customer_links l
    join public.orders o on o.id = l.order_id
    join ativos a on a.id = l.customer_id
    where l.state = 'linked'
      and o.status = 'completed'
  ),
  por_cliente as (
    select customer_id, count(*) as n
    from vinculados
    group by customer_id
  ),
  sem_vinculo as (
    select o.status, o.total::numeric as total, l.state,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where l.order_id is null or l.state = 'excluded'
  ),
  pendentes as (
    select * from sem_vinculo
    where state is null and nk is not null and pk is not null
  ),
  nao_cadastrados as (
    select * from sem_vinculo
    where status = 'completed'
      and not (state is null and nk is not null and pk is not null)
  )
  select jsonb_build_object(
    'registered_customers',      (select count(*) from ativos),
    'buying_customers',          (select count(*) from por_cliente),
    'recurring_customers',       (select count(*) from por_cliente where n >= 2),
    'orders_count',              (select count(*) from vinculados),
    'total_spent',               (select coalesce(sum(total), 0) from vinculados),
    'avg_ticket',                (select case when count(*) > 0 then round(coalesce(sum(total), 0) / count(*), 2) else 0 end from vinculados),
    'unregistered_orders',       (select count(*) from nao_cadastrados),
    'unregistered_total',        (select coalesce(sum(total), 0) from nao_cadastrados),
    'unregistered_names',        (select count(distinct nk) from nao_cadastrados),
    'unregistered_name_matches', (select count(distinct n.nk) from nao_cadastrados n where exists (select 1 from ativos a where a.name_key = n.nk)),
    'pending_sync_orders',       (select count(*) from pendentes),
    'repeated_names',            (select count(*) from (select name_key from ativos group by name_key having count(*) > 1) x),
    'shared_phones',             (select count(*) from (select phone_e164 from ativos group by phone_e164 having count(*) > 1) y)
  )
  into v_result;

  return v_result;
end;
$function$;

-- Lista paginada: 1 linha por cliente ATIVO (inclusive sem compras) + 1 linha por pedido
-- finalizado sem vínculo (kind 'unregistered', nunca agrupado pelo nome) ou aguardando
-- sincronização (kind 'pending').
-- p_sort:   'name_asc' (padrão) | 'orders_desc' | 'spent_desc' | 'last_desc'
-- p_filter: 'all' (padrão) | 'registered' | 'buyers' | 'unregistered' | 'duplicates'
-- p_search: com letras -> parte do nome normalizado; só dígitos -> parte do telefone
--           ("087..." também casa com "35387...").
CREATE FUNCTION public.list_customers(
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'name_asc',
  p_filter text DEFAULT 'all',
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := case when p_sort in ('name_asc', 'orders_desc', 'spent_desc', 'last_desc') then p_sort else 'name_asc' end;
  v_filter text := case when p_filter in ('all', 'registered', 'buyers', 'unregistered', 'duplicates') then p_filter else 'all' end;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_name_like text;
  v_digits text;
  v_digits_sem_zero text;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  -- Padrões LIKE: o termo digitado é tratado como texto literal. Caractere de escape '#'
  -- (usado com "like ... escape '#'"): '#' -> '##', '%' -> '#%', '_' -> '#_'.
  if v_search is not null then
    if v_search ~ '[[:alpha:]]' then
      v_name_like := '%' || replace(replace(replace(public.normalize_customer_name(v_search), '#', '##'), '%', '#%'), '_', '#_') || '%';
    else
      v_digits := nullif(regexp_replace(v_search, '[^0-9]', '', 'g'), '');
      if v_digits is not null and v_digits like '0%' and length(v_digits) > 1 then
        v_digits_sem_zero := substr(v_digits, 2);
      end if;
      if v_digits is null then
        v_name_like := '%' || replace(replace(replace(lower(v_search), '#', '##'), '%', '#%'), '_', '#_') || '%';
      end if;
    end if;
  end if;

  with ativos as (
    select c.id, c.display_name, c.name_key, c.phone_e164
    from public.customers c
    where c.status = 'active'
  ),
  metricas as (
    select l.customer_id,
           count(*) filter (where o.status = 'completed') as n,
           coalesce(sum(o.total::numeric) filter (where o.status = 'completed'), 0) as soma,
           min(o.created_at) filter (where o.status = 'completed') as primeira,
           max(o.created_at) filter (where o.status = 'completed') as ultima
    from public.order_customer_links l
    join public.orders o on o.id = l.order_id
    where l.state = 'linked'
    group by l.customer_id
  ),
  sem as (
    select o.id, o.created_at, o.total::numeric as total, o.customer_name, o.customer_phone,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk,
           case when l.order_id is null
                     and public.normalize_customer_name(o.customer_name) is not null
                     and public.normalize_customer_phone(o.customer_phone) is not null
                then 'pending' else 'unregistered' end as kind
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where o.status = 'completed'
      and (l.order_id is null or l.state = 'excluded')
  ),
  nomes_ativos as (
    select name_key, count(*) as n from ativos group by name_key
  ),
  telefones_ativos as (
    select phone_e164, count(*) as n from ativos group by phone_e164
  ),
  nomes_sem as (
    select nk, count(*) as n from sem where kind = 'unregistered' and nk is not null group by nk
  ),
  linhas as (
    select 'registered'::text as kind,
           a.id as customer_id,
           null::uuid as order_id,
           a.display_name,
           a.phone_e164 as phone,
           a.name_key as nk,
           coalesce(m.n, 0)::bigint as orders_count,
           coalesce(m.soma, 0)::numeric as total_spent,
           (case when coalesce(m.n, 0) > 0 then round(m.soma / m.n, 2) else 0 end)::numeric as avg_ticket,
           m.primeira as first_order_at,
           m.ultima as last_order_at,
           (na.n - 1)::bigint as same_name_count,
           (ta.n - 1)::bigint as shared_phone_count,
           coalesce(ns.n, 0)::bigint as possible_matches,
           false as phone_unrecognized
    from ativos a
    join nomes_ativos na on na.name_key = a.name_key
    join telefones_ativos ta on ta.phone_e164 = a.phone_e164
    left join metricas m on m.customer_id = a.id
    left join nomes_sem ns on ns.nk = a.name_key
    union all
    select s.kind,
           null::uuid,
           s.id,
           btrim(s.customer_name),
           s.customer_phone,
           s.nk,
           1::bigint,
           coalesce(s.total, 0)::numeric,
           round(coalesce(s.total, 0), 2)::numeric,
           s.created_at,
           s.created_at,
           0::bigint,
           0::bigint,
           (case when s.kind = 'unregistered'
                 then coalesce(na.n, 0) + coalesce(ns.n, 1) - 1
                 else coalesce(na.n, 0) end)::bigint,
           (s.pk is null and coalesce(btrim(s.customer_phone), '') <> '')
    from sem s
    left join nomes_ativos na on na.name_key = s.nk
    left join nomes_sem ns on ns.nk = s.nk
  ),
  filtrado as (
    select *
    from linhas l
    where (v_filter = 'all'
           or (v_filter = 'registered' and l.kind = 'registered')
           or (v_filter = 'buyers' and l.kind = 'registered' and l.orders_count > 0)
           or (v_filter = 'unregistered' and l.kind = 'unregistered')
           or (v_filter = 'duplicates' and (l.same_name_count > 0 or l.shared_phone_count > 0 or l.possible_matches > 0)))
      and (v_search is null
           or (v_name_like is not null and l.nk like v_name_like escape '#')
           or (v_digits is not null and (
                 regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'
                 or (v_digits_sem_zero is not null
                     and regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits_sem_zero || '%'))))
  ),
  pagina as (
    select f.*,
           row_number() over (
             order by
               case when v_sort = 'orders_desc' then f.orders_count end desc nulls last,
               case when v_sort = 'spent_desc' then f.total_spent end desc nulls last,
               case when v_sort = 'last_desc' then f.last_order_at end desc nulls last,
               f.nk asc nulls last,
               f.last_order_at desc nulls last,
               coalesce(f.customer_id, f.order_id)
           ) as ordem
    from filtrado f
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrado),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', p.kind,
               'customer_id', p.customer_id,
               'order_id', p.order_id,
               'display_name', p.display_name,
               'phone', p.phone,
               'orders_count', p.orders_count,
               'total_spent', p.total_spent,
               'avg_ticket', p.avg_ticket,
               'first_order_at', p.first_order_at,
               'last_order_at', p.last_order_at,
               'same_name_count', p.same_name_count,
               'shared_phone_count', p.shared_phone_count,
               'possible_matches', p.possible_matches,
               'phone_unrecognized', p.phone_unrecognized
             ) order by p.ordem)
      from pagina p
      where p.ordem > v_offset and p.ordem <= v_offset + v_limit
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;

-- Ficha. Por cliente (p_customer_id) ou por pedido (p_order_id — link do Histórico):
-- pedido vinculado abre o cliente; pedido sem vínculo abre a "ficha de não cadastrado"
-- (só aquele pedido + sugestões, nada é agrupado). Alertas nunca agrupam: só apontam outras
-- fichas (máx. 20 cada). audit = últimos 20 eventos.
CREATE FUNCTION public.get_customer_detail(
  p_customer_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_customer_id uuid := p_customer_id;
  v_customer public.customers;
  v_order record;
  v_link_state text;
  v_link_customer_id uuid;
  v_has_link boolean := false;
  v_nk text;
  v_pk text;
  v_ids_pagina uuid[];
  v_ids_todos uuid[];
  v_total_pedidos bigint;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  if p_customer_id is null and p_order_id is null then
    raise exception 'Informe o cliente ou o pedido';
  end if;

  if v_customer_id is null then
    select o.id, o.order_number, o.created_at, o.status, o.customer_name, o.customer_phone
      into v_order
    from public.orders o
    where o.id = p_order_id;

    if not found then
      raise exception 'Pedido não encontrado';
    end if;

    select l.state, l.customer_id into v_link_state, v_link_customer_id
    from public.order_customer_links l
    where l.order_id = p_order_id;
    v_has_link := found;

    if v_has_link and v_link_state = 'linked' then
      v_customer_id := v_link_customer_id;
    end if;
  end if;

  -- ---------------------------------------------------------------- cliente cadastrado
  if v_customer_id is not null then
    select * into v_customer from public.customers c where c.id = v_customer_id;
    if not found then
      raise exception 'Cliente não encontrado';
    end if;

    select coalesce(array_agg(x.id order by x.created_at desc, x.order_number desc), '{}'::uuid[]),
           count(*)
      into v_ids_todos, v_total_pedidos
    from (
      select o.id, o.created_at, o.order_number
      from public.order_customer_links l
      join public.orders o on o.id = l.order_id
      where l.customer_id = v_customer.id and l.state = 'linked'
    ) x;

    v_ids_pagina := v_ids_todos[v_offset + 1 : v_offset + v_limit];

    select jsonb_build_object(
      'registered', true,
      'customer', jsonb_build_object(
        'id', v_customer.id,
        'display_name', v_customer.display_name,
        'phone', v_customer.phone_e164,
        'status', v_customer.status,
        'source', v_customer.source,
        'created_at', v_customer.created_at,
        'first_order_at', (select min(o.created_at) from public.orders o where o.id = any (v_ids_todos) and o.status = 'completed'),
        'last_order_at', (select max(o.created_at) from public.orders o where o.id = any (v_ids_todos) and o.status = 'completed')
      ),
      'metrics', (
        select jsonb_build_object(
          'orders_count', count(*) filter (where o.status = 'completed'),
          'total_spent', coalesce(sum(o.total::numeric) filter (where o.status = 'completed'), 0),
          'avg_ticket', case when count(*) filter (where o.status = 'completed') > 0
                             then round(coalesce(sum(o.total::numeric) filter (where o.status = 'completed'), 0)
                                        / count(*) filter (where o.status = 'completed'), 2)
                             else 0 end,
          'cancelled_count', count(*) filter (where o.status = 'cancelled'),
          'open_count', count(*) filter (where o.status in ('requested', 'preparing', 'ready'))
        )
        from public.orders o
        where o.id = any (v_ids_todos)
      ),
      'orders_total', v_total_pedidos,
      'orders', public._customer_orders_json(v_ids_pagina),
      'top_products', public._customer_top_products_json(v_ids_todos),
      'same_name', coalesce((
        select jsonb_agg(x order by x.display_name)
        from (
          select 'registered' as kind, c.id as customer_id, null::uuid as order_id, c.display_name,
                 c.phone_e164 as phone, m.n as orders_count, m.ultima as last_order_at
          from public.customers c
          left join lateral (
            select count(*) filter (where o.status = 'completed') as n,
                   max(o.created_at) filter (where o.status = 'completed') as ultima
            from public.order_customer_links l
            join public.orders o on o.id = l.order_id
            where l.customer_id = c.id and l.state = 'linked'
          ) m on true
          where c.status = 'active' and c.name_key = v_customer.name_key and c.id <> v_customer.id
          order by c.display_name
          limit 20
        ) x
      ), '[]'::jsonb),
      'shared_phone', coalesce((
        select jsonb_agg(x order by x.display_name)
        from (
          select 'registered' as kind, c.id as customer_id, null::uuid as order_id, c.display_name,
                 c.phone_e164 as phone, m.n as orders_count, m.ultima as last_order_at
          from public.customers c
          left join lateral (
            select count(*) filter (where o.status = 'completed') as n,
                   max(o.created_at) filter (where o.status = 'completed') as ultima
            from public.order_customer_links l
            join public.orders o on o.id = l.order_id
            where l.customer_id = c.id and l.state = 'linked'
          ) m on true
          where c.status = 'active' and c.phone_e164 = v_customer.phone_e164 and c.id <> v_customer.id
          order by c.display_name
          limit 20
        ) x
      ), '[]'::jsonb),
      'possible_matches', coalesce((
        select jsonb_agg(x order by x.last_order_at desc)
        from (
          select case when l.order_id is null then 'pending' else 'unregistered' end as kind,
                 null::uuid as customer_id, o.id as order_id, btrim(o.customer_name) as display_name,
                 o.customer_phone as phone, o.order_number, o.status, o.total,
                 1 as orders_count, o.created_at as last_order_at
          from public.orders o
          left join public.order_customer_links l on l.order_id = o.id
          where (l.order_id is null or l.state = 'excluded')
            and public.normalize_customer_name(o.customer_name) = v_customer.name_key
          order by o.created_at desc
          limit 20
        ) x
      ), '[]'::jsonb),
      'audit', coalesce((
        select jsonb_agg(x order by x.acted_at desc, x.id desc)
        from (
          select a.id, a.action, a.order_id, a.order_number, a.customer_id, a.previous_customer_id,
                 a.actor, a.acted_at, a.reason, a.details
          from public.customer_link_audit a
          where a.customer_id = v_customer.id or a.previous_customer_id = v_customer.id
          order by a.acted_at desc, a.id desc
          limit 20
        ) x
      ), '[]'::jsonb)
    )
    into v_result;

    return v_result;
  end if;

  -- ---------------------------------------------------------------- não cadastrado
  v_nk := public.normalize_customer_name(v_order.customer_name);
  v_pk := public.normalize_customer_phone(v_order.customer_phone);

  select jsonb_build_object(
    'registered', false,
    'pending_sync', (not v_has_link and v_nk is not null and v_pk is not null),
    'excluded', (v_has_link and v_link_state = 'excluded'),
    'phone_unrecognized', (v_pk is null and coalesce(btrim(v_order.customer_phone), '') <> ''),
    'customer', jsonb_build_object(
      'id', null,
      'display_name', btrim(v_order.customer_name),
      'phone', v_order.customer_phone,
      'first_order_at', case when v_order.status = 'completed' then v_order.created_at end,
      'last_order_at', case when v_order.status = 'completed' then v_order.created_at end
    ),
    'metrics', jsonb_build_object(
      'orders_count', case when v_order.status = 'completed' then 1 else 0 end,
      'total_spent', coalesce((select o.total from public.orders o where o.id = p_order_id and o.status = 'completed'), 0),
      'avg_ticket', coalesce((select round(o.total::numeric, 2) from public.orders o where o.id = p_order_id and o.status = 'completed'), 0),
      'cancelled_count', case when v_order.status = 'cancelled' then 1 else 0 end,
      'open_count', case when v_order.status in ('requested', 'preparing', 'ready') then 1 else 0 end
    ),
    'orders_total', 1,
    'orders', public._customer_orders_json(array[p_order_id]),
    'top_products', public._customer_top_products_json(array[p_order_id]),
    'same_name', '[]'::jsonb,
    -- Pedido com telefone válido (aguardando sincronização ou desvinculado): cadastros com
    -- o mesmo telefone, pra mostrar a quem ele corresponderia.
    'shared_phone', coalesce((
      select jsonb_agg(x order by x.display_name)
      from (
        select 'registered' as kind, c.id as customer_id, null::uuid as order_id, c.display_name,
               c.phone_e164 as phone, null::bigint as orders_count, null::timestamptz as last_order_at
        from public.customers c
        where v_pk is not null and c.status = 'active' and c.phone_e164 = v_pk
        order by c.display_name
        limit 20
      ) x
    ), '[]'::jsonb),
    'possible_matches', coalesce((
      select jsonb_agg(x order by x.kind, x.last_order_at desc nulls last)
      from (
        (
          select 'registered' as kind, c.id as customer_id, null::uuid as order_id, c.display_name,
                 c.phone_e164 as phone, null::bigint as order_number, null::text as status, null::numeric as total,
                 m.n as orders_count, m.ultima as last_order_at
          from public.customers c
          left join lateral (
            select count(*) filter (where o.status = 'completed') as n,
                   max(o.created_at) filter (where o.status = 'completed') as ultima
            from public.order_customer_links l
            join public.orders o on o.id = l.order_id
            where l.customer_id = c.id and l.state = 'linked'
          ) m on true
          where v_nk is not null and c.status = 'active' and c.name_key = v_nk
          order by c.display_name
          limit 20
        )
        union all
        (
          select case when l.order_id is null then 'pending' else 'unregistered' end,
                 null::uuid, o.id, btrim(o.customer_name), o.customer_phone, o.order_number::bigint, o.status::text, o.total::numeric,
                 1::bigint, o.created_at
          from public.orders o
          left join public.order_customer_links l on l.order_id = o.id
          where v_nk is not null
            and o.id <> p_order_id
            and (l.order_id is null or l.state = 'excluded')
            and public.normalize_customer_name(o.customer_name) = v_nk
          order by o.created_at desc
          limit 20
        )
      ) x
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(x order by x.acted_at desc, x.id desc)
      from (
        select a.id, a.action, a.order_id, a.order_number, a.customer_id, a.previous_customer_id,
               a.actor, a.acted_at, a.reason, a.details
        from public.customer_link_audit a
        where a.order_id = p_order_id
        order by a.acted_at desc, a.id desc
        limit 20
      ) x
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;


-- =====================================================================================
-- 8) RLS e privilégios
-- =====================================================================================
-- Tabelas: RLS ligada SEM policies e todos os privilégios revogados de anon,
-- authenticated E service_role (o Supabase concede tudo por padrão a esses papéis em
-- objetos novos do schema public; service_role ignora RLS, então só a revogação o
-- bloqueia — nenhum backend atual usa estas tabelas). Acesso somente pelas RPCs SECURITY
-- DEFINER abaixo, que rodam como o dono (o papel que aplicou a migration). Sem FORCE RLS:
-- o dono não é filtrado pelas próprias tabelas.

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_link_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.customers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.order_customer_links FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.customer_link_audit FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.customer_link_audit_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- Funções internas: ninguém além do dono (chamadas só por RPCs definer, trigger ou
-- migration). service_role também é revogado: as internas não checam is_admin(), então
-- nenhum papel de API deve chamá-las diretamente. (A execução de função de trigger não
-- depende de EXECUTE de quem dispara o trigger.)
REVOKE ALL ON FUNCTION public._customer_link_audit_immutable() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_links_audit_on_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_registry_link_by_phone(text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_registry_reconcile_deleted_orders(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_orders_json(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_top_products_json(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- RPCs administrativas: is_admin() checado dentro de cada uma; anon sem EXECUTE.
REVOKE ALL ON FUNCTION public.sync_phone_customer_links(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_phone_customer_links(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.sync_phone_customer_links(integer) TO authenticated;

REVOKE ALL ON FUNCTION public.get_customers_overview() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customers_overview() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_customers_overview() TO authenticated;

REVOKE ALL ON FUNCTION public.list_customers(text, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_customers(text, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_customers(text, text, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.get_customer_detail(uuid, uuid, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_detail(uuid, uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_customer_detail(uuid, uuid, integer, integer) TO authenticated;


RESET lock_timeout;

-- Fim do passo 1. Faça o COMMIT. A FK para orders é o passo 2
-- (20261009100050_add_customer_links_order_fk.sql), em transação própria. Enquanto o
-- passo 2 não for aplicado, a sincronização e o backfill se recusam a criar vínculos.
