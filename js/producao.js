/*
 * producao.js
 * Lógica da área Produção. Etapa 1: aba Ingredientes. Etapa 2: aba Fichas
 * Técnicas (recipes/recipe_items, só item_type='ingredient' nesta etapa —
 * subrecipe_id existe no schema mas não é usado pela UI ainda, isso é
 * Etapa 3). Depende de utils.js, js/services/ingredients-service.js e
 * js/services/recipes-service.js.
 *
 * souAdminProducao decide só a edição (criar/editar/ativar/desativar) —
 * visualização já é liberada pra qualquer staff que acesse esta página; a
 * barreira real de escrita é o RLS de ingredients/recipes/recipe_items
 * (admin-only). Diferente do caso de Meta de Preparo (onde a RLS real não
 * distinguia admin de employee e a UI teve que ser corrigida pra não
 * fingir uma restrição que o banco não tinha): aqui a RLS realmente
 * distingue, então a UI pode e deve espelhar essa restrição.
 *
 * Custo de ficha técnica é SEMPRE calculado on-read em JS a partir de
 * ingredientesCache (ingredients.cost_per_base_unit) — nunca persistido em
 * recipes/recipe_items, nunca lido de product_costs (isso só entra na
 * Etapa 4). ingredientesCache já é recarregado do zero a cada
 * criar/editar ingrediente (salvarFormularioIngrediente, Etapa 1, não
 * alterado aqui) — por isso os cálculos de custo de receita, que sempre
 * fazem ingredientesCache.find(...) na hora de ler (nunca guardam uma
 * cópia/mapa à parte), automaticamente refletem uma mudança de preço de
 * ingrediente na próxima renderização, sem esforço extra.
 */

const FATORES_CONVERSAO_UNIDADE_INGREDIENTE = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 };
const UNIDADES_COMPRA_POR_TIPO_INGREDIENTE = { peso: ['kg', 'g'], volume: ['L', 'ml'], contagem: ['un'] };
const UNIDADE_BASE_POR_TIPO_INGREDIENTE = { peso: 'g', volume: 'ml', contagem: 'un' };

let ingredientesCache = [];
let souAdminProducao = false;

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoProducao();

  const carregando = document.getElementById('estado-carregando-ingredientes');
  const erro = document.getElementById('estado-erro-ingredientes');

  try {
    const [ingredientes, ehAdmin] = await Promise.all([buscarIngredientesDoSupabase(), usuarioEhAdminNoSupabase()]);
    ingredientesCache = ingredientes;
    souAdminProducao = ehAdmin;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar ingredientes:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os ingredientes. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  atualizarEstadoEdicaoIngredientes();
  renderizarTabelaIngredientes();
  ligarEventosModalIngrediente();

  ligarEventosModalNovaFicha();
  ligarEventosModalDetalheFicha();
  await carregarFichasTecnicas();
});

// ---------------------------------------------------------------------------
// Navegação (central de Produção <-> seções, mesmo padrão de configuracoes.js)
// ---------------------------------------------------------------------------

function ligarEventosNavegacaoProducao() {
  document.querySelectorAll('[data-producao-abrir]').forEach((botao) => {
    botao.addEventListener('click', () => abrirSecaoProducao(botao.dataset.producaoAbrir));
  });
  document.querySelectorAll('[data-producao-voltar]').forEach((botao) => {
    botao.addEventListener('click', fecharSecaoProducao);
  });
}

function abrirSecaoProducao(chave) {
  document.getElementById('producao-central').style.display = 'none';
  document.querySelectorAll('.producao-secao').forEach((secao) => {
    secao.classList.toggle('producao-secao-ativa', secao.dataset.producaoSecao === chave);
  });
}

function fecharSecaoProducao() {
  document.querySelectorAll('.producao-secao').forEach((secao) => secao.classList.remove('producao-secao-ativa'));
  document.getElementById('producao-central').style.display = '';
}

// ---------------------------------------------------------------------------
// Admin x staff — reflete a RLS real (só admin escreve)
// ---------------------------------------------------------------------------

function atualizarEstadoEdicaoIngredientes() {
  const botaoNovo = document.getElementById('botao-novo-ingrediente');
  const dica = document.getElementById('dica-ingredientes-somente-admin');
  botaoNovo.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** "€0,001600/g" — mais casas decimais do que formatarMoeda (2) permite, então é um formatador próprio. */
function formatarCustoBaseIngrediente(valor, unidadeBase) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  return '€' + valor.toFixed(6).replace('.', ',') + '/' + unidadeBase;
}

