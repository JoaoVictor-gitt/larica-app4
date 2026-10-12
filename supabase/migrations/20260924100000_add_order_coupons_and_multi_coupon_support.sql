-- Múltiplos cupons por pedido — Etapa 1 (migration + backend, sem frontend ainda).
--
-- 1) Cria public.order_coupons: snapshot de cada cupom EFETIVAMENTE aplicado a um pedido.
--    Estruturalmente preparada pra N linhas por pedido (sem UNIQUE(order_id), sem CHECK de
--    quantidade) — o cap "no máximo 1 monetário + 1 free_delivery" é regra de negócio dentro
--    de create_customer_order, nunca uma limitação de schema. Isso permite relaxar o cap numa
--    v2 (ex.: permitir 2 percentage) só mudando a função, sem tocar em schema.
--
--    order_id: ON DELETE CASCADE — mesmo padrão já usado para tabelas-filha de pedido
--    (order_items/order_item_selections, mesmo que criadas fora do controle de migrations);
--    se um pedido for apagado, seu histórico de cupons não tem razão de existir separado.
--
--    coupon_id: NULLABLE + ON DELETE SET NULL — decisão explícita do usuário: preservar o
--    histórico do pedido mesmo que o cupom referenciado seja removido no futuro. Cupons hoje
--    nunca são deletados fisicamente (só active=false, ver js/services/coupons-service.js), mas
--    se algum dia forem, a linha de order_coupons continua íntegra (coupon_code/discount_type/
--    discount_value/discount_amount são um snapshot independente) — só o vínculo de FK é
--    zerado, nunca a linha inteira (RESTRICT bloquearia a exclusão do cupom; CASCADE apagaria
--    o histórico do pedido — nenhum dos dois atende ao requisito).
--
-- 2) RLS/grants seguem o padrão já usado para tabelas-filha escritas só via RPC SECURITY
--    DEFINER (ver skewer_batch_components em 20260818110000_add_skewer_batch_components.sql):
--    SELECT liberado pra authenticated via policy is_staff(); ZERO grant de escrita pra
--    authenticated nem anon — toda escrita entra só por create_customer_order (SECURITY
--    DEFINER, já público pra anon desde 20260822090000_revoke_anon_admin_rpcs.sql).
--
-- 3) Substitui create_customer_order (corpo anterior: 20260923110000). Todo o corpo é idêntico
--    byte a byte EXCETO: (a) declare — variáveis de cupom trocadas; (b) bloco "CUPONS" — agora
--    processa um array de códigos (novo campo coupon_codes, com fallback pro campo legado
--    coupon_code) em vez de 1 string; (c) bloco "FREE DELIVERY" — condição trocada de
--    v_discount_type = 'free_delivery' pra v_free_delivery IS NOT NULL (necessário: quando um
--    cupom monetário E um free_delivery são combinados, v_discount_type passa a representar o
--    monetário nas colunas legadas, então checar v_discount_type quebraria a combinação); (d)
--    novo bloco de INSERT em order_coupons; (e) retorno — novo campo applied_coupons. Nenhuma
--    outra parte da função (horário de funcionamento, itens, combos, estoque, troco, etc.) foi
--    alterada.
--
-- Compatibilidade: pedidos com 0 ou 1 cupom (monetário OU free_delivery) continuam
-- exatamente com o mesmo resultado de hoje — as colunas legadas de orders continuam
-- preenchidas do mesmo jeito quando só existe 1 cupom, de qualquer tipo. O fluxo WhatsApp
-- (create_order_from_whatsapp_session) continua enviando só coupon_code (singular) e
-- continua funcionando sem nenhuma mudança, via o fallback de precedência abaixo.

-- ================================================================
-- 1. public.order_coupons
-- ================================================================

CREATE TABLE public.order_coupons (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  coupon_id         uuid NULL REFERENCES public.coupons(id) ON DELETE SET NULL,
  coupon_code       text NOT NULL,
  discount_type     text NOT NULL,
  discount_value    numeric NOT NULL,
  discount_amount   numeric NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_coupons_discount_type_valido CHECK (discount_type IN ('percentage', 'fixed', 'free_delivery')),
  CONSTRAINT order_coupons_discount_value_nao_negativo CHECK (discount_value >= 0),
  CONSTRAINT order_coupons_discount_amount_nao_negativo CHECK (discount_amount >= 0)
);

