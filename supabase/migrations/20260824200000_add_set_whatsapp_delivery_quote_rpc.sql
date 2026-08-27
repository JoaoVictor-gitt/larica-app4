-- L2.5J — RPC transacional de persistência de cotação de entrega pro
-- motor conversacional do WhatsApp (set_whatsapp_delivery_quote),
-- implementada no W4.4. Não calcula nada — só valida e grava um
-- delivery_quote_id já criado pela Edge Function calculate-delivery
-- (reaproveitada sem alteração, chamada pelo Worker — ver
-- worker/index.ts).
--
-- human_handoff=true é tratado como EXCEÇÃO aqui (raise exception),
-- diferente do padrão "changed:false sem exceção" de
-- apply_whatsapp_cart_intent/apply_whatsapp_fulfilment_intent — decisão
-- deliberada: esta RPC não tem nenhuma variante de leitura (get_*) pra
-- diferenciar, só uma única ação de mutação, então uma exceção clara é
-- mais simples e direta que inventar uma resposta "sem efeito" pra uma
-- função que só faz uma coisa.
--
-- Confirma que a cotação existe, não expirou (expires_at > now(), ver
-- W4.4A/W4.4B — antes desta correção uma cotação expirada podia ser
-- persistida aqui, só falhando mais tarde em create_customer_order) e
-- que seu eircode/address_line_1/address_line_2/area batem exatamente
-- com os da sessão atual — mesmo padrão de comparação
-- (coalesce(trim(...), '')) já usado por create_customer_order
-- (supabase/migrations/20260817140000_add_product_costs_and_snapshot.sql:505-509)
-- pra cruzar cotação x endereço, aqui aplicado contra a sessão em vez
-- do payload. create_customer_order continua fazendo sua própria
-- checagem de expires_at independente, no momento real da criação do
-- pedido — esta RPC só evita persistir algo já sabidamente inútil mais
-- cedo.
--
-- SECURITY DEFINER + search_path vazio, REVOKE ALL de
-- PUBLIC/anon/authenticated, sem GRANT a service_role — mesmo padrão de
-- 100% das RPCs de escrita já existentes no projeto.
--
-- NÃO altera whatsapp_messages, apply_whatsapp_cart_intent,
-- apply_whatsapp_fulfilment_intent, products, combo_*, orders,
-- create_customer_order, delivery_quotes (schema), calculate-delivery.
-- NÃO calcula distância/taxa — só persiste um quote_id já calculado.

CREATE OR REPLACE FUNCTION public.set_whatsapp_delivery_quote(
  p_session_id        uuid,
  p_delivery_quote_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session public.whatsapp_sessions%rowtype;
  v_quote   record;
begin

  select * into v_session
  from public.whatsapp_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Sessão não encontrada';
  end if;

  if v_session.state = 'closed' then
    raise exception 'Sessão encerrada — não é possível gravar cotação de entrega';
  end if;

  if v_session.human_handoff then
    raise exception 'Sessão em atendimento humano — não é possível gravar cotação de entrega';
  end if;

  if v_session.fulfilment_type is distinct from 'delivery' then
    raise exception 'set_whatsapp_delivery_quote só é permitido com fulfilment_type=delivery';
  end if;

  if p_delivery_quote_id is null then
    raise exception 'delivery_quote_id é obrigatório';
  end if;

  select eircode, address_line_1, address_line_2, area, distance_km, delivery_fee
  into v_quote
  from public.delivery_quotes
  where id = p_delivery_quote_id
    and expires_at > now();

  if not found then
    raise exception 'Cotação de entrega não encontrada';
  end if;

  if coalesce(trim(v_quote.eircode), '') <> coalesce(trim(v_session.eircode), '')
     or coalesce(trim(v_quote.address_line_1), '') <> coalesce(trim(v_session.address_line_1), '')
     or coalesce(trim(v_quote.address_line_2), '') <> coalesce(trim(v_session.address_line_2), '')
     or coalesce(trim(v_quote.area), '') <> coalesce(trim(v_session.area), '') then
    raise exception 'Cotação de entrega não corresponde ao endereço atual da sessão';
  end if;

  update public.whatsapp_sessions
  set delivery_quote_id = p_delivery_quote_id,
      state = 'collecting_payment',
      updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return jsonb_build_object(
    'session_id', v_session.id,
    'state', v_session.state,
    'delivery_quote_id', v_session.delivery_quote_id,
    'distance_km', v_quote.distance_km,
    'delivery_fee', v_quote.delivery_fee,
    'human_handoff', v_session.human_handoff,
    'changed', true
  );

end;
$function$;

REVOKE ALL ON FUNCTION public.set_whatsapp_delivery_quote(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_whatsapp_delivery_quote(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.set_whatsapp_delivery_quote(uuid, uuid) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
