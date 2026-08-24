-- Etapa K4: Produção alimenta automaticamente o estoque de Produtos com
-- stock_mode='produced' (ex.: Contra Filé, Acompanhamentos). Produtos
-- 'purchased'/'untracked' nunca são tocados por esta migration — só K3
-- (Compras) credita 'purchased'. Nenhum backfill: saldo atual de cada
-- produto (ex.: Contra Filé=16) é tratado como saldo de abertura.
--
-- =============================================================
-- CORREÇÃO K4.1 — CUTOFF ROBUSTO (substitui o corte por created_at/data
-- fixa da versão anterior desta mesma migration, ainda não executada).
--
-- Problema do corte anterior: comparar created_at contra uma constante de
-- calendário hardcoded ('2026-08-22...') é frágil -- não representa o
-- momento real em que esta migration é de fato aplicada no banco (pode
-- rodar antes ou depois dessa data, dependendo de quando o usuário
-- executar), e não sobrevive a nenhuma reordenação/adiamento da execução.
--
-- Mecanismo novo: uma flag explícita por batch, NÃO uma marca de
-- "já sincronizado" -- ela representa "este batch pertence ao regime
-- automático K4":
--
--   skewer_production_batches.stock_sync_enabled boolean NOT NULL DEFAULT false
--   side_production_batches.stock_sync_enabled boolean NOT NULL DEFAULT false
--
-- DEFAULT false ban todo batch já existente na tabela no momento em que
-- a migration roda (histórico) permanece false PARA SEMPRE -- nenhum
-- backfill, nenhum UPDATE em massa aqui. Todo batch CRIADO por
-- save_skewer_production_batch/save_side_production_batch a partir desta
-- migration grava stock_sync_enabled=true explicitamente no INSERT. Uma
-- EDIÇÃO nunca toca essa coluna (ausente do SET da UPDATE) -- o valor
-- persistido continua exatamente o que já era: false pra histórico, true
-- pra batch nascido sob o K4, em qualquer número de edições futuras.
--
-- A reconciliação de estoque de Produto (criação, edição, troca de
-- produto) só roda quando v_batch.stock_sync_enabled é true -- histórico
-- nunca dispara crédito/reversão, mesmo editado repetidamente depois
-- desta migration. Resolve exatamente o mesmo risco do corte anterior
-- (editar uma produção histórica sem nenhum stock_movement K4 geraria
-- desired_net completo como entrada, duplicando o saldo de abertura já
-- refletido manualmente), mas de forma robusta e independente de
-- qualquer data de calendário.
--
-- delete_skewer_production_batch/delete_side_production_batch NÃO
-- dependem desta flag: o crédito a reverter vem sempre de
-- SUM(stock_movements) do próprio batch -- um batch histórico
-- (stock_sync_enabled=false) nunca gerou nenhum stock_movement K4, então
-- credited_net já é 0 por construção, sem necessidade de checagem extra.
-- =============================================================

ALTER TABLE public.skewer_production_batches
  ADD COLUMN stock_sync_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.side_production_batches
  ADD COLUMN stock_sync_enabled boolean NOT NULL DEFAULT false;

-- =============================================================
-- 1. CHECK de movement_type ganha production_in/production_reversal --
-- mesma técnica de descoberta dinâmica da K3 (localiza o constraint pelo
-- conteúdo, nunca supõe o nome -- pode já ter sido renomeado pela K3 pra
-- stock_movements_movement_type_valido, ou pode ainda ter o nome
-- original, dependendo do ambiente).
-- =============================================================

do $$
declare
  v_check_name text;
  v_match_count int;
begin
  select count(*), max(conname) into v_match_count, v_check_name
    from pg_constraint
   where conrelid = 'public.stock_movements'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%movement_type%';

  if v_match_count <> 1 then
    raise exception 'Localizados % CHECK constraints candidatos para movement_type em stock_movements (esperado exatamente 1) — abortando.', v_match_count;
  end if;

  execute format('alter table public.stock_movements drop constraint %I', v_check_name);
end $$;

