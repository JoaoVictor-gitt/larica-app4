/*
 * side-production-service.js
 * Único arquivo que fala com o Supabase para public.side_production_batches
 * e public.side_batch_components (Produção de Acompanhamentos, Etapa B).
 * Mesmo padrão de segurança de skewer-production-service.js: anon sem
 * GRANT nenhum, staff só visualiza, admin escreve. Isolado de
 * products-service.js/ingredients-service.js/recipes-service.js de
 * propósito — um lote de acompanhamento não é nem um produto, nem um
 * ingrediente, nem uma ficha técnica, só referencia todos eles por id.
 *
 * Escrita (criar/editar) de um lote — incluindo seus componentes
 * (ingrediente/preparo usados, ex. Sal, Vinagrete) — passa inteira pela
 * RPC administrativa save_side_production_batch (migration
 * 20260818140000): nunca um INSERT/UPDATE direto em
 * side_production_batches nem em side_batch_components (GRANT direto
 * nunca existiu pra side_batch_components, e foi revogado de
 * side_production_batches na mesma migration que criou a RPC — mesma
 * lição de segurança já aplicada a skewer_production_batches, desta vez
 * aplicada desde a primeira versão). A RPC resolve nome/custo de
 * ingredient inteiramente server-side; só o custo de um componente do
 * tipo 'recipe' vem do client (reaproveitando o cálculo recursivo já
 * existente em producao.js, sem duplicar fórmula em SQL), com validação
 * de sanidade dentro da RPC. Desde a Etapa G3, exclusão de lote passa pela
 * RPC delete_side_production_batch (reverte consumo de lote antes de
 * excluir; GRANT DELETE direto foi revogado) — ver
 * excluirLoteAcompanhamentoNoSupabase mais abaixo.
 *
 * Desde a Etapa G2, um componente item_type='ingredient' pode opcionalmente
 * trazer lotId (side_batch_components.lot_id, coluna existente desde a
 * Etapa G1) — quando presente, a RPC consome/devolve saldo do lote
 * (public.lots) dentro da própria transação e resolve o custo do
 * componente a partir de lots.unit_cost_base, nunca do cadastro atual do
 * ingrediente. lotId ausente/null preserva o comportamento de sempre
 * (custo do cadastro, nenhuma baixa de estoque) — js/producao.js (Etapa
 * G4) é quem decide se envia lotId, via o seletor de lote no formulário de
 * Ingredientes/Preparos.
 *
 * Aplicar o custo real de um lote a product_costs NÃO é feito aqui —
 * fica em product-costs-service.js (aplicarCustoProducaoAcompanhamentoNoSupabase),
 * junto das outras aplicações de custo (mesmo critério já usado pra
 * Produção de Espetos: side-production-service cuida do lote em si,
 * product-costs-service cuida de toda escrita em product_costs).
 *
 * Perda, rendimento, quantidade teórica, sobra e custos são SEMPRE
 * calculados on-read em js/producao.js (Etapa C), a partir dos campos
 * brutos — nunca persistidos aqui. Depende de js/supabase.js
 * (supabaseClient), carregado antes deste arquivo.
 */

