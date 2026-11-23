-- =====================================================================================
-- Canal de venda dos pedidos — orders.sales_channel ('larica' | 'deliveroo' | 'just_eat').
--
-- FASE A (só identificação): coluna nova, aditiva, independente de payment_method.
--   ALTER TABLE ... ADD COLUMN sales_channel text NOT NULL DEFAULT 'larica' + CHECK dos 3 valores.
--   Todo pedido existente passa a valer 'larica' (default constante: sem reescrever a tabela).
--   create_customer_order (checkout público e WhatsApp) não conhece a coluna -> todo pedido novo
--   continua 'larica'; o checkout não tem como escolher canal (a RPC ignora chaves desconhecidas).
--   A criação de pedidos Deliveroo/Just Eat (RPC administrativa) é a FASE B, em migration própria,
--   depois das decisões pendentes — NADA aqui grava canal diferente de 'larica'.
--
-- Leitura: SELECT na coluna nova = ESPELHO do SELECT atual de orders.status, papel a papel (anon,
-- authenticated). O esquema de grants de orders não está versionado no repositório; o painel lê
-- orders com select('*'), então a coluna precisa ser legível por quem já lê os pedidos — sem
-- conceder leitura a quem não tinha. Escrita: nenhum GRANT novo (a fase B grava por SECURITY
-- DEFINER). Se authenticated já tiver UPDATE/INSERT no nível da TABELA orders, a coluna herda esse
-- acesso (limitado pelo CHECK aos 3 valores) — a verificação final só AVISA (NOTICE), porque é o
-- mesmo acesso que já existe hoje sobre total/status; PRE-3 mostra a situação real.
--
-- NÃO altera: RLS/policies de orders, create_customer_order, cancel_order, update_order_status,
-- impressão (claim/resolve/register), estoque, valores de pedidos existentes.
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). SQL Editor:
--   supabase/sql-editor/20261025120000_add_orders_sales_channel.sql
-- Testes: supabase/testes-manuais/20261025_sales_channel_pre.sql (antes, só SELECT) e
--   supabase/testes-manuais/20261025_sales_channel_pos_leitura.sql (depois, somente leitura).
-- Rollback (manual): supabase/rollback/20261025120000_sales_channel_down.sql
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
  v_orders regclass := to_regclass('public.orders');
begin
  if v_orders is null then
    raise exception 'Migration interrompida, nada foi alterado: public.orders não existe';
  end if;

  if exists (select 1 from pg_attribute
             where attrelid = v_orders and attname = 'sales_channel' and not attisdropped) then
    v_falhas := v_falhas || ' [orders.sales_channel já existe]';
  end if;

  if not exists (select 1 from pg_attribute
                 where attrelid = v_orders and attname = 'status' and not attisdropped) then
    v_falhas := v_falhas || ' [orders.status não existe (referência do espelho de leitura)]';
  end if;

  select string_agg(x.papel, ', ')
    into v_texto
  from unnest(array['anon', 'authenticated']) as x(papel)
  where not exists (select 1 from pg_roles r where r.rolname = x.papel);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_texto);
  end if;

  if v_falhas <> '' then
    raise exception 'Migration interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Coluna
-- =====================================================================================

ALTER TABLE public.orders
  ADD COLUMN sales_channel text NOT NULL DEFAULT 'larica'
  CONSTRAINT orders_sales_channel_valido CHECK (sales_channel IN ('larica', 'deliveroo', 'just_eat'));

-- Espelho do SELECT de orders.status (efetivo, com herança). Quem lê a tabela inteira já herda.
DO $espelho$
declare
  v_papel text;
begin
  foreach v_papel in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_papel, 'public.orders', 'status', 'SELECT')
       and not has_column_privilege(v_papel, 'public.orders', 'sales_channel', 'SELECT') then
      execute format('GRANT SELECT (sales_channel) ON public.orders TO %I', v_papel);
    end if;
  end loop;
end;
$espelho$;


-- =====================================================================================
-- 2) Verificação final
-- =====================================================================================

DO $verificacao$
declare
  v_falhas text := '';
  v_papel text;
  c record;
begin
  select a.atttypid::regtype::text as tipo, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as padrao
    into c
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = 'public.orders'::regclass and a.attname = 'sales_channel' and not a.attisdropped;

  if c.tipo is null then
    raise exception 'Migration desfeita (verificação final): coluna não foi criada';
  end if;
  if c.tipo <> 'text' then
    v_falhas := v_falhas || format(' [tipo %s]', c.tipo);
  end if;
  if not c.attnotnull then
    v_falhas := v_falhas || ' [coluna aceita NULL]';
  end if;
  if c.padrao is distinct from '''larica''::text' then
    v_falhas := v_falhas || format(' [default %s]', c.padrao);
  end if;
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.orders'::regclass and conname = 'orders_sales_channel_valido') then
    v_falhas := v_falhas || ' [CHECK orders_sales_channel_valido ausente]';
  end if;
  if exists (select 1 from public.orders where sales_channel <> 'larica') then
    v_falhas := v_falhas || ' [há pedido com canal diferente de larica]';
  end if;

  foreach v_papel in array array['anon', 'authenticated'] loop
    if has_column_privilege(v_papel, 'public.orders', 'status', 'SELECT')
       is distinct from has_column_privilege(v_papel, 'public.orders', 'sales_channel', 'SELECT') then
      v_falhas := v_falhas || format(' [%s SELECT em sales_channel difere de status]', v_papel);
    end if;
    if has_column_privilege(v_papel, 'public.orders', 'sales_channel', 'UPDATE')
       or has_column_privilege(v_papel, 'public.orders', 'sales_channel', 'INSERT') then
      raise notice 'Aviso: % tem INSERT/UPDATE em orders herdado do nível da tabela; sales_channel segue esse mesmo acesso (limitado pelo CHECK).', v_papel;
    end if;
  end loop;

  if v_falhas <> '' then
    raise exception 'Migration desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
