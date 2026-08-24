-- Fecha a segurança de public.product_costs — Produtos Espetinhos.
--
-- A partir desta migration:
--
-- 1. authenticated NÃO pode mais fazer INSERT/UPDATE/DELETE direto
--    em public.product_costs.
--
-- 2. Custos manuais de produtos não-Espetinhos passam obrigatoriamente
--    por public.save_product_cost_manual().
--
-- 3. Custos de produtos da categoria 'skewers' passam obrigatoriamente
--    por public.apply_skewer_production_cost().
--
-- 4. apply_skewer_production_cost recebe SOMENTE o ID de um lote salvo.
--    O product_id e o custo são calculados dentro do banco.
--
-- 5. O custo de um Espetinho é calculado usando exclusivamente:
--
--      skewer_production_batches.total_cost
--      +
--      SUM(
--        skewer_batch_components.quantity
--        *
--        skewer_batch_components.unit_cost_snapshot
--      )
--
--      dividido por:
--
--      skewer_production_batches.actual_quantity
--
--    Portanto preços atuais de ingredients, recipes ou
--    production_supplies NÃO são usados na aplicação do custo.
--
-- 6. Não altera:
--    - schema de product_costs;
--    - create_customer_order;
--    - pedidos;
--    - snapshots;
--    - estoque;
--    - Relatório Diário;
--    - lotes de produção;
--    - componentes dos lotes.
--
-- Migration incremental.
-- NÃO editar migrations antigas.


