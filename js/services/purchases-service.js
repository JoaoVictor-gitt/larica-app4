/*
 * purchases-service.js — Fase B (Compras v2, custo médio ponderado)
 *
 * Único arquivo que fala com o Supabase sobre Compras. Toda escrita de compra
 * passa por RPC (nunca INSERT/UPDATE direto):
 *   confirm_purchase   — grava compra + linhas + estoque + custo médio numa
 *                        transação só; idempotente por client_request_id
 *                        (reenviar a mesma confirmação NÃO duplica nada);
 *   cancel_purchase    — estorno (a compra fica registrada como cancelada);
 *   suggest_purchase_item_matches — sugestões por apelido/similaridade
 *                        (nunca associa sozinha);
 *   register_purchase_document — registra foto/PDF já enviado ao bucket
 *                        privado 'purchase-documents'.
 * A leitura por IA é feita pelo Worker (/api/admin/purchase-ocr) com o token
 * da sessão — a chave da OpenAI nunca chega ao navegador.
 *
 * buscarLotesDoSupabase/buscarMovimentosLotesDoSupabase continuam aqui só
 * porque producao.js ainda os usa (será substituído na Fase C).
 * Depende de js/supabase.js (supabaseClient).
 */

const LIMITE_DOCUMENTO_COMPRA_BYTES = 10 * 1024 * 1024;
const LADO_MAXIMO_IMAGEM_COMPRA = 2000;

function _numeroOuNull(v) {
  return v === null || v === undefined ? null : Number(v);
}

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
    estoque: linha.stock_quantity === undefined ? 0 : Number(linha.stock_quantity),
    custoMedio: _numeroOuNull(linha.avg_cost),
    custoMedioAtualizadoEm: linha.avg_cost_updated_at || null,
    categoriaFinanceiraId: linha.finance_category_id || null,
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
    status: linha.status || 'confirmed',
    origem: linha.source || 'manual',
    vatRecuperavel: linha.vat_recoverable !== false,
    totalBruto: Number(linha.gross_total || 0),
    totalDescontos: Number(linha.discount_total || 0),
    descontoGeral: Number(linha.header_discount || 0),
    totalLiquido: Number(linha.net_total || 0),
    totalVat: Number(linha.vat_total || 0),
    totalPago: Number(linha.total_paid || 0),
    arredondamento: Number(linha.rounding_adjustment || 0),
    canceladaEm: linha.cancelled_at || null,
    motivoCancelamento: linha.cancel_reason || null,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
  };
}

function _linhaSupabaseParaLinhaCompra(linha) {
  return {
    id: linha.id,
    compraId: linha.purchase_id,
    itemCompraId: linha.purchase_item_id,
    ordem: linha.line_order || 0,
    tipo: linha.line_type || 'stock',
    descricaoNota: linha.raw_description,
    nomeSnapshot: linha.item_name_snapshot,
    quantidade: Number(linha.quantity),
    unidade: linha.unit,
    quantidadeBase: _numeroOuNull(linha.base_quantity),
    precoUnitario: _numeroOuNull(linha.unit_price),
    valorBruto: Number(linha.gross_amount || 0),
    desconto: Number(linha.discount_amount || 0),
    rateioDescontoGeral: Number(linha.header_discount_share || 0),
    valorLiquido: Number(linha.net_amount || 0),
    taxaVat: Number(linha.vat_rate || 0),
    valorVat: Number(linha.vat_amount || 0),
    custo: Number(linha.cost_value || 0),
    custoPorUnidadeBase: _numeroOuNull(linha.unit_cost_base),
    precoTotal: Number(linha.total_price),
    categoriaFinanceiraId: linha.finance_category_id || null,
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

function _linhaSupabaseParaMovimentoEstoque(linha) {
  return {
    id: linha.id,
    itemCompraId: linha.purchase_item_id,
    tipo: linha.movement_type,
    quantidade: Number(linha.quantity),
    custoUnitario: _numeroOuNull(linha.unit_cost),
    valor: Number(linha.total_value),
    saldoAntes: Number(linha.balance_before),
    saldoDepois: Number(linha.balance_after),
    custoMedioAntes: _numeroOuNull(linha.avg_cost_before),
    custoMedioDepois: _numeroOuNull(linha.avg_cost_after),
    origemTipo: linha.source_type,
    origemId: linha.source_id,
    motivo: linha.reason,
    criadoEm: linha.created_at,
  };
}

function _linhaSupabaseParaDocumento(linha) {
  return {
    id: linha.id,
    compraId: linha.purchase_id,
    caminho: linha.storage_path,
    nomeArquivo: linha.file_name,
    tipoMime: linha.mime_type,
    tamanho: Number(linha.size_bytes),
    statusOcr: linha.ocr_status,
    resultadoOcr: linha.ocr_result || null,
    erroOcr: linha.ocr_error || null,
    criadoEm: linha.created_at,
  };
}

// ----------------------------------------------------------------- leituras

async function buscarFornecedoresDoSupabase() {
  const { data, error } = await supabaseClient.from('suppliers').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaFornecedor);
}

async function buscarItensCompraDoSupabase() {
  const { data, error } = await supabaseClient.from('purchase_items').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaItemCompra);
}

