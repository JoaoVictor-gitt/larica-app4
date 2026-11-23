-- =====================================================================================
-- FASE D — Estoque: ajustes manuais rastreáveis, perdas, contagem, estoque mínimo e
-- histórico unificado (produtos + insumos).
-- -------------------------------------------------------------------------------------
-- * Ajuste manual (produto ou insumo): entrada, saída, perda/desperdício ou CONTAGEM
--   (informa o saldo contado; o sistema lança só a diferença). Motivo obrigatório.
--   Nunca deixa o saldo negativo. Idempotente por client_request_id.
-- * Entrada de insumo pode informar custo unitário (estoque inicial valorizado): entra
--   no custo médio ponderado; sem custo, entra pelo custo médio atual.
-- * stock_movements ganha o tipo 'waste' (perda de produto pronto).
-- * Estoque mínimo por produto e por insumo (alerta de estoque baixo).
-- * get_stock_movements: histórico unificado com responsável, origem e nº do pedido.
-- Rollback: supabase/rollback/20261124110000_inventory_adjustments_and_ledger_view_down.sql
-- =====================================================================================

begin;

-- ------------------------------------------------------------------ 1. tipos, mínimos, idempotência
alter table public.stock_movements drop constraint stock_movements_movement_type_valido;
alter table public.stock_movements add constraint stock_movements_movement_type_valido check (movement_type = any (array[
  'sale', 'manual_addition', 'manual_removal', 'cancellation', 'purchase_in', 'purchase_reversal',
  'production_in', 'production_reversal', 'waste']));

alter table public.products add column min_stock integer;
alter table public.products add constraint products_min_stock_nao_negativo check (min_stock is null or min_stock >= 0);
alter table public.purchase_items add column min_stock numeric(14,3);
alter table public.purchase_items add constraint purchase_items_min_stock_nao_negativo check (min_stock is null or min_stock >= 0);

create unique index ux_stock_movements_manual_source on public.stock_movements (source_type, source_id, movement_type)
  where source_type = 'manual_adjustment' and source_id is not null;

-- ------------------------------------------------------------------ 2. entrada manual com custo entra no custo médio
-- (versão da Fase C + adjustment_in com valor informado = entrada ponderada)
create or replace function public._inventory_apply(
  p_item_id uuid,
  p_quantity numeric,
  p_value numeric,
  p_movement_type text,
  p_source_type text,
  p_source_id uuid,
  p_reason text,
  p_allow_negative boolean default false
)
returns public.inventory_movements
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.purchase_items%rowtype;
  v_q numeric;
  v_a numeric;
  v_new_q numeric;
  v_new_a numeric;
  v_value numeric;
  v_mov public.inventory_movements%rowtype;
begin
  select * into v_item from public.purchase_items where id = p_item_id for update;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;
  if not v_item.tracks_stock then
    raise exception 'O item "%" não controla estoque.', v_item.name;
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade do movimento inválida.';
  end if;

  v_q := v_item.stock_quantity;
  v_a := v_item.avg_cost;
  v_new_q := v_q + p_quantity;

  if v_new_q < 0 and not coalesce(p_allow_negative, false) then
    raise exception 'Estoque insuficiente de "%": saldo atual % %, movimento de % %.',
      v_item.name, trim(to_char(v_q, 'FM999999990.###')), v_item.base_unit,
      trim(to_char(p_quantity, 'FM999999990.###')), v_item.base_unit
      using hint = 'larica:insufficient_stock';
  end if;

  if p_movement_type = 'purchase_in'
     or (p_movement_type in ('production_reversal', 'adjustment_in') and p_value is not null) then
    if p_value is null or p_value < 0 then
      raise exception 'Valor de entrada inválido.';
    end if;
    v_value := p_value;
    if v_q <= 0 or v_a is null then
      v_new_a := p_value / p_quantity;
    else
      v_new_a := (v_q * v_a + p_value) / v_new_q;
    end if;
  elsif p_movement_type = 'purchase_reversal' then
    v_value := coalesce(p_value, p_quantity * coalesce(v_a, 0));
    if v_new_q > 0 and v_a is not null then
      v_new_a := (v_q * v_a + v_value) / v_new_q;
      if v_new_a < 0 then
        v_new_a := v_a;
      end if;
    else
      v_new_a := v_a;
    end if;
  else
    v_value := p_quantity * coalesce(v_a, 0);
    v_new_a := v_a;
  end if;

  insert into public.inventory_movements (
    purchase_item_id, movement_type, quantity, unit_cost, total_value,
    balance_before, balance_after, avg_cost_before, avg_cost_after,
    source_type, source_id, reason, created_by
  ) values (
    v_item.id, p_movement_type, p_quantity, abs(v_value / p_quantity), round(v_value, 4),
    v_q, v_new_q, v_a, v_new_a,
    p_source_type, p_source_id, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()
  )
  returning * into v_mov;

  update public.purchase_items
     set stock_quantity = v_new_q,
         avg_cost = v_new_a,
         avg_cost_updated_at = case when v_new_a is distinct from v_a then now() else avg_cost_updated_at end,
         updated_at = now()
   where id = v_item.id;

  if v_new_a is not null and v_new_a is distinct from v_a then
    if v_item.ingredient_id is not null then
      update public.ingredients i
         set purchase_price = round(v_new_a * i.purchase_quantity_base, 4),
             updated_at = now(),
             updated_by = auth.uid()
       where i.id = v_item.ingredient_id
         and i.base_unit = v_item.base_unit;
    elsif v_item.production_supply_id is not null and v_item.base_unit = 'un' then
      update public.production_supplies s
         set purchase_price = round(v_new_a * s.purchase_quantity, 4),
             updated_at = now(),
             updated_by = auth.uid()
       where s.id = v_item.production_supply_id;
    end if;
  end if;

  return v_mov;
