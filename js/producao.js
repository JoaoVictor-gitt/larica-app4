/*
 * producao.js
 * Lógica da área Produção — Fichas Técnicas. (Fase C, 2026-11-24: a produção de espetos e
 * acompanhamentos saiu deste arquivo e foi reescrita em js/producao-lotes.js, sem lotes;
 * o texto abaixo descreve o histórico da Ficha Técnica.) Etapa 2: aba Fichas Técnicas com ingredientes
 * simples. Etapa 3: sub-receitas (item_type='recipe' — um item de receita
 * pode ser outro preparo) + exclusão de ficha técnica. Produção de Espetos:
 * terceira aba, lotes reais de produção a partir de peças de carne com
 * perda de limpeza (skewer_production_batches) — perda, rendimento e custos
 * sempre calculados on-read (calcularIndicadoresLoteEspetos), nunca
 * persistidos, nunca lidos de product_costs (isso só entra numa etapa
 * futura). Ingredientes (public.ingredients): desde a Etapa J5, esta página
 * não tem mais cadastro próprio para eles — Compras -> Itens de Compra é a
 * única porta de criação/edição (auto-vínculo/categoria via
 * save_purchase_item/finalize_purchase_item, Etapas J3/J4). Aqui só se
 * CONSOME ingredients já existentes: ingredientesCache é lido
 * (buscarIngredientesDoSupabase) e usado por Fichas Técnicas, pelo seletor
 * "Tipo = Ingrediente" + lote em Produção de Espetos/Acompanhamentos e pelo
 * filtro de Temperos (ehIngredienteTempero). Insumos de produção
 * (production_supplies — palito, embalagem etc.): desde a Etapa I4, esta
 * página também não tem mais cadastro próprio para eles — mesma lógica,
 * via Compras (auto-vínculo de category IN ('supply','packaging'), Etapa
 * I2). Aqui só se CONSOME production_supplies já existentes:
 * insumosProducaoCache é lido (buscarInsumosProducaoDoSupabase) e usado
 * pelo seletor "Tipo = Insumo" + lote (Etapa I3) dentro de Produção de
 * Espetos. Depende de utils.js, js/services/ingredients-service.js,
 * js/services/recipes-service.js, js/services/products-service.js,
 * js/services/skewer-production-service.js e
 * js/services/production-supplies-service.js (só a função de leitura é
 * usada em ambos — criar/atualizar/desativar/excluir ficam sem chamador
 * nesta página).
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
 * ingredientesCache é carregado uma única vez no DOMContentLoaded desta
 * página — uma criação/edição feita em Compras (Etapas J3/J4) só aparece
 * aqui na próxima vez que esta página for aberta/recarregada, nunca ao
 * vivo. Os cálculos de custo sempre fazem ingredientesCache.find(...) na
 * hora de ler (nunca guardam uma cópia à parte), então refletem qualquer
 * valor já presente no cache sem esforço extra de sincronização.
 */

const FATORES_CONVERSAO_UNIDADE_INGREDIENTE = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 };
const UNIDADES_COMPRA_POR_TIPO_INGREDIENTE = { peso: ['kg', 'g'], volume: ['L', 'ml'], contagem: ['un'] };
const UNIDADE_BASE_POR_TIPO_INGREDIENTE = { peso: 'g', volume: 'ml', contagem: 'un' };

let ingredientesCache = [];
let produtosCache = [];
let insumosProducaoCache = [];
let custosProdutosCache = new Map();
let souAdminProducao = false;

/**
 * Cada seção roda no seu próprio try/catch — uma exceção em qualquer uma
 * (ex. ao ligar eventos de um modal) nunca mais impede as seguintes de
 * iniciar. Antes desta correção, o DOMContentLoaded inteiro era uma cadeia
 * síncrona sem isolamento: uma falha em qualquer chamada anterior deixava
 * as seções seguintes presas em "Carregando..." pra sempre, sem erro
 * nenhum no console. Ver finalizarSecaoComErro().
 */
document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoProducao();

  try {
    const [ingredientes, ehAdmin, produtos, insumos, custosProdutos] = await Promise.all([
      buscarIngredientesDoSupabase(),
      usuarioEhAdminNoSupabase(),
      buscarProdutosDoSupabase(),
      buscarInsumosProducaoDoSupabase(),
      buscarCustosProdutosDoSupabase(),
    ]);
    ingredientesCache = ingredientes;
    souAdminProducao = ehAdmin;
    produtosCache = produtos;
    insumosProducaoCache = insumos;
    custosProdutosCache = new Map(
      custosProdutos.map((l) => [l.product_id, l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost)])
    );

  } catch (erroCarregamento) {
    console.error('Erro ao carregar dados iniciais de Produção:', erroCarregamento);
    // Ingredientes/Produtos/Insumos (cache de leitura) são carregados juntos
    // aqui — se isso falhar, as seções que dependem desses dados precisam
    // mostrar erro, nunca ficar presas em "Carregando...". Insumos de
    // Produção não tem mais seção própria (Etapa I4) — só o cache
    // (insumosProducaoCache) é afetado por uma falha aqui, refletido
    // indiretamente no formulário de Insumo dentro de Produção de Espetos.
    // Ingredientes (Etapa J5) também não tem mais seção própria — o cache
    // continua carregado aqui pra Fichas Técnicas/Espetos/Acompanhamentos.
    finalizarSecaoComErro('estado-carregando-receitas', 'estado-erro-receitas', erroCarregamento);
    return;
  }

  try {
    ligarEventosModalNovaFicha();
    ligarEventosModalDetalheFicha();
    await carregarFichasTecnicas();
  } catch (erroFichas) {
    console.error('Erro ao preparar Fichas Técnicas:', erroFichas);
    finalizarSecaoComErro('estado-carregando-receitas', 'estado-erro-receitas', erroFichas);
  }
});

/** Garante que uma seção nunca fique presa em "Carregando..." — usada tanto pela falha do bloco de dados compartilhados quanto por qualquer exceção síncrona ao preparar uma seção específica. */
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
// Formatação
// ---------------------------------------------------------------------------

/** "€0,001600/g" — mais casas decimais do que formatarMoeda (2) permite, então é um formatador próprio. */
function formatarCustoBaseIngrediente(valor, unidadeBase) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  return '€' + valor.toFixed(6).replace('.', ',') + '/' + unidadeBase;
}

// ---------------------------------------------------------------------------
// Modal (genérico — compartilhado por todos os modais da página)
// ---------------------------------------------------------------------------

function abrirModal(idOverlay) {
  document.getElementById(idOverlay).classList.add('modal-visivel');
}

function fecharModal(idOverlay) {
  document.getElementById(idOverlay).classList.remove('modal-visivel');
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
// INSUMOS DE PRODUÇÃO — Etapa I4: o CRUD standalone (cadastro/edição de
// production_supplies) foi removido desta página. Compras → Itens de Compra
// é agora a única porta de cadastro (save_purchase_item/finalize_purchase_item,
// auto-vínculo de category IN ('supply','packaging'), Etapa I2). Esta página
// continua só CONSUMINDO production_supplies já existentes — leitura
// (buscarInsumosProducaoDoSupabase -> insumosProducaoCache, carregada no
// Promise.all inicial), itemCompraDoInsumo/insumoProducaoPorId e todo o
// fluxo de seleção de insumo+lote em Produção de Espetos (Etapa I3)
// permanecem intocados, mais acima neste arquivo.
// =============================================================================
