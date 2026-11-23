-- =====================================================================================
-- Segunda via para o cliente — configuração persistente business_settings.customer_copy_enabled.
--
-- Fatos confirmados em produção pelo PRE (C01–C12): authenticated tem INSERT e UPDATE no NÍVEL DA
-- TABELA business_settings, com RLS de escrita por is_staff(); has_permission(text) vivo tem md5
-- ca9c418e63c13180d1aee51abbff582a (= baseline); existe o trigger trg_business_settings_set_updated_metadata;
-- funções novas criadas por postgres recebem EXECUTE padrão para anon/authenticated/service_role.
-- Como um GRANT por coluna não anula o GRANT da tabela, a coluna nova herdaria escrita direta por
-- qualquer funcionário. Esta migration NÃO mexe nesses grants/RLS/policies: a coluna é protegida
-- por TRIGGER.
--
-- 1) Coluna nova customer_copy_enabled boolean NOT NULL DEFAULT false (aditiva; a linha existente
--    fica false). GRANT SELECT na coluna a authenticated (leitura pelo /pedidos e Configurações).
-- 2) Única forma de ALTERAR: public.admin_set_customer_copy_enabled(p_enabled boolean) — SECURITY
--    DEFINER, search_path '', exige public.has_permission('settings.manage') na 1ª instrução.
--    EXECUTE só para authenticated (REVOKE de PUBLIC, anon e service_role, que vêm dos privilégios
--    padrão vistos no C12).
-- 3) Proteção da coluna contra ESCRITA DIRETA pela API — para qualquer usuário, admin incluído:
--    função de trigger public.business_settings_protect_customer_copy() (SECURITY INVOKER — de
--    propósito: current_user é o papel de quem executou o comando) + 2 triggers:
--      * BEFORE UPDATE OF customer_copy_enabled: dispara sempre que a coluna é citada no SET, mesmo
--        com o mesmo valor (inclusive "false" explícito e upsert ON CONFLICT DO UPDATE). Se
--        current_user for anon/authenticated (PostgREST), recusa. Os salvamentos atuais das
--        Configurações não citam a coluna -> o trigger nem dispara para eles.
--      * BEFORE INSERT: se current_user for anon/authenticated e o valor não for o padrão false,
--        recusa (impede recriar a linha já ligada).
--    Dentro da RPC (SECURITY DEFINER) current_user é o dono da função -> permitido; a RPC já exigiu
--    settings.manage. SQL Editor (postgres) e service_role (chave de servidor) são acessos
--    confiáveis e não passam pela checagem. auth.uid()/session_user não servem para distinguir RPC de
--    escrita direta (são iguais nos dois casos); current_user serve.
--    EXECUTE da função de trigger revogado de todos (o disparo do trigger não exige EXECUTE).
--
-- MANUTENÇÃO — dependência dos triggers (ler antes de alterar business_settings no futuro):
--    O trigger BEFORE UPDATE OF customer_copy_enabled só enxerga a coluna quando ela é CITADA no
--    comando (SET); ele NÃO detecta mudança feita indiretamente por outro trigger que altere NEW. O
--    mesmo vale para o trigger BEFORE INSERT diante de um trigger posterior que altere o valor.
--    Por isso: nenhum trigger (novo ou alterado) em business_settings pode modificar
--    customer_copy_enabled, e nenhuma função SECURITY DEFINER nova pode gravar essa coluna — exceto
--    public.admin_set_customer_copy_enabled. Na data desta migration o único outro trigger é
--    trg_business_settings_set_updated_metadata (set_updated_metadata(), SECURITY INVOKER, md5
--    785317d052154950ac9c788f4e9f243e), que só grava updated_at e updated_by (PRE C15), e nenhuma
--    função SECURITY DEFINER viva grava em business_settings (PRE C13).
--
-- NÃO altera: grants, RLS e policies existentes de business_settings, demais colunas,
-- trg_business_settings_set_updated_metadata, claim/resolve/register_order_print,
-- create_customer_order, orders, estoque.
--
-- Guardas: tabela, linha id=1, papéis e has_permission(text) com o md5 confirmado; coluna, funções e
-- triggers novos ainda não existem; anon sem escrita na tabela.
-- Verificação final: coluna, privilégios de leitura, triggers (tipo/coluna/função/habilitado),
-- função de trigger (INVOKER, search_path, md5, ACL) e RPC (DEFINER, search_path, md5, ACL).
-- Qualquer divergência desfaz tudo.
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). SQL Editor:
--   supabase/sql-editor/20261025100000_add_customer_copy_setting.sql
-- Testes: supabase/testes-manuais/20261025_customer_copy_pre.sql (antes, só SELECT) e
--   supabase/testes-manuais/20261025_customer_copy_pos_leitura.sql (depois, só SELECT).
-- Rollback (manual): supabase/rollback/20261025100000_customer_copy_down.sql
-- Arquivo sem nenhuma barra invertida.
-- =====================================================================================

