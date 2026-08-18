/*
 * producao.js
 * Lógica da área Produção. Etapa 1: aba Ingredientes. Etapa 2: aba Fichas
 * Técnicas com ingredientes simples. Etapa 3: sub-receitas (item_type=
 * 'recipe' — um item de receita pode ser outro preparo) + exclusão de
 * ficha técnica. Produção de Espetos: terceira aba, lotes reais de produção
 * a partir de peças de carne com perda de limpeza (skewer_production_batches)
 * — perda, rendimento e custos sempre calculados on-read
 * (calcularIndicadoresLoteEspetos), nunca persistidos, nunca lidos de
 * product_costs (isso só entra numa etapa futura). Insumos de Produção:
 * quarta aba, cadastro standalone de insumos contados por unidade
 * (production_supplies — palito hoje, embalagem/bandeja no futuro) — Etapa
 * 3A, ainda SEM nenhuma integração com o lote de espetos (isso só entra na
 * Etapa 3B, via skewer_batch_components + RPC). Depende de utils.js,
 * js/services/ingredients-service.js, js/services/recipes-service.js,
 * js/services/products-service.js, js/services/skewer-production-service.js
 * e js/services/production-supplies-service.js.
 *
 * souAdminProducao decide só a edição (criar/editar/ativar/desativar/
 * excluir) — visualização já é liberada pra qualquer staff que acesse esta
 * página; a barreira real de escrita é a RLS de ingredients/recipes/
 * recipe_items (admin-only) e, pra composição de receita (ingrediente OU
 * sub-receita), a RPC save_recipe_item, que valida is_admin() por dentro e
 * roda como SECURITY DEFINER (não depende só da RLS). Diferente do caso de
 * Meta de Preparo (onde a RLS real não distinguia admin de employee e a UI
 * teve que ser corrigida pra não fingir uma restrição que o banco não
 * tinha): aqui a distinção é real, então a UI pode e deve espelhá-la.
 *
 * Custo de ficha técnica é SEMPRE calculado on-read em JS — recursivo
 * (item pode ser ingrediente OU sub-receita) e memoizado por receitaId
 * num Map novo a cada passada de render (nunca persistido em recipes/
 * recipe_items, nunca lido de product_costs — isso só entra na Etapa 4).
 * ingredientesCache é recarregado do zero a cada criar/editar ingrediente
 * (salvarFormularioIngrediente, Etapa 1, não alterado aqui) — por isso os
 * cálculos de custo, que sempre fazem ingredientesCache.find(...) na hora
 * de ler (nunca guardam uma cópia à parte), automaticamente refletem uma
 * mudança de preço na próxima renderização, sem esforço extra.
 */

const FATORES_CONVERSAO_UNIDADE_INGREDIENTE = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 };
const UNIDADES_COMPRA_POR_TIPO_INGREDIENTE = { peso: ['kg', 'g'], volume: ['L', 'ml'], contagem: ['un'] };
const UNIDADE_BASE_POR_TIPO_INGREDIENTE = { peso: 'g', volume: 'ml', contagem: 'un' };

let ingredientesCache = [];
let produtosCache = [];
let insumosProducaoCache = [];
let souAdminProducao = false;

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoProducao();

  const carregando = document.getElementById('estado-carregando-ingredientes');
  const erro = document.getElementById('estado-erro-ingredientes');

  try {
    const [ingredientes, ehAdmin, produtos, insumos] = await Promise.all([
      buscarIngredientesDoSupabase(),
      usuarioEhAdminNoSupabase(),
      buscarProdutosDoSupabase(),
      buscarInsumosProducaoDoSupabase(),
    ]);
    ingredientesCache = ingredientes;
    souAdminProducao = ehAdmin;
    produtosCache = produtos;
    insumosProducaoCache = insumos;
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

  ligarEventosModalLoteEspeto();
  await carregarLotesEspetos();

  atualizarEstadoEdicaoInsumos();
  renderizarTabelaInsumos();
  ligarEventosModalInsumo();
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
// FICHAS TÉCNICAS — recipes + recipe_items, item_type 'ingredient' ou
// 'recipe' (sub-receita, Etapa 3). Custo é SEMPRE calculado on-read aqui
// (ver nota no topo do arquivo) — nada aqui consulta product_costs (isso é
// Etapa 4). Escrita de item (ingrediente OU sub-receita) sempre pela RPC
// save_recipe_item (recipes-service.js) — nunca INSERT/UPDATE direto,
// validação de unidade/ciclo é sempre server-side, aqui é só UX.
// =============================================================================

let receitasCache = [];
let itensReceitaCache = [];
let receitaEmDetalheId = null;
let itemEmEdicaoId = null;

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
// Cálculo de custo — sempre on-read, nunca persistido em recipes/recipe_items.
// Recursivo (item de receita pode ser ingrediente OU sub-receita) e
// memoizado por receitaId num Map novo a cada passada de render — nunca
// entre renders, nunca gravado no banco (ver calcularCustoReceitaRecursivo).
// ---------------------------------------------------------------------------

function itensDaReceita(receitaId) {
  return itensReceitaCache.filter((item) => item.receitaId === receitaId);
}

function receitaPorId(id) {
  return receitasCache.find((r) => r.id === id);
}

/**
 * Rendimento SEMPRE derivado dos itens (nunca um campo cadastrado — recipes
 * não tem yield_quantity/yield_unit). Regra: todos os itens na mesma unit ->
 * soma nessa unit; sem itens, ou itens em mais de uma unit (ex. g + ml,
 * grandezas incompatíveis) -> indisponível, nunca uma soma inventada. Nunca
 * converte peso<->volume. Mesma função serve pra determinar se uma receita
 * pode ser usada como sub-receita de outra (precisa de rendimento disponível).
 */
function calcularRendimentoReceita(receitaId) {
  const itens = itensDaReceita(receitaId);
  if (itens.length === 0) {
    return { disponivel: false, motivo: 'sem_itens', quantidade: null, unidade: null };
  }

  const unidades = new Set(itens.map((item) => item.unidade));
  if (unidades.size > 1) {
    return { disponivel: false, motivo: 'unidades_mistas', quantidade: null, unidade: null };
  }

  const unidade = itens[0].unidade;
  const quantidade = itens.reduce((soma, item) => soma + item.quantidade, 0);
  return { disponivel: true, motivo: null, quantidade, unidade };
}

/**
 * Custo de UMA linha. Ingrediente: quantidade × custo por unidade base.
 * Sub-receita: quantidade usada × (custo total da sub-receita / rendimento
 * dela) — nunca o custo total inteiro da sub-receita, isso inflaria o
 * custo quando só uma fração dela é usada. null quando não dá
 * pra calcular (ingrediente/sub-receita sumiu do cache, ou sub-receita sem
 * rendimento disponível) — nunca tratado como custo 0.
 */
function custoLinhaItem(item, cache) {
  if (item.tipoItem === 'ingredient') {
    const ingrediente = ingredientePorId(item.ingredienteId);
    if (!ingrediente) return null;
    return item.quantidade * ingrediente.custoPorUnidadeBase;
  }

  const custoTotalSub = calcularCustoReceitaRecursivo(item.subReceitaId, cache);
  const rendimentoSub = calcularRendimentoReceita(item.subReceitaId);
  if (custoTotalSub === null || !rendimentoSub.disponivel || rendimentoSub.quantidade <= 0) return null;
  return item.quantidade * (custoTotalSub / rendimentoSub.quantidade);
}

/**
 * Custo total de uma receita, somando ingredientes + sub-receitas
 * (recursivo). `cache` é um Map novo por passada de render (nunca
 * persistido, nunca gravado no banco) — memoiza por receitaId pra não
 * recalcular a mesma sub-receita repetidas vezes quando é usada em mais de
 * um lugar na mesma tela. O placeholder gravado antes de recursar é só
 * cinto e suspensório contra recursão infinita — ciclos já são impedidos
 * na escrita pela RPC save_recipe_item, então nunca deveria ser atingido.
 */
function calcularCustoReceitaRecursivo(receitaId, cache) {
  if (cache.has(receitaId)) return cache.get(receitaId);

  cache.set(receitaId, 0);

  const custo = itensDaReceita(receitaId).reduce((soma, item) => {
    const custoLinha = custoLinhaItem(item, cache);
    return custoLinha === null ? soma : soma + custoLinha;
  }, 0);

  cache.set(receitaId, custo);
  return custo;
}

/** Ponto de entrada público — aceita `cache` opcional (um Map descartável é criado se não vier um, útil pra chamadas isoladas fora de uma passada de render maior). */
function custoTotalReceita(receitaId, cache) {
  return calcularCustoReceitaRecursivo(receitaId, cache || new Map());
}

/** null quando o rendimento não está disponível (sem itens ou unidades mistas) — nunca divide por zero. */
function custoPorRendimentoReceita(receitaId, cache) {
  const rendimento = calcularRendimentoReceita(receitaId);
  if (!rendimento.disponivel) return null;
  return custoTotalReceita(receitaId, cache) / rendimento.quantidade;
}

/**
 * DFS client-side espelhando a checagem de ciclo da RPC — só pra filtrar a
 * lista de preparos oferecidos na UI antes de tentar salvar (UX). A RPC
 * continua sendo a barreira real: mesmo que este filtro deixasse passar
 * algo por engano, o save_recipe_item rejeitaria server-side.
 */
function usarComoSubReceitaCriariaCiclo(receitaAtualId, candidatoId) {
  const visitados = new Set();
  const pilha = [candidatoId];

  while (pilha.length > 0) {
    const atual = pilha.pop();
    if (atual === receitaAtualId) return true;
    if (visitados.has(atual)) continue;
    visitados.add(atual);

    itensDaReceita(atual)
      .filter((item) => item.tipoItem === 'recipe')
      .forEach((item) => pilha.push(item.subReceitaId));
  }

  return false;
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

function formatarQuantidadeRendimento(quantidade) {
  return quantidade.toLocaleString('pt-PT', { maximumFractionDigits: 3 });
}

/** Compacto, pra célula da tabela de listagem. */
function textoRendimentoTabela(rendimento) {
  if (rendimento.disponivel) return `${formatarQuantidadeRendimento(rendimento.quantidade)} ${rendimento.unidade}`;
  if (rendimento.motivo === 'unidades_mistas') return 'Unidades mistas';
  return '—';
}

/** Frase completa, pro cabeçalho do modal de Detalhe. */
function textoRendimentoDetalhe(rendimento) {
  if (rendimento.disponivel) return `Rendimento calculado: ${formatarQuantidadeRendimento(rendimento.quantidade)} ${rendimento.unidade}`;
  if (rendimento.motivo === 'unidades_mistas') return 'Rendimento automático indisponível para unidades mistas.';
  return 'Rendimento: adicione ingredientes para calcular.';
}

/** Custo por unidade de rendimento — 6 casas pra g/ml, 4 casas pra un (mesma disciplina de "nunca esconder precisão real" de formatarCustoBaseIngrediente). */
function formatarCustoPorRendimento(valor, unidade) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  const casas = unidade === 'g' || unidade === 'ml' ? 6 : 4;
  return '€' + valor.toFixed(casas).replace('.', ',') + '/' + unidade;
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

  // Um cache só pra essa passada inteira — se duas receitas da lista usam a
  // mesma sub-receita, a segunda leitura vem memoizada (ver calcularCustoReceitaRecursivo).
  const cache = new Map();
  corpo.innerHTML = receitasCache.map((receita) => linhaReceitaHtml(receita, cache)).join('');

  corpo.querySelectorAll('[data-acao-editar-receita]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalheFicha(botao.dataset.acaoEditarReceita));
  });
}

