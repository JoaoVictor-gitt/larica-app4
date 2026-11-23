/*
 * compras.js — Fase B (Compras v2)
 *
 * Seções: Nova Compra (documento -> leitura por IA opcional -> conferência ->
 * confirmar), Histórico (filtros, detalhe, documentos, cancelamento com
 * estorno), Itens e Estoque (saldo, custo médio, histórico de preços,
 * comparação por fornecedor, nomes alternativos) e Fornecedores.
 *
 * Regras que a tela respeita (o banco é a barreira real):
 *   - nada vira compra só porque a IA leu: o usuário confere e confirma;
 *   - associação item <-> descrição da nota só é automática quando já foi
 *     confirmada antes (nome alternativo) ou o nome é idêntico; similaridade
 *     só SUGERE;
 *   - o rascunho fica salvo neste aparelho e guarda o client_request_id: se a
 *     conexão cair na confirmação, tentar de novo não duplica a compra;
 *   - compra confirmada não se edita: cancela (estorno) e lança de novo.
 * Cálculos de prévia em js/compras-calculo.js (mesmas regras do banco).
 */

const CATEGORIAS_ITEM_COMPRA = {
  ingredient: 'Ingrediente',
  meat: 'Carne',
  beverage: 'Bebida',
  supply: 'Insumo',
  packaging: 'Embalagem',
  cleaning: 'Limpeza',
  other: 'Outros',
};
const UNIDADE_PADRAO_POR_BASE = { g: 'kg', ml: 'l', un: 'un' };
const CHAVE_RASCUNHO_COMPRA = 'larica_rascunho_compra_v2';

let itensCompraCache = [];
let fornecedoresCache = [];
let comprasCache = [];
let linhasComprasCache = [];
let categoriasFinanceirasCache = [];
let apelidosCache = [];
let produtosCache = [];
let custosProdutosCache = new Map();
let ingredientesCache = [];
let insumosCache = [];
let souAdminCompras = false;

let rascunho = null;
let compraEmDetalheId = null;
let uidLinhaAguardandoNovoItem = null;
let confirmandoCompra = false;

// ===================================================================== inicialização

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoCompras();
  try {
    await carregarDadosCompras();
  } catch (erro) {
    console.error('Erro ao carregar Compras:', erro);
    const el = document.getElementById('estado-erro-geral-compras');
    el.textContent = 'Não foi possível carregar os dados de Compras. ' + erro.message;
    el.style.display = 'block';
    ['itens-compra', 'fornecedores', 'historico-compras'].forEach((s) => finalizarSecaoComErro(`estado-carregando-${s}`, `estado-erro-${s}`, erro));
    return;
  }

  executarSecao(() => {
    ligarEventosItens();
    renderizarTabelaItensCompra();
  }, 'itens-compra');
  executarSecao(() => {
    ligarEventosFornecedores();
    renderizarTabelaFornecedores();
  }, 'fornecedores');
  executarSecao(() => {
    ligarEventosHistorico();
    renderizarHistoricoCompras();
  }, 'historico-compras');
  try {
    ligarEventosNovaCompra();
    iniciarRascunho();
  } catch (erro) {
    console.error('Erro ao preparar Nova Compra:', erro);
    mostrarErroCompra('Não foi possível preparar o formulário. ' + erro.message);
  }
});

async function carregarDadosCompras() {
  const [itens, fornecedores, compras, linhas, categorias, apelidos, produtos, custos, ingredientes, insumos, ehAdmin] = await Promise.all([
    buscarItensCompraDoSupabase(),
    buscarFornecedoresDoSupabase(),
    buscarComprasDoSupabase(),
    buscarLinhasComprasDoSupabase(),
    buscarCategoriasFinanceirasDoSupabase(),
    buscarApelidosItensCompraDoSupabase(),
    buscarProdutosDoSupabase(),
    buscarCustosProdutosDoSupabase(),
    buscarIngredientesDoSupabase(),
    buscarInsumosProducaoDoSupabase(),
    usuarioEhAdminNoSupabase(),
  ]);
  itensCompraCache = itens;
  fornecedoresCache = fornecedores;
  comprasCache = compras;
  linhasComprasCache = linhas;
  categoriasFinanceirasCache = categorias;
  apelidosCache = apelidos;
  produtosCache = produtos;
  custosProdutosCache = custos;
  ingredientesCache = ingredientes;
  insumosCache = insumos;
  souAdminCompras = ehAdmin;
  atualizarDatalists();
}

async function recarregarDepoisDeGravar() {
  try {
    await carregarDadosCompras();
  } catch (erro) {
    console.error('Erro ao recarregar Compras:', erro);
    mostrarToast('Gravado, mas não foi possível atualizar a tela. Recarregue a página.', 'erro');
    return;
  }
  renderizarTabelaItensCompra();
  renderizarTabelaFornecedores();
  renderizarHistoricoCompras();
}

function executarSecao(fn, chave) {
  try {
    fn();
    const el = document.getElementById(`estado-carregando-${chave}`);
    if (el) el.style.display = 'none';
  } catch (erro) {
    console.error(`Erro ao preparar ${chave}:`, erro);
    finalizarSecaoComErro(`estado-carregando-${chave}`, `estado-erro-${chave}`, erro);
  }
}

function finalizarSecaoComErro(idCarregando, idErro, erro) {
  const elCarregando = document.getElementById(idCarregando);
  if (elCarregando) elCarregando.style.display = 'none';
  const elErro = document.getElementById(idErro);
  if (elErro) {
    elErro.textContent = 'Não foi possível carregar os dados. ' + (erro && erro.message ? erro.message : '');
    elErro.style.display = 'block';
  }
}

// ===================================================================== navegação e utilitários

function ligarEventosNavegacaoCompras() {
  document.querySelectorAll('[data-compras-abrir]').forEach((botao) => {
    botao.addEventListener('click', () => abrirSecaoCompras(botao.dataset.comprasAbrir));
  });
  document.querySelectorAll('[data-compras-voltar]').forEach((botao) => {
    botao.addEventListener('click', fecharSecaoCompras);
  });
}

function abrirSecaoCompras(chave) {
  document.getElementById('compras-central').style.display = 'none';
  document.querySelectorAll('.compras-secao').forEach((secao) => {
    secao.classList.toggle('compras-secao-ativa', secao.dataset.comprasSecao === chave);
  });
  window.scrollTo(0, 0);
}

function fecharSecaoCompras() {
  document.querySelectorAll('.compras-secao').forEach((secao) => secao.classList.remove('compras-secao-ativa'));
  document.getElementById('compras-central').style.display = '';
}

function abrirModal(idOverlay) {
  document.getElementById(idOverlay).classList.add('modal-visivel');
}

function fecharModal(idOverlay) {
  document.getElementById(idOverlay).classList.remove('modal-visivel');
}

