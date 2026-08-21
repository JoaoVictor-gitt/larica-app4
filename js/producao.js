/*
 * producao.js
 * Lógica da área Produção. Etapa 2: aba Fichas Técnicas com ingredientes
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

// Etapa G4 — Compras/Lotes: caches carregados uma única vez no
// DOMContentLoaded (js/services/purchases-service.js), nunca recarregados
// por render/seleção — só usados para popular o seletor de lote nos
// componentes item_type='ingredient' de Espetos/Acompanhamentos.
let lotesCache = [];
let itensCompraCache = [];
let movimentosLotesCache = [];

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
    finalizarSecaoComErro('estado-carregando-lotes-espetos', 'estado-erro-lotes-espetos', erroCarregamento);
    finalizarSecaoComErro('estado-carregando-acompanhamentos', 'estado-erro-acompanhamentos', erroCarregamento);
    return;
  }

  // Etapa G4 — Compras/Lotes: isolado do bloco essencial acima de propósito.
  // Uma falha aqui (ex. RLS ainda não ajustada pra purchase_items/lots/
  // lot_movements) nunca pode derrubar Ingredientes/Fichas Técnicas/Espetos/
  // Acompanhamentos — lotesCache/itensCompraCache/movimentosLotesCache
  // continuam [] (valor inicial), e todo helper da G4 já é seguro com arrays
  // vazios: o seletor de lote (inclusive de Insumo, Etapa I3) só mostra
  // "nenhum lote disponível" em vez de quebrar qualquer coisa. Erro nunca
  // escondido — sempre logado no console.
  try {
    const [lotes, itensCompra, movimentosLotes] = await Promise.all([
      buscarLotesDoSupabase(),
      buscarItensCompraDoSupabase(),
      buscarMovimentosLotesDoSupabase(),
    ]);
    lotesCache = lotes;
    itensCompraCache = itensCompra;
    movimentosLotesCache = movimentosLotes;
  } catch (erroLotesCompra) {
    console.error('Erro ao carregar dados de Compras/Lotes (seletor de lote ficará indisponível):', erroLotesCompra);
  }

  try {
    ligarEventosModalNovaFicha();
    ligarEventosModalDetalheFicha();
    await carregarFichasTecnicas();
  } catch (erroFichas) {
    console.error('Erro ao preparar Fichas Técnicas:', erroFichas);
    finalizarSecaoComErro('estado-carregando-receitas', 'estado-erro-receitas', erroFichas);
  }

  try {
    ligarEventosModalLoteEspeto();
    await carregarLotesEspetos();
  } catch (erroLotes) {
    console.error('Erro ao preparar Produção de Espetos:', erroLotes);
    finalizarSecaoComErro('estado-carregando-lotes-espetos', 'estado-erro-lotes-espetos', erroLotes);
  }

  try {
    ligarEventosModalLoteAcompanhamento();
    await carregarLotesAcompanhamentos();
  } catch (erroAcompanhamentos) {
    console.error('Erro ao preparar Produção de Acompanhamentos:', erroAcompanhamentos);
    finalizarSecaoComErro('estado-carregando-acompanhamentos', 'estado-erro-acompanhamentos', erroAcompanhamentos);
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
// Etapa G4 — Compras/Lotes: seleção de lote em componentes item_type=
// 'ingredient' de Espetos/Acompanhamentos. Nunca faz query nova (tudo
// derivado dos 3 caches carregados uma vez no DOMContentLoaded). FIFO é só
// sugestão visual — nunca decide sozinho, nunca pré-seleciona.
// ---------------------------------------------------------------------------

/** No máximo 1 purchase_item por ingredient_id — já garantido pelo UNIQUE INDEX parcial de Compras (Etapa A). */
function itemCompraDoIngrediente(ingredienteId) {
  return itensCompraCache.find((i) => i.ingredienteId === ingredienteId);
}

/** Etapa I3: mesmo padrão de itemCompraDoIngrediente, para o vínculo de insumos (production_supply_id). */
function itemCompraDoInsumo(insumoId) {
  return itensCompraCache.find((i) => i.insumoId === insumoId);
}

function itemCompraPorId(id) {
  return itensCompraCache.find((i) => i.id === id);
}

function lotePorId(id) {
  return lotesCache.find((l) => l.id === id);
}

/** Lotes ATIVOS (status='available' + saldo>0) de um purchase_item, ordenados FIFO (recebidoEm ASC, depois id) — só sugestão de exibição. */
function lotesDisponiveisDoItemCompra(itemCompraId) {
  return lotesCache
    .filter((l) => l.itemCompraId === itemCompraId && l.status === 'available' && l.quantidadeRestante > 0)
    .sort((a, b) => (a.recebidoEm < b.recebidoEm ? -1 : a.recebidoEm > b.recebidoEm ? 1 : a.id.localeCompare(b.id)));
}

/**
 * Consumo líquido ATUAL de um lote dentro de UM batch específico, a partir
 * do ledger (nunca dos componentes atuais em memória) — mesma fórmula já
 * usada nas RPCs save_ e delete_ (Etapas G2/G3): SUM(production_use) -
 * SUM(reversal). origemTipo é 'skewer_production'/'side_production'.
 */
function consumoLiquidoLoteNoBatch(loteId, origemTipo, batchId) {
  return movimentosLotesCache
    .filter((m) => m.loteId === loteId && m.origemTipo === origemTipo && m.origemId === batchId)
    .reduce((soma, m) => soma + (m.tipo === 'production_use' ? m.quantidade : m.tipo === 'reversal' ? -m.quantidade : 0), 0);
}

/**
 * Disponibilidade EFETIVA de um lote para fins de validação client-side:
 * saldo atual + o que este batch já consumiu líquido dele. Sem isso, editar
 * um componente já salvo (ex. 500g já consumidos, saldo atual 200g)
 * pareceria "saldo insuficiente" mesmo reenviando os mesmos 500g. batchId
 * null (produção nova) retorna só o saldo puro do lote.
 */
function saldoEfetivoLoteParaEdicao(loteId, origemTipo, batchId) {
  const lote = lotePorId(loteId);
  if (!lote) return 0;
  if (!batchId) return lote.quantidadeRestante;
  return lote.quantidadeRestante + consumoLiquidoLoteNoBatch(loteId, origemTipo, batchId);
}

/**
 * "DD/MM/YYYY · 700 g · €0,007143/g", com sufixos conforme o estado: "· Val.
 * DD/MM/YYYY" (se houver validade), "· Esgotado" (status='depleted'), "· ⚠
 * Vencido" (validade no passado). usadoNesteBatch força "· Usado neste lote"
 * — usada só para a opção histórica de um componente já salvo.
 */