function linhaReceitaHtml(receita, cache) {
  const rendimento = calcularRendimentoReceita(receita.id);
  const custoTotal = custoTotalReceita(receita.id, cache);
  const custoPorRendimento = custoPorRendimentoReceita(receita.id, cache);

  return `
    <tr>
      <td>${escaparHtml(receita.nome)}</td>
      <td>${escaparHtml(textoRendimentoTabela(rendimento))}</td>
      <td>${formatarMoeda(custoTotal)}</td>
      <td>${formatarCustoPorRendimento(custoPorRendimento, rendimento.unidade)}</td>
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

  const dicaErro = document.getElementById('dica-nova-ficha-erro');
  if (!nome) {
    dicaErro.textContent = 'Informe o nome da ficha técnica.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  let novaReceita;
  try {
    novaReceita = await criarReceitaNoSupabase({ nome, ativo: true });
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
  document.getElementById('botao-excluir-receita-detalhe').addEventListener('click', excluirReceitaDetalhe);

  document.getElementById('campo-tipo-item').addEventListener('change', () => {
    const tipo = document.getElementById('campo-tipo-item').value;
    document.getElementById('rotulo-referencia-item').textContent = tipo === 'ingredient' ? 'Ingrediente' : 'Preparo';
    if (tipo === 'ingredient') popularOpcoesIngredienteItem();
    else popularOpcoesPreparoItem();
    atualizarOpcoesUnidadeItem();
    atualizarPreviewCustoItem();
  });
  document.getElementById('campo-referencia-item').addEventListener('change', () => {
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

  document.getElementById('campo-tipo-item').value = 'ingredient';
  document.getElementById('rotulo-referencia-item').textContent = 'Ingrediente';
  popularOpcoesIngredienteItem();
  atualizarOpcoesUnidadeItem();
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

  const rendimento = calcularRendimentoReceita(receita.id);
  document.getElementById('texto-rendimento-receita-detalhe').textContent = textoRendimentoDetalhe(rendimento);
  document.getElementById('botao-editar-metadados-receita').disabled = !souAdminProducao;

  const botaoStatus = document.getElementById('botao-alternar-status-receita-detalhe');
  botaoStatus.textContent = receita.ativo ? 'Desativar' : 'Ativar';
  botaoStatus.disabled = !souAdminProducao;
  document.getElementById('botao-excluir-receita-detalhe').disabled = !souAdminProducao;

  // Cache só desta renderização — custo total e cada linha (que pode recursar em sub-receita) reaproveitam.
  const cache = new Map();

  renderizarItensReceitaDetalhe(cache);

  document.getElementById('texto-custo-total-receita').textContent = formatarMoeda(custoTotalReceita(receita.id, cache));
  document.getElementById('texto-custo-por-rendimento-receita').textContent = formatarCustoPorRendimento(
    custoPorRendimentoReceita(receita.id, cache),
    rendimento.unidade
  );

  document.getElementById('form-adicionar-item-receita').querySelectorAll('input, select, button').forEach((campo) => {
    campo.disabled = !souAdminProducao;
  });
}

function renderizarItensReceitaDetalhe(cache = new Map()) {
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

  corpo.innerHTML = itens.map((item) => linhaItemReceitaHtml(item, cache)).join('');

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

/** Nome do item referenciado, ingrediente ou sub-receita — nunca some da linha mesmo se o ingrediente/preparo ficar inativo depois (só novos itens não podem escolher inativos, ver popularOpcoesIngredienteItem/popularOpcoesPreparoItem). */
function nomeReferenciaItem(item) {
  if (item.tipoItem === 'ingredient') {
    const ingrediente = ingredientePorId(item.ingredienteId);
    return ingrediente ? ingrediente.nome : '(ingrediente removido)';
  }
  const sub = receitaPorId(item.subReceitaId);
  return sub ? sub.nome : '(preparo removido)';
}

function linhaItemReceitaHtml(item, cache) {
  const nome = nomeReferenciaItem(item);
  const tipoLabel = item.tipoItem === 'ingredient' ? 'Ingrediente' : 'Preparo';
  const quantidadeTexto = Number.isInteger(item.quantidade) ? item.quantidade : item.quantidade.toString().replace('.', ',');

  if (item.id === itemEmEdicaoId) {
    return `
      <tr>
        <td>${escaparHtml(nome)}</td>
        <td>${tipoLabel}</td>
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

  const custoLinha = custoLinhaItem(item, cache);

  return `
    <tr>
      <td>${escaparHtml(nome)}</td>
      <td>${tipoLabel}</td>
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

  const referenciaId = item.tipoItem === 'ingredient' ? item.ingredienteId : item.subReceitaId;

  try {
    await salvarItemReceitaNoSupabase({
      itemId,
      receitaId: item.receitaId,
      tipoItem: item.tipoItem,
      referenciaId,
      quantidade,
      unidade: item.unidade,
    });
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
  if (!confirm(`Remover "${nomeReferenciaItem(item)}" desta ficha técnica?`)) return;

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
// Edição de nome da receita (dentro do modal de Detalhe) — rendimento não é
// mais editável, é sempre calculado a partir dos itens (ver calcularRendimentoReceita).
// ---------------------------------------------------------------------------

function mostrarEdicaoMetadadosReceita() {
  if (!souAdminProducao) return;
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  document.getElementById('campo-nome-receita-edicao').value = receita.nome;

  document.getElementById('bloco-editar-metadados-receita').style.display = '';
}

function ocultarEdicaoMetadadosReceita() {
  document.getElementById('bloco-editar-metadados-receita').style.display = 'none';
}

async function salvarMetadadosReceita() {
  const receita = receitaAtualDetalhe();
  if (!receita) return;

  const nome = document.getElementById('campo-nome-receita-edicao').value.trim();

  if (!nome) {
    mostrarToast('Informe o nome da ficha técnica.', 'erro');
    return;
  }

  let receitaAtualizada;
  try {
    receitaAtualizada = await atualizarReceitaNoSupabase(receita.id, { nome });
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

/** Exclusão física da ficha — confirmação explícita, nunca um clique direto. Se a FK bloquear (ficha usada como preparo de outra), o service já mapeia pra mensagem amigável. */
async function excluirReceitaDetalhe() {
  const receita = receitaAtualDetalhe();
  if (!receita || !souAdminProducao) return;

  if (!confirm(`Excluir a ficha técnica "${receita.nome}"?\n\nEsta ação remove a ficha e sua composição.`)) return;

  try {
    await excluirReceitaNoSupabase(receita.id);
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
    return;
  }

  receitasCache = receitasCache.filter((r) => r.id !== receita.id);
  itensReceitaCache = itensReceitaCache.filter((i) => i.receitaId !== receita.id);

  fecharModalDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Ficha técnica excluída.', 'sucesso');
}

// ---------------------------------------------------------------------------
// Formulário "+ Adicionar item" (dentro do modal de Detalhe) — Tipo
// Ingrediente ou Preparo (sub-receita, Etapa 3). Reaproveita os mesmos
// campo-referencia-item/campo-unidade-item pros dois casos, só troca o que
// popula (ver campo-tipo-item change, em ligarEventosModalDetalheFicha).
// ---------------------------------------------------------------------------

/** Só ingredientes ATIVOS — um inativo não pode ser escolhido pra um item novo (mas continua aparecendo em itens já existentes, ver nomeReferenciaItem). */
function popularOpcoesIngredienteItem() {
  const select = document.getElementById('campo-referencia-item');
  const ativos = ingredientesCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));

  select.innerHTML = ativos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
}

/**
 * Só preparos: ativos, com rendimento calculável (nem sem itens, nem
 * unidades mistas), excluindo a própria receita e qualquer um que já
 * causaria ciclo (checagem client-side, só UX — a RPC save_recipe_item
 * continua sendo a barreira real).
 */
function popularOpcoesPreparoItem() {
  const select = document.getElementById('campo-referencia-item');
  const receitaAtual = receitaAtualDetalhe();
  if (!receitaAtual) {
    select.innerHTML = '';
    return;
  }

  const candidatos = receitasCache
    .filter((r) => r.id !== receitaAtual.id)
    .filter((r) => r.ativo)
    .filter((r) => calcularRendimentoReceita(r.id).disponivel)
    .filter((r) => !usarComoSubReceitaCriariaCiclo(receitaAtual.id, r.id))
    .sort((a, b) => a.nome.localeCompare(b.nome));

  select.innerHTML = candidatos.map((r) => `<option value="${r.id}">${escaparHtml(r.nome)}</option>`).join('');
}

function atualizarOpcoesUnidadeItem() {
  const tipo = document.getElementById('campo-tipo-item').value;
  const referenciaId = document.getElementById('campo-referencia-item').value;
  const selectUnidade = document.getElementById('campo-unidade-item');

  if (tipo === 'ingredient') {
    const ingrediente = ingredientePorId(referenciaId);
    if (!ingrediente) {
      selectUnidade.innerHTML = '';
      selectUnidade.disabled = false;
      return;
    }
    const unidadeAtual = selectUnidade.value;
    const opcoes = UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[ingrediente.tipoUnidade] || [];
    selectUnidade.innerHTML = opcoes.map((u) => `<option value="${u}">${u}</option>`).join('');
    selectUnidade.value = opcoes.includes(unidadeAtual) ? unidadeAtual : opcoes[0];
    selectUnidade.disabled = false;
  } else {
    // Preparo: unidade é sempre a do rendimento calculado dele — sem conversão, sem escolha.
    const rendimento = calcularRendimentoReceita(referenciaId);
    if (!rendimento.disponivel) {
      selectUnidade.innerHTML = '';
      return;
    }
    selectUnidade.innerHTML = `<option value="${rendimento.unidade}">${rendimento.unidade}</option>`;
    selectUnidade.disabled = true;
  }
}

function atualizarPreviewCustoItem() {
  const preview = document.getElementById('preview-custo-item');
  const tipo = document.getElementById('campo-tipo-item').value;
  const referenciaId = document.getElementById('campo-referencia-item').value;
  const quantidade = Number(document.getElementById('campo-quantidade-item').value);
  const unidade = document.getElementById('campo-unidade-item').value;

  if (tipo === 'ingredient') {
    const ingrediente = ingredientePorId(referenciaId);
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
    return;
  }

  // Preparo — mostra o próprio preparo (nome/rendimento/custo total/custo por unidade) e, se já houver quantidade, o custo estimado.
  const receitaSub = receitaPorId(referenciaId);
  const rendimentoSub = calcularRendimentoReceita(referenciaId);
  if (!receitaSub || !rendimentoSub.disponivel) {
    preview.textContent = '';
    return;
  }

  const cache = new Map();
  const custoTotalSub = custoTotalReceita(receitaSub.id, cache);
  const custoPorUnidadeSub = custoTotalSub / rendimentoSub.quantidade;

  let trechoEstimativa = '';
  if (Number.isFinite(quantidade) && quantidade > 0) {
    const custoEstimado = quantidade * custoPorUnidadeSub;
    trechoEstimativa = ` · Quantidade: ${formatarQuantidadeRendimento(quantidade)} ${unidade} · Custo estimado: ${formatarMoeda(custoEstimado)}`;
  }

  preview.textContent =
    `${receitaSub.nome} · Rendimento: ${formatarQuantidadeRendimento(rendimentoSub.quantidade)} ${rendimentoSub.unidade}` +
    ` · Custo total: ${formatarMoeda(custoTotalSub)} · Custo: ${formatarCustoPorRendimento(custoPorUnidadeSub, rendimentoSub.unidade)}` +
    trechoEstimativa;
}

async function adicionarItemReceita(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const receita = receitaAtualDetalhe();
  if (!receita) return;

  const tipo = document.getElementById('campo-tipo-item').value;
  const referenciaId = document.getElementById('campo-referencia-item').value;
  const quantidadeDigitada = Number(document.getElementById('campo-quantidade-item').value);
  const unidade = document.getElementById('campo-unidade-item').value;

  const dicaErro = document.getElementById('dica-item-erro');

  if (!referenciaId) {
    dicaErro.textContent = tipo === 'ingredient' ? 'Selecione um ingrediente.' : 'Selecione um preparo.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(quantidadeDigitada) || quantidadeDigitada <= 0) {
    dicaErro.textContent = 'Informe uma quantidade maior que zero.';
    dicaErro.style.display = '';
    return;
  }

  let quantidadeBase;
  let unidadeBase;

  if (tipo === 'ingredient') {
    const ingrediente = ingredientePorId(referenciaId);
    const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
    if (!ingrediente || !fator || !UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[ingrediente.tipoUnidade].includes(unidade)) {
      dicaErro.textContent = 'Unidade incompatível com o ingrediente selecionado.';
      dicaErro.style.display = '';
      return;
    }
    quantidadeBase = quantidadeDigitada * fator;
    unidadeBase = ingrediente.unidadeBase; // nunca a unidade digitada (ex. 'kg') — recipe_items sempre grava a unidade BASE
  } else {
    if (usarComoSubReceitaCriariaCiclo(receita.id, referenciaId)) {
      dicaErro.textContent = 'Esta sub-receita criaria uma dependência circular.';
      dicaErro.style.display = '';
      return;
    }
    quantidadeBase = quantidadeDigitada; // já na unidade de rendimento do preparo — sem conversão
    unidadeBase = unidade; // select travado (disabled), já é a unidade de rendimento do preparo
  }
  dicaErro.style.display = 'none';

  let novoItem;
  try {
    novoItem = await salvarItemReceitaNoSupabase({
      itemId: null,
      receitaId: receita.id,
      tipoItem: tipo,
      referenciaId,
      quantidade: quantidadeBase,
      unidade: unidadeBase,
    });
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível adicionar o item. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  itensReceitaCache.push(novoItem);
  document.getElementById('campo-quantidade-item').value = '';
  document.getElementById('preview-custo-item').textContent = '';

  renderizarDetalheFicha();
  renderizarTabelaReceitas();
  mostrarToast('Item adicionado.', 'sucesso');
}

// =============================================================================
// PRODUÇÃO DE ESPETOS — skewer_production_batches. Registra lotes reais de
// produção a partir de peças de carne com perda de limpeza. Só os campos
// brutos (peso bruto/útil, custo total, peso por espeto, quantidade real)
// são persistidos — perda, rendimento, custo bruto/útil, quantidade
// teórica, sobra teórica, custo teórico e custo real por espeto são SEMPRE
// calculados on-read por calcularIndicadoresLoteEspetos(), nunca gravados no
// banco. Nada aqui consulta product_costs nem altera estoque — isso é uma
// etapa futura, fora de escopo. Mesmo modal serve para criar e editar (item
// 22 do pedido) — não existe uma tela de "detalhe" separada.
// =============================================================================

let lotesEspetosCache = [];
let componentesLotesEspetosCache = [];
let componentesLoteEmEdicao = [];

async function carregarLotesEspetos() {
  const carregando = document.getElementById('estado-carregando-lotes-espetos');
  const erro = document.getElementById('estado-erro-lotes-espetos');

  try {
    const [lotes, componentes] = await Promise.all([buscarLotesEspetosDoSupabase(), buscarComponentesLotesEspetosDoSupabase()]);
    lotesEspetosCache = lotes;
    componentesLotesEspetosCache = componentes;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar lotes de produção de espetos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os lotes de produção. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  atualizarEstadoEdicaoLotesEspetos();
  renderizarTabelaLotesEspetos();
}

function atualizarEstadoEdicaoLotesEspetos() {
  const botaoNovo = document.getElementById('botao-novo-lote-espeto');
  const dica = document.getElementById('dica-espetos-somente-admin');
  botaoNovo.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

function produtoPorId(id) {
  return produtosCache.find((p) => p.id === id);
}

/** Componentes já salvos de um lote — histórico, nunca recalculado (mesmo padrão de itensDaReceita). */
function componentesDoLote(loteId) {
  return componentesLotesEspetosCache.filter((c) => c.loteId === loteId);
}

/** Tolerante a maiúsculas/minúsculas e espaços — "Temperos"/"temperos"/" TEMPEROS " todos batem. Sem migration, sem flag nova: usa ingredients.category já existente. */
function normalizarCategoria(texto) {
  return (texto || '').trim().toLowerCase();
}

/** Só ingredientes categorizados como Temperos aparecem no select de "Adicionar tempero/preparo" — evita listar toda a cozinha (Batata, Cenoura, etc.). Se Sal/Sal de Parrilha ainda não estiverem categorizados assim, o select fica vazio até isso ser feito na tela de Ingredientes. */
function ehIngredienteTempero(ingrediente) {
  return normalizarCategoria(ingrediente.categoria) === 'temperos';
}

// ---------------------------------------------------------------------------
// Cálculo — função pura única, usada na prévia do modal, na listagem e ao
// reabrir o modal pra editar. Retorna null quando as entradas não permitem
// calcular com segurança (mesmo padrão de custoLinhaItem em Fichas
// Técnicas: nunca deixar NaN/Infinity vazar pra tela).
// ---------------------------------------------------------------------------

/**
 * dados = { pesoBrutoG, pesoUtilG, custoTotal, pesoEspetoG, quantidadeReal }
 * (todos os pesos já em gramas — conversão kg->g acontece antes, na leitura
 * do formulário). Fórmulas exatamente como especificado: perda, rendimento,
 * custo bruto/útil por g e por kg, quantidade teórica (com sobra), custo
 * teórico e custo real por espeto (indicador principal), diferença
 * prevista x real.
 */
function calcularIndicadoresLoteEspetos(dados) {
  const { pesoBrutoG, pesoUtilG, custoTotal, pesoEspetoG, quantidadeReal } = dados;

  if (![pesoBrutoG, pesoUtilG, custoTotal, pesoEspetoG, quantidadeReal].every(Number.isFinite)) return null;
  if (pesoBrutoG <= 0 || pesoUtilG <= 0 || pesoEspetoG <= 0 || quantidadeReal <= 0) return null;
  if (custoTotal < 0) return null;
  if (pesoUtilG > pesoBrutoG) return null;

  const perdaG = pesoBrutoG - pesoUtilG;
  const perdaPercentual = (perdaG / pesoBrutoG) * 100;
  const rendimentoPercentual = (pesoUtilG / pesoBrutoG) * 100;

  const custoBrutoPorG = custoTotal / pesoBrutoG;
  const custoBrutoPorKg = custoBrutoPorG * 1000;
  const custoUtilPorG = custoTotal / pesoUtilG;
  const custoUtilPorKg = custoUtilPorG * 1000;

  // Arredonda a razão a 6 casas antes do floor — evita que imprecisão de
  // ponto flutuante (ex. 4200/140 chegando como 29.999999999) derrube a
  // quantidade teórica em 1 unidade por engano.
  const razaoEspetos = Math.round((pesoUtilG / pesoEspetoG) * 1e6) / 1e6;
  const quantidadeTeorica = Math.floor(razaoEspetos);
  const sobraTeoricaG = pesoUtilG - quantidadeTeorica * pesoEspetoG;

  const custoTeoricoPorEspeto = pesoEspetoG * custoUtilPorG;
  const custoRealPorEspeto = custoTotal / quantidadeReal;
  const diferencaQuantidade = quantidadeReal - quantidadeTeorica;

  return {
    perdaG,
    perdaPercentual,
    rendimentoPercentual,
    custoBrutoPorG,
    custoBrutoPorKg,
    custoUtilPorG,
    custoUtilPorKg,
    quantidadeTeorica,
    sobraTeoricaG,
    custoTeoricoPorEspeto,
    custoRealPorEspeto,
    diferencaQuantidade,
  };
}

/**
 * Segunda função pura, independente da anterior (calcularIndicadoresLoteEspetos
 * não é alterada) — soma o custo da carne aos componentes adicionais
 * (insumos + temperos/preparos). `componentes` é uma lista de
 * `{ tipoItem, quantidade, custoPorUnidadePreview }` — para componentes já
 * salvos (listagem) `custoPorUnidadePreview` é sempre o `custoPorUnidadeSnapshot`
 * histórico (nunca recalculado); para o modal de edição aberto, é o valor
 * mostrado na prévia daquele momento (ver nota sobre recipe ser
 * recalculado de novo só no instante de salvar, em salvarFormularioLoteEspeto).
 * Sem arredondamento intermediário — só na formatação final.
 */
function calcularCustosFinaisLoteEspetos(lote, componentes) {
  const somaPorTipo = (tipo) =>
    componentes.filter((c) => c.tipoItem === tipo).reduce((soma, c) => soma + c.quantidade * c.custoPorUnidadePreview, 0);

  const custoCarne = lote.custoTotal;
  const custoInsumos = somaPorTipo('supply');
  const custoIngredientes = somaPorTipo('ingredient');
  const custoPreparos = somaPorTipo('recipe');
  const custoTemperosTotal = custoIngredientes + custoPreparos;
  const custoComponentesTotal = custoInsumos + custoTemperosTotal;
  const custoFinalLote = custoCarne + custoComponentesTotal;
  const custoRealFinalPorEspeto = lote.quantidadeReal > 0 ? custoFinalLote / lote.quantidadeReal : null;

  return {
    custoCarne,
    custoInsumos,
    custoIngredientes,
    custoPreparos,
    custoTemperosTotal,
    custoComponentesTotal,
    custoFinalLote,
    custoRealFinalPorEspeto,
  };
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** >=1000g mostra em kg (2 casas, ex. "4,20 kg"); <1000g mostra em g (inteiro ou 1 casa). Nunca converte tudo pra kg (item 28 do pedido). */
function formatarPesoGramas(valorG) {
  if (!Number.isFinite(valorG)) return '—';
  if (Math.abs(valorG) >= 1000) {
    return (valorG / 1000).toFixed(2).replace('.', ',') + ' kg';
  }
  const texto = Number.isInteger(valorG) ? String(valorG) : valorG.toFixed(1).replace('.', ',');
  return texto + ' g';
}

/** 1 casa decimal, sem zero à direita desnecessário — "16%" / "16,7%". */
function formatarPercentual(valor) {
  if (!Number.isFinite(valor)) return '—';
  const arredondado = Math.round(valor * 10) / 10;
  const texto = Number.isInteger(arredondado) ? String(arredondado) : arredondado.toFixed(1).replace('.', ',');
  return texto + '%';
}

/** formatarMoeda já dá 2 casas (padrão do projeto) — só adiciona o "/kg". */
function formatarMoedaPorKg(valor) {
  if (!Number.isFinite(valor)) return '—';
  return formatarMoeda(valor) + '/kg';
}

/** 'YYYY-MM-DD' -> 'DD/MM/AAAA', sem passar por Date/fuso horário nenhum — produced_at é um date puro, nunca timestamptz (ver diagnóstico). */
function formatarDataProducao(dataIso) {
  if (!dataIso) return '';
  const partes = dataIso.split('-');
  if (partes.length !== 3) return dataIso;
  const [ano, mes, dia] = partes;
  return `${dia}/${mes}/${ano}`;
}

/** Data de hoje no fuso do navegador local, como 'YYYY-MM-DD' — nunca toISOString() (UTC), que poderia mostrar o dia errado. */
function dataHojeLocal() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

function renderizarTabelaLotesEspetos() {
  const corpo = document.getElementById('corpo-tabela-lotes-espetos');
  const vazio = document.getElementById('estado-vazio-lotes-espetos');

  if (lotesEspetosCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = lotesEspetosCache.map(linhaLoteEspetoHtml).join('');

  corpo.querySelectorAll('[data-acao-editar-lote]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalLoteEspeto(botao.dataset.acaoEditarLote));
  });
}

/**
 * Nome do produto sempre vem de produtosCache completo (nunca filtrado) — um
 * produto inativo ou fora de Espetinhos continua aparecendo em lotes antigos
 * (item 26 do pedido). Coluna de custo mostra o CUSTO REAL FINAL (carne +
 * insumos + temperos/preparos) — para componentes já salvos, sempre usando
 * custoPorUnidadeSnapshot histórico, nunca recalculado (dado persistido).
 * Lote sem componentes: custoComponentesTotal=0, resultado idêntico ao
 * cálculo antigo (zero regressão).
 */
function linhaLoteEspetoHtml(lote) {
  const indicadores = calcularIndicadoresLoteEspetos(lote);
  const produto = produtoPorId(lote.produtoId);
  const nomeProduto = produto ? produto.nome : '(produto removido)';

  const componentesSnapshot = componentesDoLote(lote.id).map((c) => ({
    tipoItem: c.tipoItem,
    quantidade: c.quantidade,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
  }));
  const custosFinais = calcularCustosFinaisLoteEspetos(lote, componentesSnapshot);

  const perdaTexto = indicadores ? `${formatarPesoGramas(indicadores.perdaG)} (${formatarPercentual(indicadores.perdaPercentual)})` : '—';
  const rendimentoTexto = indicadores ? formatarPercentual(indicadores.rendimentoPercentual) : '—';
  const custoRealFinalTexto = Number.isFinite(custosFinais.custoRealFinalPorEspeto)
    ? formatarMoeda(custosFinais.custoRealFinalPorEspeto)
    : '—';
  const custoCarneSecundario =
    custosFinais.custoComponentesTotal > 0 && indicadores
      ? `<br><span class="producao-custo-secundario">Carne: ${formatarMoeda(indicadores.custoRealPorEspeto)}</span>`
      : '';

  return `
    <tr>
      <td>${formatarDataProducao(lote.produzidoEm)}</td>
      <td>${escaparHtml(nomeProduto)}</td>
      <td>${formatarPesoGramas(lote.pesoBrutoG)}</td>
      <td>${formatarPesoGramas(lote.pesoUtilG)}</td>
      <td>${perdaTexto}</td>
      <td>${rendimentoTexto}</td>
      <td>${lote.quantidadeReal}</td>
      <td>${custoRealFinalTexto}${custoCarneSecundario}</td>
      <td>
        <button class="btn-icone" data-acao-editar-lote="${lote.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Opções de produto/ingrediente no modal — só ativos (e, pra produto, só
// categoria Espetinhos) pra um lote NOVO. product_id/ingredient_id
// continuam editáveis num lote existente (diferente de recipe_items, cujo
// tipo/referência é imutável), então ao editar um lote cujo produto/
// ingrediente não está mais na lista de ativos, ele é incluído como uma
// opção extra rotulada — preserva o valor correto no campo em vez de
// deixá-lo em branco ou trocar sozinho.
// ---------------------------------------------------------------------------

function popularOpcoesProdutoLote(produtoAtualId) {
  const select = document.getElementById('campo-produto-lote');
  const disponiveis = produtosCache
    .filter((p) => p.categoria === 'Espetinhos' && p.status === 'ativo')
    .sort((a, b) => a.nome.localeCompare(b.nome));

  let opcoesHtml = disponiveis.map((p) => `<option value="${p.id}">${escaparHtml(p.nome)}</option>`).join('');

  const atual = produtoAtualId ? produtoPorId(produtoAtualId) : null;
  if (atual && !disponiveis.some((p) => p.id === atual.id)) {
    opcoesHtml += `<option value="${atual.id}">${escaparHtml(atual.nome)} (inativo ou fora de Espetinhos)</option>`;
  }

  select.innerHTML = opcoesHtml;
}

function popularOpcoesIngredienteLote(ingredienteAtualId) {
  const select = document.getElementById('campo-ingrediente-lote');
  const ativos = ingredientesCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));

  let opcoesHtml = '<option value="">— Nenhum —</option>' + ativos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');

  const atual = ingredienteAtualId ? ingredientePorId(ingredienteAtualId) : null;
  if (atual && !ativos.some((i) => i.id === atual.id)) {
    opcoesHtml += `<option value="${atual.id}">${escaparHtml(atual.nome)} (inativo)</option>`;
  }

  select.innerHTML = opcoesHtml;
}

