-- L2.5I — RPC transacional de fulfilment/endereço pro motor
-- conversacional do WhatsApp (apply_whatsapp_fulfilment_intent),
-- projetada e implementada no W4.3, seguindo o mesmo padrão de
-- apply_whatsapp_cart_intent (20260824180000).
--
-- Intents: set_fulfilment_type (collection|delivery), set_address (só
-- delivery), set_delivery_instructions (só delivery), get_fulfilment
-- (leitura). Qualquer outro valor de p_intent é rejeitado.
--
-- Estratégia de state (justificada no relatório desta migration):
-- collection avança pra collecting_payment só se o carrinho não estiver
-- vazio (senão permanece em collecting_fulfilment); delivery sempre para
-- em collecting_address e nunca avança sozinho pra collecting_payment —
-- isso depende de delivery_quote_id válido, que só o W4.4 (cálculo de
-- entrega) vai saber prover.
--
-- delivery_quote_id é sempre zerado (NULL) ao trocar fulfilment_type pra
-- delivery e a cada alteração de endereço — cotação antiga nunca
-- sobrevive a uma mudança que poderia invalidá-la (mesmo que o W4.4,
-- responsável por calcular cotação de verdade, ainda não exista).
-- Trocar de delivery pra collection limpa todos os campos de endereço —
-- nunca fica endereço órfão de uma escolha anterior.
--
-- set_address nunca aceita delivery_fee/distance/quote_id do chamador —
-- só eircode/address_line_1 (obrigatórios)/address_line_2/area
-- (opcionais). Mesma disciplina de create_customer_order/
-- apply_whatsapp_cart_intent: nunca confia em valor calculado vindo de
-- fora.
--
-- Concorrência/segurança: mesmo padrão de apply_whatsapp_cart_intent —
-- SELECT ... FOR UPDATE uniforme (inclusive get_fulfilment, mesma
-- razão de leitura consistente já documentada lá); state='closed'
-- bloqueia tudo (inclusive leitura, mesma assimetria já registrada e
-- mantida por consistência); human_handoff=true bloqueia só mutação,
-- get_fulfilment continua funcionando; SECURITY DEFINER + search_path
-- vazio; REVOKE ALL de PUBLIC/anon/authenticated, sem GRANT a
-- service_role (mesma evidência de 20260824160000).
--
-- NÃO altera whatsapp_messages, products, combo_*, orders,
-- create_customer_order, delivery_quotes, apply_whatsapp_cart_intent,
-- get_whatsapp_menu. NÃO calcula entrega, NÃO chama calculate-delivery,
-- NÃO cria pedido, NÃO trata cupom/pagamento, NÃO integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.apply_whatsapp_fulfilment_intent(
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
  v_session         public.whatsapp_sessions%rowtype;
  v_changed         boolean := false;
  v_fulfilment_type text;
  v_eircode         text;
  v_address_line_1  text;
  v_address_line_2  text;
  v_area            text;
  v_instructions    text;
begin

  if p_intent not in ('set_fulfilment_type', 'set_address', 'set_delivery_instructions', 'get_fulfilment') then
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
    raise exception 'Sessão encerrada — não é possível alterar fulfilment';
  end if;

  if v_session.human_handoff and p_intent <> 'get_fulfilment' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'fulfilment_type', v_session.fulfilment_type,
      'eircode', v_session.eircode,
      'address_line_1', v_session.address_line_1,
      'address_line_2', v_session.address_line_2,
      'area', v_session.area,
      'delivery_instructions', v_session.delivery_instructions,
      'delivery_quote_id', v_session.delivery_quote_id,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'get_fulfilment' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'fulfilment_type', v_session.fulfilment_type,
      'eircode', v_session.eircode,
      'address_line_1', v_session.address_line_1,
      'address_line_2', v_session.address_line_2,
      'area', v_session.area,
      'delivery_instructions', v_session.delivery_instructions,
      'delivery_quote_id', v_session.delivery_quote_id,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'set_fulfilment_type' then

    v_fulfilment_type := nullif(trim(p_payload->>'fulfilment_type'), '');

    if v_fulfilment_type is null or v_fulfilment_type not in ('collection', 'delivery') then
      raise exception 'fulfilment_type deve ser collection ou delivery';
    end if;

    if v_fulfilment_type = 'collection' then

      update public.whatsapp_sessions
      set fulfilment_type = 'collection',
          eircode = null,
          address_line_1 = null,
          address_line_2 = null,
          area = null,
          delivery_instructions = null,
          delivery_quote_id = null,
          state = case
            when jsonb_array_length(cart) > 0 then 'collecting_payment'
            else 'collecting_fulfilment'
          end,
          updated_at = now()
      where id = p_session_id
      returning * into v_session;

    else

      update public.whatsapp_sessions
      set fulfilment_type = 'delivery',
          delivery_quote_id = null,
          state = 'collecting_address',
          updated_at = now()
      where id = p_session_id
      returning * into v_session;

    end if;

    v_changed := true;

  elsif p_intent = 'set_address' then

    if v_session.fulfilment_type is distinct from 'delivery' then
      raise exception 'set_address só é permitido com fulfilment_type=delivery';
    end if;

    v_eircode := nullif(trim(p_payload->>'eircode'), '');
    v_address_line_1 := nullif(trim(p_payload->>'address_line_1'), '');
    v_address_line_2 := nullif(trim(p_payload->>'address_line_2'), '');
    v_area := nullif(trim(p_payload->>'area'), '');

    if v_eircode is null then
      raise exception 'eircode é obrigatório';
    end if;

    if v_address_line_1 is null then
      raise exception 'address_line_1 é obrigatório';
    end if;

    update public.whatsapp_sessions
    set eircode = v_eircode,
        address_line_1 = v_address_line_1,
        address_line_2 = v_address_line_2,
        area = v_area,
        delivery_quote_id = null,
        state = 'collecting_address',
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'set_delivery_instructions' then

    if v_session.fulfilment_type is distinct from 'delivery' then
      raise exception 'set_delivery_instructions só é permitido com fulfilment_type=delivery';
    end if;

    v_instructions := nullif(trim(p_payload->>'instructions'), '');

    update public.whatsapp_sessions
    set delivery_instructions = v_instructions,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  end if;

  return jsonb_build_object(
    'session_id', v_session.id,
    'state', v_session.state,
    'fulfilment_type', v_session.fulfilment_type,
    'eircode', v_session.eircode,
    'address_line_1', v_session.address_line_1,
    'address_line_2', v_session.address_line_2,
    'area', v_session.area,
    'delivery_instructions', v_session.delivery_instructions,
    'delivery_quote_id', v_session.delivery_quote_id,
    'human_handoff', v_session.human_handoff,
    'changed', v_changed
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_fulfilment_intent(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_fulfilment_intent(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_fulfilment_intent(uuid, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
