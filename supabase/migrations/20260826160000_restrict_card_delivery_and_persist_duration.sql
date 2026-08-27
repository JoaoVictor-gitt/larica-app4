-- Acompanhamento público de pedido + regra cartao/entrega (W-tracking).
-- CREATE OR REPLACE de create_customer_order — corpo copiado
-- integralmente do definido em 20260817140000_add_product_costs_and_snapshot.sql
-- (a migration histórica NÃO é editada), com 3 deltas cirúrgicos:
--
-- 1) Nova variável v_delivery_duration_seconds, populada a partir de
--    delivery_quotes.duration_seconds (coluna nova,
--    20260826140000_add_duration_seconds_to_delivery_quotes.sql) e
--    persistida em orders.delivery_duration_seconds (coluna nova,
--    20260826150000_add_delivery_duration_seconds_to_orders.sql) — mesmo
--    padrão de snapshot já usado por delivery_distance_km/delivery_fee.
--    v_quote é `record`: só é lido no ramo 'delivery' (nunca no ramo
--    'collection', onde nunca foi populado — plpgsql lançaria "record
--    não atribuído" se lido fora do ramo que o preenche).
--
-- 2) Nova regra de negócio: payment_method='card' + fulfilment_type=
--    'delivery' é rejeitado (sem maquininha de cartão para entrega
--    ainda). collection+card continua permitido normalmente; nenhum
--    outro método de pagamento é afetado.
--
-- Nenhuma outra linha desta função foi alterada — preço/estoque/combo/
-- cupom/horário de funcionamento continuam exatamente como já eram.
-- Sem REVOKE/GRANT novo (a função nunca teve um explícito antes desta
-- migration; esta redefinição preserva o mesmo comportamento de
-- permissão de hoje).
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

  -- ==========================================================
  -- CUSTOS (Etapa 1 — Custos/Margem): custo de cada espeto/acompanhamento
  -- de combo, capturado uma única vez no laço de validação e reaproveitado
  -- no laço de snapshot mais abaixo (nunca uma segunda leitura de
  -- product_costs — ver comentário acima da função). Formato jsonb:
  -- {"<product_id>": custo_ou_null}. Reiniciado a cada item de combo.
  -- ==========================================================

  v_custos_espetos jsonb;
  v_custos_lados jsonb;
  v_custo_componente numeric(12,4);

  -- ==========================================================
  -- DISPONIBILIDADE DO NEGÓCIO (Fase 4)
  -- ==========================================================

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

  -- ==========================================================
  -- CUPOM DE DESCONTO (Fase 10B)
  -- ==========================================================

  v_coupon_code text;
  v_coupon_result jsonb;
  v_coupon_id uuid := null;
  v_discount_type text := null;
  v_discount_value numeric := null;
  v_discount_amount numeric := 0;

