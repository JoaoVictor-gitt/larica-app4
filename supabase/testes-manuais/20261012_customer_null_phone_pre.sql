-- =====================================================================================
-- PRÉ-CHECAGEM (SOMENTE LEITURA) — antes de aplicar
-- supabase/migrations/20261012100000_fix_customer_list_null_phone.sql
--
-- NÃO é migration e NÃO entra no deploy. Rode cada bloco dentro de:
--     begin transaction read only;  <bloco>  rollback;
-- Placeholder: <UUID_ADMIN> = id de um admin ativo.
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- C1 — A guarda da migration vai passar? Esperado nas DUAS linhas: md5_producao_ok,
--      md5_normalizado_ok e atributos_ok = true; tem_crlf = true (produção grava CRLF).
--      Histórico: em 2026-10-12 o md5 bruto diferiu do repositório só por CRLF (ver
--      cabeçalho da migration). Se md5_producao_ok = false, algo mudou desde então: NÃO
--      aplique — envie o resultado de C2.
-- -------------------------------------------------------------------------------------
select f.assinatura,
       md5(p.prosrc) as md5_atual,
       md5(p.prosrc) = f.md5_producao as md5_producao_ok,
       md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) = f.md5_repo_lf as md5_normalizado_ok,
       position(chr(13) in p.prosrc) > 0 as tem_crlf,
       (p.prosecdef and p.provolatile = 's' and l.lanname = 'plpgsql'
        and pg_get_function_result(p.oid) = 'jsonb'
        and p.proconfig is not distinct from array['search_path=""']) as atributos_ok,
       pg_get_userbyid(p.proowner) as dono,
       p.proacl
from (values
  ('public.list_customers(text,text,text,integer,integer)', 'b16705e5dd0a6ec1067baa4466db7ba4', '536e3d10c2f2fb8026b63df23320a6a5'),
  ('public.get_customers_overview()',                       '5568fa9012e443faf10cbaee9097bc35', '1d3b1f9a2110ea792c4369affafc0431')
) as f(assinatura, md5_producao, md5_repo_lf)
left join pg_proc p on p.oid = to_regprocedure(f.assinatura)
left join pg_language l on l.oid = p.prolang;

-- C1b — Confirma o trecho problemático em produção (esperado: true / true)
select position('join telefones_ativos ta on ta.phone_e164 = a.phone_e164' in prosrc) > 0 as tem_inner_join,
       position('(ta.n - 1)::bigint as shared_phone_count' in prosrc) > 0 as tem_shared_sem_coalesce
from pg_proc where oid = 'public.list_customers(text,text,text,integer,integer)'::regprocedure;


-- -------------------------------------------------------------------------------------
-- C2 — Definições atuais completas (guardar como registro; enviar se C1 falhar)
-- -------------------------------------------------------------------------------------
select pg_get_functiondef('public.list_customers(text,text,text,integer,integer)'::regprocedure);
select pg_get_functiondef('public.get_customers_overview()'::regprocedure);


-- -------------------------------------------------------------------------------------
-- C3 — Permissões efetivas ANTES (comparar com o mesmo comando depois; devem ser iguais).
--      Esperado: anon = false, authenticated = true.
-- -------------------------------------------------------------------------------------
select f, has_function_privilege('anon', f, 'execute') as anon,
          has_function_privilege('authenticated', f, 'execute') as authenticated,
          has_function_privilege('service_role', f, 'execute') as service_role
from unnest(array['public.list_customers(text,text,text,integer,integer)', 'public.get_customers_overview()']) as f;


-- -------------------------------------------------------------------------------------
-- C4 — Situação dos telefones nos cadastros ativos (ajuda a prever o efeito)
-- -------------------------------------------------------------------------------------
select count(*) filter (where phone_e164 is null)     as ativos_sem_telefone,
       count(*) filter (where phone_e164 is not null) as ativos_com_telefone,
       (select count(*) from (select phone_e164 from public.customers
                              where status = 'active' and phone_e164 is not null
                              group by phone_e164 having count(*) > 1) x) as telefones_compartilhados_reais
