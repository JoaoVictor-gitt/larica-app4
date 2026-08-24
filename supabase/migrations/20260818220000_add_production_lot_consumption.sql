-- Integração de Lotes de Compra com Produção — ETAPA G2 (consumo/
-- reconciliação de lotes nas RPCs de save).
--
-- Evolui save_skewer_production_batch/save_side_production_batch para que
-- um componente item_type='ingredient' possa opcionalmente trazer lot_id
-- (coluna já existente desde a Etapa G1). Quando lot_id vem preenchido:
-- custo/unidade são resolvidos a partir do LOTE (lots.unit_cost_base/
-- base_unit), nunca do cadastro atual do ingrediente nem de um valor
-- enviado pelo client; o saldo do lote é consumido/devolvido dentro da
-- própria transação, com reconciliação por delta líquido (nunca reversal
-- total + reconsumo total) comparando o consumo já registrado em
-- lot_movements (old_net) contra o novo payload (new_net), por lote.
-- lot_id ausente/NULL preserva o comportamento já existente, byte a byte
-- (custo do cadastro atual, nenhuma baixa de estoque) — mecanismo de
-- transição gradual.
--
-- CORREÇÃO (revisão pré-execução, migration ainda não executada, editada
-- em lugar): (1) valida purchase_items.tracks_stock=true quando um
-- componente ingredient traz lot_id — antes só ingredient_id era
-- validado; (2) elimina a janela de concorrência em que base_unit/
-- unit_cost_base/vínculo do lote eram lidos ANTES do SELECT ... FOR
-- UPDATE — agora todo dado mutável do lote só é lido DEPOIS do lock
-- (Fase 3), nunca antes. A Fase 1 passa a gravar componentes
-- ingredient+lot_id numa tabela intermediária (tmp_..._pending_lots),
-- sem ler nada do lote; só depois do lock (Fase 2) a Fase 3 resolve
-- vínculo/tracks_stock/base_unit/unit_cost_base de verdade. old_net/
-- new_net/delta (Fase 4) e persistência de componentes (Fase 5)
-- permanecem exatamente como já aprovado.
--
-- NÃO altera schema (lot_id já existe desde a Etapa G1). NÃO cria RPCs de
-- exclusão (Etapa G3, futura — o DELETE direto de lote de produção
-- continua sendo um risco conhecido e documentado até lá). NÃO altera UI
-- (producao.html/producao.js/producao.css — Etapa G4). NÃO altera Compras
-- (save_purchase, finalize_purchase_item, create_lot_from_purchase_line,
-- compras.html/js/css) nem Pedidos (create_customer_order,
-- products.stock_quantity, stock_movements, checkout) nem
-- apply_skewer_production_cost/apply_side_production_cost (continuam
-- lendo só unit_cost_snapshot já persistido, indiferentes à origem).
-- Mesma assinatura de parâmetros das duas RPCs — nenhum GRANT/REVOKE
-- necessário (CREATE OR REPLACE preserva os privilégios já concedidos).
-- Migrations já executadas não são editadas.

