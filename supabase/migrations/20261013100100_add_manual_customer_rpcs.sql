-- =====================================================================================
-- Cadastro de clientes — M2: cadastro manual, perfil/Eircode, pesquisa de pedidos e
-- vinculação manual INDIVIDUAL (página Clientes). Requer M1 (20261013100000).
--
-- Cria SOMENTE funções novas (nenhuma tabela, coluna, trigger ou RPC existente é criada,
-- alterada ou substituída):
--   Internas — SECURITY INVOKER, sem EXECUTE para ninguém além do dono (nem service_role):
--     _customer_registration_check(p_name, p_phone, p_eircode)        STABLE
--     _customer_manual_link_warnings(...)                              IMMUTABLE
--     Chamadas de dentro das RPCs SECURITY DEFINER, rodam com o papel do dono (current_user
--     = dono durante a RPC). Chamadas diretas: sem EXECUTE; e, se um EXECUTE fosse concedido
--     por engano, rodariam com o papel de quem chama (sem acesso às tabelas, RLS sem
--     policies) e _customer_registration_check ainda recusa quem não é admin.
--   RPCs (SECURITY DEFINER, is_admin() na 1ª linha, SÓ authenticated executa — PUBLIC, anon
--   e service_role sem EXECUTE):
--     admin_check_customer_duplicates(p_name, p_phone, p_eircode)     STABLE  (leitura)
--     admin_create_customer(p_name, p_phone, p_eircode, p_acknowledged_warnings, p_request_id)
--     admin_get_customer_profile(p_customer_id)                        STABLE  (leitura)
--     admin_update_customer_eircode(p_customer_id, p_eircode)
--     admin_search_orders_for_link(p_customer_id, p_search, p_limit, p_offset)  STABLE
--     admin_link_order_to_customer(p_customer_id, p_order_id, p_confirm_reactivation,
--                                  p_acknowledged_warnings, p_reason)
--
-- Regras de negócio (todas aplicadas NO BANCO, não só na tela):
--   * Cadastro manual: nome e telefone irlandês obrigatórios, Eircode opcional (formato da
--     M1). Mesmo nome normalizado + mesmo telefone já ATIVO = bloqueado (customer_exists;
--     o índice único customers_identity_active_uq é a barreira final). Mesmo nome, mesmo
--     telefone com outro nome e mesma identidade ARQUIVADA = avisos que precisam constar
--     em p_acknowledged_warnings; nunca bloqueiam homônimos e nunca unem cadastros.
--     Pedidos com o mesmo nome + telefone são só INFORMADOS na prévia, separados em
--     "aguardando sincronização" (sem linha de vínculo: a sincronização automática já
--     existente os vincula) e "desvinculados" ('excluded': NUNCA são vinculados nem
--     reativados automaticamente — nem pelo cadastro, nem pela sincronização, que só olha
--     pedidos sem linha de vínculo). O cadastro manual não grava nenhum vínculo.
--   * Vinculação: um pedido por vez. Vinculado a OUTRO cliente = erro sempre (não existe
--     parâmetro de transferência). 'excluded' = só com p_confirm_reactivation = true
--     (ação explícita do admin sobre aquele pedido).
--     Avisos name_mismatch / phone_mismatch / order_cancelled são recalculados no banco
--     e precisam constar em p_acknowledged_warnings. Já vinculado a ESTE cliente = sucesso
--     idempotente (already_linked), sem gravar nada.
--   * Pedidos: somente leitura (FOR KEY SHARE impede só a exclusão do pedido durante a
--     vinculação; não conflita com status, pagamento, impressão). Nada em orders,
--     order_items ou pagamentos é alterado.
--   * Auditoria (somente inclusão): customer_created (cadastro), customer_updated
--     (Eircode — apenas indicadores, nunca o texto do Eircode), link (vinculação, com
--     pedido, número, cliente, admin = auth.uid(), data = now(), motivo opcional e
--     detalhes do estado anterior/avisos confirmados). Nenhuma linha existente é alterada.
--
-- Concorrência — ordem de locks idêntica à das funções de produção:
--   sincronização (_customer_registry_link_by_phone) .. advisory 'larica.customer_registry'
--                                                        -> FK (KEY SHARE) no cliente
--   admin_archive_customer (produção) ................... advisory -> linha do cliente
--   admin_link_order_to_customer ........................ advisory -> cliente FOR NO KEY
--                                                        UPDATE -> pedido FOR KEY SHARE ->
--                                                        vínculo FOR UPDATE
--   admin_create_customer ............................... advisory -> INSERT
--   admin_update_customer_eircode / admin_update_customer  só a linha do cliente
-- FOR NO KEY UPDATE (e não FOR UPDATE) no cliente: é compatível com o KEY SHARE que a FK
-- de um vínculo novo pega no mesmo cliente, então não forma ciclo com a sincronização; e
-- conflita com os UPDATEs de admin_update_customer/admin_archive_customer, serializando
-- edição, arquivamento e vinculação do mesmo cliente. A guarda (f) confere, no corpo REAL
-- de produção, que admin_archive_customer pega o advisory ANTES de travar o cliente e que
-- admin_update_customer não pega o advisory depois do lock de linha.
-- lock_timeout de 5s local à transação: espera ocupada vira erro 'larica:busy' (nada é
-- gravado; repetir é seguro).
--
-- Erros: mensagem em português + HINT 'larica:<codigo>' (+ DETAIL JSON quando há dados),
-- lidos pelo front (js/services/customers-service.js):
--   forbidden, invalid, customer_exists, confirmation_required, busy, customer_not_found,
--   customer_archived, order_not_found, linked_to_other, reactivation_required, conflict,
--   request_conflict, request_already_used
-- 'Acesso negado' continua sendo a mensagem de falta de permissão (igual às demais RPCs).
--
-- Idempotência do cadastro (p_request_id, gerado pelo front por tentativa, 8 a 64
-- caracteres [A-Za-z0-9-]; guardado em customer_link_audit.details junto com
-- request_fingerprint = md5(nome normalizado | telefone normalizado | Eircode informado?)):
--   * tentativas SIMULTÂNEAS com o mesmo id: o advisory lock é pego ANTES da consulta; a
--     2ª espera a 1ª terminar e, como cada comando PL/pgSQL usa um snapshot novo, enxerga
--     o evento que a 1ª gravou -> devolve o mesmo cadastro (already_created). Se a 1ª
--     falhou, nada foi gravado e a 2ª cria normalmente (uma vez só);
--   * mesmo id com DADOS DIFERENTES (outro nome/telefone, Eircode diferente do gravado, ou
--     outro admin): erro request_conflict, nada é criado nem devolvido;
--   * mesmo id cujo cadastro foi ARQUIVADO (ou não existe mais): erro request_already_used
--     com o id e a situação; nada é criado (para cadastrar de novo, nova tentativa);
--   * sem p_request_id: sem idempotência por tentativa, mas a duplicidade exata continua
--     bloqueada (verificação sob o lock + índice único customers_identity_active_uq).
-- Vinculação repetida devolve already_linked. Eircode igual ao atual = changed false.
--
-- Guardas (seção 0) — qualquer falha aborta sem alterar nada:
--   (a) nenhum dos 8 nomes de função existe (qualquer assinatura);
--   (b) M1 aplicada (coluna, constraint e normalize_customer_eircode);
--   (c) CHECKs de produção aceitam os valores usados: customers.source 'admin';
--       order_customer_links.link_source 'admin' e state 'linked'/'excluded';
--       customer_link_audit.action 'customer_created', 'customer_updated', 'link';
--   (d) índice único de identidade e FK order_customer_links -> orders existem e válidos;
--   (e) funções de que as novas dependem estão EXATAMENTE como no repositório (md5 do
--       corpo normalizado CRLF -> LF): normalize_customer_name/phone, sincronização,
--       vínculo automático, reconciliação e trigger de exclusão;
--   (f) ordem de locks das RPCs de produção (verificação textual do corpo, indicativa —
--       complementa a revisão das definições completas, não a substitui);
--   (g) o papel que aplica (= dono das funções SECURITY DEFINER) tem os privilégios do
--       dono das 3 tabelas do cadastro (RLS sem policies esconderia as linhas de quem não
--       é dono; FOR NO KEY UPDATE / FOR UPDATE / INSERT / UPDATE nelas) e, em
--       public.orders, SELECT + UPDATE em AO MENOS UMA coluna (o PostgreSQL exige UPDATE
--       em alguma coluna para qualquer cláusula FOR ... SHARE/UPDATE, inclusive FOR KEY
--       SHARE — a mesma exigência que a sincronização já cumpre) e leitura sem filtro de
--       RLS. Nenhuma escrita em orders é feita;
--   (h) os papéis anon, authenticated e service_role existem.
-- Verificação final (seção 4): atributos (SECURITY DEFINER só nas RPCs, INVOKER nas
-- internas), search_path, volatilidade, is_admin() como 1ª instrução das RPCs (textual),
-- e permissões: na ACL, EXECUTE só para o dono (+ authenticated nas RPCs); privilégio
-- EFETIVO (com herança) de anon, service_role e authenticated conferido função a função.
-- Se algo divergir, aborta (tudo é desfeito).
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). Para o SQL Editor:
--   supabase/sql-editor/20261013100100_add_manual_customer_rpcs.sql
-- Pré-checagem: supabase/testes-manuais/20261013_manual_customer_pre.sql (M2-*)
-- Rollback (manual, não destrutivo por padrão): supabase/rollback/20261013100000_manual_customer_down.sql
-- Arquivo sem nenhuma barra invertida (escape de LIKE com '#').
-- =====================================================================================