/** Converte uma linha crua do Supabase (snake_case) pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaLoteAcompanhamento(linha) {
  return {
    id: linha.id,
    produtoId: linha.product_id,
    produzidoEm: linha.produced_at,
    rendimentoFinalQuantidade: Number(linha.final_yield_quantity),
    rendimentoFinalUnidade: linha.final_yield_unit,
    porcaoQuantidade: Number(linha.portion_quantity),
    porcaoUnidade: linha.portion_unit,
    porcoesReais: linha.actual_portions === null || linha.actual_portions === undefined ? null : Number(linha.actual_portions),
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
    atualizadoPor: linha.updated_by,
  };
}

/** Converte uma linha crua de side_batch_components pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaComponenteLoteAcompanhamento(linha) {
  return {
    id: linha.id,
    loteId: linha.batch_id,
    tipoItem: linha.item_type,
    ingredienteId: linha.ingredient_id,
    receitaId: linha.recipe_id,
    lotId: linha.lot_id,
    nomeSnapshot: linha.name_snapshot,
    quantidade: Number(linha.quantity),
    unidade: linha.unit,
    custoPorUnidadeSnapshot: Number(linha.unit_cost_snapshot),
    criadoEm: linha.created_at,
  };
}

/** Busca todos os lotes numa única consulta (nunca N+1), mais recentes primeiro (produzido em, depois criado em). */
async function buscarLotesAcompanhamentosDoSupabase() {
  const { data, error } = await supabaseClient
    .from('side_production_batches')
    .select('*')
    .order('produced_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLoteAcompanhamento);
}

/**
 * Busca TODOS os componentes de TODOS os lotes numa única consulta, sem
 * filtro por batch_id — quem chama agrupa em memória (Map por loteId).
 * Evita N+1: nunca uma consulta por lote.
 */
async function buscarComponentesLotesAcompanhamentosDoSupabase() {
  const { data, error } = await supabaseClient.from('side_batch_components').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaComponenteLoteAcompanhamento);
}

/**
 * Único ponto de escrita real: chama a RPC save_side_production_batch, que
 * cria/edita o lote E substitui seus componentes numa única transação
 * (batchId null = criar; preenchido = editar). `dados.componentes`
 * (opcional, default []) é uma lista de
 * `{ tipoItem, referenciaId, quantidade, unidade, custoPorUnidadeSnapshot }`
 * — `custoPorUnidadeSnapshot` só é enviado (e só é necessário) quando
 * `tipoItem === 'recipe'`; para 'ingredient' a RPC resolve o custo sozinha
 * e ignora qualquer custo enviado pelo client. Retorna `{ lote, componentes }`
 * já mapeados pro formato pt-BR. RLS/RPC restringem esta operação a admin.
 */
async function salvarLoteAcompanhamentoNoSupabase(batchId, dados) {
  const componentesPayload = (dados.componentes || []).map((componente) => {
    const item = {
      item_type: componente.tipoItem,
      reference_id: componente.referenciaId,
      lot_id: componente.lotId || null,
      quantity: componente.quantidade,
      unit: componente.unidade,
    };
    if (componente.tipoItem === 'recipe') {
      item.unit_cost_snapshot = componente.custoPorUnidadeSnapshot;
    }
    return item;
  });

  const { data, error } = await supabaseClient.rpc('save_side_production_batch', {
    p_batch_id: batchId || null,
    p_product_id: dados.produtoId,
    p_produced_at: dados.produzidoEm,
    p_final_yield_quantity: dados.rendimentoFinalQuantidade,
    p_final_yield_unit: dados.rendimentoFinalUnidade,
    p_portion_quantity: dados.porcaoQuantidade,
    p_portion_unit: dados.porcaoUnidade,
    p_actual_portions: dados.porcoesReais === undefined ? null : dados.porcoesReais,
    p_components: componentesPayload,
  });
  if (error) throw new Error(error.message);

  return {
    lote: _linhaSupabaseParaLoteAcompanhamento(data.batch),
    componentes: (data.components || []).map(_linhaSupabaseParaComponenteLoteAcompanhamento),
  };
}

/**
 * Etapa G3: exclusão passa pela RPC delete_side_production_batch — nunca
 * mais um DELETE direto (GRANT DELETE revogado de authenticated). A RPC
 * reverte, para cada lote com consumo líquido ainda ativo deste batch, o
 * saldo correspondente (lot_movements 'reversal', calculado só a partir
 * do ledger) antes de excluir o batch — cascata
 * (side_batch_components.batch_id ON DELETE CASCADE) remove os
 * componentes; lot_movements nunca é tocado pela exclusão (sem FK),
 * ledger de auditoria preservado. Mesma assinatura/retorno de antes —
 * producao.js não precisa de nenhuma mudança.
 */
async function excluirLoteAcompanhamentoNoSupabase(id) {
  const { error } = await supabaseClient.rpc('delete_side_production_batch', { p_batch_id: id });
  if (error) throw new Error(error.message);
}
