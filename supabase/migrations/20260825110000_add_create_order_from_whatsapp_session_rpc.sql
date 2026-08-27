-- RPC final do motor conversacional do WhatsApp: transforma uma
-- sessão em `awaiting_confirmation` num pedido real em `orders`. Parte
-- do W5.2, projetada na análise do W5.1 e desbloqueada pelo W5.1A
-- (set_whatsapp_customer_name). ÚNICA porta de criação de pedido a
-- partir de uma sessão WhatsApp — nenhum outro caminho deve escrever
-- em whatsapp_sessions.order_id.
--
-- Ordem de checagem, nesta ordem exata: lock (FOR UPDATE) → IDEMPOTÊNCIA
-- PRIMEIRO (order_id IS NOT NULL devolve o pedido existente sem olhar
-- state/human_handoff — permite retry mesmo com a sessão já em closed)
-- → barreira de state (state <> 'awaiting_confirmation', que já cobre
-- 'closed' estruturalmente, sem branch separado) → human_handoff →
-- customer_name → gate estrutural via whatsapp_session_ready_for_review
-- (reaproveitado sem reimplementar nenhuma regra de completude).
--
-- Gate final: se whatsapp_session_ready_for_review não estiver ready,
-- esta RPC LANÇA exceção com a lista missing embutida (diferente do
-- padrão gracioso "changed:false"/"ready:false" de get_review/
-- confirm_review, que são funções de preview) — decisão deliberada,
-- por consistência com o resto desta RPC, que já é exceção-first do
-- início ao fim (não há aqui nenhuma variante "preview", só ação).
--
-- Payload construído inteiramente server-side a partir da sessão —
-- nunca aceita price/subtotal/discount/delivery_fee/distance/total
-- vindos de fora. create_customer_order é chamada SEM capturar
-- exceção: qualquer falha de negócio (produto indisponível, cupom
-- inválido, cotação expirada, cash insuficiente, negócio fechado)
-- desfaz a transação inteira sozinha, porque a UPDATE que gravaria
-- order_id/state só roda depois do retorno bem-sucedido — nunca fica
-- alteração parcial. Concorrência: duas chamadas simultâneas
-- serializam no FOR UPDATE; a segunda só prossegue depois que a
-- primeira já comitou order_id, cai no passo de idempotência — nunca
-- cria um segundo pedido.
--
-- Confirmado (auditoria W5.1): create_customer_order sempre retorna
-- 'id' e 'order_number' no jsonb — nenhum SELECT extra necessário pra
-- extrair esses valores. last_message_at nunca é tocado por esta RPC.
--
-- SECURITY DEFINER + search_path vazio, REVOKE ALL de
-- PUBLIC/anon/authenticated, sem GRANT a service_role — mesmo padrão
-- de 100% das RPCs de escrita já existentes no projeto.
--
-- NÃO altera create_customer_order, orders, whatsapp_messages,
-- apply_whatsapp_cart_intent, apply_whatsapp_fulfilment_intent,
-- apply_whatsapp_payment_intent, apply_whatsapp_coupon_intent,
-- apply_whatsapp_review_intent, set_whatsapp_delivery_quote,
-- set_whatsapp_customer_name, worker/index.ts. NÃO integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.create_order_from_whatsapp_session(
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session   public.whatsapp_sessions%rowtype;
  v_order     record;
  v_payload   jsonb;
  v_result    jsonb;
  v_readiness jsonb;
begin

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  -- Idempotência primeiro: um order_id já gravado sempre vence,
  -- independente de state/human_handoff.
  if v_session.order_id is not null then

    select id, order_number into v_order
    from public.orders
    where id = v_session.order_id;

    return jsonb_build_object(
      'duplicate', true,
      'session_id', v_session.id,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'state', v_session.state
    );

  end if;

  if v_session.state <> 'awaiting_confirmation' then
    raise exception 'Sessão não está aguardando confirmação — não é possível criar pedido';
  end if;

  if v_session.human_handoff then
    raise exception 'Sessão em atendimento humano — não é possível criar pedido';
  end if;

  if coalesce(trim(v_session.customer_name), '') = '' then
    raise exception 'Nome do cliente não informado na sessão — não é possível criar pedido';
  end if;

  v_readiness := public.whatsapp_session_ready_for_review(p_session_id);

  if not (v_readiness->>'ready')::boolean then
    raise exception 'Sessão não está pronta para criar pedido: %', v_readiness->'missing';
  end if;

  v_payload := jsonb_build_object(
    'customer_name', v_session.customer_name,
    'customer_phone', v_session.phone,
    'fulfilment_type', v_session.fulfilment_type,
    'eircode', v_session.eircode,
    'address_line_1', v_session.address_line_1,
    'address_line_2', v_session.address_line_2,
    'area', v_session.area,
    'delivery_instructions', v_session.delivery_instructions,
    'delivery_quote_id', v_session.delivery_quote_id,
    'payment_method', v_session.payment_method,
    'needs_change', v_session.needs_change,
    'cash_amount', v_session.cash_amount,
    'coupon_code', v_session.coupon_code,
    'items', v_session.cart
  );

  -- Propaga qualquer exceção de create_customer_order sem capturar —
  -- rollback automático de toda a transação, order_id/state nunca
  -- ficam parcialmente alterados.
  v_result := public.create_customer_order(v_payload);

  update public.whatsapp_sessions
  set order_id = (v_result->>'id')::uuid,
      state = 'order_created',
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return jsonb_build_object(
    'duplicate', false,
    'session_id', v_session.id,
    'order_id', v_session.order_id,
    'order_number', v_result->>'order_number',
    'state', v_session.state
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.create_order_from_whatsapp_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order_from_whatsapp_session(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_order_from_whatsapp_session(uuid) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
