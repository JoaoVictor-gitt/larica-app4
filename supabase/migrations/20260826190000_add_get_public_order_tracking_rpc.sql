-- Acompanhamento público de pedido (Parte A) — RPC de leitura limitada
-- pra a nova página acompanhar-pedido.html. Recebe o número público do
-- pedido em texto livre ("#LARICA-31"/"LARICA-31"/"31") e normaliza
-- internamente (só dígitos) — nunca confia em formato pré-normalizado
-- pelo chamador. Devolve só os 7 campos abaixo: order_number, status
-- PÚBLICO (derivado do status real + payment_status, nunca um segundo
-- status armazenado à parte), fulfilment_type, created_at,
-- estimated_ready_at (calculado, nunca inventa duração de entrega sem
-- delivery_duration_seconds real persistido), completed_at, cancelled_at.
-- NUNCA devolve: id (UUID), customer_name, customer_phone, endereço,
-- payment_method, cash_amount, cupom, itens, subtotal/total, custos.
--
-- Pedido não encontrado e número mal formatado devolvem exatamente o
-- mesmo `null` — nunca revela se existe alguma associação de
-- telefone/nome ao número buscado.
--
-- SECURITY DEFINER + search_path vazio: o acesso do cliente público
-- nunca depende do RLS/GRANT de `orders` em si (não rastreado em
-- migrations, config pré-existente ambígua) — esta função decide
-- explicitamente, linha a linha, o que sai.
--
-- GRANT EXECUTE a anon/authenticated é deliberado (diferente do padrão
-- REVOKE-only das RPCs do WhatsApp) — esta é a ÚNICA RPC pensada pra ser
-- chamada por qualquer cliente público, e mesmo assim só é alcançável
-- via /api/track-order no Worker (rate limitado, reaproveitando
-- RATE_LIMIT_COUPON — ver worker/index.ts), nunca por SELECT direto em
-- orders.

CREATE OR REPLACE FUNCTION public.get_public_order_tracking(p_order_number text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_numero integer;
  v_order  public.orders%rowtype;
  v_status_publico text;
  v_estimativa timestamptz;
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

  -- Status público derivado do status real (orders.status) + payment_status —
  -- nunca um segundo status armazenado à parte. "aguardando_pagamento" só
  -- ocorre pra revolut/bank_transfer (payment_status='pending'); card/cash
  -- nascem com payment_status='pay_on_delivery', nunca passam por aqui.
  v_status_publico := case
    when v_order.status = 'cancelled' then 'cancelado'
    when v_order.status = 'requested' and v_order.payment_status = 'pending' then 'aguardando_pagamento'
    when v_order.status = 'requested' then 'solicitado'
    when v_order.status = 'preparing' then 'em_preparo'
    when v_order.status = 'ready' then 'pronto'
    when v_order.status = 'completed' then 'finalizado'
    else v_order.status
  end;

  -- Previsão só faz sentido enquanto o pedido ainda não terminou/cancelou.
  if v_order.status not in ('completed', 'cancelled') then
    if v_order.fulfilment_type = 'collection' then
      v_estimativa := v_order.created_at + interval '20 minutes';
    elsif v_order.delivery_duration_seconds is not null then
      v_estimativa := v_order.created_at
        + interval '20 minutes'
        + (v_order.delivery_duration_seconds || ' seconds')::interval
        + interval '20 minutes';
    else
      -- Pedido de entrega anterior a esta migration (sem duração real
      -- persistida) — nunca inventa um número, fica sem previsão.
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

REVOKE ALL ON FUNCTION public.get_public_order_tracking(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_order_tracking(text) TO anon, authenticated;
