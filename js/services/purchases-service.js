/*
 * purchases-service.js
 * Único arquivo que fala com o Supabase para public.suppliers,
 * public.purchase_items, public.purchases, public.purchase_lines e
 * public.lots (Compras + Lotes + Estoque por Lote, Etapas A-D). Escrita
 * (criar/editar) de compra (cabeçalho + linhas) passa inteira pela RPC
 * administrativa save_purchase (migration 20260818180000): nunca um
 * INSERT/UPDATE direto em purchases/purchase_lines — authenticated não
 * tem mais esse GRANT. A RPC calcula base_quantity/item_name_snapshot
 * 100% server-side e gera lote+movimento inicial automaticamente pra
 * cada linha nova cujo item controla estoque; edição de linha existente
 * só é aceita enquanto nenhum lote da compra tiver movimento além do
 * inicial (compra "com consumo" só permite editar
 * fornecedor/referência/observações). Desde a Etapa F2, uma linha nova
 * pode vir sem purchase_item_id (só item_name digitado) — save_purchase
 * resolve por nome normalizado (reaproveita item existente ou cria um
 * provisório needs_review=true) inteiramente server-side; o client nunca
 * decide isso sozinho. suppliers continua cadastro simples (GRANT direto,
 * protegido só por RLS). Desde a Etapa I2, purchase_items passou a exigir
 * RPC pra toda escrita — criar/editar vai por save_purchase_item
 * (migration 20260818290000), completar um item pendente continua indo
 * por finalize_purchase_item (migration 20260818200000, evoluída na I2) —
 * nunca mais INSERT/UPDATE direto (GRANT revogado). Pra category IN
 * ('supply','packaging') sem vínculo enviado, as duas RPCs criam/vinculam
 * um production_supply automaticamente (unifica o cadastro de Insumos de
 * Produção dentro de Itens de Compra); cleaning fica de propósito fora
 * dessa auto-criação. Desde a Etapa J3, category='ingredient' recebe o
 * mesmo tratamento pra public.ingredients (_resolve_ingredient_link);
 * desde a Etapa J4, as duas RPCs também recebem p_ingredient_category e
 * gravam/atualizam ingredients.category a partir dele (obrigatório sempre
 * que a categoria do item for 'ingredient' — nunca mais NULL numa nova
 * auto-criação via Compras; também permite corrigir a categoria de um
 * Ingredient legado já vinculado). lots/lot_movements são só-leitura pra authenticated (nenhuma
 * escrita direta em hipótese nenhuma). Exclusão de compra passa pela RPC
 * delete_purchase (migration 20260818240000) — só permitida se nenhum
 * lote da compra já teve movimentação real (production_use/sale/waste/
 * adjustment_in/adjustment_out/reversal); quando permitida, remove
 * movimentos 'purchase' iniciais + lotes + a compra numa transação só.
 * Depende de js/supabase.js (supabaseClient), carregado antes deste
 * arquivo.
 */

