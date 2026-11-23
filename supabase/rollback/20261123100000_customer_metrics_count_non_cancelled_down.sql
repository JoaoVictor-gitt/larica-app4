-- ROLLBACK de 20261123100000_customer_metrics_count_non_cancelled.sql
-- Restaura as definições exatamente como estavam no banco em 2026-11-23 (só status = 'completed').

begin;

CREATE OR REPLACE FUNCTION public._customer_top_products_json(p_order_ids uuid[])
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
    'shared_phones',             (select count(*) from (select phone_e164 from ativos where phone_e164 is not null group by phone_e164 having count(*) > 1) y)
  )
  into v_result;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_customers(p_search text DEFAULT NULL::text, p_sort text DEFAULT 'name_asc'::text, p_filter text DEFAULT 'all'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
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
    select phone_e164, count(*) as n from ativos where phone_e164 is not null group by phone_e164
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
           coalesce(ta.n - 1, 0)::bigint as shared_phone_count,
           coalesce(ns.n, 0)::bigint as possible_matches,
           false as phone_unrecognized
    from ativos a
    join nomes_ativos na on na.name_key = a.name_key
    left join telefones_ativos ta
      on ta.phone_e164 = a.phone_e164
      and a.phone_e164 is not null
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

CREATE OR REPLACE FUNCTION public.get_customer_detail(p_customer_id uuid DEFAULT NULL::uuid, p_order_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
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

commit;