async function buscarComprasDoSupabase() {
  const { data, error } = await supabaseClient
    .from('purchases')
    .select('*')
    .order('purchased_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaCompra);
}

/** Todas as linhas de todas as compras numa consulta só (agrupadas em memória por quem chama). */
async function buscarLinhasComprasDoSupabase() {
  const { data, error } = await supabaseClient.from('purchase_lines').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLinhaCompra);
}

async function buscarCategoriasFinanceirasDoSupabase() {
  const { data, error } = await supabaseClient.from('finance_categories').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data || []).map((c) => ({ id: c.id, nome: c.name, tipo: c.kind, chave: c.system_key, ativo: c.active }));
}

async function buscarApelidosItensCompraDoSupabase() {
  const { data, error } = await supabaseClient.from('purchase_item_aliases').select('*').order('alias');
  if (error) throw new Error(error.message);
  return (data || []).map((a) => ({
    id: a.id,
    itemCompraId: a.purchase_item_id,
    apelido: a.alias,
    origem: a.source,
    vezesUsado: a.times_used,
    ultimoUsoEm: a.last_used_at,
  }));
}

async function buscarMovimentosEstoqueItemDoSupabase(itemCompraId) {
  const { data, error } = await supabaseClient
    .from('inventory_movements')
    .select('*')
    .eq('purchase_item_id', itemCompraId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaMovimentoEstoque);
}

async function buscarDocumentosCompraDoSupabase(compraId) {
  const { data, error } = await supabaseClient
    .from('purchase_documents')
    .select('*')
    .eq('purchase_id', compraId)
    .order('created_at');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaDocumento);
}

/** Custo médio atual dos produtos de revenda: Map(productId -> custo). */
async function buscarMapaCustosProdutosParaCompras() {
  const { data, error } = await supabaseClient.from('product_costs').select('product_id, unit_cost, updated_at');
  if (error) throw new Error(error.message);
  return new Map((data || []).map((c) => [c.product_id, _numeroOuNull(c.unit_cost)]));
}

/** Lotes antigos — só leitura, mantido para producao.js até a Fase C. */
async function buscarLotesDoSupabase() {
  const { data, error } = await supabaseClient.from('lots').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLote);
}

/** Movimentos de lote antigos — só leitura, mantido para producao.js até a Fase C. */
async function buscarMovimentosLotesDoSupabase() {
  const { data, error } = await supabaseClient.from('lot_movements').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaMovimentoLote);
}

// ----------------------------------------------------------------- fornecedores (RLS: admin)

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

// ----------------------------------------------------------------- itens de compra (RPCs)

/** save_purchase_item continua sendo a porta de escrita do cadastro (cria ingrediente/insumo vinculado quando cabe). */
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

async function criarItemCompraNoSupabase(dados) {
  return _salvarItemCompraViaRpc(null, dados);
}

async function atualizarItemCompraNoSupabase(id, dados) {
  return _salvarItemCompraViaRpc(id, dados);
}

/** Categoria financeira padrão de um item sem estoque (despesa). Também marca o item como revisado. */
async function definirCategoriaFinanceiraItemNoSupabase(itemId, categoriaId) {
  const { data, error } = await supabaseClient.rpc('set_purchase_item_finance_category', {
    p_purchase_item_id: itemId,
    p_finance_category_id: categoriaId || null,
  });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemCompra(data);
}

async function marcarItemCompraRevisadoNoSupabase(itemId) {
  const { data, error } = await supabaseClient.rpc('mark_purchase_item_reviewed', { p_purchase_item_id: itemId });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemCompra(data);
}

async function salvarApelidoItemCompraNoSupabase(itemId, apelido) {
  const { data, error } = await supabaseClient.rpc('save_purchase_item_alias', {
    p_purchase_item_id: itemId,
    p_alias: apelido,
  });
  if (error) throw new Error(error.message);
  return { id: data.id, itemCompraId: data.purchase_item_id, apelido: data.alias, origem: data.source, vezesUsado: data.times_used };
}

async function excluirApelidoItemCompraNoSupabase(apelidoId) {
  const { error } = await supabaseClient.rpc('delete_purchase_item_alias', { p_alias_id: apelidoId });
  if (error) throw new Error(error.message);
}

/** Sugestões para as descrições lidas da nota: { index, exact: {purchase_item_id, name, via} | null, candidates: [...] }. */
async function sugerirItensParaDescricoesNoSupabase(descricoes) {
  if (!descricoes.length) return [];
  const { data, error } = await supabaseClient.rpc('suggest_purchase_item_matches', { p_descriptions: descricoes });
  if (error) throw new Error(error.message);
  return data || [];
}

// ----------------------------------------------------------------- compras (RPCs)

