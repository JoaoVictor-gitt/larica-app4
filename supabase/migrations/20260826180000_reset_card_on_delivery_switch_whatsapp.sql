-- Consistência da regra "cartão indisponível para entrega" (W-tracking,
-- Parte B) no motor conversacional do WhatsApp. CREATE OR REPLACE de
-- apply_whatsapp_fulfilment_intent — corpo idêntico ao definido em
-- 20260824190000_add_apply_whatsapp_fulfilment_intent_rpc.sql (migration
-- histórica NÃO editada), com 1 delta: no UPDATE do ramo 'delivery' de
-- set_fulfilment_type, se a sessão já tinha payment_method='card'
-- selecionado (de uma escolha anterior de collection), ele é zerado —
-- nunca deixa fulfilment_type='delivery' + payment_method='card'
-- persistido acidentalmente (mesmo espírito de "nunca deixar dado órfão
-- de uma escolha anterior" já documentado nesta função pra
-- delivery_quote_id/endereço). cash/revolut/bank_transfer não são
-- afetados — só 'card' é zerado. Nenhuma outra linha alterada — mesmos
-- REVOKE ALL de PUBLIC/anon/authenticated, sem GRANT a service_role.

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
          -- Cartão não funciona pra entrega (sem maquininha) — uma escolha
          -- anterior de payment_method='card' (feita quando a sessão ainda
          -- era collection) nunca sobrevive à troca pra delivery. Só 'card'
          -- é zerado; cash/revolut/bank_transfer continuam válidos.
          payment_method = case when payment_method = 'card' then null else payment_method end,
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