function rotuloLote(lote, opcoes) {
  const usadoNesteBatch = (opcoes && opcoes.usadoNesteBatch) || false;
  const partes = [
    formatarDataProducao(lote.recebidoEm),
    `${formatarQuantidadeRendimento(lote.quantidadeRestante)} ${lote.unidadeBase}`,
    formatarCustoBaseIngrediente(lote.custoPorUnidadeBase, lote.unidadeBase),
  ];
  if (lote.validade) partes.push(`Val. ${formatarDataProducao(lote.validade)}`);
  if (lote.status === 'depleted') partes.push('Esgotado');
  if (lote.validade && lote.validade < dataHojeLocal()) partes.push('⚠ Vencido');
  if (usadoNesteBatch) partes.push('Usado neste lote');
  return partes.join(' · ');
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

/**
 * Compara o custo atual do produto (product_costs.unit_cost, ou null se não
 * cadastrado) com o custo final histórico de um lote já salvo. Nunca divide
 * por zero: variacaoPercentual só é calculada quando custoAtual > 0.
 * mesmoCustoPersistido compara os dois valores já multiplicados por 10000 e
 * arredondados a inteiro (nunca dividindo de volta) — evita qualquer
 * resíduo de ponto flutuante na comparação, na mesma precisão de 4 casas
 * realmente persistida em product_costs.unit_cost (numeric(12,4)).
 */
function calcularComparacaoCustoProduto(custoAtual, custoLote) {
  const diferenca = custoAtual === null ? null : custoLote - custoAtual;
  const variacaoPercentual = custoAtual !== null && custoAtual > 0 ? ((custoLote - custoAtual) / custoAtual) * 100 : null;
  const mesmoCustoPersistido = custoAtual !== null && Math.round(custoAtual * 10000) === Math.round(custoLote * 10000);
  return { custoAtual, custoLote, diferenca, variacaoPercentual, mesmoCustoPersistido };
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

/** "+€0,15" / "-€0,10" / "€0,00" — mesma disciplina de sinal do resto da tela de comparação de custo. */
function formatarDiferencaCusto(valor) {
  if (!Number.isFinite(valor)) return '—';
  return (valor > 0 ? '+' : '') + formatarMoeda(valor);
}

/** "+16,00%" / "-8,50%" / "—" — 2 casas, sempre com sinal explícito quando positivo (negativo já vem com "-" do próprio número). */
function formatarVariacaoPercentual(valor) {
  if (!Number.isFinite(valor)) return '—';
  return (valor > 0 ? '+' : '') + valor.toFixed(2).replace('.', ',') + '%';
}

/** 4 casas — só usada na confirmação de "Aplicar custo ao produto" (item 10 do pedido), pra mostrar a precisão real de product_costs.unit_cost (numeric(12,4)). A UI normal do bloco usa formatarMoeda (2 casas), nunca esta. */
function formatarMoeda4Casas(valor) {
  if (!Number.isFinite(valor)) return '—';
  return '€' + valor.toFixed(4).replace('.', ',');
}

function formatarDiferenca4Casas(valor) {
  if (!Number.isFinite(valor)) return '—';
  return (valor > 0 ? '+' : '') + formatarMoeda4Casas(valor);
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

/** No máximo 1 purchase_item por product_id — mesmo UNIQUE INDEX parcial de Compras (Etapa A) já usado por itemCompraDoIngrediente, agora aplicado ao vínculo Produto (ajuste de arquitetura: a carne principal usa product_id, nunca ingredient_id — ver popularOpcoesLoteCarneLote). */
function itemCompraDoProduto(produtoId) {
  return itensCompraCache.find((i) => i.produtoId === produtoId);
}

/** Mesmo formato de rotuloLote (G4), com o nome do item de compra prefixado (item 9/11 do pedido: "Contra Filé · 19/08/2026 · 500 g · €0,020000/g"). */
function rotuloLoteCarne(lote, opcoes) {
  const itemCompra = itemCompraPorId(lote.itemCompraId);
  const nomeItem = itemCompra ? itemCompra.nome : '(item removido)';
  return `${nomeItem} · ${rotuloLote(lote, opcoes)}`;
}

/**
 * Item de compra + lotes disponíveis (available, saldo>0, base_unit='g')
 * para o vínculo Produto da carne principal — reaproveitado tanto pelo
 * select (popularOpcoesLoteCarneLote) quanto pela validação de salvar
 * (validarFormularioLoteEspeto, Etapa I1), pra nunca duplicar a mesma
 * regra de filtro em dois lugares.
 */
function loteInfoCarneDoProduto(produtoId) {
  if (!produtoId) return { itemCompra: null, disponiveis: [] };
  const itemCompra = itemCompraDoProduto(produtoId);
  if (!itemCompra) return { itemCompra: null, disponiveis: [] };
  const disponiveis = lotesCache
    .filter((l) => l.itemCompraId === itemCompra.id && l.status === 'available' && l.quantidadeRestante > 0 && l.unidadeBase === 'g')
    .sort((a, b) => (a.recebidoEm < b.recebidoEm ? -1 : a.recebidoEm > b.recebidoEm ? 1 : a.id.localeCompare(b.id)));
  return { itemCompra, disponiveis };
}

/**
 * Ajuste de arquitetura — "Lote da carne" no topo do modal, escopado pelo
 * PRODUTO selecionado (products.id -> purchase_items.product_id -> lots),
 * nunca por ingredient_id (esse caminho é exclusivo dos componentes/
 * temperos, mais abaixo). loteAtualId sempre aparece como opção histórica
 * mesmo esgotado/fora da lista de disponíveis, nunca troca sozinho; FIFO
 * (recebidoEm ASC) só marca "Sugerido — mais antigo", nunca pré-seleciona.
 *
 * Etapa I1 — idBatchAtual (o id do lote de produção sendo editado, `null`
 * pra uma produção nova) decide se "Sem lote / custo manual" é oferecido:
 * numa produção NOVA esse modo deixou de existir (item 5 do pedido) — o
 * select nasce sem nenhuma opção selecionada, só com um placeholder
 * desabilitado "Selecione um lote"; editando uma produção já existente o
 * comportamento é o mesmo de sempre (preserva compatibilidade com
 * históricas sem lote, item 6/7 do pedido — nada muda aqui pra edição).
 */
function popularOpcoesLoteCarneLote(produtoId, loteAtualId, idBatchAtual) {
  const select = document.getElementById('campo-lote-carne-lote');
  const dicaSemVinculo = document.getElementById('dica-lote-carne-sem-vinculo');
  const dicaNenhum = document.getElementById('dica-lote-carne-nenhum-disponivel');
  const ehProducaoNova = !idBatchAtual;

  const opcaoPlaceholder = ehProducaoNova
    ? '<option value="" disabled selected>Selecione um lote</option>'
    : '<option value="">Sem lote / custo manual</option>';

  if (!produtoId) {
    select.innerHTML = opcaoPlaceholder;
    dicaSemVinculo.style.display = 'none';
    dicaNenhum.style.display = 'none';
    select.value = '';
    return;
  }

  const { itemCompra, disponiveis } = loteInfoCarneDoProduto(produtoId);
  dicaSemVinculo.style.display = itemCompra ? 'none' : '';

  const loteHistorico = loteAtualId ? lotePorId(loteAtualId) : null;
  const jaNaLista = loteHistorico && disponiveis.some((l) => l.id === loteHistorico.id);

  dicaNenhum.style.display = itemCompra && disponiveis.length === 0 && !loteHistorico ? '' : 'none';

  const opcoes = [opcaoPlaceholder];
  if (loteHistorico && !jaNaLista) {
    opcoes.push(`<option value="${loteHistorico.id}">${escaparHtml(rotuloLoteCarne(loteHistorico, { usadoNesteBatch: true }))}</option>`);
  }
  disponiveis.forEach((lote, indice) => {
    const sugerido = indice === 0 ? ' (Sugerido — mais antigo)' : '';
    opcoes.push(`<option value="${lote.id}">${escaparHtml(rotuloLoteCarne(lote))}${sugerido}</option>`);
  });
  select.innerHTML = opcoes.join('');
  select.value = loteAtualId || '';
}

/** Só insumos ativos — igual ao padrão já usado pra produto/ingrediente do lote (item 27 do pedido: insumo inativo não aparece pra um componente NOVO). */
function popularOpcoesSupplyLote() {
  const select = document.getElementById('campo-supply-lote');
  const ativos = insumosProducaoCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));
  select.innerHTML = ativos.map((i) => `<option value="${i.id}">${escaparHtml(i.nome)}</option>`).join('');
  popularOpcoesLoteSupplyLote(select.value || null, null);
  atualizarUnidadeSupplyLote();
}

/**
 * Etapa I3 — mesmo padrão de popularOpcoesLoteTemperoLote (G4), agora para
 * item_type='supply'. loteAtualId sempre aparece como opção histórica,
 * mesmo esgotado/fora da lista de disponíveis — nunca troca sozinho. FIFO
 * (recebidoEm ASC) só marca a primeira opção como "Sugerido".
 */
function popularOpcoesLoteSupplyLote(insumoId, loteAtualId) {
  const grupo = document.getElementById('grupo-lote-supply-lote');
  const select = document.getElementById('campo-lote-supply-lote');
  const dicaNenhum = document.getElementById('dica-lote-supply-nenhum-disponivel');
  const dicaSemItem = document.getElementById('dica-lote-supply-sem-vinculo');

  if (!insumoId) {
    grupo.style.display = 'none';
    select.innerHTML = '';
    return;
  }
  grupo.style.display = '';

  const itemCompra = itemCompraDoInsumo(insumoId);
  dicaSemItem.style.display = itemCompra ? 'none' : '';

  const disponiveis = itemCompra ? lotesDisponiveisDoItemCompra(itemCompra.id) : [];
  const loteHistorico = loteAtualId ? lotePorId(loteAtualId) : null;
  const jaNaLista = loteHistorico && disponiveis.some((l) => l.id === loteHistorico.id);

  dicaNenhum.style.display = itemCompra && disponiveis.length === 0 && !loteHistorico ? '' : 'none';

  const opcoes = ['<option value="">Sem lote / custo cadastrado</option>'];
  if (loteHistorico && !jaNaLista) {
    opcoes.push(`<option value="${loteHistorico.id}">${escaparHtml(rotuloLote(loteHistorico, { usadoNesteBatch: true }))}</option>`);
  }
  disponiveis.forEach((lote, indice) => {
    const sugerido = indice === 0 ? ' (Sugerido — mais antigo)' : '';
    opcoes.push(`<option value="${lote.id}">${escaparHtml(rotuloLote(lote))}${sugerido}</option>`);
  });
  select.innerHTML = opcoes.join('');
  select.value = loteAtualId || '';
}

/** Etapa I3: lote selecionado trava a unidade em lote.unidadeBase (nunca hardcoded 'un') — sem lote, unidade legada 'un'. */
function atualizarUnidadeSupplyLote() {
  const loteId = document.getElementById('campo-lote-supply-lote').value;
  const lote = loteId ? lotePorId(loteId) : null;
  document.getElementById('texto-unidade-supply-lote').textContent = lote ? lote.unidadeBase : 'un';
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

  let candidatos;
  if (tipo === 'recipe') {
    candidatos = receitasCache.filter((r) => r.ativo && calcularRendimentoReceita(r.id).disponivel).sort((a, b) => a.nome.localeCompare(b.nome));
  } else {
    candidatos = ingredientesCache.filter((i) => i.ativo && ehIngredienteTempero(i)).sort((a, b) => a.nome.localeCompare(b.nome));
  }
  select.innerHTML = candidatos.map((c) => `<option value="${c.id}">${escaparHtml(c.nome)}</option>`).join('');

  atualizarEstadoSemOpcoesTempero(tipo, candidatos.length === 0);
  popularOpcoesLoteTemperoLote(tipo === 'ingredient' ? select.value || null : null, null);
}

/**
 * Etapa G4 — só relevante para item_type='ingredient'. loteAtualId
 * (não-nulo em edição) sempre aparece como opção, mesmo esgotado/fora da
 * lista de disponíveis — nunca troca sozinho. FIFO (recebidoEm ASC) só
 * marca a primeira opção como "Sugerido", nunca pré-seleciona.
 */
function popularOpcoesLoteTemperoLote(ingredienteId, loteAtualId) {
  const grupo = document.getElementById('grupo-lote-tempero-lote');
  const select = document.getElementById('campo-lote-tempero-lote');
  const dicaNenhum = document.getElementById('dica-lote-tempero-nenhum-disponivel');
  const dicaSemItem = document.getElementById('dica-lote-tempero-sem-vinculo');

  if (!ingredienteId) {
    grupo.style.display = 'none';
    select.innerHTML = '';
    return;
  }
  grupo.style.display = '';

  const itemCompra = itemCompraDoIngrediente(ingredienteId);
  dicaSemItem.style.display = itemCompra ? 'none' : '';

  const disponiveis = itemCompra ? lotesDisponiveisDoItemCompra(itemCompra.id) : [];
  const loteHistorico = loteAtualId ? lotePorId(loteAtualId) : null;
  const jaNaLista = loteHistorico && disponiveis.some((l) => l.id === loteHistorico.id);

  dicaNenhum.style.display = itemCompra && disponiveis.length === 0 && !loteHistorico ? '' : 'none';

  const opcoes = ['<option value="">Sem lote / custo cadastrado</option>'];
  if (loteHistorico && !jaNaLista) {
    opcoes.push(`<option value="${loteHistorico.id}">${escaparHtml(rotuloLote(loteHistorico, { usadoNesteBatch: true }))}</option>`);
  }
  disponiveis.forEach((lote, indice) => {
    const sugerido = indice === 0 ? ' (Sugerido — mais antigo)' : '';
    opcoes.push(`<option value="${lote.id}">${escaparHtml(rotuloLote(lote))}${sugerido}</option>`);
  });
  select.innerHTML = opcoes.join('');
  select.value = loteAtualId || '';
}

/**
 * Mantém a regra de filtro intacta (categoria Temperos, case/trim-
 * insensitive) — só melhora a UX quando não há nenhum candidato
 * selecionável: mostra um aviso específico pro caso de Ingrediente (regra
 * mais restritiva, exige categorização manual) e desabilita
 * Quantidade/Adicionar pra qualquer um dos dois tipos enquanto o select
 * estiver vazio.
 */
function atualizarEstadoSemOpcoesTempero(tipo, semOpcoes) {
  const dica = document.getElementById('dica-tempero-sem-opcoes');
  dica.style.display = semOpcoes && tipo === 'ingredient' ? '' : 'none';

  document.getElementById('campo-quantidade-tempero-lote').disabled = semOpcoes;
  document.getElementById('botao-adicionar-tempero-lote').disabled = semOpcoes || !souAdminProducao;
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
  // Etapa G4: resumo de lote abaixo do nome — só quando o componente tem lotId.
  const loteDoComponente = componente.lotId ? lotePorId(componente.lotId) : null;
  const linhaLote = loteDoComponente
    ? `<div class="producao-linha-componente-lote-detalhe">Lote ${formatarDataProducao(loteDoComponente.recebidoEm)} · ${formatarCustoBaseIngrediente(loteDoComponente.custoPorUnidadeBase, loteDoComponente.unidadeBase)}</div>`
    : '';

  return `
    <div class="producao-linha-componente-lote">
      <span class="producao-linha-componente-nome">${escaparHtml(componente.nome)}</span>
      <span class="producao-linha-componente-tipo">${tipoLabel}</span>
      <span class="producao-linha-componente-quantidade">${quantidadeTexto} ${componente.unidade}</span>
      <span class="producao-linha-componente-custo">${formatarMoeda(custoLinha)}</span>
      <button type="button" class="btn-icone" data-acao-remover-componente="${indice}" title="Remover" ${souAdminProducao ? '' : 'disabled'}>🗑️</button>
    </div>${linhaLote}`;
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

/**
 * Etapa I3: com lote, custo vem SEMPRE de lots.unit_cost_base (nunca
 * production_supplies.cost_per_unit) — mesma disciplina já usada em
 * ingredient (G4). Sem lote, comportamento legado intocado: custo ATUAL de
 * production_supplies, unidade 'un'. formatarCustoBaseIngrediente(valor,
 * 'un') produz a mesma formatação (toFixed(6) + '/un') já usada em todo o
 * projeto pra custo por unidade base — unifica os dois caminhos (com/sem
 * lote) sob a mesma função de exibição.
 */
function atualizarPreviewSupplyLote() {
  const preview = document.getElementById('preview-supply-lote');
  const dicaSaldo = document.getElementById('dica-supply-lote-saldo-insuficiente');
  const insumo = insumoProducaoPorId(document.getElementById('campo-supply-lote').value);
  const quantidade = Number(document.getElementById('campo-quantidade-supply-lote').value);
  const loteId = document.getElementById('campo-lote-supply-lote').value;
  const lote = loteId ? lotePorId(loteId) : null;

  dicaSaldo.style.display = 'none';

  if (!insumo || !Number.isFinite(quantidade) || quantidade <= 0) {
    preview.textContent = '';
    return;
  }

  const unidade = lote ? lote.unidadeBase : 'un';
  const custoPorUnidade = lote ? lote.custoPorUnidadeBase : insumo.custoPorUnidade;
  preview.textContent = `${quantidade} ${unidade} × ${formatarCustoBaseIngrediente(custoPorUnidade, unidade)} = ${formatarMoeda(quantidade * custoPorUnidade)}`;

  if (lote) {
    const idLoteAtual = document.getElementById('campo-id-lote-espeto').value || null;
    const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'skewer_production', idLoteAtual);
    if (quantidade > saldoEfetivo) {
      dicaSaldo.style.display = '';
    }
  }
}

function adicionarComponenteSupply() {
  if (!souAdminProducao) return;
  const dicaErro = document.getElementById('dica-supply-lote-erro');
  const insumo = insumoProducaoPorId(document.getElementById('campo-supply-lote').value);
  const quantidade = Number(document.getElementById('campo-quantidade-supply-lote').value);
  const lotId = document.getElementById('campo-lote-supply-lote').value || null;

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

  // Etapa I3: insumo vinculado a um Item de Compra que controla estoque
  // exige lote pra NOVA inclusão — insumo legado (sem vínculo, ou vínculo
  // sem controle de estoque) continua podendo ser adicionado sem lote.
  const itemCompra = itemCompraDoInsumo(insumo.id);
  if (itemCompra && itemCompra.controlaEstoque && !lotId) {
    dicaErro.textContent = 'Selecione um lote para este insumo.';
    dicaErro.style.display = '';
    return;
  }

  // Chave de duplicidade inclui lotId (mesma regra já validada na RPC) —
  // permite o mesmo insumo em lotes diferentes, continua bloqueando o
  // mesmo insumo+mesmo lote (ou mesmo insumo sem lote) repetido.
  if (componentesLoteEmEdicao.some((c) => c.tipoItem === 'supply' && c.referenciaId === insumo.id && (c.lotId || null) === lotId)) {
    dicaErro.textContent = 'Este insumo já foi adicionado a este lote (mesmo lote, ou sem lote).';
    dicaErro.style.display = '';
    return;
  }

  const lote = lotId ? lotePorId(lotId) : null;
  const unidade = lote ? lote.unidadeBase : 'un';
  const custoPorUnidadePreview = lote ? lote.custoPorUnidadeBase : insumo.custoPorUnidade;

  if (lote) {
    const idLoteAtual = document.getElementById('campo-id-lote-espeto').value || null;
    const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'skewer_production', idLoteAtual);
    if (quantidade > saldoEfetivo) {
      dicaErro.textContent = 'Quantidade maior que o saldo disponível neste lote.';
      dicaErro.style.display = '';
      return;
    }
  }

  dicaErro.style.display = 'none';

  componentesLoteEmEdicao.push({
    tipoItem: 'supply',
    referenciaId: insumo.id,
    quantidade,
    unidade,
    nome: insumo.nome,
    custoPorUnidadePreview,
    lotId,
  });

  document.getElementById('campo-quantidade-supply-lote').value = '';
  document.getElementById('preview-supply-lote').textContent = '';
  document.getElementById('dica-supply-lote-saldo-insuficiente').style.display = 'none';
  popularOpcoesLoteSupplyLote(insumo.id, null);
  atualizarUnidadeSupplyLote();
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
    // Etapa G4: lote selecionado trava a unidade em lote.unidadeBase — nunca
    // a unidade "natural" do ingrediente quando um lote específico manda.
    const loteId = document.getElementById('campo-lote-tempero-lote').value;
    const lote = loteId ? lotePorId(loteId) : null;
    if (lote) {
      textoUnidade.textContent = lote.unidadeBase;
    } else {
      const ingrediente = ingredientePorId(referenciaId);
      textoUnidade.textContent = ingrediente ? ingrediente.unidadeBase : '—';
    }
  }
}

