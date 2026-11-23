-- Pedidos nascem FINALIZADOS e PAGOS (pedido do usuário em 2026-11-24).
--
-- Sem etapas de atendimento e sem confirmação manual de pagamento:
--   * todo pedido novo (não cancelado) entra com status 'completed';
--   * Revolut / transferência entram com payment_status 'paid' (antes ficavam 'pending'
--     esperando a equipe confirmar). Cartão/dinheiro seguem 'pay_on_delivery'.
--   * completed_at fica vazio: o pedido não foi "concluído" na hora em que entrou, e
--     preencher distorceria os tempos de preparo dos relatórios.
-- Cancelamento: qualquer pedido não cancelado do DIA OPERACIONAL atual (começa 04:00,
-- horário de Dublin), com o mesmo estorno de estoque de antes. Dias anteriores: não.
-- Acompanhamento público: pedido finalizado sem completed_at aparece como "Pedido recebido"
-- (status público 'solicitado'), com a previsão de tempo — nunca "Finalizado" logo após pedir.
-- Também finaliza/paga o que estiver em aberto agora (idempotente).

-- ------------------------------------------------------------------ 1. pedidos novos
create or replace function public._orders_nascem_finalizados()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.status is distinct from 'cancelled' then
    new.status := 'completed';
  end if;
  if new.payment_status = 'pending' then
    new.payment_status := 'paid';
    new.payment_confirmed_at := coalesce(new.payment_confirmed_at, now());
  end if;
  return new;
end;
$function$;

revoke all on function public._orders_nascem_finalizados() from public, anon, authenticated;

drop trigger if exists trg_orders_nascem_finalizados on public.orders;
create trigger trg_orders_nascem_finalizados
  before insert on public.orders
  for each row execute function public._orders_nascem_finalizados();

-- ------------------------------------------------------------------ 2. início do dia operacional
create or replace function public._inicio_dia_operacional()
returns timestamptz
language sql
stable
set search_path to ''
as $function$
  select ((date_trunc('day', (now() at time zone 'Europe/Dublin') - interval '4 hours') + interval '4 hours') at time zone 'Europe/Dublin');
$function$;

revoke all on function public._inicio_dia_operacional() from public, anon;
grant execute on function public._inicio_dia_operacional() to authenticated, service_role;

-- ------------------------------------------------------------------ 3. cancelamento: pedidos do dia
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

  if v_order.status = 'cancelled' then
    raise exception 'Pedido já está cancelado';
  end if;

  -- Sem etapas, todo pedido nasce finalizado: o limite agora é o dia operacional.
  if v_order.created_at < public._inicio_dia_operacional() then
    raise exception 'Só é possível cancelar pedidos do dia';
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

-- ------------------------------------------------------------------ 4. acompanhamento público
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
  v_recebido boolean;
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

  -- Pedido que nasceu finalizado (sem completed_at) aparece ao cliente como recebido.
  v_recebido := v_order.status = 'completed' and v_order.completed_at is null;

  v_status_publico := case
    when v_order.status = 'cancelled' then 'cancelado'
    when v_order.status = 'requested' and v_order.payment_status = 'pending' then 'aguardando_pagamento'
    when v_order.status = 'requested' or v_recebido then 'solicitado'
    when v_order.status = 'preparing' then 'em_preparo'
    when v_order.status = 'ready' then 'pronto'
    when v_order.status = 'completed' then 'finalizado'
    else v_order.status
  end;

  -- Previsão só faz sentido enquanto o pedido não terminou de fato nem foi cancelado.
  if v_order.status not in ('completed', 'cancelled') or v_recebido then
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

-- ------------------------------------------------------------------ 5. o que estiver em aberto agora
update public.orders
   set payment_status = 'paid', payment_confirmed_at = coalesce(payment_confirmed_at, now())
 where payment_status = 'pending' and status <> 'cancelled';

update public.orders
   set status = 'completed'
 where status in ('requested', 'preparing', 'ready');