SET LOCAL lock_timeout = '5s';


-- =====================================================================================
-- 0) Guardas
-- =====================================================================================

DO $guard$
declare
  v_falhas text := '';
  v_texto text;
  v_tabela regclass := to_regclass('public.business_settings');
  v_has_permission oid := to_regprocedure('public.has_permission(text)');
begin
  if v_tabela is null then
    raise exception 'Migration interrompida, nada foi alterado: public.business_settings não existe';
  end if;

  if exists (select 1 from pg_attribute
             where attrelid = v_tabela and attname = 'customer_copy_enabled' and not attisdropped) then
    v_falhas := v_falhas || ' [coluna customer_copy_enabled já existe]';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ')
    into v_texto
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('admin_set_customer_copy_enabled', 'business_settings_protect_customer_copy');
  if v_texto is not null then
    v_falhas := v_falhas || format(' [já existe: %s]', v_texto);
  end if;

  select string_agg(t.tgname, ', ')
    into v_texto
  from pg_trigger t
  where t.tgrelid = v_tabela
    and t.tgname in ('business_settings_protect_customer_copy_update', 'business_settings_protect_customer_copy_insert');
  if v_texto is not null then
    v_falhas := v_falhas || format(' [trigger já existe: %s]', v_texto);
  end if;

  if not exists (select 1 from public.business_settings where id = 1) then
    v_falhas := v_falhas || ' [linha id=1 de business_settings não existe]';
  end if;

  select string_agg(x.papel, ', ')
    into v_texto
  from unnest(array['anon', 'authenticated', 'service_role']) as x(papel)
  where not exists (select 1 from pg_roles r where r.rolname = x.papel);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_texto);
  end if;

  -- has_permission: a RPC depende dela; md5 confirmado no C05 (= baseline 20260824110000).
  if v_has_permission is null then
    v_falhas := v_falhas || ' [public.has_permission(text) não existe]';
  elsif (select md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) from pg_proc p where p.oid = v_has_permission)
        <> 'ca9c418e63c13180d1aee51abbff582a' then
    v_falhas := v_falhas || ' [has_permission(text) difere da versão confirmada no PRE]';
  elsif not has_function_privilege(current_user, v_has_permission, 'EXECUTE') then
    v_falhas := v_falhas || format(' [o papel %s não executa has_permission(text)]', current_user);
  end if;

  -- anon nunca escreve em business_settings (C04). Se escrevesse, a revisão teria de ser outra.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_table_privilege('anon', v_tabela, 'UPDATE') or has_table_privilege('anon', v_tabela, 'INSERT')) then
    v_falhas := v_falhas || ' [anon tem UPDATE/INSERT na tabela inteira]';
  end if;

  if v_falhas <> '' then
    raise exception 'Migration interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Coluna + leitura por staff
-- =====================================================================================

ALTER TABLE public.business_settings
  ADD COLUMN customer_copy_enabled boolean NOT NULL DEFAULT false;

GRANT SELECT (customer_copy_enabled) ON public.business_settings TO authenticated;


-- =====================================================================================
-- 2) Proteção da coluna contra escrita direta (trigger)
-- =====================================================================================

CREATE FUNCTION public.business_settings_protect_customer_copy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
begin
  -- Escrita DIRETA pela API: o PostgREST executa o comando com current_user = anon/authenticated.
  -- Recusada para qualquer usuário (admin incluído). A alteração intencional é só pela RPC
  -- public.admin_set_customer_copy_enabled, que é SECURITY DEFINER (dentro dela current_user é o
  -- dono da função) e exige settings.manage antes de gravar.
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'UPDATE' then
      -- Só chega aqui quando a coluna foi citada no SET (trigger BEFORE UPDATE OF), com qualquer valor.
      raise exception 'A segunda via do cliente só pode ser alterada em Configurações.'
        using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and new.customer_copy_enabled is distinct from false then
      raise exception 'A segunda via do cliente só pode ser alterada em Configurações.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