/** Só insumos ativos — igual ao padrão já usado pra produto/ingrediente do lote (item 27 do pedido: insumo inativo não aparece pra um componente NOVO). */
function popularOpcoesSupplyLote() {
  const select = document.getElementById('campo-supply-lote');
  const ativos = insumosProducaoCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));
  select.innerHTML = ativos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
}

/**
 * Tipo=Preparo: só receitas ativas com rendimento derivado disponível
 * (reaproveita calcularRendimentoReceita já existente, mesma regra usada em
 * popularOpcoesPreparoItem de Fichas Técnicas — sem duplicar). Tipo=
 * Ingrediente: só ingredientes ativos categorizados como Temperos
 * (ehIngredienteTempero). Item 28/29 do pedido: inativos nunca aparecem
 * aqui, só em componentes já salvos (componentesLoteEmEdicao carregado por
 * fora desta função).
 */
function popularOpcoesTemperoLote() {
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const select = document.getElementById('campo-referencia-tempero-lote');
  document.getElementById('rotulo-referencia-tempero-lote').textContent = tipo === 'recipe' ? 'Preparo' : 'Ingrediente';

  if (tipo === 'recipe') {
    const candidatos = receitasCache
      .filter((r) => r.ativo && calcularRendimentoReceita(r.id).disponivel)
      .sort((a, b) => a.nome.localeCompare(b.nome));
    select.innerHTML = candidatos.map((r) => `<option value="${r.id}">${escaparHtml(r.nome)}</option>`).join('');
  } else {
    const candidatos = ingredientesCache.filter((i) => i.ativo && ehIngredienteTempero(i)).sort((a, b) => a.nome.localeCompare(b.nome));
    select.innerHTML = candidatos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
  }
}