/** Reaproveita custoTotalReceita/calcularRendimentoReceita (Fichas Técnicas) pra Preparo, e cost_per_base_unit direto pra Ingrediente — nunca duplica fórmula (item 5/13/14 do pedido). */
function atualizarPreviewTemperoLote() {
  const preview = document.getElementById('preview-tempero-lote');
  const dicaSaldo = document.getElementById('dica-tempero-lote-saldo-insuficiente');
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
  const quantidade = Number(document.getElementById('campo-quantidade-tempero-lote').value);

  dicaSaldo.style.display = 'none';

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
    // Etapa G4: lote selecionado é a fonte do custo (nunca o cadastro atual
    // do ingrediente) — só a origem do custo muda, a fórmula continua
    // quantidade × custo por unidade.
    const loteId = document.getElementById('campo-lote-tempero-lote').value;
    const lote = loteId ? lotePorId(loteId) : null;
    const custoPorUnidade = lote ? lote.custoPorUnidadeBase : ingrediente.custoPorUnidadeBase;
    const unidadeExibicao = lote ? lote.unidadeBase : ingrediente.unidadeBase;
    const custoEstimado = quantidade * custoPorUnidade;
    preview.textContent = `${quantidade} ${unidadeExibicao} × ${formatarCustoBaseIngrediente(custoPorUnidade, unidadeExibicao)} = ${formatarMoeda(custoEstimado)}`;

    if (lote) {
      const idLoteAtual = document.getElementById('campo-id-lote-espeto').value || null;
      const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'skewer_production', idLoteAtual);
      if (quantidade > saldoEfetivo) {
        dicaSaldo.style.display = '';
      }
    }
  }
}

function adicionarComponenteTempero() {
  if (!souAdminProducao) return;
  const dicaErro = document.getElementById('dica-tempero-lote-erro');
  const tipo = document.getElementById('campo-tipo-tempero-lote').value;
  const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
  const quantidade = Number(document.getElementById('campo-quantidade-tempero-lote').value);
  // Etapa G4: lotId só se aplica a 'ingredient' — recipe nunca tem lote.
  const lotId = tipo === 'ingredient' ? document.getElementById('campo-lote-tempero-lote').value || null : null;

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
  // Chave de duplicidade inclui lotId (item 21-23 do pedido G4) — mesma
  // regra já validada na RPC (Etapa G2): permite o mesmo ingrediente em
  // lotes diferentes, continua bloqueando o mesmo ingrediente+mesmo lote
  // (ou mesmo ingrediente sem lote) repetido.
  if (componentesLoteEmEdicao.some((c) => c.tipoItem === tipo && c.referenciaId === referenciaId && (c.lotId || null) === lotId)) {
    dicaErro.textContent = tipo === 'recipe' ? 'Este preparo já foi adicionado a este lote.' : 'Este ingrediente já foi adicionado a este lote (mesmo lote, ou sem lote).';
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
    const lote = lotId ? lotePorId(lotId) : null;
    nome = ingrediente.nome;
    unidade = lote ? lote.unidadeBase : ingrediente.unidadeBase;
    custoPorUnidadePreview = lote ? lote.custoPorUnidadeBase : ingrediente.custoPorUnidadeBase;

    if (lote) {
      const idLoteAtual = document.getElementById('campo-id-lote-espeto').value || null;
      const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'skewer_production', idLoteAtual);
      if (quantidade > saldoEfetivo) {
        dicaErro.textContent = 'Quantidade maior que o saldo disponível neste lote.';
        dicaErro.style.display = '';
        return;
      }
    }
  }

  dicaErro.style.display = 'none';
  componentesLoteEmEdicao.push({ tipoItem: tipo, referenciaId, quantidade, unidade, nome, custoPorUnidadePreview, lotId });

  document.getElementById('campo-quantidade-tempero-lote').value = '';
  document.getElementById('preview-tempero-lote').textContent = '';
  document.getElementById('dica-tempero-lote-saldo-insuficiente').style.display = 'none';
  popularOpcoesLoteTemperoLote(tipo === 'ingredient' ? referenciaId : null, null);
  renderizarListasComponentesLote();
}

// ---------------------------------------------------------------------------
// Custo do Produto (Etapa 4) — comparação e aplicação manual do custo real
// final de um lote JÁ SALVO em product_costs.unit_cost, reaproveitando
// aplicarCustoProducaoEspetoNoSupabase/buscarCustosProdutosDoSupabase já
// existentes (product-costs-service.js) — a escrita passa pela RPC
// apply_skewer_production_cost (SECURITY DEFINER, valida server-side que o
// produto é da categoria Espetinhos), nunca um INSERT/UPDATE direto em
// product_costs. Nunca altera o lote em si (skewer_production_batches/
// skewer_batch_components) — só product_costs. O bloco reflete sempre o
// ÚLTIMO ESTADO SALVO do lote (nunca recalculado a partir de edições ainda
// não salvas no formulário aberto), por isso só é atualizado em
// abrirModalLoteEspeto() e depois de aplicar com sucesso — nunca reativo às
// mudanças ao vivo dos campos da carne/componentes.
// ---------------------------------------------------------------------------

/** Guarda { produtoId, produtoNome, custoLote, custoAtual } do lote atualmente aberto no modal, ou null — usado pelo clique do botão sem reserializar o valor (evita qualquer perda de precisão por ida-e-volta string↔número). */
let comparacaoCustoProdutoAtual = null;

/** Só chamada por abrirModalLoteEspeto (lote já salvo) — nunca por abrirModalNovoLoteEspeto. */
function renderizarBlocoCustoProduto(lote) {
  const bloco = document.getElementById('bloco-custo-produto');

  const produto = produtoPorId(lote.produtoId);
  const componentesSnapshot = componentesDoLote(lote.id).map((c) => ({
    tipoItem: c.tipoItem,
    quantidade: c.quantidade,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
  }));
  const custoLote = calcularCustosFinaisLoteEspetos(lote, componentesSnapshot).custoRealFinalPorEspeto;
  const custoAtual = custosProdutosCache.has(lote.produtoId) ? custosProdutosCache.get(lote.produtoId) : null;
  const comparacao = calcularComparacaoCustoProduto(custoAtual, custoLote);

  document.getElementById('custoproduto-nome-produto').textContent = produto ? produto.nome : '(produto removido)';
  document.getElementById('custoproduto-origem-lote').textContent = `Lote de ${formatarDataProducao(lote.produzidoEm)}`;
  document.getElementById('custoproduto-custo-atual').textContent =
    comparacao.custoAtual === null ? 'Sem custo cadastrado' : formatarMoeda(comparacao.custoAtual);
  document.getElementById('custoproduto-custo-lote').textContent = Number.isFinite(custoLote) ? formatarMoeda(custoLote) : '—';
  document.getElementById('custoproduto-diferenca').textContent = formatarDiferencaCusto(comparacao.diferenca);
  document.getElementById('custoproduto-variacao').textContent = formatarVariacaoPercentual(comparacao.variacaoPercentual);

  document.getElementById('dica-produto-inativo-custo').style.display = produto && produto.status !== 'ativo' ? '' : 'none';
  document.getElementById('dica-custo-ja-aplicado').style.display = comparacao.mesmoCustoPersistido ? '' : 'none';
  document.getElementById('dica-custo-produto-erro').style.display = 'none';

  document.getElementById('botao-aplicar-custo-produto').disabled =
    !souAdminProducao || comparacao.mesmoCustoPersistido || !Number.isFinite(custoLote);

  comparacaoCustoProdutoAtual = Number.isFinite(custoLote)
    ? {
        produtoId: lote.produtoId,
        produtoNome: produto ? produto.nome : '(produto removido)',
        custoLote,
        custoAtual: comparacao.custoAtual,
      }
    : null;

  bloco.style.display = '';
}

function ocultarBlocoCustoProduto() {
  document.getElementById('bloco-custo-produto').style.display = 'none';
  comparacaoCustoProdutoAtual = null;
}

/**
 * Confirmação explícita (item 10 do pedido) mostrando 4 casas — a precisão
 * real de product_costs.unit_cost — mesmo a UI normal do bloco usando 2
 * casas. O texto da confirmação usa a comparação já calculada no client
 * (comparacaoCustoProdutoAtual) só como PRÉVIA — a chamada real à RPC
 * envia apenas o id do lote, nunca esse valor: a RPC recalcula tudo do
 * zero a partir dos snapshots salvos, então é impossível aplicar um custo
 * diferente do que o lote realmente tem, mesmo adulterando o client via
 * DevTools. Depois do sucesso, o cache é atualizado com o valor
 * RETORNADO pela RPC, nunca com custoLote (calculado localmente).
 */
async function aplicarCustoAoProdutoModal() {
  if (!souAdminProducao || !comparacaoCustoProdutoAtual) return;
  const { produtoNome, custoLote, custoAtual } = comparacaoCustoProdutoAtual;
  const loteId = document.getElementById('campo-id-lote-espeto').value;
  if (!loteId) return;

  const diferenca = custoAtual === null ? null : custoLote - custoAtual;
  const confirmado = confirm(
    `Aplicar ${formatarMoeda4Casas(custoLote)} como novo custo do produto ${produtoNome}?\n\n` +
      `Custo atual: ${custoAtual === null ? 'Sem custo cadastrado' : formatarMoeda4Casas(custoAtual)}\n` +
      `Novo custo: ${formatarMoeda4Casas(custoLote)}\n` +
      `Diferença: ${formatarDiferenca4Casas(diferenca)}`
  );
  if (!confirmado) return;

  const dicaErro = document.getElementById('dica-custo-produto-erro');
  const botao = document.getElementById('botao-aplicar-custo-produto');
  dicaErro.style.display = 'none';
  botao.disabled = true;

  let resultado;
  try {
    resultado = await aplicarCustoProducaoEspetoNoSupabase(loteId);
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível aplicar o custo. ' + erro.message;
    dicaErro.style.display = '';
    botao.disabled = false;
    return;
  }

  custosProdutosCache.set(resultado.produtoId, resultado.unitCost);
  mostrarToast('Custo aplicado ao produto.', 'sucesso');

  const lote = lotesEspetosCache.find((l) => l.id === loteId);
  if (lote) renderizarBlocoCustoProduto(lote);
}

// ---------------------------------------------------------------------------
// Modal: novo/editar lote
// ---------------------------------------------------------------------------

