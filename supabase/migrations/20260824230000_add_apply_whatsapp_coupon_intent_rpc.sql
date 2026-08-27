-- Helper de subtotal + RPC transacional de cupom pro motor
-- conversacional do WhatsApp, parte do W4.5.
--
-- calculate_whatsapp_cart_subtotal(cart) resolve o problema levantado
-- na auditoria: validate_coupon exige p_subtotal, mas o motor não pode
-- virar fonte de verdade de preço. A função busca o preço ATUAL de
-- cada product_id direto de products (nunca confia em nada vindo de
-- fora) e soma price*quantity — mesma fórmula de linha simples já
-- usada por create_customer_order (produtos sem combo, único formato
-- que o cart do WhatsApp aceita hoje — apply_whatsapp_cart_intent
-- rejeita combos, W4.2). Produto removido/desativado desde que entrou
-- no carrinho é silenciosamente ignorado no somatório (mesmo critério
-- do preview em build_whatsapp_order_preview, migration D) — é só uma
-- estimativa pra feedback imediato de cupom, create_customer_order
-- revalida tudo de novo e é quem decide de verdade.
--
-- apply_whatsapp_coupon_intent intents: apply_coupon, remove_coupon,
-- get_coupon. A sessão armazena só coupon_code (texto) — nunca
-- discount_amount/discount_type calculado (repetido explicitamente na
-- spec). apply_coupon chama validate_coupon com o subtotal calculado
-- acima; se o cupom for inválido, validate_coupon já dá RAISE
-- EXCEPTION, que propaga normalmente (nada foi gravado ainda) — a
-- sessão nunca fica com um coupon_code inválido salvo.
--
-- Estado: mesma regra de invalidação de apply_whatsapp_payment_intent
-- (migration B) — mutação bem-sucedida rebaixa reviewing_order/
-- awaiting_confirmation pra collecting_payment; só get_review promove.
--
-- Concorrência/segurança: FOR UPDATE uniforme; state='closed' bloqueia
-- tudo; human_handoff bloqueia só mutação (get_coupon funciona);
-- SECURITY DEFINER + search_path vazio; REVOKE ALL de
-- PUBLIC/anon/authenticated, sem GRANT a service_role.
--
-- NÃO altera whatsapp_messages, products, orders, create_customer_order,
-- validate_coupon, coupons, apply_whatsapp_cart_intent,
-- apply_whatsapp_fulfilment_intent, apply_whatsapp_payment_intent,
-- set_whatsapp_delivery_quote. NÃO cria pedido, NÃO integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.calculate_whatsapp_cart_subtotal(p_cart jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_item      jsonb;
  v_qty       integer;
  v_price     numeric;
  v_subtotal  numeric := 0;
begin

  for v_item in select * from jsonb_array_elements(p_cart) loop

    v_qty := nullif(v_item->>'quantity', '')::integer;

    select price into v_price
    from public.products
    where id = (v_item->>'product_id')::uuid;

    if v_price is not null and v_qty is not null then
      v_subtotal := v_subtotal + (v_price * v_qty);
    end if;

  end loop;

  return v_subtotal;

end;
$function$;

REVOKE ALL ON FUNCTION public.calculate_whatsapp_cart_subtotal(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_whatsapp_cart_subtotal(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_whatsapp_cart_subtotal(jsonb) FROM authenticated;


CREATE OR REPLACE FUNCTION public.apply_whatsapp_coupon_intent(
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
  v_session       public.whatsapp_sessions%rowtype;
  v_changed       boolean := false;
  v_code          text;
  v_subtotal      numeric;
  v_coupon_result jsonb;
begin

  if p_intent not in ('apply_coupon', 'remove_coupon', 'get_coupon') then
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
    raise exception 'Sessão encerrada — não é possível alterar cupom';
  end if;

  if v_session.human_handoff and p_intent <> 'get_coupon' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'coupon_code', v_session.coupon_code,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'get_coupon' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'coupon_code', v_session.coupon_code,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'apply_coupon' then

    v_code := nullif(upper(trim(p_payload->>'coupon_code')), '');

    if v_code is null then
      raise exception 'coupon_code é obrigatório';
    end if;

    v_subtotal := public.calculate_whatsapp_cart_subtotal(v_session.cart);

    -- Propaga a exceção de validate_coupon sem capturar: cupom
    -- inválido/expirado/abaixo do mínimo nunca chega a ser gravado.
    v_coupon_result := public.validate_coupon(v_code, v_subtotal);

    update public.whatsapp_sessions
    set coupon_code = v_code,
        state = case
          when state in ('reviewing_order', 'awaiting_confirmation') then 'collecting_payment'
          else state
        end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'coupon_code', v_session.coupon_code,
      'discount_type', v_coupon_result->>'discount_type',
      'discount_amount', (v_coupon_result->>'discount_amount')::numeric,
      'subtotal_used', v_subtotal,
      'human_handoff', v_session.human_handoff,
      'changed', v_changed
    );

  elsif p_intent = 'remove_coupon' then

    update public.whatsapp_sessions
    set coupon_code = null,
        state = case
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
    'coupon_code', v_session.coupon_code,
    'human_handoff', v_session.human_handoff,
    'changed', v_changed
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_coupon_intent(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_coupon_intent(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_coupon_intent(uuid, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
