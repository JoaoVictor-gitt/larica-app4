-- =====================================================================================
-- TESTES PÓS-MIGRATION — SOMENTE LEITURA (seguros para produção, com autorização)
-- Cadastro de clientes: passos 1, 2 e 3 (20261009100000, 20261009100050, 20261009100100).
--
-- NÃO é migration e NÃO entra no deploy. Nenhum teste deste arquivo executa INSERT,
-- UPDATE, DELETE ou ALTER: só SELECT, troca de papel/claims dentro da transação e
-- chamadas a RPCs de leitura (ou que são recusadas antes de escrever).
-- Para garantir isso no próprio banco, rode CADA bloco dentro de uma transação somente
-- leitura — qualquer tentativa de escrita falharia:
--     begin transaction read only;
--     <bloco>
--     rollback;
--
-- Os testes que escrevem (exclusão de pedido, sincronização forçada, auditoria, falha
-- simulada) estão em 20261009_customer_registry_pos_isolado.sql e são RESERVADOS a
-- ambiente isolado — nunca em produção.
--
-- Os blocos DO terminam com "RESULTADO: ..." como erro (proposital: nada fica gravado nem
-- configurado). A mensagem precisa começar com "RESULTADO: OK".
--
-- Placeholders:
--   <UUID_ADMIN>     id (auth.users/profiles) de um admin ativo
--   <UUID_EMPLOYEE>  id de um funcionário ativo (role employee)
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- TESTE 1 — Estrutura, RLS, privilégios efetivos e propriedade (após o passo 1)
-- -------------------------------------------------------------------------------------
-- 1a) RLS ligada (relrowsecurity true), sem FORCE, e nenhuma policy (0 linhas na 2ª consulta)
select relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) as dono
from pg_class
where oid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass);

select tablename, policyname from pg_policies
where schemaname = 'public' and tablename in ('customers', 'order_customer_links', 'customer_link_audit');

-- 1b) Privilégios efetivos nas tabelas e na sequência. Esperado: tudo false.
select r.papel, t.tabela,
       has_table_privilege(r.papel, t.tabela, 'SELECT') as sel,
       has_table_privilege(r.papel, t.tabela, 'INSERT') as ins,
       has_table_privilege(r.papel, t.tabela, 'UPDATE') as upd,
       has_table_privilege(r.papel, t.tabela, 'DELETE') as del,
       has_table_privilege(r.papel, t.tabela, 'TRUNCATE') as trunc
from unnest(array['anon', 'authenticated', 'service_role']) as r(papel)
cross join unnest(array['public.customers', 'public.order_customer_links', 'public.customer_link_audit']) as t(tabela)
order by 1, 2;

select papel, has_sequence_privilege(papel, 'public.customer_link_audit_id_seq', 'USAGE') as usage_seq
from unnest(array['anon', 'authenticated', 'service_role']) as papel;

-- 1c) EXECUTE efetivo por papel. Esperado:
--     RPCs (sync/overview/list/detail): anon=false, authenticated=true (service_role=true é
--                                       o padrão do Supabase; is_admin() recusa — auth.uid() nulo)
--     internas (_customer_*):           anon=false, authenticated=false, service_role=false
--     normalize_*:                      true para todos (funções puras)
select f, has_function_privilege('anon', f, 'execute') as anon,
          has_function_privilege('authenticated', f, 'execute') as authenticated,
          has_function_privilege('service_role', f, 'execute') as service_role
from unnest(array[
  'public.sync_phone_customer_links(integer)',
  'public.get_customers_overview()',
  'public.list_customers(text,text,text,integer,integer)',
  'public.get_customer_detail(uuid,uuid,integer,integer)',
  'public._customer_registry_link_by_phone(text,integer)',
  'public._customer_registry_reconcile_deleted_orders(integer)',
  'public._customer_orders_json(uuid[])',
  'public._customer_top_products_json(uuid[])',
  'public._customer_links_audit_on_delete()',
  'public._customer_link_audit_immutable()',
  'public.normalize_customer_name(text)',
  'public.normalize_customer_phone(text)'
]) as f;

-- 1d) SECURITY DEFINER, search_path vazio e DONO. Esperado: prosecdef true em todas exceto
--     normalize_* e _customer_link_audit_immutable; proconfig = {search_path=""} em todas;
--     dono igual ao dono das três tabelas (1a) — é com esse papel que as RPCs leem orders.
select p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) as dono
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('normalize_customer_name', 'normalize_customer_phone', '_customer_link_audit_immutable',
                    '_customer_links_audit_on_delete', '_customer_registry_link_by_phone',
                    '_customer_registry_reconcile_deleted_orders', '_customer_orders_json',
                    '_customer_top_products_json', 'sync_phone_customer_links', 'get_customers_overview',
                    'list_customers', 'get_customer_detail')
order by 1;

