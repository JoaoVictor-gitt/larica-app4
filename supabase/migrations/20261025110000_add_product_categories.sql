-- =====================================================================================
-- Categorias personalizadas de produtos (Cafés, Sobremesas, Salgados...).
--
-- 1) Tabela nova public.product_categories (id, name, normalized_name GERADA e ÚNICA, display_order,
--    active, created_at, created_by). normalized_name usa a mesma regra já validada em
--    ingredients.normalized_name (20260818310000): trim + espaços repetidos viram 1 + minúsculas +
--    acentos comuns removidos por translate() (sem depender da extensão unaccent). Assim "Cafés",
--    " cafes ", "CAFÉS" são a MESMA categoria. Nome: 1 a 40 caracteres, sem espaços nas pontas,
--    sem espaços duplos, sem caracteres de controle.
-- 2) Leitura pública (anon + authenticated): o cardápio precisa dos nomes. RLS com uma única policy
--    de SELECT. NENHUM INSERT/UPDATE/DELETE direto para anon/authenticated (sem GRANT e sem policy).
-- 3) Criação: só pela função public.admin_create_product_category(p_name text) — SECURITY DEFINER,
--    search_path '', exige public.is_admin() (funcionário, mesmo com products.manage, NÃO cria),
--    normaliza o nome, recusa nomes das categorias padrão e duplicados. EXECUTE só authenticated.
-- 4) public.products ganha custom_category_id uuid NULL (FK -> product_categories, ON DELETE RESTRICT)
--    e o CHECK products_custom_category_somente_other: só produtos category='other' podem ter
--    categoria personalizada. products.category NÃO muda — create_customer_order (combos/sides),
--    custos e produção (skewers/sides) continuam idênticos. Nenhuma linha existente é alterada
--    (a coluna nasce NULL em todas).
-- 5) Privilégios da coluna nova = ESPELHO dos privilégios atuais de products.category, papel a papel
--    (anon, authenticated) e privilégio a privilégio (SELECT, INSERT, UPDATE). O esquema de grants de
--    products não está versionado no repositório: espelhar garante que o cardápio público, que lê
--    products com select('*'), continua funcionando (se anon lê category, lê a coluna nova), e que
--    quem já podia gravar a categoria do produto pode escolher uma categoria personalizada existente
--    — sem conceder nada a mais. RLS de products NÃO é tocada.
--
-- NÃO altera: products.category nem seus valores, RLS/policies de products, create_customer_order,
-- cancel_order, estoque, stock_movements, combos, custos, pedidos, impressão.
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). SQL Editor:
--   supabase/sql-editor/20261025110000_add_product_categories.sql
-- Testes: supabase/testes-manuais/20261025_product_categories_pre.sql (antes, só SELECT) e
--   supabase/testes-manuais/20261025_product_categories_pos_leitura.sql (depois, somente leitura).
-- Rollback (manual): supabase/rollback/20261025110000_product_categories_down.sql
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
  v_products regclass := to_regclass('public.products');
  v_tipo_category oid;
  v_tipo_texto text;
begin
  if v_products is null then
    raise exception 'Migration interrompida, nada foi alterado: public.products não existe';
  end if;

  if to_regclass('public.product_categories') is not null then
    v_falhas := v_falhas || ' [public.product_categories já existe]';
  end if;

  if exists (select 1 from pg_attribute
             where attrelid = v_products and attname = 'custom_category_id' and not attisdropped) then
    v_falhas := v_falhas || ' [products.custom_category_id já existe]';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ')
    into v_texto
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'admin_create_product_category';
  if v_texto is not null then
    v_falhas := v_falhas || format(' [já existe: %s]', v_texto);
  end if;

  -- products.category existe e aceita 'other' (texto, ou enum que contenha 'other')
  select a.atttypid into v_tipo_category
  from pg_attribute a
  where a.attrelid = v_products and a.attname = 'category' and not a.attisdropped;
  if v_tipo_category is null then
    v_falhas := v_falhas || ' [products.category não existe]';
  else
    v_tipo_texto := format_type(v_tipo_category, null);
    if exists (select 1 from pg_type t where t.oid = v_tipo_category and t.typtype = 'e') then
      if not exists (select 1 from pg_enum e where e.enumtypid = v_tipo_category and e.enumlabel = 'other') then
        v_falhas := v_falhas || format(' [enum %s não tem o valor other]', v_tipo_texto);
      end if;
    elsif v_tipo_texto not in ('text', 'character varying') then
      v_falhas := v_falhas || format(' [products.category tem tipo inesperado: %s]', v_tipo_texto);
    end if;
  end if;

  select string_agg(x.papel, ', ')
    into v_texto
  from unnest(array['anon', 'authenticated', 'service_role']) as x(papel)
  where not exists (select 1 from pg_roles r where r.rolname = x.papel);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_texto);
  end if;

  if to_regprocedure('public.is_admin()') is null then
    v_falhas := v_falhas || ' [public.is_admin() não existe]';
  elsif not has_function_privilege(current_user, 'public.is_admin()', 'EXECUTE') then
    v_falhas := v_falhas || format(' [o papel %s não executa is_admin()]', current_user);
  end if;

  if to_regprocedure('gen_random_uuid()') is null then
    v_falhas := v_falhas || ' [gen_random_uuid() indisponível]';
  end if;

  if v_falhas <> '' then
    raise exception 'Migration interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Tabela de categorias + leitura pública