alter table public.stock_movements
  add constraint stock_movements_movement_type_valido
  check (movement_type in (
    'sale', 'manual_addition', 'manual_removal', 'cancellation',
    'purchase_in', 'purchase_reversal',
    'production_in', 'production_reversal'
  ));

-- =============================================================
-- 2. Helper interno: _reconcile_production_product_stock.
--
-- Mesmo padrão de old_net/delta/UPDATE atômico do helper de Compras (K3),
-- generalizado pra qualquer origem de produção (source_type informado
-- pelo caller: 'skewer_production' ou 'side_production'). Nunca aceita
-- product_id "cru" do client -- só é chamado internamente por
-- save_skewer_production_batch/save_side_production_batch/delete_*, que
-- sempre passam o product_id já validado/persistido no próprio batch.
-- Só age quando product.stock_mode='produced' -- caso contrário noop, sem
-- tocar stock_quantity (purchased/untracked ficam intocados).
-- =============================================================

CREATE FUNCTION public._reconcile_production_product_stock(
  p_source_type text,
  p_source_id uuid,
  p_product_id uuid,
  p_desired_net integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_product        public.products%rowtype;
  v_old_net        integer;
  v_delta          integer;
  v_movement_type  text;
  v_balance_after  integer;
  v_balance_before integer;
  v_movement       public.stock_movements%rowtype;
begin
  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto vinculado não encontrado.';
  end if;

  if v_product.stock_mode <> 'produced' then
    return jsonb_build_object('noop', true, 'reason', 'stock_mode_nao_produced');
  end if;

  select coalesce(sum(quantity_change), 0) into v_old_net
    from public.stock_movements
   where source_type = p_source_type
     and source_id = p_source_id
     and product_id = p_product_id
     and movement_type in ('production_in', 'production_reversal');

  v_delta := p_desired_net - v_old_net;
  if v_delta = 0 then
    return jsonb_build_object('noop', true, 'reason', 'delta_zero', 'net', v_old_net);
  end if;

  v_movement_type := case when v_delta > 0 then 'production_in' else 'production_reversal' end;

  update public.products
     set stock_quantity = stock_quantity + v_delta,
         updated_at = now()
   where id = p_product_id
     and stock_quantity + v_delta >= 0
  returning stock_quantity into v_balance_after;

  if not found then
    raise exception 'Estoque atual não permite reduzir esta produção porque parte das unidades já foi vendida ou consumida.';
  end if;
  v_balance_before := v_balance_after - v_delta;

  insert into public.stock_movements (
    product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity,
    reason, source_type, source_id, created_by
  ) values (
    p_product_id, null, v_movement_type, v_delta, v_balance_before, v_balance_after,
    case when v_delta > 0 then 'Entrada automática por produção' else 'Reversão automática por edição de produção' end,
    p_source_type, p_source_id, auth.uid()
  )
  returning * into v_movement;

  return jsonb_build_object('noop', false, 'movement', to_jsonb(v_movement));
end;
$function$;

REVOKE ALL ON FUNCTION public._reconcile_production_product_stock(text, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._reconcile_production_product_stock(text, uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public._reconcile_production_product_stock(text, uuid, uuid, integer) FROM authenticated;

-- =============================================================
-- 3. save_skewer_production_batch — CREATE OR REPLACE, mesma assinatura
-- de 11 parâmetros já executada (I3). Mudanças cirúrgicas: (a) o lock
-- inicial do batch em edição passa a capturar também o product_id antigo
-- (necessário pra detectar troca de Produto); (b) logo após o batch ser
-- persistido (criação ou edição), um bloco novo reconcilia o estoque do
-- Produto -- se o product_id mudou, reverte a zero no Produto antigo e
-- credita no novo (nesta ordem determinística por uuid, mesma disciplina
-- anti-deadlock já usada pra lots), sempre dentro da mesma transação (se
-- a reconciliação falhar, a produção inteira é revertida). Resto do
-- corpo (Fases 1-5, ingrediente/insumo/carne principal/lote) idêntico ao
-- já executado.
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
  v_old_product_id uuid;
  v_desired_net integer;
  v_product_stock_mode text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar lotes de produção.';
  end if;

  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Produto não encontrado.';
  end if;

  -- Correção K4.2: bloqueia criação E troca de product_id numa edição --
  -- roda antes de qualquer INSERT/UPDATE/reconciliação, validando sempre
  -- p_product_id (o valor que VAI ser persistido), nunca o product_id
  -- antigo do batch.
  select stock_mode into v_product_stock_mode from public.products where id = p_product_id;
  if v_product_stock_mode <> 'produced' then
    raise exception 'Este produto não está configurado para receber estoque por Produção.';
  end if;

  if p_ingredient_id is not null and not exists (select 1 from public.ingredients where id = p_ingredient_id) then
    raise exception 'Ingrediente não encontrado.';
  end if;

  -- Etapa I1: só bloqueia CRIAÇÃO (p_batch_id IS NULL) sem lote. Nunca
  -- exclusivamente "p_lot_id is null" — isso quebraria a edição de
  -- qualquer produção histórica que já nasceu sem lote. Editar um batch já
  -- existente sem lote continua permitido e cai normalmente no ramo
  -- "p_lot_id is null" (validação de p_total_cost manual) logo abaixo.
  if p_batch_id is null and p_lot_id is null then
    raise exception 'Selecione um lote da carne antes de registrar a produção.';
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
      total_cost, skewer_weight_g, actual_quantity, stock_sync_enabled, created_by, updated_by
    ) values (
      p_product_id, p_ingredient_id, p_lot_id, p_produced_at, p_gross_weight_g, p_usable_weight_g,
      case when p_lot_id is not null then 0 else p_total_cost end,
      p_skewer_weight_g, p_actual_quantity, true, v_user_id, v_user_id
    )
    returning * into v_batch;
    v_old_product_id := null;
  else
    select product_id into v_old_product_id
      from public.skewer_production_batches where id = p_batch_id for update;
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

  -- Etapa K4 (corrigida em K4.1): reconciliação automática de estoque do
  -- Produto (stock_mode='produced'). Gate: stock_sync_enabled -- true só
  -- pra batch nascido sob o K4 (INSERT acima) ou já sob o regime numa
  -- edição anterior; um batch histórico (stock_sync_enabled=false, nunca
  -- alterado pela UPDATE acima) nunca dispara crédito/reversão de
  -- estoque, mesmo editado repetidamente depois desta migration.
  if v_batch.stock_sync_enabled then
    v_desired_net := p_actual_quantity;

    if v_old_product_id is not null and v_old_product_id is distinct from p_product_id then
      -- Troca de Produto no batch: reverte a zero no antigo e credita o
      -- novo, em ordem determinística por uuid -- mesma disciplina
      -- anti-deadlock já usada pra lots, evita duas edições concorrentes
      -- travarem os dois produtos em ordem diferente.
      if v_old_product_id < p_product_id then
        perform public._reconcile_production_product_stock('skewer_production', v_batch.id, v_old_product_id, 0);
        perform public._reconcile_production_product_stock('skewer_production', v_batch.id, p_product_id, v_desired_net);
      else
        perform public._reconcile_production_product_stock('skewer_production', v_batch.id, p_product_id, v_desired_net);
        perform public._reconcile_production_product_stock('skewer_production', v_batch.id, v_old_product_id, 0);
      end if;
    else
      perform public._reconcile_production_product_stock('skewer_production', v_batch.id, p_product_id, v_desired_net);
    end if;
  end if;

  if p_components is not null and jsonb_typeof(p_components) <> 'array' then
    raise exception 'Componentes do lote devem ser enviados como uma lista.';
  end if;

  -- ================================================================
  -- Fase 1 — parse + validação estrutural de cada componente.
  -- recipe/ingredient-sem-lote/supply-sem-lote resolvidos direto;
  -- ingredient OU supply COM lote só gravam intenção em
  -- tmp_skewer_pending_lots (nada mutável do lote é lido aqui, só depois
  -- do lock). Etapa I3: generaliza a tabela de pendentes (item_type +
  -- supply_id) e o branch 'supply' para também poder adiar resolução.
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
    item_type text,
    ingredient_id uuid,
    supply_id uuid,
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
      -- Etapa I3: lote agora também é permitido para 'supply' (não só
      -- 'ingredient'). 'recipe' nunca tem lote.
      if v_lot_id is not null and v_item_type not in ('ingredient', 'supply') then
        raise exception 'Somente componentes de ingrediente ou insumo podem ter lote.';
      end if;

      -- Duplicidade: chave inclui lot_id (só relevante quando != NULL) —
      -- permite o mesmo ingrediente/insumo em lotes diferentes, mas
      -- continua rejeitando o mesmo item+mesmo lote (ou mesmo item sem
      -- lote) duas vezes.
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
            item_type, ingredient_id, supply_id, lot_id, name_snapshot, quantity, unit
          ) values (
            'ingredient', v_reference_id, null, v_lot_id, v_ingredient.name, v_quantity, v_unit
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

        if v_lot_id is not null then
          insert into pg_temp.tmp_skewer_pending_lots (
            item_type, ingredient_id, supply_id, lot_id, name_snapshot, quantity, unit
          ) values (
            'supply', null, v_reference_id, v_lot_id, v_supply.name, v_quantity, v_unit
          );
          continue;
        else
          -- Sem lote: comportamento legado intocado — sempre 'un',
          -- sempre production_supplies.cost_per_unit.
          if v_unit <> 'un' or v_supply.unit_type <> 'un' then
            raise exception 'Unidade inválida para insumo.';
          end if;
          v_name_snapshot := v_supply.name;
          v_unit_cost := v_supply.cost_per_unit;
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
  -- deste batch) + pendentes de componente (ingredient OU supply) + o
  -- lote da carne principal (p_lot_id), numa única passada de lock, ordem
  -- determinística. Já agnóstica a item_type — nenhuma mudança.
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
  -- Fase 3 — resolve componentes pendentes pós-lock. Etapa I3: ramo novo
  -- para item_type='supply', usando purchase_items.production_supply_id
  -- (não .ingredient_id) e lots.base_unit/unit_cost_base exatamente como
  -- estão no lote (nunca hardcoda 'un', nunca usa cost_per_unit atual).
  -- ================================================================

  for v_pending in select * from pg_temp.tmp_skewer_pending_lots loop
    if v_pending.item_type = 'ingredient' then
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

    else -- supply
      select l.id, l.purchase_item_id, l.base_unit, l.unit_cost_base,
             pi.production_supply_id as pi_supply_id, pi.tracks_stock as pi_tracks_stock
        into v_lot
        from public.lots l
        join public.purchase_items pi on pi.id = l.purchase_item_id
       where l.id = v_pending.lot_id;

      if not found then
        raise exception 'Lote de estoque não encontrado.';
      end if;
      if v_lot.pi_supply_id is distinct from v_pending.supply_id then
        raise exception 'O lote selecionado não pertence a este insumo.';
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
        'supply', null, null, v_pending.supply_id, v_pending.lot_id,
        v_pending.name_snapshot, v_pending.quantity, v_pending.unit, v_lot.unit_cost_base
      );
    end if;
  end loop;

  -- ================================================================
  -- Fase 3.5 — resolve/valida o lote da carne principal pós-lock (nunca
  -- vira componente). Inalterada por esta migration.
  -- ================================================================

  if p_lot_id is not null then
    select l.id, l.purchase_item_id, l.base_unit, l.unit_cost_base,
           pi.product_id as pi_product_id, pi.tracks_stock as pi_tracks_stock
      into v_main_lot
      from public.lots l
      join public.purchase_items pi on pi.id = l.purchase_item_id
     where l.id = p_lot_id;

    if not found then
      raise exception 'Lote da carne principal não encontrado.';
    end if;
    if v_main_lot.pi_product_id is distinct from p_product_id then
      raise exception 'O lote selecionado não pertence ao produto da carne principal.';
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
  -- (nunca distingue se o consumo antigo veio de componente ingredient,
  -- supply ou da carne principal — intencional). new_net soma
  -- componentes (ingredient/supply, já resolvidos na Fase 1/3) + carne
  -- principal, agregados por lot_id. Já agnóstica a item_type — nenhuma
  -- mudança.
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
  -- Fase 5 — substitui os componentes por completo. A carne principal
  -- NUNCA entra aqui — tmp_skewer_components só contém insumo/
  -- ingrediente-tempero/preparo. Já agnóstica a item_type — nenhuma
  -- mudança.
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
-- 4. delete_skewer_production_batch — CREATE OR REPLACE, mesma
-- assinatura (1 parâmetro) já executada. Bloco novo, inserido depois do
-- loop existente de reversão de lotes e antes do DELETE físico do batch:
-- calcula o net já creditado ao Produto (SUM de stock_movements deste
-- batch, sempre 0 por construção pra um batch histórico -- nunca precisou
-- de checagem de cutoff aqui), reverte esse net do Produto (bloqueia com
-- exceção clara se o estoque atual não comportar -- venda já pode ter
-- consumido parte) e apaga os stock_movements desse batch por completo,
-- sem deixar production_reversal rastreável -- mesma filosofia da
-- delete_purchase (K3): batch inteiro sumindo, suas entradas de estoque
-- também desaparecem.
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_skewer_production_batch(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_batch public.skewer_production_batches%rowtype;
  v_lot_ids uuid[];
  v_rec record;
  v_lot public.lots%rowtype;
  v_movement public.lot_movements%rowtype;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_reversed_lots jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
  v_product public.products%rowtype;
  v_credited_net integer;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir lotes de produção.';
  end if;

  -- Idempotência natural: uma segunda chamada depois do DELETE já
  -- concluído simplesmente não encontra a linha e cai aqui.
  select * into v_batch from public.skewer_production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote de produção não encontrado.';
  end if;

  -- Consumo líquido ATUAL, exclusivamente do ledger — nunca dos
  -- componentes atuais (mesma disciplina já validada na G2).
  select coalesce(array_agg(lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id
        from public.lot_movements
       where source_type = 'skewer_production'
         and source_id = p_batch_id
         and lot_id is not null
         and movement_type in ('production_use', 'reversal')
       group by lot_id
      having sum(case when movement_type = 'production_use' then quantity
                       when movement_type = 'reversal' then -quantity
                       else 0 end) > 0
    ) x;

  -- Trava todos os lotes com saldo líquido a devolver, em ordem
  -- determinística — mesma ordem batch-primeiro/lots-depois já usada na
  -- G2, evita deadlock com save/edição concorrente do mesmo batch.
  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  for v_rec in
    select lot_id,
           sum(case when movement_type = 'production_use' then quantity
                    when movement_type = 'reversal' then -quantity
                    else 0 end) as net
      from public.lot_movements
     where source_type = 'skewer_production'
       and source_id = p_batch_id
       and lot_id is not null
       and movement_type in ('production_use', 'reversal')
     group by lot_id
    having sum(case when movement_type = 'production_use' then quantity
                     when movement_type = 'reversal' then -quantity
                     else 0 end) > 0
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    v_balance_before := v_lot.remaining_quantity;
    v_balance_after := v_lot.remaining_quantity + v_rec.net;

    -- Defesa: ledger/saldo nunca deveriam permitir isso, mas se
    -- permitissem, bloqueia a exclusão inteira em vez de corromper o lote.
    if v_balance_after > v_lot.initial_quantity then
      raise exception 'A reversão ultrapassaria a quantidade inicial do lote.';
    end if;

    v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

    update public.lots set
      remaining_quantity = v_balance_after,
      status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
    where id = v_lot.id
    returning * into v_lot;

    insert into public.lot_movements (
      lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
      source_type, source_id, created_by
    ) values (
      v_lot.id, v_lot.purchase_item_id, 'reversal', v_rec.net, v_balance_before, v_balance_after,
      'skewer_production', p_batch_id, auth.uid()
    )
    returning * into v_movement;

    v_reversed_lots := v_reversed_lots || jsonb_build_array(to_jsonb(v_lot));
    v_movements := v_movements || jsonb_build_array(to_jsonb(v_movement));
  end loop;

  -- Etapa K4: reverte e apaga (sem deixar production_reversal rastreável
  -- -- o batch inteiro está sumindo) o crédito de estoque de Produto
  -- deste batch, se houver.
  select * into v_product from public.products where id = v_batch.product_id for update;
  if found and v_product.stock_mode = 'produced' then
    select coalesce(sum(quantity_change), 0) into v_credited_net
      from public.stock_movements
     where source_type = 'skewer_production'
       and source_id = p_batch_id
       and product_id = v_product.id
       and movement_type in ('production_in', 'production_reversal');

    if v_credited_net <> 0 then
      update public.products
         set stock_quantity = stock_quantity - v_credited_net,
             updated_at = now()
       where id = v_product.id
         and stock_quantity - v_credited_net >= 0;

      if not found then
        raise exception 'Estoque atual não permite excluir esta produção porque parte das unidades produzidas já foi vendida ou consumida.';
      end if;
    end if;
  end if;

  delete from public.stock_movements
   where source_type = 'skewer_production' and source_id = p_batch_id;

  -- Só agora exclui o batch — cascade remove os componentes; lot_movements
  -- nunca é tocado (sem FK, confirmado no diagnóstico), ledger preservado.
  delete from public.skewer_production_batches where id = p_batch_id;

  return jsonb_build_object(
    'deleted_batch_id', p_batch_id,
    'reversed_lots', v_reversed_lots,
    'movements', v_movements
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_skewer_production_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_skewer_production_batch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_skewer_production_batch(uuid) TO authenticated;

-- =============================================================
-- 5. save_side_production_batch — CREATE OR REPLACE, mesma assinatura de
-- 9 parâmetros já executada. Mesmo tratamento de save_skewer_production_
-- batch: (a) lock inicial captura product_id antigo; (b) depois de
-- persistido, reconcilia estoque do Produto usando desired_net =
-- actual_portions quando informado, senão floor(final_yield_quantity /
-- portion_quantity) -- mesma fórmula de fallback já usada em
-- apply_side_production_cost, não inventada aqui.
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
  v_old_product_id uuid;
  v_desired_net integer;
  v_product_stock_mode text;
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

  -- Correção K4.2: mesma barreira de save_skewer_production_batch --
  -- bloqueia criação E troca de product_id numa edição, antes de
  -- qualquer INSERT/UPDATE/reconciliação.
  select stock_mode into v_product_stock_mode from public.products where id = p_product_id;
  if v_product_stock_mode <> 'produced' then
    raise exception 'Este produto não está configurado para receber estoque por Produção.';
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
      portion_quantity, portion_unit, actual_portions, stock_sync_enabled, created_by, updated_by
    ) values (
      p_product_id, p_produced_at, p_final_yield_quantity, p_final_yield_unit,
      p_portion_quantity, p_portion_unit, p_actual_portions, true, v_user_id, v_user_id
    )
    returning * into v_batch;
    v_old_product_id := null;
  else
    select product_id into v_old_product_id
      from public.side_production_batches where id = p_batch_id for update;
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

  -- Etapa K4 (corrigida em K4.1): mesmo gate/reconciliação de
  -- save_skewer_production_batch acima (stock_sync_enabled). desired_net
  -- = actual_portions quando informado, senão a mesma quantidade teórica
  -- já usada em apply_side_production_cost (floor(rendimento/porção)).
  if v_batch.stock_sync_enabled then
    v_desired_net := coalesce(v_batch.actual_portions, floor(v_batch.final_yield_quantity / v_batch.portion_quantity));

    if v_old_product_id is not null and v_old_product_id is distinct from p_product_id then
      if v_old_product_id < p_product_id then
        perform public._reconcile_production_product_stock('side_production', v_batch.id, v_old_product_id, 0);
        perform public._reconcile_production_product_stock('side_production', v_batch.id, p_product_id, v_desired_net);
      else
        perform public._reconcile_production_product_stock('side_production', v_batch.id, p_product_id, v_desired_net);
        perform public._reconcile_production_product_stock('side_production', v_batch.id, v_old_product_id, 0);
      end if;
    else
      perform public._reconcile_production_product_stock('side_production', v_batch.id, p_product_id, v_desired_net);
    end if;
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

REVOKE ALL ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) TO authenticated;

-- =============================================================
-- 6. delete_side_production_batch — CREATE OR REPLACE, mesma assinatura
-- (1 parâmetro). Mesmo tratamento de delete_skewer_production_batch.
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_side_production_batch(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_batch public.side_production_batches%rowtype;
  v_lot_ids uuid[];
  v_rec record;
  v_lot public.lots%rowtype;
  v_movement public.lot_movements%rowtype;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_reversed_lots jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
  v_product public.products%rowtype;
  v_credited_net integer;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir lotes de acompanhamento.';
  end if;

  select * into v_batch from public.side_production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote de acompanhamento não encontrado.';
  end if;

  select coalesce(array_agg(lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id
        from public.lot_movements
       where source_type = 'side_production'
         and source_id = p_batch_id
         and lot_id is not null
         and movement_type in ('production_use', 'reversal')
       group by lot_id
      having sum(case when movement_type = 'production_use' then quantity
                       when movement_type = 'reversal' then -quantity
                       else 0 end) > 0
    ) x;

  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  for v_rec in
    select lot_id,
           sum(case when movement_type = 'production_use' then quantity
                    when movement_type = 'reversal' then -quantity
                    else 0 end) as net
      from public.lot_movements
     where source_type = 'side_production'
       and source_id = p_batch_id
       and lot_id is not null
       and movement_type in ('production_use', 'reversal')
     group by lot_id
    having sum(case when movement_type = 'production_use' then quantity
                     when movement_type = 'reversal' then -quantity
                     else 0 end) > 0
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    v_balance_before := v_lot.remaining_quantity;
    v_balance_after := v_lot.remaining_quantity + v_rec.net;

    if v_balance_after > v_lot.initial_quantity then
      raise exception 'A reversão ultrapassaria a quantidade inicial do lote.';
    end if;

    v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

    update public.lots set
      remaining_quantity = v_balance_after,
      status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
    where id = v_lot.id
    returning * into v_lot;

    insert into public.lot_movements (
      lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
      source_type, source_id, created_by
    ) values (
      v_lot.id, v_lot.purchase_item_id, 'reversal', v_rec.net, v_balance_before, v_balance_after,
      'side_production', p_batch_id, auth.uid()
    )
    returning * into v_movement;

    v_reversed_lots := v_reversed_lots || jsonb_build_array(to_jsonb(v_lot));
    v_movements := v_movements || jsonb_build_array(to_jsonb(v_movement));
  end loop;

  -- Etapa K4: mesmo tratamento de delete_skewer_production_batch.
  select * into v_product from public.products where id = v_batch.product_id for update;
  if found and v_product.stock_mode = 'produced' then
    select coalesce(sum(quantity_change), 0) into v_credited_net
      from public.stock_movements
     where source_type = 'side_production'
       and source_id = p_batch_id
       and product_id = v_product.id
       and movement_type in ('production_in', 'production_reversal');

    if v_credited_net <> 0 then
      update public.products
         set stock_quantity = stock_quantity - v_credited_net,
             updated_at = now()
       where id = v_product.id
         and stock_quantity - v_credited_net >= 0;

      if not found then
        raise exception 'Estoque atual não permite excluir esta produção porque parte das unidades produzidas já foi vendida ou consumida.';
      end if;
    end if;
  end if;

  delete from public.stock_movements
   where source_type = 'side_production' and source_id = p_batch_id;

  delete from public.side_production_batches where id = p_batch_id;

  return jsonb_build_object(
    'deleted_batch_id', p_batch_id,
    'reversed_lots', v_reversed_lots,
    'movements', v_movements
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_side_production_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_side_production_batch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_side_production_batch(uuid) TO authenticated;

-- =============================================================
-- Nenhuma outra alteração: create_customer_order, cancel_order,
-- update_order_status, adjust_stock, save_purchase/save_purchase_item/
-- finalize_purchase_item/create_lot_from_purchase_line/delete_purchase
-- (K3), schema de lots/lot_movements/purchase_items/products,
-- apply_skewer_production_cost/apply_side_production_cost, UI de
-- Produção/Compras/Produtos/Estoque. Produtos purchased/untracked: helper
-- sempre retorna noop, stock_quantity nunca é tocado. Combos: nunca
-- passam por Produção, permanecem untracked. Nenhum backfill.
-- =============================================================
