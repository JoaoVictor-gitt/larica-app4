-- Produção de Acompanhamentos — ETAPA B (componentes do lote + RPCs).
-- Cria public.side_batch_components: componentes (ingrediente/preparo)
-- usados num lote de acompanhamento, cada um preservando snapshot
-- histórico de nome/quantidade/unidade/custo — um lote é um EVENTO
-- HISTÓRICO, nunca muda de custo porque o cadastro referenciado mudou de
-- preço depois (mesma disciplina já usada em skewer_batch_components).
-- Cria save_side_production_batch (única porta de escrita pra lote +
-- componentes, numa única transação) e apply_side_production_cost (única
-- porta de escrita pra product_costs a partir de um lote de
-- acompanhamento, nunca recebendo um número do client — só o id do lote,
-- mesmo padrão já corrigido em apply_skewer_production_cost). Fecha o
-- GRANT direto de INSERT/UPDATE que authenticated tinha em
-- side_production_batches desde a Etapa A (SELECT/DELETE continuam
-- diretos). NÃO altera UI nenhuma (Etapa C). Não altera product_costs
-- (schema), products, ingredients, recipes, recipe_items,
-- skewer_production_batches, skewer_batch_components,
-- production_supplies, orders, create_customer_order, business_settings,
-- estoque, save_product_cost_manual ou qualquer outra tabela/função. Não
-- edita a migration da Etapa A (20260818130000).

-- =============================================================
-- 1. Tabela side_batch_components.
-- item_type só 'ingredient'/'recipe' nesta V1 — sem 'supply' (não há caso
-- de uso real de insumo em acompanhamentos hoje; ampliar depois é só
-- estender o CHECK, sem quebrar nada). XOR entre ingredient_id/recipe_id
-- garantido por CHECK, mesmo padrão de skewer_batch_components/
-- recipe_items. Sem total_cost_snapshot — 100% derivável
-- (quantity × unit_cost_snapshot). ingredient_id/recipe_id SEM ON DELETE
-- CASCADE nem SET NULL — NO ACTION (RESTRICT-equivalente): SET NULL seria
-- estruturalmente incompatível com o CHECK XOR (anular a referência
-- violaria a própria constraint), mesmo raciocínio já documentado em
-- skewer_batch_components.
-- =============================================================

CREATE TABLE public.side_batch_components (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL REFERENCES public.side_production_batches(id) ON DELETE CASCADE,
  item_type           text NOT NULL,
  ingredient_id       uuid NULL REFERENCES public.ingredients(id),
  recipe_id           uuid NULL REFERENCES public.recipes(id),
  name_snapshot       text NOT NULL,
  quantity            numeric(12,3) NOT NULL,
  unit                text NOT NULL,
  unit_cost_snapshot  numeric(14,6) NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT side_components_item_type_valido CHECK (item_type IN ('ingredient', 'recipe')),
  CONSTRAINT side_components_estrutura_valida CHECK (
    (item_type = 'ingredient' AND ingredient_id IS NOT NULL AND recipe_id IS NULL) OR
    (item_type = 'recipe'     AND recipe_id IS NOT NULL AND ingredient_id IS NULL)
  ),
  CONSTRAINT side_components_unit_valida            CHECK (unit IN ('g', 'ml', 'un')),
  CONSTRAINT side_components_quantity_positiva      CHECK (quantity > 0),
  CONSTRAINT side_components_cost_nao_negativo      CHECK (unit_cost_snapshot >= 0),
  CONSTRAINT side_components_name_snapshot_nao_vazio CHECK (length(trim(name_snapshot)) > 0)
);

-- Única consulta prevista sobre esta tabela filtra por lote (listagem/
-- detalhe de um batch) — sem índice por reference_id, nenhuma consulta
-- prevista precisa dele ainda.
CREATE INDEX idx_side_batch_components_batch_id ON public.side_batch_components (batch_id);

-- =============================================================
-- 2. RLS — policies existem como defesa/documentação da política da
-- tabela, mas SEM GRANT de escrita pra authenticated (ver seção 3): toda
-- criação/edição de componente passa obrigatoriamente pela RPC
-- save_side_production_batch (SECURITY DEFINER), nunca por INSERT/UPDATE/
-- DELETE direto.
-- =============================================================

ALTER TABLE public.side_batch_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY side_components_select_staff ON public.side_batch_components
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY side_components_insert_admin ON public.side_batch_components
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY side_components_update_admin ON public.side_batch_components
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY side_components_delete_admin ON public.side_batch_components
  FOR DELETE TO authenticated USING (public.is_admin());

-- =============================================================
-- 3. GRANTs — só SELECT pra authenticated. Nenhum INSERT/UPDATE/DELETE
-- direto: a cascata de exclusão (ON DELETE CASCADE acima) não exige que
-- authenticated tenha DELETE nesta tabela, só em side_production_batches
-- (que ela já tem). REVOKE explícito antes do GRANT — mesmo cuidado já
-- aplicado a toda tabela nova neste projeto desde o caso real de uma
-- tabela herdando privilégio de anon via ALTER DEFAULT PRIVILEGES.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.side_batch_components FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.side_batch_components FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.side_batch_components FROM authenticated;
GRANT SELECT ON TABLE public.side_batch_components TO authenticated;