// ---------------------------------------------------------------------------
// Custos Adicionais — componentes do lote (insumo/ingrediente/preparo),
// estado só de memória (componentesLoteEmEdicao) até "Salvar Lote". A RPC
// substitui a lista inteira no banco (mesmo padrão já usado desde a Etapa
// 3B) — remover aqui só tira do estado do modal, nunca chama o Supabase
// isoladamente.
// ---------------------------------------------------------------------------

function insumoProducaoPorId(id) {
  return insumosProducaoCache.find((i) => i.id === id);
}

function renderizarListasComponentesLote() {
  const insumos = componentesLoteEmEdicao.filter((c) => c.tipoItem === 'supply');
  const temperos = componentesLoteEmEdicao.filter((c) => c.tipoItem !== 'supply');

  renderizarListaComponentes('lista-insumos-lote', 'estado-vazio-insumos-lote', insumos);
  renderizarListaComponentes('lista-temperos-lote', 'estado-vazio-temperos-lote', temperos);

  atualizarResumoCustosLote();
}

function renderizarListaComponentes(idLista, idVazio, itens) {
  const lista = document.getElementById(idLista);
  const vazio = document.getElementById(idVazio);

  if (itens.length === 0) {
    lista.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  lista.innerHTML = itens.map(linhaComponenteLoteHtml).join('');

  lista.querySelectorAll('[data-acao-remover-componente]').forEach((botao) => {
    botao.addEventListener('click', () => removerComponenteLote(Number(botao.dataset.acaoRemoverComponente)));
  });
}

/** Índice é sempre o índice real dentro de componentesLoteEmEdicao (não da sub-lista filtrada), pra remoção funcionar mesmo com as duas sub-listas intercaladas. */
function linhaComponenteLoteHtml(componente) {
  const indice = componentesLoteEmEdicao.indexOf(componente);
  const tipoLabel = componente.tipoItem === 'supply' ? 'Insumo' : componente.tipoItem === 'recipe' ? 'Preparo' : 'Ingrediente';
  const quantidadeTexto = Number.isInteger(componente.quantidade) ? componente.quantidade : componente.quantidade.toString().replace('.', ',');
  const custoLinha = componente.quantidade * componente.custoPorUnidadePreview;

  return `
    <div class="producao-linha-componente-lote">
      <span class="producao-linha-componente-nome">${escaparHtml(componente.nome)}</span>
      <span class="producao-linha-componente-tipo">${tipoLabel}</span>
      <span class="producao-linha-componente-quantidade">${quantidadeTexto} ${componente.unidade}</span>
      <span class="producao-linha-componente-custo">${formatarMoeda(custoLinha)}</span>
      <button type="button" class="btn-icone" data-acao-remover-componente="${indice}" title="Remover" ${souAdminProducao ? '' : 'disabled'}>🗑️</button>
    </div>`;
}

function removerComponenteLote(indice) {
  if (!souAdminProducao) return;
  componentesLoteEmEdicao.splice(indice, 1);
  renderizarListasComponentesLote();
}

/** Soma carne + componentes atuais do estado do modal — lida direto dos campos do formulário (carne) e de componentesLoteEmEdicao, sempre client-side. */
function atualizarResumoCustosLote() {
  const dados = lerDadosFormularioLoteEspeto();
  const loteParcial = { custoTotal: dados.custoTotal, quantidadeReal: dados.quantidadeReal };
  const custosFinais = calcularCustosFinaisLoteEspetos(loteParcial, componentesLoteEmEdicao);

  const definir = (id, texto) => {
    document.getElementById(id).textContent = texto;
  };

  definir('resumo-custo-carne', Number.isFinite(custosFinais.custoCarne) ? formatarMoeda(custosFinais.custoCarne) : '—');
  definir('resumo-custo-insumos', formatarMoeda(custosFinais.custoInsumos));
  definir('resumo-custo-temperos', formatarMoeda(custosFinais.custoTemperosTotal));
  definir('resumo-custo-final', Number.isFinite(custosFinais.custoFinalLote) ? formatarMoeda(custosFinais.custoFinalLote) : '—');
  definir('resumo-qtd-produzida', Number.isFinite(dados.quantidadeReal) && dados.quantidadeReal > 0 ? String(dados.quantidadeReal) : '—');
  definir(
    'resumo-custo-real-final',
    Number.isFinite(custosFinais.custoRealFinalPorEspeto) ? formatarMoeda(custosFinais.custoRealFinalPorEspeto) + '/espeto' : '—'
  );
}

// --- Insumos --------------------------------------------------------------

/** Se o insumo escolhido parece ser palito e a quantidade ainda está vazia, sugere quantidade = quantidade real do lote (item 9 do pedido) — só uma sugestão, sempre editável. */
function sugerirQuantidadePalito() {
  const insumo = insumoProducaoPorId(document.getElementById('campo-supply-lote').value);
  const campoQuantidade = document.getElementById('campo-quantidade-supply-lote');
  const quantidadeReal = document.getElementById('campo-quantidade-real-lote').value;

  if (insumo && /palito/i.test(insumo.nome) && !campoQuantidade.value && quantidadeReal) {
    campoQuantidade.value = quantidadeReal;
  }
}

/** Sempre usa o custo ATUAL de production_supplies (item 10 do pedido) — no payload de salvamento nunca se envia esse custo, a RPC resolve sozinha. */
function atualizarPreviewSupplyLote() {
  const preview = document.getElementById('preview-supply-lote');
  const insumo = insumoProducaoPorId(document.getElementById('campo-supply-lote').value);
  const quantidade = Number(document.getElementById('campo-quantidade-supply-lote').value);

  if (!insumo || !Number.isFinite(quantidade) || quantidade <= 0) {
    preview.textContent = '';
    return;
  }

  preview.textContent = `${quantidade} un × ${formatarCustoInsumo(insumo.custoPorUnidade)} = ${formatarMoeda(quantidade * insumo.custoPorUnidade)}`;
}

function adicionarComponenteSupply() {
  if (!souAdminProducao) return;
  const dicaErro = document.getElementById('dica-supply-lote-erro');
  const insumo = insumoProducaoPorId(document.getElementById('campo-supply-lote').value);
  const quantidade = Number(document.getElementById('campo-quantidade-supply-lote').value);

  if (!insumo) {
    dicaErro.textContent = 'Selecione um insumo.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    dicaErro.textContent = 'Informe uma quantidade maior que zero.';
    dicaErro.style.display = '';
    return;
  }
  if (componentesLoteEmEdicao.some((c) => c.tipoItem === 'supply' && c.referenciaId === insumo.id)) {
    dicaErro.textContent = 'Este insumo já foi adicionado a este lote.';
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  componentesLoteEmEdicao.push({
    tipoItem: 'supply',
    referenciaId: insumo.id,
    quantidade,
    unidade: 'un',
    nome: insumo.nome,
    custoPorUnidadePreview: insumo.custoPorUnidade,
  });

  document.getElementById('campo-quantidade-supply-lote').value = '';
  document.getElementById('preview-supply-lote').textContent = '';
  renderizarListasComponentesLote();
}

// --- Temperos / Preparos ----------------------------------------------------

function atualizarUnidadeTemperoLote() {
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
  const textoUnidade = document.getElementById('texto-unidade-tempero-lote');

  if (!referenciaId) {
    textoUnidade.textContent = '—';
    return;
  }
  if (tipo === 'recipe') {
    const rendimento = calcularRendimentoReceita(referenciaId);
    textoUnidade.textContent = rendimento.disponivel ? rendimento.unidade : '—';
  } else {
    const ingrediente = ingredientePorId(referenciaId);
    textoUnidade.textContent = ingrediente ? ingrediente.unidadeBase : '—';
  }
}

/** Reaproveita custoTotalReceita/calcularRendimentoReceita (Fichas Técnicas) pra Preparo, e cost_per_base_unit direto pra Ingrediente — nunca duplica fórmula (item 5/13/14 do pedido). */
function atualizarPreviewTemperoLote() {
  const preview = document.getElementById('preview-tempero-lote');
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
  const quantidade = Number(document.getElementById('campo-quantidade-tempero-lote').value);

  if (!referenciaId || !Number.isFinite(quantidade) || quantidade <= 0) {
    preview.textContent = '';
    return;
  }

  if (tipo === 'recipe') {
    const receita = receitaPorId(referenciaId);
    const rendimento = calcularRendimentoReceita(referenciaId);
    if (!receita || !rendimento.disponivel) {
      preview.textContent = '';
      return;
    }
    const custoTotalSub = custoTotalReceita(referenciaId, new Map());
    const custoPorUnidade = custoTotalSub / rendimento.quantidade;
    const custoEstimado = quantidade * custoPorUnidade;
    preview.textContent =
      `${receita.nome} · Rendimento: ${formatarQuantidadeRendimento(rendimento.quantidade)} ${rendimento.unidade} · ` +
      `Custo total: ${formatarMoeda(custoTotalSub)} · Custo: ${formatarCustoPorRendimento(custoPorUnidade, rendimento.unidade)} · ` +
      `Custo estimado: ${formatarMoeda(custoEstimado)}`;
  } else {
    const ingrediente = ingredientePorId(referenciaId);
    if (!ingrediente) {
      preview.textContent = '';
      return;
    }
    const custoEstimado = quantidade * ingrediente.custoPorUnidadeBase;
    preview.textContent = `${quantidade} ${ingrediente.unidadeBase} × ${formatarCustoBaseIngrediente(ingrediente.custoPorUnidadeBase, ingrediente.unidadeBase)} = ${formatarMoeda(custoEstimado)}`;
  }
}

function adicionarComponenteTempero() {
  if (!souAdminProducao) return;
  const dicaErro = document.getElementById('dica-tempero-lote-erro');
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
  const quantidade = Number(document.getElementById('campo-quantidade-tempero-lote').value);

  if (!referenciaId) {
    dicaErro.textContent = tipo === 'recipe' ? 'Selecione um preparo.' : 'Selecione um ingrediente.';
    dicaErro.style.display = '';
    return;
  }
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    dicaErro.textContent = 'Informe uma quantidade maior que zero.';
    dicaErro.style.display = '';
    return;
  }
  if (componentesLoteEmEdicao.some((c) => c.tipoItem === tipo && c.referenciaId === referenciaId)) {
    dicaErro.textContent = tipo === 'recipe' ? 'Este preparo já foi adicionado a este lote.' : 'Este ingrediente já foi adicionado a este lote.';
    dicaErro.style.display = '';
    return;
  }

  let nome;
  let unidade;
  let custoPorUnidadePreview;

  if (tipo === 'recipe') {
    const receita = receitaPorId(referenciaId);
    const rendimento = calcularRendimentoReceita(referenciaId);
    if (!receita || !rendimento.disponivel) {
      dicaErro.textContent = 'Este preparo não tem rendimento disponível.';
      dicaErro.style.display = '';
      return;
    }
    const custoTotalSub = custoTotalReceita(referenciaId, new Map());
    nome = receita.nome;
    unidade = rendimento.unidade;
    custoPorUnidadePreview = custoTotalSub / rendimento.quantidade;
  } else {
    const ingrediente = ingredientePorId(referenciaId);
    if (!ingrediente) {
      dicaErro.textContent = 'Ingrediente não encontrado.';
      dicaErro.style.display = '';
      return;
    }
    nome = ingrediente.nome;
    unidade = ingrediente.unidadeBase;
    custoPorUnidadePreview = ingrediente.custoPorUnidadeBase;
  }

  dicaErro.style.display = 'none';
  componentesLoteEmEdicao.push({ tipoItem: tipo, referenciaId, quantidade, unidade, nome, custoPorUnidadePreview });

  document.getElementById('campo-quantidade-tempero-lote').value = '';
  document.getElementById('preview-tempero-lote').textContent = '';
  renderizarListasComponentesLote();
}

// ---------------------------------------------------------------------------
// Modal: novo/editar lote
// ---------------------------------------------------------------------------

function ligarEventosModalLoteEspeto() {
  document.getElementById('botao-novo-lote-espeto').addEventListener('click', abrirModalNovoLoteEspeto);
  document.getElementById('botao-fechar-modal-lote-espeto').addEventListener('click', fecharModalLoteEspeto);
  document.getElementById('botao-cancelar-lote-espeto').addEventListener('click', fecharModalLoteEspeto);
  document.getElementById('modal-overlay-lote-espeto').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-lote-espeto') fecharModalLoteEspeto();
  });

  [
    'campo-peso-bruto-lote',
    'campo-unidade-peso-bruto-lote',
    'campo-peso-util-lote',
    'campo-unidade-peso-util-lote',
    'campo-custo-total-lote',
    'campo-peso-espeto-lote',
    'campo-quantidade-real-lote',
  ].forEach((idCampo) => {
    const campo = document.getElementById(idCampo);
    campo.addEventListener('input', atualizarPreviewLoteEspeto);
    campo.addEventListener('change', atualizarPreviewLoteEspeto);
  });

  document.getElementById('botao-excluir-lote-espeto').addEventListener('click', excluirLoteEspetoModal);
  document.getElementById('form-lote-espeto').addEventListener('submit', salvarFormularioLoteEspeto);

  document.getElementById('campo-supply-lote').addEventListener('change', () => {
    sugerirQuantidadePalito();
    atualizarPreviewSupplyLote();
  });
  document.getElementById('campo-quantidade-supply-lote').addEventListener('input', atualizarPreviewSupplyLote);
  document.getElementById('botao-adicionar-supply-lote').addEventListener('click', adicionarComponenteSupply);

  document.getElementById('campo-tipo-tempero-lote').addEventListener('change', () => {
    popularOpcoesTemperoLote();
    atualizarUnidadeTemperoLote();
    atualizarPreviewTemperoLote();
  });
  document.getElementById('campo-referencia-tempero-lote').addEventListener('change', () => {
    atualizarUnidadeTemperoLote();
    atualizarPreviewTemperoLote();
  });
  document.getElementById('campo-quantidade-tempero-lote').addEventListener('input', atualizarPreviewTemperoLote);
  document.getElementById('botao-adicionar-tempero-lote').addEventListener('click', adicionarComponenteTempero);
}