from public.customers
where status = 'active';
-- Após a correção: a lista passa a mostrar também os "ativos_sem_telefone" (antes ocultos) e
-- shared_phones do overview passa a ser exatamente "telefones_compartilhados_reais".


-- -------------------------------------------------------------------------------------
-- C5 — "Foto" do overview ANTES (como admin). Anote o JSON da mensagem: depois da correção,
--      TODAS as chaves devem ser iguais, exceto possivelmente 'shared_phones' (e as que
--      mudarem por pedidos/cadastros novos entre as duas execuções).
-- -------------------------------------------------------------------------------------
DO $c5$
declare v jsonb;
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'NÃO EXECUTADO — rode entre "begin transaction read only;" e "rollback;".';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_ADMIN>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v := public.get_customers_overview();
  execute 'reset role';
  raise exception 'OVERVIEW ANTES: %', v;
end;
$c5$;


-- -------------------------------------------------------------------------------------
-- C6 — Totais da lista por filtro ANTES (como admin). Anote. Depois da correção:
--      'all' e 'registered' sobem exatamente ativos_sem_telefone (C4) — os cadastros que
--      estavam ocultos; 'buyers' sobe só pelos sem telefone que têm compra; 'unregistered'
--      não muda; 'duplicates' pode subir se algum cadastro sem telefone tiver nome repetido
--      ou correspondência. Busca, ordenação e paginação não mudam de regra.
-- -------------------------------------------------------------------------------------
DO $c6$
declare v text := '';
        f text;
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'NÃO EXECUTADO — rode entre "begin transaction read only;" e "rollback;".';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_ADMIN>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  foreach f in array array['all', 'registered', 'buyers', 'unregistered', 'duplicates'] loop
    v := v || format(' %s=%s', f, public.list_customers(null, 'name_asc', f, 1, 0)->>'total');
  end loop;
  execute 'reset role';
  raise exception 'TOTAIS ANTES:%', v;
end;
$c6$;


-- =====================================================================================
-- RECONCILIAÇÃO REPOSITÓRIO x PRODUÇÃO (somente leitura)
-- As mudanças abaixo foram feitas pelo SQL Editor e NÃO estão em nenhuma migration local.
-- Para versioná-las sem inventar nada, rode e envie os resultados: com eles será montada
-- uma migration de baseline (mesmo padrão de 20260824110000_baseline_current_admin_rpcs.sql:
-- copia as definições vivas, sem mudar lógica).
-- =====================================================================================

-- R1 — Definições completas das RPCs administrativas criadas pelo SQL Editor
select pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner) as dono, p.proacl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('admin_update_customer', 'admin_archive_customer');

-- R2 — Colunas de customers (confirma phone_e164 nullable e qualquer outra mudança)
select column_name, data_type, is_nullable, column_default, is_generated, generation_expression
from information_schema.columns
where table_schema = 'public' and table_name = 'customers'
order by ordinal_position;

-- R3 — Constraints atuais das três tabelas do cadastro (CHECK de telefone, de ações da
--      auditoria etc.)
select conrelid::regclass as tabela, conname, contype, convalidated, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
order by 1, 2;

-- R4 — Índices atuais (ex.: se o índice único de identidade mudou para tratar telefone nulo)
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('customers', 'order_customer_links', 'customer_link_audit')
order by 1, 2;

-- R5 — Triggers atuais das tabelas do cadastro
select tgrelid::regclass as tabela, tgname, pg_get_triggerdef(oid) as definicao
from pg_trigger
where tgrelid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
  and not tgisinternal;

-- R6 — Todas as funções do cadastro com md5 do corpo (detecta outras edições feitas fora
--      das migrations; compare com os corpos do repositório)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as md5_corpo,
       md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) as md5_corpo_lf,  -- comparar com o repositório (LF)
       p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as dono
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname like '%customer%' or p.proname like 'normalize_customer_%')
order by 1, 2;

-- R7 — Migrations registradas no histórico do Supabase (as aplicadas pelo SQL Editor não
--      aparecem aqui). Se a tabela/coluna não existir neste projeto, ignore o erro.
select version, name from supabase_migrations.schema_migrations
where version >= '20261008000000' order by version;