-- =====================================================================================

CREATE TABLE public.product_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (
    translate(
      lower(
        trim(
          regexp_replace(name, '[[:space:]]+', ' ', 'g')
        )
      ),
      'áàãâäéèêëíìîïóòõôöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'
    )
  ) STORED,
  display_order   integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid DEFAULT auth.uid(),
  CONSTRAINT product_categories_name_valido CHECK (
    char_length(name) BETWEEN 1 AND 40
    AND name = btrim(name)
    AND name !~ '[[:space:]]{2}'
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT product_categories_display_order_nao_negativo CHECK (display_order >= 0),
  CONSTRAINT product_categories_normalized_name_unico UNIQUE (normalized_name)
);

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view product categories" ON public.product_categories
  FOR SELECT TO anon, authenticated
  USING (true);

-- O Supabase dá ALL a anon/authenticated em tabela nova do schema public por padrão — zera e
-- concede só leitura (mesmo cuidado de combo_option_extras, 20261004100000).
REVOKE ALL PRIVILEGES ON TABLE public.product_categories FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.product_categories FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.product_categories FROM authenticated;
GRANT SELECT ON TABLE public.product_categories TO anon, authenticated;
GRANT ALL ON TABLE public.product_categories TO service_role;


-- =====================================================================================
-- 2) products.custom_category_id
-- =====================================================================================

ALTER TABLE public.products
  ADD COLUMN custom_category_id uuid REFERENCES public.product_categories (id) ON DELETE RESTRICT;

ALTER TABLE public.products
  ADD CONSTRAINT products_custom_category_somente_other
  CHECK (custom_category_id IS NULL OR category = 'other');

CREATE INDEX idx_products_custom_category_id ON public.products (custom_category_id);

-- Espelho dos privilégios de products.category (efetivos, com herança) na coluna nova. Quem tem o
-- privilégio no nível da tabela já o herda na coluna nova; o GRANT por coluna só é emitido quando
-- ainda faltar.
DO $espelho$
declare
  v_papel text;
  v_priv text;
begin
  foreach v_papel in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_papel, 'public.products', 'category', v_priv)
         and not has_column_privilege(v_papel, 'public.products', 'custom_category_id', v_priv) then
        execute format('GRANT %s (custom_category_id) ON public.products TO %I', v_priv, v_papel);
      end if;
    end loop;
  end loop;
end;
$espelho$;


-- =====================================================================================
-- 3) Função de criação (única forma de criar categoria)
-- =====================================================================================