SET LOCAL lock_timeout = '5s';


-- =====================================================================================
-- 0) Guardas
-- =====================================================================================

DO $guard$
declare
  c_crlf constant text := chr(13) || chr(10);
  c_lf constant text := chr(10);
  v_falhas text := '';
  v_texto text;
  v_pos_adv integer;
  v_pos_linha integer;
  v_bypass boolean;
  r record;
begin
  -- (a) nomes livres
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_texto
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = any (array[
      '_customer_registration_check', '_customer_manual_link_warnings',
      'admin_check_customer_duplicates', 'admin_create_customer', 'admin_get_customer_profile',
      'admin_update_customer_eircode', 'admin_search_orders_for_link', 'admin_link_order_to_customer'
    ]);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [já existem: %s]', v_texto);
  end if;

  -- (b) M1 aplicada
  if not exists (select 1 from pg_attribute
                 where attrelid = 'public.customers'::regclass and attname = 'eircode'
                   and attnum > 0 and not attisdropped)
     or not exists (select 1 from pg_constraint
                    where conrelid = 'public.customers'::regclass and conname = 'customers_eircode_check')
     or to_regprocedure('public.normalize_customer_eircode(text)') is null then
    v_falhas := v_falhas || ' [M1 (20261013100000_add_customer_eircode) não está aplicada]';
  end if;

  -- (c) valores aceitos pelos CHECKs atuais (toda CHECK que cita a coluna precisa aceitar)
  for r in
    select v.tabela, v.coluna, v.valor
    from (values
      ('public.customers',            'source',      'admin'),
      ('public.order_customer_links', 'link_source', 'admin'),
      ('public.order_customer_links', 'state',       'linked'),
      ('public.order_customer_links', 'state',       'excluded'),
      ('public.customer_link_audit',  'action',      'customer_created'),
      ('public.customer_link_audit',  'action',      'customer_updated'),
      ('public.customer_link_audit',  'action',      'link')
    ) as v(tabela, coluna, valor)
  loop
    select string_agg(c.conname, ', ')
      into v_texto
    from pg_constraint c
    where c.conrelid = r.tabela::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ~ ('[(]' || r.coluna || '[[:space:]]')
      and position(quote_literal(r.valor) in pg_get_constraintdef(c.oid)) = 0
      and pg_get_constraintdef(c.oid) ~ ('[(]' || r.coluna || '[[:space:]]*=[[:space:]]*ANY');
    if v_texto is not null then
      v_falhas := v_falhas || format(' [CHECK %s de %s não aceita %s = %L]', v_texto, r.tabela, r.coluna, r.valor);
    end if;
  end loop;

  -- (d) barreiras estruturais
  if not exists (select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid
                 where i.indrelid = 'public.customers'::regclass
                   and ic.relname = 'customers_identity_active_uq'
                   and i.indisunique and i.indisvalid) then
    v_falhas := v_falhas || ' [índice único customers_identity_active_uq ausente ou inválido]';
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.order_customer_links'::regclass
                   and conname = 'order_customer_links_order_fk' and contype = 'f' and convalidated) then
    v_falhas := v_falhas || ' [FK order_customer_links_order_fk ausente ou não validada]';
  end if;

  -- (e) dependências idênticas ao repositório (md5 do corpo normalizado CRLF -> LF)
  for r in
    select f.assinatura, f.md5_lf, p.prosrc
    from (values
      ('public.normalize_customer_name(text)',                        'ef9e86d2ecda8d8b9085d08ad37eb80b'),
      ('public.normalize_customer_phone(text)',                       'fc557eb1731585d58691c004ff9ea1a5'),
      ('public._customer_links_audit_on_delete()',                    '8943f428dc9ef4c8619cede330f15da6'),
      ('public._customer_registry_link_by_phone(text,integer)',       'd9e51757079a894c716467220f8ea0f9'),
      ('public._customer_registry_reconcile_deleted_orders(integer)', 'e1c6454bad82089eb65d2dfb159a6647'),
      ('public.sync_phone_customer_links(integer)',                   '3fc24b6a0ac6b9cfd7e8d0757dbda241')
    ) as f(assinatura, md5_lf)
    left join pg_proc p on p.oid = to_regprocedure(f.assinatura)
  loop
    if r.prosrc is null then
      v_falhas := v_falhas || format(' [%s não existe]', r.assinatura);
    elsif md5(replace(r.prosrc, c_crlf, c_lf)) <> r.md5_lf then
      v_falhas := v_falhas || format(' [%s difere do repositório (md5 normalizado %s)]',
                                     r.assinatura, md5(replace(r.prosrc, c_crlf, c_lf)));
    end if;
  end loop;

  -- (f) ordem de locks das RPCs de produção (texto sem espaços, minúsculo)
  for r in
    select f.assinatura, f.exige_advisory, p.prosrc
    from (values
      ('public.admin_archive_customer(uuid)',            true),
      ('public.admin_update_customer(uuid,text,text)',   false)
    ) as f(assinatura, exige_advisory)
    left join pg_proc p on p.oid = to_regprocedure(f.assinatura)
  loop
    if r.prosrc is null then
      v_falhas := v_falhas || format(' [%s não existe em produção]', r.assinatura);
      continue;
    end if;
    v_texto := regexp_replace(lower(r.prosrc), '[[:space:]]+', '', 'g');
    v_pos_adv := position('pg_advisory_xact_lock(hashtext(''larica.customer_registry''))' in v_texto);
    select min(pos) into v_pos_linha
    from (values (position('forupdate' in v_texto)),
                 (position('fornokeyupdate' in v_texto)),
                 (position('updatepublic.customers' in v_texto)),
                 (position('updatepublic.order_customer_links' in v_texto))) as x(pos)
    where pos > 0;
    if r.exige_advisory and v_pos_adv = 0 then
      v_falhas := v_falhas || format(' [%s não usa o advisory larica.customer_registry]', r.assinatura);
    elsif v_pos_adv > 0 and v_pos_linha is not null and v_pos_adv > v_pos_linha then
      v_falhas := v_falhas || format(' [%s trava a linha ANTES do advisory: ordem inversa à da vinculação manual (risco de deadlock)]', r.assinatura);
    end if;
  end loop;

  -- (g) privilégios do papel que aplica (= dono das funções SECURITY DEFINER)
  select string_agg(c.relname, ', ')
    into v_texto
  from pg_class c
  where c.oid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
    and not pg_has_role(current_user, c.relowner, 'USAGE');
  if v_texto is not null then
    v_falhas := v_falhas || format(' [o papel %s não tem os privilégios do dono de: %s (RLS sem policies esconderia as linhas)]', current_user, v_texto);
  end if;

  -- orders: só leitura + FOR KEY SHARE. SELECT na tabela; UPDATE em ao menos UMA coluna é
  -- o mínimo que o PostgreSQL exige para FOR KEY SHARE (não é usado para escrever).
  select r2.rolbypassrls into v_bypass from pg_roles r2 where r2.rolname = current_user;
  if not has_table_privilege(current_user, 'public.orders', 'SELECT') then
    v_falhas := v_falhas || format(' [o papel %s não tem SELECT em public.orders]', current_user);
  end if;
  if not has_any_column_privilege(current_user, 'public.orders', 'UPDATE') then
    v_falhas := v_falhas || format(' [o papel %s não tem UPDATE em nenhuma coluna de public.orders (exigido por FOR KEY SHARE)]', current_user);
  end if;
  if exists (select 1 from pg_class c
             where c.oid = 'public.orders'::regclass and c.relrowsecurity
               and (c.relforcerowsecurity
                    or (not pg_has_role(current_user, c.relowner, 'USAGE') and not coalesce(v_bypass, false)))) then
    v_falhas := v_falhas || format(' [a RLS de public.orders filtraria as leituras do papel %s]', current_user);
  end if;
  if not has_function_privilege(current_user, 'public.is_admin()', 'EXECUTE')
     or not has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') then
    v_falhas := v_falhas || ' [sem EXECUTE em is_admin()/auth.uid()]';
  end if;

  -- (h) papéis usados nos REVOKE/GRANT e na verificação final
  select string_agg(x.papel, ', ')
    into v_texto
  from unnest(array['anon', 'authenticated', 'service_role']) as x(papel)
  where not exists (select 1 from pg_roles r3 where r3.rolname = x.papel);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_texto);
  end if;

  if v_falhas <> '' then
    raise exception 'M2 interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Internas
