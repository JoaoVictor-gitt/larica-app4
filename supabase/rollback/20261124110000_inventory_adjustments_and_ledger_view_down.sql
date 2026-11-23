-- ROLLBACK de 20261124110000_inventory_adjustments_and_ledger_view.sql
-- Seguro apenas ANTES de lançar ajustes manuais/perdas no fluxo novo (trava abaixo).
begin;

do $$
begin
  if exists (select 1 from public.stock_movements where source_type = 'manual_adjustment' or movement_type = 'waste')
     or exists (select 1 from public.inventory_movements where source_type = 'manual') then
    raise exception 'Rollback recusado: já há ajustes/perdas lançados pelo fluxo novo.';
  end if;
end $$;

drop function if exists public.adjust_product_stock(jsonb);
drop function if exists public.adjust_item_stock(jsonb);
drop function if exists public.set_min_stock(text, uuid, numeric);
drop function if exists public.get_stock_movements(jsonb);
drop index if exists public.ux_stock_movements_manual_source;

alter table public.products drop constraint if exists products_min_stock_nao_negativo;
alter table public.products drop column if exists min_stock;
alter table public.purchase_items drop constraint if exists purchase_items_min_stock_nao_negativo;
alter table public.purchase_items drop column if exists min_stock;

alter table public.stock_movements drop constraint stock_movements_movement_type_valido;
alter table public.stock_movements add constraint stock_movements_movement_type_valido check (movement_type = any (array[
  'sale', 'manual_addition', 'manual_removal', 'cancellation', 'purchase_in', 'purchase_reversal',
  'production_in', 'production_reversal']));

-- _inventory_apply volta à versão da Fase C
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

  if p_movement_type = 'purchase_in' or (p_movement_type = 'production_reversal' and p_value is not null) then
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

revoke all on function public._inventory_apply(uuid, numeric, numeric, text, text, uuid, text, boolean) from public, anon, authenticated;

commit;