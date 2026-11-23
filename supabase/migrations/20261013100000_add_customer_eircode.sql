-- =====================================================================================
-- Cadastro de clientes — M1: Eircode opcional no cadastro (customers.eircode)
--
-- O que faz:
--   1) public.normalize_customer_eircode(text): função pura (IMMUTABLE, sem acesso a
--      tabelas). Maiúsculas, remove espaços; com exatamente 7 caracteres A-Z/0-9 devolve
--      'XXX XXXX', senão NULL. É a MESMA regra do front (validarFormatoEircode /
--      formatarEircode em js/utils.js): só formato, sem validar routing key.
--   2) customers.eircode text NULL + CHECK customers_eircode_check (NULL ou 'XXX XXXX').
--
-- O que NÃO faz: não toca em orders (orders.eircode continua sendo o endereço de entrega
-- de cada pedido), em order_customer_links, na auditoria, em RLS/privilégios das tabelas
-- nem em nenhuma RPC existente (admin_update_customer, admin_archive_customer,
-- create_customer_order, set_whatsapp_customer_name e as do cadastro seguem intactas).
-- A coluna nova nasce sem privilégio para anon/authenticated (grants de coluna não
-- existem; a tabela continua sem grants e com RLS ativa, sem policies).
--
-- Locks: ADD COLUMN nullable sem DEFAULT é só catálogo (não reescreve a tabela); o CHECK
-- valida as linhas atuais (66 cadastros, todas com eircode NULL) — milissegundos. Pega
-- ACCESS EXCLUSIVE só em public.customers até o COMMIT: leituras do cadastro (página
-- Clientes, sincronização) esperam esses milissegundos. Pedidos não são afetados: criar,
-- alterar status, pagar, imprimir e excluir pedidos não leem customers (o trigger de
-- exclusão usa order_customer_links e a auditoria). lock_timeout limita só a ESPERA pelo
-- lock (se alguém estiver lendo customers numa transação longa, aborta em 3s sem alterar
-- nada); não limita quanto tempo o lock fica retido — por isso nada demorado vem depois
-- do ALTER.
--
-- Guardas (seção 0) — se qualquer uma falhar, aborta sem alterar nada:
--   (a) nenhum objeto com os nomes novos (coluna, constraint, função);
--   (b) customers existe, com RLS ativa, e o papel que aplica tem os privilégios do dono
--       (dono ou membro COM herança — pg_has_role USAGE; MEMBER sem herança não basta
--       para ALTER TABLE);
--   (c) nenhuma função de public insere em customers SEM lista de colunas (INSERT ...
--       VALUES/SELECT posicional quebraria ou deslocaria valores com uma coluna a mais).
--       Verificação textual indicativa sobre todos os corpos — complementa a revisão das
--       definições de produção (B13), não a substitui;
--   (d) os papéis anon, authenticated e service_role existem (a verificação final usa
--       has_*_privilege com esses nomes, que daria erro se algum não existisse).
-- Verificação final (seção 3): coluna, constraint validada, RLS, ausência de privilégio
-- de anon/authenticated na coluna e permissões da função (ACL só com o dono; PUBLIC, anon,
-- authenticated e service_role sem EXECUTE efetivo); se algo divergir, aborta (tudo é
-- desfeito).
--
-- Transação: SEM BEGIN/COMMIT (a CLI do Supabase já executa cada migration numa
-- transação). Para o SQL Editor use a cópia com BEGIN/COMMIT:
--   supabase/sql-editor/20261013100000_add_customer_eircode.sql
-- SET LOCAL vale só dentro da transação (sem RESET). Nunca execute comando a comando.
-- Pré-checagem: supabase/testes-manuais/20261013_manual_customer_pre.sql (M1-*)
-- Rollback (manual, não destrutivo por padrão): supabase/rollback/20261013100000_manual_customer_down.sql
-- Arquivo sem nenhuma barra invertida.
-- =====================================================================================

SET LOCAL lock_timeout = '3s';


-- =====================================================================================
-- 0) Guardas
-- =====================================================================================

DO $guard$
declare
  v_falhas text := '';
  v_conflitos text;
  v_tabela oid := to_regclass('public.customers');
  v_posicionais text;
begin
  if v_tabela is null then
    raise exception 'M1 interrompida: public.customers não existe. Nada foi alterado.';
  end if;

  -- (a) nomes livres
  select string_agg(obj, ', ')
    into v_conflitos
  from (
    select 'coluna customers.eircode' as obj
    from pg_attribute
    where attrelid = v_tabela and attname = 'eircode' and attnum > 0 and not attisdropped
    union all
    select format('constraint %s em %s', conname, conrelid::regclass::text)
    from pg_constraint
    where conname = 'customers_eircode_check'
    union all
    select format('função %s', p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'normalize_customer_eircode'
  ) s;
  if v_conflitos is not null then
    v_falhas := v_falhas || format(' [já existe: %s]', v_conflitos);
  end if;

  -- (b) RLS ativa e papel com direito de ALTER TABLE (privilégios do dono = USAGE)
  if not (select relrowsecurity from pg_class where oid = v_tabela) then
    v_falhas := v_falhas || ' [RLS de public.customers não está ativa — estado inesperado]';
  end if;
  if not pg_has_role(current_user, (select relowner from pg_class where oid = v_tabela), 'USAGE') then
    v_falhas := v_falhas || format(' [o papel %s não tem os privilégios do dono de public.customers (dono: %s)]',
                                   current_user, pg_get_userbyid((select relowner from pg_class where oid = v_tabela)));
  end if;

  -- (d) papéis usados na verificação final
  select string_agg(x.papel, ', ')
    into v_conflitos
  from unnest(array['anon', 'authenticated', 'service_role']) as x(papel)
  where not exists (select 1 from pg_roles r where r.rolname = x.papel);
  if v_conflitos is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_conflitos);
  end if;

  -- (c) INSERT posicional em customers em qualquer função de public (corpo normalizado)
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_posicionais
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind in ('f', 'p')
    and lower(p.prosrc) ~ 'insert[[:space:]]+into[[:space:]]+(public[.])?customers[[:space:]]+(values|select|[(][[:space:]]*select)';
  if v_posicionais is not null then
    v_falhas := v_falhas || format(' [INSERT sem lista de colunas em customers: %s]', v_posicionais);
  end if;

  if v_falhas <> '' then
    raise exception 'M1 interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Normalização do Eircode (pura; uso interno das RPCs SECURITY DEFINER)