/** "5 kg" / "24 un" — quantidade comprada como foi digitada, sem casas decimais desnecessárias. */
function formatarQuantidadeCompraIngrediente(ingrediente) {
  const quantidade = ingrediente.quantidadeCompraExibicao;
  const texto = Number.isInteger(quantidade) ? String(quantidade) : String(quantidade).replace('.', ',');
  return `${texto} ${ingrediente.unidadeCompraExibicao}`;
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

function renderizarTabelaIngredientes() {
  const corpo = document.getElementById('corpo-tabela-ingredientes');
  const vazio = document.getElementById('estado-vazio-ingredientes');

  if (ingredientesCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = ingredientesCache.map(linhaIngredienteHtml).join('');

  corpo.querySelectorAll('[data-acao-editar]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalIngrediente(botao.dataset.acaoEditar));
  });
}

function linhaIngredienteHtml(ingrediente) {
  return `
    <tr>
      <td>${escaparHtml(ingrediente.nome)}</td>
      <td>${escaparHtml(formatarQuantidadeCompraIngrediente(ingrediente))}</td>
      <td>${formatarMoeda(ingrediente.precoCompra)}</td>
      <td>${formatarCustoBaseIngrediente(ingrediente.custoPorUnidadeBase, ingrediente.unidadeBase)}</td>
      <td>${ingrediente.categoria ? escaparHtml(ingrediente.categoria) : '—'}</td>
      <td>${formatarData(ingrediente.atualizadoEm)}</td>
      <td><span class="badge badge-${ingrediente.ativo ? 'ativo' : 'inativo'}">${ingrediente.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>
        <button class="btn-icone" data-acao-editar="${ingrediente.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Unidades — dropdown de unidade filtrado pelo tipo selecionado
// ---------------------------------------------------------------------------

function atualizarOpcoesUnidadeIngrediente() {
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const selectUnidade = document.getElementById('campo-unidade-ingrediente');
  const unidadeAtual = selectUnidade.value;
  const opcoes = UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[tipo] || [];

  selectUnidade.innerHTML = opcoes.map((u) => `<option value="${u}">${u}</option>`).join('');
  selectUnidade.value = opcoes.includes(unidadeAtual) ? unidadeAtual : opcoes[0];
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function ligarEventosModalIngrediente() {
  document.getElementById('botao-novo-ingrediente').addEventListener('click', abrirModalNovoIngrediente);
  document.getElementById('botao-fechar-modal-ingrediente').addEventListener('click', fecharModalIngrediente);
  document.getElementById('botao-cancelar-ingrediente').addEventListener('click', fecharModalIngrediente);
  document.getElementById('modal-overlay-ingrediente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-ingrediente') fecharModalIngrediente();
  });

  document.getElementById('campo-tipo-ingrediente').addEventListener('change', () => {
    atualizarOpcoesUnidadeIngrediente();
    atualizarPreviewCustoIngrediente();
  });
  document.getElementById('campo-quantidade-ingrediente').addEventListener('input', atualizarPreviewCustoIngrediente);
  document.getElementById('campo-unidade-ingrediente').addEventListener('change', atualizarPreviewCustoIngrediente);
  document.getElementById('campo-preco-ingrediente').addEventListener('input', atualizarPreviewCustoIngrediente);

  document.getElementById('campo-embalagens-qtd').addEventListener('input', aplicarConvenienciaEmbalagem);
  document.getElementById('campo-embalagens-tamanho').addEventListener('input', aplicarConvenienciaEmbalagem);

  document.getElementById('form-ingrediente').addEventListener('submit', salvarFormularioIngrediente);
}

/** Multiplica embalagens × tamanho e preenche a Quantidade comprada — puramente uma conveniência de formulário, nada disso é enviado ao banco. */
function aplicarConvenienciaEmbalagem() {
  const qtdEmbalagens = Number(document.getElementById('campo-embalagens-qtd').value);
  const tamanhoEmbalagem = Number(document.getElementById('campo-embalagens-tamanho').value);

  if (Number.isFinite(qtdEmbalagens) && qtdEmbalagens > 0 && Number.isFinite(tamanhoEmbalagem) && tamanhoEmbalagem > 0) {
    document.getElementById('campo-quantidade-ingrediente').value = qtdEmbalagens * tamanhoEmbalagem;
    atualizarPreviewCustoIngrediente();
  }
}

function atualizarPreviewCustoIngrediente() {
  const preview = document.getElementById('preview-custo-ingrediente');
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const quantidade = Number(document.getElementById('campo-quantidade-ingrediente').value);
  const unidade = document.getElementById('campo-unidade-ingrediente').value;
  const preco = Number(document.getElementById('campo-preco-ingrediente').value);

  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
  const unidadeBase = UNIDADE_BASE_POR_TIPO_INGREDIENTE[tipo];

  if (!Number.isFinite(quantidade) || quantidade <= 0 || !fator || !Number.isFinite(preco) || preco < 0) {
    preview.textContent = '';
    return;
  }

  const quantidadeBase = quantidade * fator;
  const custoBase = preco / quantidadeBase;
  const quantidadeTexto = Number.isInteger(quantidade) ? quantidade : quantidade.toString().replace('.', ',');
  const quantidadeBaseTexto = Number.isInteger(quantidadeBase) ? quantidadeBase : quantidadeBase.toFixed(3).replace('.', ',');

  preview.textContent = `${quantidadeTexto} ${unidade} = ${quantidadeBaseTexto} ${unidadeBase} · Custo: ${formatarCustoBaseIngrediente(custoBase, unidadeBase)}`;
}

function abrirModalNovoIngrediente() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-ingrediente').textContent = 'Novo Ingrediente';
  document.getElementById('campo-id-ingrediente').value = '';
  document.getElementById('campo-nome-ingrediente').value = '';
  document.getElementById('campo-tipo-ingrediente').value = 'peso';
  document.getElementById('campo-quantidade-ingrediente').value = '';
  document.getElementById('campo-embalagens-qtd').value = '';
  document.getElementById('campo-embalagens-tamanho').value = '';
  document.getElementById('campo-preco-ingrediente').value = '';
  document.getElementById('campo-categoria-ingrediente').value = '';
  document.getElementById('campo-status-ingrediente').value = 'ativo';
  document.getElementById('dica-ingrediente-erro').style.display = 'none';

  atualizarOpcoesUnidadeIngrediente();
  atualizarPreviewCustoIngrediente();
  abrirModal('modal-overlay-ingrediente');
}

function abrirModalIngrediente(id) {
  if (!souAdminProducao) return;
  const ingrediente = ingredientesCache.find((i) => i.id === id);
  if (!ingrediente) return;

  document.getElementById('titulo-modal-ingrediente').textContent = 'Editar Ingrediente';
  document.getElementById('campo-id-ingrediente').value = ingrediente.id;
  document.getElementById('campo-nome-ingrediente').value = ingrediente.nome;
  document.getElementById('campo-tipo-ingrediente').value = ingrediente.tipoUnidade;
  atualizarOpcoesUnidadeIngrediente();
  document.getElementById('campo-unidade-ingrediente').value = ingrediente.unidadeCompraExibicao;
  document.getElementById('campo-quantidade-ingrediente').value = ingrediente.quantidadeCompraExibicao;
  document.getElementById('campo-embalagens-qtd').value = '';
  document.getElementById('campo-embalagens-tamanho').value = '';
  document.getElementById('campo-preco-ingrediente').value = ingrediente.precoCompra;
  document.getElementById('campo-categoria-ingrediente').value = ingrediente.categoria || '';
  document.getElementById('campo-status-ingrediente').value = ingrediente.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-ingrediente-erro').style.display = 'none';

  atualizarPreviewCustoIngrediente();
  abrirModal('modal-overlay-ingrediente');
}

function fecharModalIngrediente() {
  fecharModal('modal-overlay-ingrediente');
}

function abrirModal(idOverlay) {
  document.getElementById(idOverlay).classList.add('modal-visivel');
}

function fecharModal(idOverlay) {
  document.getElementById(idOverlay).classList.remove('modal-visivel');
}

// ---------------------------------------------------------------------------
// Validação e salvamento
// ---------------------------------------------------------------------------

/** Espelha no cliente os CHECKs do banco, só pra feedback mais rápido — o banco continua a fonte real. */
function validarFormularioIngrediente({ nome, tipo, quantidade, unidade, preco }) {
  if (!nome) return 'Informe o nome do ingrediente.';
  if (!['peso', 'volume', 'contagem'].includes(tipo)) return 'Tipo inválido.';
  if (!Number.isFinite(quantidade) || quantidade <= 0) return 'Informe uma quantidade comprada maior que zero.';
  if (!UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[tipo].includes(unidade)) return 'Unidade incompatível com o tipo selecionado.';
  if (!Number.isFinite(preco) || preco < 0) return 'Informe um preço pago válido (não pode ser negativo).';
  return null;
}

async function salvarFormularioIngrediente(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const id = document.getElementById('campo-id-ingrediente').value;
  const nome = document.getElementById('campo-nome-ingrediente').value.trim();
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const quantidade = Number(document.getElementById('campo-quantidade-ingrediente').value);
  const unidade = document.getElementById('campo-unidade-ingrediente').value;
  const preco = Number(document.getElementById('campo-preco-ingrediente').value);
  const categoria = document.getElementById('campo-categoria-ingrediente').value.trim();
  const ativo = document.getElementById('campo-status-ingrediente').value === 'ativo';

  const erroValidacao = validarFormularioIngrediente({ nome, tipo, quantidade, unidade, preco });
  const dicaErro = document.getElementById('dica-ingrediente-erro');
  if (erroValidacao) {
    dicaErro.textContent = erroValidacao;
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
  const dados = {
    nome,
    tipoUnidade: tipo,
    unidadeBase: UNIDADE_BASE_POR_TIPO_INGREDIENTE[tipo],
    quantidadeCompraExibicao: quantidade,
    unidadeCompraExibicao: unidade,
    quantidadeBaseCompra: quantidade * fator,
    precoCompra: preco,
    categoria,
    ativo,
  };

  try {
    if (id) {
      await atualizarIngredienteNoSupabase(id, dados);
    } else {
      await criarIngredienteNoSupabase(dados);
    }
  } catch (erro) {
    mostrarToast('Não foi possível salvar o ingrediente. ' + erro.message, 'erro');
    return;
  }

  mostrarToast('Ingrediente salvo.', 'sucesso');
  fecharModalIngrediente();

  try {
    ingredientesCache = await buscarIngredientesDoSupabase();
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar ingredientes:', erroRecarregar);
  }
  renderizarTabelaIngredientes();
}

// =============================================================================
// FICHAS TÉCNICAS (Etapa 2) — recipes + recipe_items, só item_type='ingredient'
// nesta etapa. Custo é SEMPRE calculado on-read aqui (ver nota no topo do
// arquivo) — nada aqui consulta product_costs (isso é Etapa 4).
// =============================================================================

let receitasCache = [];
let itensReceitaCache = [];
let receitaEmDetalheId = null;
let itemEmEdicaoId = null;

const ROTULO_UNIDADE_RENDIMENTO = { porcao: 'porção', g: 'g', ml: 'ml', un: 'un' };

async function carregarFichasTecnicas() {
  const carregando = document.getElementById('estado-carregando-receitas');
  const erro = document.getElementById('estado-erro-receitas');

  try {
    const [receitas, itens] = await Promise.all([buscarReceitasDoSupabase(), buscarItensReceitasDoSupabase()]);
    receitasCache = receitas;
    itensReceitaCache = itens;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar fichas técnicas:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar as fichas técnicas. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  atualizarEstadoEdicaoFichas();
  renderizarTabelaReceitas();
}

function atualizarEstadoEdicaoFichas() {
  const botaoNova = document.getElementById('botao-nova-ficha-tecnica');
  const dica = document.getElementById('dica-fichas-somente-admin');
  botaoNova.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

/** Busca em ingredientesCache (nunca um cache/mapa à parte) — assim uma edição de preço em Ingredientes (que já recarrega ingredientesCache do zero) é refletida aqui automaticamente, sem sincronização manual. */
function ingredientePorId(id) {
  return ingredientesCache.find((i) => i.id === id);
}

// ---------------------------------------------------------------------------
// Cálculo de custo — sempre on-read, nunca persistido em recipes/recipe_items
// ---------------------------------------------------------------------------

function itensDaReceita(receitaId) {
  return itensReceitaCache.filter((item) => item.receitaId === receitaId);
}

/** null se o ingrediente referenciado não estiver mais em ingredientesCache — não deveria acontecer (FK RESTRICT impede exclusão física), mas nunca trata ausência como custo 0. */
function custoLinhaItem(item) {
  const ingrediente = ingredientePorId(item.ingredienteId);
  if (!ingrediente) return null;
  return item.quantidade * ingrediente.custoPorUnidadeBase;
}

function custoTotalReceita(receitaId) {
  return itensDaReceita(receitaId).reduce((soma, item) => {
    const custo = custoLinhaItem(item);
    return custo === null ? soma : soma + custo;
  }, 0);
}

function custoPorRendimentoReceita(receita) {
  if (!Number.isFinite(receita.rendimentoQuantidade) || receita.rendimentoQuantidade <= 0) return null;
  return custoTotalReceita(receita.id) / receita.rendimentoQuantidade;
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function formatarRendimentoReceita(receita) {
  const quantidade = Number.isInteger(receita.rendimentoQuantidade) ? receita.rendimentoQuantidade : receita.rendimentoQuantidade.toString().replace('.', ',');
  const unidade =
    receita.rendimentoUnidade === 'porcao' ? (receita.rendimentoQuantidade === 1 ? 'porção' : 'porções') : receita.rendimentoUnidade;
  return `${quantidade} ${unidade}`;
}

/** Custo por unidade de rendimento — 4 casas pra porção/un, 6 casas pra g/ml (mesma disciplina de "nunca esconder precisão real" de formatarCustoBaseIngrediente). */
function formatarCustoPorRendimento(valor, unidade) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  const casas = unidade === 'g' || unidade === 'ml' ? 6 : 4;
  const rotulo = ROTULO_UNIDADE_RENDIMENTO[unidade] || unidade;
  return '€' + valor.toFixed(casas).replace('.', ',') + '/' + rotulo;
}

// ---------------------------------------------------------------------------
// Listagem de fichas técnicas
// ---------------------------------------------------------------------------

function renderizarTabelaReceitas() {
  const corpo = document.getElementById('corpo-tabela-receitas');
  const vazio = document.getElementById('estado-vazio-receitas');

  if (receitasCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = receitasCache.map(linhaReceitaHtml).join('');

  corpo.querySelectorAll('[data-acao-editar-receita]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalheFicha(botao.dataset.acaoEditarReceita));
  });
}

function linhaReceitaHtml(receita) {
  const custoTotal = custoTotalReceita(receita.id);
  const custoPorRendimento = custoPorRendimentoReceita(receita);

  return `
    <tr>
      <td>${escaparHtml(receita.nome)}</td>
      <td>${escaparHtml(formatarRendimentoReceita(receita))}</td>
      <td>${formatarMoeda(custoTotal)}</td>
      <td>${formatarCustoPorRendimento(custoPorRendimento, receita.rendimentoUnidade)}</td>
      <td><span class="badge badge-${receita.ativo ? 'ativo' : 'inativo'}">${receita.ativo ? 'Ativa' : 'Inativa'}</span></td>
      <td>
        <button class="btn-icone" data-acao-editar-receita="${receita.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Modal: Nova Ficha Técnica
// ---------------------------------------------------------------------------

function ligarEventosModalNovaFicha() {
  document.getElementById('botao-nova-ficha-tecnica').addEventListener('click', abrirModalNovaFicha);
  document.getElementById('botao-fechar-modal-nova-ficha').addEventListener('click', fecharModalNovaFicha);
  document.getElementById('botao-cancelar-nova-ficha').addEventListener('click', fecharModalNovaFicha);
  document.getElementById('modal-overlay-nova-ficha').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-nova-ficha') fecharModalNovaFicha();
  });
  document.getElementById('form-nova-ficha').addEventListener('submit', salvarNovaFicha);
}

