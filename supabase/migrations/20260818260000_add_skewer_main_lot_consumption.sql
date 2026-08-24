-- Integração do Lote de Compra da Carne Principal na Produção de Espetos —
-- ETAPA H2 (RPC).
--
-- Evolui save_skewer_production_batch para aceitar e consumir p_lot_id
-- (lote de compra da carne principal). A carne principal continua no
-- header (gross_weight_g/usable_weight_g/total_cost/lot_id, já existentes
-- desde a Etapa H1) — NUNCA vira skewer_batch_component. O lote é debitado
-- pelo gross_weight_g INTEIRO (peso bruto retirado do estoque), nunca pelo
-- usable_weight_g — a diferença é perda de limpeza da produção, não uma
-- característica do lote. Custo (total_cost) é sempre derivado
-- server-side quando há lote (gross_weight_g × lots.unit_cost_base),
-- nunca confiado ao client nesse caso; p_total_cost continua na
-- assinatura só para compatibilidade com o modo manual (sem lote), e é
-- ignorado quando p_lot_id não é nulo.
--
-- Assinatura muda: p_lot_id uuid é inserido logo após p_ingredient_id —
-- isso cria um novo overload aos olhos do Postgres (4 uuid em vez de 3
-- antes do date), então esta migration primeiro faz DROP FUNCTION da
-- assinatura antiga (sem CASCADE) antes de recriar, para nunca deixar
-- duas versões coexistindo.
--
-- NÃO altera schema (skewer_production_batches.lot_id já existe desde a
-- Etapa H1, executada e validada). NÃO altera save_side_production_batch,
-- delete_skewer_production_batch, delete_side_production_batch,
-- apply_skewer_production_cost, apply_side_production_cost — nenhuma
-- delas precisa mudar: delete_skewer_production_batch já reverte por
-- lot_id de forma genérica (source_type='skewer_production',
-- source_id=batch_id), sem se importar se o consumo veio de um
-- componente ou do header. NÃO altera Compras (save_purchase,
-- finalize_purchase_item, create_lot_from_purchase_line), Pedidos
-- (create_customer_order, products.stock_quantity, stock_movements) nem
-- product_costs. NÃO altera skewer_batch_components (schema/lógica de
-- componentes intocada — ingredient/recipe/supply seguem exatamente como
-- na G2). NÃO altera UI (producao.html/producao.js/producao.css) —
-- nenhuma tela ainda envia p_lot_id (fica null sempre, Etapa H3 futura).
-- Migrations já executadas não são editadas.

-- =============================================================
-- 1. Remove a assinatura antiga antes de recriar com o parâmetro novo.
-- =============================================================

DROP FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb);

