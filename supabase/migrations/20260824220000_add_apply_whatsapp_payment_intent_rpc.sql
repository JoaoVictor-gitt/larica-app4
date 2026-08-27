-- RPC transacional de forma de pagamento pro motor conversacional do
-- WhatsApp (apply_whatsapp_payment_intent), parte do W4.5, seguindo o
-- mesmo padrão de apply_whatsapp_cart_intent/apply_whatsapp_fulfilment_intent.
--
-- Intents: set_payment_method, set_cash_change, get_payment. Métodos
-- aceitos: card, cash, revolut, bank_transfer — mesma whitelist de
-- create_customer_order — mas checando também business_settings
-- (revolut_enabled+revolut_qr_path pra revolut; bank_transfer_enabled+
-- beneficiary/iban/bic pra bank_transfer), mesmo critério de
-- revolutDisponivel()/transferenciaDisponivel() (js/pedido.js) —
-- nunca oferece/aceita um método que o negócio desativou.
--
-- set_payment_method sempre zera needs_change/cash_amount (mesma
-- disciplina de "nunca deixar dado órfão de uma escolha anterior" já
-- usada em delivery_quote_id ao trocar endereço/fulfilment) — troco
-- sempre precisa ser informado de novo via set_cash_change depois de
-- qualquer troca de método, mesmo re-selecionando cash.
--
-- set_cash_change só é permitido com payment_method='cash' já
-- gravado. needs_change=false força cash_amount=null. needs_change=true
-- exige cash_amount numérico > 0, validado por regex ANTES do cast
-- (mesma técnica de apply_whatsapp_cart_intent/quantity — nunca
-- trunca/estoura erro bruto de cast). NUNCA compara cash_amount com
-- total/subtotal do pedido aqui — o motor ainda não é autoridade de
-- total; create_customer_order faz essa validação final sozinho.
--
-- Estado: esta RPC só REBAIXA (nunca promove) — se a mutação mudou
-- algo e o estado anterior era reviewing_order/awaiting_confirmation,
-- vira collecting_payment. A promoção collecting_payment→reviewing_order
-- é responsabilidade exclusiva de apply_whatsapp_review_intent
-- (get_review), decisão de arquitetura justificada na migration D.
--
-- Concorrência/segurança: FOR UPDATE uniforme (inclusive get_payment);
-- state='closed' bloqueia tudo; human_handoff bloqueia só mutação
-- (get_payment continua funcionando); SECURITY DEFINER + search_path
-- vazio; REVOKE ALL de PUBLIC/anon/authenticated, sem GRANT a
-- service_role (mesma evidência de 20260824160000).
--
-- NÃO altera whatsapp_messages, products, orders, create_customer_order,
-- apply_whatsapp_cart_intent, apply_whatsapp_fulfilment_intent,
-- set_whatsapp_delivery_quote. NÃO cria pedido, NÃO trata cupom
-- (etapa própria, migration C), NÃO integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.apply_whatsapp_payment_intent(
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
  v_session          public.whatsapp_sessions%rowtype;
  v_business         record;
  v_changed          boolean := false;
  v_payment_method   text;
  v_needs_change     boolean;
  v_cash_amount_texto text;
  v_cash_amount      numeric;
begin

  if p_intent not in ('set_payment_method', 'set_cash_change', 'get_payment') then
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
    raise exception 'Sessão encerrada — não é possível alterar pagamento';
  end if;

  if v_session.human_handoff and p_intent <> 'get_payment' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'payment_method', v_session.payment_method,
      'needs_change', v_session.needs_change,
      'cash_amount', v_session.cash_amount,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'get_payment' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'state', v_session.state,
      'payment_method', v_session.payment_method,
      'needs_change', v_session.needs_change,
      'cash_amount', v_session.cash_amount,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  if p_intent = 'set_payment_method' then

    v_payment_method := nullif(trim(p_payload->>'payment_method'), '');

    if v_payment_method is null or v_payment_method not in ('card', 'cash', 'revolut', 'bank_transfer') then
      raise exception 'Forma de pagamento inválida';
    end if;

    select revolut_enabled, revolut_qr_path,
           bank_transfer_enabled, bank_transfer_beneficiary, bank_transfer_iban, bank_transfer_bic
    into v_business
    from public.business_settings
    where id = 1;

    if not found then
      raise exception 'Configuração do estabelecimento indisponível. Tente novamente.';
    end if;

    if v_payment_method = 'revolut'
       and (v_business.revolut_enabled is not true
            or coalesce(trim(v_business.revolut_qr_path), '') = '') then
      raise exception 'Revolut indisponível no momento.';
    end if;

    if v_payment_method = 'bank_transfer'
       and (v_business.bank_transfer_enabled is not true
            or coalesce(trim(v_business.bank_transfer_beneficiary), '') = ''
            or coalesce(trim(v_business.bank_transfer_iban), '') = ''
            or coalesce(trim(v_business.bank_transfer_bic), '') = '') then
      raise exception 'Transferência bancária indisponível no momento.';
    end if;

    update public.whatsapp_sessions
    set payment_method = v_payment_method,
        needs_change = false,
        cash_amount = null,
        state = case
          when state in ('reviewing_order', 'awaiting_confirmation') then 'collecting_payment'
          else state
        end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'set_cash_change' then

    if v_session.payment_method is distinct from 'cash' then
      raise exception 'set_cash_change só é permitido com payment_method=cash';
    end if;

    if p_payload->>'needs_change' is null then
      raise exception 'needs_change é obrigatório (true ou false)';
    end if;

    v_needs_change := (p_payload->>'needs_change')::boolean;

    if v_needs_change then

      v_cash_amount_texto := nullif(trim(p_payload->>'cash_amount'), '');

      if v_cash_amount_texto is null or v_cash_amount_texto !~ '^[0-9]+(\.[0-9]{1,2})?$' then
        raise exception 'cash_amount deve ser um valor numérico maior que zero';
      end if;

      v_cash_amount := v_cash_amount_texto::numeric;

      if v_cash_amount <= 0 then
        raise exception 'cash_amount deve ser maior que zero';
      end if;

    else
      v_cash_amount := null;
    end if;

    update public.whatsapp_sessions
    set needs_change = v_needs_change,
        cash_amount = v_cash_amount,
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
    'payment_method', v_session.payment_method,
    'needs_change', v_session.needs_change,
    'cash_amount', v_session.cash_amount,
    'human_handoff', v_session.human_handoff,
    'changed', v_changed
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.apply_whatsapp_payment_intent(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_whatsapp_payment_intent(uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_whatsapp_payment_intent(uuid, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