function abrirModalNovaFicha() {
  if (!souAdminProducao) return;

  document.getElementById('campo-nome-nova-ficha').value = '';
  document.getElementById('campo-rendimento-quantidade-nova-ficha').value = '';
  document.getElementById('campo-rendimento-unidade-nova-ficha').value = 'porcao';
  document.getElementById('dica-nova-ficha-erro').style.display = 'none';

  abrirModal('modal-overlay-nova-ficha');
}

function fecharModalNovaFicha() {
  fecharModal('modal-overlay-nova-ficha');
}

async function salvarNovaFicha(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const nome = document.getElementById('campo-nome-nova-ficha').value.trim();
  const rendimentoQuantidade = Number(document.getElementById('campo-rendimento-quantidade-nova-ficha').value);
  const rendimentoUnidade = document.getElementById('campo-rendimento-unidade-nova-ficha').value;

  const dicaErro = document.getElementById('dica-nova-ficha-erro');
  if (!nome) {
    dicaErro.textContent = 'Informe o nome da ficha técnica.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(rendimentoQuantidade) || rendimentoQuantidade <= 0) {
    dicaErro.textContent = 'Informe um rendimento maior que zero.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  let novaReceita;
  try {
    novaReceita = await criarReceitaNoSupabase({ nome, rendimentoQuantidade, rendimentoUnidade, ativo: true });
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível criar a ficha técnica. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  receitasCache.push(novaReceita);
  renderizarTabelaReceitas();
  fecharModalNovaFicha();
  mostrarToast('Ficha técnica criada. Agora adicione os ingredientes.', 'sucesso');
  abrirModalDetalheFicha(novaReceita.id);
}

// ---------------------------------------------------------------------------
// Modal: Detalhe da Ficha Técnica
// ---------------------------------------------------------------------------

function ligarEventosModalDetalheFicha() {
  document.getElementById('botao-fechar-modal-detalhe-ficha').addEventListener('click', fecharModalDetalheFicha);
  document.getElementById('botao-fechar-detalhe-ficha').addEventListener('click', fecharModalDetalheFicha);
  document.getElementById('modal-overlay-detalhe-ficha').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-detalhe-ficha') fecharModalDetalheFicha();
  });

  document.getElementById('botao-editar-metadados-receita').addEventListener('click', mostrarEdicaoMetadadosReceita);
  document.getElementById('botao-cancelar-edicao-metadados-receita').addEventListener('click', ocultarEdicaoMetadadosReceita);
  document.getElementById('botao-salvar-metadados-receita').addEventListener('click', salvarMetadadosReceita);
  document.getElementById('botao-alternar-status-receita-detalhe').addEventListener('click', alternarStatusReceitaDetalhe);

  document.getElementById('campo-ingrediente-item').addEventListener('change', () => {
    atualizarOpcoesUnidadeItem();
    atualizarPreviewCustoItem();
  });
  document.getElementById('campo-quantidade-item').addEventListener('input', atualizarPreviewCustoItem);
  document.getElementById('campo-unidade-item').addEventListener('change', atualizarPreviewCustoItem);
  document.getElementById('form-adicionar-item-receita').addEventListener('submit', adicionarItemReceita);
}

