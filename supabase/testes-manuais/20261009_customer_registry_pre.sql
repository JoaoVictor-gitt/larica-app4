-- =====================================================================================
-- PRÉ-VALIDAÇÃO (SOMENTE LEITURA) — rodar no SQL Editor ANTES de aplicar:
--   passo 1: supabase/migrations/20261009100000_add_customer_registry.sql
--   passo 2: supabase/migrations/20261009100050_add_customer_links_order_fk.sql
--   passo 3: supabase/migrations/20261009100100_backfill_customer_registry.sql
--
-- NÃO é migration e NÃO entra no deploy. Nenhuma consulta abaixo grava nada.
-- Recomendado: rodar dentro de `begin transaction read only;` ... `rollback;` (qualquer
-- tentativa de escrita falharia). Rode um bloco por vez e guarde os resultados.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- P1 — Conflito de nomes. Esperado: 0 linhas nas três consultas.
--      (Se aparecer algo, o passo 1 aborta sozinho — investigar antes.)
-- -------------------------------------------------------------------------------------
select c.relname, c.relkind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = any (array[
    'customers', 'customers_pkey', 'customers_identity_active_uq', 'customers_name_key_idx', 'customers_phone_e164_idx',
    'order_customer_links', 'order_customer_links_pkey', 'order_customer_links_customer_idx',
    'customer_link_audit', 'customer_link_audit_pkey', 'customer_link_audit_id_seq',
    'customer_link_audit_customer_idx', 'customer_link_audit_order_idx', 'customer_link_audit_order_deleted_uq']);

select t.typname
from pg_type t join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typname in ('customers', 'order_customer_links', 'customer_link_audit');

select p.proname, pg_get_function_identity_arguments(p.oid) args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = any (array[
    'normalize_customer_name', 'normalize_customer_phone',
    '_customer_link_audit_immutable', '_customer_links_audit_on_delete',
    '_customer_registry_link_by_phone', '_customer_registry_reconcile_deleted_orders',
    '_customer_orders_json', '_customer_top_products_json',
    'sync_phone_customer_links', 'get_customers_overview', 'list_customers', 'get_customer_detail']);


-- -------------------------------------------------------------------------------------
-- P2 — Tipos das colunas usadas. Esperado: orders.id uuid; order_number integer/bigint;
--      total/subtotal/delivery_fee/discount_amount numeric; customer_name/customer_phone
--      text; created_at timestamptz. status: text (se for enum, tudo bem — as RPCs comparam
--      com literais e convertem para text onde precisa).
-- -------------------------------------------------------------------------------------
select table_name, column_name, data_type, udt_name, is_nullable
from information_schema.columns
where table_schema = 'public' and (
  (table_name = 'orders' and column_name in ('id', 'order_number', 'status', 'created_at', 'completed_at', 'cancelled_at',
     'cancel_reason', 'customer_name', 'customer_phone', 'fulfilment_type', 'payment_method', 'subtotal', 'delivery_fee',
     'discount_amount', 'total'))
  or (table_name = 'order_items' and column_name in ('id', 'order_id', 'product_id', 'product_name', 'item_type', 'quantity', 'total_price'))
  or (table_name = 'order_item_selections' and column_name in ('order_item_id', 'selection_type', 'selected_product_name', 'quantity', 'extra_price')))
order by table_name, column_name;
-- Esperado: 27 linhas (15 + 7 + 5). Coluna faltando = o passo 1 falha ao criar as funções.

select status, count(*) from public.orders group by 1 order by 2 desc;