/** Lê um peso do formulário (par valor+unidade) já convertido pra gramas — reaproveita FATORES_CONVERSAO_UNIDADE_INGREDIENTE (kg:1000, g:1), a mesma tabela já usada em Ingredientes. */
function lerPesoEmGramas(idCampoValor, idCampoUnidade) {
  const valor = Number(document.getElementById(idCampoValor).value);
  const unidade = document.getElementById(idCampoUnidade).value;
  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
  if (!Number.isFinite(valor) || !fator) return NaN;
  return valor * fator;
}

function lerDadosFormularioLoteEspeto() {
  return {
    pesoBrutoG: lerPesoEmGramas('campo-peso-bruto-lote', 'campo-unidade-peso-bruto-lote'),
    pesoUtilG: lerPesoEmGramas('campo-peso-util-lote', 'campo-unidade-peso-util-lote'),
    custoTotal: Number(document.getElementById('campo-custo-total-lote').value),
    pesoEspetoG: Number(document.getElementById('campo-peso-espeto-lote').value),
    quantidadeReal: Number(document.getElementById('campo-quantidade-real-lote').value),
  };
}

/** >=1000g mostra em kg no campo (valor exato, divisão por 1000 sem perda de precisão); <1000g mostra em g. Usado só ao abrir o modal em modo edição (item 22 do pedido). */
function preencherCampoPeso(idValor, idUnidade, valorG) {
  if (valorG >= 1000) {
    document.getElementById(idValor).value = valorG / 1000;
    document.getElementById(idUnidade).value = 'kg';
  } else {
    document.getElementById(idValor).value = valorG;
    document.getElementById(idUnidade).value = 'g';
  }
}

