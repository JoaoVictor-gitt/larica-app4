-- *** NÃO APLICAR — SUBSTITUÍDA, NUNCA FOI APLICADA NO BANCO ***
-- Esta versão (identificação calculada na hora, sem cadastro) foi substituída por
-- supabase/migrations/20261009100000_add_customer_registry.sql (cadastro persistente).
-- Movida para fora de supabase/migrations/ para nunca ser aplicada por `supabase db push`
-- (criaria funções com os mesmos nomes e assinaturas diferentes). Mantida só como registro.
--
-- Clientes (painel admin) — visão por cliente derivada dos pedidos já existentes.
--
-- Não existe tabela de clientes. Identificação (decisão do usuário):
--   - NOME normalizado (lower + trim + espaços colapsados; acentos e variações
--     NÃO são unificados) + TELEFONE IRLANDÊS normalizado (353...);
--   - mesmo nome + mesmo telefone  -> um cliente (todos os pedidos do par);
--   - mesmo nome + telefones diferentes -> clientes separados ("Nome repetido");
--   - nomes diferentes + mesmo telefone -> clientes separados ("Telefone
--     compartilhado / possível vínculo");
--   - sem telefone (ou telefone não reconhecido) -> cada pedido é um registro
--     avulso ("Identificação incompleta"), NUNCA agrupado só pelo nome; nomes
--     iguais aparecem como "possíveis correspondências".
--
-- Métricas: só pedidos status = 'completed'. Pedido finalizado com total 0 conta
-- normalmente. Cancelados/em andamento aparecem só no histórico da ficha.
-- Pedidos avulsos ficam fora de clientes únicos/recorrentes/ticket e são
-- informados à parte.
--
-- Acesso: SOMENTE ADMIN — as 3 RPCs são SECURITY DEFINER (ignoram RLS), então
-- is_admin() é a primeira instrução de cada uma; anon/PUBLIC sem EXECUTE.
--
-- Puramente aditiva: nenhuma tabela, linha, trigger, policy, publicação ou RPC
-- existente é alterada (criação de pedidos, Kanban, Realtime e impressão Epson
-- intocados). Único efeito em orders é o índice de expressão (seção 2).
--
-- ATENÇÃO: as funções normalize_* são IMMUTABLE e indexadas — alterar a regra
-- depois de aplicada exige REINDEX INDEX public.idx_orders_customer_identity.

-- =============================================================
-- 1) Normalização (IMMUTABLE pra poder indexar)
-- =============================================================

-- Nome: NBSP/tab/quebras -> espaço, trim, espaços repetidos -> 1, minúsculas.
CREATE OR REPLACE FUNCTION public.normalize_customer_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select nullif(
    lower(
      regexp_replace(
        trim(translate(coalesce(p_name, ''), chr(160) || chr(9) || chr(10) || chr(13), '    ')),
        '[[:space:]]+', ' ', 'g'
      )
    ),
    ''
  );
$function$;

-- Telefone irlandês -> '353' + número nacional sem o 0. Aceita:
--   087 123 4567 | +353 87 123 4567 | 353871234567 (WhatsApp) | 00353 87... |
--   +353 (0)87... | 87 123 4567 (celular sem o 0) | 01 234 5678 (fixo).
-- Qualquer outra coisa -> NULL (tratado como "sem telefone").
CREATE OR REPLACE FUNCTION public.normalize_customer_phone(p_phone text)
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

-- Funções puras (não expõem dado nenhum) usadas na expressão do índice de orders:
-- o Postgres exige EXECUTE de quem grava em orders ao avaliar o índice, então
-- ficam liberadas pra todos — revogar só criaria risco de quebrar INSERT de pedido.
GRANT EXECUTE ON FUNCTION public.normalize_customer_name(text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_customer_phone(text) TO PUBLIC;

-- =============================================================
-- 2) Índice de expressão (ficha por cliente / nomes repetidos)
-- =============================================================
-- CREATE INDEX pega lock SHARE em orders (bloqueia escritas enquanto roda, ms
-- numa tabela pequena). lock_timeout faz falhar limpo em vez de enfileirar
-- novos pedidos/impressões atrás de uma transação longa. Aplicar fora do horário.
-- customer_name/customer_phone não mudam depois do INSERT, então os UPDATEs de
-- status/impressão/auto-print continuam HOT (sem custo extra de índice).

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_orders_customer_identity
  ON public.orders (public.normalize_customer_name(customer_name), public.normalize_customer_phone(customer_phone));