function receitaAtualDetalhe() {
  return receitasCache.find((r) => r.id === receitaEmDetalheId) || null;
}

function abrirModalDetalheFicha(receitaId) {
  receitaEmDetalheId = receitaId;
  itemEmEdicaoId = null;
  ocultarEdicaoMetadadosReceita();

  popularOpcoesIngredienteItem();
  document.getElementById('campo-quantidade-item').value = '';
  document.getElementById('preview-custo-item').textContent = '';
  document.getElementById('dica-item-erro').style.display = 'none';

  renderizarDetalheFicha();
  abrirModal('modal-overlay-detalhe-ficha');
}

function fecharModalDetalheFicha() {
  fecharModal('modal-overlay-detalhe-ficha');
  receitaEmDetalheId = null;
  itemEmEdicaoId = null;
}

function renderizarDetalheFicha() {
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  document.getElementById('titulo-modal-detalhe-ficha').textContent = receita.nome;
  document.getElementById('texto-rendimento-receita-detalhe').textContent = `Rendimento: ${formatarRendimentoReceita(receita)}`;
  document.getElementById('botao-editar-metadados-receita').disabled = !souAdminProducao;

  const botaoStatus = document.getElementById('botao-alternar-status-receita-detalhe');
  botaoStatus.textContent = receita.ativo ? 'Desativar' : 'Ativar';
  botaoStatus.disabled = !souAdminProducao;

  renderizarItensReceitaDetalhe();

  document.getElementById('texto-custo-total-receita').textContent = formatarMoeda(custoTotalReceita(receita.id));
  document.getElementById('texto-custo-por-rendimento-receita').textContent = formatarCustoPorRendimento(
    custoPorRendimentoReceita(receita),
    receita.rendimentoUnidade
  );

  document.getElementById('form-adicionar-item-receita').querySelectorAll('input, select, button').forEach((campo) => {
    campo.disabled = !souAdminProducao;
  });
}