/** Estado comum às duas subseções de Custos Adicionais, reiniciado toda vez que o modal abre (novo ou editar) — evita duplicar isso nas duas funções abaixo. */
function reiniciarFormularioCustosAdicionaisLote() {
  popularOpcoesSupplyLote();
  document.getElementById('campo-quantidade-supply-lote').value = '';
  document.getElementById('preview-supply-lote').textContent = '';
  document.getElementById('dica-supply-lote-erro').style.display = 'none';

  document.getElementById('campo-tipo-tempero-lote').value = 'recipe';
  popularOpcoesTemperoLote();
  atualizarUnidadeTemperoLote();
  document.getElementById('campo-quantidade-tempero-lote').value = '';
  document.getElementById('preview-tempero-lote').textContent = '';
  document.getElementById('dica-tempero-lote-erro').style.display = 'none';

  renderizarListasComponentesLote();
}

function abrirModalNovoLoteEspeto() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-lote-espeto').textContent = 'Novo Lote de Produção';
  document.getElementById('campo-id-lote-espeto').value = '';
  popularOpcoesProdutoLote(null);
  popularOpcoesIngredienteLote(null);
  document.getElementById('campo-produto-lote').value = '';
  document.getElementById('campo-ingrediente-lote').value = '';
  document.getElementById('campo-data-lote').value = dataHojeLocal();
  document.getElementById('campo-peso-bruto-lote').value = '';
  document.getElementById('campo-unidade-peso-bruto-lote').value = 'kg';
  document.getElementById('campo-peso-util-lote').value = '';
  document.getElementById('campo-unidade-peso-util-lote').value = 'kg';
  document.getElementById('campo-custo-total-lote').value = '';
  document.getElementById('campo-peso-espeto-lote').value = '';
  document.getElementById('campo-quantidade-real-lote').value = '';
  document.getElementById('dica-lote-espeto-erro').style.display = 'none';
  document.getElementById('botao-excluir-lote-espeto').style.display = 'none';

  componentesLoteEmEdicao = [];
  reiniciarFormularioCustosAdicionaisLote();

  atualizarPreviewLoteEspeto();
  abrirModal('modal-overlay-lote-espeto');
}