-- =============================================================
-- 4. RPC save_side_production_batch — única porta de escrita pra lote +
-- componentes, numa única transação (a própria invocação da função). Se
-- qualquer componente for inválido, o RAISE EXCEPTION desfaz também o
-- INSERT/UPDATE do lote já feito antes no mesmo bloco — nunca fica um lote
-- salvo pela metade. auth.uid() (nunca um parâmetro do client) resolve
-- created_by/updated_by. Categoria do produto ('sides') é validada aqui
-- dentro, direto de products.category — nunca confiada do client.
-- name_snapshot/unit_cost_snapshot de ingredient são resolvidos
-- inteiramente aqui dentro (nunca confiados do client); só
-- unit_cost_snapshot de recipe vem do client (reaproveitando o cálculo
-- recursivo que já existe em producao.js, sem duplicar a fórmula em SQL),
-- com validação de sanidade (NOT NULL, >= 0) + validação estrutural real
-- (receita existe, unidade única, unidade bate). Rendimento/porção que não
-- produzam ao menos 1 porção teórica são sempre rejeitados, mesmo com
-- actual_portions informado — evita mascarar um provável erro de
-- digitação (unidades trocadas) e garante que apply_side_production_cost
-- nunca precise dividir por zero.
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
  v_quantity numeric;
  v_unit text;
  v_unit_cost numeric;
  v_name_snapshot text;
  v_ingredient record;
  v_recipe_unidades int;
  v_recipe_unit text;
  v_seen_keys text[] := '{}';
  v_key text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar lotes de acompanhamento.';
  end if;

  -- Produto: existe e é da categoria certa — nunca confiado do client.
  select category into v_category from public.products where id = p_product_id;
  if v_category is null then
    raise exception 'Produto não encontrado.';
  end if;
  if v_category is distinct from 'sides' then
    raise exception 'Este produto não pertence à categoria Acompanhamentos.';
  end if;

  -- Validações do lote — defesa em profundidade, além dos CHECKs da tabela.
  if p_produced_at is null then
    raise exception 'Data de produção obrigatória.';
  end if;
  if p_final_yield_quantity is null or p_final_yield_quantity <= 0 then
    raise exception 'Rendimento final inválido.';
  end if;
  if p_final_yield_unit is null or p_final_yield_unit not in ('g','ml','un') then
    raise exception 'Unidade de rendimento inválida.';
  end if;
  if p_portion_quantity is null or p_portion_quantity <= 0 then
    raise exception 'Quantidade da porção inválida.';
  end if;
  if p_portion_unit is null or p_portion_unit not in ('g','ml','un') then
    raise exception 'Unidade da porção inválida.';
  end if;
  if p_portion_unit <> p_final_yield_unit then
    raise exception 'A unidade da porção deve ser igual à unidade do rendimento.';
  end if;
  if p_actual_portions is not null and p_actual_portions <= 0 then
    raise exception 'Quantidade real de porções inválida.';
  end if;

  -- Rendimento/porção precisam produzir ao menos 1 porção teórica — mesmo
  -- com actual_portions informado, um rendimento menor que a própria
  -- porção indica erro de digitação (ex. unidades trocadas), não um caso
  -- real válido.
  v_theoretical_portions := floor(p_final_yield_quantity / p_portion_quantity);
  if v_theoretical_portions < 1 then
    raise exception 'O rendimento informado não produz nenhuma porção válida.';
  end if;

  -- Cria ou edita o lote.
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

  -- Substitui os componentes por completo: sem imutabilidade por item — o
  -- estado salvo é sempre o estado final da lista enviada. p_components
  -- pode ser [] ou NULL: tecnicamente válido nesta etapa (sem UI ainda),
  -- mesmo que um lote sem componentes não tenha custo nenhum — a Etapa C
  -- pode exigir pelo menos 1 componente antes de habilitar "Salvar", sem
  -- que isso precise ser reforçado aqui no banco.
  delete from public.side_batch_components where batch_id = v_batch.id;

  -- Formato de p_components — mensagem controlada em vez de deixar
  -- jsonb_array_elements() falhar com erro interno do Postgres se vier
  -- algo que não seja array. NULL continua significando "zero
  -- componentes" (não entra neste if).
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

      -- reference_id: cast controlado — valor malformado gera mensagem
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

      -- Duplicidade: mesmo item_type + reference_id não pode aparecer
      -- duas vezes no mesmo lote.
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

      insert into public.side_batch_components (
        batch_id, item_type, ingredient_id, recipe_id, name_snapshot, quantity, unit, unit_cost_snapshot
      ) values (
        v_batch.id,
        v_item_type,
        case when v_item_type = 'ingredient' then v_reference_id end,
        case when v_item_type = 'recipe' then v_reference_id end,
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
      (select jsonb_agg(to_jsonb(c)) from public.side_batch_components c where c.batch_id = v_batch.id),
      '[]'::jsonb
    )
  );