function renderizarItensReceitaDetalhe() {
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  const itens = itensDaReceita(receita.id);
  const corpo = document.getElementById('corpo-tabela-itens-receita');
  const vazio = document.getElementById('estado-vazio-itens-receita');

  if (itens.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = itens.map(linhaItemReceitaHtml).join('');

  corpo.querySelectorAll('[data-acao-editar-item]').forEach((botao) => {
    botao.addEventListener('click', () => iniciarEdicaoItem(botao.dataset.acaoEditarItem));
  });
  corpo.querySelectorAll('[data-acao-remover-item]').forEach((botao) => {
    botao.addEventListener('click', () => removerItemReceita(botao.dataset.acaoRemoverItem));
  });
  corpo.querySelectorAll('[data-acao-salvar-item]').forEach((botao) => {
    botao.addEventListener('click', () => salvarEdicaoItem(botao.dataset.acaoSalvarItem));
  });
  corpo.querySelectorAll('[data-acao-cancelar-item]').forEach((botao) => {
    botao.addEventListener('click', cancelarEdicaoItem);
  });
}

function linhaItemReceitaHtml(item) {
  const ingrediente = ingredientePorId(item.ingredienteId);
  const nome = ingrediente ? ingrediente.nome : '(ingrediente removido)';
  const quantidadeTexto = Number.isInteger(item.quantidade) ? item.quantidade : item.quantidade.toString().replace('.', ',');

  if (item.id === itemEmEdicaoId) {
    return `
      <tr>
        <td>${escaparHtml(nome)}</td>
        <td>
          <div class="producao-item-receita-edicao">
            <input type="number" id="campo-editar-quantidade-item" class="input" min="0" step="0.001" value="${item.quantidade}" />
            <span>${item.unidade}</span>
          </div>
        </td>
        <td>—</td>
        <td>
          <div class="producao-item-receita-edicao">
            <button type="button" class="btn-icone" data-acao-salvar-item="${item.id}" title="Salvar">✔️</button>
            <button type="button" class="btn-icone" data-acao-cancelar-item="${item.id}" title="Cancelar">✖️</button>
          </div>
        </td>
      </tr>`;
  }

  const custoLinha = custoLinhaItem(item);

  return `
    <tr>
      <td>${escaparHtml(nome)}</td>
      <td>${quantidadeTexto} ${item.unidade}</td>
      <td>${custoLinha === null ? '—' : formatarMoeda(custoLinha)}</td>
      <td>
        <div class="producao-item-receita-edicao">
          <button type="button" class="btn-icone" data-acao-editar-item="${item.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
          <button type="button" class="btn-icone" data-acao-remover-item="${item.id}" title="Remover" ${souAdminProducao ? '' : 'disabled'}>🗑️</button>
        </div>
      </td>
    </tr>`;
}

function iniciarEdicaoItem(itemId) {
  if (!souAdminProducao) return;
  itemEmEdicaoId = itemId;
  renderizarItensReceitaDetalhe();
}

function cancelarEdicaoItem() {
  itemEmEdicaoId = null;
  renderizarItensReceitaDetalhe();
}

async function salvarEdicaoItem(itemId) {
  const quantidade = Number(document.getElementById('campo-editar-quantidade-item').value);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    mostrarToast('Informe uma quantidade válida.', 'erro');
    return;
  }

  const item = itensReceitaCache.find((i) => i.id === itemId);
  if (!item) return;

  try {
    await atualizarItemReceitaNoSupabase(itemId, { quantidade, unidade: item.unidade });
  } catch (erro) {
    mostrarToast('Não foi possível atualizar o item. ' + erro.message, 'erro');
    return;
  }

  item.quantidade = quantidade;
  itemEmEdicaoId = null;
  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Item atualizado.', 'sucesso');
}