-- =====================================================================================
-- 'd03fx92' / 'D03 FX92' / ' d03  fx92 ' -> 'D03 FX92'. Qualquer outra coisa -> NULL
-- (as RPCs distinguem "vazio" de "inválido" antes de chamar).

CREATE FUNCTION public.normalize_customer_eircode(p_eircode text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select case
    when e ~ '^[A-Z0-9]{7}$' then substr(e, 1, 3) || ' ' || substr(e, 4, 4)
    else null
  end
  from (select upper(regexp_replace(coalesce(p_eircode, ''), '[[:space:]]+', '', 'g')) as e) x;
$function$;

-- Sem acesso direto pela API: só as RPCs (dono) usam. Revoga também o padrão do Supabase.
REVOKE ALL ON FUNCTION public.normalize_customer_eircode(text) FROM PUBLIC, anon, authenticated, service_role;


-- =====================================================================================
-- 2) Coluna (nullable, sem DEFAULT) + CHECK do formato canônico
-- =====================================================================================

ALTER TABLE public.customers
  ADD COLUMN eircode text NULL,
  ADD CONSTRAINT customers_eircode_check CHECK (eircode IS NULL OR eircode ~ '^[A-Z0-9]{3} [A-Z0-9]{4}$');


-- =====================================================================================
-- 3) Verificação final (aborta e desfaz tudo se algo divergir)
-- =====================================================================================

DO $verificacao$
declare
  v_falhas text := '';
  v_tabela oid := 'public.customers'::regclass;
  v_funcao oid := to_regprocedure('public.normalize_customer_eircode(text)');
  r record;
begin
  select a.attnotnull, format_type(a.atttypid, a.atttypmod) as tipo,
         exists (select 1 from pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum) as tem_default
    into r
  from pg_attribute a
  where a.attrelid = v_tabela and a.attname = 'eircode' and not a.attisdropped;
  if not found or r.tipo <> 'text' or r.attnotnull or r.tem_default then
    v_falhas := v_falhas || ' [coluna eircode não ficou text NULL sem DEFAULT]';
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = v_tabela and conname = 'customers_eircode_check'
                   and contype = 'c' and convalidated) then
    v_falhas := v_falhas || ' [customers_eircode_check ausente ou não validada]';
  end if;

  if not (select relrowsecurity from pg_class where oid = v_tabela) then
    v_falhas := v_falhas || ' [RLS de customers desativada]';
  end if;

  if has_column_privilege('anon', v_tabela, 'eircode', 'SELECT')
     or has_column_privilege('anon', v_tabela, 'eircode', 'UPDATE')
     or has_column_privilege('authenticated', v_tabela, 'eircode', 'SELECT')
     or has_column_privilege('authenticated', v_tabela, 'eircode', 'UPDATE') then
    v_falhas := v_falhas || ' [anon/authenticated com privilégio na coluna eircode]';
  end if;

  if v_funcao is null then
    v_falhas := v_falhas || ' [normalize_customer_eircode não foi criada]';
  else
    -- ACL nula = padrão (PUBLIC executa). Na ACL, só o dono pode ter EXECUTE (grantee 0 =
    -- PUBLIC). Depois, privilégio EFETIVO (inclui herança) dos três papéis da API.
    if (select proacl from pg_proc where oid = v_funcao) is null
       or exists (select 1 from pg_proc p cross join lateral aclexplode(p.proacl) x
                  where p.oid = v_funcao and x.privilege_type = 'EXECUTE' and x.grantee <> p.proowner)
       or has_function_privilege('anon', v_funcao, 'EXECUTE')
       or has_function_privilege('authenticated', v_funcao, 'EXECUTE')
       or has_function_privilege('service_role', v_funcao, 'EXECUTE') then
      v_falhas := v_falhas || ' [normalize_customer_eircode executável por outro papel além do dono (PUBLIC/anon/authenticated/service_role)]';
    end if;
    if public.normalize_customer_eircode(' d03  fx92 ') is distinct from 'D03 FX92'
       or public.normalize_customer_eircode('D03FX9') is not null
       or public.normalize_customer_eircode('D03-FX92') is not null
       or public.normalize_customer_eircode(null) is not null then
      v_falhas := v_falhas || ' [normalize_customer_eircode com resultado inesperado]';
    end if;
  end if;

  if v_falhas <> '' then
    raise exception 'M1 desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
