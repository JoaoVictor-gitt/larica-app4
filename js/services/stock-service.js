/*
 * stock-service.js — Fase D (estoque rastreável)
 *
 * Todo ajuste manual passa por RPC, com motivo obrigatório e idempotência por
 * client_request_id (repetir o envio não duplica):
 *   adjust_product_stock — produto de venda (unidades): entrada, saída, perda, contagem;
 *   adjust_item_stock    — insumo (g/ml/un): idem; entrada pode informar custo
 *                          unitário, que entra no custo médio ponderado;
 *   set_min_stock        — estoque mínimo (alerta de estoque baixo), admin;
 *   get_stock_movements  — histórico unificado (produtos + insumos) com responsável.
 * Nomes com "EstoqueRastreavel" para não colidir com storage.js/products-service.js.
 */

function _erroEstoqueRastreavel(error) {
  const e = new Error(error.message);
  e.dica = error.hint || null;
  return e;
}

async function ajustarProdutoEstoqueRastreavel(payload) {
  const { data, error } = await supabaseClient.rpc('adjust_product_stock', { p_payload: payload });
  if (error) throw _erroEstoqueRastreavel(error);
  return data;
}

async function ajustarInsumoEstoqueRastreavel(payload) {
  const { data, error } = await supabaseClient.rpc('adjust_item_stock', { p_payload: payload });
  if (error) throw _erroEstoqueRastreavel(error);
  return data;
}

/** tipo: 'product' | 'item'. minimo null limpa. Para insumo, em unidade-base (g/ml/un). */
async function definirMinimoEstoqueRastreavel(tipo, id, minimo) {
  const { error } = await supabaseClient.rpc('set_min_stock', { p_kind: tipo, p_id: id, p_min: minimo });
  if (error) throw _erroEstoqueRastreavel(error);
}

/** filtros: { ledger, target_id, types: [...], date_from, date_to, limit } */
async function buscarMovimentosEstoqueRastreavel(filtros) {
  const { data, error } = await supabaseClient.rpc('get_stock_movements', { p_filters: filtros || {} });
  if (error) throw _erroEstoqueRastreavel(error);
  return (data || []).map((m) => ({
    livro: m.ledger,
    id: m.id,
    criadoEm: m.created_at,
    alvoId: m.target_id,
    alvoNome: m.target_name,
    unidadeBase: m.base_unit,
    tipo: m.movement_type,
    quantidade: Number(m.quantity),
    saldoAntes: Number(m.balance_before),
    saldoDepois: Number(m.balance_after),
    custoUnitario: m.unit_cost === null ? null : Number(m.unit_cost),
    valor: m.total_value === null ? null : Number(m.total_value),
    origemTipo: m.source_type,
    origemId: m.source_id,
    motivo: m.reason,
    numeroPedido: m.order_number,
    responsavel: m.responsible,
  }));
}