/** Escapa texto para HTML e para atributos (inclui aspas) — descrições de nota são texto livre. */
function esc(texto) {
  return escaparHtml(texto).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function euro(valor) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return '—';
  return '€' + Number(valor).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function euroPreciso(valor) {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) return '—';
  const n = Number(valor);
  const casas = Math.abs(n) < 1 ? 4 : 2;
  return '€' + n.toLocaleString('pt-PT', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function numeroTexto(valor, casas = 3) {
  return Number(valor).toLocaleString('pt-PT', { maximumFractionDigits: casas });
}

function formatarDataCompra(dataIso) {
  if (!dataIso) return '';
  const [ano, mes, dia] = String(dataIso).slice(0, 10).split('-');
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : dataIso;
}

function dataHojeLocal() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

function itemCompraPorId(id) {
  return itensCompraCache.find((i) => i.id === id) || null;
}

function fornecedorPorId(id) {
  return fornecedoresCache.find((f) => f.id === id) || null;
}

function categoriaFinanceiraPorId(id) {
  return categoriasFinanceirasCache.find((c) => c.id === id) || null;
}

function produtoDoItem(item) {
  return item && item.produtoId ? produtosCache.find((p) => p.id === item.produtoId) || null : null;
}

/** O estoque deste item fica no produto de revenda (Coca Cola etc.)? */
function estoqueFicaNoProduto(item) {
  const produto = produtoDoItem(item);
  return !!(item && item.controlaEstoque && produto && produto.stockMode === 'purchased');
}

function opcoesCategoriasDespesa(selecionada) {
  const ativas = categoriasFinanceirasCache.filter((c) => c.tipo === 'expense' && c.ativo);
  return '<option value="">— Categoria —</option>' + ativas
    .map((c) => `<option value="${c.id}" ${c.id === selecionada ? 'selected' : ''}>${esc(c.nome)}</option>`)
    .join('');
}

function atualizarDatalists() {
  document.getElementById('lista-itens-compra-datalist').innerHTML = itensCompraCache
    .filter((i) => i.ativo)
    .map((i) => `<option value="${esc(i.nome)}">${i.controlaEstoque ? 'Estoque' : 'Despesa'}</option>`)
    .join('');
  document.getElementById('lista-fornecedores-datalist').innerHTML = fornecedoresCache
    .filter((f) => f.ativo)
    .map((f) => `<option value="${esc(f.nome)}"></option>`)
    .join('');
}

function itemPorNomeDigitado(texto) {
  const n = normalizarTextoCompra(texto);
  if (!n) return null;
  return itensCompraCache.find((i) => i.ativo && normalizarTextoCompra(i.nome) === n) || null;
}

function mostrarErroCompra(mensagem) {
  const el = document.getElementById('dica-registrar-compra-erro');
  el.textContent = mensagem || '';
  el.style.display = mensagem ? '' : 'none';
}

// ===================================================================== rascunho (Nova Compra)

function novoUid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function linhaVazia() {
  return {
    uid: novoUid(),
    descricao: '',
    itemId: null,
    itemTexto: '',
    destino: 'estoque',
    categoriaFinanceiraId: null,
    quantidade: null,
    unidade: '',
    precoUnitario: null,
    valorBruto: null,
    desconto: null,
    taxaVat: null,
    lembrarApelido: true,
    sugestao: null,
    observacaoIa: null,
    origemAssociacao: null,
  };
}

function rascunhoNovo() {
  return {
    requestId: novoUid(),
    origem: 'manual',
    documentos: [],
    fornecedor: '',
    data: dataHojeLocal(),
    referencia: '',
    vatRecuperavel: true,
    observacoes: '',
    descontoGeral: null,
    totalPago: null,
    linhas: [linhaVazia()],
    avisosIa: [],
  };
}

function salvarRascunhoLocal() {
  try {
    const copia = { ...rascunho, documentos: rascunho.documentos.map((d) => ({ documento: d.documento })) };
    localStorage.setItem(CHAVE_RASCUNHO_COMPRA, JSON.stringify(copia));
  } catch (erro) {
    // armazenamento local indisponível: segue sem rascunho salvo
  }
}

function apagarRascunhoLocal() {
  try {
    localStorage.removeItem(CHAVE_RASCUNHO_COMPRA);
  } catch (erro) {
    // ignore
  }
}

function iniciarRascunho() {
  let salvo = null;
  try {
    salvo = JSON.parse(localStorage.getItem(CHAVE_RASCUNHO_COMPRA) || 'null');
  } catch (erro) {
    salvo = null;
  }
  rascunho = salvo && salvo.requestId && Array.isArray(salvo.linhas) ? { ...rascunhoNovo(), ...salvo } : rascunhoNovo();
  if (!rascunho.linhas.length) rascunho.linhas = [linhaVazia()];
  preencherCabecalhoDoRascunho();
  renderizarDocumentosRascunho();
  renderizarLinhasRascunho();
  atualizarResumoCompra();
  atualizarPermissaoNovaCompra();
}

function rascunhoTemConteudo() {
  return rascunho.documentos.length > 0 || rascunho.linhas.some((l) => l.descricao || l.itemId || l.quantidade || l.valorBruto || l.precoUnitario);
}

function preencherCabecalhoDoRascunho() {
  document.getElementById('campo-fornecedor-compra').value = rascunho.fornecedor || '';
  document.getElementById('campo-data-compra').value = rascunho.data || dataHojeLocal();
  document.getElementById('campo-referencia-compra').value = rascunho.referencia || '';
  document.getElementById('campo-vat-recuperavel-compra').value = rascunho.vatRecuperavel ? 'true' : 'false';
  document.getElementById('campo-observacoes-compra').value = rascunho.observacoes || '';
  document.getElementById('campo-desconto-geral-compra').value = rascunho.descontoGeral ?? '';
  document.getElementById('campo-total-pago-compra').value = rascunho.totalPago ?? '';
}

function atualizarPermissaoNovaCompra() {
  document.getElementById('dica-compras-somente-admin').style.display = souAdminCompras ? 'none' : '';
  document.getElementById('botao-confirmar-compra').disabled = !souAdminCompras;
  document.querySelectorAll('.compras-acoes-documento input[type=file]').forEach((i) => { i.disabled = !souAdminCompras; });
}

function ligarEventosNovaCompra() {
  const campos = [
    ['campo-fornecedor-compra', 'fornecedor'],
    ['campo-data-compra', 'data'],
    ['campo-referencia-compra', 'referencia'],
    ['campo-observacoes-compra', 'observacoes'],
  ];
  campos.forEach(([id, chave]) => {
    document.getElementById(id).addEventListener('input', (e) => {
      rascunho[chave] = e.target.value;
      salvarRascunhoLocal();
    });
  });
  document.getElementById('campo-vat-recuperavel-compra').addEventListener('change', (e) => {
    rascunho.vatRecuperavel = e.target.value === 'true';
    salvarRascunhoLocal();
    atualizarTodasAsLinhasCalculadas();
  });
  document.getElementById('campo-desconto-geral-compra').addEventListener('input', (e) => {
    rascunho.descontoGeral = numeroOuNullCompra(e.target.value);
    salvarRascunhoLocal();
    atualizarTodasAsLinhasCalculadas();
  });
  document.getElementById('campo-total-pago-compra').addEventListener('input', (e) => {
    rascunho.totalPago = numeroOuNullCompra(e.target.value);
    salvarRascunhoLocal();
    atualizarResumoCompra();
  });
  document.getElementById('botao-adicionar-linha-compra').addEventListener('click', () => {
    rascunho.linhas.push(linhaVazia());
    salvarRascunhoLocal();
    renderizarLinhasRascunho();
    const cards = document.querySelectorAll('.compras-linha-card');
    const ultimo = cards[cards.length - 1];
    if (ultimo) ultimo.querySelector('[data-campo="descricao"]').focus();
  });
  document.getElementById('botao-limpar-compra').addEventListener('click', () => {
    if (rascunhoTemConteudo() && !confirm('Descartar o rascunho desta compra?')) return;
    rascunho = rascunhoNovo();
    apagarRascunhoLocal();
    preencherCabecalhoDoRascunho();
    renderizarDocumentosRascunho();
    renderizarLinhasRascunho();
    atualizarResumoCompra();
    mostrarErroCompra('');
  });
  document.getElementById('botao-confirmar-compra').addEventListener('click', confirmarCompra);

  document.getElementById('campo-foto-camera').addEventListener('change', aoEscolherArquivos);
  document.getElementById('campo-foto-galeria').addEventListener('change', aoEscolherArquivos);
  document.getElementById('campo-pdf').addEventListener('change', aoEscolherArquivos);
}

// --------------------------------------------------------------------- documentos

async function aoEscolherArquivos(evento) {
  const arquivos = Array.from(evento.target.files || []);
  evento.target.value = '';
  if (!arquivos.length || !souAdminCompras) return;
  const dica = document.getElementById('dica-documentos-compra');
  for (const arquivo of arquivos) {
    const pendente = { documento: null, previa: null, enviando: true, nome: arquivo.name || 'documento' };
    rascunho.documentos.push(pendente);
    renderizarDocumentosRascunho();
    try {
      const { documento, previa } = await enviarDocumentoCompra(arquivo);
      pendente.documento = documento;
      pendente.previa = previa;
      pendente.enviando = false;
    } catch (erro) {
      rascunho.documentos = rascunho.documentos.filter((d) => d !== pendente);
      dica.textContent = 'Não foi possível anexar "' + (arquivo.name || 'arquivo') + '": ' + erro.message;
    }
    salvarRascunhoLocal();
    renderizarDocumentosRascunho();
  }
}

function renderizarDocumentosRascunho() {
  const lista = document.getElementById('lista-documentos-compra');
  lista.innerHTML = rascunho.documentos.map((d, i) => {
    const ehPdf = d.documento && d.documento.tipoMime === 'application/pdf';
    const miniatura = d.previa
      ? `<img src="${d.previa}" alt="Nota anexada" />`
      : `<span class="compras-documento-icone">${ehPdf ? '📄' : '🧾'}</span>`;
    const status = d.enviando ? 'Enviando…' : d.lendo ? 'Lendo com IA…' : d.lido ? '✓ Lido pela IA' : '';
    return `
      <div class="compras-documento" data-indice="${i}">
        <button type="button" class="compras-documento-miniatura" data-acao="abrir" ${d.documento ? '' : 'disabled'} title="Abrir">${miniatura}</button>
        <div class="compras-documento-info">
          <span class="compras-documento-nome">${esc((d.documento && d.documento.nomeArquivo) || d.nome || 'Documento')}</span>
          <span class="compras-documento-status">${status}</span>
          <div class="compras-documento-acoes">
            <button type="button" class="btn btn-primario btn-pequeno" data-acao="ler" ${d.documento && !d.lendo ? '' : 'disabled'}>✨ Ler com IA</button>
            <button type="button" class="btn-icone" data-acao="remover" title="Remover" ${d.enviando || d.lendo ? 'disabled' : ''}>✕</button>
          </div>
        </div>
      </div>`;
  }).join('');
  lista.querySelectorAll('.compras-documento').forEach((el) => {
    const i = Number(el.dataset.indice);
    el.querySelector('[data-acao="abrir"]').addEventListener('click', () => abrirDocumento(rascunho.documentos[i].documento));
    el.querySelector('[data-acao="ler"]').addEventListener('click', () => lerDocumentoDoRascunho(i));
    el.querySelector('[data-acao="remover"]').addEventListener('click', () => removerDocumentoDoRascunho(i));
  });
}

async function abrirDocumento(documento) {
  if (!documento) return;
  try {
    const url = await obterLinkDocumentoCompra(documento.caminho);
    window.open(url, '_blank', 'noopener');
  } catch (erro) {
    mostrarToast('Não foi possível abrir o documento. ' + erro.message, 'erro');
  }
}

function removerDocumentoDoRascunho(indice) {
  const d = rascunho.documentos[indice];
  rascunho.documentos.splice(indice, 1);
  salvarRascunhoLocal();
  renderizarDocumentosRascunho();
  // Arquivo ainda não ligado a compra: tenta liberar o espaço (melhor esforço).
  if (d && d.documento) {
    supabaseClient.storage.from('purchase-documents').remove([d.documento.caminho]).catch(() => undefined);
  }
}

async function lerDocumentoDoRascunho(indice) {
  const d = rascunho.documentos[indice];
  if (!d || !d.documento) return;
  const dica = document.getElementById('dica-documentos-compra');
  d.lendo = true;
  renderizarDocumentosRascunho();
  let nota;
  try {
    nota = await lerDocumentoCompraComIa(d.documento.id);
  } catch (erro) {
    d.lendo = false;
    renderizarDocumentosRascunho();
    dica.textContent = erro.message;
    dica.classList.add('compras-dica-alerta');
    return;
  }
  d.lendo = false;
  d.lido = true;
  aplicarLeituraNoRascunho(rascunhoDaNotaLida(nota));
  renderizarDocumentosRascunho();
}

function aplicarLeituraNoRascunho(lido) {
  const dica = document.getElementById('dica-documentos-compra');
  dica.classList.remove('compras-dica-alerta');
  const linhasPreenchidas = rascunho.linhas.filter((l) => l.descricao || l.itemId || l.quantidade || l.valorBruto);
  const novas = lido.linhas.map((l) => ({ ...linhaVazia(), ...l }));
  if (novas.length && linhasPreenchidas.length) {
    if (confirm(`A nota tem ${novas.length} linha(s). OK = adicionar às linhas atuais; Cancelar = substituir as linhas atuais.`)) {
      rascunho.linhas = [...linhasPreenchidas, ...novas];
    } else {
      rascunho.linhas = novas;
    }
  } else if (novas.length) {
    rascunho.linhas = novas;
  }
  if (!rascunho.fornecedor && lido.fornecedor) rascunho.fornecedor = lido.fornecedor;
  if (!rascunho.referencia && lido.referencia) rascunho.referencia = lido.referencia;
  if (lido.data) rascunho.data = lido.data;
  if (lido.descontoGeral !== null && lido.descontoGeral !== undefined) rascunho.descontoGeral = lido.descontoGeral;
  if (lido.totalPago !== null && lido.totalPago !== undefined) rascunho.totalPago = lido.totalPago;
  rascunho.origem = 'ocr';
  rascunho.avisosIa = lido.avisos || [];
  if (lido.moeda && lido.moeda !== 'EUR') rascunho.avisosIa.push(`Moeda da nota: ${lido.moeda}. Os valores serão gravados como euros.`);

  const resumo = novas.length
    ? `IA leu ${novas.length} linha(s). Confira cada uma — campos em branco não puderam ser lidos.`
    : 'A IA não encontrou itens legíveis. Preencha manualmente.';
  dica.innerHTML = esc(resumo) + (rascunho.avisosIa.length
    ? '<ul class="compras-avisos-ia">' + rascunho.avisosIa.map((a) => `<li>${esc(a)}</li>`).join('') + '</ul>'
    : '');

  if (!rascunho.linhas.length) rascunho.linhas = [linhaVazia()];
  preencherCabecalhoDoRascunho();
  salvarRascunhoLocal();
  renderizarLinhasRascunho();
  atualizarResumoCompra();
  buscarSugestoesDasLinhas();
}

// --------------------------------------------------------------------- associação (sugestões)

async function buscarSugestoesDasLinhas(somenteUid) {
  const alvo = rascunho.linhas.filter((l) => !l.itemId && normalizarTextoCompra(l.descricao) && (!somenteUid || l.uid === somenteUid));
  if (!alvo.length) return;
  let resultado;
  try {
    resultado = await sugerirItensParaDescricoesNoSupabase(alvo.map((l) => l.descricao));
  } catch (erro) {
    console.error('Sugestões indisponíveis:', erro);
    return;
  }
  resultado.forEach((r) => {
    const linha = alvo[r.index];
    if (!linha || linha.itemId) return;
    linha.sugestao = r;
    if (r.exact) {
      // Associação já confirmada antes (nome alternativo) ou nome idêntico: reutiliza, visível e trocável.
      associarItemNaLinha(linha, itemCompraPorId(r.exact.purchase_item_id), r.exact.via === 'alias' ? 'apelido' : 'nome');
    }
  });
  salvarRascunhoLocal();
  renderizarLinhasRascunho();
  atualizarResumoCompra();
}

function associarItemNaLinha(linha, item, origem) {
  if (!item) {
    linha.itemId = null;
    linha.origemAssociacao = null;
    return;
  }
  linha.itemId = item.id;
  linha.itemTexto = item.nome;
  linha.origemAssociacao = origem || 'manual';
  linha.destino = item.controlaEstoque ? 'estoque' : 'despesa';
  if (!item.controlaEstoque && !linha.categoriaFinanceiraId) linha.categoriaFinanceiraId = item.categoriaFinanceiraId;
  if (item.controlaEstoque) {
    const compativeis = UNIDADES_COMPATIVEIS_POR_BASE[item.unidadeBase] || [];
    if (!compativeis.includes(linha.unidade)) {
      // unidade lida/da linha não serve para este item: só troca quando estava vazia
      if (!linha.unidade) linha.unidade = UNIDADE_PADRAO_POR_BASE[item.unidadeBase] || '';
    }
  }
}

// --------------------------------------------------------------------- linhas

function renderizarLinhasRascunho() {
  const lista = document.getElementById('lista-linhas-compra');
  lista.innerHTML = rascunho.linhas.map((l, i) => htmlLinhaCompra(l, i)).join('');
  lista.querySelectorAll('.compras-linha-card').forEach((card) => ligarEventosLinha(card));
  atualizarTodasAsLinhasCalculadas();
}

function htmlLinhaCompra(l, i) {
  const item = itemCompraPorId(l.itemId);
  const unidades = item && item.controlaEstoque ? UNIDADES_COMPATIVEIS_POR_BASE[item.unidadeBase] || UNIDADES_LINHA_COMPRA : UNIDADES_LINHA_COMPRA;
  const opcoesUnidade = '<option value="">—</option>' + unidades
    .map((u) => `<option value="${u}" ${u === l.unidade ? 'selected' : ''}>${u}</option>`).join('')
    + (l.unidade && !unidades.includes(l.unidade) ? `<option value="${l.unidade}" selected>${l.unidade} (incompatível)</option>` : '');
  const opcoesVat = '<option value="">VAT</option>' + TAXAS_VAT_COMPRA
    .map((t) => `<option value="${t}" ${Number(l.taxaVat) === t && l.taxaVat !== null ? 'selected' : ''}>${String(t).replace('.', ',')}%</option>`).join('');

  let associacao = '';
  if (item) {
    const selo = l.origemAssociacao === 'apelido' ? 'reconhecido por associação anterior'
      : l.origemAssociacao === 'nome' ? 'mesmo nome do cadastro' : 'associado';
    const destino = item.controlaEstoque
      ? (estoqueFicaNoProduto(item) ? `entra no estoque do produto ${esc(produtoDoItem(item).nome)}` : 'entra no estoque')
      : 'despesa sem estoque';
    associacao = `<span class="compras-associacao-ok">✓ ${esc(item.nome)}</span>
      <span class="compras-associacao-info">${selo} · ${destino}</span>`;
    const diferente = normalizarTextoCompra(l.descricao) && normalizarTextoCompra(l.descricao) !== normalizarTextoCompra(item.nome);
    if (diferente) {
      associacao += `<label class="compras-check"><input type="checkbox" data-campo="lembrarApelido" ${l.lembrarApelido ? 'checked' : ''} />
        Lembrar "${esc(l.descricao)}" como nome de ${esc(item.nome)}</label>`;
    }
  } else if (l.sugestao && l.sugestao.candidates && l.sugestao.candidates.length) {
    associacao = '<span class="compras-associacao-info">Parece com:</span> ' + l.sugestao.candidates
      .map((c) => `<button type="button" class="compras-chip" data-sugestao="${c.purchase_item_id}">${esc(c.name)} <small>${Math.round(c.score * 100)}%</small></button>`)
      .join('');
  }

  const mostrarCategoria = (item && !item.controlaEstoque) || (!item && l.destino === 'despesa');
  return `
    <div class="card compras-linha-card" data-uid="${l.uid}">
      <div class="compras-linha-topo">
        <span class="compras-linha-numero">${i + 1}</span>
        <input type="text" class="input" data-campo="descricao" value="${esc(l.descricao || '')}" placeholder="Descrição na nota" maxlength="300" />
        <button type="button" class="btn-icone" data-acao="remover" title="Remover linha">🗑️</button>
      </div>
      <div class="compras-linha-associacao">
        <div class="compras-linha-item">
          <input type="text" class="input" data-campo="itemTexto" list="lista-itens-compra-datalist" value="${esc(item ? item.nome : l.itemTexto || '')}" placeholder="Item do cadastro" autocomplete="off" />
          <button type="button" class="btn btn-secundario btn-pequeno" data-acao="novo-item" ${souAdminCompras ? '' : 'disabled'}>+ Novo</button>
        </div>
        ${item ? '' : `<select class="input compras-linha-destino" data-campo="destino">
          <option value="estoque" ${l.destino === 'estoque' ? 'selected' : ''}>Estoque</option>
          <option value="despesa" ${l.destino === 'despesa' ? 'selected' : ''}>Despesa sem item</option>
        </select>`}
        ${mostrarCategoria ? `<select class="input" data-campo="categoriaFinanceiraId">${opcoesCategoriasDespesa(l.categoriaFinanceiraId || (item && item.categoriaFinanceiraId))}</select>` : ''}
        <div class="compras-linha-sugestoes">${associacao}</div>
      </div>
      <div class="compras-linha-valores">
        <label>Qtd.<input type="number" class="input" data-campo="quantidade" min="0" step="0.001" inputmode="decimal" value="${l.quantidade ?? ''}" /></label>
        <label>Unid.<select class="input" data-campo="unidade">${opcoesUnidade}</select></label>
        <label>Preço unit.<input type="number" class="input" data-campo="precoUnitario" min="0" step="0.0001" inputmode="decimal" value="${l.precoUnitario ?? ''}" /></label>
        <label>Valor linha<input type="number" class="input" data-campo="valorBruto" min="0" step="0.01" inputmode="decimal" value="${l.valorBruto ?? ''}" placeholder="qtd × preço" /></label>
        <label>Desconto<input type="number" class="input" data-campo="desconto" min="0" step="0.01" inputmode="decimal" value="${l.desconto ?? ''}" /></label>
        <label>VAT<select class="input" data-campo="taxaVat">${opcoesVat}</select></label>
      </div>
      ${l.observacaoIa ? `<p class="compras-aviso compras-aviso-linha">${esc(l.observacaoIa)}</p>` : ''}
      <div class="compras-linha-calculo" data-calculo></div>
    </div>`;
}

function linhaPorUid(uid) {
  return rascunho.linhas.find((l) => l.uid === uid);
}

function ligarEventosLinha(card) {
  const uid = card.dataset.uid;
  const numericos = ['quantidade', 'precoUnitario', 'valorBruto', 'desconto'];
  card.querySelectorAll('[data-campo]').forEach((campo) => {
    const chave = campo.dataset.campo;
    const evento = campo.tagName === 'SELECT' || campo.type === 'checkbox' ? 'change' : 'input';
    campo.addEventListener(evento, () => {
      const l = linhaPorUid(uid);
      if (!l) return;
      if (chave === 'lembrarApelido') l.lembrarApelido = campo.checked;
      else if (numericos.includes(chave)) l[chave] = numeroOuNullCompra(campo.value);
      else if (chave === 'taxaVat') l.taxaVat = numeroOuNullCompra(campo.value);
      else if (chave === 'categoriaFinanceiraId') l.categoriaFinanceiraId = campo.value || null;
      else if (chave === 'itemTexto') {
        l.itemTexto = campo.value;
        return salvarRascunhoLocal();
      } else l[chave] = campo.value;
      salvarRascunhoLocal();
      if (chave === 'destino') {
        renderizarLinhasRascunho();
        return;
      }
      atualizarTodasAsLinhasCalculadas();
    });
  });

  const campoItem = card.querySelector('[data-campo="itemTexto"]');
  campoItem.addEventListener('change', () => {
    const l = linhaPorUid(uid);
    const texto = campoItem.value.trim();
    const item = itemPorNomeDigitado(texto);
    if (item) associarItemNaLinha(l, item, 'manual');
    else {
      l.itemId = null;
      l.itemTexto = texto;
      l.origemAssociacao = null;
    }
    salvarRascunhoLocal();
    renderizarLinhasRascunho();
  });

  card.querySelector('[data-campo="descricao"]').addEventListener('change', () => {
    const l = linhaPorUid(uid);
    if (!l.itemId) buscarSugestoesDasLinhas(uid);
    else renderizarLinhasRascunho();
  });

  card.querySelectorAll('[data-sugestao]').forEach((botao) => {
    botao.addEventListener('click', () => {
      const l = linhaPorUid(uid);
      associarItemNaLinha(l, itemCompraPorId(botao.dataset.sugestao), 'sugestao');
      salvarRascunhoLocal();
      renderizarLinhasRascunho();
    });
  });

  card.querySelector('[data-acao="remover"]').addEventListener('click', () => {
    rascunho.linhas = rascunho.linhas.filter((x) => x.uid !== uid);
    if (!rascunho.linhas.length) rascunho.linhas = [linhaVazia()];
    salvarRascunhoLocal();
    renderizarLinhasRascunho();
  });

  card.querySelector('[data-acao="novo-item"]').addEventListener('click', () => {
    const l = linhaPorUid(uid);
    uidLinhaAguardandoNovoItem = uid;
    abrirModalNovoItemCompra(l.itemTexto && !l.itemId ? l.itemTexto : l.descricao);
  });
}

function calculoAtual() {
  return calcularCompra(rascunho.linhas, rascunho.descontoGeral, rascunho.vatRecuperavel, rascunho.totalPago);
}

function atualizarTodasAsLinhasCalculadas() {
  const calc = calculoAtual();
  rascunho.linhas.forEach((l, i) => {
    const card = document.querySelector(`.compras-linha-card[data-uid="${l.uid}"]`);
    if (!card) return;
    const item = itemCompraPorId(l.itemId);
    const r = calc.linhas[i];
    const problemas = problemasDaLinhaCompra({ ...l, destino: item ? (item.controlaEstoque ? 'estoque' : 'despesa') : l.destino }, item);
    let custoUnit = '';
    if (item && item.controlaEstoque && problemas.length === 0) {
      const base = quantidadeBaseDaLinhaCompra(l.quantidade, l.unidade, item.unidadeBase);
      if (base) custoUnit = ` · ${euroPreciso(custoParaExibicaoCompra(r.custo / base, item.unidadeBase))}/${rotuloUnidadeExibicaoCompra(item.unidadeBase)}`;
    }
    const alvo = card.querySelector('[data-calculo]');
    alvo.innerHTML = `
      <span>Líquido <strong>${euro(r.liquido)}</strong></span>
      <span>VAT <strong>${euro(r.vat)}</strong></span>
      <span>Custo <strong>${euro(r.custo)}</strong>${custoUnit}</span>
      ${r.rateio ? `<span class="compras-calculo-nota">inclui −${euro(r.rateio)} do desconto geral</span>` : ''}
      ${problemas.length ? `<span class="compras-linha-pendencias">Falta: ${problemas.map(escaparHtml).join(', ')}</span>` : ''}`;
    card.classList.toggle('compras-linha-incompleta', problemas.length > 0);
  });
  atualizarResumoCompra(calc);
}

function atualizarResumoCompra(calcPronto) {
  const calc = calcPronto || calculoAtual();
  const t = calc.totais;
  const itensEstoque = rascunho.linhas.filter((l) => { const it = itemCompraPorId(l.itemId); return it && it.controlaEstoque; }).length;
  const despesas = rascunho.linhas.length - itensEstoque;
  document.getElementById('resumo-compra').innerHTML = `
    <div><dt>Bruto</dt><dd>${euro(t.bruto)}</dd></div>
    <div><dt>Descontos</dt><dd>−${euro(t.descontos)}</dd></div>
    <div><dt>Líquido</dt><dd>${euro(t.liquido)}</dd></div>
    <div><dt>VAT ${rascunho.vatRecuperavel ? '(recuperável)' : '(no custo)'}</dt><dd>${euro(t.vat)}</dd></div>
    <div><dt>Total calculado</dt><dd>${euro(t.calculado)}</dd></div>
    <div class="compras-resumo-destaque"><dt>Total pago</dt><dd>${euro(t.pago)}</dd></div>
    <div><dt>Entradas no estoque</dt><dd>${itensEstoque}</dd></div>
    <div><dt>Despesas</dt><dd>${despesas}</dd></div>`;
  const aviso = document.getElementById('aviso-diferenca-compra');
  let texto = '';
  if (t.descontoGeralExcede) texto = 'O desconto geral é maior que o valor das linhas.';
  else if (t.diferencaExcede) texto = `O total pago difere do calculado em ${euro(t.diferenca)} — acima do limite de €1,00. Confira valores, descontos e VAT.`;
  else if (t.diferenca !== 0) texto = `Diferença de arredondamento de ${euro(t.diferenca)} será registrada.`;
  aviso.textContent = texto;
  aviso.style.display = texto ? '' : 'none';
  aviso.classList.toggle('compras-aviso-erro', t.descontoGeralExcede || t.diferencaExcede);
}

// --------------------------------------------------------------------- confirmar

function montarPayloadCompra() {
  const fornecedorTexto = (rascunho.fornecedor || '').trim();
  const fornecedorExistente = fornecedoresCache.find((f) => normalizarTextoCompra(f.nome) === normalizarTextoCompra(fornecedorTexto));
  return {
    client_request_id: rascunho.requestId,
    supplier_id: fornecedorExistente ? fornecedorExistente.id : null,
    supplier_name: fornecedorExistente ? null : fornecedorTexto || null,
    purchased_at: rascunho.data,
    reference: rascunho.referencia || null,
    notes: rascunho.observacoes || null,
    vat_recoverable: rascunho.vatRecuperavel,
    header_discount: rascunho.descontoGeral || 0,
    total_paid: rascunho.totalPago,
    source: rascunho.origem,
    document_ids: rascunho.documentos.filter((d) => d.documento).map((d) => d.documento.id),
    lines: rascunho.linhas.map((l) => {
      const item = itemCompraPorId(l.itemId);
      return {
        raw_description: l.descricao || null,
        purchase_item_id: item ? item.id : null,
        line_type: item ? undefined : l.destino === 'despesa' ? 'expense' : 'stock',
        finance_category_id: l.categoriaFinanceiraId || null,
        quantity: l.quantidade,
        unit: l.unidade,
        unit_price: l.precoUnitario,
        gross_amount: l.valorBruto,
        discount_amount: l.desconto || 0,
        vat_rate: l.taxaVat,
        remember_alias: l.lembrarApelido !== false,
      };
    }),
  };
}

async function confirmarCompra() {
  if (!souAdminCompras || confirmandoCompra) return;
  mostrarErroCompra('');
  if (!rascunho.data) return mostrarErroCompra('Informe a data da compra.');
  if (rascunho.documentos.some((d) => d.enviando || d.lendo)) return mostrarErroCompra('Aguarde o envio/leitura dos documentos terminar.');

  const pendentes = rascunho.linhas
    .map((l, i) => {
      const item = itemCompraPorId(l.itemId);
      const p = problemasDaLinhaCompra({ ...l, destino: item ? (item.controlaEstoque ? 'estoque' : 'despesa') : l.destino }, item);
      return p.length ? `Linha ${i + 1}: ${p.join(', ')}` : null;
    })
    .filter(Boolean);
  if (pendentes.length) {
    const primeiro = document.querySelector('.compras-linha-incompleta');
    if (primeiro) primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return mostrarErroCompra('Complete as linhas antes de confirmar. ' + pendentes.join(' · '));
  }
  const calc = calculoAtual();
  if (calc.totais.descontoGeralExcede) return mostrarErroCompra('O desconto geral é maior que o valor das linhas.');
  if (calc.totais.diferencaExcede) return mostrarErroCompra('O total pago difere do calculado em mais de €1,00. Confira os valores.');

  const entradas = rascunho.linhas.filter((l) => { const it = itemCompraPorId(l.itemId); return it && it.controlaEstoque; });
  const resumoConfirmacao = [
    `Confirmar compra de ${euro(calc.totais.pago)}?`,
    `${entradas.length} entrada(s) no estoque e ${rascunho.linhas.length - entradas.length} despesa(s).`,
    `VAT ${euro(calc.totais.vat)} ${rascunho.vatRecuperavel ? '(recuperável, fora do custo)' : '(não recuperável, no custo)'}.`,
    'Depois de confirmada, a compra só pode ser cancelada com estorno.',
  ].join('\n');
  if (!confirm(resumoConfirmacao)) return;

  const botao = document.getElementById('botao-confirmar-compra');
  confirmandoCompra = true;
  botao.disabled = true;
  botao.textContent = 'Confirmando…';
  let resultado;
  try {
    resultado = await confirmarCompraNoSupabase(montarPayloadCompra());
  } catch (erro) {
    // Rascunho e client_request_id preservados: nova tentativa não duplica.
    mostrarErroCompra('Não foi possível confirmar. ' + erro.message);
    confirmandoCompra = false;
    botao.disabled = false;
    botao.textContent = 'Confirmar compra';
    return;
  }
  confirmandoCompra = false;
  botao.disabled = false;
  botao.textContent = 'Confirmar compra';

  mostrarToast(resultado.duplicate ? 'Esta compra já estava registrada.' : 'Compra registrada e estoque atualizado.', 'sucesso');
  rascunho = rascunhoNovo();
  apagarRascunhoLocal();
  preencherCabecalhoDoRascunho();
  renderizarDocumentosRascunho();
  renderizarLinhasRascunho();
  const dica = document.getElementById('dica-documentos-compra');
  dica.textContent = 'Fotografe ou anexe a nota para a IA preencher os dados. Você confere tudo antes de confirmar.';
  dica.classList.remove('compras-dica-alerta');
  await recarregarDepoisDeGravar();
  abrirSecaoCompras('historico');
  abrirDetalheCompra(resultado.purchase_id);
}

// ===================================================================== HISTÓRICO

function ligarEventosHistorico() {
  ['filtro-historico-busca', 'filtro-historico-de', 'filtro-historico-ate', 'filtro-historico-status'].forEach((id) => {
    document.getElementById(id).addEventListener('input', renderizarHistoricoCompras);
  });
  document.getElementById('botao-fechar-modal-detalhe-compra').addEventListener('click', () => fecharModal('modal-overlay-detalhe-compra'));
  document.getElementById('botao-fechar-detalhe-compra').addEventListener('click', () => fecharModal('modal-overlay-detalhe-compra'));
  document.getElementById('botao-cancelar-compra').addEventListener('click', abrirModalCancelarCompra);
  document.getElementById('botao-fechar-modal-cancelar-compra').addEventListener('click', () => fecharModal('modal-overlay-cancelar-compra'));
  document.getElementById('botao-desistir-cancelar-compra').addEventListener('click', () => fecharModal('modal-overlay-cancelar-compra'));
  document.getElementById('botao-confirmar-cancelar-compra').addEventListener('click', confirmarCancelamentoCompra);
}

function linhasDaCompra(compraId) {
  return linhasComprasCache.filter((l) => l.compraId === compraId).sort((a, b) => a.ordem - b.ordem);
}

function comprasFiltradas() {
  const busca = normalizarTextoCompra(document.getElementById('filtro-historico-busca').value);
  const de = document.getElementById('filtro-historico-de').value;
  const ate = document.getElementById('filtro-historico-ate').value;
  const status = document.getElementById('filtro-historico-status').value;
  return comprasCache.filter((c) => {
    if (status && c.status !== status) return false;
    if (de && c.compradoEm < de) return false;
    if (ate && c.compradoEm > ate) return false;
    if (busca) {
      const fornecedor = fornecedorPorId(c.fornecedorId);
      const textos = [fornecedor && fornecedor.nome, c.referencia, ...linhasDaCompra(c.id).map((l) => `${l.nomeSnapshot} ${l.descricaoNota || ''}`)];
      if (!textos.some((t) => (normalizarTextoCompra(t) || '').includes(busca))) return false;
    }
    return true;
  });
}

function renderizarHistoricoCompras() {
  const corpo = document.getElementById('corpo-tabela-historico-compras');
  const vazio = document.getElementById('estado-vazio-historico-compras');
  const lista = comprasFiltradas();
  const confirmadas = lista.filter((c) => c.status === 'confirmed');
  document.getElementById('resumo-historico-compras').innerHTML = `
    <div><dt>Compras</dt><dd>${confirmadas.length}</dd></div>
    <div><dt>Total pago</dt><dd>${euro(confirmadas.reduce((s, c) => s + c.totalPago, 0))}</dd></div>
    <div><dt>VAT recuperável</dt><dd>${euro(confirmadas.filter((c) => c.vatRecuperavel).reduce((s, c) => s + c.totalVat, 0))}</dd></div>
    <div><dt>VAT no custo</dt><dd>${euro(confirmadas.filter((c) => !c.vatRecuperavel).reduce((s, c) => s + c.totalVat, 0))}</dd></div>`;
  if (!lista.length) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';
  corpo.innerHTML = lista.map((c) => {
    const fornecedor = fornecedorPorId(c.fornecedorId);
    const n = linhasDaCompra(c.id).length;
    const situacao = c.status === 'cancelled'
      ? '<span class="compras-status compras-status-cancelada">Cancelada</span>'
      : '<span class="compras-status compras-status-ok">Confirmada</span>';
    return `
      <tr class="${c.status === 'cancelled' ? 'compras-linha-cancelada' : ''}">
        <td>${formatarDataCompra(c.compradoEm)}</td>
        <td>${esc(fornecedor ? fornecedor.nome : '—')}</td>
        <td>${esc(c.referencia || '—')}</td>
        <td>${n}</td>
        <td>${euro(c.totalVat)}</td>
        <td><strong>${euro(c.totalPago)}</strong></td>
        <td>${situacao}${c.origem === 'ocr' ? ' <span title="Lida por IA">✨</span>' : ''}</td>
        <td><button class="btn btn-secundario btn-pequeno" data-detalhe-compra="${c.id}">Ver</button></td>
      </tr>`;
  }).join('');
  corpo.querySelectorAll('[data-detalhe-compra]').forEach((b) => b.addEventListener('click', () => abrirDetalheCompra(b.dataset.detalheCompra)));
}

async function abrirDetalheCompra(compraId) {
  const c = comprasCache.find((x) => x.id === compraId);
  if (!c) return;
  compraEmDetalheId = compraId;
  const fornecedor = fornecedorPorId(c.fornecedorId);
  document.getElementById('titulo-modal-detalhe-compra').textContent = `Compra de ${formatarDataCompra(c.compradoEm)}`;
  const linhas = linhasDaCompra(c.id);
  const corpo = document.getElementById('corpo-modal-detalhe-compra');
  corpo.innerHTML = `
    ${c.status === 'cancelled' ? `<p class="compras-aviso compras-aviso-erro">Cancelada em ${formatarData(c.canceladaEm)} — ${esc(c.motivoCancelamento || '')}. Estoque e custo médio foram estornados.</p>` : ''}
    <dl class="compras-resumo-grade">
      <div><dt>Fornecedor</dt><dd>${esc(fornecedor ? fornecedor.nome : '—')}</dd></div>
      <div><dt>Nº da nota</dt><dd>${esc(c.referencia || '—')}</dd></div>
      <div><dt>VAT</dt><dd>${c.vatRecuperavel ? 'Recuperável' : 'Não recuperável'}</dd></div>
      <div><dt>Origem</dt><dd>${c.origem === 'ocr' ? 'Lida por IA e conferida' : 'Manual'}</dd></div>
    </dl>
    ${c.observacoes ? `<p class="dica-campo">${esc(c.observacoes)}</p>` : ''}
    <div class="compras-tabela-wrap">
      <table class="tabela compras-tabela-compacta">
        <thead><tr><th>Item</th><th>Qtd.</th><th>Líquido</th><th>VAT</th><th>Custo</th><th>Custo/unid.</th></tr></thead>
        <tbody>${linhas.map((l) => {
          const item = itemCompraPorId(l.itemCompraId);
          const categoria = categoriaFinanceiraPorId(l.categoriaFinanceiraId);
          const unit = l.tipo === 'stock' && item && l.custoPorUnidadeBase !== null
            ? `${euroPreciso(custoParaExibicaoCompra(l.custoPorUnidadeBase, item.unidadeBase))}/${rotuloUnidadeExibicaoCompra(item.unidadeBase)}` : '—';
          return `<tr>
            <td>${esc(l.nomeSnapshot)}${l.descricaoNota && l.descricaoNota !== l.nomeSnapshot ? `<br><small>nota: ${esc(l.descricaoNota)}</small>` : ''}
              ${l.tipo === 'expense' ? `<br><small class="compras-tag-despesa">Despesa · ${esc(categoria ? categoria.nome : '')}</small>` : ''}</td>
            <td>${numeroTexto(l.quantidade)} ${l.unidade}</td>
            <td>${euro(l.valorLiquido)}${l.desconto + l.rateioDescontoGeral > 0 ? `<br><small>desc. ${euro(l.desconto + l.rateioDescontoGeral)}</small>` : ''}</td>
            <td>${euro(l.valorVat)}<br><small>${String(l.taxaVat).replace('.', ',')}%</small></td>
            <td>${euro(l.custo)}</td>
            <td>${unit}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <dl class="compras-resumo-grade">
      <div><dt>Bruto</dt><dd>${euro(c.totalBruto)}</dd></div>
      <div><dt>Descontos</dt><dd>−${euro(c.totalDescontos)}</dd></div>
      <div><dt>Líquido</dt><dd>${euro(c.totalLiquido)}</dd></div>
      <div><dt>VAT</dt><dd>${euro(c.totalVat)}</dd></div>
      ${c.arredondamento ? `<div><dt>Arredondamento</dt><dd>${euro(c.arredondamento)}</dd></div>` : ''}
      <div class="compras-resumo-destaque"><dt>Total pago</dt><dd>${euro(c.totalPago)}</dd></div>
    </dl>
    <h3 class="compras-subtitulo">Documentos</h3>
    <div class="compras-documentos" id="documentos-detalhe-compra"><span class="dica-campo">Carregando…</span></div>`;
  const podeCancelar = souAdminCompras && c.status === 'confirmed';
  document.getElementById('botao-cancelar-compra').style.display = podeCancelar ? '' : 'none';
  abrirModal('modal-overlay-detalhe-compra');

  const alvo = document.getElementById('documentos-detalhe-compra');
  try {
    const docs = await buscarDocumentosCompraDoSupabase(c.id);
    if (compraEmDetalheId !== compraId) return;
    alvo.innerHTML = docs.length
      ? docs.map((d, i) => `<button type="button" class="btn btn-secundario btn-pequeno" data-doc="${i}">${d.tipoMime === 'application/pdf' ? '📄' : '🧾'} ${esc(d.nomeArquivo || 'Documento ' + (i + 1))}</button>`).join('')
      : '<span class="dica-campo">Nenhum documento anexado.</span>';
    alvo.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => abrirDocumento(docs[Number(b.dataset.doc)])));
  } catch (erro) {
    alvo.innerHTML = `<span class="dica-campo">Não foi possível carregar os documentos. ${esc(erro.message)}</span>`;
  }
}

function abrirModalCancelarCompra() {
  document.getElementById('campo-motivo-cancelamento-compra').value = '';
  document.getElementById('dica-cancelar-compra-erro').style.display = 'none';
  abrirModal('modal-overlay-cancelar-compra');
  document.getElementById('campo-motivo-cancelamento-compra').focus();
}

async function confirmarCancelamentoCompra() {
  const motivo = document.getElementById('campo-motivo-cancelamento-compra').value.trim();
  const dica = document.getElementById('dica-cancelar-compra-erro');
  if (motivo.length < 3) {
    dica.textContent = 'Informe o motivo do cancelamento.';
    dica.style.display = '';
    return;
  }
  const botao = document.getElementById('botao-confirmar-cancelar-compra');
  botao.disabled = true;
  try {
    await cancelarCompraNoSupabase(compraEmDetalheId, motivo);
  } catch (erro) {
    dica.textContent = erro.message;
    dica.style.display = '';
    botao.disabled = false;
    return;
  }
  botao.disabled = false;
  fecharModal('modal-overlay-cancelar-compra');
  mostrarToast('Compra cancelada e estoque estornado.', 'sucesso');
  await recarregarDepoisDeGravar();
  abrirDetalheCompra(compraEmDetalheId);
}

// ===================================================================== ITENS E ESTOQUE

function ligarEventosItens() {
  document.getElementById('botao-novo-item-compra').addEventListener('click', () => {
    uidLinhaAguardandoNovoItem = null;
    abrirModalNovoItemCompra('');
  });
  document.getElementById('botao-novo-item-compra').disabled = !souAdminCompras;
  document.getElementById('dica-itens-compra-somente-admin').style.display = souAdminCompras ? 'none' : '';
  ['filtro-itens-compra-busca', 'filtro-itens-compra-categoria', 'filtro-itens-compra-tipo'].forEach((id) => {
    document.getElementById(id).addEventListener('input', renderizarTabelaItensCompra);
  });
  document.getElementById('botao-fechar-modal-item-compra').addEventListener('click', fecharModalItemCompra);
  document.getElementById('botao-cancelar-item-compra').addEventListener('click', fecharModalItemCompra);
  document.getElementById('campo-controla-estoque-item-compra').addEventListener('change', atualizarVisibilidadeTipoItemCompra);
  document.getElementById('campo-tipo-vinculo-item-compra').addEventListener('change', () => popularOpcoesVinculoItemCompra(null));
  document.getElementById('campo-categoria-item-compra').addEventListener('change', atualizarVisibilidadeVinculoItemCompra);
  document.getElementById('form-item-compra').addEventListener('submit', salvarFormularioItemCompra);
  document.getElementById('botao-fechar-modal-historico-item').addEventListener('click', () => fecharModal('modal-overlay-historico-item'));
  document.getElementById('botao-fechar-historico-item').addEventListener('click', () => fecharModal('modal-overlay-historico-item'));
}

function textoVinculoItemCompra(item) {
  if (item.produtoId) {
    const produto = produtosCache.find((p) => p.id === item.produtoId);
    return produto ? `Produto: ${produto.nome}` : 'Produto (removido)';
  }
  if (item.ingredienteId) {
    const ingrediente = ingredientesCache.find((i) => i.id === item.ingredienteId);
    return ingrediente ? `Ingrediente: ${ingrediente.nome}` : 'Ingrediente (removido)';
  }
  if (item.insumoId) {
    const insumo = insumosCache.find((i) => i.id === item.insumoId);
    return insumo ? `Insumo: ${insumo.nome}` : 'Insumo (removido)';
  }
  return '—';
}

function estoqueECustoDoItem(item) {
  if (!item.controlaEstoque) {
    const cat = categoriaFinanceiraPorId(item.categoriaFinanceiraId);
    return { estoque: 'Despesa', custo: cat ? cat.nome : '—' };
  }
  if (estoqueFicaNoProduto(item)) {
    const produto = produtoDoItem(item);
    const custo = custosProdutosCache.get(produto.id);
    return { estoque: `${numeroTexto(produto.quantidadeEstoque, 0)} un <small>(no produto)</small>`, custo: custo !== null && custo !== undefined ? `${euroPreciso(custo)}/un` : '—' };
  }
  const q = quantidadeParaExibicaoCompra(item.estoque, item.unidadeBase);
  const custo = custoParaExibicaoCompra(item.custoMedio, item.unidadeBase);
  return {
    estoque: `${numeroTexto(q.valor)} ${q.unidade}`,
    custo: custo !== null ? `${euroPreciso(custo)}/${rotuloUnidadeExibicaoCompra(item.unidadeBase)}` : '—',
  };
}

function renderizarTabelaItensCompra() {
  const corpo = document.getElementById('corpo-tabela-itens-compra');
  const vazio = document.getElementById('estado-vazio-itens-compra');
  const busca = normalizarTextoCompra(document.getElementById('filtro-itens-compra-busca').value);
  const categoria = document.getElementById('filtro-itens-compra-categoria').value;
  const tipo = document.getElementById('filtro-itens-compra-tipo').value;

  const pendentes = itensCompraCache.filter((i) => i.needsReview).length;
  const contador = document.getElementById('texto-itens-compra-pendentes-contador');
  contador.textContent = `${pendentes} pendente${pendentes === 1 ? '' : 's'}`;
  contador.style.display = pendentes ? '' : 'none';

  const lista = itensCompraCache.filter((i) => {
    if (categoria && i.categoria !== categoria) return false;
    if (tipo === 'estoque' && !i.controlaEstoque) return false;
    if (tipo === 'despesa' && i.controlaEstoque) return false;
    if (tipo === 'pendentes' && !i.needsReview) return false;
    if (busca) {
      const nomes = [i.nome, ...apelidosCache.filter((a) => a.itemCompraId === i.id).map((a) => a.apelido)];
      if (!nomes.some((n) => (normalizarTextoCompra(n) || '').includes(busca))) return false;
    }
    return true;
  });
  if (!lista.length) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';
  corpo.innerHTML = lista.map((item) => {
    const ec = estoqueECustoDoItem(item);
    const negativo = item.controlaEstoque && !estoqueFicaNoProduto(item) && item.estoque < 0;
    const apelidos = apelidosCache.filter((a) => a.itemCompraId === item.id).length;
    return `
      <tr>
        <td>${esc(item.nome)}${item.needsReview ? ' <span class="compras-badge-pendente">⚠ Revisar</span>' : ''}
          ${apelidos ? `<br><small>${apelidos} nome(s) alternativo(s)</small>` : ''}</td>
        <td>${CATEGORIAS_ITEM_COMPRA[item.categoria] || item.categoria}</td>
        <td class="${negativo ? 'compras-negativo' : ''}">${ec.estoque}</td>
        <td>${ec.custo}</td>
        <td>${esc(textoVinculoItemCompra(item))}</td>
        <td>${item.ativo ? 'Ativo' : 'Inativo'}</td>
        <td class="compras-acoes-linha">
          <button class="btn-icone" data-historico-item="${item.id}" title="Histórico de preços">📈</button>
          <button class="btn-icone" data-editar-item="${item.id}" title="Editar" ${souAdminCompras ? '' : 'disabled'}>✏️</button>
        </td>
      </tr>`;
  }).join('');
  corpo.querySelectorAll('[data-editar-item]').forEach((b) => b.addEventListener('click', () => abrirModalItemCompra(b.dataset.editarItem)));
  corpo.querySelectorAll('[data-historico-item]').forEach((b) => b.addEventListener('click', () => abrirHistoricoItem(b.dataset.historicoItem)));
}

function historicoDePrecosDoItem(item) {
  return linhasComprasCache
    .filter((l) => l.itemCompraId === item.id && l.tipo === 'stock' && l.quantidadeBase)
    .map((l) => {
      const compra = comprasCache.find((c) => c.id === l.compraId);
      if (!compra || compra.status !== 'confirmed') return null;
      const fornecedor = fornecedorPorId(compra.fornecedorId);
      return {
        data: compra.compradoEm,
        compraId: compra.id,
        fornecedor: fornecedor ? fornecedor.nome : '—',
        quantidadeBase: l.quantidadeBase,
        custo: l.custo,
        precoExibicao: custoParaExibicaoCompra(l.custoPorUnidadeBase, item.unidadeBase),
        descricaoNota: l.descricaoNota,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.data < b.data ? 1 : -1));
}

async function abrirHistoricoItem(itemId) {
  const item = itemCompraPorId(itemId);
  if (!item) return;
  document.getElementById('titulo-modal-historico-item').textContent = item.nome;
  const corpo = document.getElementById('corpo-modal-historico-item');
  const ec = estoqueECustoDoItem(item);
  const unidadeExib = rotuloUnidadeExibicaoCompra(item.unidadeBase);
  const historico = item.controlaEstoque ? historicoDePrecosDoItem(item) : [];
  const precos = historico.map((h) => h.precoExibicao).filter((p) => p !== null);
  const comparacao = compararFornecedoresCompra(historico);
  const apelidos = apelidosCache.filter((a) => a.itemCompraId === item.id);

  corpo.innerHTML = `
    <dl class="compras-resumo-grade">
      <div><dt>Estoque</dt><dd>${ec.estoque}</dd></div>
      <div><dt>${item.controlaEstoque ? 'Custo médio' : 'Categoria'}</dt><dd>${ec.custo}</dd></div>
      ${precos.length ? `
      <div><dt>Último preço</dt><dd>${euroPreciso(precos[0])}/${unidadeExib}</dd></div>
      <div><dt>Menor / maior</dt><dd>${euroPreciso(Math.min(...precos))} / ${euroPreciso(Math.max(...precos))}</dd></div>` : ''}
    </dl>
    ${item.controlaEstoque ? `
      <h3 class="compras-subtitulo">Histórico de compras</h3>
      ${historico.length ? `<div class="compras-tabela-wrap"><table class="tabela compras-tabela-compacta">
        <thead><tr><th>Data</th><th>Fornecedor</th><th>Quantidade</th><th>Preço/${unidadeExib}</th><th>Total</th></tr></thead>
        <tbody>${historico.map((h) => {
          const q = quantidadeParaExibicaoCompra(h.quantidadeBase, item.unidadeBase);
          return `<tr><td>${formatarDataCompra(h.data)}</td><td>${esc(h.fornecedor)}</td><td>${numeroTexto(q.valor)} ${q.unidade}</td>
            <td>${euroPreciso(h.precoExibicao)}</td><td>${euro(h.custo)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="dica-campo">Nenhuma compra confirmada deste item ainda.</p>'}
      ${comparacao.length > 1 ? `
        <h3 class="compras-subtitulo">Comparação por fornecedor</h3>
        <div class="compras-tabela-wrap"><table class="tabela compras-tabela-compacta">
          <thead><tr><th>Fornecedor</th><th>Compras</th><th>Preço médio/${unidadeExib}</th><th>Último</th></tr></thead>
          <tbody>${comparacao.map((g, i) => `<tr><td>${esc(g.fornecedor)}${i === 0 ? ' <span class="compras-status compras-status-ok">mais barato</span>' : ''}</td><td>${g.compras}</td>
            <td>${euroPreciso(custoParaExibicaoCompra(g.precoMedioBase, item.unidadeBase))}</td><td>${euroPreciso(g.ultimoPreco)} <small>${formatarDataCompra(g.ultimaData)}</small></td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      ${estoqueFicaNoProduto(item) ? '' : '<h3 class="compras-subtitulo">Movimentações de estoque</h3><div id="movimentos-historico-item"><span class="dica-campo">Carregando…</span></div>'}` : ''}
    <h3 class="compras-subtitulo">Nomes alternativos</h3>
    <p class="dica-campo">Descrições de notas reconhecidas automaticamente como este item.</p>
    <div class="compras-apelidos">${apelidos.length ? apelidos.map((a) => `
      <span class="compras-chip compras-chip-fixo">${esc(a.apelido)}${a.vezesUsado ? ` <small>${a.vezesUsado}×</small>` : ''}
        ${souAdminCompras ? `<button type="button" data-remover-apelido="${a.id}" title="Remover" aria-label="Remover">✕</button>` : ''}</span>`).join('') : '<span class="dica-campo">Nenhum ainda.</span>'}</div>
    ${souAdminCompras ? `<div class="compras-linha-item" style="margin-top:8px;">
      <input type="text" class="input" id="campo-novo-apelido" placeholder="Ex.: Beef Striploin" maxlength="300" />
      <button type="button" class="btn btn-secundario btn-pequeno" id="botao-adicionar-apelido">Adicionar</button>
    </div><p class="compras-erro" id="dica-apelido-erro" style="display:none;"></p>` : ''}`;
  abrirModal('modal-overlay-historico-item');

  corpo.querySelectorAll('[data-remover-apelido]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await excluirApelidoItemCompraNoSupabase(b.dataset.removerApelido);
      apelidosCache = apelidosCache.filter((a) => a.id !== b.dataset.removerApelido);
      abrirHistoricoItem(itemId);
      renderizarTabelaItensCompra();
    } catch (erro) {
      mostrarToast(erro.message, 'erro');
    }
  }));
  const botaoApelido = document.getElementById('botao-adicionar-apelido');
  if (botaoApelido) {
    botaoApelido.addEventListener('click', async () => {
      const campo = document.getElementById('campo-novo-apelido');
      const dica = document.getElementById('dica-apelido-erro');
      try {
        const novo = await salvarApelidoItemCompraNoSupabase(itemId, campo.value);
        apelidosCache = [...apelidosCache.filter((a) => a.id !== novo.id), novo];
        abrirHistoricoItem(itemId);
        renderizarTabelaItensCompra();
      } catch (erro) {
        dica.textContent = erro.message;
        dica.style.display = '';
      }
    });
  }

  const alvoMov = document.getElementById('movimentos-historico-item');
  if (alvoMov) {
    try {
      const movs = await buscarMovimentosEstoqueItemDoSupabase(itemId);
      const rotulos = { purchase_in: 'Entrada por compra', purchase_reversal: 'Estorno de compra', production_out: 'Saída para produção', production_reversal: 'Estorno de produção', adjustment_in: 'Ajuste (entrada)', adjustment_out: 'Ajuste (saída)', waste: 'Perda' };
      alvoMov.innerHTML = movs.length ? `<div class="compras-tabela-wrap"><table class="tabela compras-tabela-compacta">
        <thead><tr><th>Quando</th><th>Movimento</th><th>Qtd.</th><th>Saldo</th><th>Custo médio</th></tr></thead>
        <tbody>${movs.slice(0, 30).map((m) => {
          const q = quantidadeParaExibicaoCompra(m.quantidade, item.unidadeBase);
          const s = quantidadeParaExibicaoCompra(m.saldoDepois, item.unidadeBase);
          return `<tr><td>${formatarData(m.criadoEm)}</td><td>${rotulos[m.tipo] || m.tipo}${m.motivo ? `<br><small>${esc(m.motivo)}</small>` : ''}</td>
            <td>${m.quantidade > 0 ? '+' : ''}${numeroTexto(q.valor)} ${q.unidade}</td><td>${numeroTexto(s.valor)} ${s.unidade}</td>
            <td>${euroPreciso(custoParaExibicaoCompra(m.custoMedioAntes, item.unidadeBase))} → ${euroPreciso(custoParaExibicaoCompra(m.custoMedioDepois, item.unidadeBase))}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="dica-campo">Sem movimentações.</p>';
    } catch (erro) {
      alvoMov.innerHTML = `<p class="dica-campo">Não foi possível carregar. ${esc(erro.message)}</p>`;
    }
  }
}

// --------------------------------------------------------------------- modal de item

function atualizarVisibilidadeTipoItemCompra() {
  const controla = document.getElementById('campo-controla-estoque-item-compra').value === 'true';
  document.getElementById('grupo-unidade-base-item-compra').style.display = controla ? '' : 'none';
  document.getElementById('campo-unidade-base-item-compra').required = controla;
  document.getElementById('grupo-categoria-financeira-item-compra').style.display = controla ? 'none' : '';
  document.getElementById('grupo-tipo-vinculo-item-compra').style.display = controla ? '' : 'none';
  if (!controla) {
    document.getElementById('grupo-referencia-vinculo-item-compra').style.display = 'none';
    document.getElementById('dica-vinculo-supply-auto').style.display = 'none';
    document.getElementById('grupo-vinculo-supply-existente').style.display = 'none';
    document.getElementById('grupo-categoria-ingrediente-item-compra').style.display = 'none';
  } else {
    popularOpcoesVinculoItemCompra(document.getElementById('campo-referencia-vinculo-item-compra').value || null);
    atualizarVisibilidadeVinculoItemCompra();
  }
}

function popularOpcoesVinculoItemCompra(vinculoAtual) {
  const tipo = document.getElementById('campo-tipo-vinculo-item-compra').value;
  const grupo = document.getElementById('grupo-referencia-vinculo-item-compra');
  const select = document.getElementById('campo-referencia-vinculo-item-compra');
  if (!tipo) {
    grupo.style.display = 'none';
    select.innerHTML = '';
    return;
  }
  grupo.style.display = '';
  const todos = tipo === 'product' ? produtosCache : tipo === 'ingredient' ? ingredientesCache : insumosCache;
  const ativos = tipo === 'product' ? todos.filter((p) => p.status === 'ativo') : todos.filter((i) => i.ativo);
  const ordenados = [...ativos].sort((a, b) => a.nome.localeCompare(b.nome));
  let opcoesHtml = ordenados.map((o) => `<option value="${o.id}">${esc(o.nome)}${tipo === 'product' && o.stockMode !== 'purchased' ? ' (não é de revenda)' : ''}</option>`).join('');
  if (vinculoAtual && !ordenados.some((o) => o.id === vinculoAtual)) {
    const achado = todos.find((o) => o.id === vinculoAtual);
    opcoesHtml += `<option value="${vinculoAtual}">${esc(achado ? `${achado.nome} (inativo)` : '(removido)')}</option>`;
  }
  select.innerHTML = opcoesHtml;
  select.value = vinculoAtual || (ordenados[0] ? ordenados[0].id : '');
}

/** Insumo/Embalagem e Ingrediente criam o vínculo automaticamente no servidor (save_purchase_item). */
function atualizarVisibilidadeVinculoItemCompra() {
  const controla = document.getElementById('campo-controla-estoque-item-compra').value === 'true';
  const categoria = document.getElementById('campo-categoria-item-compra').value;
  const id = document.getElementById('campo-id-item-compra').value;
  const itemAtual = id ? itemCompraPorId(id) : null;
  const elegivelSupply = categoria === 'supply' || categoria === 'packaging';
  const elegivelIngredient = categoria === 'ingredient';
  const jaVinculadoSupply = elegivelSupply && !!(itemAtual && itemAtual.insumoId);
  const jaVinculadoIngredient = elegivelIngredient && !!(itemAtual && itemAtual.ingredienteId);
  const jaVinculado = jaVinculadoSupply || jaVinculadoIngredient;

  const grupoTipo = document.getElementById('grupo-tipo-vinculo-item-compra');
  const dicaAuto = document.getElementById('dica-vinculo-supply-auto');
  const grupoExistente = document.getElementById('grupo-vinculo-supply-existente');
  const textoExistente = document.getElementById('texto-vinculo-supply-existente');

  if (!controla) {
    document.getElementById('grupo-categoria-ingrediente-item-compra').style.display = 'none';
    return;
  }
  if (jaVinculado) {
    grupoTipo.style.display = 'none';
    document.getElementById('grupo-referencia-vinculo-item-compra').style.display = 'none';
    dicaAuto.style.display = 'none';
    grupoExistente.style.display = '';
    if (jaVinculadoSupply) {
      const insumo = insumosCache.find((i) => i.id === itemAtual.insumoId);
      textoExistente.textContent = insumo ? insumo.nome : '(insumo removido)';
    } else {
      const ingrediente = ingredientesCache.find((i) => i.id === itemAtual.ingredienteId);
      textoExistente.textContent = ingrediente ? ingrediente.nome : '(ingrediente removido)';
    }
  } else {
    grupoTipo.style.display = '';
    grupoExistente.style.display = 'none';
    dicaAuto.style.display = elegivelSupply || elegivelIngredient ? '' : 'none';
    dicaAuto.textContent = elegivelIngredient
      ? 'Sem vínculo escolhido, um Ingrediente é criado e vinculado ao salvar — a ficha técnica passa a usar o custo médio das compras.'
      : 'Sem vínculo escolhido, um Insumo de Produção é criado e vinculado ao salvar.';
  }
  document.getElementById('grupo-categoria-ingrediente-item-compra').style.display = elegivelIngredient ? '' : 'none';
}

function abrirModalNovoItemCompra(nomeSugerido) {
  if (!souAdminCompras) return;
  document.getElementById('titulo-modal-item-compra').textContent = 'Novo Item';
  document.getElementById('campo-id-item-compra').value = '';
  document.getElementById('campo-nome-item-compra').value = nomeSugerido || '';
  document.getElementById('campo-categoria-item-compra').value = 'ingredient';
  document.getElementById('campo-controla-estoque-item-compra').value = 'true';
  document.getElementById('campo-unidade-base-item-compra').value = '';
  document.getElementById('campo-tipo-vinculo-item-compra').value = '';
  document.getElementById('campo-categoria-ingrediente-item-compra').value = '';
  document.getElementById('campo-categoria-financeira-item-compra').innerHTML = opcoesCategoriasDespesa(null);
  document.getElementById('campo-status-item-compra').value = 'ativo';
  document.getElementById('dica-item-compra-erro').style.display = 'none';
  document.getElementById('dica-item-compra-pendente').style.display = 'none';
  document.getElementById('campo-unidade-base-item-compra').disabled = false;
  popularOpcoesVinculoItemCompra(null);
  atualizarVisibilidadeTipoItemCompra();
  abrirModal('modal-overlay-item-compra');
  document.getElementById('campo-nome-item-compra').focus();
}

function abrirModalItemCompra(id) {
  if (!souAdminCompras) return;
  const item = itemCompraPorId(id);
  if (!item) return;
  uidLinhaAguardandoNovoItem = null;
  document.getElementById('titulo-modal-item-compra').textContent = item.needsReview ? 'Revisar Item' : 'Editar Item';
  document.getElementById('campo-id-item-compra').value = item.id;
  document.getElementById('campo-nome-item-compra').value = item.nome;
  document.getElementById('campo-categoria-item-compra').value = item.categoria;
  document.getElementById('campo-controla-estoque-item-compra').value = item.controlaEstoque ? 'true' : 'false';
  document.getElementById('campo-unidade-base-item-compra').value = item.unidadeBase || '';
  // Unidade não muda depois que o item já teve movimentação (o banco também bloqueia).
  document.getElementById('campo-unidade-base-item-compra').disabled = item.estoque !== 0 || linhasComprasCache.some((l) => l.itemCompraId === item.id && l.tipo === 'stock');
  document.getElementById('campo-categoria-financeira-item-compra').innerHTML = opcoesCategoriasDespesa(item.categoriaFinanceiraId);
  document.getElementById('campo-status-item-compra').value = item.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-item-compra-erro').style.display = 'none';
  document.getElementById('dica-item-compra-pendente').style.display = item.needsReview ? '' : 'none';
  const tipoVinculo = item.produtoId ? 'product' : item.ingredienteId ? 'ingredient' : item.insumoId ? 'supply' : '';
  document.getElementById('campo-tipo-vinculo-item-compra').value = tipoVinculo;
  popularOpcoesVinculoItemCompra(item.produtoId || item.ingredienteId || item.insumoId || null);
  const ingredienteVinculado = item.ingredienteId ? ingredientesCache.find((i) => i.id === item.ingredienteId) : null;
  document.getElementById('campo-categoria-ingrediente-item-compra').value = ingredienteVinculado ? ingredienteVinculado.categoria || '' : '';
  atualizarVisibilidadeTipoItemCompra();
  abrirModal('modal-overlay-item-compra');
}

function fecharModalItemCompra() {
  uidLinhaAguardandoNovoItem = null;
  fecharModal('modal-overlay-item-compra');
}

async function salvarFormularioItemCompra(evento) {
  evento.preventDefault();
  if (!souAdminCompras) return;
  const id = document.getElementById('campo-id-item-compra').value;
  const nome = document.getElementById('campo-nome-item-compra').value.trim();
  const categoria = document.getElementById('campo-categoria-item-compra').value;
  const controlaEstoque = document.getElementById('campo-controla-estoque-item-compra').value === 'true';
  const unidadeBase = controlaEstoque ? document.getElementById('campo-unidade-base-item-compra').value || null : null;
  const tipoVinculo = controlaEstoque ? document.getElementById('campo-tipo-vinculo-item-compra').value : '';
  const referenciaVinculo = document.getElementById('campo-referencia-vinculo-item-compra').value || null;
  const ingredienteCategoria = document.getElementById('campo-categoria-ingrediente-item-compra').value || null;
  const categoriaFinanceiraId = document.getElementById('campo-categoria-financeira-item-compra').value || null;
  const ativo = document.getElementById('campo-status-item-compra').value === 'ativo';
  const dicaErro = document.getElementById('dica-item-compra-erro');
  const erro = (m) => { dicaErro.textContent = m; dicaErro.style.display = ''; };

  if (!nome) return erro('Informe o nome do item.');
  if (controlaEstoque && !unidadeBase) return erro('Escolha a unidade de estoque (peso, volume ou unidade).');
  if (controlaEstoque && categoria === 'ingredient' && !ingredienteCategoria) return erro('Selecione a categoria do ingrediente.');
  if (!controlaEstoque && !categoriaFinanceiraId) return erro('Escolha a categoria financeira da despesa.');
  dicaErro.style.display = 'none';

  const itemAtual = id ? itemCompraPorId(id) : null;
  const dados = {
    nome,
    categoria,
    controlaEstoque,
    unidadeBase: controlaEstoque ? unidadeBase : null,
    ativo,
    produtoId: tipoVinculo === 'product' ? referenciaVinculo : null,
    ingredienteId: tipoVinculo === 'ingredient' ? referenciaVinculo : itemAtual && categoria === 'ingredient' ? itemAtual.ingredienteId : null,
    insumoId: tipoVinculo === 'supply' ? referenciaVinculo : itemAtual && (categoria === 'supply' || categoria === 'packaging') ? itemAtual.insumoId : null,
    ingredienteCategoria: controlaEstoque && categoria === 'ingredient' ? ingredienteCategoria : null,
  };

  const botao = document.getElementById('botao-salvar-item-compra');
  botao.disabled = true;
  let salvo;
  try {
    salvo = id ? await atualizarItemCompraNoSupabase(id, dados) : await criarItemCompraNoSupabase(dados);
    if (!controlaEstoque) salvo = await definirCategoriaFinanceiraItemNoSupabase(salvo.id, categoriaFinanceiraId);
    else if (salvo.needsReview) salvo = await marcarItemCompraRevisadoNoSupabase(salvo.id);
  } catch (e) {
    botao.disabled = false;
    return erro('Não foi possível salvar o item. ' + e.message);
  }
  botao.disabled = false;

  const uid = uidLinhaAguardandoNovoItem;
  fecharModalItemCompra();
  mostrarToast('Item salvo.', 'sucesso');
  await recarregarDepoisDeGravar();
  if (uid) {
    const linha = linhaPorUid(uid);
    if (linha) {
      associarItemNaLinha(linha, itemCompraPorId(salvo.id), 'manual');
      salvarRascunhoLocal();
    }
  }
  renderizarLinhasRascunho();
}

// ===================================================================== FORNECEDORES

function ligarEventosFornecedores() {
  document.getElementById('botao-novo-fornecedor').disabled = !souAdminCompras;
  document.getElementById('dica-fornecedores-somente-admin').style.display = souAdminCompras ? 'none' : '';
  document.getElementById('botao-novo-fornecedor').addEventListener('click', () => abrirModalFornecedor(null));
  document.getElementById('botao-fechar-modal-fornecedor').addEventListener('click', () => fecharModal('modal-overlay-fornecedor'));
  document.getElementById('botao-cancelar-fornecedor').addEventListener('click', () => fecharModal('modal-overlay-fornecedor'));
  document.getElementById('form-fornecedor').addEventListener('submit', salvarFormularioFornecedor);
}

function renderizarTabelaFornecedores() {
  const corpo = document.getElementById('corpo-tabela-fornecedores');
  const vazio = document.getElementById('estado-vazio-fornecedores');
  if (!fornecedoresCache.length) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';
  corpo.innerHTML = fornecedoresCache.map((f) => `
    <tr>
      <td>${esc(f.nome)}</td>
      <td>${esc(f.nomeContato || '—')}</td>
      <td>${esc(f.telefone || '—')}</td>
      <td>${esc(f.email || '—')}</td>
      <td>${f.ativo ? 'Ativo' : 'Inativo'}</td>
      <td><button class="btn-icone" data-editar-fornecedor="${f.id}" title="Editar" ${souAdminCompras ? '' : 'disabled'}>✏️</button></td>
    </tr>`).join('');
  corpo.querySelectorAll('[data-editar-fornecedor]').forEach((b) => b.addEventListener('click', () => abrirModalFornecedor(b.dataset.editarFornecedor)));
}

function abrirModalFornecedor(id) {
  if (!souAdminCompras) return;
  const f = id ? fornecedorPorId(id) : null;
  document.getElementById('titulo-modal-fornecedor').textContent = f ? 'Editar Fornecedor' : 'Novo Fornecedor';
  document.getElementById('campo-id-fornecedor').value = f ? f.id : '';
  document.getElementById('campo-nome-fornecedor').value = f ? f.nome : '';
  document.getElementById('campo-contato-fornecedor').value = f ? f.nomeContato || '' : '';
  document.getElementById('campo-telefone-fornecedor').value = f ? f.telefone || '' : '';
  document.getElementById('campo-email-fornecedor').value = f ? f.email || '' : '';
  document.getElementById('campo-observacoes-fornecedor').value = f ? f.observacoes || '' : '';
  document.getElementById('campo-status-fornecedor').value = !f || f.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-fornecedor-erro').style.display = 'none';
  abrirModal('modal-overlay-fornecedor');
}

async function salvarFormularioFornecedor(evento) {
  evento.preventDefault();
  if (!souAdminCompras) return;
  const id = document.getElementById('campo-id-fornecedor').value;
  const nome = document.getElementById('campo-nome-fornecedor').value.trim();
  const dica = document.getElementById('dica-fornecedor-erro');
  if (!nome) {
    dica.textContent = 'Informe o nome do fornecedor.';
    dica.style.display = '';
    return;
  }
  const duplicado = fornecedoresCache.find((f) => f.id !== id && normalizarTextoCompra(f.nome) === normalizarTextoCompra(nome));
  if (duplicado) {
    dica.textContent = `Já existe o fornecedor "${duplicado.nome}".`;
    dica.style.display = '';
    return;
  }
  const dados = {
    nome,
    nomeContato: document.getElementById('campo-contato-fornecedor').value.trim() || null,
    telefone: document.getElementById('campo-telefone-fornecedor').value.trim() || null,
    email: document.getElementById('campo-email-fornecedor').value.trim() || null,
    observacoes: document.getElementById('campo-observacoes-fornecedor').value.trim() || null,
    ativo: document.getElementById('campo-status-fornecedor').value === 'ativo',
  };
  try {
    if (id) await atualizarFornecedorNoSupabase(id, dados);
    else await criarFornecedorNoSupabase(dados);
  } catch (erro) {
    dica.textContent = 'Não foi possível salvar o fornecedor. ' + erro.message;
    dica.style.display = '';
    return;
  }
  fecharModal('modal-overlay-fornecedor');
  mostrarToast('Fornecedor salvo.', 'sucesso');
  await recarregarDepoisDeGravar();
}
