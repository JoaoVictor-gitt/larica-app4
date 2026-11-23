/*
 * production-service.js — Fase C (produção simplificada, sem lotes)
 *
 * Toda escrita passa por RPC:
 *   preview_production  — calcula sem gravar (g/espeto, porções, custo, ingredientes,
 *                         falta de estoque); a tela usa para a prévia ao vivo;
 *   confirm_production  — grava a produção, baixa matéria-prima/ingredientes e dá
 *                         entrada no produto numa transação só; idempotente por
 *                         client_request_id; recusa estoque insuficiente com
 *                         hint 'larica:insufficient_stock' até vir allow_negative;
 *   cancel_production   — estorno (a produção fica registrada como cancelada).
 * Nomes com "LoteProducao" para não colidir com funções globais de outros
 * arquivos carregados na mesma página (producao.js, purchases-service.js).
 */

function _linhaParaLoteProducao(l) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: l.id,
    tipo: l.kind,
    produtoId: l.product_id,
    produzidoEm: l.produced_at,
    materiaPrimaId: l.raw_item_id,
    pesoBrutoG: num(l.raw_quantity_g),
    receitaId: l.recipe_id,
    vezesReceita: num(l.recipe_multiplier),
    pesoFinalG: num(l.output_weight_g),
    porcaoG: num(l.portion_g),
    unidades: Number(l.units_produced),
    custoTotal: num(l.total_cost),
    custoUnitario: num(l.unit_cost),
    statusCusto: l.cost_status,
    custoAplicadoNoProduto: !!l.product_cost_applied,
    estoqueNegativoAutorizado: !!l.stock_negative_authorized,
    status: l.status,
    observacoes: l.notes,
    canceladaEm: l.cancelled_at,
    motivoCancelamento: l.cancel_reason,
    criadoEm: l.created_at,
  };
}

function _erroRpcLoteProducao(error) {
  const e = new Error(error.message);
  e.dica = error.hint || null;
  return e;
}

async function buscarLotesProducaoDoSupabase() {
  const { data, error } = await supabaseClient
    .from('production_batches')
    .select('*')
    .order('produced_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaParaLoteProducao);
}

async function buscarInsumosLoteProducaoDoSupabase(loteId) {
  const { data, error } = await supabaseClient.from('production_batch_inputs').select('*').eq('batch_id', loteId);
  if (error) throw new Error(error.message);
  return (data || []).map((i) => ({
    id: i.id,
    itemCompraId: i.purchase_item_id,
    ingredienteId: i.ingredient_id,
    nome: i.name_snapshot,
    quantidade: Number(i.quantity),
    unidadeBase: i.base_unit,
    custoUnitario: i.unit_cost === null ? null : Number(i.unit_cost),
    custoTotal: i.total_cost === null ? null : Number(i.total_cost),
    baixaEstoque: !!i.stock_moved,
  }));
}

/** Plano calculado pelo banco (mesmo cálculo da confirmação), sem gravar nada. */
async function previsualizarLoteProducaoNoSupabase(payload) {
  const { data, error } = await supabaseClient.rpc('preview_production', { p_payload: payload });
  if (error) throw _erroRpcLoteProducao(error);
  return data;
}

async function confirmarLoteProducaoNoSupabase(payload) {
  const { data, error } = await supabaseClient.rpc('confirm_production', { p_payload: payload });
  if (error) throw _erroRpcLoteProducao(error);
  return data;
}

async function cancelarLoteProducaoNoSupabase(loteId, motivo) {
  const { data, error } = await supabaseClient.rpc('cancel_production', { p_batch_id: loteId, p_reason: motivo });
  if (error) throw _erroRpcLoteProducao(error);
  return { jaCancelada: !!data.already_cancelled, lote: _linhaParaLoteProducao(data.batch) };
}