-- =============================================================
-- 2. save_skewer_production_batch — nova versão, com p_lot_id.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_skewer_production_batch(
  p_batch_id uuid,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_lot_id uuid,
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
  v_main_lot record;
  v_total_cost numeric;
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
  if p_lot_id is not null and p_ingredient_id is null then
    raise exception 'Selecione o ingrediente da carne principal para vincular um lote.';
  end if;
  if p_gross_weight_g is null or p_gross_weight_g <= 0 then raise exception 'Peso bruto inválido.'; end if;
  if p_usable_weight_g is null or p_usable_weight_g <= 0 then raise exception 'Peso útil inválido.'; end if;
  if p_usable_weight_g > p_gross_weight_g then raise exception 'Peso útil não pode exceder o peso bruto.'; end if;
  -- p_total_cost só é validado/usado no modo manual (sem lote) — com
  -- lote, o valor real é sempre derivado pós-lock, nunca confiado ao
  -- client.
  if p_lot_id is null then
    if p_total_cost is null or p_total_cost < 0 then raise exception 'Custo total inválido.'; end if;
  end if;
  if p_skewer_weight_g is null or p_skewer_weight_g <= 0 then raise exception 'Peso por espeto inválido.'; end if;
  if p_actual_quantity is null or p_actual_quantity <= 0 then raise exception 'Quantidade produzida inválida.'; end if;
  if p_produced_at is null then raise exception 'Data de produção obrigatória.'; end if;

  if p_batch_id is null then
    insert into public.skewer_production_batches (
      product_id, ingredient_id, lot_id, produced_at, gross_weight_g, usable_weight_g,
      total_cost, skewer_weight_g, actual_quantity, created_by, updated_by
    ) values (
      p_product_id, p_ingredient_id, p_lot_id, p_produced_at, p_gross_weight_g, p_usable_weight_g,
      case when p_lot_id is not null then 0 else p_total_cost end,
      p_skewer_weight_g, p_actual_quantity, v_user_id, v_user_id
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
      lot_id = p_lot_id,
      produced_at = p_produced_at,
      gross_weight_g = p_gross_weight_g,
      usable_weight_g = p_usable_weight_g,
      total_cost = case when p_lot_id is not null then 0 else p_total_cost end,
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
  -- Fase 1 — idêntica à G2 já executada: parse + validação estrutural de
  -- cada componente. recipe/supply/ingredient sem lote resolvidos direto;
  -- ingredient COM lote só grava intenção em tmp_skewer_pending_lots
  -- (nada mutável do lote é lido aqui, só depois do lock).
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
  -- Fase 2 — conjunto de TODOS os lotes envolvidos: histórico (ledger
  -- deste batch) + pendentes de componente + o lote da carne principal
  -- (p_lot_id), numa única passada de lock, ordem determinística.
  -- ================================================================

  select coalesce(array_agg(distinct lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id from public.lot_movements
       where source_type = 'skewer_production' and source_id = v_batch.id and lot_id is not null
      union
      select lot_id from pg_temp.tmp_skewer_pending_lots
      union
      select p_lot_id where p_lot_id is not null
    ) x;

  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  -- ================================================================
  -- Fase 3 — resolve componentes pendentes pós-lock (idêntico à G2).
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
  -- Fase 3.5 — resolve/valida o lote da carne principal pós-lock (nunca
  -- vira componente). Consumo = p_gross_weight_g inteiro, nunca
  -- p_usable_weight_g. Custo derivado aqui, nunca confiado ao client.
  -- ================================================================

  if p_lot_id is not null then
    select l.id, l.purchase_item_id, l.base_unit, l.unit_cost_base,
           pi.ingredient_id as pi_ingredient_id, pi.tracks_stock as pi_tracks_stock
      into v_main_lot
      from public.lots l
      join public.purchase_items pi on pi.id = l.purchase_item_id
     where l.id = p_lot_id;

    if not found then
      raise exception 'Lote da carne principal não encontrado.';
    end if;
    if v_main_lot.pi_ingredient_id is distinct from p_ingredient_id then
      raise exception 'O lote selecionado não pertence ao ingrediente da carne principal.';
    end if;
    if not v_main_lot.pi_tracks_stock then
      raise exception 'O item de compra vinculado a este lote não controla estoque.';
    end if;
    if v_main_lot.base_unit <> 'g' then
      raise exception 'O lote da carne principal deve controlar estoque em gramas.';
    end if;

    v_total_cost := p_gross_weight_g * v_main_lot.unit_cost_base;

    update public.skewer_production_batches
       set total_cost = v_total_cost
     where id = v_batch.id
    returning * into v_batch;
  end if;

  -- ================================================================
  -- Fase 4 — reconciliação de saldo por lote. old_net vem SÓ do ledger
  -- (nunca distingue se o consumo antigo veio de componente ou da carne
  -- principal — intencional). new_net soma componentes + carne
  -- principal, agregados por lot_id (mesmo lote em carne+componente
  -- soma, nunca sobrescreve).
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
    new_net_componentes as (
      select lot_id, sum(quantity) as net
        from pg_temp.tmp_skewer_components
       where lot_id is not null
       group by lot_id
    ),
    new_net_carne as (
      select p_lot_id as lot_id, p_gross_weight_g as net
       where p_lot_id is not null
    ),
    new_net as (
      select lot_id, sum(net) as net
        from (
          select * from new_net_componentes
          union all
          select * from new_net_carne
        ) u
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
        'skewer_production', v_batch.id, v_user_id
      );

    elsif v_rec.old_net > v_rec.new_net then
    v_restore := v_rec.old_net - v_rec.new_net;
    v_balance_before := v_lot.remaining_quantity;

    if v_balance_before + v_restore > v_lot.initial_quantity then
    raise exception 'A reversão ultrapassaria a quantidade inicial do lote.';
    end if;

  v_balance_after := v_balance_before + v_restore;
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
  end loop;

  -- ================================================================
  -- Fase 5 — substitui os componentes por completo (idêntico à G2). A
  -- carne principal NUNCA entra aqui — tmp_skewer_components só contém
  -- insumo/ingrediente-tempero/preparo, exatamente como antes.
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

REVOKE ALL ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) TO authenticated;

-- =============================================================
-- FIM — ETAPA H2
-- =============================================================
--
-- save_side_production_batch, delete_skewer_production_batch,
-- delete_side_production_batch, apply_skewer_production_cost,
-- apply_side_production_cost: inalteradas. delete_skewer_production_batch
-- em particular não precisa de nenhuma mudança — já reverte por lot_id de
-- forma genérica (source_type='skewer_production', source_id=batch_id),
-- sem se importar se o consumo veio de um componente ou do header (mesma
-- conclusão do diagnóstico).
--
-- skewer_batch_components: schema e lógica de componentes (ingredient/
-- recipe/supply) inalterados — Fases 1/3/5 são idênticas à G2 já
-- executada, só reposicionadas ao redor das novas Fases 2 (lock
-- unificado)/3.5 (carne principal)/4 (reconciliação estendida).
--
-- Compras (save_purchase, finalize_purchase_item,
-- create_lot_from_purchase_line), Pedidos (create_customer_order,
-- products.stock_quantity, stock_movements), product_costs: não tocados.
--
-- UI (producao.html/producao.js/producao.css): não alterada nesta etapa —
-- nenhuma tela ainda envia p_lot_id (fica sempre null até a Etapa H3),
-- então o comportamento observável hoje é idêntico ao anterior a esta
-- migration.
