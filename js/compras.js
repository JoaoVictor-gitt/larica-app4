/*
 * compras.js
 * Lógica da área Compras (Etapa E — UI completa, sem consumo de lote
 * ainda). Cinco seções: Itens de Compra (purchase_items, cadastro
 * simples), Fornecedores (suppliers, cadastro simples), Registrar Compra
 * (cabeçalho+linhas, salva via save_purchase — a única porta de escrita,
 * nunca INSERT/UPDATE direto), Lotes em Estoque (só leitura, lots) e
 * Histórico de Compras (só leitura, purchases+purchase_lines+lots
 * agrupados em memória). Nenhuma tela desta página consome/baixa lote —
 * isso é uma etapa futura separada (Produção/Pedidos). Depende de
 * utils.js, js/services/purchases-service.js,
 * js/services/products-service.js, js/services/ingredients-service.js,
 * js/services/production-supplies-service.js.
 *
 * Edição de compra: uma compra só tem suas linhas/data editáveis enquanto
 * nenhum lote dela tiver movimento além do 'purchase' inicial
 * (compraTemConsumoReal, calculada só sobre os caches já carregados,
 * nunca uma consulta nova) — mesma regra já implementada em
 * save_purchase (Etapa D); a UI só espelha isso pra travar os campos
 * antes mesmo de tentar salvar, mas o banco continua a barreira real.
 *
 * Modais (Item de Compra / Fornecedor) NÃO fecham ao clicar fora — mesmo
 * estado final já corrigido em Produção (nenhum listener de click/
 * mousedown no backdrop).
 */

const FATORES_CONVERSAO_UNIDADE_COMPRA = { g: 1, kg: 1000, ml: 1, l: 1000, un: 1 };
const UNIDADES_COMPRA_POR_BASE = { g: ['g', 'kg'], ml: ['ml', 'l'], un: ['un'] };
const CATEGORIAS_ITEM_COMPRA = {
  ingredient: 'Ingrediente',
  meat: 'Carne',
  beverage: 'Bebida',
  supply: 'Insumo',
  packaging: 'Embalagem',
  cleaning: 'Limpeza',
  other: 'Outros',
};
const ROTULOS_STATUS_LOTE = { available: 'Disponível', depleted: 'Esgotado', archived: 'Arquivado' };

let itensCompraCache = [];
let fornecedoresCache = [];
let comprasCache = [];
let linhasComprasCache = [];
let lotesCache = [];
let movimentosLotesCache = [];
let produtosCache = [];
let ingredientesCache = [];
let insumosCache = [];
let souAdminCompras = false;

let compraEmEdicaoId = null;
let linhasCompraEmEdicao = [];
let compraTemConsumo = false;
let lotesMostrandoHistoricoCompleto = false;

/**
 * Cada seção roda no seu próprio try/catch — uma exceção em qualquer uma
 * nunca impede as seguintes de iniciar (mesma correção já validada em
 * Produção). Ver finalizarSecaoComErro().
 */
document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoCompras();

  try {
    const [itens, fornecedores, compras, linhas, lotes, movimentos, produtos, ingredientes, insumos, ehAdmin] = await Promise.all([
      buscarItensCompraDoSupabase(),
      buscarFornecedoresDoSupabase(),
      buscarComprasDoSupabase(),
      buscarLinhasComprasDoSupabase(),
      buscarLotesDoSupabase(),
      buscarMovimentosLotesDoSupabase(),
      buscarProdutosDoSupabase(),
      buscarIngredientesDoSupabase(),
      buscarInsumosProducaoDoSupabase(),
      usuarioEhAdminNoSupabase(),
    ]);
    itensCompraCache = itens;
    fornecedoresCache = fornecedores;
    comprasCache = compras;
    linhasComprasCache = linhas;
    lotesCache = lotes;
    movimentosLotesCache = movimentos;
    produtosCache = produtos;
    ingredientesCache = ingredientes;
    insumosCache = insumos;
    souAdminCompras = ehAdmin;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar dados iniciais de Compras:', erroCarregamento);
    finalizarSecaoComErro('estado-carregando-itens-compra', 'estado-erro-itens-compra', erroCarregamento);
    finalizarSecaoComErro('estado-carregando-fornecedores', 'estado-erro-fornecedores', erroCarregamento);
    finalizarSecaoComErro('estado-carregando-lotes', 'estado-erro-lotes', erroCarregamento);
    finalizarSecaoComErro('estado-carregando-historico-compras', 'estado-erro-historico-compras', erroCarregamento);
    const dicaRegistrar = document.getElementById('dica-registrar-compra-erro');
    dicaRegistrar.textContent = 'Não foi possível carregar os dados necessários. ' + erroCarregamento.message;
    dicaRegistrar.style.display = '';
    return;
  }

  try {
    atualizarEstadoEdicaoItensCompra();
    renderizarTabelaItensCompra();
    ligarEventosModalItemCompra();
    document.getElementById('estado-carregando-itens-compra').style.display = 'none';
  } catch (erro) {
    console.error('Erro ao preparar Itens de Compra:', erro);
    finalizarSecaoComErro('estado-carregando-itens-compra', 'estado-erro-itens-compra', erro);
  }

  try {
    atualizarEstadoEdicaoFornecedores();
    renderizarTabelaFornecedores();
    ligarEventosModalFornecedor();
    document.getElementById('estado-carregando-fornecedores').style.display = 'none';
  } catch (erro) {
    console.error('Erro ao preparar Fornecedores:', erro);
    finalizarSecaoComErro('estado-carregando-fornecedores', 'estado-erro-fornecedores', erro);
  }

  try {
    popularFiltrosLotes();
    ligarEventosFiltrosLotes();
    renderizarTabelaLotes();
    document.getElementById('estado-carregando-lotes').style.display = 'none';
  } catch (erro) {
    console.error('Erro ao preparar Lotes em Estoque:', erro);
    finalizarSecaoComErro('estado-carregando-lotes', 'estado-erro-lotes', erro);
  }

  try {
    renderizarTabelaHistoricoCompras();
    document.getElementById('estado-carregando-historico-compras').style.display = 'none';
  } catch (erro) {
    console.error('Erro ao preparar Histórico de Compras:', erro);
    finalizarSecaoComErro('estado-carregando-historico-compras', 'estado-erro-historico-compras', erro);
  }

  try {
    ligarEventosRegistrarCompra();
    atualizarEstadoEdicaoRegistrarCompra();
    prepararNovaCompra();
  } catch (erro) {
    console.error('Erro ao preparar Registrar Compra:', erro);
    const dica = document.getElementById('dica-registrar-compra-erro');
    dica.textContent = 'Não foi possível preparar o formulário de compra. ' + erro.message;
    dica.style.display = '';
  }
});

