-- L2.5H — RPC transacional de carrinho pro motor conversacional do
-- WhatsApp (apply_whatsapp_cart_intent), projetada no W4.1 (seções 9/14)
-- e implementada como segunda fatia do W4.2.
--
-- Intents suportadas nesta etapa: add_item (só item_type='product' —
-- combo explicitamente fora de escopo, rejeitado com exceção clara),
-- remove_item (por cart_index, nunca product_id — ver decisão no
-- relatório da migration), clear_cart, get_cart. Qualquer outro valor de
-- p_intent é rejeitado.
--
-- cart_index (remove_item) é 1-based na interface desta RPC: 1 = primeiro
-- item do array, 2 = segundo, etc. — nunca o índice 0-based nativo do
-- jsonb. A conversão pro índice 0-based (cart_index - 1) acontece só
-- internamente, depois de validado (cart_index >= 1 e <= tamanho do
-- cart). Ajustado no W4.2B a partir da auditoria W4.2A (implementação
-- original era 0-based sem conversão).
--
-- quantity (add_item) é validado por regex (só dígitos) ANTES de
-- qualquer cast pra integer — nunca trunca um valor fracionário
-- silenciosamente (2.5 nunca vira 2); ausente, fracionário, negativo ou
-- não-numérico são todos erro controlado com mensagem de negócio, nunca
-- um erro bruto de cast do Postgres. Também ajustado no W4.2B.
--
-- Concorrência: SELECT ... FOR UPDATE na sessão roda pra todo intent
-- (inclusive get_cart, pra leitura consistente) — serializa
-- automaticamente duas mensagens da mesma sessão chegando quase juntas,
-- sem lock manual/advisory, mesma técnica já usada em
-- record_whatsapp_inbound_message.
--
-- human_handoff=true nunca vira erro — get_cart continua funcionando;
-- add_item/remove_item/clear_cart retornam o estado atual sem alteração
-- (changed:false). Sessão inexistente ou state='closed' SÃO erro
-- (raise exception) — distinção deliberada, pedida no desenho do W4.1.
--
-- Nunca aceita nem grava price/subtotal/discount/total no cart — o
-- formato gravado é sempre {item_type, product_id, quantity} (produto
-- simples nesta etapa), o mesmo aceito por create_customer_order.
-- product_id de add_item é sempre revalidado contra products (active,
-- is_available, category) antes de entrar no cart — nunca confiado do
-- payload.
--
-- SECURITY DEFINER + search_path vazio: mesmo padrão de
-- get_whatsapp_menu (20260824170000) e de 100% das RPCs de escrita já
-- existentes no projeto.
--
-- NÃO altera whatsapp_messages, products, combo_*, orders,
-- create_customer_order, delivery_quotes. NÃO cria pedido, não calcula
-- entrega, não valida cupom, não coleta pagamento, não integra
-- Meta/OpenAI. NÃO avança pra fulfilment_type/address/payment_method
-- nesta etapa.

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

    -- Validação de quantity ANTES de qualquer cast pra integer: um
    -- valor fracionário ("2.5") ou não-numérico ("abc") faria o cast
    -- ::integer estourar um erro bruto do Postgres em vez da mensagem
    -- de negócio abaixo — por isso o valor bruto é validado por regex
    -- (só dígitos, sem sinal, sem ponto) antes de qualquer conversão.
    -- Nunca trunca silenciosamente (2.5 nunca vira 2) — ou é um inteiro
    -- exato, ou é rejeitado.
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
        state = case when state in ('greeting', 'browsing_menu') then 'building_cart' else state end,
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'remove_item' then

    -- Contrato 1-based: cart_index=1 é o primeiro item (o motor/cliente
    -- nunca vê índice 0-based) — convertido pra índice 0-based do jsonb
    -- (cart_index - 1) só no momento de aplicar o operador `-`, depois
    -- de validado.
    v_cart_index := nullif(p_payload->>'cart_index', '')::integer;

    if v_cart_index is null
       or v_cart_index < 1
       or v_cart_index > jsonb_array_length(v_session.cart) then
      raise exception 'Índice de carrinho inválido: %', p_payload->>'cart_index';
    end if;

    update public.whatsapp_sessions
    set cart = v_session.cart - (v_cart_index - 1),
        updated_at = now()
    where id = p_session_id
    returning * into v_session;

    v_changed := true;

  elsif p_intent = 'clear_cart' then

    update public.whatsapp_sessions
    set cart = '[]'::jsonb,
        state = case when state = 'building_cart' then 'browsing_menu' else state end,
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
