/*
 * skewer-production-service.js
 * Único arquivo que fala com o Supabase para public.skewer_production_batches
 * e public.skewer_batch_components (Produção de Espetos, Etapas 2-3B). Mesmo
 * padrão de segurança de ingredients/recipes: anon sem GRANT nenhum, staff só
 * visualiza, admin escreve. Isolado de products-service.js/ingredients-
 * service.js/production-supplies-service.js de propósito — um lote de
 * produção não é nem um produto, nem um ingrediente, nem um insumo, só
 * referencia todos eles por id.
 *
 * Escrita (criar/editar) de um lote — incluindo seus componentes (insumo/
 * ingrediente/preparo usados, ex. palito, sal, Tempero Larica) — passa
 * inteira pela RPC administrativa save_skewer_production_batch (migration
 * 20260818110000): nunca um INSERT/UPDATE direto em skewer_production_batches
 * nem em skewer_batch_components (a Etapa 3B revogou esse GRANT direto,
 * mesma correção já aplicada em recipe_items). A RPC resolve nome/custo de
 * ingredient/supply inteiramente server-side; só o custo de um componente
 * do tipo 'recipe' vem do client (reaproveitando o cálculo recursivo já
 * existente em producao.js, sem duplicar fórmula em SQL), com validação de
 * sanidade dentro da RPC. Desde a Etapa G3, exclusão de lote passa pela RPC
 * delete_skewer_production_batch (reverte consumo de lote antes de excluir;
 * GRANT DELETE direto foi revogado) — ver excluirLoteEspetosNoSupabase mais
 * abaixo.
 *
 * Desde a Etapa G2, um componente item_type='ingredient' pode opcionalmente
 * trazer lotId (skewer_batch_components.lot_id, coluna existente desde a
 * Etapa G1) — quando presente, a RPC consome/devolve saldo do lote
 * (public.lots) dentro da própria transação e resolve o custo do
 * componente a partir de lots.unit_cost_base, nunca do cadastro atual do
 * ingrediente. lotId ausente/null preserva o comportamento de sempre
 * (custo do cadastro, nenhuma baixa de estoque) — js/producao.js (Etapa
 * G4) é quem decide se envia lotId, via o seletor de lote no formulário de
 * Temperos/Preparos.
 *
 * criarLoteEspetosNoSupabase/atualizarLoteEspetosNoSupabase mantêm
 * exatamente a mesma assinatura e retorno já usados por js/producao.js
 * (Etapa 2) — por dentro, viraram wrappers finos da RPC. Isso permite a
 * Etapa 3B fechar o GRANT direto sem exigir NENHUMA mudança na UI: como a
 * Etapa 2 nunca preenche `dados.componentes`, o payload de componentes vai
 * sempre `[]`, reproduzindo exatamente o comportamento de hoje (lote só com
 * carne). Perda, rendimento, custos, quantidade teórica e sobra continuam
 * NUNCA calculados nem persistidos aqui — sempre on-read em js/producao.js
 * (calcularIndicadoresLoteEspetos), a partir dos campos brutos. Depende de
 * js/supabase.js (supabaseClient), carregado antes deste arquivo.
 */

/** Converte uma linha crua do Supabase (snake_case) pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaLoteEspeto(linha) {
  return {
    id: linha.id,
    produtoId: linha.product_id,
    ingredienteId: linha.ingredient_id,
    produzidoEm: linha.produced_at,
    pesoBrutoG: Number(linha.gross_weight_g),
    pesoUtilG: Number(linha.usable_weight_g),
    custoTotal: Number(linha.total_cost),
    pesoEspetoG: Number(linha.skewer_weight_g),
    quantidadeReal: Number(linha.actual_quantity),
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
    atualizadoPor: linha.updated_by,
  };
}

/** Converte uma linha crua de skewer_batch_components pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaComponenteLote(linha) {
  return {
    id: linha.id,
    loteId: linha.batch_id,
    tipoItem: linha.item_type,
    ingredienteId: linha.ingredient_id,
    receitaId: linha.recipe_id,
    insumoId: linha.supply_id,
    lotId: linha.lot_id,
    nomeSnapshot: linha.name_snapshot,
    quantidade: Number(linha.quantity),
    unidade: linha.unit,
    custoPorUnidadeSnapshot: Number(linha.unit_cost_snapshot),
    criadoEm: linha.created_at,
  };
}

/** Busca todos os lotes numa única consulta (nunca N+1), mais recentes primeiro (produzido em, depois criado em). */
async function buscarLotesEspetosDoSupabase() {
  const { data, error } = await supabaseClient
    .from('skewer_production_batches')
    .select('*')
    .order('produced_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLoteEspeto);
}

/**
 * Busca TODOS os componentes de TODOS os lotes numa única consulta, sem
 * filtro por batch_id — quem chama agrupa em memória (Map por loteId).
 * Evita N+1: nunca uma consulta por lote. Ainda não é chamada por nenhuma
 * UI (Etapa 3C consome isso pra montar a tela de componentes).
 */
async function buscarComponentesLotesEspetosDoSupabase() {
  const { data, error } = await supabaseClient.from('skewer_batch_components').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaComponenteLote);
}