end;
$function$;

-- ------------------------------------------------------------------ 3. ajuste manual de PRODUTO
-- p_payload: { client_request_id, product_id, mode: 'in'|'out'|'waste'|'count', quantity, reason }
--   in/out/waste: quantity > 0 (inteiro); count: quantity = saldo contado (>= 0).
create or replace function public.adjust_product_stock(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_req uuid;
  v_mode text := p_payload->>'mode';
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_qty numeric;
  v_product public.products%rowtype;
  v_delta integer;
  v_type text;
  v_mov public.stock_movements%rowtype;
  v_rotulo text;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  begin
    v_req := (p_payload->>'client_request_id')::uuid;
  exception when others then
    raise exception 'Identificador da operação inválido.';
  end;
  if v_req is null then
    raise exception 'Identificador da operação ausente.';
  end if;
  if v_mode not in ('in', 'out', 'waste', 'count') then
    raise exception 'Tipo de ajuste inválido.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo do ajuste.';
  end if;
  v_qty := (p_payload->>'quantity')::numeric;
  if v_qty is null or v_qty < 0 or v_qty <> floor(v_qty) or (v_mode <> 'count' and v_qty = 0) then
    raise exception 'Quantidade inválida (use um número inteiro%).', case when v_mode = 'count' then ' maior ou igual a zero' else ' maior que zero' end;
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select * into v_mov from public.stock_movements where source_type = 'manual_adjustment' and source_id = v_req limit 1;
  if found then
    return jsonb_build_object('duplicate', true, 'movement', to_jsonb(v_mov));
  end if;

  select * into v_product from public.products where id = (p_payload->>'product_id')::uuid for update;
  if not found then
    raise exception 'Produto não encontrado.';
  end if;

  v_delta := case v_mode
    when 'in' then v_qty::integer
    when 'out' then -v_qty::integer
    when 'waste' then -v_qty::integer
    else v_qty::integer - v_product.stock_quantity end;
  if v_delta = 0 then
    raise exception 'A contagem é igual ao saldo atual (% un): nada a ajustar.', v_product.stock_quantity;
  end if;
  if v_product.stock_quantity + v_delta < 0 then
    raise exception 'Estoque insuficiente de "%": saldo atual % un, saída de % un.', v_product.name, v_product.stock_quantity, abs(v_delta)
      using hint = 'larica:insufficient_stock';
  end if;

  v_type := case when v_mode = 'waste' then 'waste' when v_delta > 0 then 'manual_addition' else 'manual_removal' end;
  v_rotulo := case v_mode when 'count' then 'Contagem' when 'waste' then 'Perda' when 'in' then 'Entrada manual' else 'Saída manual' end;

  update public.products set stock_quantity = stock_quantity + v_delta, updated_at = now() where id = v_product.id;
  insert into public.stock_movements (
    product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, source_type, source_id, created_by
  ) values (
    v_product.id, null, v_type, v_delta, v_product.stock_quantity, v_product.stock_quantity + v_delta,
    v_rotulo || ': ' || left(v_reason, 480), 'manual_adjustment', v_req, auth.uid()
  )
  returning * into v_mov;

  return jsonb_build_object('duplicate', false, 'movement', to_jsonb(v_mov));
end;
$function$;

-- ------------------------------------------------------------------ 4. ajuste manual de INSUMO
-- p_payload: { client_request_id, purchase_item_id, mode, quantity (unidade-base), unit_cost?, reason }
--   unit_cost (por unidade-base) só vale para entradas; entra no custo médio ponderado.
create or replace function public.adjust_item_stock(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_req uuid;
  v_mode text := p_payload->>'mode';
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_qty numeric;
  v_cost numeric;
  v_item public.purchase_items%rowtype;
  v_product_mode text;
  v_delta numeric;
  v_type text;
  v_mov public.inventory_movements%rowtype;
  v_rotulo text;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  begin
    v_req := (p_payload->>'client_request_id')::uuid;
  exception when others then
    raise exception 'Identificador da operação inválido.';
  end;
  if v_req is null then
    raise exception 'Identificador da operação ausente.';
  end if;
  if v_mode not in ('in', 'out', 'waste', 'count') then
    raise exception 'Tipo de ajuste inválido.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo do ajuste.';
  end if;
  v_qty := round((p_payload->>'quantity')::numeric, 3);
  if v_qty is null or v_qty < 0 or (v_mode <> 'count' and v_qty = 0) then
    raise exception 'Quantidade inválida.';
  end if;
  v_cost := (p_payload->>'unit_cost')::numeric;
  if v_cost is not null and v_cost < 0 then
    raise exception 'Custo inválido.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select * into v_mov from public.inventory_movements where source_type = 'manual' and source_id = v_req limit 1;
  if found then
    return jsonb_build_object('duplicate', true, 'movement', to_jsonb(v_mov));
  end if;

  select * into v_item from public.purchase_items where id = (p_payload->>'purchase_item_id')::uuid;
  if not found then
    raise exception 'Item não encontrado.';
  end if;
  if not v_item.tracks_stock then
    raise exception '"%" é uma despesa, não tem estoque.', v_item.name;
  end if;
  if v_item.product_id is not null then
    select stock_mode into v_product_mode from public.products where id = v_item.product_id;
    if v_product_mode = 'purchased' then
      raise exception 'O estoque de "%" fica no produto de revenda — ajuste pela aba Produtos.', v_item.name;
    end if;
  end if;

  v_delta := case v_mode when 'in' then v_qty when 'out' then -v_qty when 'waste' then -v_qty else v_qty - v_item.stock_quantity end;
  if v_delta = 0 then
    raise exception 'A contagem é igual ao saldo atual: nada a ajustar.';
  end if;
  v_type := case when v_mode = 'waste' then 'waste' when v_delta > 0 then 'adjustment_in' else 'adjustment_out' end;
  v_rotulo := case v_mode when 'count' then 'Contagem' when 'waste' then 'Perda' when 'in' then 'Entrada manual' else 'Saída manual' end;

  v_mov := public._inventory_apply(
    v_item.id, v_delta,
    case when v_delta > 0 and v_cost is not null then round(v_delta * v_cost, 4) else null end,
    v_type, 'manual', v_req, v_rotulo || ': ' || left(v_reason, 480), false);

  return jsonb_build_object('duplicate', false, 'movement', to_jsonb(v_mov));
end;
$function$;

-- ------------------------------------------------------------------ 5. estoque mínimo
create or replace function public.set_min_stock(p_kind text, p_id uuid, p_min numeric)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem definir o estoque mínimo.';
  end if;
  if p_min is not null and p_min < 0 then
    raise exception 'Estoque mínimo inválido.';
  end if;
  if p_kind = 'product' then
    if p_min is not null and p_min <> floor(p_min) then
      raise exception 'Estoque mínimo de produto deve ser inteiro.';
    end if;
    update public.products set min_stock = p_min::integer, updated_at = now() where id = p_id;
  elsif p_kind = 'item' then
    update public.purchase_items set min_stock = round(p_min, 3), updated_at = now() where id = p_id;
  else
    raise exception 'Tipo inválido.';
  end if;
  if not found then
    raise exception 'Registro não encontrado.';
  end if;
end;
$function$;

-- ------------------------------------------------------------------ 6. histórico unificado
-- p_filters: { ledger: 'product'|'item'|null, target_id, types: [..], date_from, date_to, limit }
create or replace function public.get_stock_movements(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_ledger text := nullif(p_filters->>'ledger', '');
  v_target uuid := nullif(p_filters->>'target_id', '')::uuid;
  v_from date := nullif(p_filters->>'date_from', '')::date;
  v_to date := nullif(p_filters->>'date_to', '')::date;
  v_types text[];
  v_limit integer := least(greatest(coalesce((p_filters->>'limit')::integer, 200), 1), 500);
  v_result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  if jsonb_typeof(p_filters->'types') = 'array' and jsonb_array_length(p_filters->'types') > 0 then
    select array_agg(x) into v_types from jsonb_array_elements_text(p_filters->'types') x;
  end if;

  with todos as (
    select 'product'::text as ledger, sm.id, sm.created_at, sm.product_id as target_id, p.name as target_name, 'un'::text as base_unit,
           sm.movement_type, sm.quantity_change::numeric as quantity, sm.previous_quantity::numeric as balance_before,
           sm.new_quantity::numeric as balance_after, null::numeric as unit_cost, null::numeric as total_value,
           coalesce(sm.source_type, case when sm.order_id is not null then 'order' end) as source_type, coalesce(sm.source_id, sm.order_id) as source_id,
           sm.reason, o.order_number::bigint as order_number, sm.created_by
      from public.stock_movements sm
      join public.products p on p.id = sm.product_id
      left join public.orders o on o.id = sm.order_id
     where (v_ledger is null or v_ledger = 'product')
       and (v_target is null or sm.product_id = v_target)
       and (v_from is null or sm.created_at >= v_from::timestamptz)
       and (v_to is null or sm.created_at < (v_to + 1)::timestamptz)
       and (v_types is null or sm.movement_type = any (v_types))
    union all
    select 'item', m.id, m.created_at, m.purchase_item_id, pi.name, pi.base_unit,
           m.movement_type, m.quantity, m.balance_before, m.balance_after, m.unit_cost, m.total_value,
           m.source_type, m.source_id, m.reason, null::bigint, m.created_by
      from public.inventory_movements m
      join public.purchase_items pi on pi.id = m.purchase_item_id
     where (v_ledger is null or v_ledger = 'item')
       and (v_target is null or m.purchase_item_id = v_target)
       and (v_from is null or m.created_at >= v_from::timestamptz)
       and (v_to is null or m.created_at < (v_to + 1)::timestamptz)
       and (v_types is null or m.movement_type = any (v_types))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ledger', t.ledger, 'id', t.id, 'created_at', t.created_at, 'target_id', t.target_id, 'target_name', t.target_name,
           'base_unit', t.base_unit, 'movement_type', t.movement_type, 'quantity', t.quantity,
           'balance_before', t.balance_before, 'balance_after', t.balance_after, 'unit_cost', t.unit_cost, 'total_value', t.total_value,
           'source_type', t.source_type, 'source_id', t.source_id, 'reason', t.reason, 'order_number', t.order_number,
           'responsible', coalesce(nullif(btrim(pr.full_name), ''), pr.username)
         ) order by t.created_at desc, t.id), '[]'::jsonb)
    into v_result
    from (select * from todos order by created_at desc, id limit v_limit) t
    left join public.profiles pr on pr.id = t.created_by;

  return v_result;
end;
$function$;

-- ------------------------------------------------------------------ 7. permissões
revoke all on function public._inventory_apply(uuid, numeric, numeric, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.adjust_product_stock(jsonb) from public, anon;
revoke all on function public.adjust_item_stock(jsonb) from public, anon;
revoke all on function public.set_min_stock(text, uuid, numeric) from public, anon;
revoke all on function public.get_stock_movements(jsonb) from public, anon;
grant execute on function public.adjust_product_stock(jsonb) to authenticated;
grant execute on function public.adjust_item_stock(jsonb) to authenticated;
grant execute on function public.set_min_stock(text, uuid, numeric) to authenticated;
grant execute on function public.get_stock_movements(jsonb) to authenticated;

commit;