CREATE FUNCTION public.admin_create_product_category(p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_nome text;
  v_normalizado text;
  v_id uuid;
  v_existente text;
begin
  if not public.is_admin() then
    raise exception 'Somente administradores podem criar categorias.';
  end if;

  v_nome := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');

  if v_nome = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  if char_length(v_nome) > 40 then
    raise exception 'O nome da categoria pode ter no máximo 40 caracteres.';
  end if;
  if v_nome ~ '[[:cntrl:]]' then
    raise exception 'O nome da categoria contém caracteres inválidos.';
  end if;

  -- Mesma expressão da coluna gerada (v_nome já está sem espaços nas pontas e sem espaços duplos).
  v_normalizado := translate(lower(v_nome), 'áàãâäéèêëíìîïóòõôöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn');

  -- Nomes das categorias padrão (pt e rótulos em inglês do cardápio) ficam reservados.
  if v_normalizado = any (array['combos', 'combo', 'espetinhos', 'espetinho', 'espetos', 'espeto',
                                'acompanhamentos', 'acompanhamento', 'bebidas', 'bebida', 'outro',
                                'outros', 'skewers', 'sides', 'drinks', 'other', 'others']) then
    raise exception 'Esse nome já é uma categoria padrão.';
  end if;

  insert into public.product_categories (name)
  values (v_nome)
  on conflict (normalized_name) do nothing
  returning id into v_id;

  if v_id is null then
    select name into v_existente from public.product_categories where normalized_name = v_normalizado;
    raise exception 'Já existe a categoria "%".', coalesce(v_existente, v_nome);
  end if;

  return jsonb_build_object('id', v_id, 'name', v_nome);
end;
$function$;

REVOKE ALL ON FUNCTION public.admin_create_product_category(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_product_category(text) TO authenticated;


-- =====================================================================================
-- 4) Verificação final
-- =====================================================================================

DO $verificacao$
declare
  v_falhas text := '';
  v_cat regclass := to_regclass('public.product_categories');
  v_authenticated oid := (select oid from pg_roles where rolname = 'authenticated');
  v_papel text;
  v_priv text;
  r record;
begin
  if v_cat is null then
    raise exception 'Migration desfeita (verificação final): product_categories não foi criada';
  end if;

  -- RLS e policies
  if not (select relrowsecurity from pg_class where oid = v_cat) then
    v_falhas := v_falhas || ' [RLS desligada em product_categories]';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'product_categories') <> 1
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'product_categories'
                    and cmd = 'SELECT') then
    v_falhas := v_falhas || ' [policies de product_categories diferentes do previsto]';
  end if;

  -- Privilégios na tabela de categorias: só leitura para anon/authenticated
  foreach v_papel in array array['anon', 'authenticated'] loop
    if not has_table_privilege(v_papel, v_cat, 'SELECT') then
      v_falhas := v_falhas || format(' [%s não lê product_categories]', v_papel);
    end if;
    if has_table_privilege(v_papel, v_cat, 'INSERT') or has_table_privilege(v_papel, v_cat, 'UPDATE')
       or has_table_privilege(v_papel, v_cat, 'DELETE') or has_table_privilege(v_papel, v_cat, 'TRUNCATE') then
      v_falhas := v_falhas || format(' [%s escreve em product_categories]', v_papel);
    end if;
  end loop;

  -- Coluna nova com exatamente os mesmos privilégios efetivos de products.category
  foreach v_papel in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE'] loop
      if has_column_privilege(v_papel, 'public.products', 'category', v_priv)
         is distinct from has_column_privilege(v_papel, 'public.products', 'custom_category_id', v_priv) then
        v_falhas := v_falhas || format(' [%s %s em custom_category_id difere de category]', v_papel, v_priv);
      end if;
    end loop;
  end loop;

  -- Nenhum produto existente foi tocado
  if exists (select 1 from public.products where custom_category_id is not null) then
    v_falhas := v_falhas || ' [há produtos com custom_category_id preenchido]';
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.products'::regclass and conname = 'products_custom_category_somente_other') then
    v_falhas := v_falhas || ' [CHECK products_custom_category_somente_other ausente]';
  end if;

  -- Função
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner
    into r
  from pg_proc p
  where p.oid = to_regprocedure('public.admin_create_product_category(text)');

  if r.oid is null then
    raise exception 'Migration desfeita (verificação final): função não foi criada';
  end if;
  if not r.prosecdef then
    v_falhas := v_falhas || ' [função não é SECURITY DEFINER]';
  end if;
  if r.provolatile::text <> 'v' then
    v_falhas := v_falhas || format(' [volatilidade %s]', r.provolatile::text);
  end if;
  if r.proconfig is distinct from array['search_path=""'] then
    v_falhas := v_falhas || format(' [search_path %s]', r.proconfig);
  end if;
  if r.proacl is null then
    v_falhas := v_falhas || ' [ACL padrão (PUBLIC executa)]';
  elsif exists (select 1 from aclexplode(r.proacl) x
                where x.privilege_type = 'EXECUTE' and x.grantee <> r.proowner
                  and x.grantee is distinct from v_authenticated) then
    v_falhas := v_falhas || ' [EXECUTE concedido a papel não previsto]';
  end if;
  if has_function_privilege('anon', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [executável por anon]';
  end if;
  if has_function_privilege('service_role', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [executável por service_role]';
  end if;
  if not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [sem EXECUTE para authenticated]';
  end if;

  -- O bloqueio de não-admin é comprovado por comportamento DEPOIS da instalação, em
  -- supabase/testes-manuais/20261025_product_categories_pos_leitura.sql (POS-4).

  if v_falhas <> '' then
    raise exception 'Migration desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