/**
 * Único ponto de escrita real: chama a RPC save_skewer_production_batch,
 * que cria/edita o lote E substitui seus componentes numa única transação
 * (batchId null = criar; preenchido = editar). `dados.componentes`
 * (opcional, default []) é uma lista de
 * `{ tipoItem, referenciaId, quantidade, unidade, custoPorUnidadeSnapshot }`
 * — `custoPorUnidadeSnapshot` só é enviado (e só é necessário) quando
 * `tipoItem === 'recipe'`; para 'ingredient'/'supply' a RPC resolve o custo
 * sozinha e ignora qualquer custo enviado pelo client.
 */
async function _salvarLoteEspetosViaRpc(batchId, dados) {
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

  const { data, error } = await supabaseClient.rpc('save_skewer_production_batch', {
    p_batch_id: batchId,
    p_product_id: dados.produtoId,
    p_ingredient_id: dados.ingredienteId || null,
    p_produced_at: dados.produzidoEm,
    p_gross_weight_g: dados.pesoBrutoG,
    p_usable_weight_g: dados.pesoUtilG,
    p_total_cost: dados.custoTotal,
    p_skewer_weight_g: dados.pesoEspetoG,
    p_actual_quantity: dados.quantidadeReal,
    p_components: componentesPayload,
  });
  if (error) throw new Error(error.message);

  return {
    lote: _linhaSupabaseParaLoteEspeto(data.batch),
    componentes: (data.components || []).map(_linhaSupabaseParaComponenteLote),
  };
}

/** Cria um lote de produção (e seus componentes, se enviados). Mesma assinatura/retorno de antes da Etapa 3B — ver comentário do topo do arquivo. RLS/RPC restringem esta operação a admin. */
async function criarLoteEspetosNoSupabase(dados) {
  const resultado = await _salvarLoteEspetosViaRpc(null, dados);
  return resultado.lote;
}

/** Atualiza um lote existente (e substitui seus componentes, se enviados). Mesma assinatura/retorno de antes da Etapa 3B — ver comentário do topo do arquivo. RLS/RPC restringem esta operação a admin. */
async function atualizarLoteEspetosNoSupabase(id, dados) {
  const resultado = await _salvarLoteEspetosViaRpc(id, dados);
  return resultado.lote;
}

/**
 * Etapa G3: exclusão passa pela RPC delete_skewer_production_batch —
 * nunca mais um DELETE direto (GRANT DELETE revogado de authenticated).
 * A RPC reverte, para cada lote com consumo líquido ainda ativo deste
 * batch, o saldo correspondente (lot_movements 'reversal', calculado só
 * a partir do ledger) antes de excluir o batch — cascata
 * (skewer_batch_components.batch_id ON DELETE CASCADE) remove os
 * componentes; lot_movements nunca é tocado pela exclusão (sem FK),
 * ledger de auditoria preservado. Mesma assinatura/retorno de antes —
 * producao.js não precisa de nenhuma mudança.
 */
async function excluirLoteEspetosNoSupabase(id) {
  const { error } = await supabaseClient.rpc('delete_skewer_production_batch', { p_batch_id: id });
  if (error) throw new Error(error.message);
}