-- =============================================================
-- 3) Indicadores gerais
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_customers_overview()
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

  with base as (
    select public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk,
           o.total
    from public.orders o
    where o.status = 'completed'
  ),
  grupos as (
    select nk, pk, count(*) as n
    from base
    where nk is not null and pk is not null
    group by nk, pk
  ),
  identificados as (
    select count(*) as n, coalesce(sum(total), 0) as soma
    from base
    where nk is not null and pk is not null
  ),
  avulsos as (
    select count(*) as n, coalesce(sum(total), 0) as soma
    from base
    where nk is null or pk is null
  )
  select jsonb_build_object(
    'unique_customers',    (select count(*) from grupos),
    'recurring_customers', (select count(*) from grupos where n >= 2),
    'orders_count',        i.n,
    'total_spent',         i.soma,
    'avg_ticket',          case when i.n > 0 then round(i.soma / i.n, 2) else 0 end,
    'incomplete_orders',   a.n,
    'incomplete_total',    a.soma,
    'repeated_names',      (select count(*) from (select nk from grupos group by nk having count(*) > 1) r),
    'shared_phones',       (select count(*) from (select pk from grupos group by pk having count(*) > 1) s)
  )
  into v_result
  from identificados i, avulsos a;

  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION public.get_customers_overview() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customers_overview() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_customers_overview() TO authenticated;

-- =============================================================
-- 4) Lista paginada (busca/ordenação/filtro no servidor)
-- =============================================================
-- Linhas: 1 por cliente identificado (nome+telefone) com >=1 pedido finalizado
-- e 1 por pedido finalizado avulso (sem telefone reconhecido).
-- p_sort:   'name_asc' (padrão) | 'orders_desc' | 'spent_desc' | 'last_desc'
-- p_filter: 'all' (padrão) | 'identified' | 'incomplete' | 'duplicates'
-- p_search: com letras -> parte do nome normalizado; só dígitos -> parte do
--           telefone ("087..." também casa com "35387...").
-- Abre a ficha por ref_order_id (pedido mais recente da linha) — o telefone
-- nunca precisa ir pra URL.

