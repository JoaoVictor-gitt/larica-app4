-- Helpers de completude/prévia + RPC de revisão pro motor
-- conversacional do WhatsApp, parte do W4.5 — fecha o funil
-- collecting_payment → reviewing_order → awaiting_confirmation.
--
-- whatsapp_session_ready_for_review(session_id): só LEITURA (nenhum
-- FOR UPDATE próprio — sempre chamada de dentro de uma transação que
-- já travou a linha via FOR UPDATE em apply_whatsapp_review_intent,
-- não trava de novo). Retorna {ready, missing[]}: cart não vazio,
-- fulfilment_type definido, se delivery — endereço completo E
-- delivery_quote_id não nulo E ainda não expirado (expires_at > now(),
-- mesma checagem de set_whatsapp_delivery_quote/W4.4B) —, payment_method
-- definido, e se cash+needs_change — cash_amount presente. Cupom NUNCA
-- é pré-requisito (é opcional).
--
-- build_whatsapp_order_preview(session_id): monta a prévia pra
-- apresentação — itens com nome/quantidade/preço atual (via products,
-- nunca do cart armazenado), subtotal, delivery_fee/distance da
-- cotação viva, cupom revalidado (validate_coupon com try/catch local:
-- se o cupom não for mais válido no momento da prévia — ex: expirou
-- entre duas mensagens — a prévia simplesmente reporta
-- coupon_valid:false e desconto 0, em vez de quebrar a revisão
-- inteira por causa de um cupom velho), total estimado. TODOS os
-- valores monetários são recalculados aqui a partir de products/
-- delivery_quotes/validate_coupon — nunca lidos de nenhum campo
-- armazenado na sessão. Marcados conceitualmente como preview:
-- create_customer_order continua sendo quem recalcula tudo de novo e
-- decide de verdade — nada disso é persistido na sessão.
--
-- apply_whatsapp_review_intent intents: get_review, confirm_review.
--
-- get_review: SEMPRE funciona (inclusive human_handoff — é a única
-- variante de leitura real de todo o fluxo de revisão, mesmo padrão
-- get_cart/get_fulfilment/get_payment/get_coupon). Se a completude
-- falhar, retorna ready:false + missing[] sem lançar exceção (o motor
-- decide o que perguntar a seguir). Se passar, é o ÚNICO lugar do
-- sistema que PROMOVE o estado: collecting_payment → reviewing_order
-- (idempotente — chamar de novo com reviewing_order/awaiting_confirmation
-- não regride nada, só recalcula a prévia).
--
-- confirm_review: exige state='reviewing_order' (chamar com
-- awaiting_confirmation já é no-op idempotente — changed:false, devolve
-- a prévia de novo; chamar de qualquer outro estado é erro — precisa
-- passar por get_review primeiro). Revalida a completude DE NOVO na
-- hora (protege contra uma cotação que expirou ou um item que ficou
-- indisponível entre o get_review e a confirmação) — só promove pra
-- awaiting_confirmation se ainda estiver tudo certo; senão devolve
-- ready:false sem lançar exceção nem avançar, igual get_review.
-- human_handoff aqui É bloqueado com exceção (raise exception) — só
-- confirm_review não tem variante "sem efeito" que faça sentido (é
-- puramente uma promoção de estado, sem alternativa de leitura), mesmo
-- raciocínio já documentado em set_whatsapp_delivery_quote (W4.4).
-- state='closed' bloqueia os dois intents, como em toda RPC da família.
--
-- NÃO cria pedido — awaiting_confirmation é só o estado que sinaliza
-- "cliente confirmou a prévia", a RPC de criação de pedido de fato
-- (create_order_from_whatsapp_session ou equivalente) é etapa futura,
-- fora do escopo do W4.5.
--
-- NÃO altera whatsapp_messages, products, orders, create_customer_order,
-- validate_coupon, delivery_quotes, apply_whatsapp_cart_intent,
-- apply_whatsapp_fulfilment_intent, apply_whatsapp_payment_intent,
-- apply_whatsapp_coupon_intent, set_whatsapp_delivery_quote. NÃO
-- integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.whatsapp_session_ready_for_review(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session  public.whatsapp_sessions%rowtype;
  v_missing  text[] := '{}';
  v_quote_ok boolean;
begin

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  if jsonb_array_length(v_session.cart) = 0 then
    v_missing := array_append(v_missing, 'cart_empty');
  end if;

  if v_session.fulfilment_type is null then
    v_missing := array_append(v_missing, 'fulfilment_type');
  elsif v_session.fulfilment_type = 'delivery' then

    if coalesce(trim(v_session.eircode), '') = ''
       or coalesce(trim(v_session.address_line_1), '') = '' then
      v_missing := array_append(v_missing, 'address');
    end if;

    if v_session.delivery_quote_id is null then
      v_missing := array_append(v_missing, 'delivery_quote');
    else
      select exists(
        select 1 from public.delivery_quotes
        where id = v_session.delivery_quote_id
          and expires_at > now()
      ) into v_quote_ok;

      if not v_quote_ok then
        v_missing := array_append(v_missing, 'delivery_quote_expired');
      end if;
    end if;

  end if;

  if v_session.payment_method is null then
    v_missing := array_append(v_missing, 'payment_method');
  elsif v_session.payment_method = 'cash'
        and v_session.needs_change
        and v_session.cash_amount is null then
    v_missing := array_append(v_missing, 'cash_amount');
  end if;

  return jsonb_build_object(
    'ready', array_length(v_missing, 1) is null,
    'missing', to_jsonb(v_missing)
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.whatsapp_session_ready_for_review(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.whatsapp_session_ready_for_review(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.whatsapp_session_ready_for_review(uuid) FROM authenticated;


CREATE OR REPLACE FUNCTION public.build_whatsapp_order_preview(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session        public.whatsapp_sessions%rowtype;
  v_items          jsonb := '[]'::jsonb;
  v_item           jsonb;
  v_qty            integer;
  v_product        record;
  v_line_total     numeric;
  v_subtotal       numeric := 0;
  v_coupon_result  jsonb;
  v_coupon_valid   boolean := null;
  v_discount_amount numeric := 0;
  v_quote          record;
  v_delivery_fee   numeric := null;
  v_delivery_km    numeric := null;
  v_total          numeric;
begin

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  for v_item in select * from jsonb_array_elements(v_session.cart) loop

    v_qty := nullif(v_item->>'quantity', '')::integer;

    select id, name, price into v_product
    from public.products
    where id = (v_item->>'product_id')::uuid;

    if v_product.id is null or v_qty is null then
      continue;
    end if;

    v_line_total := v_product.price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'name', v_product.name,
      'quantity', v_qty,
      'unit_price', v_product.price,
      'line_total', v_line_total
    ));

  end loop;

  if v_session.coupon_code is not null then
    begin
      v_coupon_result := public.validate_coupon(v_session.coupon_code, v_subtotal);
      v_coupon_valid := true;
      v_discount_amount := coalesce((v_coupon_result->>'discount_amount')::numeric, 0);
    exception when others then
      v_coupon_valid := false;
      v_discount_amount := 0;
    end;
  end if;

  if v_session.fulfilment_type = 'delivery' and v_session.delivery_quote_id is not null then

    select distance_km, delivery_fee into v_quote
    from public.delivery_quotes
    where id = v_session.delivery_quote_id
      and expires_at > now();

    if found then
      v_delivery_fee := v_quote.delivery_fee;
      v_delivery_km := v_quote.distance_km;
    end if;

  end if;

  v_total := greatest(0, v_subtotal - v_discount_amount) + coalesce(v_delivery_fee, 0);

  return jsonb_build_object(
    'items', v_items,
    'subtotal', v_subtotal,
    'fulfilment_type', v_session.fulfilment_type,
    'eircode', v_session.eircode,
    'address_line_1', v_session.address_line_1,
    'address_line_2', v_session.address_line_2,
    'area', v_session.area,
    'delivery_instructions', v_session.delivery_instructions,
    'delivery_fee', v_delivery_fee,
    'delivery_distance_km', v_delivery_km,
    'payment_method', v_session.payment_method,
    'needs_change', v_session.needs_change,
    'cash_amount', v_session.cash_amount,
    'coupon_code', v_session.coupon_code,
    'coupon_valid', v_coupon_valid,
    'discount_amount', v_discount_amount,
    'total', v_total
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.build_whatsapp_order_preview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_whatsapp_order_preview(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.build_whatsapp_order_preview(uuid) FROM authenticated;


CREATE OR REPLACE FUNCTION public.apply_whatsapp_review_intent(
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
  v_session   public.whatsapp_sessions%rowtype;
  v_readiness jsonb;
  v_preview   jsonb;
  v_changed   boolean := false;
begin

  if p_intent not in ('get_review', 'confirm_review') then
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
    raise exception 'Sessão encerrada — não é possível revisar o pedido';
  end if;

  if p_intent = 'get_review' then

    v_readiness := public.whatsapp_session_ready_for_review(p_session_id);

    if not (v_readiness->>'ready')::boolean then
      return jsonb_build_object(
        'session_id', v_session.id,
        'state', v_session.state,
        'ready', false,
        'missing', v_readiness->'missing',
        'human_handoff', v_session.human_handoff,
        'changed', false
      );
    end if;

    if v_session.state not in ('reviewing_order', 'awaiting_confirmation') then
      update public.whatsapp_sessions
      set state = 'reviewing_order',
          updated_at = now()
      where id = p_session_id
      returning * into v_session;
      v_changed := true;
    end if;

    v_preview := public.build_whatsapp_order_preview(p_session_id);

    return v_preview || jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'ready', true,
      'human_handoff', v_session.human_handoff,
      'changed', v_changed
    );

  end if;

  -- confirm_review

  if v_session.human_handoff then
    raise exception 'Sessão em atendimento humano — não é possível confirmar o pedido';
  end if;

  if v_session.state = 'awaiting_confirmation' then
    v_preview := public.build_whatsapp_order_preview(p_session_id);
    return v_preview || jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'ready', true,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if v_session.state <> 'reviewing_order' then
    raise exception 'Revisão ainda não realizada — chame get_review primeiro';
  end if;

  v_readiness := public.whatsapp_session_ready_for_review(p_session_id);

  if not (v_readiness->>'ready')::boolean then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'ready', false,
      'missing', v_readiness->'missing',
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  update public.whatsapp_sessions
  set state = 'awaiting_confirmation',
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  v_preview := public.build_whatsapp_order_preview(p_session_id);

  return v_preview || jsonb_build_object(
    'session_id', v_session.id,
    'state', v_session.state,
    'ready', true,
    'human_handoff', v_session.human_handoff,
    'changed', true
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_review_intent(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_review_intent(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_review_intent(uuid, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