/**
 * Carrega os componentes já salvos (item 16 do pedido): nome/quantidade/
 * unidade/custo exatamente como estão em componentesDoLote (histórico, não
 * recalculado). Importante — isso é só a EXIBIÇÃO inicial; ao salvar,
 * ingredient/supply são sempre resolvidos de novo pela RPC e recipe é
 * sempre recalculado pelo client no momento do save (ver
 * salvarFormularioLoteEspeto) — comportamento documentado no item 17 do
 * pedido, não escondido (aviso também visível na própria UI, seção
 * Temperos/Preparos).
 */
function abrirModalLoteEspeto(id) {
  if (!souAdminProducao) return;
  const lote = lotesEspetosCache.find((l) => l.id === id);
  if (!lote) return;

  document.getElementById('titulo-modal-lote-espeto').textContent = 'Editar Lote de Produção';
  document.getElementById('campo-id-lote-espeto').value = lote.id;
  popularOpcoesProdutoLote(lote.produtoId);
  popularOpcoesIngredienteLote(lote.ingredienteId);
  document.getElementById('campo-produto-lote').value = lote.produtoId;
  document.getElementById('campo-ingrediente-lote').value = lote.ingredienteId || '';
  document.getElementById('campo-data-lote').value = lote.produzidoEm;

  preencherCampoPeso('campo-peso-bruto-lote', 'campo-unidade-peso-bruto-lote', lote.pesoBrutoG);
  preencherCampoPeso('campo-peso-util-lote', 'campo-unidade-peso-util-lote', lote.pesoUtilG);

  document.getElementById('campo-custo-total-lote').value = lote.custoTotal;
  document.getElementById('campo-peso-espeto-lote').value = lote.pesoEspetoG;
  document.getElementById('campo-quantidade-real-lote').value = lote.quantidadeReal;
  document.getElementById('dica-lote-espeto-erro').style.display = 'none';
  document.getElementById('botao-excluir-lote-espeto').style.display = souAdminProducao ? '' : 'none';

  componentesLoteEmEdicao = componentesDoLote(lote.id).map((c) => ({
    tipoItem: c.tipoItem,
    referenciaId: c.ingredienteId || c.receitaId || c.insumoId,
    quantidade: c.quantidade,
    unidade: c.unidade,
    nome: c.nomeSnapshot,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
  }));
  reiniciarFormularioCustosAdicionaisLote();

  atualizarPreviewLoteEspeto();
  abrirModal('modal-overlay-lote-espeto');
}

function fecharModalLoteEspeto() {
  fecharModal('modal-overlay-lote-espeto');
}

/** Recalculada a cada tecla/troca de unidade, sempre client-side — nunca consulta o Supabase (item 19 do pedido). */
function atualizarPreviewLoteEspeto() {
  const dados = lerDadosFormularioLoteEspeto();
  const indicadores = calcularIndicadoresLoteEspetos(dados);
  preencherPreviewLoteEspeto(dados, indicadores);
  atualizarResumoCustosLote();
}

function preencherPreviewLoteEspeto(dados, indicadores) {
  const definir = (id, texto) => {
    document.getElementById(id).textContent = texto;
  };

  definir('preview-peso-bruto', Number.isFinite(dados.pesoBrutoG) ? formatarPesoGramas(dados.pesoBrutoG) : '—');
  definir('preview-peso-util', Number.isFinite(dados.pesoUtilG) ? formatarPesoGramas(dados.pesoUtilG) : '—');

  if (!indicadores) {
    [
      'preview-perda',
      'preview-rendimento',
      'preview-custo-bruto',
      'preview-custo-util',
      'preview-qtd-teorica',
      'preview-sobra-teorica',
      'preview-qtd-real',
      'preview-diferenca',
      'preview-custo-teorico',
      'preview-custo-real',
    ].forEach((id) => definir(id, '—'));
    return;
  }

  definir('preview-perda', `${formatarPesoGramas(indicadores.perdaG)} (${formatarPercentual(indicadores.perdaPercentual)})`);
  definir('preview-rendimento', formatarPercentual(indicadores.rendimentoPercentual));
  definir('preview-custo-bruto', formatarMoedaPorKg(indicadores.custoBrutoPorKg));
  definir('preview-custo-util', formatarMoedaPorKg(indicadores.custoUtilPorKg));
  definir('preview-qtd-teorica', String(indicadores.quantidadeTeorica));
  definir('preview-sobra-teorica', formatarPesoGramas(indicadores.sobraTeoricaG));
  definir('preview-qtd-real', String(dados.quantidadeReal));
  definir('preview-diferenca', (indicadores.diferencaQuantidade > 0 ? '+' : '') + indicadores.diferencaQuantidade);
  definir('preview-custo-teorico', formatarMoeda(indicadores.custoTeoricoPorEspeto) + '/espeto');
  definir('preview-custo-real', formatarMoeda(indicadores.custoRealPorEspeto) + '/espeto');
}

/** Espelha no cliente os CHECKs do banco, só pra feedback mais rápido — o banco continua a fonte real. */
function validarFormularioLoteEspeto({ produtoId, dataProducao, pesoBrutoG, pesoUtilG, custoTotal, pesoEspetoG, quantidadeReal }) {
  if (!produtoId) return 'Selecione o produto.';
  if (!dataProducao) return 'Informe a data da produção.';
  if (!Number.isFinite(pesoBrutoG) || pesoBrutoG <= 0) return 'Informe um peso bruto válido, maior que zero.';
  if (!Number.isFinite(pesoUtilG) || pesoUtilG <= 0) return 'Informe um peso após limpeza válido, maior que zero.';
  if (pesoUtilG > pesoBrutoG) return 'O peso após limpeza não pode ser maior que o peso bruto.';
  if (!Number.isFinite(custoTotal) || custoTotal < 0) return 'Informe um valor total válido (não pode ser negativo).';
  if (!Number.isFinite(pesoEspetoG) || pesoEspetoG <= 0) return 'Informe o peso padrão por espeto, maior que zero.';
  if (!Number.isFinite(quantidadeReal) || quantidadeReal <= 0 || !Number.isInteger(quantidadeReal)) {
    return 'Informe a quantidade realmente produzida, um número inteiro maior que zero.';
  }
  return null;
}

/**
 * Monta o payload de componentes pro service/RPC a partir do estado do
 * modal. ingredient/supply nunca levam custo (a RPC resolve sozinha,
 * sempre com o valor atual). recipe é a ÚNICA exceção: o custo é sempre
 * RECALCULADO AGORA (nunca reaproveita custoPorUnidadePreview, que pode ter
 * sido carregado de um snapshot antigo ao abrir o modal) — mesma disciplina
 * documentada no item 17 do pedido: editar o lote redefine seu estado
 * final, então um preparo usado num lote antigo passa a refletir o custo
 * atual da ficha técnica no momento do save, não o que estava salvo antes.
 */
function montarComponentesPayloadParaSalvar() {
  return componentesLoteEmEdicao.map((componente) => {
    if (componente.tipoItem !== 'recipe') {
      return {
        tipoItem: componente.tipoItem,
        referenciaId: componente.referenciaId,
        quantidade: componente.quantidade,
        unidade: componente.unidade,
      };
    }

    const rendimento = calcularRendimentoReceita(componente.referenciaId);
    const custoPorUnidadeAtual = rendimento.disponivel
      ? custoTotalReceita(componente.referenciaId, new Map()) / rendimento.quantidade
      : componente.custoPorUnidadePreview;

    return {
      tipoItem: 'recipe',
      referenciaId: componente.referenciaId,
      quantidade: componente.quantidade,
      unidade: componente.unidade,
      custoPorUnidadeSnapshot: custoPorUnidadeAtual,
    };
  });
}