CREATE OR REPLACE FUNCTION public.list_customers(
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
  v_filter text := case when p_filter in ('all', 'identified', 'incomplete', 'duplicates') then p_filter else 'all' end;
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_name_like text;
  v_digits text;
  v_digits_sem_zero text;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  if v_search is not null then
    if v_search ~ '[[:alpha:]]' then
      v_name_like := '%' || replace(replace(replace(public.normalize_customer_name(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    else
      v_digits := nullif(regexp_replace(v_search, '[^0-9]', '', 'g'), '');
      if v_digits is not null and v_digits like '0%' and length(v_digits) > 1 then
        v_digits_sem_zero := substr(v_digits, 2);
      end if;
      if v_digits is null then
        -- termo sem letras nem dígitos (ex.: "+", "-") -> busca literal no nome
        v_name_like := '%' || replace(replace(replace(lower(v_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
      end if;
    end if;
  end if;

  with base as (
    select o.id, o.order_number, o.created_at, o.total, o.customer_name, o.customer_phone,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk
    from public.orders o
    where o.status = 'completed'
  ),
  grupos as (
    select nk, pk,
           (array_agg(id order by created_at desc, order_number desc))[1] as ref_order_id,
           (array_agg(trim(customer_name) order by created_at desc, order_number desc))[1] as display_name,
           (array_agg(customer_phone order by created_at desc, order_number desc))[1] as phone,
           count(*) as orders_count,
           coalesce(sum(total), 0) as total_spent,
           min(created_at) as first_order_at,
           max(created_at) as last_order_at
    from base
    where nk is not null and pk is not null
    group by nk, pk
  ),
  avulsos as (
    select * from base where nk is null or pk is null
  ),
  grupos_por_nome as (
    select nk, count(*) as n from grupos group by nk
  ),
  avulsos_por_nome as (
    select nk, count(*) as n from avulsos where nk is not null group by nk
  ),
  linhas as (
    select 'identified'::text as kind,
           g.nk, g.pk, g.ref_order_id, g.display_name, g.phone,
           g.orders_count, g.total_spent,
           round(g.total_spent / g.orders_count, 2) as avg_ticket,
           g.first_order_at, g.last_order_at,
           (count(*) over (partition by g.nk)) - 1 as same_name_count,
           (count(*) over (partition by g.pk)) - 1 as shared_phone_count,
           coalesce(apn.n, 0) as possible_matches,
           false as phone_unrecognized
    from grupos g
    left join avulsos_por_nome apn on apn.nk = g.nk
    union all
    select 'incomplete'::text,
           a.nk, null::text, a.id, trim(a.customer_name), a.customer_phone,
           1::bigint, coalesce(a.total, 0),
           round(coalesce(a.total, 0), 2),
           a.created_at, a.created_at,
           0::bigint, 0::bigint,
           coalesce(gpn.n, 0) + coalesce(apn.n, 1) - 1,
           coalesce(trim(a.customer_phone), '') <> ''
    from avulsos a
    left join grupos_por_nome gpn on gpn.nk = a.nk
    left join avulsos_por_nome apn on apn.nk = a.nk
  ),
  filtrado as (
    select *
    from linhas l
    where (v_filter = 'all'
           or (v_filter = 'identified' and l.kind = 'identified')
           or (v_filter = 'incomplete' and l.kind = 'incomplete')
           or (v_filter = 'duplicates' and (l.same_name_count > 0 or l.shared_phone_count > 0 or l.possible_matches > 0)))
      and (v_search is null
           or (v_name_like is not null and l.nk like v_name_like)
           or (v_digits is not null and (
                 coalesce(l.pk, '') like '%' || v_digits || '%'
                 or regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'
                 or (v_digits_sem_zero is not null and coalesce(l.pk, '') like '%' || v_digits_sem_zero || '%'))))
  ),
  pagina as (
    select f.*,
           row_number() over (
             order by
               case when v_sort = 'orders_desc' then f.orders_count end desc nulls last,
               case when v_sort = 'spent_desc' then f.total_spent end desc nulls last,
               case when v_sort = 'last_desc' then f.last_order_at end desc nulls last,
               f.nk asc nulls last,
               f.last_order_at desc,
               f.ref_order_id
           ) as ordem
    from filtrado f
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrado),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', p.kind,
               'ref_order_id', p.ref_order_id,
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

REVOKE ALL ON FUNCTION public.list_customers(text, text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_customers(text, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_customers(text, text, text, integer, integer) TO authenticated;

-- =============================================================
-- 5) Ficha individual — sempre a partir de um pedido
-- =============================================================
-- O par (nome, telefone) é resolvido do pedido p_order_id (link do Histórico ou
-- ref_order_id da lista). Com telefone reconhecido: todos os pedidos do MESMO
-- par, de qualquer status (paginados, mais recente primeiro, com itens e
-- seleções). Sem telefone: só aquele pedido. Métricas e top_products contam só
-- 'completed'. Alertas (nunca agrupam, só apontam outras fichas, máx. 20 cada):
--   same_name         — mesmo nome, outro telefone
--   shared_phone      — mesmo telefone, outro nome
--   possible_matches  — mesmo nome sem telefone (e, numa ficha avulsa, também
--                       clientes identificados com o mesmo nome)

CREATE OR REPLACE FUNCTION public.get_customer_detail(
  p_order_id uuid,
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
  v_nk text;
  v_pk text;
  v_raw_phone text;
  v_identified boolean;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  if p_order_id is null then
    raise exception 'Informe o pedido';
  end if;

  select public.normalize_customer_name(o.customer_name),
         public.normalize_customer_phone(o.customer_phone),
         o.customer_phone
    into v_nk, v_pk, v_raw_phone
  from public.orders o
  where o.id = p_order_id;

  if not found then
    raise exception 'Pedido não encontrado';
  end if;

  v_identified := v_nk is not null and v_pk is not null;

  with alvo as (
    -- Dois ramos excludentes (só um roda): cada um usa o próprio índice.
    select o.*
    from public.orders o
    where v_identified
      and public.normalize_customer_name(o.customer_name) = v_nk
      and public.normalize_customer_phone(o.customer_phone) = v_pk
    union all
    select o.*
    from public.orders o
    where not v_identified
      and o.id = p_order_id
  ),
  finalizados as (
    select * from alvo where status = 'completed'
  ),
  pagina as (
    select *
    from alvo
    order by created_at desc, order_number desc
    limit v_limit offset v_offset
  ),
  relacionados as (
    -- Pedidos (qualquer status) com o mesmo nome ou o mesmo telefone, fora do próprio cliente.
    select r.id, r.order_number, r.created_at, r.status, r.total, r.customer_name, r.customer_phone, r.nk, r.pk
    from (
      select o.*,
             public.normalize_customer_name(o.customer_name) as nk,
             public.normalize_customer_phone(o.customer_phone) as pk
      from public.orders o
      where (v_nk is not null and public.normalize_customer_name(o.customer_name) = v_nk)
         or (v_pk is not null and public.normalize_customer_phone(o.customer_phone) = v_pk)
    ) r
    where not (v_identified and r.nk is not distinct from v_nk and r.pk is not distinct from v_pk)
      and r.id <> p_order_id
  ),
  grupos_relacionados as (
    -- Clientes identificados relacionados (agrupados pelo próprio par nome+telefone)
    select nk, pk,
           (array_agg(id order by created_at desc, order_number desc))[1] as ref_order_id,
           (array_agg(trim(customer_name) order by created_at desc, order_number desc))[1] as display_name,
           (array_agg(customer_phone order by created_at desc, order_number desc))[1] as phone,
           count(*) as orders_count,
           max(created_at) as last_order_at
    from relacionados
    where nk is not null and pk is not null
    group by nk, pk
  ),
  avulsos_relacionados as (
    -- Pedidos sem telefone com o mesmo nome (cada um isolado)
    select id as ref_order_id, trim(customer_name) as display_name, customer_phone as phone,
           1::bigint as orders_count, created_at as last_order_at
    from relacionados
    where pk is null and nk = v_nk
  )
  select jsonb_build_object(
    'identified', v_identified,
    'phone_unrecognized', (not v_identified and coalesce(trim(v_raw_phone), '') <> ''),
    'customer', jsonb_build_object(
      'display_name', coalesce(
        (select trim(customer_name) from finalizados order by created_at desc, order_number desc limit 1),
        (select trim(customer_name) from alvo order by created_at desc, order_number desc limit 1)
      ),
      'phone', (select customer_phone from alvo where customer_phone is not null order by created_at desc, order_number desc limit 1),
      'first_order_at', (select min(created_at) from finalizados),
      'last_order_at', (select max(created_at) from finalizados)
    ),
    'metrics', (
      select jsonb_build_object(
        'orders_count', count(*),
        'total_spent', coalesce(sum(total), 0),
        'avg_ticket', case when count(*) > 0 then round(coalesce(sum(total), 0) / count(*), 2) else 0 end
      )
      from finalizados
    ) || (
      select jsonb_build_object(
        'cancelled_count', count(*) filter (where status = 'cancelled'),
        'open_count', count(*) filter (where status in ('requested', 'preparing', 'ready'))
      )
      from alvo
    ),
    'orders_total', (select count(*) from alvo),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id,
               'order_number', p.order_number,
               'status', p.status,
               'created_at', p.created_at,
               'completed_at', p.completed_at,
               'cancelled_at', p.cancelled_at,
               'cancel_reason', p.cancel_reason,
               'customer_name', p.customer_name,
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
             ) order by p.created_at desc, p.order_number desc)
      from pagina p
    ), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(t order by t.quantity desc, t.product_name)
      from (
        select (array_agg(i.product_name order by f.created_at desc))[1] as product_name,
               sum(i.quantity) as quantity,
               count(distinct f.id) as orders_count,
               coalesce(sum(i.total_price), 0) as items_value
        from finalizados f
        join public.order_items i on i.order_id = f.id
        group by coalesce(i.product_id::text, i.product_name)
        order by sum(i.quantity) desc, 1
        limit 10
      ) t
    ), '[]'::jsonb),
    'same_name', coalesce((
      select jsonb_agg(x order by x.last_order_at desc)
      from (
        select ref_order_id, display_name, phone, orders_count, last_order_at
        from grupos_relacionados
        where v_identified and nk = v_nk and pk <> v_pk
        order by last_order_at desc
        limit 20
      ) x
    ), '[]'::jsonb),
    'shared_phone', coalesce((
      select jsonb_agg(x order by x.last_order_at desc)
      from (
        select ref_order_id, display_name, phone, orders_count, last_order_at
        from grupos_relacionados
        where v_identified and pk = v_pk and nk is distinct from v_nk
        order by last_order_at desc
        limit 20
      ) x
    ), '[]'::jsonb),
    'possible_matches', coalesce((
      select jsonb_agg(x order by x.last_order_at desc)
      from (
        select 'incomplete'::text as kind, ref_order_id, display_name, phone, orders_count, last_order_at
        from avulsos_relacionados
        union all
        select 'identified'::text, ref_order_id, display_name, phone, orders_count, last_order_at
        from grupos_relacionados
        where not v_identified and nk = v_nk
        order by last_order_at desc
        limit 20
      ) x
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_detail(uuid, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_detail(uuid, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_customer_detail(uuid, integer, integer) TO authenticated;
