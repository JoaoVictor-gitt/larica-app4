-- Produção de Espetos — ETAPA 3B (componentes do lote + RPC transacional).
-- Cria public.skewer_batch_components: componentes adicionais de um lote
-- (insumo/palito, ingrediente/tempero, ficha técnica/preparo), cada um
-- preservando snapshot histórico de nome e custo — um lote é um EVENTO
-- HISTÓRICO, nunca deve mudar de custo porque o cadastro referenciado mudou
-- de preço depois (diferente de Fichas Técnicas, que são sempre derivadas
-- on-read). Cria a RPC save_skewer_production_batch como única porta de
-- escrita pra lote+componentes juntos, numa única transação (SECURITY
-- DEFINER, valida is_admin() por dentro). Fecha o GRANT direto de
-- INSERT/UPDATE que authenticated tinha em skewer_production_batches desde
-- a Etapa 1 (SELECT/DELETE continuam diretos). NÃO altera UI nenhuma —
-- criarLoteEspetosNoSupabase/atualizarLoteEspetosNoSupabase (service) viram
-- wrappers desta RPC, mesma assinatura de hoje, pra Etapa 2 continuar
-- funcionando sem nenhuma mudança de código. Não altera product_costs,
-- estoque, orders, create_customer_order, business_settings ou qualquer
-- outra tabela. Não edita nenhuma migration anterior.

-- =============================================================
-- 1. Tabela skewer_batch_components.
-- XOR entre ingredient_id/recipe_id/supply_id garantido por CHECK, mesmo
-- padrão já usado em recipe_items.item_type. Sem total_cost_snapshot —
-- 100% derivável (quantity × unit_cost_snapshot), nunca persistido, mesma
-- disciplina já usada em toda a feature (rendimento/custo de receita nunca
-- persistidos). ingredient_id/recipe_id/supply_id SEM ON DELETE CASCADE
-- nem SET NULL — NO ACTION (RESTRICT-equivalente): SET NULL seria
-- estruturalmente incompatível com o CHECK XOR abaixo (anular a referência
-- violaria a própria constraint que exige ela NOT NULL pro item_type da
-- linha), então se comportaria como RESTRICT de qualquer forma, só que com
-- um erro de CHECK genérico em vez de um erro de FK claro. Mesmo padrão já
-- usado em recipe_items.ingredient_id/skewer_production_batches.ingredient_id
-- — nunca apagar histórico silenciosamente, risco baixíssimo na prática já
-- que ingredientes/receitas/insumos nunca são excluídos fisicamente no
-- fluxo normal do projeto (padrão é active=false).
-- =============================================================

CREATE TABLE public.skewer_batch_components (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.skewer_production_batches(id) ON DELETE CASCADE,
  item_type           text NOT NULL,
  ingredient_id       uuid NULL REFERENCES public.ingredients(id),
  recipe_id           uuid NULL REFERENCES public.recipes(id),
  supply_id           uuid NULL REFERENCES public.production_supplies(id),
  name_snapshot       text NOT NULL,
  quantity            numeric(12,3) NOT NULL,
  unit                text NOT NULL,
  unit_cost_snapshot  numeric(14,6) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT skewer_components_item_type_valido CHECK (item_type IN ('ingredient', 'recipe', 'supply')),
  CONSTRAINT skewer_components_estrutura_valida CHECK (
    (item_type = 'ingredient' AND ingredient_id IS NOT NULL AND recipe_id IS NULL AND supply_id IS NULL) OR
    (item_type = 'recipe'     AND recipe_id IS NOT NULL AND ingredient_id IS NULL AND supply_id IS NULL) OR
    (item_type = 'supply'     AND supply_id IS NOT NULL AND ingredient_id IS NULL AND recipe_id IS NULL)
  ),
  CONSTRAINT skewer_components_unit_valida      CHECK (unit IN ('g', 'ml', 'un')),
  CONSTRAINT skewer_components_quantity_positiva CHECK (quantity > 0),
  CONSTRAINT skewer_components_cost_nao_negativo CHECK (unit_cost_snapshot >= 0)
);

-- Única consulta prevista sobre esta tabela filtra por lote (listagem/
-- detalhe de um batch) — sem índice por reference_id, nenhuma consulta
-- prevista precisa dele ainda.
CREATE INDEX idx_skewer_components_batch_id ON public.skewer_batch_components (batch_id);

-- =============================================================
-- 2. RLS — policies existem como defesa/documentação da política da
-- tabela, mas SEM GRANT de escrita pra authenticated (ver seção 3): toda
-- criação/edição de componente passa obrigatoriamente pela RPC
-- save_skewer_production_batch (SECURITY DEFINER), nunca por INSERT/UPDATE/
-- DELETE direto.
-- =============================================================

