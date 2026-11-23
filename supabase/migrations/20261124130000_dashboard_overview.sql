-- =====================================================================================
-- FASE F — Dashboard gerencial: um RPC só para a visão rápida do negócio.
-- -------------------------------------------------------------------------------------
-- get_dashboard(p_from, p_to) — qualquer staff:
--   vendas (hoje, período e período anterior de mesmo tamanho), série diária, mais
--   vendidos, alertas de estoque (produtos e insumos abaixo do mínimo, zerados ou
--   negativos) e produções recentes.
--   Bloco "finance" (DRE, CMV com cobertura, caixa, rentabilidade) só para admin —
--   reaproveita get_finance_report (mesmos números do Financeiro). Para funcionário vem null.
-- Somente leitura. Rollback: supabase/rollback/20261124130000_dashboard_overview_down.sql
-- =====================================================================================

begin;

create or replace function public.get_dashboard(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_tz text;
  v_hoje date;
  v_ini timestamptz;
  v_fim timestamptz;
  v_dias integer;
  v_ant_ini timestamptz;
  v_ant_fim timestamptz;
  v_hoje_ini timestamptz;
  v_vendas jsonb;
  v_anterior jsonb;
  v_hoje_j jsonb;
  v_diario jsonb;
  v_top jsonb;
  v_alertas jsonb;
  v_producoes jsonb;
  v_fin jsonb;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Período inválido.';
  end if;
  if p_to - p_from > 400 then
    raise exception 'Período longo demais para o Dashboard (máximo 400 dias). Use o Financeiro.';
  end if;
  select coalesce(nullif(timezone, ''), 'Europe/Dublin') into v_tz from public.business_settings limit 1;
  v_tz := coalesce(v_tz, 'Europe/Dublin');
  v_hoje := (now() at time zone v_tz)::date;
  v_dias := p_to - p_from + 1;
  v_ini := (p_from::timestamp at time zone v_tz);
  v_fim := ((p_to + 1)::timestamp at time zone v_tz);
  v_ant_ini := ((p_from - v_dias)::timestamp at time zone v_tz);
  v_ant_fim := v_ini;
  v_hoje_ini := (v_hoje::timestamp at time zone v_tz);

  select jsonb_build_object(
    'revenue', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    'orders', count(*) filter (where o.status <> 'cancelled'),
    'cancelled', count(*) filter (where o.status = 'cancelled'),
    'avg_ticket', case when count(*) filter (where o.status <> 'cancelled') > 0
                       then round(sum(o.total) filter (where o.status <> 'cancelled') / count(*) filter (where o.status <> 'cancelled'), 2) else 0 end
  ) into v_vendas
  from public.orders o where o.created_at >= v_ini and o.created_at < v_fim;

  select jsonb_build_object(
    'revenue', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    'orders', count(*) filter (where o.status <> 'cancelled'),
    'from', p_from - v_dias, 'to', p_from - 1
  ) into v_anterior
  from public.orders o where o.created_at >= v_ant_ini and o.created_at < v_ant_fim;

  select jsonb_build_object(
    'date', v_hoje,
    'revenue', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    'orders', count(*) filter (where o.status <> 'cancelled')
  ) into v_hoje_j
  from public.orders o where o.created_at >= v_hoje_ini and o.created_at < v_hoje_ini + interval '1 day';

  select coalesce(jsonb_agg(jsonb_build_object('date', d.dia::date, 'revenue', coalesce(r.v, 0), 'orders', coalesce(r.n, 0)) order by d.dia), '[]'::jsonb)
    into v_diario
    from generate_series(p_from, p_to, interval '1 day') d(dia)
    left join (select (o.created_at at time zone v_tz)::date dia, sum(o.total) v, count(*) n
                 from public.orders o where o.created_at >= v_ini and o.created_at < v_fim and o.status <> 'cancelled' group by 1) r
      on r.dia = d.dia::date;

  select coalesce(jsonb_agg(x order by x.qty desc, x.revenue desc), '[]'::jsonb) into v_top
    from (
      select coalesce(p.name, (array_agg(oi.product_name order by o.created_at desc))[1]) as name,
             sum(oi.quantity) qty, sum(oi.total_price) revenue
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        left join public.products p on p.id = oi.product_id
       where o.created_at >= v_ini and o.created_at < v_fim and o.status <> 'cancelled'
       group by oi.product_id, p.name
       order by 2 desc, 3 desc
       limit 8
    ) x;

  select coalesce(jsonb_agg(a order by a.ordem, a.name), '[]'::jsonb) into v_alertas
    from (
      select 'product' as kind, p.id, p.name, p.stock_quantity::numeric as stock, p.min_stock::numeric as min, 'un'::text as unit,
             case when p.stock_quantity < 0 then 'negative' when p.stock_quantity = 0 then 'zero' else 'low' end as level,
             case when p.stock_quantity < 0 then 0 when p.stock_quantity = 0 then 1 else 2 end as ordem
        from public.products p
       where p.active and p.category <> 'combos' and p.stock_mode <> 'untracked'
         and (p.stock_quantity <= 0 or (p.min_stock is not null and p.stock_quantity < p.min_stock))
      union all
      select 'item', i.id, i.name, i.stock_quantity, i.min_stock, i.base_unit,
             case when i.stock_quantity < 0 then 'negative' when i.stock_quantity = 0 then 'zero' else 'low' end,
             case when i.stock_quantity < 0 then 0 when i.stock_quantity = 0 then 1 else 2 end
        from public.purchase_items i
       where i.active and i.tracks_stock
         and not exists (select 1 from public.products pp where pp.id = i.product_id and pp.stock_mode = 'purchased')
         -- insumo que nunca teve movimento não é "alerta": ainda não foi lançado no estoque
         and exists (select 1 from public.inventory_movements m where m.purchase_item_id = i.id)
         and (i.stock_quantity <= 0 or (i.min_stock is not null and i.stock_quantity < i.min_stock))
    ) a;

  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v_producoes
    from (
      select b.id, b.kind, p.name as product_name, b.produced_at, b.units_produced, b.unit_cost, b.cost_status, b.status, b.created_at
        from public.production_batches b join public.products p on p.id = b.product_id
       order by b.created_at desc
       limit 5
    ) x;

  if public.is_admin() then
    v_fin := public.get_finance_report(p_from, p_to);
    v_fin := jsonb_build_object('dre', v_fin->'dre', 'cogs', v_fin->'cogs', 'cash', v_fin->'cash',
                                'accounts', v_fin->'accounts', 'products', v_fin->'products', 'expenses', v_fin->'expenses');
  end if;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', v_dias, 'timezone', v_tz),
    'today', v_hoje_j,
    'sales', v_vendas,
    'previous', v_anterior,
    'daily', v_diario,
    'top_products', v_top,
    'stock_alerts', v_alertas,
    'recent_productions', v_producoes,
    'finance', v_fin
  );
end;
$function$;

revoke all on function public.get_dashboard(date, date) from public, anon;
grant execute on function public.get_dashboard(date, date) to authenticated;

commit;