end;
$function$;

-- =============================================================
-- 5. Fecha o INSERT/UPDATE direto que authenticated ainda tinha em
-- side_production_batches desde a Etapa A (GRANT SELECT, INSERT, UPDATE,
-- DELETE, migration 20260818130000). Com save_side_production_batch
-- existindo, esse INSERT/UPDATE direto contornaria justamente as
-- validações que a RPC agora centraliza (categoria do produto,
-- consistência de rendimento/porção, e principalmente a substituição
-- atômica de componentes) — mesma correção já aplicada a
-- skewer_production_batches, desta vez feita já na etapa que introduz a
-- RPC, em vez de precisar de uma rodada de correção depois.
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
-- public.save_side_production_batch(). A RPC continua funcionando pós-
-- REVOKE porque é SECURITY DEFINER, e continua validando
-- public.is_admin() logo no início.
--
-- As policies side_batches_insert_admin/update_admin (migration
-- 20260818130000) NÃO são removidas — ficam como defesa redundante e
-- documentação da política da tabela, sem efeito prático depois deste
-- REVOKE.
-- =============================================================

REVOKE INSERT, UPDATE
  ON TABLE public.side_production_batches
  FROM authenticated;

-- =============================================================
-- 6. RPC apply_side_production_cost — única porta de escrita pra
-- product_costs a partir de um lote de acompanhamento. Recebe SOMENTE
-- p_batch_id: product_id, final_yield_quantity, portion_quantity,
-- actual_portions e todos os unit_cost_snapshot dos componentes vêm
-- exclusivamente do banco, dentro da própria transação (FOR UPDATE no
-- lote) — nunca um número vindo do client. Mesmo padrão já corrigido em
-- apply_skewer_production_cost.
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_side_production_cost(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_batch public.side_production_batches%rowtype;
  v_category text;
  v_custo_componentes numeric;
  v_quantidade_teorica numeric;
  v_quantidade_final numeric;
  v_custo_real numeric;
  v_result record;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem aplicar custo de produção.';
  end if;

  -- Lock de consistência: nada altera o lote durante o cálculo.
  select * into v_batch from public.side_production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote de acompanhamento não encontrado.';
  end if;

  -- product_id vem exclusivamente do lote — nunca de parâmetro do client.
  select category into v_category from public.products where id = v_batch.product_id;
  if v_category is distinct from 'sides' then
    raise exception 'Este lote não pertence a um produto da categoria Acompanhamentos.';
  end if;

  -- Só snapshots salvos — nunca ingredients/recipes atuais.
  select coalesce(sum(quantity * unit_cost_snapshot), 0)
    into v_custo_componentes
    from public.side_batch_components
   where batch_id = p_batch_id;

  v_quantidade_teorica := floor(v_batch.final_yield_quantity / v_batch.portion_quantity);
  v_quantidade_final := coalesce(v_batch.actual_portions, v_quantidade_teorica);

  -- Defensivo — save_side_production_batch já garante quantidade teórica
  -- >= 1 em qualquer lote salvo, mas esta RPC não confia só nisso.
  if v_quantidade_final is null or v_quantidade_final <= 0 then
    raise exception 'Quantidade de porções inválida para este lote.';
  end if;

  v_custo_real := v_custo_componentes / v_quantidade_final;

  insert into public.product_costs (product_id, unit_cost, updated_at, updated_by)
  values (v_batch.product_id, v_custo_real, now(), auth.uid())
  on conflict (product_id) do update
    set unit_cost = excluded.unit_cost, updated_at = now(), updated_by = auth.uid()
  returning * into v_result;

  return jsonb_build_object(
    'product_id', v_result.product_id,
    'batch_id', v_batch.id,
    'unit_cost', v_result.unit_cost,
    'updated_at', v_result.updated_at,
    'updated_by', v_result.updated_by
  );
end;
$function$;

-- =============================================================
-- 7. GRANTs das funções. Postgres concede EXECUTE a PUBLIC
-- automaticamente em toda CREATE FUNCTION — precisa REVOKE explícito,
-- mesmo cuidado já aplicado a toda função nova neste projeto.
-- =============================================================

REVOKE ALL ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.apply_side_production_cost(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_side_production_cost(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_side_production_cost(uuid) TO authenticated;

-- Nenhuma outra alteração: product_costs (schema), products, ingredients,
-- recipes, recipe_items, skewer_production_batches,
-- skewer_batch_components, production_supplies,
-- save_product_cost_manual, orders, create_customer_order,
-- business_settings, estoque e Relatórios permanecem exatamente como
-- estavam. Nenhum arquivo de UI (producao.html/producao.js/producao.css)
-- foi alterado — a Etapa C consumirá esta RPC.
