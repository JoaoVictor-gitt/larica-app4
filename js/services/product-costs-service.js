/*
 * product-costs-service.js
 * Único arquivo que fala com o Supabase para public.product_costs (custo
 * unitário atual de cada produto). Tabela separada de products de propósito:
 * anon não tem GRANT nenhum aqui, só authenticated (SELECT para staff — ver
 * migration 20260817140000). Escrita (criar/atualizar custo) passa inteira
 * por RPC administrativa desde a migration 20260818120000: nunca um INSERT/
 * UPDATE direto na tabela — authenticated não tem mais esse GRANT. Duas
 * RPCs, cada uma validando a categoria real do produto NO BANCO (nunca
 * confiando em nada vindo do client):
 *   - save_product_cost_manual: fluxo manual (produtos.js), rejeita
 *     produtos da categoria 'skewers' (Espetinhos só recebem custo pela
 *     Produção).
 *   - apply_skewer_production_cost: fluxo de Produção de Espetos
 *     (producao.js) — recebe só o id do lote, nunca um custo; a RPC
 *     recalcula o valor inteiramente a partir dos snapshots do lote e
 *     resolve o produto sozinha (skewer_production_batches.product_id),
 *     rejeitando quando esse produto não é da categoria 'skewers'.
 * NUNCA carregar este arquivo em pedido.html/js/pedido.js (área pública) —
 * só nas páginas admin que precisam mostrar/editar custo (produtos.js,
 * producao.js). Depende de js/supabase.js (supabaseClient), carregado
 * antes deste arquivo.
 */

/**
 * Busca o custo atual de todos os produtos numa única consulta (nunca uma
 * por produto — evita N+1 na tela de Produtos). Produtos sem linha aqui
 * simplesmente não aparecem no resultado; quem chama trata a ausência como
 * "custo não cadastrado" (equivalente a unit_cost NULL), nunca como 0.
 */
async function buscarCustosProdutosDoSupabase() {
  const { data, error } = await supabaseClient.from('product_costs').select('product_id, unit_cost, updated_at, updated_by');
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Cria ou atualiza o custo MANUAL de um produto — chama a RPC
 * save_product_cost_manual (SECURITY DEFINER), que valida server-side que
 * o produto não é da categoria 'skewers' (Espetinhos) antes de gravar;
 * chamar isto para um Espetinho sempre falha, com a mensagem da RPC. Para
 * Espetinhos, usar aplicarCustoProducaoEspetoNoSupabase. `unitCost` pode
 * ser `null` — a RPC grava/mantém a linha com unit_cost NULL em vez de
 * removê-la (ausência física de linha e unit_cost NULL já são equivalentes
 * em toda leitura). Mesma assinatura e comportamento de erro de antes da
 * migration 20260818120000 — nenhuma mudança necessária em produtos.js.
 * RLS/RPC restringem esta operação a admin.
 */
async function salvarCustoProdutoNoSupabase(productId, unitCost) {
  const { error } = await supabaseClient.rpc('save_product_cost_manual', {
    p_product_id: productId,
    p_unit_cost: unitCost,
  });
  if (error) throw new Error(error.message);
}

/**
 * Aplica o custo real final de um lote de Produção de Espetos ao produto —
 * chama a RPC apply_skewer_production_cost (SECURITY DEFINER), passando só
 * o id do lote. A RPC recalcula o custo inteiramente a partir dos
 * snapshots salvos (total_cost do lote + soma de quantity×unit_cost_snapshot
 * dos componentes) e resolve o product_id sozinha, a partir do próprio
 * lote — nunca confia em nenhum valor calculado no client. Único caminho
 * autorizado pra esse custo; nunca chamar salvarCustoProdutoNoSupabase
 * para um Espetinho. Retorna o que a RPC gravou de fato (product_id,
 * batch_id, unit_cost, updated_at, updated_by) — quem chama deve usar esse
 * retorno pra atualizar cache/UI, nunca o valor calculado localmente.
 * RLS/RPC restringem esta operação a admin.
 */
async function aplicarCustoProducaoEspetoNoSupabase(batchId) {
  const { data, error } = await supabaseClient.rpc('apply_skewer_production_cost', {
    p_batch_id: batchId,
  });
  if (error) throw new Error(error.message);
  return {
    produtoId: data.product_id,
    loteId: data.batch_id,
    unitCost: data.unit_cost === null || data.unit_cost === undefined ? null : Number(data.unit_cost),
    atualizadoEm: data.updated_at,
    atualizadoPor: data.updated_by,
  };
}