-- =====================================================================================

-- Validação + normalização + duplicidades de um cadastro manual. Única implementação,
-- usada pela prévia (admin_check_customer_duplicates) e pela criação (admin_create_customer
-- recalcula tudo no banco, sob o advisory lock). Não grava nada.
-- warnings: same_name (outro cadastro ATIVO com o mesmo nome e outro telefone ou sem
-- telefone), same_phone (cadastro ATIVO com o mesmo telefone e outro nome),
-- archived_identity (cadastro ARQUIVADO com o mesmo nome e telefone).
-- exact_match: cadastro ATIVO com o mesmo nome e telefone (bloqueante).
-- Pedidos com o mesmo nome + telefone: SOMENTE informativos (contagens), nunca avisos a
-- confirmar e nunca vinculados por esta função ou pelo cadastro:
--   pending_sync_orders_same_identity  sem linha de vínculo (a sincronização automática
--                                      existente os vincula ao cadastro ativo da mesma
--                                      identidade);
--   excluded_orders_same_identity      'excluded': ficam desvinculados; só "Vincular
--                                      pedido", com confirmação explícita, os reativa.
-- SECURITY INVOKER: dentro das RPCs SECURITY DEFINER roda com o papel do dono. A checagem
-- de admin abaixo é defesa em profundidade para um EXECUTE concedido por engano.
CREATE FUNCTION public._customer_registration_check(p_name text, p_phone text, p_eircode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  v_display text := btrim(regexp_replace(translate(coalesce(p_name, ''), chr(160), ' '), '[[:space:]]+', ' ', 'g'));
  v_name_key text := public.normalize_customer_name(p_name);
  v_phone_raw text := nullif(btrim(coalesce(p_phone, '')), '');
  v_phone text := public.normalize_customer_phone(p_phone);
  v_eircode_raw text := nullif(btrim(coalesce(p_eircode, '')), '');
  v_eircode text := public.normalize_customer_eircode(p_eircode);
  v_errors jsonb := '{}'::jsonb;
  v_exact jsonb;
  v_same_name jsonb := '[]'::jsonb;
  v_same_name_total integer := 0;
  v_same_phone jsonb := '[]'::jsonb;
  v_same_phone_total integer := 0;
  v_archived jsonb := '[]'::jsonb;
  v_orders_pending integer := 0;
  v_orders_excluded integer := 0;
  v_warnings text[] := '{}';
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  if v_name_key is null then
    v_errors := v_errors || jsonb_build_object('name', 'required');
  elsif char_length(v_display) > 120 then
    v_errors := v_errors || jsonb_build_object('name', 'too_long');
  end if;

  if v_phone_raw is null then
    v_errors := v_errors || jsonb_build_object('phone', 'required');
  elsif v_phone is null then
    v_errors := v_errors || jsonb_build_object('phone', 'invalid');
  end if;

  if v_eircode_raw is not null and v_eircode is null then
    v_errors := v_errors || jsonb_build_object('eircode', 'invalid');
  end if;

  if v_name_key is not null and v_phone is not null then
    select jsonb_build_object('customer_id', c.id, 'display_name', c.display_name, 'phone', c.phone_e164, 'status', c.status)
      into v_exact
    from public.customers c
    where c.status = 'active' and c.name_key = v_name_key and c.phone_e164 = v_phone
    order by c.created_at
    limit 1;

    select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
      into v_archived
    from (
      select jsonb_build_object('customer_id', c.id, 'display_name', c.display_name, 'phone', c.phone_e164,
                                'status', c.status, 'created_at', c.created_at) as j,
             c.created_at
      from public.customers c
      where c.status = 'archived' and c.name_key = v_name_key and c.phone_e164 = v_phone
      order by c.created_at desc
      limit 10
    ) x;

    -- Somente informativo (ver cabeçalho da função): nada aqui grava ou reativa vínculos.
    select count(*) filter (where l.order_id is null),
           count(*) filter (where l.state = 'excluded')
      into v_orders_pending, v_orders_excluded
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where (l.order_id is null or l.state = 'excluded')
      and public.normalize_customer_name(o.customer_name) = v_name_key
      and public.normalize_customer_phone(o.customer_phone) = v_phone;
  end if;

  if v_name_key is not null then
    select count(*)
      into v_same_name_total
    from public.customers c
    where c.status = 'active' and c.name_key = v_name_key
      and (v_phone is null or c.phone_e164 is distinct from v_phone);

    select coalesce(jsonb_agg(x.j order by x.created_at), '[]'::jsonb)
      into v_same_name
    from (
      select jsonb_build_object('customer_id', c.id, 'display_name', c.display_name, 'phone', c.phone_e164,
                                'status', c.status, 'created_at', c.created_at) as j,
             c.created_at
      from public.customers c
      where c.status = 'active' and c.name_key = v_name_key
        and (v_phone is null or c.phone_e164 is distinct from v_phone)
      order by c.created_at
      limit 10
    ) x;
  end if;

  if v_phone is not null then
    select count(*)
      into v_same_phone_total
    from public.customers c
    where c.status = 'active' and c.phone_e164 = v_phone
      and (v_name_key is null or c.name_key <> v_name_key);

    select coalesce(jsonb_agg(x.j order by x.created_at), '[]'::jsonb)
      into v_same_phone
    from (
      select jsonb_build_object('customer_id', c.id, 'display_name', c.display_name, 'phone', c.phone_e164,
                                'status', c.status, 'created_at', c.created_at) as j,
             c.created_at
      from public.customers c
      where c.status = 'active' and c.phone_e164 = v_phone
        and (v_name_key is null or c.name_key <> v_name_key)
      order by c.created_at
      limit 10
    ) x;
  end if;

  if v_same_name_total > 0 then
    v_warnings := array_append(v_warnings, 'same_name');
  end if;
  if v_same_phone_total > 0 then
    v_warnings := array_append(v_warnings, 'same_phone');
  end if;
  if jsonb_array_length(v_archived) > 0 then
    v_warnings := array_append(v_warnings, 'archived_identity');
  end if;

  return jsonb_build_object(
    'valid', v_errors = '{}'::jsonb,
    'errors', v_errors,
    'normalized', jsonb_build_object('display_name', nullif(v_display, ''), 'name_key', v_name_key,
                                     'phone', v_phone, 'eircode', v_eircode),
    'exact_match', v_exact,
    'warnings', to_jsonb(v_warnings),
    'same_name', v_same_name,
    'same_name_total', v_same_name_total,
    'same_phone', v_same_phone,
    'same_phone_total', v_same_phone_total,
    'archived_identity', v_archived,
    'pending_sync_orders_same_identity', v_orders_pending,
    'excluded_orders_same_identity', v_orders_excluded
  );
end;
$function$;

-- Avisos de divergência entre um pedido e o cadastro (recebe valores JÁ normalizados).
-- Única regra, usada pela pesquisa (prévia) e pela vinculação (exigência no banco).
--   name_mismatch   nome normalizado do pedido diferente do cadastro (ou pedido sem nome)
--   phone_mismatch  telefone do pedido ausente/não reconhecido, cadastro sem telefone,
--                   ou telefones diferentes
--   order_cancelled pedido cancelado (decisão: vincular só com confirmação explícita)
CREATE FUNCTION public._customer_manual_link_warnings(
  p_customer_name_key text,
  p_customer_phone text,
  p_order_name_key text,
  p_order_phone text,
  p_order_status text
)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select array_remove(array[
    case when p_order_name_key is null or p_order_name_key is distinct from p_customer_name_key
         then 'name_mismatch' end,
    case when p_customer_phone is null or p_order_phone is null or p_order_phone <> p_customer_phone
         then 'phone_mismatch' end,
    case when p_order_status = 'cancelled' then 'order_cancelled' end
  ]::text[], null);
$function$;


-- =====================================================================================
-- 2) Cadastro manual e perfil
-- =====================================================================================