function ligarEventosModalLoteEspeto() {
  document.getElementById('botao-novo-lote-espeto').addEventListener('click', abrirModalNovoLoteEspeto);
  document.getElementById('botao-fechar-modal-lote-espeto').addEventListener('click', fecharModalLoteEspeto);
  document.getElementById('botao-cancelar-lote-espeto').addEventListener('click', fecharModalLoteEspeto);

  [
    'campo-peso-bruto-lote',
    'campo-unidade-peso-bruto-lote',
    'campo-peso-util-lote',
    'campo-unidade-peso-util-lote',
    'campo-peso-espeto-lote',
    'campo-quantidade-real-lote',
  ].forEach((idCampo) => {
    const campo = document.getElementById(idCampo);
    campo.addEventListener('input', atualizarPreviewLoteEspeto);
    campo.addEventListener('change', atualizarPreviewLoteEspeto);
  });

  document.getElementById('botao-excluir-lote-espeto').addEventListener('click', excluirLoteEspetoModal);
  document.getElementById('form-lote-espeto').addEventListener('submit', salvarFormularioLoteEspeto);
  document.getElementById('botao-aplicar-custo-produto').addEventListener('click', aplicarCustoAoProdutoModal);

  document.getElementById('campo-produto-lote').addEventListener('change', () => {
    // Ajuste de arquitetura: trocar o Produto limpa o lote da carne
    // imediatamente e recalcula a lista a partir do novo produto — nunca
    // mantém o lote do produto anterior (item 14 do pedido).
    const produtoId = document.getElementById('campo-produto-lote').value || null;
    const idBatchAtual = document.getElementById('campo-id-lote-espeto').value || null;
    popularOpcoesLoteCarneLote(produtoId, null, idBatchAtual);
    atualizarPreviewLoteEspeto();
  });
  document.getElementById('campo-lote-carne-lote').addEventListener('change', atualizarPreviewLoteEspeto);

  document.getElementById('campo-supply-lote').addEventListener('change', () => {
    sugerirQuantidadePalito();
    const insumoId = document.getElementById('campo-supply-lote').value || null;
    popularOpcoesLoteSupplyLote(insumoId, null);
    atualizarUnidadeSupplyLote();
    atualizarPreviewSupplyLote();
  });
  document.getElementById('campo-quantidade-supply-lote').addEventListener('input', atualizarPreviewSupplyLote);
  document.getElementById('campo-lote-supply-lote').addEventListener('change', () => {
    atualizarUnidadeSupplyLote();
    atualizarPreviewSupplyLote();
  });
  document.getElementById('botao-adicionar-supply-lote').addEventListener('click', adicionarComponenteSupply);

  document.getElementById('campo-tipo-tempero-lote').addEventListener('change', () => {
    popularOpcoesTemperoLote();
    atualizarUnidadeTemperoLote();
    atualizarPreviewTemperoLote();
  });
  document.getElementById('campo-referencia-tempero-lote').addEventListener('change', () => {
    // Etapa G4 (item 12): trocar o ingrediente/preparo limpa o lote
    // selecionado imediatamente — nunca preserva o lote do ingrediente anterior.
    const tipo = document.getElementById('campo-tipo-tempero-lote').value;
    const referenciaId = document.getElementById('campo-referencia-tempero-lote').value;
    popularOpcoesLoteTemperoLote(tipo === 'ingredient' ? referenciaId || null : null, null);
    atualizarUnidadeTemperoLote();
    atualizarPreviewTemperoLote();
  });
  document.getElementById('campo-lote-tempero-lote').addEventListener('change', () => {
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

/**
 * Etapa H3 — quando true, a próxima chamada de atualizarCustoCarneLote()
 * (com lote ativo) só atualiza rótulo/readonly/saldo/aviso, sem tocar
 * campo-custo-total-lote.value — preserva o total_cost snapshot exibido ao
 * abrir um lote já salvo (item 22-23 do pedido: só recalcular se o usuário
 * de fato mudar peso bruto ou trocar de lote depois de aberto). Setada só
 * por abrirModalLoteEspeto, resetada automaticamente na primeira chamada.
 */
let ignorarRecalculoCustoCarneNaProximaChamada = false;

/**
 * Ajuste de arquitetura — a carne principal passou a usar o vínculo
 * PRODUTO (products.id -> purchase_items.product_id -> lots), não mais
 * ingredient_id — a RPC não exige mais p_ingredient_id quando p_lot_id da
 * carne está presente. Este estado é só um valor vestigial: null em lote
 * novo, e em edição preserva o que já estava persistido no batch (nunca
 * derivado/validado por nada no fluxo de lote da carne) — nunca quebra
 * p_ingredient_id, mas também nunca é ativamente gerenciado.
 */
let ingredienteIdCarnePrincipal = null;

/**
 * Etapa I1 — campo-custo-total-lote deixou de ser um input visível/
 * editável (agora type="hidden") — esta função só o mantém atualizado
 * (fonte de dados pra lerDadosFormularioLoteEspeto/payload de save) e
 * espelha o valor formatado em texto-custo-carne-lote (leitura pro
 * usuário). Chamada a cada atualização de preview (peso bruto/unidade
 * mudou, lote mudou). Custo SEMPRE gross×unit_cost_base do lote, NUNCA
 * usable_weight_g (item 9/10 do pedido) — mesmo com peso útil diferente,
 * o cálculo de custo ignora completamente esse campo.
 */
function atualizarCustoCarneLote() {
  const campoCusto = document.getElementById('campo-custo-total-lote');
  const textoCusto = document.getElementById('texto-custo-carne-lote');
  const loteId = document.getElementById('campo-lote-carne-lote').value || null;
  const textoSaldo = document.getElementById('texto-saldo-lote-carne');
  const dicaSaldoInsuficiente = document.getElementById('dica-lote-carne-saldo-insuficiente');

  const lote = loteId ? lotePorId(loteId) : null;

  if (!lote) {
    // Sem lote — produção nova ainda incompleta, ou edição de uma produção
    // histórica que nasceu sem lote (item 6/7 do pedido). Nenhuma UI altera
    // mais campoCusto.value por aqui — só exibe o que já está nele (o
    // snapshot carregado por abrirModalLoteEspeto, ou vazio numa produção
    // nova), nunca inventa/zera um valor histórico.
    textoSaldo.style.display = 'none';
    dicaSaldoInsuficiente.style.display = 'none';
    const valorAtual = campoCusto.value === '' ? NaN : Number(campoCusto.value);
    textoCusto.textContent = Number.isFinite(valorAtual) ? formatarMoeda(valorAtual) : '—';
    return;
  }

  const pesoBrutoG = lerPesoEmGramas('campo-peso-bruto-lote', 'campo-unidade-peso-bruto-lote');

  if (ignorarRecalculoCustoCarneNaProximaChamada) {
    ignorarRecalculoCustoCarneNaProximaChamada = false;
  } else if (Number.isFinite(pesoBrutoG) && pesoBrutoG > 0) {
    campoCusto.value = pesoBrutoG * lote.custoPorUnidadeBase;
  } else {
    campoCusto.value = '';
  }

  const valorExibido = campoCusto.value === '' ? NaN : Number(campoCusto.value);
  textoCusto.textContent = Number.isFinite(valorExibido) ? formatarMoeda(valorExibido) : '—';

  const idLoteAtual = document.getElementById('campo-id-lote-espeto').value || null;
  const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'skewer_production', idLoteAtual);
  textoSaldo.textContent = `Saldo disponível: ${formatarPesoGramas(saldoEfetivo)}`;
  textoSaldo.style.display = '';

  dicaSaldoInsuficiente.style.display = Number.isFinite(pesoBrutoG) && pesoBrutoG > saldoEfetivo ? '' : 'none';
}

/** Estado comum às duas subseções de Custos Adicionais, reiniciado toda vez que o modal abre (novo ou editar) — evita duplicar isso nas duas funções abaixo. */
function reiniciarFormularioCustosAdicionaisLote() {
  popularOpcoesSupplyLote();
  document.getElementById('campo-quantidade-supply-lote').value = '';
  document.getElementById('preview-supply-lote').textContent = '';
  document.getElementById('dica-supply-lote-erro').style.display = 'none';
  document.getElementById('dica-supply-lote-saldo-insuficiente').style.display = 'none';

  document.getElementById('campo-tipo-tempero-lote').value = 'recipe';
  popularOpcoesTemperoLote();
  atualizarUnidadeTemperoLote();
  document.getElementById('campo-quantidade-tempero-lote').value = '';
  document.getElementById('preview-tempero-lote').textContent = '';
  document.getElementById('dica-tempero-lote-erro').style.display = 'none';
  document.getElementById('dica-tempero-lote-saldo-insuficiente').style.display = 'none';

  renderizarListasComponentesLote();
}

function abrirModalNovoLoteEspeto() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-lote-espeto').textContent = 'Novo Lote de Produção';
  document.getElementById('campo-id-lote-espeto').value = '';
  popularOpcoesProdutoLote(null);
  document.getElementById('campo-produto-lote').value = '';
  ingredienteIdCarnePrincipal = null;
  popularOpcoesLoteCarneLote(null, null, null);
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
  ocultarBlocoCustoProduto();

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
  document.getElementById('campo-produto-lote').value = lote.produtoId;

  // Ajuste de arquitetura: a lista de lotes é escopada pelo PRODUTO já
  // persistido no batch (lote.produtoId) — reconstrói o contexto sem
  // depender de ingredient_id (item 15 do pedido). ingredient_id do
  // header é só preservado como valor vestigial (nunca derivado/validado
  // pela RPC no fluxo de lote da carne) — não quebra p_ingredient_id.
  ingredienteIdCarnePrincipal = lote.ingredienteId || null;
  popularOpcoesLoteCarneLote(lote.produtoId, lote.lotId || null, lote.id);
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
    lotId: c.lotId || null,
  }));
  reiniciarFormularioCustosAdicionaisLote();
  renderizarBlocoCustoProduto(lote);

  // Etapa H3 (item 22-23): preserva o total_cost snapshot já exibido acima
  // — a próxima chamada de atualizarCustoCarneLote() (dentro do
  // atualizarPreviewLoteEspeto logo abaixo) não deve recalcular o custo só
  // por causa da abertura do modal.
  ignorarRecalculoCustoCarneNaProximaChamada = true;
  atualizarPreviewLoteEspeto();
  abrirModal('modal-overlay-lote-espeto');
}

function fecharModalLoteEspeto() {
  fecharModal('modal-overlay-lote-espeto');
}