/**
 * Confirma a compra. `payload` segue o formato documentado em confirm_purchase
 * (migration 20261123110000). `client_request_id` deve ser gerado UMA vez por
 * formulário e reaproveitado em novas tentativas — é o que impede duplicação.
 */
async function confirmarCompraNoSupabase(payload) {
  const { data, error } = await supabaseClient.rpc('confirm_purchase', { p_payload: payload });
  if (error) throw new Error(error.message);
  return data;
}

async function cancelarCompraNoSupabase(compraId, motivo) {
  const { data, error } = await supabaseClient.rpc('cancel_purchase', { p_purchase_id: compraId, p_reason: motivo });
  if (error) throw new Error(error.message);
  return { jaCancelada: !!data.already_cancelled, compra: _linhaSupabaseParaCompra(data.purchase) };
}

// ----------------------------------------------------------------- documentos

function _lerArquivoComoDataUrl(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    leitor.readAsDataURL(arquivo);
  });
}

function _carregarImagem(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Formato de imagem não suportado. Use JPG, PNG ou WebP.'));
    img.src = dataUrl;
  });
}

/**
 * Prepara a foto para envio: redimensiona para no máximo 2000 px no maior
 * lado e converte para JPEG — fotos de celular ficam pequenas e legíveis para
 * a IA. Devolve { blob, mime, extensao, previa (data URL) }.
 */
async function prepararImagemDocumentoCompra(arquivo) {
  const dataUrl = await _lerArquivoComoDataUrl(arquivo);
  const img = await _carregarImagem(dataUrl);
  const escala = Math.min(1, LADO_MAXIMO_IMAGEM_COMPRA / Math.max(img.naturalWidth, img.naturalHeight));
  const largura = Math.max(1, Math.round(img.naturalWidth * escala));
  const altura = Math.max(1, Math.round(img.naturalHeight * escala));
  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, largura, altura);
  ctx.drawImage(img, 0, 0, largura, altura);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Não foi possível processar a imagem.');
  return { blob, mime: 'image/jpeg', extensao: 'jpg', previa: canvas.toDataURL('image/jpeg', 0.5) };
}

/** Envia foto ou PDF ao bucket privado e registra o documento. Devolve o documento + prévia. */
async function enviarDocumentoCompra(arquivo) {
  let conteudo;
  let mime;
  let extensao;
  let previa = null;
  if (arquivo.type === 'application/pdf') {
    conteudo = arquivo;
    mime = 'application/pdf';
    extensao = 'pdf';
  } else if (arquivo.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(arquivo.name || '')) {
    const preparada = await prepararImagemDocumentoCompra(arquivo);
    conteudo = preparada.blob;
    mime = preparada.mime;
    extensao = preparada.extensao;
    previa = preparada.previa;
  } else {
    throw new Error('Envie uma foto (JPG, PNG, WebP) ou um PDF.');
  }
  if (conteudo.size > LIMITE_DOCUMENTO_COMPRA_BYTES) {
    throw new Error('Arquivo grande demais (máximo 10 MB).');
  }

  const caminho = `uploads/${crypto.randomUUID()}.${extensao}`;
  const { error: erroUpload } = await supabaseClient.storage
    .from('purchase-documents')
    .upload(caminho, conteudo, { contentType: mime, upsert: false });
  if (erroUpload) throw new Error('Falha ao enviar o arquivo: ' + erroUpload.message);

  const { data, error } = await supabaseClient.rpc('register_purchase_document', {
    p_storage_path: caminho,
    p_file_name: arquivo.name || null,
    p_mime_type: mime,
    p_size_bytes: conteudo.size,
  });
  if (error) throw new Error(error.message);
  return { documento: _linhaSupabaseParaDocumento(data), previa };
}

/** Link temporário (5 min) para abrir um documento do bucket privado. */
async function obterLinkDocumentoCompra(caminho) {
  const { data, error } = await supabaseClient.storage.from('purchase-documents').createSignedUrl(caminho, 300);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

/**
 * Pede ao Worker a leitura da nota com IA. Erros já chegam com mensagem
 * pronta para o usuário (ex.: IA não configurada -> preencher manualmente).
 */
async function lerDocumentoCompraComIa(documentoId) {
  const { data: sessao } = await supabaseClient.auth.getSession();
  const token = sessao && sessao.session ? sessao.session.access_token : null;
  if (!token) throw new Error('Sessão expirada. Faça login novamente.');

  let resposta;
  try {
    resposta = await fetch('/api/admin/purchase-ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ document_id: documentoId }),
    });
  } catch (erro) {
    throw new Error('Sem conexão com o servidor. Verifique a internet e tente de novo.');
  }
  let corpo = null;
  try {
    corpo = await resposta.json();
  } catch (erro) {
    corpo = null;
  }
  if (!resposta.ok || !corpo || !corpo.ok) {
    const mensagem = (corpo && corpo.error) || 'Não foi possível ler o documento. Preencha manualmente.';
    const falha = new Error(mensagem);
    falha.codigo = corpo && corpo.code;
    throw falha;
  }
  return corpo.result;
}