async function removerItemReceita(itemId) {
  if (!souAdminProducao) return;

  const item = itensReceitaCache.find((i) => i.id === itemId);
  if (!item) return;
  const ingrediente = ingredientePorId(item.ingredienteId);
  if (!confirm(`Remover "${ingrediente ? ingrediente.nome : 'este item'}" desta ficha técnica?`)) return;

  try {
    await excluirItemReceitaNoSupabase(itemId);
  } catch (erro) {
    mostrarToast('Não foi possível remover o item. ' + erro.message, 'erro');
    return;
  }

  itensReceitaCache = itensReceitaCache.filter((i) => i.id !== itemId);
  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Item removido.', 'sucesso');
}

// ---------------------------------------------------------------------------
// Edição de nome/rendimento da receita (dentro do modal de Detalhe)
// ---------------------------------------------------------------------------

function mostrarEdicaoMetadadosReceita() {
  if (!souAdminProducao) return;
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  document.getElementById('campo-nome-receita-edicao').value = receita.nome;
  document.getElementById('campo-rendimento-quantidade-edicao').value = receita.rendimentoQuantidade;
  document.getElementById('campo-rendimento-unidade-edicao').value = receita.rendimentoUnidade;

  document.getElementById('bloco-editar-metadados-receita').style.display = '';
}