-- 1e) O dono das funções lê orders/filhas sem filtro de RLS. Esperado: rls_filtraria vazio.
select (select string_agg(distinct pg_get_userbyid(p.proowner), ', ')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_customers_overview') as dono_rpcs,
       (select string_agg(c.relname, ', ')
        from pg_class c, pg_proc p
        where p.oid = 'public.get_customers_overview()'::regprocedure
          and c.oid in ('public.orders'::regclass, 'public.order_items'::regclass, 'public.order_item_selections'::regclass)
          and c.relrowsecurity
          and (c.relforcerowsecurity
               or (c.relowner <> p.proowner
                   and not (select rolbypassrls from pg_roles where oid = p.proowner)))) as rls_filtraria;

-- 1f) Constraints, índices e triggers do cadastro
select conrelid::regclass as tabela, conname, contype, convalidated, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
order by 1, 2;
-- Esperado (após o passo 2): order_customer_links_order_fk com convalidated = true e
-- "ON DELETE CASCADE"; order_customer_links_customer_fk "ON DELETE RESTRICT".

select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename in ('customers', 'order_customer_links', 'customer_link_audit')
order by 1, 2;
-- Esperado: inclui customers_identity_active_uq (UNIQUE ... WHERE status = 'active') e
-- customer_link_audit_order_deleted_uq (UNIQUE (order_id) WHERE action = 'order_deleted').

select tgrelid::regclass as tabela, tgname, pg_get_triggerdef(oid) as definicao
from pg_trigger
where tgrelid in ('public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
  and not tgisinternal;
-- Esperado: customer_links_audit_on_delete (AFTER DELETE) e customer_link_audit_immutable
-- (BEFORE UPDATE OR DELETE).

-- 1g) Normalização (coluna ok = true em todas)
select entrada, esperado, public.normalize_customer_phone(entrada) as obtido,
       esperado is not distinct from public.normalize_customer_phone(entrada) as ok
from (values ('087 123 4567', '353871234567'), ('+353 87 123 4567', '353871234567'), ('353871234567', '353871234567'),
             ('00353 87 123 4567', '353871234567'), ('+353 (0)87 123 4567', '353871234567'), ('87 123 4567', '353871234567'),
             ('01 234 5678', '35312345678'), ('+55 11 98765-4321', null), ('07700 900123', null), ('123', null), ('', null),
             (null, null)) v(entrada, esperado);

select entrada, esperado, public.normalize_customer_name(entrada) as obtido,
       esperado is not distinct from public.normalize_customer_name(entrada) as ok
from (values ('  Ana  Silva ', 'ana silva'), ('ANA SILVA', 'ana silva'), ('ana' || chr(160) || 'silva', 'ana silva'),
             ('João', 'joão'), ('Joao', 'joao'), ('   ', null)) v(entrada, esperado);


-- -------------------------------------------------------------------------------------
-- TESTE 2 — Backfill (após o passo 3; comparar com P3 e P4 da pré-validação)
-- -------------------------------------------------------------------------------------
select (select count(*) from public.customers) as cadastros,
       (select count(*) from public.customers where source = 'backfill') as cadastros_backfill,
       (select count(*) from public.order_customer_links where state = 'linked') as vinculos,
       (select count(*) from public.order_customer_links where state = 'excluded') as excluidos,   -- esperado 0
       (select count(*) from public.customer_link_audit where action = 'backfill') as auditoria_backfill,
       (select count(*) from public.customer_link_audit where action = 'customer_created') as auditoria_cadastros;
-- Esperado: cadastros_backfill = cadastros_previstos (P3); vinculos (de origem backfill) =
-- vinculos_previstos_todos_status; auditoria_backfill = vínculos de origem backfill;
-- auditoria_cadastros = cadastros. (Se a página Clientes já sincronizou pedidos novos,
-- cadastros/vínculos podem ser maiores — confira por source/link_source.)

select link_source, count(*) from public.order_customer_links group by 1;

-- Nenhum vínculo com nome/telefone diferente do cadastro. Esperado: 0.
select count(*) as vinculos_inconsistentes
from public.order_customer_links l
join public.orders o on o.id = l.order_id
join public.customers c on c.id = l.customer_id
where l.state = 'linked'
  and (public.normalize_customer_phone(o.customer_phone) is distinct from c.phone_e164
       or public.normalize_customer_name(o.customer_name) is distinct from c.name_key);

-- Nenhum pedido sem telefone reconhecido foi vinculado. Esperado: 0.
select count(*) as vinculados_sem_telefone
from public.order_customer_links l
join public.orders o on o.id = l.order_id
where l.state = 'linked' and public.normalize_customer_phone(o.customer_phone) is null;

-- Checksum de orders: rode P4 (corte fixo 2026-10-10 10:51:13.63358+00) — deve continuar
-- igual à referência registrada.