-- Prévia (não grava): validação por campo, duplicidade exata e avisos.
CREATE FUNCTION public.admin_check_customer_duplicates(p_name text, p_phone text, p_eircode text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  return public._customer_registration_check(p_name, p_phone, p_eircode);
end;
$function$;

-- Criação. Tudo é recalculado no banco sob o advisory lock da sincronização (que, por
-- isso, não cria o mesmo cadastro ao mesmo tempo). p_request_id: id da tentativa gerado
-- pelo front — regras de idempotência no cabeçalho do arquivo (simultâneas, dados
-- diferentes, cadastro arquivado).
CREATE FUNCTION public.admin_create_customer(
  p_name text,
  p_phone text,
  p_eircode text DEFAULT NULL,
  p_acknowledged_warnings text[] DEFAULT '{}',
  p_request_id text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_request text := nullif(btrim(coalesce(p_request_id, '')), '');
  v_ack text[] := coalesce(p_acknowledged_warnings, '{}');
  v_check jsonb;
  v_fingerprint text;
  v_warnings text[];
  v_missing text[];
  v_id uuid;
  v_prev_found boolean;
  v_prev_customer uuid;
  v_prev_actor uuid;
  v_prev_fingerprint text;
  v_prev_status text;
  v_prev_eircode text;
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  if v_request is not null and v_request !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception using message = 'Identificador da tentativa inválido.', hint = 'larica:invalid',
                          detail = jsonb_build_object('request_id', 'invalid')::text;
  end if;

  -- Lock ANTES de qualquer leitura: serializa com a sincronização e com outras criações
  -- (inclusive a repetição simultânea da mesma tentativa).
  perform set_config('lock_timeout', '5s', true);
  begin
    perform pg_advisory_xact_lock(hashtext('larica.customer_registry'));
  exception
    when lock_not_available then
      raise exception using message = 'O cadastro de clientes está ocupado (sincronização ou outra operação). Nada foi gravado; tente novamente em alguns segundos.',
                            hint = 'larica:busy';
  end;

  -- Validação/duplicidades recalculadas sob o lock (snapshot novo, posterior ao lock)
  v_check := public._customer_registration_check(p_name, p_phone, p_eircode);

  if not (v_check ->> 'valid')::boolean then
    raise exception using message = 'Dados do cliente inválidos.', hint = 'larica:invalid',
                          detail = (v_check -> 'errors')::text;
  end if;

  -- Impressão digital dos dados da tentativa: nome e telefone normalizados + SE há Eircode
  -- (o texto do Eircode não entra na auditoria; é comparado com o cadastro, abaixo).
  v_fingerprint := md5(concat_ws('|',
                                 v_check -> 'normalized' ->> 'name_key',
                                 v_check -> 'normalized' ->> 'phone',
                                 case when (v_check -> 'normalized' ->> 'eircode') is null then 'sem-eircode' else 'com-eircode' end));

  -- Repetição da MESMA tentativa (ex.: falha de rede depois do COMMIT)
  if v_request is not null then
    select true, a.customer_id, a.actor, a.details ->> 'request_fingerprint'
      into v_prev_found, v_prev_customer, v_prev_actor, v_prev_fingerprint
    from public.customer_link_audit a
    where a.action = 'customer_created'
      and a.details ->> 'request_id' = v_request
    order by a.id
    limit 1;

    if coalesce(v_prev_found, false) then
      select c.status, c.eircode into v_prev_status, v_prev_eircode
      from public.customers c
      where c.id = v_prev_customer;

      if v_prev_actor is distinct from auth.uid()
         or v_prev_fingerprint is distinct from v_fingerprint
         or (v_prev_status is not null
             and v_prev_eircode is distinct from (v_check -> 'normalized' ->> 'eircode')) then
        raise exception using message = 'Este identificador de tentativa já foi usado com outros dados. Nenhum cadastro foi criado; inicie um novo cadastro.',
                              hint = 'larica:request_conflict';
      end if;

      if v_prev_status is distinct from 'active' then
        raise exception using message = 'Esta tentativa já criou um cadastro que foi arquivado ou não existe mais. Nenhum cadastro novo foi criado; para cadastrar de novo, inicie um novo cadastro.',
                              hint = 'larica:request_already_used',
                              detail = jsonb_build_object('customer_id', v_prev_customer,
                                                          'status', coalesce(v_prev_status, 'missing'))::text;
      end if;

      return (select jsonb_build_object('success', true, 'already_created', true, 'customer_id', c.id,
                                        'display_name', c.display_name, 'phone', c.phone_e164,
                                        'eircode', c.eircode, 'status', c.status)
              from public.customers c
              where c.id = v_prev_customer);
    end if;
  end if;

  if jsonb_typeof(v_check -> 'exact_match') = 'object' then
    raise exception using message = 'Já existe um cadastro ativo com este nome e telefone. Nenhum cadastro foi criado.',
                          hint = 'larica:customer_exists',
                          detail = jsonb_build_object('customer_id', v_check -> 'exact_match' ->> 'customer_id')::text;
  end if;

  select coalesce(array_agg(x.w order by x.w), '{}') into v_warnings
  from jsonb_array_elements_text(v_check -> 'warnings') as x(w);
  select coalesce(array_agg(x.w order by x.w), '{}') into v_missing
  from unnest(v_warnings) as x(w)
  where not (x.w = any (v_ack));

  if cardinality(v_missing) > 0 then
    raise exception using message = 'Confirmação necessária: há possíveis duplicidades que precisam ser revisadas. Nenhum cadastro foi criado.',
                          hint = 'larica:confirmation_required',
                          detail = jsonb_build_object('warnings', to_jsonb(v_missing))::text;
  end if;

  begin
    insert into public.customers (display_name, phone_e164, eircode, source, created_by, updated_by)
    values (v_check -> 'normalized' ->> 'display_name',
            v_check -> 'normalized' ->> 'phone',
            v_check -> 'normalized' ->> 'eircode',
            'admin', auth.uid(), auth.uid())
    returning id into v_id;
  exception
    when unique_violation then
      raise exception using message = 'Já existe um cadastro ativo com este nome e telefone. Nenhum cadastro foi criado.',
                            hint = 'larica:customer_exists';
  end;

  insert into public.customer_link_audit (batch_id, action, customer_id, actor, details)
  values (gen_random_uuid(), 'customer_created', v_id, auth.uid(),
          jsonb_build_object('source', 'admin',
                             'manual', true,
                             'display_name', v_check -> 'normalized' ->> 'display_name',
                             'phone_e164', v_check -> 'normalized' ->> 'phone',
                             'eircode_informed', (v_check -> 'normalized' ->> 'eircode') is not null,
                             'acknowledged_warnings', to_jsonb(v_warnings),
                             'request_id', v_request,
                             'request_fingerprint', case when v_request is not null then v_fingerprint end));

  return jsonb_build_object('success', true, 'already_created', false, 'customer_id', v_id,
                            'display_name', v_check -> 'normalized' ->> 'display_name',
                            'phone', v_check -> 'normalized' ->> 'phone',
                            'eircode', v_check -> 'normalized' ->> 'eircode',
                            'status', 'active');
end;
$function$;

-- Perfil do cadastro (inclui o Eircode, que get_customer_detail não devolve).
CREATE FUNCTION public.admin_get_customer_profile(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  select jsonb_build_object('customer_id', c.id, 'display_name', c.display_name, 'phone', c.phone_e164,
                            'eircode', c.eircode, 'status', c.status, 'source', c.source,
                            'created_at', c.created_at, 'updated_at', c.updated_at)
    into v_result
  from public.customers c
  where c.id = p_customer_id;

  if v_result is null then
    raise exception using message = 'Cliente não encontrado.', hint = 'larica:customer_not_found';
  end if;

  return v_result;
end;
$function$;

-- Edição só do Eircode (vazio/NULL = remover). Auditoria customer_updated SEM o texto do
-- Eircode: só indicadores (added | changed | removed, had_before, has_after).
CREATE FUNCTION public.admin_update_customer_eircode(p_customer_id uuid, p_eircode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_raw text := nullif(btrim(coalesce(p_eircode, '')), '');
  v_new text := public.normalize_customer_eircode(p_eircode);
  v_status text;
  v_old text;
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  if v_raw is not null and v_new is null then
    raise exception using message = 'Eircode inválido: use 7 letras/números (ex.: D03 FX92).', hint = 'larica:invalid',
                          detail = jsonb_build_object('eircode', 'invalid')::text;
  end if;

  perform set_config('lock_timeout', '5s', true);
  begin
    select c.status, c.eircode into v_status, v_old
    from public.customers c
    where c.id = p_customer_id
    for no key update;
  exception
    when lock_not_available then
      raise exception using message = 'Este cadastro está sendo alterado por outra operação. Nada foi gravado; tente novamente.',
                            hint = 'larica:busy';
  end;

  if v_status is null then
    raise exception using message = 'Cliente não encontrado.', hint = 'larica:customer_not_found';
  end if;
  if v_status <> 'active' then
    raise exception using message = 'Cadastro arquivado não pode ser editado.', hint = 'larica:customer_archived';
  end if;

  if v_old is not distinct from v_new then
    return jsonb_build_object('success', true, 'changed', false, 'customer_id', p_customer_id, 'eircode', v_new);
  end if;

  update public.customers
     set eircode = v_new, updated_at = now(), updated_by = auth.uid()
   where id = p_customer_id;

  insert into public.customer_link_audit (batch_id, action, customer_id, actor, details)
  values (gen_random_uuid(), 'customer_updated', p_customer_id, auth.uid(),
          jsonb_build_object('field', 'eircode',
                             'change', case when v_old is null then 'added' when v_new is null then 'removed' else 'changed' end,
                             'had_before', v_old is not null,
                             'has_after', v_new is not null,
                             'source', 'admin_update_customer_eircode'));

  return jsonb_build_object('success', true, 'changed', true, 'customer_id', p_customer_id, 'eircode', v_new);
end;
$function$;


-- =====================================================================================
-- 3) Pesquisa de pedidos e vinculação individual
-- =====================================================================================

-- Pesquisa por número (123 / #LARICA-123), por dígitos do telefone (6+ dígitos; 087... casa
-- com 35387...) ou por nome normalizado (contém). Qualquer status. Mais recentes primeiro.
-- link_state em relação ao cliente: none | this | other | excluded. warnings = mesma regra
-- da vinculação (prévia; a vinculação recalcula).
CREATE FUNCTION public.admin_search_orders_for_link(
  p_customer_id uuid,
  p_search text,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := left(nullif(btrim(coalesce(p_search, '')), ''), 80);
  v_c_id uuid;
  v_c_name_key text;
  v_c_phone text;
  v_num bigint;
  v_digits text;
  v_phone_digits text;
  v_phone_sem_zero text;
  v_name_like text;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  select c.id, c.name_key, c.phone_e164 into v_c_id, v_c_name_key, v_c_phone
  from public.customers c
  where c.id = p_customer_id;
  if v_c_id is null then
    raise exception using message = 'Cliente não encontrado.', hint = 'larica:customer_not_found';
  end if;

  if v_search is null or char_length(v_search) < 2 then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'too_short', true);
  end if;

  v_digits := nullif(regexp_replace(v_search, '[^0-9]', '', 'g'), '');

  if lower(v_search) ~ '^#?[[:space:]]*(larica)?[[:space:]-]*[0-9]{1,12}$' then
    v_num := v_digits::bigint;
  end if;

  if v_search !~ '[[:alpha:]]' and v_digits is not null and char_length(v_digits) >= 6 then
    v_phone_digits := v_digits;
    if v_digits like '0%' then
      v_phone_sem_zero := substr(v_digits, 2);
    end if;
  end if;

  if v_num is null and v_search ~ '[[:alpha:]]' then
    v_name_like := '%' || replace(replace(replace(public.normalize_customer_name(v_search), '#', '##'), '%', '#%'), '_', '#_') || '%';
  end if;

  if v_num is null and v_phone_digits is null and v_name_like is null then
    return jsonb_build_object('total', 0, 'rows', '[]'::jsonb, 'too_short', false);
  end if;

  with base as (
    select o.id,
           o.order_number::bigint as order_number,
           o.created_at,
           o.status::text as status,
           o.total::numeric as total,
           o.customer_name,
           o.customer_phone,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk,
           l.state as link_state,
           l.customer_id as link_customer_id
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where (v_num is not null and o.order_number::bigint = v_num)
       or (v_phone_digits is not null
           and (regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g') like '%' || v_phone_digits || '%'
                or coalesce(public.normalize_customer_phone(o.customer_phone), '') like '%' || coalesce(v_phone_sem_zero, v_phone_digits) || '%'))
       or (v_name_like is not null
           and public.normalize_customer_name(o.customer_name) like v_name_like escape '#')
  ),
  pagina as (
    select * from base
    order by created_at desc, id desc
    limit v_limit offset v_offset
  )
  select jsonb_build_object(
           'total', (select count(*) from base),
           'too_short', false,
           'rows', coalesce(jsonb_agg(jsonb_build_object(
             'order_id', p.id,
             'order_number', p.order_number,
             'created_at', p.created_at,
             'status', p.status,
             'total', p.total,
             'customer_name', p.customer_name,
             'customer_phone', p.customer_phone,
             'phone_recognized', p.pk is not null,
             'link_state', case
                             when p.link_state is null then 'none'
                             when p.link_state = 'excluded' then 'excluded'
                             when p.link_customer_id = v_c_id then 'this'
                             else 'other'
                           end,
             'linked_customer_id', case when p.link_state = 'linked' and p.link_customer_id <> v_c_id then p.link_customer_id end,
             'linked_customer_name', case when p.link_state = 'linked' and p.link_customer_id <> v_c_id then oc.display_name end,
             'last_audit_action', case when p.link_state = 'excluded' then (
                                    select a.action from public.customer_link_audit a
                                    where a.order_id = p.id
                                    order by a.id desc
                                    limit 1) end,
             'warnings', to_jsonb(public._customer_manual_link_warnings(v_c_name_key, v_c_phone, p.nk, p.pk, p.status))
           ) order by p.created_at desc, p.id desc), '[]'::jsonb)
         )
    into v_result
  from pagina p
  left join public.customers oc on oc.id = p.link_customer_id;

  return v_result;
end;
$function$;

-- Vinculação manual de UM pedido. Tudo ou nada (uma transação). Ver cabeçalho para a
-- ordem de locks. Nunca transfere; reativa 'excluded' só com confirmação; avisos
-- recalculados e exigidos aqui; pedido não é alterado.
CREATE FUNCTION public.admin_link_order_to_customer(
  p_customer_id uuid,
  p_order_id uuid,
  p_confirm_reactivation boolean DEFAULT false,
  p_acknowledged_warnings text[] DEFAULT '{}',
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ack text[] := coalesce(p_acknowledged_warnings, '{}');
  v_c_status text;
  v_c_name_key text;
  v_c_phone text;
  v_o_id uuid;
  v_o_number bigint;
  v_o_status text;
  v_o_name_key text;
  v_o_phone text;
  v_l_exists boolean := false;
  v_l_state text;
  v_l_customer uuid;
  v_other_name text;
  v_prev_action text;
  v_warnings text[];
  v_missing text[];
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  if p_customer_id is null or p_order_id is null then
    raise exception using message = 'Cliente e pedido são obrigatórios.', hint = 'larica:invalid';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception using message = 'Motivo muito longo (máximo de 500 caracteres).', hint = 'larica:invalid',
                          detail = jsonb_build_object('reason', 'too_long')::text;
  end if;

  perform set_config('lock_timeout', '5s', true);
  begin
    perform pg_advisory_xact_lock(hashtext('larica.customer_registry'));

    select c.status, c.name_key, c.phone_e164
      into v_c_status, v_c_name_key, v_c_phone
    from public.customers c
    where c.id = p_customer_id
    for no key update;

    select o.id, o.order_number::bigint, o.status::text,
           public.normalize_customer_name(o.customer_name),
           public.normalize_customer_phone(o.customer_phone)
      into v_o_id, v_o_number, v_o_status, v_o_name_key, v_o_phone
    from public.orders o
    where o.id = p_order_id
    for key share;

    select true, l.state, l.customer_id
      into v_l_exists, v_l_state, v_l_customer
    from public.order_customer_links l
    where l.order_id = p_order_id
    for update;
  exception
    when lock_not_available then
      raise exception using message = 'O cadastro ou o pedido está ocupado por outra operação (sincronização, edição ou exclusão). Nada foi gravado; tente novamente.',
                            hint = 'larica:busy';
  end;
  v_l_exists := coalesce(v_l_exists, false);

  if v_c_status is null then
    raise exception using message = 'Cliente não encontrado.', hint = 'larica:customer_not_found';
  end if;
  if v_c_status <> 'active' then
    raise exception using message = 'Cadastro arquivado: não é possível vincular pedidos.', hint = 'larica:customer_archived';
  end if;
  if v_o_id is null then
    raise exception using message = 'Pedido não encontrado (pode ter sido excluído).', hint = 'larica:order_not_found';
  end if;

  if v_l_exists and v_l_state = 'linked' then
    if v_l_customer = p_customer_id then
      return jsonb_build_object('success', true, 'already_linked', true, 'reactivated', false,
                                'order_id', p_order_id, 'order_number', v_o_number, 'customer_id', p_customer_id);
    end if;
    select c.display_name into v_other_name from public.customers c where c.id = v_l_customer;
    raise exception using message = format('O pedido #LARICA-%s já está vinculado a outro cliente (%s). Ele não é transferido automaticamente; nada foi alterado.',
                                           v_o_number, coalesce(v_other_name, 'cadastro desconhecido')),
                          hint = 'larica:linked_to_other',
                          detail = jsonb_build_object('customer_id', v_l_customer, 'display_name', v_other_name)::text;
  end if;

  if v_l_exists and v_l_state = 'excluded' then
    select a.action into v_prev_action
    from public.customer_link_audit a
    where a.order_id = p_order_id
    order by a.id desc
    limit 1;

    if not coalesce(p_confirm_reactivation, false) then
      raise exception using message = format('O pedido #LARICA-%s foi desvinculado anteriormente. Confirme a reativação explicitamente para vinculá-lo.', v_o_number),
                            hint = 'larica:reactivation_required',
                            detail = jsonb_build_object('last_audit_action', v_prev_action)::text;
    end if;
  end if;

  v_warnings := public._customer_manual_link_warnings(v_c_name_key, v_c_phone, v_o_name_key, v_o_phone, v_o_status);
  select coalesce(array_agg(x.w order by x.w), '{}') into v_missing
  from unnest(v_warnings) as x(w)
  where not (x.w = any (v_ack));

  if cardinality(v_missing) > 0 then
    raise exception using message = 'Confirmação necessária: os dados do pedido divergem do cadastro. Nada foi alterado.',
                          hint = 'larica:confirmation_required',
                          detail = jsonb_build_object('warnings', to_jsonb(v_missing))::text;
  end if;

  begin
    if v_l_exists then
      update public.order_customer_links
         set state = 'linked', customer_id = p_customer_id, link_source = 'admin',
             linked_at = now(), linked_by = auth.uid()
       where order_id = p_order_id and state = 'excluded';
    else
      insert into public.order_customer_links (order_id, order_number, state, customer_id, link_source, linked_by)
      values (p_order_id, v_o_number, 'linked', p_customer_id, 'admin', auth.uid());
    end if;
  exception
    when unique_violation then
      raise exception using message = 'O pedido foi vinculado por outro processo neste instante. Nada foi alterado; reabra a ficha e confira.',
                            hint = 'larica:conflict';
  end;

  insert into public.customer_link_audit
    (batch_id, action, order_id, order_number, customer_id, previous_customer_id, actor, reason, details)
  values (gen_random_uuid(), 'link', p_order_id, v_o_number, p_customer_id, null, auth.uid(), v_reason,
          jsonb_build_object('source', 'admin',
                             'manual', true,
                             'previous_state', case when v_l_exists then v_l_state else 'none' end,
                             'reactivated', v_l_exists,
                             'previous_exclusion_action', v_prev_action,
                             'order_status', v_o_status,
                             'warnings_acknowledged', to_jsonb(v_warnings)));

  return jsonb_build_object('success', true, 'already_linked', false, 'reactivated', v_l_exists,
                            'order_id', p_order_id, 'order_number', v_o_number, 'customer_id', p_customer_id,
                            'warnings_acknowledged', to_jsonb(v_warnings));
end;
$function$;


-- =====================================================================================
-- 4) Privilégios + verificação final
-- =====================================================================================
-- Internas: só o dono. RPCs: is_admin() dentro; só authenticated executa. Nenhum backend
-- usa estas RPCs com service_role (e sem login is_admin() seria falso de todo modo), então
-- o EXECUTE que o Supabase concede por padrão a service_role é revogado também.

REVOKE ALL ON FUNCTION public._customer_registration_check(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._customer_manual_link_warnings(text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_check_customer_duplicates(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_check_customer_duplicates(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_create_customer(text, text, text, text[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_customer(text, text, text, text[], text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_get_customer_profile(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_customer_profile(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_update_customer_eircode(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_customer_eircode(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_search_orders_for_link(uuid, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_search_orders_for_link(uuid, text, integer, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_link_order_to_customer(uuid, uuid, boolean, text[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_link_order_to_customer(uuid, uuid, boolean, text[], text) TO authenticated;

-- Verificação final. Permissões em duas camadas:
--   (1) ACL declarada (pg_proc.proacl via aclexplode): ACL nula = padrão (PUBLIC executa)
--       -> falha; EXECUTE só pode estar concedido ao dono e, nas RPCs, a authenticated
--       (qualquer outro grantee, inclusive PUBLIC = grantee 0, falha);
--   (2) privilégio EFETIVO (has_function_privilege, com herança de papéis): anon e
--       service_role = false em todas; authenticated = true só nas RPCs.
-- Atributos: SECURITY DEFINER nas RPCs e INVOKER nas internas; search_path ''; volatilidade;
-- e (textual, indicativo) is_admin() como primeira instrução de cada RPC.
DO $verificacao$
declare
  v_falhas text := '';
  v_authenticated oid := (select oid from pg_roles where rolname = 'authenticated');
  v_corpo text;
  c_inicio_admin constant text := 'ifnotpublic.is_admin()then';
  r record;
begin
  for r in
    select f.assinatura, f.interna, f.volatilidade, p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl,
           p.proowner, p.prosrc
    from (values
      ('public._customer_registration_check(text,text,text)',                   true,  's'),
      ('public._customer_manual_link_warnings(text,text,text,text,text)',       true,  'i'),
      ('public.admin_check_customer_duplicates(text,text,text)',                false, 's'),
      ('public.admin_create_customer(text,text,text,text[],text)',              false, 'v'),
      ('public.admin_get_customer_profile(uuid)',                               false, 's'),
      ('public.admin_update_customer_eircode(uuid,text)',                       false, 'v'),
      ('public.admin_search_orders_for_link(uuid,text,integer,integer)',        false, 's'),
      ('public.admin_link_order_to_customer(uuid,uuid,boolean,text[],text)',    false, 'v')
    ) as f(assinatura, interna, volatilidade)
    left join pg_proc p on p.oid = to_regprocedure(f.assinatura)
  loop
    if r.oid is null then
      v_falhas := v_falhas || format(' [%s não foi criada]', r.assinatura);
      continue;
    end if;
    if r.proconfig is distinct from array['search_path=""'] then
      v_falhas := v_falhas || format(' [%s: search_path %s]', r.assinatura, r.proconfig);
    end if;
    if r.provolatile::text <> r.volatilidade then
      v_falhas := v_falhas || format(' [%s: volatilidade %s]', r.assinatura, r.provolatile::text);
    end if;
    if r.interna and r.prosecdef then
      v_falhas := v_falhas || format(' [interna %s deveria ser SECURITY INVOKER]', r.assinatura);
    end if;
    if not r.interna and not r.prosecdef then
      v_falhas := v_falhas || format(' [%s não é SECURITY DEFINER]', r.assinatura);
    end if;

    -- (1) ACL declarada
    if r.proacl is null then
      v_falhas := v_falhas || format(' [%s com ACL padrão (PUBLIC executa)]', r.assinatura);
    elsif exists (select 1 from aclexplode(r.proacl) x
                  where x.privilege_type = 'EXECUTE'
                    and x.grantee <> r.proowner
                    and (r.interna or x.grantee is distinct from v_authenticated)) then
      v_falhas := v_falhas || format(' [%s com EXECUTE concedido a papel não previsto: %s]', r.assinatura,
        (select string_agg(case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end, ', ')
         from aclexplode(r.proacl) x
         where x.privilege_type = 'EXECUTE' and x.grantee <> r.proowner
           and (r.interna or x.grantee is distinct from v_authenticated)));
    end if;

    -- (2) privilégio efetivo
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      v_falhas := v_falhas || format(' [%s executável por anon]', r.assinatura);
    end if;
    if has_function_privilege('service_role', r.oid, 'EXECUTE') then
      v_falhas := v_falhas || format(' [%s executável por service_role]', r.assinatura);
    end if;
    if r.interna and has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      v_falhas := v_falhas || format(' [interna %s executável por authenticated]', r.assinatura);
    end if;
    if not r.interna and not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      v_falhas := v_falhas || format(' [%s sem EXECUTE para authenticated]', r.assinatura);
    end if;

    -- is_admin() logo depois do 1º BEGIN do corpo (texto sem espaços, minúsculo; indicativo)
    if not r.interna or r.assinatura like 'public._customer_registration_check(%' then
      v_corpo := regexp_replace(lower(r.prosrc), '[[:space:]]+', '', 'g');
      if position('begin' in v_corpo) = 0
         or substr(v_corpo, position('begin' in v_corpo) + 5, length(c_inicio_admin)) <> c_inicio_admin then
        v_falhas := v_falhas || format(' [%s: is_admin() não é a primeira instrução]', r.assinatura);
      end if;
    end if;
  end loop;

  -- Tabelas continuam fechadas (nada nesta migration mexe nelas; conferência de segurança)
  if exists (select 1 from pg_class c
             where c.oid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
               and not c.relrowsecurity)
     or has_table_privilege('anon', 'public.customers', 'SELECT')
     or has_table_privilege('authenticated', 'public.customers', 'SELECT')
     or has_table_privilege('authenticated', 'public.order_customer_links', 'SELECT')
     or has_table_privilege('authenticated', 'public.customer_link_audit', 'SELECT') then
    v_falhas := v_falhas || ' [tabelas do cadastro abertas para anon/authenticated ou sem RLS]';
  end if;

  -- Regra de avisos (função pura) com casos conhecidos
  if public._customer_manual_link_warnings('ana', '353871234567', 'ana', '353871234567', 'completed') <> '{}'::text[]
     or public._customer_manual_link_warnings('ana', '353871234567', 'bia', null, 'cancelled')
        <> array['name_mismatch', 'phone_mismatch', 'order_cancelled']::text[]
     or public._customer_manual_link_warnings('ana', null, 'ana', '353871234567', 'completed') <> array['phone_mismatch']::text[] then
    v_falhas := v_falhas || ' [_customer_manual_link_warnings com resultado inesperado]';
  end if;

  if v_falhas <> '' then
    raise exception 'M2 desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