function _linhaSupabaseParaFornecedor(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    ativo: linha.active,
    nomeContato: linha.contact_name,
    telefone: linha.phone,
    email: linha.email,
    observacoes: linha.notes,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

function _linhaSupabaseParaItemCompra(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    categoria: linha.category,
    controlaEstoque: linha.tracks_stock,
    unidadeBase: linha.base_unit,
    ativo: linha.active,
    needsReview: linha.needs_review,
    produtoId: linha.product_id,
    ingredienteId: linha.ingredient_id,
    insumoId: linha.production_supply_id,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

function _linhaSupabaseParaCompra(linha) {
  return {
    id: linha.id,
    fornecedorId: linha.supplier_id,
    compradoEm: linha.purchased_at,
    referencia: linha.reference,
    observacoes: linha.notes,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
    atualizadoPor: linha.updated_by,
  };
}

function _linhaSupabaseParaLinhaCompra(linha) {
  return {
    id: linha.id,
    compraId: linha.purchase_id,
    itemCompraId: linha.purchase_item_id,
    nomeSnapshot: linha.item_name_snapshot,
    quantidade: Number(linha.quantity),
    unidade: linha.unit,
    quantidadeBase: Number(linha.base_quantity),
    precoTotal: Number(linha.total_price),
    custoPorUnidadeBase: Number(linha.unit_cost_base),
    criadoEm: linha.created_at,
  };
}

function _linhaSupabaseParaMovimentoLote(linha) {
  return {
    id: linha.id,
    loteId: linha.lot_id,
    itemCompraId: linha.purchase_item_id,
    tipo: linha.movement_type,
    quantidade: Number(linha.quantity),
    saldoAntes: Number(linha.balance_before),
    saldoDepois: Number(linha.balance_after),
    origemTipo: linha.source_type,
    origemId: linha.source_id,
    observacoes: linha.notes,
    ocorridoEm: linha.occurred_at,
    criadoPor: linha.created_by,
  };
}

function _linhaSupabaseParaLote(linha) {
  return {
    id: linha.id,
    linhaCompraId: linha.purchase_line_id,
    itemCompraId: linha.purchase_item_id,
    recebidoEm: linha.received_at,
    validade: linha.expiration_date,
    quantidadeInicial: Number(linha.initial_quantity),
    quantidadeRestante: Number(linha.remaining_quantity),
    unidadeBase: linha.base_unit,
    custoPorUnidadeBase: Number(linha.unit_cost_base),
    status: linha.status,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

/** Busca todos os fornecedores numa única consulta. */
async function buscarFornecedoresDoSupabase() {
  const { data, error } = await supabaseClient.from('suppliers').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaFornecedor);
}

/** Busca todos os itens de compra numa única consulta. */
async function buscarItensCompraDoSupabase() {
  const { data, error } = await supabaseClient.from('purchase_items').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaItemCompra);
}

/** Cria um fornecedor — INSERT direto (RLS/admin protege, sem RPC dedicada, mesmo padrão de ingredients/production_supplies). */
async function criarFornecedorNoSupabase(dados) {
  const { data, error } = await supabaseClient
    .from('suppliers')
    .insert({
      name: dados.nome,
      active: dados.ativo !== false,
      contact_name: dados.nomeContato || null,
      phone: dados.telefone || null,
      email: dados.email || null,
      notes: dados.observacoes || null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaFornecedor(data);
}

/** Atualiza um fornecedor existente — UPDATE direto (RLS/admin protege). */
async function atualizarFornecedorNoSupabase(id, dados) {
  const { data, error } = await supabaseClient
    .from('suppliers')
    .update({
      name: dados.nome,
      active: dados.ativo !== false,
      contact_name: dados.nomeContato || null,
      phone: dados.telefone || null,
      email: dados.email || null,
      notes: dados.observacoes || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaFornecedor(data);
}

/**
 * Único ponto de escrita real de purchase_items — RPC save_purchase_item
 * (Etapa I2), nunca INSERT/UPDATE direto (GRANT revogado). Pra category
 * IN ('supply','packaging') sem nenhum vínculo enviado, a RPC cria/
 * vincula um production_supply inteiramente server-side (nunca decidido
 * aqui) — cleaning fica de propósito fora dessa auto-criação. No máximo
 * um vínculo enviado — os outros dois sempre null (reforça client-side o
 * CHECK XOR já existente no banco, que a RPC também valida).
 */
async function _salvarItemCompraViaRpc(id, dados) {
  const { data, error } = await supabaseClient.rpc('save_purchase_item', {
    p_purchase_item_id: id || null,
    p_name: dados.nome,
    p_category: dados.categoria,
    p_tracks_stock: dados.controlaEstoque !== false,
    p_base_unit: dados.unidadeBase || null,
    p_product_id: dados.produtoId || null,
    p_ingredient_id: dados.ingredienteId || null,
    p_ingredient_category: dados.ingredienteCategoria || null,
    p_production_supply_id: dados.insumoId || null,
    p_active: dados.ativo !== false,
  });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemCompra(data.item);
}

/** Cria um item de compra. Mesma assinatura/retorno de antes da Etapa I2 — ver comentário de _salvarItemCompraViaRpc. RLS/RPC restringem esta operação a admin. */
async function criarItemCompraNoSupabase(dados) {
  return _salvarItemCompraViaRpc(null, dados);
}

/** Atualiza um item de compra existente. Mesma assinatura/retorno de antes da Etapa I2 — ver comentário de _salvarItemCompraViaRpc. RLS/RPC restringem esta operação a admin. */
async function atualizarItemCompraNoSupabase(id, dados) {
  return _salvarItemCompraViaRpc(id, dados);
}

/**
 * Completa o cadastro de um item de compra pendente (needs_review=true) via
 * RPC finalize_purchase_item — nunca por UPDATE direto. Se controlaEstoque
 * vier true, a RPC também converte retroativamente toda purchase_line
 * desse item ainda sem base_quantity e gera lote+movimento inicial para
 * cada uma (rollback integral se alguma linha antiga tiver unidade
 * incompatível com a unidade-base escolhida). Devolve o item já
 * finalizado (needsReview=false) mais as linhas/lotes/movimentos afetados
 * por esta chamada.
 */
async function finalizarItemCompraNoSupabase(id, dados) {
  const { data, error } = await supabaseClient.rpc('finalize_purchase_item', {
    p_purchase_item_id: id,
    p_name: dados.nome,
    p_category: dados.categoria,
    p_tracks_stock: dados.controlaEstoque !== false,
    p_base_unit: dados.unidadeBase || null,
    p_product_id: dados.produtoId || null,
    p_ingredient_id: dados.ingredienteId || null,
    p_ingredient_category: dados.ingredienteCategoria || null,
    p_production_supply_id: dados.insumoId || null,
    p_active: dados.ativo !== false,
  });
  if (error) throw new Error(error.message);
  return {
    item: _linhaSupabaseParaItemCompra(data.item),
    linhas: (data.lines || []).map(_linhaSupabaseParaLinhaCompra),
    lotes: (data.lots || []).map(_linhaSupabaseParaLote),
    movimentos: data.movements || [],
  };
}

/** Busca todos os lotes numa única consulta (sem filtro — agrupamento em memória por item/linha de compra). */
async function buscarLotesDoSupabase() {
  const { data, error } = await supabaseClient.from('lots').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLote);
}

/** Busca todos os movimentos de lote numa única consulta — usado só pra detectar se uma compra já teve consumo real (qualquer movimento além do 'purchase' inicial) antes de liberar edição de linhas. */
async function buscarMovimentosLotesDoSupabase() {
  const { data, error } = await supabaseClient.from('lot_movements').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaMovimentoLote);
}

/** Busca todas as compras numa única consulta, mais recentes primeiro. */
async function buscarComprasDoSupabase() {
  const { data, error } = await supabaseClient.from('purchases').select('*').order('purchased_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaCompra);
}

/**
 * Busca TODAS as linhas de TODAS as compras numa única consulta, sem
 * filtro por purchase_id — quem chama agrupa em memória (Map por
 * compraId). Evita N+1: nunca uma consulta por compra.
 */
async function buscarLinhasComprasDoSupabase() {
  const { data, error } = await supabaseClient.from('purchase_lines').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLinhaCompra);
}

/**
 * Único ponto de escrita real: chama a RPC save_purchase, que cria/edita
 * o cabeçalho da compra E reconcilia suas linhas (gerando lote+movimento
 * inicial automaticamente pras linhas novas com item que controla
 * estoque) numa única transação (purchaseId null = criar; preenchido =
 * editar). `dados.linhas` é uma lista de
 * `{ linhaId, itemCompraId, quantidade, unidade, precoTotal, validade }`
 * — `linhaId` null identifica uma linha nova, preenchido identifica uma
 * linha já existente (o item dela nunca pode mudar). Se a compra já tiver
 * lote com consumo, a RPC ignora `linhas` e só atualiza
 * fornecedor/referência/observações.
 */
async function salvarCompraNoSupabase(purchaseId, dados) {
  const linhasPayload = (dados.linhas || []).map((linha) => ({
    line_id: linha.linhaId || null,
    purchase_item_id: linha.itemCompraId || null,
    item_name: linha.itemNome || null,
    quantity: linha.quantidade,
    unit: linha.unidade,
    total_price: linha.precoTotal,
    expiration_date: linha.validade || null,
  }));

  const { data, error } = await supabaseClient.rpc('save_purchase', {
    p_purchase_id: purchaseId || null,
    p_supplier_id: dados.fornecedorId || null,
    p_purchased_at: dados.compradoEm,
    p_reference: dados.referencia || null,
    p_notes: dados.observacoes || null,
    p_lines: linhasPayload,
  });
  if (error) throw new Error(error.message);

  return {
    compra: _linhaSupabaseParaCompra(data.purchase),
    linhas: (data.lines || []).map(_linhaSupabaseParaLinhaCompra),
    lotes: (data.lots || []).map(_linhaSupabaseParaLote),
    movimentos: data.movements || [],
  };
}

/**
 * Exclusão passa pela RPC delete_purchase — nunca um DELETE direto (GRANT
 * já revogado desde save_purchase, migration 20260818180000). A RPC só
 * permite excluir se nenhum lote gerado pelas linhas desta compra já teve
 * movimentação além do 'purchase' inicial (verificação sempre feita
 * server-side, a partir do ledger real, nunca confiada ao client); se
 * houver qualquer movimento real (production_use/sale/waste/
 * adjustment_in/adjustment_out/reversal), rejeita com mensagem clara e não
 * apaga nada. Quando permitido: remove os movimentos 'purchase' iniciais,
 * os lotes, e a compra — purchase_lines cai sozinha via ON DELETE CASCADE
 * já existente.
 */
async function excluirCompraNoSupabase(id) {
  const { data, error } = await supabaseClient.rpc('delete_purchase', { p_purchase_id: id });
  if (error) throw new Error(error.message);
  return {
    loteIdsRemovidos: (data.deleted_lots || []).map((l) => l.id),
  };
}