/** Recalculada a cada tecla/troca de unidade, sempre client-side — nunca consulta o Supabase (item 19 do pedido). */
function atualizarPreviewLoteEspeto() {
  atualizarCustoCarneLote();
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
function validarFormularioLoteEspeto({ produtoId, dataProducao, pesoBrutoG, pesoUtilG, custoTotal, pesoEspetoG, quantidadeReal, lotId, idLoteAtual }) {
  if (!produtoId) return 'Selecione o produto.';
  if (!dataProducao) return 'Informe a data da produção.';
  if (!Number.isFinite(pesoBrutoG) || pesoBrutoG <= 0) return 'Informe um peso bruto válido, maior que zero.';
  if (!Number.isFinite(pesoUtilG) || pesoUtilG <= 0) return 'Informe um peso após limpeza válido, maior que zero.';
  if (pesoUtilG > pesoBrutoG) return 'O peso após limpeza não pode ser maior que o peso bruto.';

  const ehProducaoNova = !idLoteAtual;

  if (lotId) {
    // Com lote (nova produção ou edição): custo é sempre derivado, só
    // valida saldo — nunca lê/valida custoTotal aqui.
    const saldoEfetivo = saldoEfetivoLoteParaEdicao(lotId, 'skewer_production', idLoteAtual);
    if (pesoBrutoG > saldoEfetivo) return 'Saldo insuficiente no lote selecionado para a carne principal.';
  } else if (ehProducaoNova) {
    // Etapa I1: produção NOVA sem lote é sempre bloqueada — a mensagem
    // exata depende de qual parte do vínculo está faltando (itens 2/3/4
    // do pedido). RPC (item 11) continua a barreira real; isto é só UX.
    const { itemCompra, disponiveis } = loteInfoCarneDoProduto(produtoId);
    if (!itemCompra) return 'Cadastre um Item de Compra para este produto antes de registrar a produção.';
    if (disponiveis.length === 0) return 'Cadastre uma compra/lote para este produto antes de registrar a produção.';
    return 'Selecione um lote da carne antes de registrar a produção.';
  } else {
    // Edição de produção histórica que nasceu sem lote — modo manual
    // preservado (item 6/7 do pedido): custo continua o que já estava
    // (campo oculto, nunca mais editado por esta UI, ver
    // atualizarCustoCarneLote), só validado como número são.
    if (!Number.isFinite(custoTotal) || custoTotal < 0) return 'Informe um valor total válido (não pode ser negativo).';
  }

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
        lotId: componente.lotId || null,
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
  // Ajuste de arquitetura: a carne principal usa o vínculo Produto (não
  // ingredient_id) — este valor é só vestigial/preservado, nunca lido de
  // um campo visual (ver comentário de ingredienteIdCarnePrincipal).
  const ingredienteId = ingredienteIdCarnePrincipal;
  const lotId = document.getElementById('campo-lote-carne-lote').value || null;
  const dataProducao = document.getElementById('campo-data-lote').value;
  const dados = lerDadosFormularioLoteEspeto();

  const erroValidacao = validarFormularioLoteEspeto({ produtoId, dataProducao, ...dados, lotId, idLoteAtual: id || null });
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
    lotId,
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
// PRODUÇÃO DE ACOMPANHAMENTOS — side_production_batches + side_batch_components
// (Etapa C). Lote de acompanhamento (Salada de Maionese, Vinagrete, Arroz,
// Farofa, Molho de Alho...): rendimento final e porção são sempre digitados
// (rendimento nunca calculado pela soma dos componentes — captura perda real
// de cocção/evaporação/absorção), quantidade de porções é sempre derivada
// (teórica) ou informada (real, opcional). Todo custo do lote vem da soma
// dos componentes (ingredient/recipe, sem supply) — diferente de Espetos,
// não existe aqui um "custo da carne" separado. Escrita (criar/editar lote +
// substituir componentes) passa inteira pela RPC save_side_production_batch;
// aplicar custo ao produto passa inteira por apply_side_production_cost
// (product-costs-service.js), que nunca recebe nenhum número do
// client, só o id do lote. Funções desta seção nunca reaproveitam nem
// misturam estado com as de Produção de Espetos (calcularIndicadoresLote
// Acompanhamento/calcularCustosFinaisLoteEspetos são independentes, mesmo
// quando a fórmula é parecida) — cada seção tem seu próprio cache/estado de
// modal. Depende de js/services/side-production-service.js e reaproveita
// (sem alterar) ingredientesCache/receitasCache/produtosCache/
// custosProdutosCache/calcularRendimentoReceita/custoTotalReceita/
// formatarQuantidadeRendimento/formatarCustoPorRendimento/
// calcularComparacaoCustoProduto/formatarMoeda4Casas já existentes.
// =============================================================================

let lotesAcompanhamentosCache = [];
let componentesLotesAcompanhamentosCache = [];
let componentesAcompanhamentoEmEdicao = [];

async function carregarLotesAcompanhamentos() {
  const carregando = document.getElementById('estado-carregando-acompanhamentos');
  const erro = document.getElementById('estado-erro-acompanhamentos');

  try {
    const [lotes, componentes] = await Promise.all([
      buscarLotesAcompanhamentosDoSupabase(),
      buscarComponentesLotesAcompanhamentosDoSupabase(),
    ]);
    lotesAcompanhamentosCache = lotes;
    componentesLotesAcompanhamentosCache = componentes;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar lotes de produção de acompanhamentos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os lotes de acompanhamento. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  atualizarEstadoEdicaoLotesAcompanhamentos();
  renderizarTabelaLotesAcompanhamentos();
}

function atualizarEstadoEdicaoLotesAcompanhamentos() {
  const botaoNovo = document.getElementById('botao-novo-lote-acompanhamento');
  const dica = document.getElementById('dica-acompanhamentos-somente-admin');
  botaoNovo.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

/** Componentes já salvos de um lote — histórico, nunca recalculado (mesmo padrão de componentesDoLote/itensDaReceita). */
function componentesDoLoteAcompanhamento(loteId) {
  return componentesLotesAcompanhamentosCache.filter((c) => c.loteId === loteId);
}

// ---------------------------------------------------------------------------
// Cálculo — função pura única, usada na prévia do modal, na listagem e ao
// reabrir o modal pra editar. Diferente de calcularIndicadoresLoteEspetos:
// retorna o objeto mesmo quando quantidadeTeorica < 1 (nunca null nesse
// caso) — a UI precisa desse valor pra mostrar o erro específico e
// desabilitar Salvar (rendimento menor que a porção).
// ---------------------------------------------------------------------------

/**
 * lote = { rendimentoFinalQuantidade, rendimentoFinalUnidade, porcaoQuantidade, porcoesReais }.
 * componentes = lista de { quantidade, unidade, custoPorUnidadePreview } —
 * para listagem/comparação de custo, custoPorUnidadePreview é sempre o
 * custoPorUnidadeSnapshot histórico (nunca recalculado); para o modal de
 * edição aberto, é o valor mostrado na prévia daquele momento (ingredient
 * sempre atual; recipe recalculado de novo só no instante de salvar, ver
 * montarComponentesPayloadParaSalvarAcompanhamento).
 *
 * SEMPRE retorna um objeto (nunca null) — rendimentoTeoricoComponentes/
 * custoTotal continuam calculáveis mesmo sem rendimento/porção preenchidos
 * ainda; cada campo é individualmente null/NaN-safe, quem consome checa
 * campo a campo com Number.isFinite(...), nunca a verdade do objeto inteiro.
 */
function calcularIndicadoresLoteAcompanhamento(lote, componentes) {
  const { rendimentoFinalQuantidade, rendimentoFinalUnidade, porcaoQuantidade, porcoesReais } = lote;

  // Rendimento teórico dos componentes — SUM(component.quantity) só quando
  // há componentes E todos estão na mesma unidade (nunca soma unidades
  // diferentes, nunca converte g<->ml). Só uma referência operacional —
  // nunca persistida, nunca confundida com o rendimento automático de
  // Fichas Técnicas (calcularRendimentoReceita, que deriva de recipe_items).
  let rendimentoTeoricoComponentes = null;
  let unidadeRendimentoTeorico = null;
  if (componentes.length > 0) {
    const unidades = new Set(componentes.map((c) => c.unidade));
    if (unidades.size === 1) {
      rendimentoTeoricoComponentes = componentes.reduce((soma, c) => soma + c.quantidade, 0);
      unidadeRendimentoTeorico = componentes[0].unidade;
    }
  }

  const custoTotal = componentes.reduce((soma, c) => soma + c.quantidade * c.custoPorUnidadePreview, 0);

  const rendimentoValido = Number.isFinite(rendimentoFinalQuantidade) && rendimentoFinalQuantidade > 0;
  const porcaoValida = Number.isFinite(porcaoQuantidade) && porcaoQuantidade > 0;

  // Comparação só quando o teórico existe E está na MESMA unidade do
  // rendimento real informado (nunca compara g com un).
  let diferencaRendimento = null;
  let rendimentoPercentual = null;
  let perdaQuantidade = null;
  let perdaPercentual = null;
  if (rendimentoValido && rendimentoTeoricoComponentes !== null && unidadeRendimentoTeorico === rendimentoFinalUnidade) {
    diferencaRendimento = rendimentoFinalQuantidade - rendimentoTeoricoComponentes;
    rendimentoPercentual = (rendimentoFinalQuantidade / rendimentoTeoricoComponentes) * 100;
    perdaQuantidade = rendimentoTeoricoComponentes - rendimentoFinalQuantidade;
    perdaPercentual = 100 - rendimentoPercentual;
  }

  if (!rendimentoValido || !porcaoValida) {
    return {
      rendimentoTeoricoComponentes,
      unidadeRendimentoTeorico,
      diferencaRendimento,
      rendimentoPercentual,
      perdaQuantidade,
      perdaPercentual,
      quantidadeTeorica: null,
      sobra: null,
      diferencaPorcoes: null,
      custoTotal,
      custoPorBase: null,
      custoTeoricoPorPorcao: null,
      quantidadeFinal: null,
      custoRealPorPorcao: null,
    };
  }

  // Arredonda a razão a 6 casas antes do floor — mesma blindagem contra
  // imprecisão de ponto flutuante já usada em calcularIndicadoresLoteEspetos.
  const razao = Math.round((rendimentoFinalQuantidade / porcaoQuantidade) * 1e6) / 1e6;
  const quantidadeTeorica = Math.floor(razao);
  const sobra = rendimentoFinalQuantidade - quantidadeTeorica * porcaoQuantidade;

  // Custos — fórmulas intocadas: sempre baseadas no rendimento REAL
  // informado, nunca no rendimento teórico dos componentes. Fórmula
  // principal: porção × custo por base — nunca custoTotal/quantidadeTeorica,
  // que distorceria o custo teórico quando há sobra.
  const custoPorBase = custoTotal / rendimentoFinalQuantidade;
  const custoTeoricoPorPorcao = porcaoQuantidade * custoPorBase;

  const quantidadeFinal = Number.isFinite(porcoesReais) && porcoesReais > 0 ? porcoesReais : quantidadeTeorica;
  const custoRealPorPorcao = quantidadeFinal > 0 ? custoTotal / quantidadeFinal : null;

  const diferencaPorcoes = Number.isFinite(porcoesReais) && porcoesReais > 0 ? porcoesReais - quantidadeTeorica : null;

  return {
    rendimentoTeoricoComponentes,
    unidadeRendimentoTeorico,
    diferencaRendimento,
    rendimentoPercentual,
    perdaQuantidade,
    perdaPercentual,
    quantidadeTeorica,
    sobra,
    diferencaPorcoes,
    custoTotal,
    custoPorBase,
    custoTeoricoPorPorcao,
    quantidadeFinal,
    custoRealPorPorcao,
  };
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

function renderizarTabelaLotesAcompanhamentos() {
  const corpo = document.getElementById('corpo-tabela-acompanhamentos');
  const vazio = document.getElementById('estado-vazio-acompanhamentos');

  if (lotesAcompanhamentosCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = lotesAcompanhamentosCache.map(linhaLoteAcompanhamentoHtml).join('');

  corpo.querySelectorAll('[data-acao-editar-lote-acompanhamento]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalLoteAcompanhamento(botao.dataset.acaoEditarLoteAcompanhamento));
  });
}

/** Nome do produto sempre vem de produtosCache completo (nunca filtrado) — produto inativo continua aparecendo em lotes antigos. Custo total/real sempre a partir de custoPorUnidadeSnapshot histórico (zero query por linha). */
function linhaLoteAcompanhamentoHtml(lote) {
  const produto = produtoPorId(lote.produtoId);
  const nomeProduto = produto ? produto.nome : '(produto removido)';

  const componentesSnapshot = componentesDoLoteAcompanhamento(lote.id).map((c) => ({
    quantidade: c.quantidade,
    unidade: c.unidade,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
  }));
  const indicadores = calcularIndicadoresLoteAcompanhamento(lote, componentesSnapshot);

  const rendimentoTexto = `${formatarQuantidadeRendimento(lote.rendimentoFinalQuantidade)} ${lote.rendimentoFinalUnidade}`;
  const porcaoTexto = `${formatarQuantidadeRendimento(lote.porcaoQuantidade)} ${lote.porcaoUnidade}`;
  const qtdTeoricaTexto = Number.isFinite(indicadores.quantidadeTeorica) ? String(indicadores.quantidadeTeorica) : '—';
  const qtdRealTexto = lote.porcoesReais === null ? 'Não informada' : String(lote.porcoesReais);
  const custoTotalTexto = formatarMoeda(indicadores.custoTotal);
  const custoRealTexto = Number.isFinite(indicadores.custoRealPorPorcao) ? formatarMoeda(indicadores.custoRealPorPorcao) : '—';

  return `
    <tr>
      <td>${formatarDataProducao(lote.produzidoEm)}</td>
      <td>${escaparHtml(nomeProduto)}</td>
      <td>${rendimentoTexto}</td>
      <td>${porcaoTexto}</td>
      <td>${qtdTeoricaTexto}</td>
      <td>${qtdRealTexto}</td>
      <td>${custoTotalTexto}</td>
      <td>${custoRealTexto}</td>
      <td>
        <button class="btn-icone" data-acao-editar-lote-acompanhamento="${lote.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Opções de produto no modal — só ativos da categoria Acompanhamentos pra um
// lote NOVO (categoria já mapeada pt-BR por products-service.js — valor real
// no banco é 'sides'). product_id continua editável num lote existente, então
// ao editar um lote cujo produto não está mais na lista de ativos, ele é
// incluído como opção extra rotulada — mesmo padrão de popularOpcoesProdutoLote.
// ---------------------------------------------------------------------------

function popularOpcoesProdutoAcompanhamento(produtoAtualId) {
  const select = document.getElementById('campo-produto-acompanhamento');
  const disponiveis = produtosCache
    .filter((p) => p.categoria === 'Acompanhamentos' && p.status === 'ativo')
    .sort((a, b) => a.nome.localeCompare(b.nome));

  let opcoesHtml = disponiveis.map((p) => `<option value="${p.id}">${escaparHtml(p.nome)}</option>`).join('');

  const atual = produtoAtualId ? produtoPorId(produtoAtualId) : null;
  if (atual && !disponiveis.some((p) => p.id === atual.id)) {
    opcoesHtml += `<option value="${atual.id}">${escaparHtml(atual.nome)} (inativo ou fora de Acompanhamentos)</option>`;
  }

  select.innerHTML = opcoesHtml;
}

// ---------------------------------------------------------------------------
// Componentes (Ingredientes/Preparos) — estado só de memória
// (componentesAcompanhamentoEmEdicao) até "Salvar". A RPC substitui a lista
// inteira no banco — remover aqui só tira do estado do modal, nunca chama o
// Supabase isoladamente.
// ---------------------------------------------------------------------------

/**
 * Tipo=Ingrediente: TODOS os ingredientes ativos (sem filtro de categoria —
 * diferente de Temperos/Preparos de Espetos, Acompanhamentos pode usar
 * Batata/Cenoura/Maionese/Sal/etc). Tipo=Preparo: só receitas ativas com
 * rendimento derivado disponível (reaproveita calcularRendimentoReceita já
 * existente, mesmo filtro de popularOpcoesTemperoLote/popularOpcoesPreparoItem
 * — sem duplicar regra).
 */
function popularOpcoesComponenteAcompanhamento() {
  const tipo = document.getElementById('campo-tipo-componente-acompanhamento').value;
  const select = document.getElementById('campo-referencia-componente-acompanhamento');
  document.getElementById('rotulo-referencia-componente-acompanhamento').textContent = tipo === 'recipe' ? 'Preparo' : 'Ingrediente';

  let candidatos;
  if (tipo === 'recipe') {
    candidatos = receitasCache.filter((r) => r.ativo && calcularRendimentoReceita(r.id).disponivel).sort((a, b) => a.nome.localeCompare(b.nome));
  } else {
    candidatos = ingredientesCache.filter((i) => i.ativo).sort((a, b) => a.nome.localeCompare(b.nome));
  }
  select.innerHTML = candidatos.map((c) => `<option value="${c.id}">${escaparHtml(c.nome)}</option>`).join('');

  popularOpcoesLoteComponenteAcompanhamento(tipo === 'ingredient' ? select.value || null : null, null);
  atualizarUnidadeComponenteAcompanhamento();
}

/**
 * Etapa G4 — equivalente exato de popularOpcoesLoteTemperoLote (Espetos),
 * só com ids trocados. Só relevante para item_type='ingredient'.
 */
function popularOpcoesLoteComponenteAcompanhamento(ingredienteId, loteAtualId) {
  const grupo = document.getElementById('grupo-lote-componente-acompanhamento');
  const select = document.getElementById('campo-lote-componente-acompanhamento');
  const dicaNenhum = document.getElementById('dica-lote-componente-acompanhamento-nenhum-disponivel');
  const dicaSemItem = document.getElementById('dica-lote-componente-acompanhamento-sem-vinculo');

  if (!ingredienteId) {
    grupo.style.display = 'none';
    select.innerHTML = '';
    return;
  }
  grupo.style.display = '';

  const itemCompra = itemCompraDoIngrediente(ingredienteId);
  dicaSemItem.style.display = itemCompra ? 'none' : '';

  const disponiveis = itemCompra ? lotesDisponiveisDoItemCompra(itemCompra.id) : [];
  const loteHistorico = loteAtualId ? lotePorId(loteAtualId) : null;
  const jaNaLista = loteHistorico && disponiveis.some((l) => l.id === loteHistorico.id);

  dicaNenhum.style.display = itemCompra && disponiveis.length === 0 && !loteHistorico ? '' : 'none';

  const opcoes = ['<option value="">Sem lote / custo cadastrado</option>'];
  if (loteHistorico && !jaNaLista) {
    opcoes.push(`<option value="${loteHistorico.id}">${escaparHtml(rotuloLote(loteHistorico, { usadoNesteBatch: true }))}</option>`);
  }
  disponiveis.forEach((lote, indice) => {
    const sugerido = indice === 0 ? ' (Sugerido — mais antigo)' : '';
    opcoes.push(`<option value="${lote.id}">${escaparHtml(rotuloLote(lote))}${sugerido}</option>`);
  });
  select.innerHTML = opcoes.join('');
  select.value = loteAtualId || '';
}

function atualizarUnidadeComponenteAcompanhamento() {
  const tipo = document.getElementById('campo-tipo-componente-acompanhamento').value;
  const referenciaId = document.getElementById('campo-referencia-componente-acompanhamento').value;
  const textoUnidade = document.getElementById('texto-unidade-componente-acompanhamento');

  if (!referenciaId) {
    textoUnidade.textContent = '—';
    return;
  }
  if (tipo === 'recipe') {
    const rendimento = calcularRendimentoReceita(referenciaId);
    textoUnidade.textContent = rendimento.disponivel ? rendimento.unidade : '—';
  } else {
    // Etapa G4: lote selecionado trava a unidade em lote.unidadeBase.
    const loteId = document.getElementById('campo-lote-componente-acompanhamento').value;
    const lote = loteId ? lotePorId(loteId) : null;
    if (lote) {
      textoUnidade.textContent = lote.unidadeBase;
    } else {
      const ingrediente = ingredientePorId(referenciaId);
      textoUnidade.textContent = ingrediente ? ingrediente.unidadeBase : '—';
    }
  }
}

/** Reaproveita custoTotalReceita/calcularRendimentoReceita (Fichas Técnicas) pra Preparo, e cost_per_base_unit direto pra Ingrediente — nunca duplica fórmula. */
function atualizarPreviewComponenteAcompanhamento() {
  const preview = document.getElementById('preview-componente-acompanhamento');
  const dicaSaldo = document.getElementById('dica-componente-acompanhamento-lote-saldo-insuficiente');
  const tipo = document.getElementById('campo-tipo-componente-acompanhamento').value;
  const referenciaId = document.getElementById('campo-referencia-componente-acompanhamento').value;
  const quantidade = Number(document.getElementById('campo-quantidade-componente-acompanhamento').value);

  dicaSaldo.style.display = 'none';

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
    // Etapa G4: lote selecionado é a fonte do custo — nunca o cadastro
    // atual do ingrediente quando um lote específico manda.
    const loteId = document.getElementById('campo-lote-componente-acompanhamento').value;
    const lote = loteId ? lotePorId(loteId) : null;
    const custoPorUnidade = lote ? lote.custoPorUnidadeBase : ingrediente.custoPorUnidadeBase;
    const unidadeExibicao = lote ? lote.unidadeBase : ingrediente.unidadeBase;
    const custoEstimado = quantidade * custoPorUnidade;
    preview.textContent = `${quantidade} ${unidadeExibicao} × ${formatarCustoBaseIngrediente(custoPorUnidade, unidadeExibicao)} = ${formatarMoeda(custoEstimado)}`;

    if (lote) {
      const idLoteAtual = document.getElementById('campo-id-lote-acompanhamento').value || null;
      const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'side_production', idLoteAtual);
      if (quantidade > saldoEfetivo) {
        dicaSaldo.style.display = '';
      }
    }
  }
}

function adicionarComponenteAcompanhamento() {
  if (!souAdminProducao) return;
  const dicaErro = document.getElementById('dica-componente-acompanhamento-erro');
  const tipo = document.getElementById('campo-tipo-componente-acompanhamento').value;
  const referenciaId = document.getElementById('campo-referencia-componente-acompanhamento').value;
  const quantidade = Number(document.getElementById('campo-quantidade-componente-acompanhamento').value);
  const lotId = tipo === 'ingredient' ? document.getElementById('campo-lote-componente-acompanhamento').value || null : null;

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
  if (componentesAcompanhamentoEmEdicao.some((c) => c.tipoItem === tipo && c.referenciaId === referenciaId && (c.lotId || null) === lotId)) {
    dicaErro.textContent = tipo === 'recipe' ? 'Este preparo já foi adicionado a este lote.' : 'Este ingrediente já foi adicionado a este lote (mesmo lote, ou sem lote).';
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
    const lote = lotId ? lotePorId(lotId) : null;
    nome = ingrediente.nome;
    unidade = lote ? lote.unidadeBase : ingrediente.unidadeBase;
    custoPorUnidadePreview = lote ? lote.custoPorUnidadeBase : ingrediente.custoPorUnidadeBase;

    if (lote) {
      const idLoteAtual = document.getElementById('campo-id-lote-acompanhamento').value || null;
      const saldoEfetivo = saldoEfetivoLoteParaEdicao(lote.id, 'side_production', idLoteAtual);
      if (quantidade > saldoEfetivo) {
        dicaErro.textContent = 'Quantidade maior que o saldo disponível neste lote.';
        dicaErro.style.display = '';
        return;
      }
    }
  }

  dicaErro.style.display = 'none';
  componentesAcompanhamentoEmEdicao.push({ tipoItem: tipo, referenciaId, quantidade, unidade, nome, custoPorUnidadePreview, lotId });

  document.getElementById('campo-quantidade-componente-acompanhamento').value = '';
  document.getElementById('preview-componente-acompanhamento').textContent = '';
  document.getElementById('dica-componente-acompanhamento-lote-saldo-insuficiente').style.display = 'none';
  popularOpcoesLoteComponenteAcompanhamento(tipo === 'ingredient' ? referenciaId : null, null);
  renderizarListaComponentesAcompanhamento();
}

/** Versão dedicada (não reaproveita renderizarListaComponentes/linhaComponenteLoteHtml de Espetos, que fecham sobre componentesLoteEmEdicao) — mesmas classes CSS já existentes. */
function renderizarListaComponentesAcompanhamento() {
  const lista = document.getElementById('lista-componentes-acompanhamento');
  const vazio = document.getElementById('estado-vazio-componentes-acompanhamento');
  const itens = componentesAcompanhamentoEmEdicao;

  if (itens.length === 0) {
    lista.innerHTML = '';
    vazio.style.display = 'block';
  } else {
    vazio.style.display = 'none';
    lista.innerHTML = itens.map(linhaComponenteAcompanhamentoHtml).join('');
    lista.querySelectorAll('[data-acao-remover-componente-acompanhamento]').forEach((botao) => {
      botao.addEventListener('click', () => removerComponenteAcompanhamento(Number(botao.dataset.acaoRemoverComponenteAcompanhamento)));
    });
  }

  atualizarResumoLoteAcompanhamento();
}

function linhaComponenteAcompanhamentoHtml(componente) {
  const indice = componentesAcompanhamentoEmEdicao.indexOf(componente);
  const tipoLabel = componente.tipoItem === 'recipe' ? 'Preparo' : 'Ingrediente';
  const quantidadeTexto = Number.isInteger(componente.quantidade) ? componente.quantidade : componente.quantidade.toString().replace('.', ',');
  const custoLinha = componente.quantidade * componente.custoPorUnidadePreview;
  // Etapa G4: resumo de lote abaixo do nome — só quando o componente tem lotId.
  const loteDoComponente = componente.lotId ? lotePorId(componente.lotId) : null;
  const linhaLote = loteDoComponente
    ? `<div class="producao-linha-componente-lote-detalhe">Lote ${formatarDataProducao(loteDoComponente.recebidoEm)} · ${formatarCustoBaseIngrediente(loteDoComponente.custoPorUnidadeBase, loteDoComponente.unidadeBase)}</div>`
    : '';

  return `
    <div class="producao-linha-componente-lote">
      <span class="producao-linha-componente-nome">${escaparHtml(componente.nome)}</span>
      <span class="producao-linha-componente-tipo">${tipoLabel}</span>
      <span class="producao-linha-componente-quantidade">${quantidadeTexto} ${componente.unidade}</span>
      <span class="producao-linha-componente-custo">${formatarMoeda(custoLinha)}</span>
      <button type="button" class="btn-icone" data-acao-remover-componente-acompanhamento="${indice}" title="Remover" ${souAdminProducao ? '' : 'disabled'}>🗑️</button>
    </div>${linhaLote}`;
}

function removerComponenteAcompanhamento(indice) {
  if (!souAdminProducao) return;
  componentesAcompanhamentoEmEdicao.splice(indice, 1);
  renderizarListaComponentesAcompanhamento();
}

/** Lê rendimento/porção/porções reais do formulário — porcaoUnidade sempre igual à unidade do rendimento corrente (travada na UI, nunca um select independente). */
function lerDadosFormularioLoteAcompanhamento() {
  const unidade = document.getElementById('campo-rendimento-unidade-acompanhamento').value;
  const porcoesReaisTexto = document.getElementById('campo-porcoes-reais-acompanhamento').value;
  return {
    rendimentoFinalQuantidade: Number(document.getElementById('campo-rendimento-quantidade-acompanhamento').value),
    rendimentoFinalUnidade: unidade,
    porcaoQuantidade: Number(document.getElementById('campo-porcao-quantidade-acompanhamento').value),
    porcaoUnidade: unidade,
    porcoesReais: porcoesReaisTexto === '' ? null : Number(porcoesReaisTexto),
  };
}

/** Recalculada a cada tecla/troca de unidade, sempre client-side — nunca consulta o Supabase. */
function atualizarPreviewLoteAcompanhamento() {
  document.getElementById('texto-unidade-porcao-acompanhamento').textContent =
    document.getElementById('campo-rendimento-unidade-acompanhamento').value;
  atualizarResumoLoteAcompanhamento();
}

/** Soma custo dos componentes atuais do estado do modal + rendimento/porção/porções reais lidos direto dos campos — sempre client-side. Mostra o aviso de rendimento inválido e desabilita Salvar quando quantidadeTeorica < 1, mesmo com porções reais preenchidas. */
/**
 * Escreve as 10 linhas do bloco "Indicadores da Produção", escondendo cada
 * uma individualmente quando não calculável (nunca mostra "—" pra algo que
 * simplesmente não se aplica ainda). "Perda" só aparece quando o rendimento
 * real é MENOR que o teórico dos componentes — se for maior/igual, mostra só
 * Diferença (com sinal "+") e Rendimento (>100%), nunca "perda negativa".
 */
function renderizarIndicadoresProducaoAcompanhamento(dados, indicadores) {
  const definir = (id, texto) => {
    document.getElementById(id).textContent = texto;
  };
  const mostrarLinha = (idLinha, mostrar) => {
    document.getElementById(idLinha).style.display = mostrar ? '' : 'none';
  };

  const temComponentes = componentesAcompanhamentoEmEdicao.length > 0;
  mostrarLinha('linha-indicador-rendimento-teorico', temComponentes);
  if (temComponentes) {
    definir(
      'indicadores-rendimento-teorico',
      indicadores.rendimentoTeoricoComponentes === null
        ? 'Indisponível para unidades mistas'
        : `${formatarQuantidadeRendimento(indicadores.rendimentoTeoricoComponentes)} ${indicadores.unidadeRendimentoTeorico}`
    );
  }

  const rendimentoValido = Number.isFinite(dados.rendimentoFinalQuantidade) && dados.rendimentoFinalQuantidade > 0;
  mostrarLinha('linha-indicador-rendimento-real', rendimentoValido);
  if (rendimentoValido) {
    definir('indicadores-rendimento-real', `${formatarQuantidadeRendimento(dados.rendimentoFinalQuantidade)} ${dados.rendimentoFinalUnidade}`);
  }

  const comparacaoDisponivel = indicadores.diferencaRendimento !== null;
  mostrarLinha('linha-indicador-diferenca-rendimento', comparacaoDisponivel);
  mostrarLinha('linha-indicador-rendimento-percentual', comparacaoDisponivel);
  mostrarLinha('linha-indicador-perda', comparacaoDisponivel && indicadores.diferencaRendimento < 0);
  if (comparacaoDisponivel) {
    const sinal = indicadores.diferencaRendimento > 0 ? '+' : '';
    definir('indicadores-diferenca-rendimento', `${sinal}${formatarQuantidadeRendimento(indicadores.diferencaRendimento)} ${dados.rendimentoFinalUnidade}`);
    definir('indicadores-rendimento-percentual', formatarPercentual(indicadores.rendimentoPercentual));
    if (indicadores.diferencaRendimento < 0) {
      definir(
        'indicadores-perda',
        `${formatarQuantidadeRendimento(indicadores.perdaQuantidade)} ${dados.rendimentoFinalUnidade} (${formatarPercentual(indicadores.perdaPercentual)})`
      );
    }
  }

  const porcaoValida = Number.isFinite(dados.porcaoQuantidade) && dados.porcaoQuantidade > 0;
  mostrarLinha('linha-indicador-porcao', porcaoValida);
  if (porcaoValida) definir('indicadores-porcao', `${formatarQuantidadeRendimento(dados.porcaoQuantidade)} ${dados.porcaoUnidade}`);

  const teoricaDisponivel = Number.isFinite(indicadores.quantidadeTeorica);
  mostrarLinha('linha-indicador-porcoes-teoricas', teoricaDisponivel);
  if (teoricaDisponivel) definir('indicadores-porcoes-teoricas', String(indicadores.quantidadeTeorica));

  const reaisInformadas = dados.porcoesReais !== null;
  mostrarLinha('linha-indicador-porcoes-reais', reaisInformadas);
  if (reaisInformadas) definir('indicadores-porcoes-reais', String(dados.porcoesReais));

  const diferencaPorcoesDisponivel = indicadores.diferencaPorcoes !== null;
  mostrarLinha('linha-indicador-diferenca-porcoes', diferencaPorcoesDisponivel);
  if (diferencaPorcoesDisponivel) {
    const sinal = indicadores.diferencaPorcoes > 0 ? '+' : '';
    definir('indicadores-diferenca-porcoes', `${sinal}${indicadores.diferencaPorcoes}`);
  }

  const sobraDisponivel = Number.isFinite(indicadores.sobra);
  mostrarLinha('linha-indicador-sobra', sobraDisponivel);
  if (sobraDisponivel) definir('indicadores-sobra', `${formatarQuantidadeRendimento(indicadores.sobra)} ${dados.rendimentoFinalUnidade}`);
}

/** Orquestrador chamado a cada input/change relevante — indicadores comparativos + resumo de custos + aviso/desabilitação de Salvar quando rendimento/porção não produz nenhuma porção válida. */
function atualizarResumoLoteAcompanhamento() {
  const dados = lerDadosFormularioLoteAcompanhamento();
  const indicadores = calcularIndicadoresLoteAcompanhamento(dados, componentesAcompanhamentoEmEdicao);

  renderizarIndicadoresProducaoAcompanhamento(dados, indicadores);

  const definir = (id, texto) => {
    document.getElementById(id).textContent = texto;
  };
  definir('resumo-acomp-custo-total', formatarMoeda(indicadores.custoTotal));
  definir('resumo-acomp-custo-base', Number.isFinite(indicadores.custoPorBase) ? formatarCustoPorRendimento(indicadores.custoPorBase, dados.rendimentoFinalUnidade) : '—');
  definir('resumo-acomp-custo-teorico', Number.isFinite(indicadores.custoTeoricoPorPorcao) ? formatarMoeda(indicadores.custoTeoricoPorPorcao) + '/porção' : '—');
  definir('resumo-acomp-custo-real', Number.isFinite(indicadores.custoRealPorPorcao) ? formatarMoeda(indicadores.custoRealPorPorcao) + '/porção' : '—');

  const dicaInvalida = document.getElementById('dica-acomp-rendimento-invalido');
  const botaoSalvar = document.getElementById('botao-salvar-lote-acompanhamento');
  const rendimentoInvalido = Number.isFinite(indicadores.quantidadeTeorica) && indicadores.quantidadeTeorica < 1;
  dicaInvalida.style.display = rendimentoInvalido ? '' : 'none';
  botaoSalvar.disabled = !souAdminProducao || rendimentoInvalido;
}

// ---------------------------------------------------------------------------
// Custo do Produto — comparação e aplicação manual do custo real por porção
// de um lote JÁ SALVO em product_costs.unit_cost, reaproveitando
// calcularComparacaoCustoProduto/aplicarCustoProducaoAcompanhamentoNoSupabase/
// custosProdutosCache já existentes — a escrita passa pela RPC
// apply_side_production_cost (SECURITY DEFINER, valida server-side que o
// produto é da categoria Acompanhamentos), nunca um INSERT/UPDATE direto em
// product_costs. Nunca altera o lote em si. O bloco reflete sempre o ÚLTIMO
// ESTADO SALVO do lote — só atualizado em abrirModalLoteAcompanhamento() e
// depois de aplicar com sucesso, nunca reativo a edições ainda não salvas.
// ---------------------------------------------------------------------------

/** Guarda { produtoId, produtoNome, custoLote, custoAtual } do lote atualmente aberto no modal, ou null. */
let comparacaoCustoAcompanhamentoAtual = null;

/** Só chamada por abrirModalLoteAcompanhamento (lote já salvo) — nunca por abrirModalNovoLoteAcompanhamento. */
function renderizarBlocoCustoAcompanhamentoProduto(lote) {
  const bloco = document.getElementById('bloco-custo-acomp-produto');

  const produto = produtoPorId(lote.produtoId);
  const componentesSnapshot = componentesDoLoteAcompanhamento(lote.id).map((c) => ({
    quantidade: c.quantidade,
    unidade: c.unidade,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
  }));
  const indicadores = calcularIndicadoresLoteAcompanhamento(lote, componentesSnapshot);
  const custoLote = indicadores.custoRealPorPorcao;
  const custoAtual = custosProdutosCache.has(lote.produtoId) ? custosProdutosCache.get(lote.produtoId) : null;
  const comparacao = calcularComparacaoCustoProduto(custoAtual, Number.isFinite(custoLote) ? custoLote : NaN);

  document.getElementById('custoproduto-acomp-nome-produto').textContent = produto ? produto.nome : '(produto removido)';
  document.getElementById('custoproduto-acomp-origem-lote').textContent = `Lote de ${formatarDataProducao(lote.produzidoEm)}`;
  document.getElementById('custoproduto-acomp-custo-atual').textContent =
    comparacao.custoAtual === null ? 'Sem custo cadastrado' : formatarMoeda(comparacao.custoAtual);
  document.getElementById('custoproduto-acomp-custo-lote').textContent = Number.isFinite(custoLote) ? formatarMoeda(custoLote) : '—';
  document.getElementById('custoproduto-acomp-diferenca').textContent = formatarDiferencaCusto(comparacao.diferenca);
  document.getElementById('custoproduto-acomp-variacao').textContent = formatarVariacaoPercentual(comparacao.variacaoPercentual);

  document.getElementById('dica-produto-acomp-inativo-custo').style.display = produto && produto.status !== 'ativo' ? '' : 'none';
  document.getElementById('dica-custo-acomp-ja-aplicado').style.display = comparacao.mesmoCustoPersistido ? '' : 'none';
  document.getElementById('dica-custo-acomp-produto-erro').style.display = 'none';

  document.getElementById('botao-aplicar-custo-acomp-produto').disabled =
    !souAdminProducao || comparacao.mesmoCustoPersistido || !Number.isFinite(custoLote);

  comparacaoCustoAcompanhamentoAtual = Number.isFinite(custoLote)
    ? {
        produtoId: lote.produtoId,
        produtoNome: produto ? produto.nome : '(produto removido)',
        custoLote,
        custoAtual: comparacao.custoAtual,
      }
    : null;

  bloco.style.display = '';
}

function ocultarBlocoCustoAcompanhamentoProduto() {
  document.getElementById('bloco-custo-acomp-produto').style.display = 'none';
  comparacaoCustoAcompanhamentoAtual = null;
}

/**
 * Confirmação explícita mostrando 4 casas (precisão real de
 * product_costs.unit_cost) — a chamada real à RPC envia apenas o id do
 * lote, nunca esse valor: apply_side_production_cost recalcula tudo do zero
 * a partir dos snapshots salvos. Depois do sucesso, o cache é atualizado com
 * o valor RETORNADO pela RPC, nunca com custoLote (calculado localmente).
 */
async function aplicarCustoAoProdutoAcompanhamentoModal() {
  if (!souAdminProducao || !comparacaoCustoAcompanhamentoAtual) return;
  const { produtoNome, custoLote, custoAtual } = comparacaoCustoAcompanhamentoAtual;
  const loteId = document.getElementById('campo-id-lote-acompanhamento').value;
  if (!loteId) return;

  const diferenca = custoAtual === null ? null : custoLote - custoAtual;
  const confirmado = confirm(
    `Aplicar ${formatarMoeda4Casas(custoLote)} como novo custo do produto ${produtoNome}?\n\n` +
      `Custo atual: ${custoAtual === null ? 'Sem custo cadastrado' : formatarMoeda4Casas(custoAtual)}\n` +
      `Novo custo: ${formatarMoeda4Casas(custoLote)}\n` +
      `Diferença: ${formatarDiferenca4Casas(diferenca)}`
  );
  if (!confirmado) return;

  const dicaErro = document.getElementById('dica-custo-acomp-produto-erro');
  const botao = document.getElementById('botao-aplicar-custo-acomp-produto');
  dicaErro.style.display = 'none';
  botao.disabled = true;

  let resultado;
  try {
    resultado = await aplicarCustoProducaoAcompanhamentoNoSupabase(loteId);
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível aplicar o custo. ' + erro.message;
    dicaErro.style.display = '';
    botao.disabled = false;
    return;
  }

  custosProdutosCache.set(resultado.produtoId, resultado.unitCost);
  mostrarToast('Custo aplicado ao produto.', 'sucesso');

  const lote = lotesAcompanhamentosCache.find((l) => l.id === loteId);
  if (lote) renderizarBlocoCustoAcompanhamentoProduto(lote);
}

// ---------------------------------------------------------------------------
// Modal: novo/editar lote de acompanhamento
// ---------------------------------------------------------------------------

function ligarEventosModalLoteAcompanhamento() {
  document.getElementById('botao-novo-lote-acompanhamento').addEventListener('click', abrirModalNovoLoteAcompanhamento);
  document.getElementById('botao-fechar-modal-lote-acompanhamento').addEventListener('click', fecharModalLoteAcompanhamento);
  document.getElementById('botao-cancelar-lote-acompanhamento').addEventListener('click', fecharModalLoteAcompanhamento);

  ['campo-rendimento-quantidade-acompanhamento', 'campo-rendimento-unidade-acompanhamento', 'campo-porcao-quantidade-acompanhamento', 'campo-porcoes-reais-acompanhamento'].forEach(
    (idCampo) => {
      const campo = document.getElementById(idCampo);
      campo.addEventListener('input', atualizarPreviewLoteAcompanhamento);
      campo.addEventListener('change', atualizarPreviewLoteAcompanhamento);
    }
  );

  document.getElementById('botao-excluir-lote-acompanhamento').addEventListener('click', excluirLoteAcompanhamentoModal);
  document.getElementById('form-lote-acompanhamento').addEventListener('submit', salvarFormularioLoteAcompanhamento);
  document.getElementById('botao-aplicar-custo-acomp-produto').addEventListener('click', aplicarCustoAoProdutoAcompanhamentoModal);

  document.getElementById('campo-tipo-componente-acompanhamento').addEventListener('change', () => {
    popularOpcoesComponenteAcompanhamento();
    atualizarPreviewComponenteAcompanhamento();
  });
  document.getElementById('campo-referencia-componente-acompanhamento').addEventListener('change', () => {
    // Etapa G4 (item 12): trocar o ingrediente/preparo limpa o lote
    // selecionado imediatamente.
    const tipo = document.getElementById('campo-tipo-componente-acompanhamento').value;
    const referenciaId = document.getElementById('campo-referencia-componente-acompanhamento').value;
    popularOpcoesLoteComponenteAcompanhamento(tipo === 'ingredient' ? referenciaId || null : null, null);
    atualizarUnidadeComponenteAcompanhamento();
    atualizarPreviewComponenteAcompanhamento();
  });
  document.getElementById('campo-lote-componente-acompanhamento').addEventListener('change', () => {
    atualizarUnidadeComponenteAcompanhamento();
    atualizarPreviewComponenteAcompanhamento();
  });
  document.getElementById('campo-quantidade-componente-acompanhamento').addEventListener('input', atualizarPreviewComponenteAcompanhamento);
  document.getElementById('botao-adicionar-componente-acompanhamento').addEventListener('click', adicionarComponenteAcompanhamento);
}

/** Estado do formulário de "+ Adicionar" componente, reiniciado toda vez que o modal abre (novo ou editar). */
function reiniciarFormularioComponenteAcompanhamento() {
  document.getElementById('campo-tipo-componente-acompanhamento').value = 'ingredient';
  popularOpcoesComponenteAcompanhamento();
  document.getElementById('campo-quantidade-componente-acompanhamento').value = '';
  document.getElementById('preview-componente-acompanhamento').textContent = '';
  document.getElementById('dica-componente-acompanhamento-erro').style.display = 'none';
  document.getElementById('dica-componente-acompanhamento-lote-saldo-insuficiente').style.display = 'none';
  renderizarListaComponentesAcompanhamento();
}

function abrirModalNovoLoteAcompanhamento() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-lote-acompanhamento').textContent = 'Nova Produção de Acompanhamento';
  document.getElementById('campo-id-lote-acompanhamento').value = '';
  popularOpcoesProdutoAcompanhamento(null);
  document.getElementById('campo-produto-acompanhamento').value = '';
  document.getElementById('campo-data-acompanhamento').value = dataHojeLocal();
  document.getElementById('campo-rendimento-quantidade-acompanhamento').value = '';
  document.getElementById('campo-rendimento-unidade-acompanhamento').value = 'g';
  document.getElementById('campo-porcao-quantidade-acompanhamento').value = '';
  document.getElementById('campo-porcoes-reais-acompanhamento').value = '';
  document.getElementById('dica-lote-acompanhamento-erro').style.display = 'none';
  document.getElementById('botao-excluir-lote-acompanhamento').style.display = 'none';

  componentesAcompanhamentoEmEdicao = [];
  reiniciarFormularioComponenteAcompanhamento();
  ocultarBlocoCustoAcompanhamentoProduto();

  atualizarPreviewLoteAcompanhamento();
  abrirModal('modal-overlay-lote-acompanhamento');
}

/**
 * Carrega os componentes já salvos: nome/quantidade/unidade/custo
 * EXATAMENTE como estão em componentesDoLoteAcompanhamento (histórico, não
 * recalculado) — isso é só a EXIBIÇÃO inicial. Ao salvar, ingredient é
 * sempre resolvido de novo pela RPC e recipe é sempre recalculado pelo
 * client no momento do save (ver montarComponentesPayloadParaSalvarAcompanhamento)
 * — editar o lote redefine seu estado final com custos atuais, mesmo padrão
 * já documentado em Produção de Espetos.
 */
function abrirModalLoteAcompanhamento(id) {
  if (!souAdminProducao) return;
  const lote = lotesAcompanhamentosCache.find((l) => l.id === id);
  if (!lote) return;

  document.getElementById('titulo-modal-lote-acompanhamento').textContent = 'Editar Produção de Acompanhamento';
  document.getElementById('campo-id-lote-acompanhamento').value = lote.id;
  popularOpcoesProdutoAcompanhamento(lote.produtoId);
  document.getElementById('campo-produto-acompanhamento').value = lote.produtoId;
  document.getElementById('campo-data-acompanhamento').value = lote.produzidoEm;
  document.getElementById('campo-rendimento-quantidade-acompanhamento').value = lote.rendimentoFinalQuantidade;
  document.getElementById('campo-rendimento-unidade-acompanhamento').value = lote.rendimentoFinalUnidade;
  document.getElementById('campo-porcao-quantidade-acompanhamento').value = lote.porcaoQuantidade;
  document.getElementById('campo-porcoes-reais-acompanhamento').value = lote.porcoesReais === null ? '' : lote.porcoesReais;
  document.getElementById('dica-lote-acompanhamento-erro').style.display = 'none';
  document.getElementById('botao-excluir-lote-acompanhamento').style.display = souAdminProducao ? '' : 'none';

  componentesAcompanhamentoEmEdicao = componentesDoLoteAcompanhamento(lote.id).map((c) => ({
    tipoItem: c.tipoItem,
    referenciaId: c.ingredienteId || c.receitaId,
    quantidade: c.quantidade,
    unidade: c.unidade,
    nome: c.nomeSnapshot,
    custoPorUnidadePreview: c.custoPorUnidadeSnapshot,
    lotId: c.lotId || null,
  }));
  reiniciarFormularioComponenteAcompanhamento();
  renderizarBlocoCustoAcompanhamentoProduto(lote);

  atualizarPreviewLoteAcompanhamento();
  abrirModal('modal-overlay-lote-acompanhamento');
}

function fecharModalLoteAcompanhamento() {
  fecharModal('modal-overlay-lote-acompanhamento');
}

/** Espelha no cliente os CHECKs/validações da RPC, só pra feedback mais rápido — o banco continua a fonte real. */
function validarFormularioLoteAcompanhamento({ produtoId, dataProducao, rendimentoFinalQuantidade, rendimentoFinalUnidade, porcaoQuantidade, porcaoUnidade, porcoesReais }) {
  if (!produtoId) return 'Selecione o produto.';
  if (!dataProducao) return 'Informe a data da produção.';
  if (!Number.isFinite(rendimentoFinalQuantidade) || rendimentoFinalQuantidade <= 0) return 'Informe um rendimento final válido, maior que zero.';
  if (!rendimentoFinalUnidade) return 'Selecione a unidade do rendimento.';
  if (!Number.isFinite(porcaoQuantidade) || porcaoQuantidade <= 0) return 'Informe uma porção válida, maior que zero.';
  if (porcaoUnidade !== rendimentoFinalUnidade) return 'A unidade da porção deve ser igual à do rendimento.';
  if (porcoesReais !== null && (!Number.isFinite(porcoesReais) || porcoesReais <= 0)) return 'Quantidade real de porções deve ser maior que zero.';

  const razao = Math.round((rendimentoFinalQuantidade / porcaoQuantidade) * 1e6) / 1e6;
  if (Math.floor(razao) < 1) return 'O rendimento informado não produz nenhuma porção válida.';

  if (componentesAcompanhamentoEmEdicao.length === 0) return 'Adicione pelo menos um ingrediente ou preparo.';

  return null;
}

/**
 * Monta o payload de componentes pro service/RPC a partir do estado do
 * modal. ingredient nunca leva custo (a RPC resolve sozinha, sempre com o
 * valor atual). recipe é a ÚNICA exceção: o custo é sempre RECALCULADO
 * AGORA (nunca reaproveita custoPorUnidadePreview, que pode ter sido
 * carregado de um snapshot antigo ao abrir o modal) — mesma disciplina de
 * montarComponentesPayloadParaSalvar (Espetos): editar o lote redefine seu
 * estado final, então um preparo usado num lote antigo passa a refletir o
 * custo atual da ficha técnica no momento do save.
 */
function montarComponentesPayloadParaSalvarAcompanhamento() {
  return componentesAcompanhamentoEmEdicao.map((componente) => {
    if (componente.tipoItem !== 'recipe') {
      return {
        tipoItem: componente.tipoItem,
        referenciaId: componente.referenciaId,
        quantidade: componente.quantidade,
        unidade: componente.unidade,
        lotId: componente.lotId || null,
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

async function salvarFormularioLoteAcompanhamento(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const id = document.getElementById('campo-id-lote-acompanhamento').value;
  const produtoId = document.getElementById('campo-produto-acompanhamento').value;
  const dataProducao = document.getElementById('campo-data-acompanhamento').value;
  const dados = lerDadosFormularioLoteAcompanhamento();

  const erroValidacao = validarFormularioLoteAcompanhamento({ produtoId, dataProducao, ...dados });
  const dicaErro = document.getElementById('dica-lote-acompanhamento-erro');
  if (erroValidacao) {
    dicaErro.textContent = erroValidacao;
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const payload = {
    produtoId,
    produzidoEm: dataProducao,
    rendimentoFinalQuantidade: dados.rendimentoFinalQuantidade,
    rendimentoFinalUnidade: dados.rendimentoFinalUnidade,
    porcaoQuantidade: dados.porcaoQuantidade,
    porcaoUnidade: dados.porcaoUnidade,
    porcoesReais: dados.porcoesReais,
    componentes: montarComponentesPayloadParaSalvarAcompanhamento(),
  };

  try {
    await salvarLoteAcompanhamentoNoSupabase(id || null, payload);
  } catch (erro) {
    dicaErro.textContent = 'Não foi possível salvar o lote. ' + erro.message;
    dicaErro.style.display = '';
    return;
  }

  mostrarToast('Produção de acompanhamento salva.', 'sucesso');
  fecharModalLoteAcompanhamento();

  try {
    const [lotes, componentes] = await Promise.all([buscarLotesAcompanhamentosDoSupabase(), buscarComponentesLotesAcompanhamentosDoSupabase()]);
    lotesAcompanhamentosCache = lotes;
    componentesLotesAcompanhamentosCache = componentes;
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar lotes de produção de acompanhamentos:', erroRecarregar);
  }
  renderizarTabelaLotesAcompanhamentos();
}

/** Exclusão física — admin only, confirmação explícita. Cascata (side_batch_components.batch_id ON DELETE CASCADE) remove os componentes automaticamente. */
async function excluirLoteAcompanhamentoModal() {
  const id = document.getElementById('campo-id-lote-acompanhamento').value;
  if (!id || !souAdminProducao) return;
  const lote = lotesAcompanhamentosCache.find((l) => l.id === id);
  if (!lote) return;

  if (!confirm('Excluir esta produção de acompanhamento?\n\nEsta ação remove o registro de produção.')) return;

  try {
    await excluirLoteAcompanhamentoNoSupabase(id);
  } catch (erro) {
    mostrarToast('Não foi possível excluir o lote. ' + erro.message, 'erro');
    return;
  }

  lotesAcompanhamentosCache = lotesAcompanhamentosCache.filter((l) => l.id !== id);
  componentesLotesAcompanhamentosCache = componentesLotesAcompanhamentosCache.filter((c) => c.loteId !== id);
  fecharModalLoteAcompanhamento();
  renderizarTabelaLotesAcompanhamentos();
  mostrarToast('Produção de acompanhamento excluída.', 'sucesso');
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
