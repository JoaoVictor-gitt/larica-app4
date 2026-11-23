-- Desfaz 20261124150000_orders_born_finalized.sql: pedidos voltam a nascer 'requested'
-- (e Revolut/transferência 'pending'), cancelamento volta a valer só para requested/preparing
-- e o acompanhamento volta ao mapeamento anterior. Pedidos já gravados NÃO são alterados.
drop trigger if exists trg_orders_nascem_finalizados on public.orders;
drop function if exists public._orders_nascem_finalizados();
create or replace function public.cancel_order(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_order record;
  v_reason text;
  v_item record;
  v_selection record;
  v_qtd_devolver integer;
  v_new_stock integer;
begin

  if not public.is_staff() then
    raise exception 'Usuário sem permissão';
  end if;

  v_reason := trim(p_reason);
  if v_reason is null or v_reason = '' then
    raise exception 'Motivo do cancelamento é obrigatório';
  end if;

  -- Lock na linha do pedido — impede que duas chamadas concorrentes pro mesmo
  -- pedido estornem o estoque duas vezes.
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido não encontrado';
  end if;

  if v_order.status not in ('requested', 'preparing') then
    raise exception 'Pedido não pode ser cancelado neste status';
  end if;

  -- =========================================================
  -- ESTORNO — PRODUTO SIMPLES
  -- =========================================================

  for v_item in
    select id, product_id, quantity
    from public.order_items
    where order_id = p_order_id
      and item_type = 'product'
  loop

    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Item do pedido inconsistente (produto)';
    end if;

    update public.products
       set stock_quantity = stock_quantity + v_item.quantity,
           updated_at = now()
     where id = v_item.product_id
    returning stock_quantity into v_new_stock;

    if not found then
      raise exception 'Produto não encontrado para estorno: %', v_item.product_id;
    end if;

    insert into public.stock_movements (
      product_id, order_id, movement_type,
      quantity_change, previous_quantity, new_quantity,
      reason, created_by
    )
    values (
      v_item.product_id, p_order_id, 'cancellation',
      v_item.quantity, v_new_stock - v_item.quantity, v_new_stock,
      v_reason, auth.uid()
    );

  end loop;

  -- =========================================================
  -- ESTORNO — COMPONENTES DE COMBO (snapshot order_item_selections;
  -- nunca combo_configs/combo_skewer_options/combo_included_products)
  -- =========================================================

  for v_item in
    select id, quantity
    from public.order_items
    where order_id = p_order_id
      and item_type = 'combo'
  loop

    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Item do pedido inconsistente (combo)';
    end if;

    for v_selection in
      select selected_product_id, quantity
      from public.order_item_selections
      where order_item_id = v_item.id
    loop

      if v_selection.selected_product_id is null
         or v_selection.quantity is null
         or v_selection.quantity <= 0 then
        raise exception 'Seleção de combo inconsistente';
      end if;

      -- quantity da selection é por unidade do combo
      v_qtd_devolver := v_selection.quantity * v_item.quantity;

      update public.products
         set stock_quantity = stock_quantity + v_qtd_devolver,
             updated_at = now()
       where id = v_selection.selected_product_id
      returning stock_quantity into v_new_stock;

      if not found then
        raise exception 'Produto não encontrado para estorno: %', v_selection.selected_product_id;
      end if;

      insert into public.stock_movements (
        product_id, order_id, movement_type,
        quantity_change, previous_quantity, new_quantity,
        reason, created_by
      )
      values (
        v_selection.selected_product_id, p_order_id, 'cancellation',
        v_qtd_devolver, v_new_stock - v_qtd_devolver, v_new_stock,
        v_reason, auth.uid()
      );

    end loop;

  end loop;

  -- =========================================================
  -- ATUALIZA O PEDIDO (só depois de todos os estornos concluídos)
  -- =========================================================

  update public.orders
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = v_reason
   where id = p_order_id;

  select * into v_order
  from public.orders
  where id = p_order_id;

  return v_order;

end;
$function$;

create or replace function public.get_public_order_tracking(p_order_number text)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_numero integer;
  v_order  public.orders%rowtype;
  v_status_publico text;
  v_estimativa timestamptz;
begin

  -- Normaliza "#LARICA-31" / "LARICA-31" / "31" -> 31 (extrai só dígitos).
  v_numero := nullif(regexp_replace(coalesce(p_order_number, ''), '\D', '', 'g'), '')::integer;

  if v_numero is null then
    return null;
  end if;

  select * into v_order
  from public.orders
  where order_number = v_numero;

  if not found then
    return null;
  end if;

  v_status_publico := case
    when v_order.status = 'cancelled' then 'cancelado'
    when v_order.status = 'requested' and v_order.payment_status = 'pending' then 'aguardando_pagamento'
    when v_order.status = 'requested' then 'solicitado'
    when v_order.status = 'preparing' then 'em_preparo'
    when v_order.status = 'ready' then 'pronto'
    when v_order.status = 'completed' then 'finalizado'
    else v_order.status
  end;

  -- Previsão só faz sentido enquanto o pedido não terminou de fato nem foi cancelado.
  if v_order.status not in ('completed', 'cancelled') then
    if v_order.fulfilment_type = 'collection' then
      v_estimativa := v_order.created_at + interval '20 minutes';
    elsif v_order.delivery_duration_seconds is not null then
      v_estimativa := v_order.created_at
        + interval '20 minutes'
        + (v_order.delivery_duration_seconds || ' seconds')::interval
        + interval '20 minutes';
    else
      v_estimativa := null;
    end if;
  else
    v_estimativa := null;
  end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'status', v_status_publico,
    'fulfilment_type', v_order.fulfilment_type,
    'created_at', v_order.created_at,
    'estimated_ready_at', v_estimativa,
    'completed_at', v_order.completed_at,
    'cancelled_at', v_order.cancelled_at
  );

end;
$function$;

drop function if exists public._inicio_dia_operacional();