-- -------------------------------------------------------------------------------------
-- TESTE 3 — Acesso negado a não administradores (rodar dentro de transação read only)
-- -------------------------------------------------------------------------------------
DO $teste3$
declare
  v_msgs text := '';
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'RESULTADO: NÃO EXECUTADO — rode este bloco entre "begin transaction read only;" e "rollback;".';
  end if;

  -- 3a) anon: sem EXECUTE nas RPCs e sem acesso às tabelas
  execute 'set local role anon';
  begin
    perform public.list_customers();
    v_msgs := v_msgs || ' [FALHA anon executou list_customers]';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.customers limit 1;
    v_msgs := v_msgs || ' [FALHA anon leu customers]';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  -- 3b) funcionário autenticado: RPC recusa com "Acesso negado" (antes de qualquer escrita);
  --     tabelas e funções internas negadas
  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_EMPLOYEE>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.get_customers_overview();
    v_msgs := v_msgs || ' [FALHA employee executou overview]';
  exception when raise_exception then
    if sqlerrm <> 'Acesso negado' then v_msgs := v_msgs || ' [FALHA mensagem: ' || sqlerrm || ']'; end if;
  end;
  -- Só conta como sucesso a recusa por is_admin() ('Acesso negado'): qualquer outro erro
  -- (ex.: transação read only, função interna, lock) indicaria que a checagem não rodou
  -- primeiro, e é reportado como falha com o SQLSTATE e a mensagem recebidos.
  begin
    perform public.sync_phone_customer_links();
    v_msgs := v_msgs || ' [FALHA employee executou sync]';
  exception when others then
    if sqlstate <> 'P0001' or sqlerrm <> 'Acesso negado' then
      v_msgs := v_msgs || ' [FALHA sync como employee: esperado P0001 "Acesso negado", recebido ' || sqlstate || ' "' || sqlerrm || '"]';
    end if;
  end;
  begin
    perform 1 from public.order_customer_links limit 1;
    v_msgs := v_msgs || ' [FALHA employee leu order_customer_links]';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public._customer_registry_link_by_phone('auto_phone', 1);
    v_msgs := v_msgs || ' [FALHA employee executou função interna]';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  -- 3c) service_role: sem acesso direto às tabelas nem às funções internas
  execute 'set local role service_role';
  begin
    perform 1 from public.customer_link_audit limit 1;
    v_msgs := v_msgs || ' [FALHA service_role leu customer_link_audit]';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public._customer_registry_reconcile_deleted_orders(1);
    v_msgs := v_msgs || ' [FALHA service_role executou função interna]';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  -- 3d) admin: RPCs de leitura funcionam
  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_ADMIN>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform public.get_customers_overview();
  perform public.list_customers();
  execute 'reset role';

  if v_msgs = '' then
    raise exception 'RESULTADO: OK — anon, funcionário e service_role bloqueados; admin com acesso de leitura';
  else
    raise exception 'RESULTADO: FALHA —%', v_msgs;
  end if;
end;
$teste3$;


-- -------------------------------------------------------------------------------------
-- TESTE 7 — Métricas do overview batem com somas manuais pelos vínculos
--           (rodar dentro de transação read only)
-- -------------------------------------------------------------------------------------
DO $teste7$
declare
  v_ov jsonb;
  v_cadastrados bigint;
  v_compraram bigint;
  v_recorrentes bigint;
  v_pedidos bigint;
  v_total numeric;
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'RESULTADO: NÃO EXECUTADO — rode este bloco entre "begin transaction read only;" e "rollback;".';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_ADMIN>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ov := public.get_customers_overview();
  execute 'reset role';

  select count(*) into v_cadastrados from public.customers where status = 'active';
  select count(*), coalesce(sum(o.total), 0) into v_pedidos, v_total
  from public.order_customer_links l
  join public.orders o on o.id = l.order_id
  join public.customers c on c.id = l.customer_id and c.status = 'active'
  where l.state = 'linked' and o.status = 'completed';
  select count(*) filter (where n >= 1), count(*) filter (where n >= 2) into v_compraram, v_recorrentes
  from (select l.customer_id, count(*) n
        from public.order_customer_links l
        join public.orders o on o.id = l.order_id
        join public.customers c on c.id = l.customer_id and c.status = 'active'
        where l.state = 'linked' and o.status = 'completed' group by 1) x;

  if (v_ov->>'registered_customers')::bigint = v_cadastrados
     and (v_ov->>'buying_customers')::bigint = v_compraram
     and (v_ov->>'recurring_customers')::bigint = v_recorrentes
     and (v_ov->>'orders_count')::bigint = v_pedidos
     and (v_ov->>'total_spent')::numeric = v_total then
    raise exception 'RESULTADO: OK — overview = manual: %', v_ov;
  else
    raise exception 'RESULTADO: FALHA — overview %, manual: cadastrados % compraram % recorrentes % pedidos % total %',
      v_ov, v_cadastrados, v_compraram, v_recorrentes, v_pedidos, v_total;
  end if;
end;
$teste7$;
