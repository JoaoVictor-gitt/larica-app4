-- L2.3D.2B — Baseline das RPCs administrativas já existentes no banco vivo.
--
-- Estas 8 funções já existem e já estão em uso no banco de produção, mas
-- não tinham nenhum CREATE FUNCTION rastreado nas migrations locais
-- (confirmado na auditoria L2.3D.2A). Esta migration só VERSIONA as
-- definições atuais — capturadas via pg_get_functiondef e preservadas em
-- tmp/pg_get_functiondef_9_rpcs_banco_vivo.txt — sem alterar nenhuma
-- lógica, mensagem, validação ou assinatura.
--
-- create_customer_order fica de fora desta migration: L2.3D.2A já
-- confirmou (comparação linha a linha) que sua versão atual é idêntica à
-- já versionada em 20260817140000_add_product_costs_and_snapshot.sql.
--
-- Nenhum GRANT/REVOKE é alterado aqui — os privilégios atuais já são
-- tratados pelas migrations de hardening 20260822090000 em diante.

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and p.role = 'admin'
  );
$function$;


CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active = true
      and role in ('admin', 'employee')
  );
$function$;


CREATE OR REPLACE FUNCTION public.has_permission(p_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active = true
      and (
        (
          p.role = 'admin'
          and p_permission = any (array[
            'dashboard.view',
            'orders.view',
            'orders.manage',
            'products.view',
            'products.manage',
            'stock.view',
            'stock.manage',
            'history.view',
            'settings.manage',
            'users.manage'
          ])
        )
        or (
          p.role = 'employee'
          and exists (
            select 1 from public.user_permissions up
            where up.user_id = p.id and up.permission = p_permission
          )
        )
      )
  );
$function$;


CREATE OR REPLACE FUNCTION public.validate_coupon(p_code text, p_subtotal numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_code text := nullif(upper(trim(p_code)), '');
  v_coupon record;
  v_discount_amount numeric;
begin

  if v_code is null then
    raise exception 'Informe um código de cupom.';
  end if;

  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'Subtotal inválido.';
  end if;

  select *
  into v_coupon
  from public.coupons
  where code = v_code;

  if v_coupon.id is null then
    raise exception 'Cupom não encontrado.';
  end if;

  if not v_coupon.active then
    raise exception 'Este cupom está inativo.';
  end if;

  if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
    raise exception 'Este cupom ainda não é válido.';
  end if;

  if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
    raise exception 'Este cupom expirou.';
  end if;

  if v_coupon.minimum_order_value is not null and p_subtotal < v_coupon.minimum_order_value then
    raise exception 'Pedido mínimo de €% para este cupom.', v_coupon.minimum_order_value;
  end if;

  if v_coupon.discount_type = 'percentage' then
    v_discount_amount := least(round(p_subtotal * v_coupon.discount_value / 100, 2), p_subtotal);
  else
    v_discount_amount := least(v_coupon.discount_value, p_subtotal);
  end if;

  return jsonb_build_object(
    'valid', true,
    'coupon_id', v_coupon.id,
    'code', v_coupon.code,
    'discount_type', v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'discount_amount', v_discount_amount
  );

end;
$function$;


CREATE OR REPLACE FUNCTION public.adjust_stock(p_product_id uuid, p_quantity_change integer, p_reason text DEFAULT NULL::text)
 RETURNS products
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_previous integer;
  v_new integer;
  v_product public.products;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  if p_quantity_change = 0 then
    raise exception 'Quantidade de ajuste não pode ser zero';
  end if;

  update public.products
     set stock_quantity = stock_quantity + p_quantity_change,
         updated_at = now()
   where id = p_product_id
     and stock_quantity + p_quantity_change >= 0
  returning stock_quantity into v_new;

  if not found then
    if exists (select 1 from public.products where id = p_product_id) then
      raise exception 'Estoque insuficiente para essa remoção';
    else
      raise exception 'Produto não encontrado';
    end if;
  end if;

  v_previous := v_new - p_quantity_change;

  insert into public.stock_movements
    (product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity, reason, created_by)
  values
    (p_product_id, null, case when p_quantity_change > 0 then 'manual_addition' else 'manual_removal' end,
     p_quantity_change, v_previous, v_new, p_reason, auth.uid());

  select * into v_product from public.products where id = p_product_id;
  return v_product;
end;
$function$;


CREATE OR REPLACE FUNCTION public.confirm_order_payment(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders;
begin

  if not public.is_staff() then
    raise exception 'Apenas a equipe pode confirmar pagamentos.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'Pedido não encontrado.';
  end if;

  if v_order.payment_method <> 'revolut' then
    raise exception 'Este pedido não usa confirmação manual de pagamento.';
  end if;

  if v_order.payment_status <> 'pending' then
    raise exception 'Pagamento deste pedido já foi processado.';
  end if;

  if v_order.status <> 'requested' then
    raise exception 'Pedido não está mais aguardando confirmação.';
  end if;

  update public.orders
  set payment_status = 'paid',
      payment_confirmed_at = now(),
      payment_confirmed_by = auth.uid()
  where id = p_order_id;

  select * into v_order from public.orders where id = p_order_id;

  return v_order;

end;
$function$;


CREATE OR REPLACE FUNCTION public.update_order_status(p_order_id uuid, p_new_status text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare

  v_order public.orders;
  v_expected text;

begin

  -- Somente funcionário ativo.

  if not public.is_staff() then
    raise exception 'Usuário sem permissão';
  end if;


  select *
  into v_order

  from public.orders

  where id = p_order_id
  for update;


  if v_order.id is null then
    raise exception 'Pedido não encontrado';
  end if;


  -- Máquina de estados

  case p_new_status

    when 'preparing' then
      v_expected := 'requested';

    when 'ready' then
      v_expected := 'preparing';

    when 'completed' then
      v_expected := 'ready';

    else
      raise exception
        'Status inválido: %',
        p_new_status;

  end case;


  if v_order.status <> v_expected then

    raise exception
      'Não é possível mudar o pedido #LARICA-% de "%" diretamente para "%"',
      v_order.order_number,
      v_order.status,
      p_new_status;

  end if;


  if p_new_status = 'preparing' then

    update public.orders
    set
      status = 'preparing',
      accepted_at = now()

    where id = p_order_id;


  elsif p_new_status = 'ready' then

    update public.orders
    set
      status = 'ready',
      ready_at = now()

    where id = p_order_id;


  elsif p_new_status = 'completed' then

    update public.orders
    set
      status = 'completed',
      completed_at = now()

    where id = p_order_id;

  end if;


  select *
  into v_order

  from public.orders
  where id = p_order_id;


  return v_order;

end;
$function$;


CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- pedido estornem o estoque duas vezes, e (junto do FOR UPDATE acrescentado
  -- em update_order_status) impede que uma transição em andamento sobrescreva
  -- um cancelamento já commitado.
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