async function salvarFormularioLoteEspeto(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const id = document.getElementById('campo-id-lote-espeto').value;
  const produtoId = document.getElementById('campo-produto-lote').value;
  const ingredienteId = document.getElementById('campo-ingrediente-lote').value || null;
  const dataProducao = document.getElementById('campo-data-lote').value;
  const dados = lerDadosFormularioLoteEspeto();

  const erroValidacao = validarFormularioLoteEspeto({ produtoId, dataProducao, ...dados });
  const dicaErro = document.getElementById('dica-lote-espeto-erro');
  if (erroValidacao) {
    dicaErro.textContent = erroValidacao;
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const payload = {
    produtoId,
    ingredienteId,
    produzidoEm: dataProducao,
    pesoBrutoG: dados.pesoBrutoG,
    pesoUtilG: dados.pesoUtilG,
    custoTotal: dados.custoTotal,
    pesoEspetoG: dados.pesoEspetoG,
    quantidadeReal: dados.quantidadeReal,
    componentes: montarComponentesPayloadParaSalvar(),
  };

  try {
    if (id) {
      await atualizarLoteEspetosNoSupabase(id, payload);
    } else {
      await criarLoteEspetosNoSupabase(payload);
    }
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar o lote. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  mostrarToast('Lote de produção salvo.', 'sucesso');
  fecharModalLoteEspeto();

  try {
    const [lotes, componentes] = await Promise.all([buscarLotesEspetosDoSupabase(), buscarComponentesLotesEspetosDoSupabase()]);
    lotesEspetosCache = lotes;
    componentesLotesEspetosCache = componentes;
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar lotes de produção:', erroRecarregar);
  }
  renderizarTabelaLotesEspetos();
}

/** Exclusão física — admin only, confirmação explícita. Nenhuma tabela referencia skewer_production_batches ainda, então nenhum erro de FK é esperado. */
async function excluirLoteEspetoModal() {
  const id = document.getElementById('campo-id-lote-espeto').value;
  if (!id || !souAdminProducao) return;
  const lote = lotesEspetosCache.find((l) => l.id === id);
  if (!lote) return;

  if (!confirm('Excluir este lote de produção?\n\nEsta ação remove o registro de produção.')) return;

  try {
    await excluirLoteEspetosNoSupabase(id);
  } catch (erro) {
    mostrarToast('Não foi possível excluir o lote. ' + erro.message, 'erro');
    return;
  }

  lotesEspetosCache = lotesEspetosCache.filter((l) => l.id !== id);
  componentesLotesEspetosCache = componentesLotesEspetosCache.filter((c) => c.loteId !== id);
  fecharModalLoteEspeto();
  renderizarTabelaLotesEspetos();
  mostrarToast('Lote de produção excluído.', 'sucesso');
}

// =============================================================================
// INSUMOS DE PRODUÇÃO — production_supplies (Etapa 3A). Cadastro standalone
// de insumos contados por unidade (palito de espeto hoje; embalagem/bandeja
// no futuro, sem migration nova — só uma linha nova aqui). Custo por
// unidade (custoPorUnidade) vem sempre de cost_per_unit, coluna GERADA no
// banco (purchase_price / purchase_quantity) — nunca calculado nem digitado
// aqui. NENHUMA integração com skewer_production_batches/lotes ainda — essa
// leitura só entra na Etapa 3B (skewer_batch_components + RPC
// save_skewer_production_batch).
// =============================================================================

function atualizarEstadoEdicaoInsumos() {
  const botaoNovo = document.getElementById('botao-novo-insumo');
  const dica = document.getElementById('dica-insumos-somente-admin');
  botaoNovo.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

/** "€0,012000/un" — mesma disciplina de formatarCustoBaseIngrediente (nunca esconder precisão real). */
function formatarCustoInsumo(valor) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  return '€' + valor.toFixed(6).replace('.', ',') + '/un';
}

/** "1000 un" — quantidade comprada, sempre em unidades inteiras nesta V1. */
function formatarQuantidadeInsumo(insumo) {
  const quantidade = insumo.quantidadeCompra;
  const texto = Number.isInteger(quantidade) ? String(quantidade) : String(quantidade).replace('.', ',');
  return `${texto} un`;
}

function renderizarTabelaInsumos() {
  const corpo = document.getElementById('corpo-tabela-insumos');
  const vazio = document.getElementById('estado-vazio-insumos');

  if (insumosProducaoCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = insumosProducaoCache.map(linhaInsumoHtml).join('');

  corpo.querySelectorAll('[data-acao-editar-insumo]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalInsumo(botao.dataset.acaoEditarInsumo));
  });
}

function linhaInsumoHtml(insumo) {
  return `
    <tr>
      <td>${escaparHtml(insumo.nome)}</td>
      <td>${escaparHtml(formatarQuantidadeInsumo(insumo))}</td>
      <td>${formatarMoeda(insumo.precoCompra)}</td>
      <td>${formatarCustoInsumo(insumo.custoPorUnidade)}</td>
      <td>${formatarData(insumo.atualizadoEm)}</td>
      <td><span class="badge badge-${insumo.ativo ? 'ativo' : 'inativo'}">${insumo.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>
        <button class="btn-icone" data-acao-editar-insumo="${insumo.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function ligarEventosModalInsumo() {
  document.getElementById('botao-novo-insumo').addEventListener('click', abrirModalNovoInsumo);
  document.getElementById('botao-fechar-modal-insumo').addEventListener('click', fecharModalInsumo);
  document.getElementById('botao-cancelar-insumo').addEventListener('click', fecharModalInsumo);
  document.getElementById('modal-overlay-insumo').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-insumo') fecharModalInsumo();
  });

  document.getElementById('campo-quantidade-insumo').addEventListener('input', atualizarPreviewCustoInsumo);
  document.getElementById('campo-preco-insumo').addEventListener('input', atualizarPreviewCustoInsumo);

  document.getElementById('form-insumo').addEventListener('submit', salvarFormularioInsumo);
}

function atualizarPreviewCustoInsumo() {
  const preview = document.getElementById('preview-custo-insumo');
  const quantidade = Number(document.getElementById('campo-quantidade-insumo').value);
  const preco = Number(document.getElementById('campo-preco-insumo').value);

  if (!Number.isFinite(quantidade) || quantidade <= 0 || !Number.isFinite(preco) || preco < 0) {
    preview.textContent = '';
    return;
  }

  const custo = preco / quantidade;
  const quantidadeTexto = Number.isInteger(quantidade) ? quantidade : quantidade.toString().replace('.', ',');

  preview.textContent = `${quantidadeTexto} unidades por ${formatarMoeda(preco)} · Custo unitário: ${formatarCustoInsumo(custo)}`;
}

function abrirModalNovoInsumo() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-insumo').textContent = 'Novo Insumo';
  document.getElementById('campo-id-insumo').value = '';
  document.getElementById('campo-nome-insumo').value = '';
  document.getElementById('campo-quantidade-insumo').value = '';
  document.getElementById('campo-preco-insumo').value = '';
  document.getElementById('campo-status-insumo').value = 'ativo';
  document.getElementById('dica-insumo-erro').style.display = 'none';

  atualizarPreviewCustoInsumo();
  abrirModal('modal-overlay-insumo');
}

function abrirModalInsumo(id) {
  if (!souAdminProducao) return;
  const insumo = insumosProducaoCache.find((i) => i.id === id);
  if (!insumo) return;

  document.getElementById('titulo-modal-insumo').textContent = 'Editar Insumo';
  document.getElementById('campo-id-insumo').value = insumo.id;
  document.getElementById('campo-nome-insumo').value = insumo.nome;
  document.getElementById('campo-quantidade-insumo').value = insumo.quantidadeCompra;
  document.getElementById('campo-preco-insumo').value = insumo.precoCompra;
  document.getElementById('campo-status-insumo').value = insumo.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-insumo-erro').style.display = 'none';

  atualizarPreviewCustoInsumo();
  abrirModal('modal-overlay-insumo');
}

function fecharModalInsumo() {
  fecharModal('modal-overlay-insumo');
}

/** Espelha no cliente os CHECKs do banco, só pra feedback mais rápido — o banco continua a fonte real. */
function validarFormularioInsumo({ nome, quantidade, preco }) {
  if (!nome) return 'Informe o nome do insumo.';
  if (!Number.isFinite(quantidade) || quantidade <= 0) return 'Informe uma quantidade comprada maior que zero.';
  if (!Number.isFinite(preco) || preco < 0) return 'Informe um preço pago válido (não pode ser negativo).';
  return null;
}

async function salvarFormularioInsumo(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const id = document.getElementById('campo-id-insumo').value;
  const nome = document.getElementById('campo-nome-insumo').value.trim();
  const quantidade = Number(document.getElementById('campo-quantidade-insumo').value);
  const preco = Number(document.getElementById('campo-preco-insumo').value);
  const ativo = document.getElementById('campo-status-insumo').value === 'ativo';

  const erroValidacao = validarFormularioInsumo({ nome, quantidade, preco });
  const dicaErro = document.getElementById('dica-insumo-erro');
  if (erroValidacao) {
    dicaErro.textContent = erroValidacao;
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const dados = { nome, quantidadeCompra: quantidade, precoCompra: preco, ativo };

  try {
    if (id) {
      await atualizarInsumoProducaoNoSupabase(id, dados);
    } else {
      await criarInsumoProducaoNoSupabase(dados);
    }
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar o insumo. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  mostrarToast('Insumo salvo.', 'sucesso');
  fecharModalInsumo();

  try {
    insumosProducaoCache = await buscarInsumosProducaoDoSupabase();
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar insumos:', erroRecarregar);
  }
  renderizarTabelaInsumos();
}