ALTER TABLE public.skewer_batch_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY skewer_components_select_staff ON public.skewer_batch_components
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY skewer_components_insert_admin ON public.skewer_batch_components
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY skewer_components_update_admin ON public.skewer_batch_components
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY skewer_components_delete_admin ON public.skewer_batch_components
  FOR DELETE TO authenticated USING (public.is_admin());

-- =============================================================
-- 3. GRANTs — só SELECT pra authenticated. Nenhum INSERT/UPDATE/DELETE
-- direto: a cascata de exclusão (ON DELETE CASCADE acima) não exige que
-- authenticated tenha DELETE nesta tabela, só em skewer_production_batches
-- (que ela já tem). REVOKE explícito antes do GRANT — mesmo cuidado já
-- aplicado a toda tabela nova neste projeto desde o caso real de uma
-- tabela herdando privilégio de anon via ALTER DEFAULT PRIVILEGES.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.skewer_batch_components FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.skewer_batch_components FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.skewer_batch_components FROM authenticated;
GRANT SELECT ON TABLE public.skewer_batch_components TO authenticated;

-- =============================================================
-- 4. RPC save_skewer_production_batch — única porta de escrita pra lote +
-- componentes, numa única transação (a própria invocação da função). Se
-- qualquer componente for inválido, o RAISE EXCEPTION desfaz também o
-- INSERT/UPDATE do lote já feito antes no mesmo bloco — nunca fica um lote
-- salvo pela metade. auth.uid() (nunca um parâmetro do client) resolve
-- created_by/updated_by. name_snapshot/unit_cost_snapshot de
-- ingredient/supply são resolvidos inteiramente aqui dentro (nunca
-- confiados do client); só unit_cost_snapshot de recipe vem do client
-- (reaproveitando o cálculo recursivo que já existe em producao.js, sem
-- duplicar a fórmula em SQL), com validação de sanidade (NOT NULL, >= 0).
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
  v_quantity numeric;
  v_unit text;
  v_unit_cost numeric;
  v_name_snapshot text;
  v_ingredient record;
  v_supply record;
  v_recipe_unidades int;
  v_recipe_unit text;
  v_seen_keys text[] := '{}';
  v_key text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar lotes de produção.';
  end if;

  -- Validações do lote — defesa em profundidade, além dos CHECKs da tabela.
  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Produto não encontrado.';
  end if;
  if p_ingredient_id is not null and not exists (select 1 from public.ingredients where id = p_ingredient_id) then
    raise exception 'Ingrediente não encontrado.';
  end if;
  if p_gross_weight_g is null or p_gross_weight_g <= 0 then
    raise exception 'Peso bruto inválido.';
  end if;
  if p_usable_weight_g is null or p_usable_weight_g <= 0 then
    raise exception 'Peso útil inválido.';
  end if;
  if p_usable_weight_g > p_gross_weight_g then
    raise exception 'Peso útil não pode exceder o peso bruto.';
  end if;
  if p_total_cost is null or p_total_cost < 0 then
    raise exception 'Custo total inválido.';
  end if;
  if p_skewer_weight_g is null or p_skewer_weight_g <= 0 then
    raise exception 'Peso por espeto inválido.';
  end if;
  if p_actual_quantity is null or p_actual_quantity <= 0 then
    raise exception 'Quantidade produzida inválida.';
  end if;
  if p_produced_at is null then
    raise exception 'Data de produção obrigatória.';
  end if;

  -- Cria ou edita o lote.
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

  -- Substitui os componentes por completo: sem imutabilidade por item (ao
  -- contrário de recipe_items) — o estado salvo é sempre o estado final da
  -- lista enviada. p_components pode ser [] ou NULL: lote só com carne
  -- continua válido (preserva lotes antigos e o comportamento de hoje).
  delete from public.skewer_batch_components where batch_id = v_batch.id;

  -- Formato de p_components — mensagem controlada em vez de deixar
  -- jsonb_array_elements() falhar com erro interno do Postgres se vier algo
  -- que não seja array (ex. um objeto ou uma string). NULL continua
  -- significando "zero componentes" (não entra neste if).
  if p_components is not null and jsonb_typeof(p_components) <> 'array' then
    raise exception 'Componentes do lote devem ser enviados como uma lista.';
  end if;

  if p_components is not null then
    for v_component in select * from jsonb_array_elements(p_components) loop
      if jsonb_typeof(v_component) <> 'object' then
        raise exception 'Componente do lote inválido.';
      end if;

      v_item_type := v_component->>'item_type';
      v_unit := v_component->>'unit';

      -- reference_id: cast controlado — UUID malformado gera mensagem
      -- controlada em vez de erro interno do Postgres. Campo ausente vira
      -- NULL (sem exceção), capturado logo abaixo pelo "sem referência".
      begin
        v_reference_id := (v_component->>'reference_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'Referência inválida para o componente.';
      end;

      -- quantity: mesmo cuidado — valor não numérico gera mensagem
      -- controlada em vez de erro interno do Postgres.
      begin
        v_quantity := (v_component->>'quantity')::numeric;
      exception when invalid_text_representation then
        raise exception 'Quantidade inválida para o componente.';
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

      -- Duplicidade: mesmo item_type + reference_id não pode aparecer duas vezes no mesmo lote.
      v_key := v_item_type || ':' || v_reference_id::text;
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
        if v_unit <> v_ingredient.base_unit then
          raise exception 'Unidade incompatível com o ingrediente.';
        end if;
        v_name_snapshot := v_ingredient.name;
        v_unit_cost := v_ingredient.cost_per_base_unit;

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

        -- Único valor confiado ao client nesta RPC: custo recursivo de
        -- ficha técnica, já calculado pela função JS existente
        -- (calcularCustoReceitaRecursivo/calcularRendimentoReceita) —
        -- reimplementar essa árvore recursiva em SQL duplicaria a fórmula.
        -- Validação de sanidade abaixo, não recálculo. Cast controlado —
        -- mesmo cuidado do reference_id/quantity acima.
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

      insert into public.skewer_batch_components (
        batch_id, item_type, ingredient_id, recipe_id, supply_id, name_snapshot, quantity, unit, unit_cost_snapshot
      ) values (
        v_batch.id,
        v_item_type,
        case when v_item_type = 'ingredient' then v_reference_id end,
        case when v_item_type = 'recipe' then v_reference_id end,
        case when v_item_type = 'supply' then v_reference_id end,
        v_name_snapshot,
        v_quantity,
        v_unit,
        v_unit_cost
      );
    end loop;
  end if;

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
-- 5. Fecha o INSERT/UPDATE direto que authenticated ainda tinha em
-- skewer_production_batches desde a Etapa 1 (GRANT SELECT, INSERT, UPDATE,
-- DELETE, migration 20260818090000). Com save_skewer_production_batch
-- existindo, esse INSERT/UPDATE direto contornaria justamente as
-- validações que a RPC agora centraliza (existência de produto/ingrediente,
-- consistência de pesos, e principalmente a substituição atômica de
-- componentes) — mesma correção já aplicada em recipe_items, desta vez
-- feita já na etapa que introduz a RPC, em vez de precisar de uma rodada
-- de correção depois.
--
-- SELECT direto permanece permitido — continua protegido pela RLS/
-- is_staff(), sem mudança nenhuma.
--
-- DELETE direto permanece permitido — continua protegido pela RLS/
-- is_admin(); excluir um lote não tem risco de inconsistência de
-- componentes (a cascata do item 1 acima cuida disso), por isso não
-- precisa passar pela RPC.
--
-- INSERT e UPDATE diretos deixam de ser permitidos para authenticated a
-- partir daqui — criação e edição de lote passam obrigatoriamente por
-- public.save_skewer_production_batch(). A RPC continua funcionando pós-
-- REVOKE porque é SECURITY DEFINER, e continua validando public.is_admin()
-- logo no início.
--
-- As policies skewer_batches_insert_admin/update_admin (migration
-- 20260818090000) NÃO são removidas — ficam como defesa redundante e
-- documentação da política da tabela, sem efeito prático depois deste
-- REVOKE.
-- =============================================================

REVOKE INSERT, UPDATE
  ON TABLE public.skewer_production_batches
  FROM authenticated;

-- =============================================================
-- 6. GRANTs da função. Postgres concede EXECUTE a PUBLIC automaticamente em
-- toda CREATE FUNCTION — precisa REVOKE explícito, mesmo cuidado já
-- aplicado a toda função nova neste projeto.
-- =============================================================

REVOKE ALL ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_skewer_production_batch(uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) TO authenticated;

-- Nenhuma outra alteração: product_costs, products, ingredients, recipes,
-- recipe_items, production_supplies, orders, estoque e Relatórios
-- permanecem exatamente como estavam. Nenhum arquivo de UI
-- (producao.html/producao.js/producao.css) foi alterado — só o service
-- (skewer-production-service.js) passa a chamar esta RPC por baixo dos
-- mesmos nomes de função já usados pela Etapa 2.