-- -------------------------------------------------------------------------------------
-- P3 — Prévia do backfill.
--      As expressões nk/pk abaixo são CÓPIA LITERAL dos corpos de
--      public.normalize_customer_name() e public.normalize_customer_phone() da migration
--      (que ainda não existem no banco). Se a migration mudar, atualize aqui também.
--      Anote os valores: o passo 3 e o teste 2 (pós) devem bater com eles.
-- -------------------------------------------------------------------------------------
with n as (
  select o.id, o.status, o.customer_phone,
    nullif(
      lower(
        regexp_replace(
          btrim(translate(coalesce(o.customer_name, ''), chr(160) || chr(9) || chr(10) || chr(13), '    ')),
          '[[:space:]]+', ' ', 'g'
        )
      ),
      ''
    ) as nk,
    (select case
              when e ~ '^353[1-9][0-9]{6,8}$' then e
              when e ~ '^0[1-9][0-9]{6,8}$' then '353' || substr(e, 2)
              when e ~ '^8[3-9][0-9]{7}$' then '353' || e
              else null
            end
     from (
       select case when d ~ '^3530' then '353' || substr(d, 5) else d end as e
       from (
         select case when d0 ~ '^00' then substr(d0, 3) else d0 end as d
         from (select regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g') as d0) a
       ) b
     ) c) as pk
  from public.orders o
)
select
  count(distinct (nk, pk)) filter (where nk is not null and pk is not null)                          as cadastros_previstos,
  count(*) filter (where nk is not null and pk is not null)                                          as vinculos_previstos_todos_status,
  count(*) filter (where nk is not null and pk is not null and status = 'completed')                 as vinculos_previstos_finalizados,
  count(distinct (nk, pk)) filter (where nk is not null and pk is not null and status = 'completed') as pares_com_pedido_finalizado,
  count(*) filter (where status = 'completed' and (nk is null or pk is null))                        as finalizados_que_ficam_sem_cadastro,
  count(*) filter (where nk is null or pk is null)                                                   as todos_que_ficam_sem_cadastro,
  count(*) filter (where coalesce(btrim(customer_phone), '') <> '' and pk is null)                   as telefone_nao_reconhecido,
  count(*) filter (where nk is null)                                                                 as pedidos_sem_nome,
  (select count(*) from (select nk from n where nk is not null and pk is not null group by nk having count(distinct pk) > 1) x)
                                                                                                     as nomes_repetidos_previstos,
  (select count(*) from (select pk from n where nk is not null and pk is not null group by pk having count(distinct nk) > 1) y)
                                                                                                     as telefones_compartilhados_previstos
from n;
-- Observação: pedidos cancelados/em andamento com telefone também são vinculados (por isso
-- vinculos_previstos_todos_status >= vinculos_previstos_finalizados) — só não entram nas
-- métricas.

-- P3b — Telefones preenchidos que NÃO serão reconhecidos (ficam como não cadastrados).
--       Mesma expressão de normalização de P3 (cópia literal da função), sem atalho por regex.
select o.customer_phone, count(*) as pedidos
from public.orders o
where coalesce(btrim(o.customer_phone), '') <> ''
  and (select case
                when e ~ '^353[1-9][0-9]{6,8}$' then e
                when e ~ '^0[1-9][0-9]{6,8}$' then '353' || substr(e, 2)
                when e ~ '^8[3-9][0-9]{7}$' then '353' || e
                else null
              end
       from (
         select case when d ~ '^3530' then '353' || substr(d, 5) else d end as e
         from (
           select case when d0 ~ '^00' then substr(d0, 3) else d0 end as d
           from (select regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g') as d0) a
         ) b
       ) c) is null
group by 1
order by 2 desc;
-- A soma da coluna "pedidos" deve ser igual a telefone_nao_reconhecido (P3).


-- -------------------------------------------------------------------------------------
-- P4 — Checksum de orders: REFERÊNCIA HISTÓRICA FIXA.
--      Linha de base registrada: 336 pedidos com created_at < 2026-10-10 10:51:13.63358+00,
--      checksum d5acd26dfaa550796c67431ce3b9f308. A expressão do checksum é a MESMA usada
--      na linha de base — não altere.
--      Rode antes e depois de cada passo: pedidos e checksum devem continuar iguais à
--      referência (as migrations não alteram nenhum pedido).
-- -------------------------------------------------------------------------------------
select '2026-10-10 10:51:13.63358+00'::timestamptz as corte,
       count(*) as pedidos,                         -- referência: 336
       md5(string_agg(id::text || '|' || coalesce(customer_name, '') || '|' || coalesce(customer_phone, '') || '|'
                      || status::text || '|' || coalesce(total::text, ''), ',' order by id)) as checksum,
       md5(string_agg(id::text || '|' || coalesce(customer_name, '') || '|' || coalesce(customer_phone, '') || '|'
                      || status::text || '|' || coalesce(total::text, ''), ',' order by id)) = 'd5acd26dfaa550796c67431ce3b9f308' as igual_a_referencia
from public.orders
where created_at < '2026-10-10 10:51:13.63358+00'::timestamptz;
-- Se "pedidos" ou o checksum diferirem da referência, ANTES de concluir que algo alterou
-- pedidos, verifique causas legítimas da operação normal ocorridas depois do corte:
--   (a) exclusão de pedidos no Histórico (pedidos < 336);
--   (b) mudança de status de pedidos que estavam em andamento no corte (o status entra no
--       checksum). Para isolar (b), compare também o checksum sem status (P4b), anotando-o
--       AGORA, antes de aplicar.

-- P4b — Checksum sem status (anotar antes de aplicar; comparar depois com o mesmo corte).
select md5(string_agg(id::text || '|' || coalesce(customer_name, '') || '|' || coalesce(customer_phone, '') || '|'
                      || coalesce(total::text, ''), ',' order by id)) as checksum_sem_status
from public.orders
where created_at < '2026-10-10 10:51:13.63358+00'::timestamptz;


-- -------------------------------------------------------------------------------------
-- P5 — Ambiente: triggers, RLS, privilégios, funções de apoio, transações e locks.
-- -------------------------------------------------------------------------------------
-- P5a — Triggers em orders e filhas. Procure efeitos FORA da transação (net.http_post,
--       pg_net, http, dblink, pg_notify para sistemas externos). Informativo: os testes que
--       excluem pedidos ficam reservados a ambiente isolado de qualquer forma.
select c.relname as tabela, t.tgname, pg_get_triggerdef(t.oid) as definicao,
       p.proname as funcao,
       (pg_get_functiondef(p.oid) ~* '(net[.]|http_|pg_net|dblink|pg_notify)') as possivel_efeito_externo
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where c.oid in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.order_item_selections'::regclass)
  and not t.tgisinternal
order by 1, 2;

-- P5b — FKs que apontam para orders e o comportamento ON DELETE (como a exclusão no
--       Histórico já se propaga hoje).
select conrelid::regclass as tabela, conname, confdeltype as on_delete  -- a=no action r=restrict c=cascade n=set null
from pg_constraint
where contype = 'f' and confrelid = 'public.orders'::regclass
order by 1;

-- P5c — RLS e policies de orders e filhas (a exclusão no Histórico continua sob estas policies).
select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as dono
from pg_class
where oid in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.order_item_selections'::regclass);
select tablename, policyname, cmd, roles, qual
from pg_policies where schemaname = 'public' and tablename in ('orders', 'order_items', 'order_item_selections');

-- P5c2 — Prévia das pré-condições que o passo 1 verifica (rodar COM O MESMO PAPEL que vai
--        aplicar a migration). Esperado: todas as colunas true e rls_filtraria_leitura vazio.
select current_user,
       has_table_privilege(current_user, 'public.orders', 'SELECT') as select_orders,
       has_table_privilege(current_user, 'public.orders', 'REFERENCES') as references_orders,
       has_table_privilege(current_user, 'public.order_items', 'SELECT') as select_order_items,
       has_table_privilege(current_user, 'public.order_item_selections', 'SELECT') as select_selections,
       has_function_privilege(current_user, 'public.is_admin()', 'EXECUTE') as exec_is_admin,
       has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') as exec_auth_uid,
       (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls,
       (select string_agg(c.relname, ', ')
        from pg_class c
        where c.oid in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.order_item_selections'::regclass)
          and c.relrowsecurity
          and (c.relforcerowsecurity
               or (c.relowner <> (select oid from pg_roles where rolname = current_user)
                   and not (select rolbypassrls from pg_roles where rolname = current_user)))) as rls_filtraria_leitura;

-- P5d — Funções de apoio e versão (esperado: is_admin igual ao baseline; versão 17.x)
select pg_get_functiondef('public.is_admin()'::regprocedure);
select to_regprocedure('auth.uid()') as auth_uid, to_regprocedure('gen_random_uuid()') as gen_random_uuid,
       current_setting('server_version') as versao;

-- P5e — Privilégios padrão que o Supabase aplica em objetos novos (a migration revoga
--       explicitamente de PUBLIC/anon/authenticated/service_role nas tabelas e sequência
--       novas e nas funções internas).
select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace;

-- P5f — LOGO ANTES DE CADA PASSO: transações abertas e locks em orders.
--       Esperado: nenhuma transação antiga ("idle in transaction" ou longa) e nenhum lock
--       pendente (granted = false) em orders. Especialmente antes do passo 2 (FK).
select pid, usename, application_name, state, now() - xact_start as duracao, left(query, 100) as consulta
from pg_stat_activity
where datname = current_database() and xact_start is not null and pid <> pg_backend_pid()
order by xact_start;

select l.pid, l.mode, l.granted, a.state, now() - a.xact_start as duracao_transacao, left(a.query, 80) as consulta
from pg_locks l
left join pg_stat_activity a on a.pid = l.pid
where l.relation = 'public.orders'::regclass;
