-- Migration corretiva de apply_whatsapp_cart_intent (já aplicada
-- remotamente em 20260824180000/W4.2, por isso precisa de CREATE OR
-- REPLACE numa migration nova em vez de edição in loco — diferente de
-- W4.4B, que ainda não tinha sido executada).
--
-- Achado da auditoria do W4.5 (seção 9 da spec): apply_whatsapp_fulfilment_intent
-- já rebaixa o estado incondicionalmente em toda mutação (set_fulfilment_type/
-- set_address sempre forçam collecting_address/collecting_payment), mas
-- apply_whatsapp_cart_intent NÃO fazia isso — add_item só mudava o
-- estado se já estivesse em greeting/browsing_menu, remove_item nunca
-- tocava o estado, clear_cart só tratava building_cart→browsing_menu.
-- Isso significava que adicionar/remover item com a sessão em
-- reviewing_order ou awaiting_confirmation deixava esses estados
-- intactos — violando a exigência explícita de "qualquer alteração
-- depois de awaiting_confirmation exige nova revisão antes de
-- confirmar" (W4.5, seção 9).
--
-- Único ajuste: as 3 expressões de estado de add_item/remove_item/
-- clear_cart ganham a mesma regra de invalidação já usada em
-- apply_whatsapp_payment_intent/apply_whatsapp_coupon_intent (W4.5,
-- migrations B/C) — se o estado ANTES da mutação era reviewing_order
-- ou awaiting_confirmation, o novo estado vira collecting_payment
-- (forçando o cliente a passar de novo por apply_whatsapp_review_intent
-- antes de conseguir confirmar). remove_item ganha uma expressão de
-- estado que antes não existia (só cart + updated_at). Todo o resto do
-- corpo — validação de product_id/quantity, merge de duplicado,
-- cart_index 1-based, FOR UPDATE, human_handoff, state='closed',
-- formato do retorno, SECURITY DEFINER, search_path, REVOKEs — é
-- idêntico, char a char, ao já aplicado em 20260824180000 (W4.2B).
--
-- NÃO altera whatsapp_messages, products, orders, create_customer_order,
-- apply_whatsapp_fulfilment_intent, apply_whatsapp_payment_intent,
-- apply_whatsapp_coupon_intent, apply_whatsapp_review_intent,
-- set_whatsapp_delivery_quote, get_whatsapp_menu, worker/index.ts.

CREATE OR REPLACE FUNCTION public.apply_whatsapp_cart_intent(
  p_session_id uuid,
  p_intent     text,
  p_payload    jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session    public.whatsapp_sessions%rowtype;
  v_changed    boolean := false;
  v_product_id uuid;
  v_quantity   integer;
  v_quantity_texto text;
  v_cart_index integer;
  v_product    record;
  v_novo_cart  jsonb;
  v_encontrado boolean;
  v_i          integer;
  v_item       jsonb;
begin

  if p_intent not in ('add_item', 'remove_item', 'clear_cart', 'get_cart') then
    raise exception 'Intent não suportada: %', p_intent;
  end if;

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  if v_session.state = 'closed' then
    raise exception 'Sessão encerrada — não é possível alterar o carrinho';
  end if;

  if v_session.human_handoff and p_intent <> 'get_cart' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'cart', v_session.cart,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'get_cart' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'cart', v_session.cart,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'add_item' then

    v_product_id := nullif(p_payload->>'product_id', '')::uuid;

    if v_product_id is null then
      raise exception 'product_id é obrigatório';
    end if;

    v_quantity_texto := nullif(trim(p_payload->>'quantity'), '');

    if v_quantity_texto is null or v_quantity_texto !~ '^[0-9]+$' then
      raise exception 'quantity deve ser um número inteiro maior ou igual a 1';
    end if;

    v_quantity := v_quantity_texto::integer;

    if v_quantity < 1 then
      raise exception 'quantity deve ser maior ou igual a 1';
    end if;

    select id, name, category, active, is_available
    into v_product
    from public.products
    where id = v_product_id;

    if v_product.id is null or v_product.active is not true then
      raise exception 'Produto indisponível: %', v_product_id;
    end if;

    if v_product.category = 'combos' then
      raise exception 'Combos ainda não são suportados nesta etapa: %', v_product.name;
    end if;

    if v_product.is_available is not true then
      raise exception 'Produto indisponível no momento: %', v_product.name;
    end if;

    v_encontrado := false;
    v_novo_cart := '[]'::jsonb;

    for v_i in 0 .. jsonb_array_length(v_session.cart) - 1 loop
      v_item := v_session.cart -> v_i;

      if v_item->>'item_type' = 'product'
         and (v_item->>'product_id')::uuid = v_product_id then
        v_novo_cart := v_novo_cart || jsonb_build_array(
          jsonb_set(v_item, '{quantity}', to_jsonb((v_item->>'quantity')::integer + v_quantity))
        );
        v_encontrado := true;
      else
        v_novo_cart := v_novo_cart || jsonb_build_array(v_item);
      end if;
    end loop;

    if not v_encontrado then
      v_novo_cart := v_novo_cart || jsonb_build_array(
        jsonb_build_object(
          'item_type', 'product',
          'product_id', v_product_id,
          'quantity', v_quantity
        )
      );
    end if;

    update public.whatsapp_sessions
    set cart = v_novo_cart,
        state = case
          when state in ('greeting', 'browsing_menu') then 'building_cart'
          when state in ('reviewing_order', 'awaiting_confirmation') then 'collecting_payment'
          else state
        end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'remove_item' then

    v_cart_index := nullif(p_payload->>'cart_index', '')::integer;

    if v_cart_index is null
       or v_cart_index < 1
       or v_cart_index > jsonb_array_length(v_session.cart) then
      raise exception 'Índice de carrinho inválido: %', p_payload->>'cart_index';
    end if;

    update public.whatsapp_sessions
    set cart = v_session.cart - (v_cart_index - 1),
        state = case
          when state in ('reviewing_order', 'awaiting_confirmation') then 'collecting_payment'
          else state
        end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'clear_cart' then

    update public.whatsapp_sessions
    set cart = '[]'::jsonb,
        state = case
          when state = 'building_cart' then 'browsing_menu'
          when state in ('reviewing_order', 'awaiting_confirmation') then 'collecting_payment'
          else state
        end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  end if;

  return jsonb_build_object(
    'session_id', v_session.id,
    'state', v_session.state,
    'cart', v_session.cart,
    'human_handoff', v_session.human_handoff,
    'changed', v_changed
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_cart_intent(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_cart_intent(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_cart_intent(uuid, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