begin

  -- ==========================================================
  -- DISPONIBILIDADE DO NEGÓCIO (Fase 4 — nunca confia no payload;
  -- roda ANTES de qualquer validação/efeito colateral existente)
  -- ==========================================================

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


  -- ==========================================================
  -- DADOS BÁSICOS
  -- ==========================================================

  if coalesce(trim(payload->>'customer_name'), '') = '' then
    raise exception 'Nome do cliente é obrigatório';
  end if;

  if coalesce(trim(payload->>'customer_phone'), '') = '' then
    raise exception 'Telefone do cliente é obrigatório';
  end if;


  if v_fulfilment not in ('collection', 'delivery') then
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
  -- RETIRADA / ENTREGA
  -- ==========================================================

  if v_fulfilment = 'collection' then

    v_delivery_fee := 0;
    v_delivery_distance := null;
    v_delivery_duration_seconds := null;

    if nullif(payload->>'pickup_time', '') is not null then
      v_pickup_time :=
        (payload->>'pickup_time')::time;
    end if;

  else

    if coalesce(trim(payload->>'address_line_1'), '') = '' then
      raise exception 'Endereço é obrigatório para entrega';
    end if;

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
    trim(payload->>'customer_phone'),

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


    -- Disponibilidade operacional (Etapa 2): trava a linha do produto até o
    -- fim da transação, pra ninguém conseguir alternar is_available embaixo
    -- do pedido entre esta validação e a baixa de estoque mais abaixo.
    -- Custos (Etapa 1 — Custos/Margem): LEFT JOIN product_costs pra trazer
    -- o custo atual junto — "FOR UPDATE OF p" nomeia o alias porque agora
    -- há um outer join na consulta (sem isso o Postgres recusa o FOR
    -- UPDATE); nenhum lock novo é tomado sobre product_costs, só sobre p,
    -- exatamente como antes.
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


    -- Evita enviar combo como produto comum ou vice-versa

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

      -- Custos (Etapa 1): reinicia o acumulador de custo deste item de
      -- combo — cada v_item de combo tem seu próprio mapa, nunca
      -- reaproveitado entre itens diferentes do mesmo pedido.
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


        -- Disponibilidade operacional (Etapa 2): FOR UPDATE OF p só trava a
        -- linha de products (o alias da config do combo, o, não precisa).
        -- Custo (Etapa 1): LEFT JOIN product_costs pra ler o custo atual
        -- do espeto já aqui — única leitura de custo deste componente em
        -- toda a função (ver comentário no topo do arquivo).
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


        -- Custo (Etapa 1, segunda revisão): guarda o custo já lido acima
        -- em memória, indexado por product_id — é essa cópia que o laço
        -- de snapshot mais abaixo vai usar, sem reconsultar product_costs.
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


        -- Disponibilidade operacional (Etapa 2). Custo (Etapa 1): LEFT
        -- JOIN product_costs pra ler o custo atual já aqui — única
        -- leitura de custo deste componente em toda a função. "FOR UPDATE
        -- OF p" (em vez do "FOR UPDATE" sem qualificação de antes) passa
        -- a ser necessário porque agora a consulta tem um outer join —
        -- sem qualificar, o Postgres recusaria travar o lado nullable.
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


        -- Custo (Etapa 1, segunda revisão): mesma técnica do espeto acima
        -- — guarda o custo já lido na validação em memória, indexado por
        -- product_id, pra o laço de snapshot mais abaixo reaproveitar sem
        -- reconsultar product_costs.
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


    -- Custo (Etapa 1 — Custos/Margem): unit_cost_snapshot em order_items só
    -- existe para item_type='product' (custo lido acima, via product_costs).
    -- Para item_type='combo' fica sempre NULL aqui — o custo real do combo
    -- mora nas selections (espetos/acompanhamentos/inclusos), somadas numa
    -- fase futura; usar o custo do produto-combo em si duplicaria o CMV.
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

        -- Custo (Etapa 1, segunda revisão): não reconsulta product_costs
        -- aqui — reaproveita o valor já capturado no laço de validação
        -- acima (v_custos_espetos), única leitura de custo deste
        -- componente em toda a função. Nunca extra_price, que continua
        -- sendo só receita.
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

        -- Custo (Etapa 1, segunda revisão): não reconsulta product_costs
        -- aqui — reaproveita o valor já capturado no laço de validação
        -- acima (v_custos_lados), única leitura de custo deste componente
        -- em toda a função. Acompanhamentos não têm extra_price (sempre
        -- 0), mas têm custo próprio e precisam do snapshot igual aos
        -- espetos.
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
      -- Disponibilidade operacional (Etapa 2): FOR UPDATE OF p trava cada
      -- produto incluso enquanto o loop percorre os itens do combo.
      -- Custo (Etapa 1): mesmo LEFT JOIN product_costs — Farofa/Molho de
      -- Alho etc. têm custo próprio mesmo sendo grátis pro cliente.

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
  -- CUPOM DE DESCONTO (Fase 10B)
  -- v_subtotal já é conhecido aqui (fim do loop de itens) e
  -- nada de total/troco foi calculado ainda. Revalida sempre
  -- server-side via validate_coupon — nunca confia em nada do
  -- payload além do código em texto puro. Se inválido/expirado,
  -- validate_coupon já dá RAISE EXCEPTION, que desfaz (rollback)
  -- tudo que essa chamada já fez até aqui (header, itens,
  -- baixas de estoque, stock_movements).
  -- ==========================================================

  v_coupon_code := nullif(upper(trim(payload->>'coupon_code')), '');

  if v_coupon_code is not null then

    v_coupon_result := public.validate_coupon(v_coupon_code, v_subtotal);

    v_coupon_id := (v_coupon_result->>'coupon_id')::uuid;
    v_discount_type := v_coupon_result->>'discount_type';
    v_discount_value := (v_coupon_result->>'discount_value')::numeric;
    v_discount_amount := (v_coupon_result->>'discount_amount')::numeric;

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
    'total', o.total,

    'coupon_code', o.coupon_code,
    'discount_amount', o.discount_amount,

    'created_at', o.created_at

  )

  into v_result

  from public.orders o
  where o.id = v_order_id;


  return v_result;

end;
$function$;