function ocultarEdicaoMetadadosReceita() {
  document.getElementById('bloco-editar-metadados-receita').style.display = 'none';
}

async function salvarMetadadosReceita() {
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  const nome = document.getElementById('campo-nome-receita-edicao').value.trim();
  const rendimentoQuantidade = Number(document.getElementById('campo-rendimento-quantidade-edicao').value);
  const rendimentoUnidade = document.getElementById('campo-rendimento-unidade-edicao').value;

  if (!nome) {
    mostrarToast('Informe o nome da ficha técnica.', 'erro');
    return;
  }
  if (!Number.isFinite(rendimentoQuantidade) || rendimentoQuantidade <= 0) {
    mostrarToast('Informe um rendimento maior que zero.', 'erro');
    return;
  }

  let receitaAtualizada;
  try {
    receitaAtualizada = await atualizarReceitaNoSupabase(receita.id, { nome, rendimentoQuantidade, rendimentoUnidade });
  } catch (erro) {
    mostrarToast('Não foi possível salvar a ficha técnica. ' + erro.message, 'erro');
    return;
  }

  const indice = receitasCache.findIndex((r) => r.id === receita.id);
  if (indice !== -1) receitasCache[indice] = receitaAtualizada;

  ocultarEdicaoMetadadosReceita();
  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Ficha técnica atualizada.', 'sucesso');
}

