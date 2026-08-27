-- RPC mínima pra resolver o bloqueador encontrado no W5.1: nenhuma
-- RPC/webhook grava whatsapp_sessions.customer_name hoje. Parte do
-- W5.1A, pré-requisito isolado antes de create_order_from_whatsapp_session
-- (W5.2 — ainda não implementada).
--
-- Política de sobrescrita: só grava se customer_name atual estiver
-- NULL/vazio. Se já houver um nome (seja porque o cliente já
-- confirmou, seja porque uma chamada anterior já gravou), a RPC
-- retorna changed:false e NEM VALIDA p_customer_name — evita que um
-- profile.name da Meta (não confiável como fonte de verdade, é só
-- dado de identificação — ver seção 7 do relatório W5.1A) sobrescreva
-- um nome já correto/corrigido pelo cliente.
--
-- human_handoff NÃO bloqueia esta RPC (diferente de
-- confirm_review/set_whatsapp_delivery_quote) — é uma mutação
-- não-financeira, sem efeito em cart/state/payment, e a política de
-- sobrescrita acima já garante que nunca pisa num nome já confirmado.
-- state='closed' continua bloqueando, mesma regra universal da
-- família de RPCs do WhatsApp.
--
-- Sem limite de tamanho pra customer_name: auditado e confirmado que
-- não existe limite em create_customer_order, orders ou frontend —
-- não inventado aqui.
--
-- last_message_at NUNCA é tocado por esta RPC (só mensagens reais do
-- cliente avançam isso, não uma captura interna de nome).
--
-- NÃO altera create_customer_order, orders, whatsapp_messages,
-- apply_whatsapp_cart_intent, apply_whatsapp_fulfilment_intent,
-- apply_whatsapp_payment_intent, apply_whatsapp_coupon_intent,
-- apply_whatsapp_review_intent, set_whatsapp_delivery_quote,
-- worker/index.ts. NÃO cria pedido, NÃO integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.set_whatsapp_customer_name(
  p_session_id     uuid,
  p_customer_name  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session      public.whatsapp_sessions%rowtype;
  v_name_texto   text;
  v_changed      boolean := false;
begin

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  if v_session.state = 'closed' then
    raise exception 'Sessão encerrada — não é possível alterar nome do cliente';
  end if;

  if coalesce(trim(v_session.customer_name), '') <> '' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'customer_name', v_session.customer_name,
      'state', v_session.state,
      'human_handoff', v_session.human_handoff,
      'changed', false
    );
  end if;

  v_name_texto := nullif(trim(p_customer_name), '');

  if v_name_texto is null then
    raise exception 'Nome do cliente é obrigatório';
  end if;

  update public.whatsapp_sessions
  set customer_name = v_name_texto,
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  v_changed := true;

  return jsonb_build_object(
    'session_id', v_session.id,
    'customer_name', v_session.customer_name,
    'state', v_session.state,
    'human_handoff', v_session.human_handoff,
    'changed', v_changed
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.set_whatsapp_customer_name(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_whatsapp_customer_name(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_whatsapp_customer_name(uuid, text) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