-- O disparo de um trigger não exige EXECUTE na função; ninguém além do dono precisa dele.
REVOKE ALL ON FUNCTION public.business_settings_protect_customer_copy() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER business_settings_protect_customer_copy_update
  BEFORE UPDATE OF customer_copy_enabled ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.business_settings_protect_customer_copy();

CREATE TRIGGER business_settings_protect_customer_copy_insert
  BEFORE INSERT ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.business_settings_protect_customer_copy();


-- =====================================================================================
-- 3) Função de gravação (única forma de alterar a configuração)
-- =====================================================================================

CREATE FUNCTION public.admin_set_customer_copy_enabled(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_valor boolean;
begin
  if not public.has_permission('settings.manage') then
    raise exception 'Usuário sem permissão para alterar esta configuração.';
  end if;

  if p_enabled is null then
    raise exception 'Valor inválido para a segunda via do cliente.';
  end if;

  update public.business_settings
     set customer_copy_enabled = p_enabled
   where id = 1
  returning customer_copy_enabled into v_valor;

  if not found then
    raise exception 'Configurações do estabelecimento não encontradas.';
  end if;

  return v_valor;
end;
$function$;

-- Remove o EXECUTE que os privilégios padrão (C12) concedem a anon e service_role, e o de PUBLIC.
REVOKE ALL ON FUNCTION public.admin_set_customer_copy_enabled(boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_customer_copy_enabled(boolean) TO authenticated;


-- =====================================================================================
-- 4) Verificação final
-- =====================================================================================

DO $verificacao$
declare
  v_falhas text := '';
  v_tabela regclass := to_regclass('public.business_settings');
  v_authenticated oid := (select oid from pg_roles where rolname = 'authenticated');
  v_attnum smallint;
  v_gatilho oid := to_regprocedure('public.business_settings_protect_customer_copy()');
  c record;
  r record;
  t record;
begin
  -- Coluna
  select a.attnum, a.atttypid::regtype::text as tipo, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as padrao
    into c
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = v_tabela and a.attname = 'customer_copy_enabled' and not a.attisdropped;

  if c.tipo is null then
    raise exception 'Migration desfeita (verificação final): coluna não foi criada';
  end if;
  v_attnum := c.attnum;
  if c.tipo <> 'boolean' then
    v_falhas := v_falhas || format(' [tipo %s]', c.tipo);
  end if;
  if not c.attnotnull then
    v_falhas := v_falhas || ' [coluna aceita NULL]';
  end if;
  if c.padrao is distinct from 'false' then
    v_falhas := v_falhas || format(' [default %s]', c.padrao);
  end if;
  if exists (select 1 from public.business_settings where customer_copy_enabled is distinct from false) then
    v_falhas := v_falhas || ' [linha existente não ficou desligada]';
  end if;

  -- Leitura: authenticated lê; anon não acessa. (UPDATE/INSERT de authenticated vêm herdados do
  -- nível da tabela — confirmado no PRE — e a coluna é protegida pelos triggers abaixo.)
  if not has_column_privilege('authenticated', v_tabela, 'customer_copy_enabled', 'SELECT') then
    v_falhas := v_falhas || ' [authenticated não lê a coluna]';
  end if;
  if has_column_privilege('anon', v_tabela, 'customer_copy_enabled', 'SELECT')
     or has_column_privilege('anon', v_tabela, 'customer_copy_enabled', 'UPDATE')
     or has_column_privilege('anon', v_tabela, 'customer_copy_enabled', 'INSERT') then
    v_falhas := v_falhas || ' [anon acessa a coluna]';
  end if;

  -- Função de trigger
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner, p.prorettype::regtype::text as retorno,
         md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) as md5_lf
    into r
  from pg_proc p where p.oid = v_gatilho;

  if r.oid is null then
    raise exception 'Migration desfeita (verificação final): função de trigger não foi criada';
  end if;
  if r.prosecdef then
    v_falhas := v_falhas || ' [função de trigger não pode ser SECURITY DEFINER]';
  end if;
  if r.retorno <> 'trigger' then
    v_falhas := v_falhas || format(' [função de trigger retorna %s]', r.retorno);
  end if;
  if r.proconfig is distinct from array['search_path=""'] then
    v_falhas := v_falhas || format(' [search_path da função de trigger %s]', r.proconfig);
  end if;
  if r.md5_lf <> '21570cb54ae4b34456836a4048def58e' then
    v_falhas := v_falhas || format(' [corpo da função de trigger inesperado: %s]', r.md5_lf);
  end if;
  if r.proacl is null
     or exists (select 1 from aclexplode(r.proacl) x where x.privilege_type = 'EXECUTE' and x.grantee <> r.proowner) then
    v_falhas := v_falhas || ' [EXECUTE da função de trigger concedido a alguém além do dono]';
  end if;
  if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE')
     or has_function_privilege('service_role', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [função de trigger executável por anon/authenticated/service_role]';
  end if;

  -- Triggers: BEFORE + FOR EACH ROW; UPDATE só da coluna customer_copy_enabled; INSERT; habilitados;
  -- apontando para a função de trigger. (tgtype: 1 = ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE)
  select tg.tgtype, tg.tgenabled, tg.tgfoid, tg.tgattr::text as colunas into t
  from pg_trigger tg where tg.tgrelid = v_tabela and tg.tgname = 'business_settings_protect_customer_copy_update';
  if t.tgfoid is null then
    v_falhas := v_falhas || ' [trigger de UPDATE ausente]';
  elsif t.tgfoid <> v_gatilho or (t.tgtype & 1) <> 1 or (t.tgtype & 2) <> 2 or (t.tgtype & 16) <> 16
        or (t.tgtype & 4) <> 0 or t.colunas <> v_attnum::text or t.tgenabled <> 'O' then
    v_falhas := v_falhas || format(' [trigger de UPDATE diferente do previsto: tipo %s colunas %s habilitado %s]',
                                   t.tgtype, t.colunas, t.tgenabled);
  end if;

  t := null;
  select tg.tgtype, tg.tgenabled, tg.tgfoid, tg.tgattr::text as colunas into t
  from pg_trigger tg where tg.tgrelid = v_tabela and tg.tgname = 'business_settings_protect_customer_copy_insert';
  if t.tgfoid is null then
    v_falhas := v_falhas || ' [trigger de INSERT ausente]';
  elsif t.tgfoid <> v_gatilho or (t.tgtype & 1) <> 1 or (t.tgtype & 2) <> 2 or (t.tgtype & 4) <> 4
        or (t.tgtype & 16) <> 0 or t.colunas <> '' or t.tgenabled <> 'O' then
    v_falhas := v_falhas || format(' [trigger de INSERT diferente do previsto: tipo %s colunas %s habilitado %s]',
                                   t.tgtype, t.colunas, t.tgenabled);
  end if;

  -- RPC
  r := null;
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner,
         md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) as md5_lf
    into r
  from pg_proc p
  where p.oid = to_regprocedure('public.admin_set_customer_copy_enabled(boolean)');

  if r.oid is null then
    raise exception 'Migration desfeita (verificação final): função admin_set_customer_copy_enabled não foi criada';
  end if;
  if not r.prosecdef then
    v_falhas := v_falhas || ' [RPC não é SECURITY DEFINER]';
  end if;
  if r.provolatile::text <> 'v' then
    v_falhas := v_falhas || format(' [volatilidade da RPC %s]', r.provolatile::text);
  end if;
  if r.proconfig is distinct from array['search_path=""'] then
    v_falhas := v_falhas || format(' [search_path da RPC %s]', r.proconfig);
  end if;
  if r.md5_lf <> '334a686b6943877f50d7b3198a792ef2' then
    v_falhas := v_falhas || format(' [corpo da RPC inesperado: %s]', r.md5_lf);
  end if;
  if r.proacl is null then
    v_falhas := v_falhas || ' [ACL padrão na RPC (PUBLIC executa)]';
  elsif exists (select 1 from aclexplode(r.proacl) x
                where x.privilege_type = 'EXECUTE' and x.grantee <> r.proowner
                  and x.grantee is distinct from v_authenticated) then
    v_falhas := v_falhas || ' [EXECUTE da RPC concedido a papel não previsto]';
  end if;
  if has_function_privilege('anon', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [RPC executável por anon]';
  end if;
  if has_function_privilege('service_role', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [RPC executável por service_role]';
  end if;
  if not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [RPC sem EXECUTE para authenticated]';
  end if;

  if v_falhas <> '' then
    raise exception 'Migration desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