/** Garante que uma seção nunca fique presa em "Carregando..." — mesmo helper já validado em Produção. */
function finalizarSecaoComErro(idCarregando, idErro, erro) {
  const elCarregando = document.getElementById(idCarregando);
  if (elCarregando) elCarregando.style.display = 'none';
  const elErro = document.getElementById(idErro);
  if (elErro) {
    elErro.textContent = 'Não foi possível carregar os dados. ' + (erro && erro.message ? erro.message : '');
    elErro.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Navegação (central de Compras <-> seções, mesmo padrão de Produção)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function formatarQuantidadeCompra(valor) {
  return Number(valor).toLocaleString('pt-PT', { maximumFractionDigits: 3 });
}

/** 6 casas g/ml, 4 casas un — mesma disciplina de precisão já usada em Produção. */
function formatarCustoPorBaseCompra(valor, unidade) {
  if (!Number.isFinite(valor)) return '—';
  const casas = unidade === 'g' || unidade === 'ml' ? 6 : 4;
  return '€' + valor.toFixed(casas).replace('.', ',') + '/' + unidade;
}

/** 'YYYY-MM-DD' -> 'DD/MM/AAAA', sem passar por Date/fuso — purchased_at/received_at/expiration_date são date puro. */
function formatarDataCompra(dataIso) {
  if (!dataIso) return '';
  const partes = dataIso.split('-');
  if (partes.length !== 3) return dataIso;
  const [ano, mes, dia] = partes;
  return `${dia}/${mes}/${ano}`;
}

/** Data de hoje no fuso do navegador local, como 'YYYY-MM-DD' — nunca toISOString() (UTC). */
function dataHojeLocal() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// ---------------------------------------------------------------------------
// ITENS DE COMPRA — purchase_items, cadastro simples (GRANT direto, sem RPC)
// ---------------------------------------------------------------------------

function atualizarEstadoEdicaoItensCompra() {
  document.getElementById('botao-novo-item-compra').disabled = !souAdminCompras;
  document.getElementById('dica-itens-compra-somente-admin').style.display = souAdminCompras ? 'none' : '';
}

function itemCompraPorId(id) {
  return itensCompraCache.find((i) => i.id === id);
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

function renderizarTabelaItensCompra() {
  const corpo = document.getElementById('corpo-tabela-itens-compra');
  const vazio = document.getElementById('estado-vazio-itens-compra');

  if (itensCompraCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = itensCompraCache.map(linhaItemCompraHtml).join('');
  corpo.querySelectorAll('[data-acao-editar-item-compra]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalItemCompra(botao.dataset.acaoEditarItemCompra));
  });
}

function linhaItemCompraHtml(item) {
  return `
    <tr>
      <td>${escaparHtml(item.nome)}</td>
      <td>${CATEGORIAS_ITEM_COMPRA[item.categoria] || item.categoria}</td>
      <td>${item.controlaEstoque ? 'Sim' : 'Não'}</td>
      <td>${item.unidadeBase || '—'}</td>
      <td>${textoVinculoItemCompra(item)}</td>
      <td>${item.ativo ? 'Ativo' : 'Inativo'}</td>
      <td>
        <button class="btn-icone" data-acao-editar-item-compra="${item.id}" title="Editar" ${souAdminCompras ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

function ligarEventosModalItemCompra() {
  document.getElementById('botao-novo-item-compra').addEventListener('click', abrirModalNovoItemCompra);
  document.getElementById('botao-fechar-modal-item-compra').addEventListener('click', fecharModalItemCompra);
  document.getElementById('botao-cancelar-item-compra').addEventListener('click', fecharModalItemCompra);
  document.getElementById('campo-controla-estoque-item-compra').addEventListener('change', atualizarVisibilidadeUnidadeBaseItemCompra);
  document.getElementById('campo-tipo-vinculo-item-compra').addEventListener('change', () => popularOpcoesVinculoItemCompra(null));
  document.getElementById('form-item-compra').addEventListener('submit', salvarFormularioItemCompra);
}

function atualizarVisibilidadeUnidadeBaseItemCompra() {
  const controla = document.getElementById('campo-controla-estoque-item-compra').value === 'true';
  document.getElementById('campo-unidade-base-item-compra').required = controla;
}

/** vinculoAtual (id) preserva a seleção ao editar um item já vinculado — mesmo padrão de "opção extra" já usado em Produção pra itens inativos/fora de filtro. */
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
  const ativos =
    tipo === 'product'
      ? todos.filter((p) => p.status === 'ativo')
      : todos.filter((i) => i.ativo);
  const ordenados = [...ativos].sort((a, b) => a.nome.localeCompare(b.nome));

  let opcoesHtml = ordenados.map((o) => `<option value="${o.id}">${escaparHtml(o.nome)}</option>`).join('');

  if (vinculoAtual && !ordenados.some((o) => o.id === vinculoAtual)) {
    const achado = todos.find((o) => o.id === vinculoAtual);
    const nomeAtual = achado ? `${achado.nome} (inativo)` : '(removido)';
    opcoesHtml += `<option value="${vinculoAtual}">${escaparHtml(nomeAtual)}</option>`;
  }

  select.innerHTML = opcoesHtml;
  select.value = vinculoAtual || '';
}

function abrirModalNovoItemCompra() {
  if (!souAdminCompras) return;

  document.getElementById('titulo-modal-item-compra').textContent = 'Novo Item de Compra';
  document.getElementById('campo-id-item-compra').value = '';
  document.getElementById('campo-nome-item-compra').value = '';
  document.getElementById('campo-categoria-item-compra').value = 'ingredient';
  document.getElementById('campo-controla-estoque-item-compra').value = 'true';
  document.getElementById('campo-unidade-base-item-compra').value = '';
  document.getElementById('campo-tipo-vinculo-item-compra').value = '';
  document.getElementById('campo-status-item-compra').value = 'ativo';
  document.getElementById('dica-item-compra-erro').style.display = 'none';

  atualizarVisibilidadeUnidadeBaseItemCompra();
  popularOpcoesVinculoItemCompra(null);
  abrirModal('modal-overlay-item-compra');
}

function abrirModalItemCompra(id) {
  if (!souAdminCompras) return;
  const item = itemCompraPorId(id);
  if (!item) return;

  document.getElementById('titulo-modal-item-compra').textContent = 'Editar Item de Compra';
  document.getElementById('campo-id-item-compra').value = item.id;
  document.getElementById('campo-nome-item-compra').value = item.nome;
  document.getElementById('campo-categoria-item-compra').value = item.categoria;
  document.getElementById('campo-controla-estoque-item-compra').value = item.controlaEstoque ? 'true' : 'false';
  document.getElementById('campo-unidade-base-item-compra').value = item.unidadeBase || '';
  document.getElementById('campo-status-item-compra').value = item.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-item-compra-erro').style.display = 'none';

  atualizarVisibilidadeUnidadeBaseItemCompra();

  const tipoVinculo = item.produtoId ? 'product' : item.ingredienteId ? 'ingredient' : item.insumoId ? 'supply' : '';
  const vinculoId = item.produtoId || item.ingredienteId || item.insumoId || null;
  document.getElementById('campo-tipo-vinculo-item-compra').value = tipoVinculo;
  popularOpcoesVinculoItemCompra(vinculoId);

  abrirModal('modal-overlay-item-compra');
}

function fecharModalItemCompra() {
  fecharModal('modal-overlay-item-compra');
}

async function salvarFormularioItemCompra(evento) {
  evento.preventDefault();
  if (!souAdminCompras) return;

  const id = document.getElementById('campo-id-item-compra').value;
  const nome = document.getElementById('campo-nome-item-compra').value.trim();
  const categoria = document.getElementById('campo-categoria-item-compra').value;
  const controlaEstoque = document.getElementById('campo-controla-estoque-item-compra').value === 'true';
  const unidadeBase = document.getElementById('campo-unidade-base-item-compra').value || null;
  const tipoVinculo = document.getElementById('campo-tipo-vinculo-item-compra').value;
  const referenciaVinculo = document.getElementById('campo-referencia-vinculo-item-compra').value || null;
  const ativo = document.getElementById('campo-status-item-compra').value === 'ativo';

  const dicaErro = document.getElementById('dica-item-compra-erro');

  if (!nome) {
    dicaErro.textContent = 'Informe o nome do item.';
    dicaErro.style.display = '';
    return;
  }
  if (controlaEstoque && !unidadeBase) {
    dicaErro.textContent = 'Selecione a unidade-base — obrigatória quando o item controla estoque.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const dados = {
    nome,
    categoria,
    controlaEstoque,
    unidadeBase,
    ativo,
    produtoId: tipoVinculo === 'product' ? referenciaVinculo : null,
    ingredienteId: tipoVinculo === 'ingredient' ? referenciaVinculo : null,
    insumoId: tipoVinculo === 'supply' ? referenciaVinculo : null,
  };

  try {
    if (id) {
      const atualizado = await atualizarItemCompraNoSupabase(id, dados);
      itensCompraCache = itensCompraCache.map((i) => (i.id === id ? atualizado : i));
    } else {
      const criado = await criarItemCompraNoSupabase(dados);
      itensCompraCache = [...itensCompraCache, criado];
    }
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar o item. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  mostrarToast('Item de compra salvo.', 'sucesso');
  fecharModalItemCompra();
  renderizarTabelaItensCompra();
  popularFiltrosLotes();
  if (document.getElementById('campo-item-linha-compra')) popularOpcoesItemLinhaCompra();
}

// ---------------------------------------------------------------------------
// FORNECEDORES — suppliers, cadastro simples (GRANT direto, sem RPC)
// ---------------------------------------------------------------------------

function atualizarEstadoEdicaoFornecedores() {
  document.getElementById('botao-novo-fornecedor').disabled = !souAdminCompras;
  document.getElementById('dica-fornecedores-somente-admin').style.display = souAdminCompras ? 'none' : '';
}

function fornecedorPorId(id) {
  return fornecedoresCache.find((f) => f.id === id);
}

function renderizarTabelaFornecedores() {
  const corpo = document.getElementById('corpo-tabela-fornecedores');
  const vazio = document.getElementById('estado-vazio-fornecedores');

  if (fornecedoresCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = fornecedoresCache.map(linhaFornecedorHtml).join('');
  corpo.querySelectorAll('[data-acao-editar-fornecedor]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalFornecedor(botao.dataset.acaoEditarFornecedor));
  });
}

function linhaFornecedorHtml(fornecedor) {
  return `
    <tr>
      <td>${escaparHtml(fornecedor.nome)}</td>
      <td>${escaparHtml(fornecedor.nomeContato || '—')}</td>
      <td>${escaparHtml(fornecedor.telefone || '—')}</td>
      <td>${escaparHtml(fornecedor.email || '—')}</td>
      <td>${fornecedor.ativo ? 'Ativo' : 'Inativo'}</td>
      <td>
        <button class="btn-icone" data-acao-editar-fornecedor="${fornecedor.id}" title="Editar" ${souAdminCompras ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

function ligarEventosModalFornecedor() {
  document.getElementById('botao-novo-fornecedor').addEventListener('click', abrirModalNovoFornecedor);
  document.getElementById('botao-fechar-modal-fornecedor').addEventListener('click', fecharModalFornecedor);
  document.getElementById('botao-cancelar-fornecedor').addEventListener('click', fecharModalFornecedor);
  document.getElementById('form-fornecedor').addEventListener('submit', salvarFormularioFornecedor);
}

function abrirModalNovoFornecedor() {
  if (!souAdminCompras) return;

  document.getElementById('titulo-modal-fornecedor').textContent = 'Novo Fornecedor';
  document.getElementById('campo-id-fornecedor').value = '';
  document.getElementById('campo-nome-fornecedor').value = '';
  document.getElementById('campo-contato-fornecedor').value = '';
  document.getElementById('campo-telefone-fornecedor').value = '';
  document.getElementById('campo-email-fornecedor').value = '';
  document.getElementById('campo-observacoes-fornecedor').value = '';
  document.getElementById('campo-status-fornecedor').value = 'ativo';
  document.getElementById('dica-fornecedor-erro').style.display = 'none';
  abrirModal('modal-overlay-fornecedor');
}

function abrirModalFornecedor(id) {
  if (!souAdminCompras) return;
  const fornecedor = fornecedorPorId(id);
  if (!fornecedor) return;

  document.getElementById('titulo-modal-fornecedor').textContent = 'Editar Fornecedor';
  document.getElementById('campo-id-fornecedor').value = fornecedor.id;
  document.getElementById('campo-nome-fornecedor').value = fornecedor.nome;
  document.getElementById('campo-contato-fornecedor').value = fornecedor.nomeContato || '';
  document.getElementById('campo-telefone-fornecedor').value = fornecedor.telefone || '';
  document.getElementById('campo-email-fornecedor').value = fornecedor.email || '';
  document.getElementById('campo-observacoes-fornecedor').value = fornecedor.observacoes || '';
  document.getElementById('campo-status-fornecedor').value = fornecedor.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-fornecedor-erro').style.display = 'none';
  abrirModal('modal-overlay-fornecedor');
}

function fecharModalFornecedor() {
  fecharModal('modal-overlay-fornecedor');
}

async function salvarFormularioFornecedor(evento) {
  evento.preventDefault();
  if (!souAdminCompras) return;

  const id = document.getElementById('campo-id-fornecedor').value;
  const nome = document.getElementById('campo-nome-fornecedor').value.trim();
  const dicaErro = document.getElementById('dica-fornecedor-erro');

  if (!nome) {
    dicaErro.textContent = 'Informe o nome do fornecedor.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const dados = {
    nome,
    nomeContato: document.getElementById('campo-contato-fornecedor').value.trim() || null,
    telefone: document.getElementById('campo-telefone-fornecedor').value.trim() || null,
    email: document.getElementById('campo-email-fornecedor').value.trim() || null,
    observacoes: document.getElementById('campo-observacoes-fornecedor').value.trim() || null,
    ativo: document.getElementById('campo-status-fornecedor').value === 'ativo',
  };

  try {
    if (id) {
      const atualizado = await atualizarFornecedorNoSupabase(id, dados);
      fornecedoresCache = fornecedoresCache.map((f) => (f.id === id ? atualizado : f));
    } else {
      const criado = await criarFornecedorNoSupabase(dados);
      fornecedoresCache = [...fornecedoresCache, criado];
    }
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar o fornecedor. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  mostrarToast('Fornecedor salvo.', 'sucesso');
  fecharModalFornecedor();
  renderizarTabelaFornecedores();
  if (document.getElementById('campo-fornecedor-compra')) popularOpcoesFornecedorCompra();
}

// ---------------------------------------------------------------------------
// LOTES EM ESTOQUE — só leitura (lots). Zero consumo/ajuste nesta etapa.
// ---------------------------------------------------------------------------

function calcularValorRestanteLote(lote) {
  return lote.quantidadeRestante * lote.custoPorUnidadeBase;
}

function popularFiltrosLotes() {
  const selectCategoria = document.getElementById('filtro-lotes-categoria');
  const categoriaAtual = selectCategoria.value;
  const categorias = [...new Set(itensCompraCache.map((i) => i.categoria))];
  selectCategoria.innerHTML =
    '<option value="">Todas</option>' + categorias.map((c) => `<option value="${c}">${CATEGORIAS_ITEM_COMPRA[c] || c}</option>`).join('');
  selectCategoria.value = categoriaAtual;

  const selectItem = document.getElementById('filtro-lotes-item');
  const itemAtual = selectItem.value;
  const itensComEstoque = itensCompraCache.filter((i) => i.controlaEstoque).sort((a, b) => a.nome.localeCompare(b.nome));
  selectItem.innerHTML = '<option value="">Todos</option>' + itensComEstoque.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
  selectItem.value = itemAtual;
}

function ligarEventosFiltrosLotes() {
  document.getElementById('filtro-lotes-categoria').addEventListener('change', renderizarTabelaLotes);
  document.getElementById('filtro-lotes-status').addEventListener('change', renderizarTabelaLotes);
  document.getElementById('filtro-lotes-item').addEventListener('change', renderizarTabelaLotes);
  document.getElementById('botao-lotes-ver-historico-completo').addEventListener('click', () => {
    lotesMostrandoHistoricoCompleto = !lotesMostrandoHistoricoCompleto;
    document.getElementById('botao-lotes-ver-historico-completo').textContent = lotesMostrandoHistoricoCompleto
      ? 'Ver só ativos'
      : 'Ver histórico completo';
    renderizarTabelaLotes();
  });
}

/** Só aviso visual (⚠ Vencido / ⚠ Vence em X dias) — sem nenhuma regra de bloqueio automático, conforme pedido. */
function textoValidadeLote(lote) {
  if (!lote.validade) return '—';
  const dataTexto = formatarDataCompra(lote.validade);
  const diffDias = Math.floor((new Date(lote.validade + 'T00:00:00') - new Date(dataHojeLocal() + 'T00:00:00')) / 86400000);
  if (diffDias < 0) return `${dataTexto} ⚠ Vencido`;
  if (diffDias <= 7) return `${dataTexto} ⚠ Vence em ${diffDias} dia${diffDias === 1 ? '' : 's'}`;
  return dataTexto;
}

/**
 * Visão principal (sem "Ver histórico completo" e sem filtro de status
 * explícito): todos os available + só os 5 depleted mais recentes;
 * archived nunca aparece. Regra só de UI — nenhum dado é apagado, o
 * histórico completo continua uma consulta/clique de distância.
 */
function renderizarTabelaLotes() {
  const corpo = document.getElementById('corpo-tabela-lotes');
  const vazio = document.getElementById('estado-vazio-lotes');

  const categoriaFiltro = document.getElementById('filtro-lotes-categoria').value;
  const statusFiltro = document.getElementById('filtro-lotes-status').value;
  const itemFiltro = document.getElementById('filtro-lotes-item').value;

  let lotes = lotesCache.filter((lote) => {
    const item = itemCompraPorId(lote.itemCompraId);
    if (categoriaFiltro && (!item || item.categoria !== categoriaFiltro)) return false;
    if (itemFiltro && lote.itemCompraId !== itemFiltro) return false;
    if (statusFiltro && lote.status !== statusFiltro) return false;
    return true;
  });

  if (!lotesMostrandoHistoricoCompleto) {
    if (statusFiltro) {
      // Filtro explícito de status já decide o que mostrar — sem recorte adicional.
    } else {
      const disponiveis = lotes.filter((l) => l.status === 'available');
      const esgotados = lotes
        .filter((l) => l.status === 'depleted')
        .sort((a, b) => new Date(b.atualizadoEm) - new Date(a.atualizadoEm))
        .slice(0, 5);
      lotes = [...disponiveis, ...esgotados];
    }
  }

  lotes = [...lotes].sort((a, b) => new Date(b.recebidoEm) - new Date(a.recebidoEm));

  if (lotes.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';
  corpo.innerHTML = lotes.map(linhaLoteHtml).join('');
}

function linhaLoteHtml(lote) {
  const item = itemCompraPorId(lote.itemCompraId);
  const nomeItem = item ? item.nome : '(item removido)';

  return `
    <tr>
      <td>${escaparHtml(nomeItem)}</td>
      <td>${formatarDataCompra(lote.recebidoEm)}</td>
      <td>${textoValidadeLote(lote)}</td>
      <td>${formatarQuantidadeCompra(lote.quantidadeInicial)} ${lote.unidadeBase}</td>
      <td>${formatarQuantidadeCompra(lote.quantidadeRestante)} ${lote.unidadeBase}</td>
      <td>${lote.unidadeBase}</td>
      <td>${formatarCustoPorBaseCompra(lote.custoPorUnidadeBase, lote.unidadeBase)}</td>
      <td>${formatarMoeda(calcularValorRestanteLote(lote))}</td>
      <td>${ROTULOS_STATUS_LOTE[lote.status] || lote.status}</td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// HISTÓRICO DE COMPRAS — purchases+purchase_lines+lots agrupados em
// memória, zero N+1.
// ---------------------------------------------------------------------------

function linhasDaCompra(compraId) {
  return linhasComprasCache.filter((l) => l.compraId === compraId);
}

function lotesDaCompra(compraId) {
  const idsLinhas = linhasDaCompra(compraId).map((l) => l.id);
  return lotesCache.filter((lote) => idsLinhas.includes(lote.linhaCompraId));
}

/** Consumo real = qualquer movimento além do 'purchase' inicial, em qualquer lote desta compra — mesma detecção já implementada em save_purchase, aqui só sobre os caches já carregados. */
function compraTemConsumoReal(compraId) {
  const idsLotes = lotesDaCompra(compraId).map((l) => l.id);
  return movimentosLotesCache.some((m) => idsLotes.includes(m.loteId) && m.tipo !== 'purchase');
}

function renderizarTabelaHistoricoCompras() {
  const corpo = document.getElementById('corpo-tabela-historico-compras');
  const vazio = document.getElementById('estado-vazio-historico-compras');

  if (comprasCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = comprasCache.map(linhaHistoricoCompraHtml).join('');
  corpo.querySelectorAll('[data-acao-editar-compra]').forEach((botao) => {
    botao.addEventListener('click', () => abrirCompraParaEdicao(botao.dataset.acaoEditarCompra));
  });
}

function linhaHistoricoCompraHtml(compra) {
  const linhas = linhasDaCompra(compra.id);
  const total = linhas.reduce((soma, l) => soma + l.precoTotal, 0);
  const qtdLotes = lotesDaCompra(compra.id).length;
  const fornecedor = compra.fornecedorId ? fornecedorPorId(compra.fornecedorId) : null;

  return `
    <tr>
      <td>${formatarDataCompra(compra.compradoEm)}</td>
      <td>${fornecedor ? escaparHtml(fornecedor.nome) : '—'}</td>
      <td>${linhas.length}</td>
      <td>${formatarMoeda(total)}</td>
      <td>${qtdLotes}</td>
      <td>${escaparHtml(compra.referencia || '—')}</td>
      <td>
        <button class="btn-icone" data-acao-editar-compra="${compra.id}" title="Editar" ${souAdminCompras ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// REGISTRAR COMPRA — cabeçalho + linhas, salva via save_purchase (única
// porta de escrita). componentesCompraEmEdicao é estado só de memória até
// "Salvar Compra".
// ---------------------------------------------------------------------------

function atualizarEstadoEdicaoRegistrarCompra() {
  document.getElementById('dica-compras-somente-admin').style.display = souAdminCompras ? 'none' : '';
}

function popularOpcoesFornecedorCompra() {
  const select = document.getElementById('campo-fornecedor-compra');
  const atual = select.value;
  const ativos = fornecedoresCache.filter((f) => f.ativo).sort((a, b) => a.nome.localeCompare(b.nome));
  select.innerHTML = '<option value="">— Nenhum —</option>' + ativos.map((f) => `<option value="${f.id}">${escaparHtml(f.nome)}</option>`).join('');
  if (atual && ativos.some((f) => f.id === atual)) select.value = atual;
}

function popularOpcoesItemLinhaCompra() {
  const select = document.getElementById('campo-item-linha-compra');
  const ativos = itensCompraCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));
  select.innerHTML = ativos
    .map((i) => `<option value="${i.id}">${escaparHtml(i.nome)} — ${CATEGORIAS_ITEM_COMPRA[i.categoria] || i.categoria}</option>`)
    .join('');
  atualizarUnidadeLinhaCompra();
}

/**
 * Unidade travada nas opções coerentes com o base_unit do item escolhido
 * (mesma tabela que a RPC save_purchase usa server-side) — quando o item
 * não tem base_unit definido (só possível com tracks_stock=false), trava
 * em 'un' só, exatamente o que a RPC já aceita hoje nesse caso.
 */
function atualizarUnidadeLinhaCompra() {
  const itemId = document.getElementById('campo-item-linha-compra').value;
  const item = itemCompraPorId(itemId);
  const selectUnidade = document.getElementById('campo-unidade-linha-compra');
  const dicaSemBase = document.getElementById('dica-validade-linha-compra');
  const campoValidade = document.getElementById('campo-validade-linha-compra');

  if (!item) {
    selectUnidade.innerHTML = '';
    return;
  }

  const opcoesUnidade = item.unidadeBase ? UNIDADES_COMPRA_POR_BASE[item.unidadeBase] : ['un'];
  selectUnidade.innerHTML = opcoesUnidade.map((u) => `<option value="${u}">${u}</option>`).join('');

  dicaSemBase.style.display = item.unidadeBase ? 'none' : '';
  campoValidade.disabled = compraTemConsumo || !item.controlaEstoque;
  if (!item.controlaEstoque) campoValidade.value = '';
}

/** Mesma tabela de conversão usada server-side em save_purchase — só pra exibição, o banco recalcula de verdade. */
function calcularBaseQuantityPreview(item, quantidade, unidade) {
  if (!item || !Number.isFinite(quantidade) || quantidade <= 0) return null;
  const baseUnit = item.unidadeBase || 'un';
  if (baseUnit === 'g') {
    if (unidade === 'g') return quantidade;
    if (unidade === 'kg') return quantidade * FATORES_CONVERSAO_UNIDADE_COMPRA.kg;
    return null;
  }
  if (baseUnit === 'ml') {
    if (unidade === 'ml') return quantidade;
    if (unidade === 'l') return quantidade * FATORES_CONVERSAO_UNIDADE_COMPRA.l;
    return null;
  }
  return unidade === 'un' ? quantidade : null;
}

function atualizarPreviewLinhaCompra() {
  const preview = document.getElementById('preview-linha-compra');
  const itemId = document.getElementById('campo-item-linha-compra').value;
  const item = itemCompraPorId(itemId);
  const quantidade = Number(document.getElementById('campo-quantidade-linha-compra').value);
  const unidade = document.getElementById('campo-unidade-linha-compra').value;
  const preco = Number(document.getElementById('campo-preco-linha-compra').value);

  if (!item || !Number.isFinite(quantidade) || quantidade <= 0) {
    preview.textContent = '';
    return;
  }
  const baseQuantity = calcularBaseQuantityPreview(item, quantidade, unidade);
  if (baseQuantity === null) {
    preview.textContent = '';
    return;
  }
  const baseUnit = item.unidadeBase || 'un';
  let texto = `${formatarQuantidadeCompra(quantidade)} ${unidade} → ${formatarQuantidadeCompra(baseQuantity)} ${baseUnit}`;

  if (Number.isFinite(preco) && preco >= 0) {
    const custoBase = preco / baseQuantity;
    texto += ` · ${formatarMoeda(preco)} / ${formatarQuantidadeCompra(baseQuantity)}${baseUnit} = ${formatarCustoPorBaseCompra(custoBase, baseUnit)}`;
    if (baseUnit === 'g' || baseUnit === 'ml') {
      const unidadeGrande = baseUnit === 'g' ? 'kg' : 'l';
      texto += ` (${formatarMoeda(custoBase * 1000)}/${unidadeGrande})`;
    }
  }
  preview.textContent = texto;
}

function adicionarLinhaCompra() {
  if (!souAdminCompras || compraTemConsumo) return;
  const dicaErro = document.getElementById('dica-linha-compra-erro');
  const itemId = document.getElementById('campo-item-linha-compra').value;
  const item = itemCompraPorId(itemId);
  const quantidade = Number(document.getElementById('campo-quantidade-linha-compra').value);
  const unidade = document.getElementById('campo-unidade-linha-compra').value;
  const preco = Number(document.getElementById('campo-preco-linha-compra').value);
  const validade = document.getElementById('campo-validade-linha-compra').value || null;

  if (!item) {
    dicaErro.textContent = 'Selecione um item.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    dicaErro.textContent = 'Informe uma quantidade maior que zero.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(preco) || preco < 0) {
    dicaErro.textContent = 'Informe um preço válido (não pode ser negativo).';
    dicaErro.style.display = '';
    return;
  }
  if (validade && !item.controlaEstoque) {
    dicaErro.textContent = 'Item sem controle de estoque não pode ter validade.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  linhasCompraEmEdicao.push({
    linhaId: null,
    itemCompraId: item.id,
    nome: item.nome,
    quantidade,
    unidade,
    precoTotal: preco,
    validade,
  });

  document.getElementById('campo-quantidade-linha-compra').value = '';
  document.getElementById('campo-preco-linha-compra').value = '';
  document.getElementById('campo-validade-linha-compra').value = '';
  document.getElementById('preview-linha-compra').textContent = '';
  renderizarListaLinhasCompra();
}

function renderizarListaLinhasCompra() {
  const lista = document.getElementById('lista-linhas-compra');
  const vazio = document.getElementById('estado-vazio-linhas-compra');

  if (linhasCompraEmEdicao.length === 0) {
    lista.innerHTML = '';
    vazio.style.display = 'block';
  } else {
    vazio.style.display = 'none';
    lista.innerHTML = linhasCompraEmEdicao.map(linhaLinhaCompraHtml).join('');
    lista.querySelectorAll('[data-acao-remover-linha-compra]').forEach((botao) => {
      botao.addEventListener('click', () => removerLinhaCompra(Number(botao.dataset.acaoRemoverLinhaCompra)));
    });
  }

  atualizarTotalCompra();
}

function linhaLinhaCompraHtml(linha) {
  const indice = linhasCompraEmEdicao.indexOf(linha);
  const podeRemover = souAdminCompras && !compraTemConsumo;

  return `
    <div class="compras-linha-linha-compra">
      <span class="compras-linha-linha-compra-nome">${escaparHtml(linha.nome)}</span>
      <span class="compras-linha-linha-compra-quantidade">${formatarQuantidadeCompra(linha.quantidade)} ${linha.unidade}</span>
      <span class="compras-linha-linha-compra-preco">${formatarMoeda(linha.precoTotal)}</span>
      <span class="compras-linha-linha-compra-validade">${linha.validade ? formatarDataCompra(linha.validade) : ''}</span>
      <button type="button" class="btn-icone" data-acao-remover-linha-compra="${indice}" title="Remover" ${podeRemover ? '' : 'disabled'}>🗑️</button>
    </div>`;
}

function removerLinhaCompra(indice) {
  if (!souAdminCompras || compraTemConsumo) return;
  linhasCompraEmEdicao.splice(indice, 1);
  renderizarListaLinhasCompra();
}

function atualizarTotalCompra() {
  const total = linhasCompraEmEdicao.reduce((soma, linha) => soma + linha.precoTotal, 0);
  document.getElementById('texto-total-compra').textContent = formatarMoeda(total);
}

/** Desabilita Data + todo o bloco de linhas quando a compra em edição já teve consumo real — só metadados (fornecedor/referência/observações) continuam editáveis, mesma regra já implementada em save_purchase. */
function aplicarTravaConsumoFormularioCompra() {
  document.getElementById('dica-compra-com-consumo').style.display = compraTemConsumo ? '' : 'none';

  document.getElementById('campo-data-compra').disabled = compraTemConsumo;
  document.getElementById('campo-item-linha-compra').disabled = compraTemConsumo;
  document.getElementById('campo-quantidade-linha-compra').disabled = compraTemConsumo;
  document.getElementById('campo-unidade-linha-compra').disabled = compraTemConsumo;
  document.getElementById('campo-preco-linha-compra').disabled = compraTemConsumo;
  document.getElementById('campo-validade-linha-compra').disabled = compraTemConsumo;
  document.getElementById('botao-adicionar-linha-compra').disabled = compraTemConsumo || !souAdminCompras;
}

function prepararNovaCompra() {
  compraEmEdicaoId = null;
  compraTemConsumo = false;
  linhasCompraEmEdicao = [];

  document.getElementById('titulo-secao-registrar-compra').textContent = 'Registrar Compra';
  popularOpcoesFornecedorCompra();
  document.getElementById('campo-fornecedor-compra').value = '';
  document.getElementById('campo-data-compra').value = dataHojeLocal();
  document.getElementById('campo-referencia-compra').value = '';
  document.getElementById('campo-observacoes-compra').value = '';
  document.getElementById('dica-registrar-compra-erro').style.display = 'none';
  document.getElementById('dica-linha-compra-erro').style.display = 'none';

  popularOpcoesItemLinhaCompra();
  document.getElementById('campo-quantidade-linha-compra').value = '';
  document.getElementById('campo-preco-linha-compra').value = '';
  document.getElementById('campo-validade-linha-compra').value = '';
  document.getElementById('preview-linha-compra').textContent = '';

  aplicarTravaConsumoFormularioCompra();
  renderizarListaLinhasCompra();
}

function abrirCompraParaEdicao(compraId) {
  if (!souAdminCompras) return;
  const compra = comprasCache.find((c) => c.id === compraId);
  if (!compra) return;

  compraEmEdicaoId = compraId;
  compraTemConsumo = compraTemConsumoReal(compraId);
  linhasCompraEmEdicao = linhasDaCompra(compraId).map((linha) => {
    const lote = lotesCache.find((l) => l.linhaCompraId === linha.id);
    return {
      linhaId: linha.id,
      itemCompraId: linha.itemCompraId,
      nome: linha.nomeSnapshot,
      quantidade: linha.quantidade,
      unidade: linha.unidade,
      precoTotal: linha.precoTotal,
      validade: lote ? lote.validade : null,
    };
  });

  document.getElementById('titulo-secao-registrar-compra').textContent = 'Editar Compra';
  popularOpcoesFornecedorCompra();
  document.getElementById('campo-fornecedor-compra').value = compra.fornecedorId || '';
  document.getElementById('campo-data-compra').value = compra.compradoEm;
  document.getElementById('campo-referencia-compra').value = compra.referencia || '';
  document.getElementById('campo-observacoes-compra').value = compra.observacoes || '';
  document.getElementById('dica-registrar-compra-erro').style.display = 'none';
  document.getElementById('dica-linha-compra-erro').style.display = 'none';

  popularOpcoesItemLinhaCompra();
  document.getElementById('campo-quantidade-linha-compra').value = '';
  document.getElementById('campo-preco-linha-compra').value = '';
  document.getElementById('campo-validade-linha-compra').value = '';
  document.getElementById('preview-linha-compra').textContent = '';

  aplicarTravaConsumoFormularioCompra();
  renderizarListaLinhasCompra();
  abrirSecaoCompras('registrar');
}

/**
 * Único ponto de escrita real: chama salvarCompraNoSupabase (RPC
 * save_purchase). Sucesso: toast usando o retorno da RPC (nunca contado
 * no client antes de salvar), recarrega compras/linhas/lotes/movimentos
 * em background e re-renderiza Histórico/Lotes sem recarregar a página;
 * se estava criando, reseta o formulário pra uma compra nova (pronta pro
 * próximo lançamento); se estava editando, volta pro Histórico. Erro:
 * mensagem no formulário, nada é descartado, nunca finge sucesso.
 */
async function salvarFormularioCompra() {
  if (!souAdminCompras) return;

  const fornecedorId = document.getElementById('campo-fornecedor-compra').value || null;
  const compradoEm = document.getElementById('campo-data-compra').value;
  const referencia = document.getElementById('campo-referencia-compra').value.trim() || null;
  const observacoes = document.getElementById('campo-observacoes-compra').value.trim() || null;

  const dicaErro = document.getElementById('dica-registrar-compra-erro');

  if (!compradoEm) {
    dicaErro.textContent = 'Informe a data da compra.';
    dicaErro.style.display = '';
    return;
  }
  if (linhasCompraEmEdicao.length === 0) {
    dicaErro.textContent = 'Adicione pelo menos um item à compra.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const payload = { fornecedorId, compradoEm, referencia, observacoes, linhas: linhasCompraEmEdicao };

  const botaoSalvar = document.getElementById('botao-salvar-compra');
  botaoSalvar.disabled = true;

  let resultado;
  try {
    resultado = await salvarCompraNoSupabase(compraEmEdicaoId, payload);
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar a compra. ' + erro.message;
    dicaErro.style.display = '';
    botaoSalvar.disabled = false;
    return;
  }
  botaoSalvar.disabled = false;

  const foiEdicao = !!compraEmEdicaoId;
  const qtdLotes = resultado.lotes.length;
  mostrarToast(
    qtdLotes > 0
      ? `Compra salva com sucesso. ${qtdLotes} lote${qtdLotes === 1 ? '' : 's'} gerado${qtdLotes === 1 ? '' : 's'}.`
      : 'Compra salva com sucesso.',
    'sucesso'
  );

  try {
    const [compras, linhas, lotes, movimentos] = await Promise.all([
      buscarComprasDoSupabase(),
      buscarLinhasComprasDoSupabase(),
      buscarLotesDoSupabase(),
      buscarMovimentosLotesDoSupabase(),
    ]);
    comprasCache = compras;
    linhasComprasCache = linhas;
    lotesCache = lotes;
    movimentosLotesCache = movimentos;
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar compras:', erroRecarregar);
  }

  renderizarTabelaHistoricoCompras();
  popularFiltrosLotes();
  renderizarTabelaLotes();

  if (foiEdicao) {
    abrirSecaoCompras('historico');
  } else {
    prepararNovaCompra();
  }
}

function ligarEventosRegistrarCompra() {
  document.getElementById('campo-item-linha-compra').addEventListener('change', () => {
    atualizarUnidadeLinhaCompra();
    atualizarPreviewLinhaCompra();
  });
  document.getElementById('campo-quantidade-linha-compra').addEventListener('input', atualizarPreviewLinhaCompra);
  document.getElementById('campo-unidade-linha-compra').addEventListener('change', atualizarPreviewLinhaCompra);
  document.getElementById('campo-preco-linha-compra').addEventListener('input', atualizarPreviewLinhaCompra);
  document.getElementById('botao-adicionar-linha-compra').addEventListener('click', adicionarLinhaCompra);
  document.getElementById('botao-cancelar-registrar-compra').addEventListener('click', () => {
    prepararNovaCompra();
    fecharSecaoCompras();
  });
  document.getElementById('botao-salvar-compra').addEventListener('click', salvarFormularioCompra);
}