-- =============================================================
-- 1. RPC DE CUSTO MANUAL
--
-- Usada pela tela Produtos para categorias que ainda permitem
-- custo manual.
--
-- Produtos da categoria 'skewers' são rejeitados server-side.
--
-- A categoria é SEMPRE consultada em public.products.
-- O client nunca informa a categoria.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_product_cost_manual(
  p_product_id uuid,
  p_unit_cost numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_category text;
  v_result record;
begin

  -- -----------------------------------------------------------
  -- Segurança
  -- -----------------------------------------------------------

  if not public.is_admin() then
    raise exception
      'Apenas administradores podem alterar o custo de produtos.';
  end if;


  -- -----------------------------------------------------------
  -- Produto
  --
  -- A categoria vem diretamente do banco.
  -- FOUND diferencia corretamente:
  --
  -- produto inexistente
  --
  -- de
  --
  -- produto existente com category NULL.
  -- -----------------------------------------------------------

  select category
  into v_category
  from public.products
  where id = p_product_id;

  if not found then
    raise exception 'Produto não encontrado.';
  end if;


  -- -----------------------------------------------------------
  -- Espetinhos não aceitam custo manual.
  --
  -- O único fluxo permitido para category='skewers' é
  -- apply_skewer_production_cost().
  -- -----------------------------------------------------------

  if v_category = 'skewers' then
    raise exception
      'O custo de produtos da categoria Espetinhos deve ser aplicado pela Produção.';
  end if;


  -- -----------------------------------------------------------
  -- Validação do custo.
  --
  -- NULL continua permitido no fluxo manual porque product_costs.unit_cost
  -- é nullable e esse era o comportamento existente.
  --
  -- Valor negativo nunca é permitido.
  -- -----------------------------------------------------------

  if p_unit_cost is not null
     and p_unit_cost < 0 then
    raise exception 'Custo inválido.';
  end if;


  -- -----------------------------------------------------------
  -- UPSERT
  --
  -- product_costs possui uma única linha atual por produto.
  -- Não existe histórico nesta tabela.
  -- -----------------------------------------------------------

  insert into public.product_costs (
    product_id,
    unit_cost,
    updated_at,
    updated_by
  )
  values (
    p_product_id,
    p_unit_cost,
    now(),
    auth.uid()
  )
  on conflict (product_id)
  do update
    set unit_cost = excluded.unit_cost,
        updated_at = now(),
        updated_by = auth.uid()
  returning *
  into v_result;


  -- -----------------------------------------------------------
  -- Retorno
  -- -----------------------------------------------------------

  return jsonb_build_object(
    'product_id', v_result.product_id,
    'unit_cost', v_result.unit_cost,
    'updated_at', v_result.updated_at,
    'updated_by', v_result.updated_by
  );

end;
$function$;


-- =============================================================
-- 2. RPC DE APLICAÇÃO DO CUSTO DA PRODUÇÃO DE ESPETOS
--
-- Único caminho autorizado para atualizar product_costs de
-- produtos category='skewers'.
--
-- IMPORTANTE:
--
-- O caller envia SOMENTE:
--
--   p_batch_id
--
-- O caller NÃO envia:
--
--   product_id
--   unit_cost
--   custo da carne
--   custo dos componentes
--   quantidade produzida
--
-- Tudo isso é obtido diretamente do lote salvo no banco.
--
-- Isso impede que DevTools/client/console alterem arbitrariamente
-- o custo aplicado a um Espetinho.
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_skewer_production_cost(
  p_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_batch public.skewer_production_batches%rowtype;
  v_category text;

  v_custo_componentes numeric;
  v_custo_final_lote numeric;
  v_custo_real_final numeric;

  v_result record;
begin

  -- -----------------------------------------------------------
  -- Segurança
  -- -----------------------------------------------------------

  if not public.is_admin() then
    raise exception
      'Apenas administradores podem aplicar custo de produção.';
  end if;


  -- -----------------------------------------------------------
  -- Carrega e trava o lote.
  --
  -- FOR UPDATE garante que o registro do lote não seja alterado
  -- simultaneamente enquanto o custo está sendo calculado.
  -- -----------------------------------------------------------

  select *
  into v_batch
  from public.skewer_production_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Lote de produção não encontrado.';
  end if;


  -- -----------------------------------------------------------
  -- Categoria do produto
  --
  -- product_id vem EXCLUSIVAMENTE do lote.
  --
  -- Nunca é recebido do client.
  -- -----------------------------------------------------------

  select category
  into v_category
  from public.products
  where id = v_batch.product_id;


  -- A FK do lote já garante que product_id referencia products.
  --
  -- IS DISTINCT FROM também rejeita category NULL.
  if v_category is distinct from 'skewers' then
    raise exception
      'Este lote não pertence a um produto da categoria Espetinhos.';
  end if;


  -- -----------------------------------------------------------
  -- Quantidade real produzida
  --
  -- O CHECK da tabela já exige actual_quantity > 0.
  -- Esta validação é mantida como defesa adicional.
  -- -----------------------------------------------------------

  if v_batch.actual_quantity is null
     or v_batch.actual_quantity <= 0 then
    raise exception
      'Quantidade produzida inválida para este lote.';
  end if;


  -- -----------------------------------------------------------
  -- Custo histórico dos componentes
  --
  -- Usa SOMENTE snapshots persistidos em:
  --
  -- skewer_batch_components.unit_cost_snapshot
  --
  -- NÃO consulta preços atuais de:
  --
  -- ingredients
  -- recipes
  -- production_supplies
  --
  -- Se o lote não possuir componentes:
  --
  -- custo_componentes = 0
  -- -----------------------------------------------------------

  select coalesce(
    sum(
      quantity
      *
      unit_cost_snapshot
    ),
    0
  )
  into v_custo_componentes
  from public.skewer_batch_components
  where batch_id = p_batch_id;


  -- -----------------------------------------------------------
  -- Custo final histórico do lote
  --
  -- total_cost = custo da carne registrado no lote.
  --
  -- componentes = palitos/insumos/ingredientes/preparos
  -- conforme snapshots históricos.
  -- -----------------------------------------------------------

  v_custo_final_lote :=
    v_batch.total_cost
    +
    v_custo_componentes;


  -- -----------------------------------------------------------
  -- Custo real final por Espetinho
  --
  -- NÃO arredondar aqui.
  --
  -- product_costs.unit_cost é numeric(12,4), portanto o próprio
  -- PostgreSQL fará a persistência na precisão da coluna.
  -- -----------------------------------------------------------

  v_custo_real_final :=
    v_custo_final_lote
    /
    v_batch.actual_quantity;


  -- -----------------------------------------------------------
  -- Atualiza o custo atual do produto.
  --
  -- product_id vem do lote.
  -- unit_cost foi calculado inteiramente no banco.
  -- -----------------------------------------------------------

  insert into public.product_costs (
    product_id,
    unit_cost,
    updated_at,
    updated_by
  )
  values (
    v_batch.product_id,
    v_custo_real_final,
    now(),
    auth.uid()
  )
  on conflict (product_id)
  do update
    set unit_cost = excluded.unit_cost,
        updated_at = now(),
        updated_by = auth.uid()
  returning *
  into v_result;


  -- -----------------------------------------------------------
  -- Retorno
  --
  -- O client deve usar unit_cost RETORNADO pelo banco para
  -- atualizar seu cache.
  --
  -- Não deve assumir que o valor calculado previamente no
  -- navegador foi necessariamente o valor persistido.
  -- -----------------------------------------------------------

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
-- 3. FECHA ESCRITA DIRETA EM PRODUCT_COSTS
--
-- authenticated anteriormente possuía:
--
-- SELECT
-- INSERT
-- UPDATE
-- DELETE
--
-- Depois desta migration, mantém somente SELECT direto.
--
-- Toda escrita passa obrigatoriamente pelas RPCs acima.
--
-- DELETE também é removido porque a auditoria confirmou que
-- nenhum fluxo da aplicação exclui linhas de product_costs.
--
-- As policies antigas podem continuar existindo como defesa
-- redundante/documentação.
-- =============================================================

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.product_costs
FROM authenticated;


-- =============================================================
-- 4. SEGURANÇA / GRANTS
-- save_product_cost_manual(uuid, numeric)
--
-- CREATE FUNCTION concede EXECUTE a PUBLIC por padrão.
-- Removemos explicitamente antes de liberar para authenticated.
--
-- A própria função continua validando is_admin().
-- =============================================================

REVOKE ALL
ON FUNCTION public.save_product_cost_manual(uuid, numeric)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.save_product_cost_manual(uuid, numeric)
FROM anon;

GRANT EXECUTE
ON FUNCTION public.save_product_cost_manual(uuid, numeric)
TO authenticated;


-- =============================================================
-- 5. SEGURANÇA / GRANTS
-- apply_skewer_production_cost(uuid)
--
-- Somente authenticated recebe EXECUTE.
-- A função internamente exige is_admin().
-- =============================================================

REVOKE ALL
ON FUNCTION public.apply_skewer_production_cost(uuid)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.apply_skewer_production_cost(uuid)
FROM anon;

GRANT EXECUTE
ON FUNCTION public.apply_skewer_production_cost(uuid)
TO authenticated;


-- =============================================================
-- ESTADO FINAL
-- =============================================================
--
-- public.product_costs
--
-- authenticated:
--
--   SELECT direto: SIM
--   INSERT direto: NÃO
--   UPDATE direto: NÃO
--   DELETE direto: NÃO
--
--
-- CUSTO MANUAL
--
-- Produtos não-Espetinhos:
--
--   save_product_cost_manual(product_id, unit_cost)
--
--
-- ESPETINHOS
--
-- Único caminho:
--
--   apply_skewer_production_cost(batch_id)
--
-- O custo é calculado server-side:
--
--   (
--     skewer_production_batches.total_cost
--     +
--     SUM(
--       skewer_batch_components.quantity
--       *
--       skewer_batch_components.unit_cost_snapshot
--     )
--   )
--   /
--   skewer_production_batches.actual_quantity
--
--
-- NÃO ALTERADO:
--
-- create_customer_order
-- products
-- orders
-- order_items
-- order_item_selections
-- estoque
-- Relatório Diário
-- skewer_production_batches
-- skewer_batch_components
--
-- Nenhuma migration anterior deve ser editada.
-- =============================================================