-- Consulta prevista: sempre por pedido (Admin/Histórico/Epson montando "quais cupons esse
-- pedido usou"); coupon_code pra relatórios agregarem "quantas vezes esse código foi usado".
CREATE INDEX idx_order_coupons_order_id ON public.order_coupons (order_id);
CREATE INDEX idx_order_coupons_coupon_code ON public.order_coupons (coupon_code);

ALTER TABLE public.order_coupons ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_coupons_select_staff ON public.order_coupons
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY order_coupons_insert_admin ON public.order_coupons
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY order_coupons_update_admin ON public.order_coupons
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY order_coupons_delete_admin ON public.order_coupons
  FOR DELETE TO authenticated USING (public.is_admin());

-- Só SELECT pra authenticated — nenhuma escrita direta. create_customer_order (SECURITY
-- DEFINER) grava as linhas, sem depender de nenhum GRANT de INSERT pra authenticated/anon.
REVOKE ALL PRIVILEGES ON TABLE public.order_coupons FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.order_coupons FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.order_coupons FROM authenticated;
GRANT SELECT ON TABLE public.order_coupons TO authenticated;


-- ================================================================
-- 2. create_customer_order — nova versão (multi-cupom)
-- ================================================================

CREATE OR REPLACE FUNCTION public.create_customer_order(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare

  v_fulfilment text := payload->>'fulfilment_type';
  v_payment text := payload->>'payment_method';
  v_payment_status text;

  v_needs_change boolean :=
    coalesce((payload->>'needs_change')::boolean, false);

  v_cash_amount numeric;
  v_change numeric;

  v_delivery_fee numeric :=
    greatest(
      0,
      coalesce(
        nullif(payload->>'delivery_fee', '')::numeric,
        0
      )
    );

  v_original_delivery_fee numeric := null;

  v_delivery_distance numeric;
  v_delivery_duration_seconds integer;
  v_pickup_time time;

  v_items jsonb :=
    coalesce(payload->'items', '[]'::jsonb);

  v_item jsonb;
  v_selection jsonb;

  v_product record;
  v_sel record;
  v_quote record;

  v_allowed_skewers integer;
  v_allowed_sides integer;

  v_item_qty integer;
  v_selection_qty integer;

  v_qtd_espetos integer;
  v_qtd_lados integer;

  v_subtotal numeric := 0;
  v_total numeric := 0;

  v_order_id uuid;
  v_item_id uuid;

  v_unit_price numeric;
  v_extras_per_unit numeric;
  v_extras_line_total numeric;
  v_line_total numeric;

  v_item_type text;

  v_new_stock integer;
  v_qtd_baixa integer;

  v_custos_espetos jsonb;
  v_custos_lados jsonb;
  v_custo_componente numeric(12,4);

  v_business_settings record;
  v_hours_configured boolean;
  v_now_local timestamp;
  v_current_day int;
  v_current_time time;
  v_yesterday_day int;
  v_today_hours record;
  v_yesterday_hours record;
  v_is_open boolean;

  v_result jsonb;

  -- Multi-cupom (v1): no máximo 1 cupom monetário (percentage/fixed) + 1 free_delivery.
  -- Precedência quando o payload envia os dois formatos: coupon_codes (array) tem prioridade
  -- TOTAL sobre coupon_code (singular/legado) — se o array vier presente e não-vazio,
  -- coupon_code é ignorado por completo, nunca somado/mesclado a ele, pra nunca gerar
  -- aplicação duplicada do mesmo código. coupon_code só é usado quando coupon_codes estiver
  -- ausente/vazio (compatibilidade com o fluxo WhatsApp, que só conhece o formato singular).
  v_coupon_codes_raw jsonb := payload->'coupon_codes';
  v_legacy_coupon_code text := nullif(upper(trim(payload->>'coupon_code')), '');
  v_coupon_codes text[] := '{}';
  v_code text;
  v_coupon_element jsonb;
  v_coupon_result jsonb;
  v_monetary jsonb := null;
  v_free_delivery jsonb := null;
  v_monetary_count integer := 0;
  v_free_delivery_count integer := 0;

  -- Colunas legadas de orders: cupom monetário tem prioridade de representação; na ausência
  -- dele, free_delivery as representa — preserva o comportamento atual pra quem usa 1 cupom só.
  v_coupon_code text := null;
  v_coupon_id uuid := null;
  v_discount_type text := null;
  v_discount_value numeric := null;
  v_discount_amount numeric := 0;

begin

  select
    orders_enabled,
    closed_message,
    delivery_enabled,
    collection_enabled,
    timezone,
    bank_transfer_enabled,
    bank_transfer_beneficiary,
    bank_transfer_iban,
    bank_transfer_bic
  into v_business_settings
  from public.business_settings
  where id = 1;

  if not found then
    raise exception 'Configuração do estabelecimento indisponível. Tente novamente.';
  end if;

  if not v_business_settings.orders_enabled then
    raise exception '%', coalesce(nullif(v_business_settings.closed_message, ''), 'Pedidos fechados no momento.');
  end if;

  select bool_or(enabled) into v_hours_configured from public.business_hours;

  if v_hours_configured then

    v_now_local := now() at time zone v_business_settings.timezone;
    v_current_day := extract(dow from v_now_local)::int;
    v_current_time := v_now_local::time;
    v_yesterday_day := (v_current_day + 6) % 7;

    select * into v_today_hours from public.business_hours where day_of_week = v_current_day;
    if not found then
      raise exception 'Horário de funcionamento indisponível. Tente novamente.';
    end if;

    select * into v_yesterday_hours from public.business_hours where day_of_week = v_yesterday_day;
    if not found then
      raise exception 'Horário de funcionamento indisponível. Tente novamente.';
    end if;

    v_is_open := false;

    if v_today_hours.enabled
       and v_today_hours.opening_time is not null
       and v_today_hours.closing_time is not null then

      if v_today_hours.closing_time > v_today_hours.opening_time then
        if v_current_time >= v_today_hours.opening_time
           and v_current_time < v_today_hours.closing_time then
          v_is_open := true;
        end if;
      else
        if v_current_time >= v_today_hours.opening_time then
          v_is_open := true; -- turno de hoje atravessa a meia-noite: aberto até 23:59:59 de hoje
        end if;
      end if;

    end if;

    if not v_is_open
       and v_yesterday_hours.enabled
       and v_yesterday_hours.opening_time is not null
       and v_yesterday_hours.closing_time is not null
       and v_yesterday_hours.closing_time <= v_yesterday_hours.opening_time
       and v_current_time < v_yesterday_hours.closing_time then
      v_is_open := true; -- madrugada de hoje ainda dentro do turno overnight de ontem
    end if;

    if not v_is_open then
      raise exception 'Fora do horário de funcionamento.';
    end if;

  end if;

  if v_fulfilment = 'delivery' and not v_business_settings.delivery_enabled then
    raise exception 'Entrega desativada no momento.';
  end if;

  if v_fulfilment = 'collection' and not v_business_settings.collection_enabled then
    raise exception 'Retirada desativada no momento.';
  end if;

  -- "Comer no local" não tem toggle de disponibilidade nesta fase — sempre
  -- permitido, sem checagem de business_settings (decisão explícita do
  -- usuário: toggle fica para uma etapa futura, se necessário).


  -- ==========================================================
  -- DADOS BÁSICOS
  -- ==========================================================

  if coalesce(trim(payload->>'customer_name'), '') = '' then
    raise exception 'Nome do cliente é obrigatório';
  end if;

  -- customer_phone agora é OPCIONAL nos 3 fulfilments (Pick Up, Dine In, Delivery) — decisão
  -- explícita do usuário. O campo continua existindo no payload/coluna, só deixou de bloquear a
  -- criação do pedido quando vazio/null.

  if v_fulfilment not in ('collection', 'delivery', 'dine_in') then
    raise exception 'Tipo de recebimento inválido';
  end if;


  if v_payment not in ('card', 'cash', 'revolut', 'bank_transfer') then
    raise exception 'Forma de pagamento inválida';
  end if;

  if v_payment = 'card' and v_fulfilment = 'delivery' then
    raise exception 'Pagamento por cartão está disponível apenas para retirada no momento.';
  end if;

  if v_payment = 'bank_transfer' then

    if v_business_settings.bank_transfer_enabled is not true then
      raise exception 'Transferência bancária indisponível no momento.';
    end if;

    if coalesce(trim(v_business_settings.bank_transfer_beneficiary), '') = ''
       or coalesce(trim(v_business_settings.bank_transfer_iban), '') = ''
       or coalesce(trim(v_business_settings.bank_transfer_bic), '') = '' then
      raise exception 'Transferência bancária indisponível no momento.';
    end if;

  end if;

  if v_payment = 'revolut' or v_payment = 'bank_transfer' then
    v_payment_status := 'pending';
  else
    v_payment_status := 'pay_on_delivery';
  end if;


  if jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) = 0 then
    raise exception 'O pedido precisa ter ao menos um item';
  end if;


  -- ==========================================================
  -- RETIRADA / COMER NO LOCAL / ENTREGA — 3 vias explícitas, nunca um
  -- else genérico assumindo delivery. dine_in tratado igual a collection
  -- (sem endereço, sem taxa de entrega, pickup_time opcional do payload);
  -- só o valor gravado em fulfilment_type diferencia os dois.
  -- ==========================================================

  if v_fulfilment = 'collection' then

    v_delivery_fee := 0;
    v_delivery_distance := null;
    v_delivery_duration_seconds := null;

    if nullif(payload->>'pickup_time', '') is not null then
      v_pickup_time :=
        (payload->>'pickup_time')::time;
    end if;

  elsif v_fulfilment = 'dine_in' then

    v_delivery_fee := 0;
    v_delivery_distance := null;
    v_delivery_duration_seconds := null;

    if nullif(payload->>'pickup_time', '') is not null then
      v_pickup_time :=
        (payload->>'pickup_time')::time;
    end if;

  elsif v_fulfilment = 'delivery' then

    -- address_line_1 agora é OPCIONAL para Delivery — Eircode sozinho já é um identificador de
    -- localização preciso na Irlanda (checagem abaixo, intocada). address_line_2/area nunca
    -- tiveram checagem própria aqui.

    if coalesce(trim(payload->>'eircode'), '') = '' then
      raise exception 'Eircode é obrigatório para entrega';
    end if;

    -- A taxa/distância NÃO vêm mais do payload (delivery_fee/delivery_distance_km
    -- continuam podendo estar presentes por compatibilidade, mas são ignorados
    -- daqui pra frente). A fonte oficial é a cotação criada pela Edge Function
    -- calculate-delivery em public.delivery_quotes.

    if coalesce(trim(payload->>'delivery_quote_id'), '') = '' then
      raise exception 'Cotação de entrega expirada ou inválida. Calcule a entrega novamente.';
    end if;

    select
      eircode,
      address_line_1,
      address_line_2,
      area,
      distance_km,
      delivery_fee,
      duration_seconds
    into v_quote
    from public.delivery_quotes
    where id = (payload->>'delivery_quote_id')::uuid
      and expires_at > now();

    if v_quote.delivery_fee is null then
      raise exception 'Cotação de entrega expirada ou inválida. Calcule a entrega novamente.';
    end if;

    if coalesce(trim(v_quote.eircode), '') <> coalesce(trim(payload->>'eircode'), '')
       or coalesce(trim(v_quote.address_line_1), '') <> coalesce(trim(payload->>'address_line_1'), '')
       or coalesce(trim(v_quote.address_line_2), '') <> coalesce(trim(payload->>'address_line_2'), '')
       or coalesce(trim(v_quote.area), '') <> coalesce(trim(payload->>'area'), '') then
      raise exception 'Cotação de entrega expirada ou inválida. Calcule a entrega novamente.';
    end if;

    v_delivery_fee := v_quote.delivery_fee;
    v_delivery_distance := v_quote.distance_km;
    v_delivery_duration_seconds := v_quote.duration_seconds;

  else
    raise exception 'Tipo de recebimento inválido';
  end if;


  -- ==========================================================
  -- PAGAMENTO
  -- ==========================================================

  if v_payment <> 'cash' then
    v_needs_change := false;
  end if;


  -- ==========================================================
  -- CRIA CABEÇALHO DO PEDIDO
  -- ==========================================================

  insert into public.orders (

    customer_name,
    customer_phone,

    fulfilment_type,
    pickup_time,

    eircode,
    address_line_1,
    address_line_2,
    area,
    delivery_instructions,
    delivery_distance_km,
    delivery_fee,
    delivery_duration_seconds,

    payment_method,
    needs_change,
    payment_status,

    cash_amount,
    change_amount,

    subtotal,
    total,

    status

  )
  values (

    trim(payload->>'customer_name'),
    nullif(trim(payload->>'customer_phone'), ''),

    v_fulfilment,
    v_pickup_time,

    case when v_fulfilment = 'delivery'
      then nullif(payload->>'eircode', '')
      else null
    end,

    case when v_fulfilment = 'delivery'
      then nullif(payload->>'address_line_1', '')
      else null
    end,

    case when v_fulfilment = 'delivery'
      then nullif(payload->>'address_line_2', '')
      else null
    end,

    case when v_fulfilment = 'delivery'
      then nullif(payload->>'area', '')
      else null
    end,

    case when v_fulfilment = 'delivery'
      then nullif(payload->>'delivery_instructions', '')
      else null
    end,

    v_delivery_distance,
    v_delivery_fee,
    v_delivery_duration_seconds,

    v_payment,
    v_needs_change,
    v_payment_status,

    null,
    null,

    0,
    0,

    'requested'

  )
  returning id into v_order_id;


  -- ==========================================================
  -- ITENS DO PEDIDO
  -- ==========================================================

  for v_item in
    select *
    from jsonb_array_elements(v_items)
  loop

    v_item_type := v_item->>'item_type';

    if v_item_type not in ('product', 'combo') then
      raise exception 'Tipo de item inválido';
    end if;


    v_item_qty :=
      coalesce(
        nullif(v_item->>'quantity', '')::integer,
        1
      );

    if v_item_qty < 1 then
      raise exception 'Quantidade do produto deve ser maior que zero';
    end if;


    select
      p.id,
      p.name,
      p.price,
      p.active,
      p.category,
      p.is_available,
      pc.unit_cost as unit_cost

    into v_product

    from public.products p
    left join public.product_costs pc on pc.product_id = p.id
    where p.id = (v_item->>'product_id')::uuid
    for update of p;


    if v_product.id is null
       or v_product.active is not true then

      raise exception
        'Produto indisponível: %',
        (v_item->>'product_id');

    end if;


    if v_product.is_available is not true then

      raise exception
        'Produto indisponível no momento: %',
        v_product.name;

    end if;


    if v_product.price < 0 then
      raise exception 'Preço inválido para %', v_product.name;
    end if;


    if v_product.category = 'combos'
       and v_item_type <> 'combo' then

      raise exception
        'O produto % precisa ser enviado como combo',
        v_product.name;

    end if;


    if v_product.category <> 'combos'
       and v_item_type = 'combo' then

      raise exception
        'O produto % não é um combo',
        v_product.name;

    end if;


    v_unit_price := v_product.price;
    v_extras_per_unit := 0;


    -- ========================================================
    -- COMBO
    -- ========================================================

    if v_item_type = 'combo' then

      v_custos_espetos := '{}'::jsonb;
      v_custos_lados := '{}'::jsonb;

      select
        cc.allowed_skewers,
        cc.allowed_sides

      into
        v_allowed_skewers,
        v_allowed_sides

      from public.combo_configs cc
      where cc.product_id = v_product.id;


      if v_allowed_skewers is null
         or v_allowed_sides is null then

        raise exception
          'Combo % sem configuração',
          v_product.name;

      end if;


      -- ------------------------------------------------------
      -- ESPETOS
      -- ------------------------------------------------------

      v_qtd_espetos := (

        select coalesce(
          sum((s->>'quantity')::integer),
          0
        )

        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'skewers',
            '[]'::jsonb
          )
        ) s

      );


      if v_qtd_espetos <> v_allowed_skewers then

        raise exception
          'Quantidade de espetos inválida para %',
          v_product.name;

      end if;


      for v_selection in

        select *
        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'skewers',
            '[]'::jsonb
          )
        )

      loop

        v_selection_qty :=
          nullif(
            v_selection->>'quantity',
            ''
          )::integer;


        if v_selection_qty is null
           or v_selection_qty < 1 then

          raise exception
            'Quantidade de espeto inválida';

        end if;


        select
          p.id,
          p.name,
          p.active,
          p.is_available,
          o.extra_price,
          pc.unit_cost as unit_cost

        into v_sel

        from public.combo_skewer_options o

        join public.products p
          on p.id = o.skewer_product_id

        left join public.product_costs pc
          on pc.product_id = p.id

        where o.combo_id = v_product.id
          and o.skewer_product_id =
              (v_selection->>'product_id')::uuid
        for update of p;


        if v_sel.id is null
           or v_sel.active is not true then

          raise exception
            'Espeto inválido para o combo %',
            v_product.name;

        end if;


        if v_sel.is_available is not true then

          raise exception
            'Espeto % indisponível no momento',
            v_sel.name;

        end if;


        if v_sel.extra_price < 0 then
          raise exception
            'Acréscimo inválido no combo %',
            v_product.name;
        end if;


        v_custos_espetos :=
          v_custos_espetos
          || jsonb_build_object(v_sel.id::text, v_sel.unit_cost);


        v_extras_per_unit :=
          v_extras_per_unit
          + (v_sel.extra_price * v_selection_qty);

      end loop;


      -- ------------------------------------------------------
      -- ACOMPANHAMENTOS
      -- ------------------------------------------------------

      v_qtd_lados := (

        select coalesce(
          sum((s->>'quantity')::integer),
          0
        )

        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'sides',
            '[]'::jsonb
          )
        ) s

      );


      if v_qtd_lados <> v_allowed_sides then

        raise exception
          'Quantidade de acompanhamentos inválida para %',
          v_product.name;

      end if;


      for v_selection in

        select *
        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'sides',
            '[]'::jsonb
          )
        )

      loop

        v_selection_qty :=
          nullif(
            v_selection->>'quantity',
            ''
          )::integer;


        if v_selection_qty is null
           or v_selection_qty < 1 then

          raise exception
            'Quantidade de acompanhamento inválida';

        end if;


        select
          p.id,
          p.name,
          p.active,
          p.category,
          p.is_available,
          pc.unit_cost as unit_cost

        into v_sel

        from public.products p

        left join public.product_costs pc
          on pc.product_id = p.id

        where p.id =
          (v_selection->>'product_id')::uuid
        for update of p;


        if v_sel.id is null
           or v_sel.active is not true
           or v_sel.category <> 'sides' then

          raise exception
            'Acompanhamento inválido para o combo %',
            v_product.name;

        end if;


        if v_sel.is_available is not true then

          raise exception
            'Acompanhamento % indisponível no momento',
            v_sel.name;

        end if;


        if exists (

          select 1

          from public.combo_included_products cip

          where cip.combo_id = v_product.id
            and cip.included_product_id = v_sel.id

        ) then

          raise exception
            'Acompanhamento já incluso não pode ser selecionado';

        end if;


        v_custos_lados :=
          v_custos_lados
          || jsonb_build_object(v_sel.id::text, v_sel.unit_cost);

      end loop;


    end if;


    -- ========================================================
    -- TOTAL DA LINHA
    -- ========================================================

    v_extras_line_total :=
      v_extras_per_unit * v_item_qty;


    v_line_total :=
      (v_unit_price * v_item_qty)
      + v_extras_line_total;


    v_subtotal :=
      v_subtotal + v_line_total;


    insert into public.order_items (

      order_id,
      product_id,
      product_name,

      item_type,
      quantity,

      unit_price,
      extras_total,
      total_price,

      unit_cost_snapshot

    )
    values (

      v_order_id,
      v_product.id,
      v_product.name,

      v_item_type,
      v_item_qty,

      v_unit_price,
      v_extras_line_total,
      v_line_total,

      case when v_item_type = 'product' then v_product.unit_cost else null end

    )
    returning id into v_item_id;


    -- ========================================================
    -- BAIXA DE ESTOQUE — PRODUTO SIMPLES
    -- Combos não têm estoque próprio; os componentes baixam
    -- mais abaixo, no snapshot do combo.
    -- ========================================================

    if v_item_type = 'product' then

      update public.products
         set stock_quantity = stock_quantity - v_item_qty,
             updated_at = now()
       where id = v_product.id
         and stock_quantity >= v_item_qty
      returning stock_quantity into v_new_stock;

      if not found then
        raise exception 'Estoque insuficiente para %', v_product.name;
      end if;

      insert into public.stock_movements (
        product_id, order_id, movement_type,
        quantity_change, previous_quantity, new_quantity
      )
      values (
        v_product.id, v_order_id, 'sale',
        -v_item_qty, v_new_stock + v_item_qty, v_new_stock
      );

    end if;


    -- ========================================================
    -- SNAPSHOT DAS ESCOLHAS DO COMBO
    -- ========================================================

    if v_item_type = 'combo' then


      -- ESPETOS

      for v_selection in

        select *
        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'skewers',
            '[]'::jsonb
          )
        )

      loop

        select
          p.id,
          p.name,
          o.extra_price

        into v_sel

        from public.combo_skewer_options o

        join public.products p
          on p.id = o.skewer_product_id

        where o.combo_id = v_product.id
          and o.skewer_product_id =
              (v_selection->>'product_id')::uuid;

        v_custo_componente :=
          (v_custos_espetos ->> v_sel.id::text)::numeric;


        v_qtd_baixa := (v_selection->>'quantity')::integer * v_item_qty;

        update public.products
           set stock_quantity = stock_quantity - v_qtd_baixa,
               updated_at = now()
         where id = v_sel.id
           and stock_quantity >= v_qtd_baixa
        returning stock_quantity into v_new_stock;

        if not found then
          raise exception 'Estoque insuficiente para %', v_sel.name;
        end if;

        insert into public.stock_movements (
          product_id, order_id, movement_type,
          quantity_change, previous_quantity, new_quantity
        )
        values (
          v_sel.id, v_order_id, 'sale',
          -v_qtd_baixa, v_new_stock + v_qtd_baixa, v_new_stock
        );


        insert into public.order_item_selections (

          order_item_id,
          selection_type,

          selected_product_id,
          selected_product_name,

          quantity,
          extra_price,

          unit_cost_snapshot

        )
        values (

          v_item_id,
          'skewer',

          v_sel.id,
          v_sel.name,

          (v_selection->>'quantity')::integer,
          v_sel.extra_price,

          v_custo_componente

        );

      end loop;


      -- ACOMPANHAMENTOS

      for v_selection in

        select *
        from jsonb_array_elements(
          coalesce(
            v_item->'selections'->'sides',
            '[]'::jsonb
          )
        )

      loop

        select
          p.id,
          p.name

        into v_sel

        from public.products p

        where p.id =
          (v_selection->>'product_id')::uuid;

        v_custo_componente :=
          (v_custos_lados ->> v_sel.id::text)::numeric;


        v_qtd_baixa := (v_selection->>'quantity')::integer * v_item_qty;

        update public.products
           set stock_quantity = stock_quantity - v_qtd_baixa,
               updated_at = now()
         where id = v_sel.id
           and stock_quantity >= v_qtd_baixa
        returning stock_quantity into v_new_stock;

        if not found then
          raise exception 'Estoque insuficiente para %', v_sel.name;
        end if;

        insert into public.stock_movements (
          product_id, order_id, movement_type,
          quantity_change, previous_quantity, new_quantity
        )
        values (
          v_sel.id, v_order_id, 'sale',
          -v_qtd_baixa, v_new_stock + v_qtd_baixa, v_new_stock
        );


        insert into public.order_item_selections (

          order_item_id,
          selection_type,

          selected_product_id,
          selected_product_name,

          quantity,
          extra_price,

          unit_cost_snapshot

        )
        values (

          v_item_id,
          'side',

          v_sel.id,
          v_sel.name,

          (v_selection->>'quantity')::integer,
          0,

          v_custo_componente

        );

      end loop;


      -- ITENS INCLUSOS
      -- Sempre vêm do banco, nunca do payload.

      for v_sel in

        select
          p.id,
          p.name,
          p.active,
          p.is_available,
          cip.quantity,
          pc.unit_cost as unit_cost

        from public.combo_included_products cip

        join public.products p
          on p.id = cip.included_product_id

        left join public.product_costs pc
          on pc.product_id = p.id

        where cip.combo_id = v_product.id
        for update of p

      loop

        if v_sel.active is not true then

          raise exception
            'Item incluso % está indisponível',
            v_sel.name;

        end if;


        if v_sel.is_available is not true then

          raise exception
            'Item incluso % está indisponível no momento',
            v_sel.name;

        end if;


        v_qtd_baixa := v_sel.quantity * v_item_qty;

        update public.products
           set stock_quantity = stock_quantity - v_qtd_baixa,
               updated_at = now()
         where id = v_sel.id
           and stock_quantity >= v_qtd_baixa
        returning stock_quantity into v_new_stock;

        if not found then
          raise exception 'Estoque insuficiente para %', v_sel.name;
        end if;

        insert into public.stock_movements (
          product_id, order_id, movement_type,
          quantity_change, previous_quantity, new_quantity
        )
        values (
          v_sel.id, v_order_id, 'sale',
          -v_qtd_baixa, v_new_stock + v_qtd_baixa, v_new_stock
        );


        insert into public.order_item_selections (

          order_item_id,
          selection_type,

          selected_product_id,
          selected_product_name,

          quantity,
          extra_price,

          unit_cost_snapshot

        )
        values (

          v_item_id,
          'included',

          v_sel.id,
          v_sel.name,

          v_sel.quantity,
          0,

          v_sel.unit_cost

        );

      end loop;

    end if;

  end loop;


  -- ==========================================================
  -- CUPONS (v1: no máximo 1 monetário + 1 free_delivery)
  --
  -- Precedência payload->'coupon_codes' (array) vs. payload->>'coupon_code' (legado): o array,
  -- quando presente e não-vazio, tem prioridade TOTAL — o campo legado é ignorado por completo
  -- nesse caso, nunca mesclado, pra nunca gerar aplicação duplicada do mesmo código. O campo
  -- legado só é usado quando a chave coupon_codes estiver ausente, for JSON null explícito, ou
  -- for um array vazio (mantém o fluxo WhatsApp funcionando sem mudança:
  -- create_order_from_whatsapp_session só envia coupon_code).
  --
  -- Validação estrita: se a chave existir com um valor que NÃO seja array (string/objeto/
  -- número/boolean), é erro explícito — nunca fallback silencioso pro campo legado. Dentro do
  -- array, cada elemento precisa ser string não vazia após trim — null, número, objeto,
  -- boolean ou string vazia/só espaços são rejeitados com exception, nunca descartados em
  -- silêncio.
  -- ==========================================================

  if v_coupon_codes_raw is null or jsonb_typeof(v_coupon_codes_raw) = 'null' then

    -- Chave ausente ou JSON null explícito: mesmo tratamento — usa o campo legado, se houver.
    if v_legacy_coupon_code is not null then
      v_coupon_codes := array[v_legacy_coupon_code];
    end if;

  elsif jsonb_typeof(v_coupon_codes_raw) <> 'array' then

    raise exception 'coupon_codes precisa ser um array de códigos de cupom.';

  elsif jsonb_array_length(v_coupon_codes_raw) = 0 then

    -- Array vazio: fallback pro campo legado, conforme regra já definida.
    if v_legacy_coupon_code is not null then
      v_coupon_codes := array[v_legacy_coupon_code];
    end if;

  else

    -- Array não-vazio: prioridade total sobre coupon_code (legado é ignorado por completo).
    for v_coupon_element in select * from jsonb_array_elements(v_coupon_codes_raw) loop

      if jsonb_typeof(v_coupon_element) <> 'string' then
        raise exception 'Todos os códigos em coupon_codes precisam ser strings não vazias.';
      end if;

      v_code := nullif(upper(trim(v_coupon_element #>> '{}')), '');

      if v_code is null then
        raise exception 'Todos os códigos em coupon_codes precisam ser strings não vazias.';
      end if;

      v_coupon_codes := array_append(v_coupon_codes, v_code);

    end loop;

  end if;

  if coalesce(array_length(v_coupon_codes, 1), 0) > 2 then
    raise exception 'No máximo 2 cupons podem ser aplicados por pedido.';
  end if;

  if coalesce(array_length(v_coupon_codes, 1), 0) > 1
     and array_length(v_coupon_codes, 1) <> (
       select count(distinct c) from unnest(v_coupon_codes) c
     ) then
    raise exception 'O mesmo código de cupom foi informado mais de uma vez.';
  end if;

  foreach v_code in array v_coupon_codes loop

    v_coupon_result := public.validate_coupon(v_code, v_subtotal);

    if (v_coupon_result->>'discount_type') = 'free_delivery' then

      v_free_delivery_count := v_free_delivery_count + 1;

      if v_free_delivery_count > 1 then
        raise exception 'Apenas um cupom de frete grátis pode ser aplicado por pedido.';
      end if;

      v_free_delivery := v_coupon_result;

    else

      v_monetary_count := v_monetary_count + 1;

      if v_monetary_count > 1 then
        raise exception 'Apenas um cupom de desconto (percentual ou fixo) pode ser aplicado por pedido.';
      end if;

      v_monetary := v_coupon_result;

    end if;

  end loop;

  -- Colunas legadas de orders: cupom monetário tem prioridade de representação; na ausência
  -- dele, free_delivery as representa — preserva o comportamento de sempre pra quem usa 1
  -- cupom só, de qualquer tipo (percentage, fixed OU free_delivery).
  if v_monetary is not null then

    v_coupon_code := v_monetary->>'code';
    v_coupon_id := (v_monetary->>'coupon_id')::uuid;
    v_discount_type := v_monetary->>'discount_type';
    v_discount_value := (v_monetary->>'discount_value')::numeric;
    v_discount_amount := (v_monetary->>'discount_amount')::numeric;

  elsif v_free_delivery is not null then

    v_coupon_code := v_free_delivery->>'code';
    v_coupon_id := (v_free_delivery->>'coupon_id')::uuid;
    v_discount_type := v_free_delivery->>'discount_type';
    v_discount_value := (v_free_delivery->>'discount_value')::numeric;
    v_discount_amount := 0;

  end if;


  -- ==========================================================
  -- FREE DELIVERY — zera a taxa de entrega EFETIVAMENTE cobrada, nunca o
  -- subtotal/desconto de produto (v_discount_amount de free_delivery é sempre 0, garantido por
  -- validate_coupon). Condição em v_free_delivery IS NOT NULL — não mais em v_discount_type =
  -- 'free_delivery' como na versão anterior: agora v_discount_type pode estar ocupado pelo
  -- cupom monetário quando os dois são combinados, então checar v_discount_type quebraria a
  -- combinação percentage+free_delivery. Só roda quando TODAS as condições batem: fulfilment é
  -- delivery (Pick Up/Dine In já são delivery_fee=0 — nunca entram aqui, nunca geram crédito
  -- monetário), e v_delivery_fee já foi lido da cotação autoritativa (nunca do payload) e é > 0.
  -- ==========================================================

  if v_free_delivery is not null
     and v_fulfilment = 'delivery'
     and v_delivery_fee > 0 then

    v_original_delivery_fee := v_delivery_fee;
    v_delivery_fee := 0;

  end if;


  -- ==========================================================
  -- SNAPSHOT EM order_coupons — um registro por cupom efetivamente aplicado, preservando
  -- histórico independente das colunas legadas de orders (que só guardam 1 representante).
  -- ==========================================================

  if v_monetary is not null then

    insert into public.order_coupons (
      order_id, coupon_id, coupon_code, discount_type, discount_value, discount_amount
    ) values (
      v_order_id,
      (v_monetary->>'coupon_id')::uuid,
      v_monetary->>'code',
      v_monetary->>'discount_type',
      (v_monetary->>'discount_value')::numeric,
      (v_monetary->>'discount_amount')::numeric
    );

  end if;

  if v_free_delivery is not null then

    insert into public.order_coupons (
      order_id, coupon_id, coupon_code, discount_type, discount_value, discount_amount
    ) values (
      v_order_id,
      (v_free_delivery->>'coupon_id')::uuid,
      v_free_delivery->>'code',
      v_free_delivery->>'discount_type',
      (v_free_delivery->>'discount_value')::numeric,
      0
    );

  end if;


  -- ==========================================================
  -- TOTAL FINAL
  -- ==========================================================

  v_total :=
    greatest(0, v_subtotal - v_discount_amount) + v_delivery_fee;


  -- ==========================================================
  -- TROCO
  -- ==========================================================

  if v_payment = 'cash'
     and v_needs_change then

    v_cash_amount :=
      nullif(
        payload->>'cash_amount',
        ''
      )::numeric;


    if v_cash_amount is null
       or v_cash_amount < v_total then

      raise exception
        'Valor pago insuficiente para o troco';

    end if;


    v_change :=
      v_cash_amount - v_total;

  else

    v_cash_amount := null;
    v_change := null;

  end if;


  -- ==========================================================
  -- ATUALIZA TOTAL
  -- ==========================================================

  update public.orders

  set
    subtotal = v_subtotal,
    total = v_total,
    delivery_fee = v_delivery_fee,
    original_delivery_fee = v_original_delivery_fee,
    cash_amount = v_cash_amount,
    change_amount = v_change,
    coupon_id = v_coupon_id,
    coupon_code = v_coupon_code,
    discount_type = v_discount_type,
    discount_value = v_discount_value,
    discount_amount = v_discount_amount

  where id = v_order_id;


  -- ==========================================================
  -- RETORNO PARA O CLIENTE
  -- ==========================================================

  select jsonb_build_object(

    'id', o.id,
    'order_number', o.order_number,
    'status', o.status,

    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'original_delivery_fee', o.original_delivery_fee,
    'total', o.total,

    'coupon_code', o.coupon_code,
    'discount_amount', o.discount_amount,

    'applied_coupons', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'coupon_code', oc.coupon_code,
          'discount_type', oc.discount_type,
          'discount_value', oc.discount_value,
          'discount_amount', oc.discount_amount
        )
        order by oc.created_at
      )
      from public.order_coupons oc
      where oc.order_id = o.id
    ), '[]'::jsonb),

    'created_at', o.created_at

  )

  into v_result

  from public.orders o
  where o.id = v_order_id;


  return v_result;

end;
$function$;