async function alternarStatusReceitaDetalhe() {
  const receita = receitaAtualDetalhe();
  if (!receita || !souAdminProducao) return;

  const novoStatus = !receita.ativo;
  try {
    await alternarStatusReceitaNoSupabase(receita.id, novoStatus);
  } catch (erro) {
    mostrarToast('Não foi possível alterar o status. ' + erro.message, 'erro');
    return;
  }

  receita.ativo = novoStatus;
  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast(novoStatus ? 'Ficha técnica ativada.' : 'Ficha técnica desativada.', 'sucesso');
}

// ---------------------------------------------------------------------------
// Formulário "+ Adicionar ingrediente" (dentro do modal de Detalhe)
// ---------------------------------------------------------------------------

/** Só ingredientes ATIVOS — um ingrediente inativo não pode ser escolhido pra um item novo (mas continua aparecendo em itens já existentes, ver linhaItemReceitaHtml). */
function popularOpcoesIngredienteItem() {
  const select = document.getElementById('campo-ingrediente-item');
  const ativos = ingredientesCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));

  select.innerHTML = ativos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
  atualizarOpcoesUnidadeItem();
}

function atualizarOpcoesUnidadeItem() {
  const ingrediente = ingredientePorId(document.getElementById('campo-ingrediente-item').value);
  const selectUnidade = document.getElementById('campo-unidade-item');

  if (!ingrediente) {
    selectUnidade.innerHTML = '';
    return;
  }

  const unidadeAtual = selectUnidade.value;
  const opcoes = UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[ingrediente.tipoUnidade] || [];
  selectUnidade.innerHTML = opcoes.map((u) => `<option value="${u}">${u}</option>`).join('');
  selectUnidade.value = opcoes.includes(unidadeAtual) ? unidadeAtual : opcoes[0];
}

function atualizarPreviewCustoItem() {
  const preview = document.getElementById('preview-custo-item');
  const ingrediente = ingredientePorId(document.getElementById('campo-ingrediente-item').value);
  const quantidade = Number(document.getElementById('campo-quantidade-item').value);
  const unidade = document.getElementById('campo-unidade-item').value;
  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];

  if (!ingrediente || !Number.isFinite(quantidade) || quantidade <= 0 || !fator) {
    preview.textContent = '';
    return;
  }

  const quantidadeBase = quantidade * fator;
  const custo = quantidadeBase * ingrediente.custoPorUnidadeBase;
  const quantidadeTexto = Number.isInteger(quantidade) ? quantidade : quantidade.toString().replace('.', ',');
  const quantidadeBaseTexto = Number.isInteger(quantidadeBase) ? quantidadeBase : quantidadeBase.toFixed(3).replace('.', ',');

  preview.textContent = `${quantidadeTexto} ${unidade} = ${quantidadeBaseTexto} ${ingrediente.unidadeBase} · Custo estimado: ${formatarMoeda(custo)}`;
}

async function adicionarItemReceita(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const receita = receitaAtualDetalhe();
  if (!receita) return;

  const ingrediente = ingredientePorId(document.getElementById('campo-ingrediente-item').value);
  const quantidade = Number(document.getElementById('campo-quantidade-item').value);
  const unidade = document.getElementById('campo-unidade-item').value;
  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];

  const dicaErro = document.getElementById('dica-item-erro');

  if (!ingrediente) {
    dicaErro.textContent = 'Selecione um ingrediente.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    dicaErro.textContent = 'Informe uma quantidade maior que zero.';
    dicaErro.style.display = '';
    return;
  }
  if (!fator || !UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[ingrediente.tipoUnidade].includes(unidade)) {
    dicaErro.textContent = 'Unidade incompatível com o ingrediente selecionado.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const quantidadeBase = quantidade * fator;

  let novoItem;
  try {
    novoItem = await criarItemReceitaNoSupabase({
      receitaId: receita.id,
      ingredienteId: ingrediente.id,
      quantidade: quantidadeBase,
      unidade: ingrediente.unidadeBase,
    });
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível adicionar o ingrediente. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  itensReceitaCache.push(novoItem);
  document.getElementById('campo-quantidade-item').value = '';
  document.getElementById('preview-custo-item').textContent = '';

  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Ingrediente adicionado.', 'sucesso');
}