-- =============================================================
-- 1. save_skewer_production_batch — CREATE OR REPLACE.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_skewer_production_batch(
  p_batch_id uuid,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_produced_at date,
  p_gross_weight_g numeric,
  p_usable_weight_g numeric,
  p_total_cost numeric,
  p_skewer_weight_g numeric,
  p_actual_quantity integer,
  p_components jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_batch public.skewer_production_batches%rowtype;
  v_component jsonb;
  v_item_type text;
  v_reference_id uuid;
  v_lot_id uuid;
  v_quantity numeric;
  v_unit text;
  v_unit_cost numeric;
  v_name_snapshot text;
  v_ingredient record;
  v_supply record;
  v_lot record;
  v_pending record;
  v_seen_keys text[] := '{}';
  v_key text;
  v_lot_ids uuid[];
  v_rec record;
  v_extra numeric;
  v_restore numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_recipe_unidades int;
  v_recipe_unit text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar lotes de produção.';
  end if;

  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Produto não encontrado.';
  end if;
  if p_ingredient_id is not null and not exists (select 1 from public.ingredients where id = p_ingredient_id) then
    raise exception 'Ingrediente não encontrado.';
  end if;
  if p_gross_weight_g is null or p_gross_weight_g <= 0 then raise exception 'Peso bruto inválido.'; end if;
  if p_usable_weight_g is null or p_usable_weight_g <= 0 then raise exception 'Peso útil inválido.'; end if;
  if p_usable_weight_g > p_gross_weight_g then raise exception 'Peso útil não pode exceder o peso bruto.'; end if;
  if p_total_cost is null or p_total_cost < 0 then raise exception 'Custo total inválido.'; end if;
  if p_skewer_weight_g is null or p_skewer_weight_g <= 0 then raise exception 'Peso por espeto inválido.'; end if;
  if p_actual_quantity is null or p_actual_quantity <= 0 then raise exception 'Quantidade produzida inválida.'; end if;
  if p_produced_at is null then raise exception 'Data de produção obrigatória.'; end if;

  if p_batch_id is null then
    insert into public.skewer_production_batches (
      product_id, ingredient_id, produced_at, gross_weight_g, usable_weight_g,
      total_cost, skewer_weight_g, actual_quantity, created_by, updated_by
    ) values (
      p_product_id, p_ingredient_id, p_produced_at, p_gross_weight_g, p_usable_weight_g,
      p_total_cost, p_skewer_weight_g, p_actual_quantity, v_user_id, v_user_id
    )
    returning * into v_batch;
  else
    perform 1 from public.skewer_production_batches where id = p_batch_id for update;
    if not found then
      raise exception 'Lote de produção não encontrado.';
    end if;

    update public.skewer_production_batches set
      product_id = p_product_id,
      ingredient_id = p_ingredient_id,
      produced_at = p_produced_at,
      gross_weight_g = p_gross_weight_g,
      usable_weight_g = p_usable_weight_g,
      total_cost = p_total_cost,
      skewer_weight_g = p_skewer_weight_g,
      actual_quantity = p_actual_quantity,
      updated_at = now(),
      updated_by = v_user_id
    where id = p_batch_id
    returning * into v_batch;
  end if;

  if p_components is not null and jsonb_typeof(p_components) <> 'array' then
    raise exception 'Componentes do lote devem ser enviados como uma lista.';
  end if;

  -- ================================================================
  -- Fase 1 — parse + validação estrutural. recipe/supply/ingredient sem
  -- lote são resolvidos e persistidos direto na tabela final (nenhum
  -- depende de dado mutável de lots). ingredient COM lote só grava a
  -- intenção (ingredient_id/lot_id/quantity/unit/nome) numa tabela
  -- intermediária — base_unit/unit_cost_base/vínculo do lote NUNCA são
  -- lidos aqui, só depois do lock (Fase 3).
  -- ================================================================

  create temporary table if not exists pg_temp.tmp_skewer_components (
    item_type text,
    ingredient_id uuid,
    recipe_id uuid,
    supply_id uuid,
    lot_id uuid,
    name_snapshot text,
    quantity numeric,
    unit text,
    unit_cost numeric
  ) on commit drop;
  truncate table pg_temp.tmp_skewer_components;

  create temporary table if not exists pg_temp.tmp_skewer_pending_lots (
    ingredient_id uuid,
    lot_id uuid,
    name_snapshot text,
    quantity numeric,
    unit text
  ) on commit drop;
  truncate table pg_temp.tmp_skewer_pending_lots;

  if p_components is not null then
    for v_component in select * from jsonb_array_elements(p_components) loop
      if jsonb_typeof(v_component) <> 'object' then
        raise exception 'Componente do lote inválido.';
      end if;

      v_item_type := v_component->>'item_type';
      v_unit := v_component->>'unit';

      begin
        v_reference_id := (v_component->>'reference_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Referência inválida para o componente.';
      end;

      begin
        v_quantity := (v_component->>'quantity')::numeric;
      exception when invalid_text_representation then
        raise exception 'Quantidade inválida para o componente.';
      end;

      begin
        v_lot_id := (v_component->>'lot_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Lote inválido para o componente.';
      end;

      if v_item_type not in ('ingredient', 'recipe', 'supply') then
        raise exception 'Tipo de componente inválido.';
      end if;
      if v_reference_id is null then
        raise exception 'Componente sem referência.';
      end if;
      if v_quantity is null or v_quantity <= 0 then
        raise exception 'Quantidade inválida para o componente.';
      end if;
      if v_unit is null or v_unit not in ('g', 'ml', 'un') then
        raise exception 'Unidade inválida para o componente.';
      end if;
      if v_lot_id is not null and v_item_type <> 'ingredient' then
        raise exception 'Somente componentes de ingrediente podem ter lote.';
      end if;

      -- Duplicidade: chave inclui lot_id (só relevante quando != NULL) —
      -- permite o mesmo ingrediente em dois lotes diferentes, mas
      -- continua rejeitando o mesmo ingrediente+mesmo lote (ou mesmo
      -- ingrediente sem lote) duas vezes.
      v_key := v_item_type || ':' || v_reference_id::text || ':' || coalesce(v_lot_id::text, 'sem-lote');
      if v_key = any (v_seen_keys) then
        raise exception 'Componente duplicado no lote.';
      end if;
      v_seen_keys := v_seen_keys || v_key;

      if v_item_type = 'ingredient' then
        select id, name, base_unit, cost_per_base_unit
          into v_ingredient
          from public.ingredients
         where id = v_reference_id;
        if v_ingredient.id is null then
          raise exception 'Ingrediente não encontrado.';
        end if;

        if v_lot_id is not null then
          insert into pg_temp.tmp_skewer_pending_lots (
            ingredient_id, lot_id, name_snapshot, quantity, unit
          ) values (
            v_reference_id, v_lot_id, v_ingredient.name, v_quantity, v_unit
          );
          continue;
        else
          if v_unit <> v_ingredient.base_unit then
            raise exception 'Unidade incompatível com o ingrediente.';
          end if;
          v_name_snapshot := v_ingredient.name;
          v_unit_cost := v_ingredient.cost_per_base_unit;
        end if;

      elsif v_item_type = 'supply' then
        select id, name, unit_type, cost_per_unit
          into v_supply
          from public.production_supplies
         where id = v_reference_id;
        if v_supply.id is null then
          raise exception 'Insumo não encontrado.';
        end if;
        if v_unit <> 'un' or v_supply.unit_type <> 'un' then
          raise exception 'Unidade inválida para insumo.';
        end if;
        v_name_snapshot := v_supply.name;
        v_unit_cost := v_supply.cost_per_unit;

      else -- recipe
        if not exists (select 1 from public.recipes where id = v_reference_id) then
          raise exception 'Ficha técnica não encontrada.';
        end if;

        select count(distinct unit) into v_recipe_unidades
          from public.recipe_items
         where recipe_id = v_reference_id;
        if v_recipe_unidades is null or v_recipe_unidades = 0 then
          raise exception 'Esta ficha técnica ainda não tem itens suficientes para ser usada como componente.';
        end if;
        if v_recipe_unidades > 1 then
          raise exception 'Esta ficha técnica tem unidades mistas e não pode ser usada como componente.';
        end if;

        select unit into v_recipe_unit
          from public.recipe_items
         where recipe_id = v_reference_id
         limit 1;
        if v_unit <> v_recipe_unit then
          raise exception 'Unidade incompatível com o rendimento da ficha técnica.';
        end if;

        begin
          v_unit_cost := (v_component->>'unit_cost_snapshot')::numeric;
        exception when invalid_text_representation then
          raise exception 'Custo do componente de ficha técnica inválido.';
        end;
        if v_unit_cost is null or v_unit_cost < 0 then
          raise exception 'Custo do componente de ficha técnica inválido.';
        end if;

        select name into v_name_snapshot from public.recipes where id = v_reference_id;
      end if;

      insert into pg_temp.tmp_skewer_components (
        item_type, ingredient_id, recipe_id, supply_id, lot_id, name_snapshot, quantity, unit, unit_cost
      ) values (
        v_item_type,
        case when v_item_type = 'ingredient' then v_reference_id end,
        case when v_item_type = 'recipe' then v_reference_id end,
        case when v_item_type = 'supply' then v_reference_id end,
        null,
        v_name_snapshot,
        v_quantity,
        v_unit,
        v_unit_cost
      );
    end loop;
  end if;

  -- ================================================================
  -- Fase 2 — trava TODOS os lotes envolvidos (histórico + pendentes
  -- desta chamada) numa única passada, em ordem determinística — ANTES
  -- de qualquer leitura de base_unit/unit_cost_base/vínculo.
  -- ================================================================

  select coalesce(array_agg(distinct lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id from public.lot_movements
       where source_type = 'skewer_production' and source_id = v_batch.id and lot_id is not null
      union
      select lot_id from pg_temp.tmp_skewer_pending_lots
    ) x;

  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  -- ================================================================
  -- Fase 3 — só agora, com os lotes travados, resolve vínculo/
  -- tracks_stock/base_unit/unit_cost_base de cada componente pendente.
  -- Qualquer inconsistência aborta a função inteira.
  -- ================================================================

  for v_pending in select * from pg_temp.tmp_skewer_pending_lots loop
    select l.id, l.purchase_item_id, l.base_unit, l.unit_cost_base,
           pi.ingredient_id as pi_ingredient_id, pi.tracks_stock as pi_tracks_stock
      into v_lot
      from public.lots l
      join public.purchase_items pi on pi.id = l.purchase_item_id
     where l.id = v_pending.lot_id;

    if not found then
      raise exception 'Lote de estoque não encontrado.';
    end if;
    if v_lot.pi_ingredient_id is distinct from v_pending.ingredient_id then
      raise exception 'O lote selecionado não pertence a este ingrediente.';
    end if;
    if not v_lot.pi_tracks_stock then
      raise exception 'O item de compra vinculado a este lote não controla estoque.';
    end if;
    if v_pending.unit <> v_lot.base_unit then
      raise exception 'Unidade do lote incompatível com o componente.';
    end if;

    insert into pg_temp.tmp_skewer_components (
      item_type, ingredient_id, recipe_id, supply_id, lot_id, name_snapshot, quantity, unit, unit_cost
    ) values (
      'ingredient', v_pending.ingredient_id, null, null, v_pending.lot_id,
      v_pending.name_snapshot, v_pending.quantity, v_pending.unit, v_lot.unit_cost_base
    );
  end loop;

  -- ================================================================
  -- Fase 4 — reconciliação de saldo por lote (lógica inalterada, só
  -- reposicionada). old_net vem de lot_movements; new_net vem da tabela
  -- final, já 100% resolvida. Só gera movimento pros lotes cujo consumo
  -- líquido realmente mudou.
  -- ================================================================

  for v_rec in
    with old_net as (
      select lot_id,
             sum(case when movement_type = 'production_use' then quantity
                      when movement_type = 'reversal' then -quantity
                      else 0 end) as net
        from public.lot_movements
       where source_type = 'skewer_production'
         and source_id = v_batch.id
         and lot_id is not null
       group by lot_id
    ),
    new_net as (
      select lot_id, sum(quantity) as net
        from pg_temp.tmp_skewer_components
       where lot_id is not null
       group by lot_id
    )
    select coalesce(o.lot_id, n.lot_id) as lot_id,
           coalesce(o.net, 0) as old_net,
           coalesce(n.net, 0) as new_net
      from old_net o
      full outer join new_net n on n.lot_id = o.lot_id
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    if v_rec.new_net > v_rec.old_net then
      -- Consumo adicional líquido.
      v_extra := v_rec.new_net - v_rec.old_net;
      if v_lot.status = 'archived' then
        raise exception 'Este lote foi arquivado e não pode receber novo consumo.';
      end if;
      if v_lot.remaining_quantity < v_extra then
        raise exception 'Saldo insuficiente no lote selecionado.';
      end if;
      v_balance_before := v_lot.remaining_quantity;
      v_balance_after := v_lot.remaining_quantity - v_extra;
      v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

      update public.lots set
        remaining_quantity = v_balance_after,
        status = v_new_status,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_lot.id;

      insert into public.lot_movements (
        lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
        source_type, source_id, created_by
      ) values (
        v_lot.id, v_lot.purchase_item_id, 'production_use', v_extra, v_balance_before, v_balance_after,
        'skewer_production', v_batch.id, v_user_id
      );

    elsif v_rec.old_net > v_rec.new_net then
      -- Devolução líquida (parcial ou total).
      v_restore := v_rec.old_net - v_rec.new_net;
      v_balance_before := v_lot.remaining_quantity;
      v_balance_after := v_lot.remaining_quantity + v_restore;
      v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

      update public.lots set
        remaining_quantity = v_balance_after,
        status = v_new_status,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_lot.id;

      insert into public.lot_movements (
        lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
        source_type, source_id, created_by
      ) values (
        v_lot.id, v_lot.purchase_item_id, 'reversal', v_restore, v_balance_before, v_balance_after,
        'skewer_production', v_batch.id, v_user_id
      );
    end if;
    -- old_net = new_net: nenhum movimento, nenhuma alteração de saldo.
  end loop;

  -- ================================================================
  -- Fase 5 — substitui os componentes por completo, a partir da tabela
  -- de trabalho já validada e reconciliada.
  -- ================================================================

  delete from public.skewer_batch_components where batch_id = v_batch.id;

  insert into public.skewer_batch_components (
    batch_id, item_type, ingredient_id, recipe_id, supply_id, lot_id, name_snapshot, quantity, unit, unit_cost_snapshot
  )
  select v_batch.id, item_type, ingredient_id, recipe_id, supply_id, lot_id, name_snapshot, quantity, unit, unit_cost
    from pg_temp.tmp_skewer_components;

  return jsonb_build_object(
    'batch', to_jsonb(v_batch),
    'components', coalesce(
      (select jsonb_agg(to_jsonb(c)) from public.skewer_batch_components c where c.batch_id = v_batch.id),
      '[]'::jsonb
    )
  );
end;
$function$;

-- =============================================================
-- 2. save_side_production_batch — CREATE OR REPLACE. Mesmo tratamento —
-- sem supply, sem ingredient_id no cabeçalho do lote, source_type=
-- 'side_production', tabelas temporárias próprias
-- (pg_temp.tmp_side_components / pg_temp.tmp_side_pending_lots).
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_side_production_batch(
  p_batch_id uuid,
  p_product_id uuid,
  p_produced_at date,
  p_final_yield_quantity numeric,
  p_final_yield_unit text,
  p_portion_quantity numeric,
  p_portion_unit text,
  p_actual_portions integer,
  p_components jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_category text;
  v_theoretical_portions numeric;
  v_batch public.side_production_batches%rowtype;
  v_component jsonb;
  v_item_type text;
  v_reference_id uuid;
  v_lot_id uuid;
  v_quantity numeric;
  v_unit text;
  v_unit_cost numeric;
  v_name_snapshot text;
  v_ingredient record;
  v_lot record;
  v_pending record;
  v_seen_keys text[] := '{}';
  v_key text;
  v_lot_ids uuid[];
  v_rec record;
  v_extra numeric;
  v_restore numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_recipe_unidades int;
  v_recipe_unit text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar lotes de acompanhamento.';
  end if;

  select category into v_category from public.products where id = p_product_id;
  if v_category is null then
    raise exception 'Produto não encontrado.';
  end if;
  if v_category is distinct from 'sides' then
    raise exception 'Este produto não pertence à categoria Acompanhamentos.';
  end if;

  if p_produced_at is null then raise exception 'Data de produção obrigatória.'; end if;
  if p_final_yield_quantity is null or p_final_yield_quantity <= 0 then raise exception 'Rendimento final inválido.'; end if;
  if p_final_yield_unit is null or p_final_yield_unit not in ('g','ml','un') then raise exception 'Unidade de rendimento inválida.'; end if;
  if p_portion_quantity is null or p_portion_quantity <= 0 then raise exception 'Quantidade da porção inválida.'; end if;
  if p_portion_unit is null or p_portion_unit not in ('g','ml','un') then raise exception 'Unidade da porção inválida.'; end if;
  if p_portion_unit <> p_final_yield_unit then raise exception 'A unidade da porção deve ser igual à unidade do rendimento.'; end if;
  if p_actual_portions is not null and p_actual_portions <= 0 then raise exception 'Quantidade real de porções inválida.'; end if;

  v_theoretical_portions := floor(p_final_yield_quantity / p_portion_quantity);
  if v_theoretical_portions < 1 then
    raise exception 'O rendimento informado não produz nenhuma porção válida.';
  end if;

  if p_batch_id is null then
    insert into public.side_production_batches (
      product_id, produced_at, final_yield_quantity, final_yield_unit,
      portion_quantity, portion_unit, actual_portions, created_by, updated_by
    ) values (
      p_product_id, p_produced_at, p_final_yield_quantity, p_final_yield_unit,
      p_portion_quantity, p_portion_unit, p_actual_portions, v_user_id, v_user_id
    )
    returning * into v_batch;
  else
    perform 1 from public.side_production_batches where id = p_batch_id for update;
    if not found then
      raise exception 'Lote de acompanhamento não encontrado.';
    end if;

    update public.side_production_batches set
      product_id = p_product_id,
      produced_at = p_produced_at,
      final_yield_quantity = p_final_yield_quantity,
      final_yield_unit = p_final_yield_unit,
      portion_quantity = p_portion_quantity,
      portion_unit = p_portion_unit,
      actual_portions = p_actual_portions,
      updated_at = now(),
      updated_by = v_user_id
    where id = p_batch_id
    returning * into v_batch;
  end if;

  if p_components is not null and jsonb_typeof(p_components) <> 'array' then
    raise exception 'Componentes do lote devem ser enviados como uma lista.';
  end if;

  create temporary table if not exists pg_temp.tmp_side_components (
    item_type text,
    ingredient_id uuid,
    recipe_id uuid,
    lot_id uuid,
    name_snapshot text,
    quantity numeric,
    unit text,
    unit_cost numeric
  ) on commit drop;
  truncate table pg_temp.tmp_side_components;

  create temporary table if not exists pg_temp.tmp_side_pending_lots (
    ingredient_id uuid,
    lot_id uuid,
    name_snapshot text,
    quantity numeric,
    unit text
  ) on commit drop;
  truncate table pg_temp.tmp_side_pending_lots;

  if p_components is not null then
    for v_component in select * from jsonb_array_elements(p_components) loop
      if jsonb_typeof(v_component) <> 'object' then
        raise exception 'Componente do lote inválido.';
      end if;

      v_item_type := v_component->>'item_type';
      v_unit := v_component->>'unit';

      begin
        v_reference_id := (v_component->>'reference_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Referência inválida para o componente.';
      end;

      begin
        v_quantity := (v_component->>'quantity')::numeric;
      exception when invalid_text_representation then
        raise exception 'Quantidade inválida para o componente.';
      end;

      begin
        v_lot_id := (v_component->>'lot_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Lote inválido para o componente.';
      end;

      if v_item_type not in ('ingredient', 'recipe') then
        raise exception 'Tipo de componente inválido.';
      end if;
      if v_reference_id is null then
        raise exception 'Componente sem referência.';
      end if;
      if v_quantity is null or v_quantity <= 0 then
        raise exception 'Quantidade inválida para o componente.';
      end if;
      if v_unit is null or v_unit not in ('g', 'ml', 'un') then
        raise exception 'Unidade inválida para o componente.';
      end if;
      if v_lot_id is not null and v_item_type <> 'ingredient' then
        raise exception 'Somente componentes de ingrediente podem ter lote.';
      end if;

      v_key := v_item_type || ':' || v_reference_id::text || ':' || coalesce(v_lot_id::text, 'sem-lote');
      if v_key = any (v_seen_keys) then
        raise exception 'Componente duplicado no lote.';
      end if;
      v_seen_keys := v_seen_keys || v_key;

      if v_item_type = 'ingredient' then
        select id, name, base_unit, cost_per_base_unit
          into v_ingredient
          from public.ingredients
         where id = v_reference_id;
        if v_ingredient.id is null then
          raise exception 'Ingrediente não encontrado.';
        end if;

        if v_lot_id is not null then
          insert into pg_temp.tmp_side_pending_lots (
            ingredient_id, lot_id, name_snapshot, quantity, unit
          ) values (
            v_reference_id, v_lot_id, v_ingredient.name, v_quantity, v_unit
          );
          continue;
        else
          if v_unit <> v_ingredient.base_unit then
            raise exception 'Unidade incompatível com o ingrediente.';
          end if;
          v_name_snapshot := v_ingredient.name;
          v_unit_cost := v_ingredient.cost_per_base_unit;
        end if;

      else -- recipe
        if not exists (select 1 from public.recipes where id = v_reference_id) then
          raise exception 'Ficha técnica não encontrada.';
        end if;

        select count(distinct unit) into v_recipe_unidades
          from public.recipe_items
         where recipe_id = v_reference_id;
        if v_recipe_unidades is null or v_recipe_unidades = 0 then
          raise exception 'Esta ficha técnica ainda não tem itens suficientes para ser usada como componente.';
        end if;
        if v_recipe_unidades > 1 then
          raise exception 'Esta ficha técnica tem unidades mistas e não pode ser usada como componente.';
        end if;

        select unit into v_recipe_unit
          from public.recipe_items
         where recipe_id = v_reference_id
         limit 1;
        if v_unit <> v_recipe_unit then
          raise exception 'Unidade incompatível com o rendimento da ficha técnica.';
        end if;

        begin
          v_unit_cost := (v_component->>'unit_cost_snapshot')::numeric;
        exception when invalid_text_representation then
          raise exception 'Custo do componente de ficha técnica inválido.';
        end;
        if v_unit_cost is null or v_unit_cost < 0 then
          raise exception 'Custo do componente de ficha técnica inválido.';
        end if;

        select name into v_name_snapshot from public.recipes where id = v_reference_id;
      end if;

      insert into pg_temp.tmp_side_components (
        item_type, ingredient_id, recipe_id, lot_id, name_snapshot, quantity, unit, unit_cost
      ) values (
        v_item_type,
        case when v_item_type = 'ingredient' then v_reference_id end,
        case when v_item_type = 'recipe' then v_reference_id end,
        null,
        v_name_snapshot,
        v_quantity,
        v_unit,
        v_unit_cost
      );
    end loop;
  end if;

  select coalesce(array_agg(distinct lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id from public.lot_movements
       where source_type = 'side_production' and source_id = v_batch.id and lot_id is not null
      union
      select lot_id from pg_temp.tmp_side_pending_lots
    ) x;

  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  for v_pending in select * from pg_temp.tmp_side_pending_lots loop
    select l.id, l.purchase_item_id, l.base_unit, l.unit_cost_base,
           pi.ingredient_id as pi_ingredient_id, pi.tracks_stock as pi_tracks_stock
      into v_lot
      from public.lots l
      join public.purchase_items pi on pi.id = l.purchase_item_id
     where l.id = v_pending.lot_id;

    if not found then
      raise exception 'Lote de estoque não encontrado.';
    end if;
    if v_lot.pi_ingredient_id is distinct from v_pending.ingredient_id then
      raise exception 'O lote selecionado não pertence a este ingrediente.';
    end if;
    if not v_lot.pi_tracks_stock then
      raise exception 'O item de compra vinculado a este lote não controla estoque.';
    end if;
    if v_pending.unit <> v_lot.base_unit then
      raise exception 'Unidade do lote incompatível com o componente.';
    end if;

    insert into pg_temp.tmp_side_components (
      item_type, ingredient_id, recipe_id, lot_id, name_snapshot, quantity, unit, unit_cost
    ) values (
      'ingredient', v_pending.ingredient_id, null, v_pending.lot_id,
      v_pending.name_snapshot, v_pending.quantity, v_pending.unit, v_lot.unit_cost_base
    );
  end loop;

  for v_rec in
    with old_net as (
      select lot_id,
             sum(case when movement_type = 'production_use' then quantity
                      when movement_type = 'reversal' then -quantity
                      else 0 end) as net
        from public.lot_movements
       where source_type = 'side_production'
         and source_id = v_batch.id
         and lot_id is not null
       group by lot_id
    ),
    new_net as (
      select lot_id, sum(quantity) as net
        from pg_temp.tmp_side_components
       where lot_id is not null
       group by lot_id
    )
    select coalesce(o.lot_id, n.lot_id) as lot_id,
           coalesce(o.net, 0) as old_net,
           coalesce(n.net, 0) as new_net
      from old_net o
      full outer join new_net n on n.lot_id = o.lot_id
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    if v_rec.new_net > v_rec.old_net then
      v_extra := v_rec.new_net - v_rec.old_net;
      if v_lot.status = 'archived' then
        raise exception 'Este lote foi arquivado e não pode receber novo consumo.';
      end if;
      if v_lot.remaining_quantity < v_extra then
        raise exception 'Saldo insuficiente no lote selecionado.';
      end if;
      v_balance_before := v_lot.remaining_quantity;
      v_balance_after := v_lot.remaining_quantity - v_extra;
      v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

      update public.lots set
        remaining_quantity = v_balance_after,
        status = v_new_status,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_lot.id;

      insert into public.lot_movements (
        lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
        source_type, source_id, created_by
      ) values (
        v_lot.id, v_lot.purchase_item_id, 'production_use', v_extra, v_balance_before, v_balance_after,
        'side_production', v_batch.id, v_user_id
      );

    elsif v_rec.old_net > v_rec.new_net then
      v_restore := v_rec.old_net - v_rec.new_net;
      v_balance_before := v_lot.remaining_quantity;
      v_balance_after := v_lot.remaining_quantity + v_restore;
      v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

      update public.lots set
        remaining_quantity = v_balance_after,
        status = v_new_status,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_lot.id;

      insert into public.lot_movements (
        lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
        source_type, source_id, created_by
      ) values (
        v_lot.id, v_lot.purchase_item_id, 'reversal', v_restore, v_balance_before, v_balance_after,
        'side_production', v_batch.id, v_user_id
      );
    end if;
  end loop;

  delete from public.side_batch_components where batch_id = v_batch.id;

  insert into public.side_batch_components (
    batch_id, item_type, ingredient_id, recipe_id, lot_id, name_snapshot, quantity, unit, unit_cost_snapshot
  )
  select v_batch.id, item_type, ingredient_id, recipe_id, lot_id, name_snapshot, quantity, unit, unit_cost
    from pg_temp.tmp_side_components;

  return jsonb_build_object(
    'batch', to_jsonb(v_batch),
    'components', coalesce(
      (select jsonb_agg(to_jsonb(c)) from public.side_batch_components c where c.batch_id = v_batch.id),
      '[]'::jsonb
    )
  );
end;
$function$;

-- =============================================================
-- FIM — ETAPA G2 (corrigida)
-- =============================================================
--
-- Nenhuma mudança de schema (lot_id já existe desde a Etapa G1). Nenhum
-- GRANT/REVOKE necessário (assinatura de parâmetros inalterada nas duas
-- RPCs). apply_skewer_production_cost/apply_side_production_cost,
-- save_purchase, finalize_purchase_item, create_lot_from_purchase_line
-- permanecem exatamente como estavam. Nenhuma RPC de exclusão criada
-- (Etapa G3) — DELETE direto de lote de produção continua sendo um risco
-- conhecido e documentado até lá. Nenhuma UI alterada
-- (producao.html/producao.js/producao.css) — Etapa G4. Nenhuma mudança
-- necessária em js/services/skewer-production-service.js/
-- side-production-service.js — o payload enviado pelo client não mudou,
-- as duas correções são inteiramente internas à RPC.
