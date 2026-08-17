/*
 * relatorios.js
 * Relatório Diário (Etapa 1) — fechamento financeiro de UM dia específico do
 * estabelecimento, com exportação planejada pra etapas futuras (não aqui).
 * Reaproveita getOrdersForReport()/getCancelledOrdersForReport()
 * (js/services/orders-service.js) e o padrão de timezone já validado no
 * Dashboard (js/dashboard.js: Intl.DateTimeFormat com timeZone explícito),
 * mas usa business_settings.timezone de verdade (via settings-service.js)
 * em vez de um fuso fixo — igual pedido, sem duplicar lógica de fuso nova
 * (o motor é o mesmo datetimeLocalParaUtcIso() já usado por cupons, em
 * js/utils.js). Depende de storage.js, utils.js, settings-service.js e
 * orders-service.js.
 */

let fusoHorarioRelatorio = 'Europe/Dublin'; // sobrescrito por business_settings.timezone assim que carregado
let dataSelecionadaRelatorio = null; // 'yyyy-mm-dd', no fuso do estabelecimento

/**
 * Fonte única de verdade pro relatório do dia selecionado — preenchido no fim de carregarRelatorioDoDia()
 * (Etapa 3), depois de todos os cálculos já existentes. Tela, PDF e Excel leem só daqui; nenhum dos três
 * recalcula nada nem faz consulta própria. null enquanto carrega ou se o carregamento falhar — os botões
 * de exportação ficam desabilitados nesse período (ver atualizarBotoesExportacao()).
 */
let relatorioAtual = null;

// Rótulos compactos pro card "Status dos pagamentos" — distintos de ROTULOS_STATUS_PAGAMENTO (utils.js),
// que são frases longas pensadas pro contexto de detalhe de um pedido, não pra um resumo compacto do dia.
const ROTULOS_STATUS_PAGAMENTO_RELATORIO = {
  pago: 'Pago',
  pendente: 'Pendente',
  pagar_na_entrega: 'Pagamento na entrega',
  legado: 'Legado',
};
const ORDEM_STATUS_PAGAMENTO_RELATORIO = ['pago', 'pendente', 'pagar_na_entrega', 'legado'];

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosRelatorio();

  try {
    // carregarProdutosCache() (Etapa 2) só é usada aqui pra resolver categoria de produtos vendidos
    // diretamente (nome/preço/quantidade continuam vindo do snapshot em order_items, nunca daqui).
    const [config] = await Promise.all([buscarConfiguracoesNegocioDoSupabase(), carregarProdutosCache()]);
    fusoHorarioRelatorio = config.fusoHorario || 'Europe/Dublin';
  } catch (erro) {
    // Sem o fuso real do estabelecimento não dá pra garantir que "o dia" está certo — melhor mostrar
    // erro do que arriscar um relatório com data errada por causa de um fuso presumido.
    exibirErroRelatorio('Não foi possível carregar as configurações do estabelecimento. ' + erro.message);
    return;
  }

  dataSelecionadaRelatorio = hojeNoFuso(fusoHorarioRelatorio);
  document.getElementById('campo-data-relatorio').value = dataSelecionadaRelatorio;
  await carregarRelatorioDoDia(dataSelecionadaRelatorio);
});

function ligarEventosRelatorio() {
  document.getElementById('campo-data-relatorio').addEventListener('change', (evento) => {
    if (!evento.target.value) return;
    dataSelecionadaRelatorio = evento.target.value;
    carregarRelatorioDoDia(dataSelecionadaRelatorio);
  });

  document.getElementById('botao-hoje-relatorio').addEventListener('click', () => {
    dataSelecionadaRelatorio = hojeNoFuso(fusoHorarioRelatorio);
    document.getElementById('campo-data-relatorio').value = dataSelecionadaRelatorio;
    carregarRelatorioDoDia(dataSelecionadaRelatorio);
  });

  document.getElementById('botao-exportar-pdf').addEventListener('click', () => exportarRelatorioPdf(relatorioAtual));
  document.getElementById('botao-exportar-excel').addEventListener('click', () => exportarRelatorioExcel(relatorioAtual));
}

/** Habilita/desabilita os 2 botões de exportação — só ficam ativos quando há um relatório carregado com sucesso */
function atualizarBotoesExportacao(habilitado) {
  document.getElementById('botao-exportar-pdf').disabled = !habilitado;
  document.getElementById('botao-exportar-excel').disabled = !habilitado;
}

// ---------------------------------------------------------------------------
// Timezone — mesma técnica já validada no projeto (Intl.DateTimeFormat com
// timeZone explícito, igual chaveDataDublin() em dashboard.js; conversão
// exata de limite de dia via datetimeLocalParaUtcIso(), já usada por
// cupons em js/utils.js), só que parametrizada pelo fuso real do
// estabelecimento em vez de um fuso fixo.
// ---------------------------------------------------------------------------

/** yyyy-mm-dd no fuso informado, a partir de um objeto Date */
function chaveDataNoFuso(data, fuso) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(data);
  const porTipo = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${porTipo.year}-${porTipo.month}-${porTipo.day}`;
}

function hojeNoFuso(fuso) {
  return chaveDataNoFuso(new Date(), fuso);
}

/** yyyy-mm-dd do dia seguinte — âncora ao meio-dia UTC (nunca cruza meia-noite local), aritmética pura de calendário */
function diaSeguinte(yyyyMmDd) {
  const ancora = new Date(`${yyyyMmDd}T12:00:00.000Z`);
  ancora.setUTCDate(ancora.getUTCDate() + 1);
  const dois = (n) => String(n).padStart(2, '0');
  return `${ancora.getUTCFullYear()}-${dois(ancora.getUTCMonth() + 1)}-${dois(ancora.getUTCDate())}`;
}

/**
 * Limites UTC exatos do dia `yyyyMmDd` no fuso do estabelecimento — início e fim (exclusivo) já
 * prontos pra usar direto em getOrdersForReport()/getCancelledOrdersForReport(). Usa
 * datetimeLocalParaUtcIso() (js/utils.js), que já trata corretamente horário inexistente/ambíguo na
 * troca de horário de verão — não precisa da técnica de "janela larga + filtro em JS" do Dashboard,
 * porque aqui é sempre um único dia (limites exatos, não uma janela multi-dia).
 */
function limitesUtcDoDia(yyyyMmDd, fuso) {
  const desdeUtc = datetimeLocalParaUtcIso(`${yyyyMmDd}T00:00`, fuso);
  const ateUtc = datetimeLocalParaUtcIso(`${diaSeguinte(yyyyMmDd)}T00:00`, fuso);
  return { desdeUtc, ateUtc };
}

// ---------------------------------------------------------------------------
// Carregamento e cálculo
// ---------------------------------------------------------------------------

async function carregarRelatorioDoDia(yyyyMmDd) {
  const carregando = document.getElementById('estado-carregando-relatorio-diario');
  const erro = document.getElementById('estado-erro-relatorio-diario');
  const conteudo = document.getElementById('conteudo-relatorio-diario');

  erro.style.display = 'none';
  conteudo.style.display = 'none';
  carregando.style.display = 'block';
  relatorioAtual = null;
  atualizarBotoesExportacao(false);

  try {
    const { desdeUtc, ateUtc } = limitesUtcDoDia(yyyyMmDd, fusoHorarioRelatorio);

    const [brutos, cancelados] = await Promise.all([
      getOrdersForReport({ desdeUtc, ateUtc }),
      getCancelledOrdersForReport({ desdeUtc, ateUtc }),
    ]);

    // Único critério de exclusão financeira: status='cancelled' (item 3). payment_status nunca exclui
    // pedido do faturamento nesta V1. desdeUtc/ateUtc já são os limites exatos do dia (não uma janela
    // larga), então não precisa de filtro adicional por chave de data em JS.
    const pedidos = brutos.filter((p) => p.status !== STATUS_PEDIDO.CANCELADO);
    const idsPedidosValidos = new Set(pedidos.map((p) => p.id));

    // Etapa 2 — detalhamento das vendas. Só busca order_items/selections dos pedidos já sem cancelados
    // (item 16): nenhum item de pedido cancelado entra aqui, orders continua sendo a única fonte de
    // status. Sequência de 2 consultas em lote (nunca uma por pedido — item 15).
    const orderIds = pedidos.map((p) => p.id);
    const itensBrutos = await getOrderItemsForReport(orderIds);
    const itens = itensBrutos.filter((i) => idsPedidosValidos.has(i.orderId)); // defensivo, reforça a regra do item 16
    const selecoes = await getOrderItemSelectionsForReport(itens.map((i) => i.id));

    const resumo = calcularResumoRelatorioDiario(pedidos, cancelados);
    const produtosVendidos = calcularProdutosVendidos(itens);
    const combosVendidos = calcularCombosVendidos(itens);
    const consumoCombos = calcularConsumoCombos(itens, selecoes);
    const acrescimosCombos = calcularAcrescimosCombos(itens, selecoes);
    const vendasPorCategoria = calcularVendasPorCategoria(itens);
    const cuponsUtilizados = calcularCuponsUtilizados(pedidos);

    verificarReconciliacoes({ resumo, itens, produtosVendidos, combosVendidos, acrescimosCombos, cuponsUtilizados });

    renderizarRelatorioDiario(resumo);
    renderizarVendasPorCategoria(vendasPorCategoria);
    renderizarProdutosVendidos(produtosVendidos);
    renderizarCombosVendidos(combosVendidos);
    renderizarConsumoCombos(consumoCombos);
    renderizarAcrescimosCombos(acrescimosCombos);
    renderizarCuponsUtilizados(cuponsUtilizados);

    // Etapa 3 — fonte única de verdade pra exportação (PDF/Excel). Mesmos objetos já calculados e já
    // renderizados na tela, nenhum recálculo, nenhuma consulta nova. resumo já traz totalCancelamentos/
    // valorHistoricoCancelado, não precisa de um array de cancelados separado aqui.
    relatorioAtual = {
      data: yyyyMmDd,
      resumo,
      produtosVendidos,
      combosVendidos,
      consumoCombos,
      acrescimosCombos,
      vendasPorCategoria,
      cuponsUtilizados,
    };
    atualizarBotoesExportacao(true);

    carregando.style.display = 'none';
    conteudo.style.display = '';
  } catch (erroCarregamento) {
    console.error('Erro ao carregar relatório diário:', erroCarregamento);
    carregando.style.display = 'none';
    exibirErroRelatorio('Não foi possível carregar o relatório. ' + erroCarregamento.message);
  }
}

function exibirErroRelatorio(mensagem) {
  const erro = document.getElementById('estado-erro-relatorio-diario');
  document.getElementById('estado-carregando-relatorio-diario').style.display = 'none';
  document.getElementById('conteudo-relatorio-diario').style.display = 'none';
  erro.textContent = mensagem;
  erro.style.display = 'block';
}

/**
 * Função pura — recebe pedidos já sem cancelados (`pedidos`) e os pedidos cancelados do dia
 * (`cancelados`, já filtrados por cancelled_at), devolve o resumo completo do dia. Nenhuma consulta
 * aqui dentro, só agregação — mesmo padrão de calcularResumoFechamento() em dashboard.js.
 */
function calcularResumoRelatorioDiario(pedidos, cancelados) {
  const faturamentoTotal = pedidos.reduce((soma, p) => soma + p.total, 0);
  const faturamentoBruto = pedidos.reduce((soma, p) => soma + p.subtotal, 0);
  const descontos = pedidos.reduce((soma, p) => soma + p.descontoAmount, 0);
  const taxasEntrega = pedidos.reduce((soma, p) => soma + p.taxaEntrega, 0);
  const vendasAposDescontos = pedidos.reduce((soma, p) => soma + (p.subtotal - p.descontoAmount), 0);

  const totalPedidos = pedidos.length;
  const ticketMedio = totalPedidos > 0 ? faturamentoTotal / totalPedidos : 0;

  const totalCancelamentos = cancelados.length;
  const valorHistoricoCancelado = cancelados.reduce((soma, c) => soma + c.total, 0);

  const porFormaPagamento = { cartao: { qtd: 0, valor: 0 }, dinheiro: { qtd: 0, valor: 0 }, revolut: { qtd: 0, valor: 0 }, transferencia: { qtd: 0, valor: 0 } };
  const porStatusPagamento = { pago: { qtd: 0, valor: 0 }, pendente: { qtd: 0, valor: 0 }, pagar_na_entrega: { qtd: 0, valor: 0 }, legado: { qtd: 0, valor: 0 } };
  const porAtendimento = { retirada: { qtd: 0, valor: 0 }, entrega: { qtd: 0, valor: 0, taxas: 0 } };

  pedidos.forEach((p) => {
    if (porFormaPagamento[p.formaPagamento]) {
      porFormaPagamento[p.formaPagamento].qtd += 1;
      porFormaPagamento[p.formaPagamento].valor += p.total;
    }
    if (porStatusPagamento[p.statusPagamento]) {
      porStatusPagamento[p.statusPagamento].qtd += 1;
      porStatusPagamento[p.statusPagamento].valor += p.total;
    }
    if (p.fulfilment === 'retirada') {
      porAtendimento.retirada.qtd += 1;
      porAtendimento.retirada.valor += p.total;
    } else if (p.fulfilment === 'entrega') {
      porAtendimento.entrega.qtd += 1;
      porAtendimento.entrega.valor += p.total;
      porAtendimento.entrega.taxas += p.taxaEntrega;
    }
  });

  return {
    faturamentoTotal,
    faturamentoBruto,
    descontos,
    taxasEntrega,
    vendasAposDescontos,
    totalPedidos,
    ticketMedio,
    totalCancelamentos,
    valorHistoricoCancelado,
    porFormaPagamento,
    porStatusPagamento,
    porAtendimento,
  };
}

// ---------------------------------------------------------------------------
// Etapa 2 — Detalhamento das vendas (cálculo, funções puras sem I/O)
//
// Regra de ouro (snapshot histórico): nome/preço vêm sempre de order_items/
// order_item_selections, nunca de `products` — só usamos a categoria do
// cache de produtos (categoriaDoProduto), porque isso não reprecifica nada,
// só agrupa visualmente. Um pedido antigo continua com os valores de quando
// foi feito mesmo que o produto tenha mudado de preço/nome/sumido depois.
//
// Fórmula de consumo/receita real de componente de combo (confirmada linha
// a linha no corpo de create_customer_order, não é suposição — ver plano):
//   consumo_real = order_item_selections.quantity × order_items.quantity
//   receita_real = order_item_selections.extra_price × quantity_da_selecao × quantity_do_item_pai
// ---------------------------------------------------------------------------

/** Categoria pt-BR de um produto pelo cache já carregado (carregarProdutosCache) — "Não identificado" se o produto não existe mais */
function categoriaDoProduto(produtoId) {
  if (!produtoId) return 'Não identificado';
  const produto = obterProdutos().find((p) => p.id === produtoId);
  return produto ? produto.categoria : 'Não identificado';
}

/** Produtos vendidos diretamente (item_type='product') — nunca inclui componentes escolhidos dentro de combos (item 9 do pedido) */
function calcularProdutosVendidos(itens) {
  const porProduto = new Map();

  itens
    .filter((i) => i.tipoItem === 'product')
    .forEach((i) => {
      const chave = i.produtoId || i.nome;
      const atual = porProduto.get(chave) || { produtoId: i.produtoId, nome: i.nome, quantidade: 0, valorVendido: 0 };
      atual.quantidade += i.quantidade;
      atual.valorVendido += i.valorTotal;
      porProduto.set(chave, atual);
    });

  return Array.from(porProduto.values())
    .map((p) => ({
      ...p,
      categoria: categoriaDoProduto(p.produtoId),
      precoMedio: p.quantidade > 0 ? p.valorVendido / p.quantidade : 0,
    }))
    .sort((a, b) => b.valorVendido - a.valorVendido);
}

/** Combos vendidos (item_type='combo'), agrupados por product_id. Valor vendido = receita base + acréscimos, sempre (reconciliação B) */
function calcularCombosVendidos(itens) {
  const porCombo = new Map();

  itens
    .filter((i) => i.tipoItem === 'combo')
    .forEach((i) => {
      const chave = i.produtoId || i.nome;
      const atual = porCombo.get(chave) || { produtoId: i.produtoId, nome: i.nome, quantidade: 0, receitaBase: 0, acrescimos: 0, valorVendido: 0 };
      atual.quantidade += i.quantidade;
      atual.receitaBase += i.precoUnitario * i.quantidade;
      atual.acrescimos += i.extrasTotal;
      atual.valorVendido += i.valorTotal;
      porCombo.set(chave, atual);
    });

  return Array.from(porCombo.values())
    .map((c) => ({ ...c, precoBaseMedio: c.quantidade > 0 ? c.receitaBase / c.quantidade : 0 }))
    .sort((a, b) => b.valorVendido - a.valorVendido);
}

/** { skewer, side, included }: consumo real de cada componente (SUM(selection.quantity × item_pai.quantity)) — nunca a quantidade crua da seleção */
function calcularConsumoCombos(itens, selecoes) {
  const quantidadePorItemCombo = new Map(itens.filter((i) => i.tipoItem === 'combo').map((i) => [i.id, i.quantidade]));

  const grupos = { skewer: new Map(), side: new Map(), included: new Map() };

  selecoes.forEach((s) => {
    const quantidadePai = quantidadePorItemCombo.get(s.orderItemId);
    if (quantidadePai === undefined) return; // seleção de um order_item fora do conjunto de pedidos válidos do dia
    const grupo = grupos[s.tipoSelecao];
    if (!grupo) return;

    const chave = s.produtoId || s.nome;
    const atual = grupo.get(chave) || { produtoId: s.produtoId, nome: s.nome, consumo: 0 };
    atual.consumo += s.quantidade * quantidadePai;
    grupo.set(chave, atual);
  });

  const paraLista = (mapa) => Array.from(mapa.values()).sort((a, b) => b.consumo - a.consumo);
  return { skewer: paraLista(grupos.skewer), side: paraLista(grupos.side), included: paraLista(grupos.included) };
}

/** Acréscimos com receita real (só selection_type='skewer' com extra_price > 0) — mesma fórmula de consumo, multiplicada pelo acréscimo unitário */
function calcularAcrescimosCombos(itens, selecoes) {
  const quantidadePorItemCombo = new Map(itens.filter((i) => i.tipoItem === 'combo').map((i) => [i.id, i.quantidade]));

  const porProduto = new Map();

  selecoes
    .filter((s) => s.tipoSelecao === 'skewer' && s.acrescimoUnitario > 0)
    .forEach((s) => {
      const quantidadePai = quantidadePorItemCombo.get(s.orderItemId);
      if (quantidadePai === undefined) return;

      const consumoReal = s.quantidade * quantidadePai;
      const chave = s.produtoId || s.nome;
      const atual = porProduto.get(chave) || { produtoId: s.produtoId, nome: s.nome, quantidadeComAcrescimo: 0, receitaAdicional: 0 };
      atual.quantidadeComAcrescimo += consumoReal;
      atual.receitaAdicional += s.acrescimoUnitario * consumoReal;
      porProduto.set(chave, atual);
    });

  return Array.from(porProduto.values())
    .map((p) => ({ ...p, acrescimoUnitarioMedio: p.quantidadeComAcrescimo > 0 ? p.receitaAdicional / p.quantidadeComAcrescimo : 0 }))
    .sort((a, b) => b.receitaAdicional - a.receitaAdicional);
}

/**
 * Mix de vendas por categoria — combo sempre entra como "Combos" (nunca decompõe componentes aqui de
 * novo, item 9/11). % é sobre SUM(order_items.total_price) do dia, nunca orders.total (que já inclui
 * entrega e já desconta cupom) — por isso o rótulo explícito na UI.
 */
function calcularVendasPorCategoria(itens) {
  const porCategoria = new Map();
  let totalItens = 0;

  itens.forEach((i) => {
    const categoria = i.tipoItem === 'combo' ? 'Combos' : categoriaDoProduto(i.produtoId);
    const atual = porCategoria.get(categoria) || { categoria, quantidade: 0, valorVendido: 0 };
    atual.quantidade += i.quantidade;
    atual.valorVendido += i.valorTotal;
    porCategoria.set(categoria, atual);
    totalItens += i.valorTotal;
  });

  return Array.from(porCategoria.values())
    .map((c) => ({ ...c, percentual: totalItens > 0 ? (c.valorVendido / totalItens) * 100 : 0 }))
    .sort((a, b) => b.valorVendido - a.valorVendido);
}

/** Agrupa descontos por coupon_code (snapshot em orders, nunca a tabela coupons) — descontos sem código caem em "Sem cupom / Ajuste manual" (item 13) */
function calcularCuponsUtilizados(pedidos) {
  const porCupom = new Map();

  pedidos
    .filter((p) => p.descontoAmount > 0)
    .forEach((p) => {
      const chave = p.cupomCodigo || '__sem_cupom__';
      const atual = porCupom.get(chave) || { codigo: p.cupomCodigo, pedidos: 0, desconto: 0 };
      atual.pedidos += 1;
      atual.desconto += p.descontoAmount;
      porCupom.set(chave, atual);
    });

  return Array.from(porCupom.values()).sort((a, b) => b.desconto - a.desconto);
}

/**
 * Reconciliações internas (item 14 do pedido) — nunca bloqueiam a tela nem lançam erro; uma diferença
 * > €0,01 vira console.warn com os dois valores e a diferença exata, pra diagnóstico.
 */
function verificarReconciliacoes({ resumo, itens, produtosVendidos, combosVendidos, acrescimosCombos, cuponsUtilizados }) {
  const EPSILON = 0.01;
  const diverge = (a, b) => Math.abs(a - b) > EPSILON;

  // A) Produtos vendidos + Combos vendidos === SUM(order_items.total_price)
  const somaItens = itens.reduce((soma, i) => soma + i.valorTotal, 0);
  const somaProdutosECombos =
    produtosVendidos.reduce((s, p) => s + p.valorVendido, 0) + combosVendidos.reduce((s, c) => s + c.valorVendido, 0);
  if (diverge(somaItens, somaProdutosECombos)) {
    console.warn(
      '[Relatório Diário] Reconciliação A divergente — SUM(order_items.total_price) =',
      somaItens,
      'vs. Produtos+Combos vendidos =',
      somaProdutosECombos,
      'diferença =',
      somaItens - somaProdutosECombos
    );
  }

  // B) por combo: receita base + acréscimos === valor vendido
  combosVendidos.forEach((c) => {
    const soma = c.receitaBase + c.acrescimos;
    if (diverge(soma, c.valorVendido)) {
      console.warn(
        '[Relatório Diário] Reconciliação B divergente pro combo',
        c.nome,
        '— receitaBase + acrescimos =',
        soma,
        'vs. valorVendido =',
        c.valorVendido
      );
    }
  });

  // C) total de acréscimos detalhados === SUM(order_items.extras_total) dos combos
  const extrasTotalCombos = itens.filter((i) => i.tipoItem === 'combo').reduce((s, i) => s + i.extrasTotal, 0);
  const somaAcrescimosDetalhados = acrescimosCombos.reduce((s, a) => s + a.receitaAdicional, 0);
  if (diverge(extrasTotalCombos, somaAcrescimosDetalhados)) {
    console.warn(
      '[Relatório Diário] Reconciliação C divergente — SUM(order_items.extras_total) =',
      extrasTotalCombos,
      'vs. acréscimos detalhados =',
      somaAcrescimosDetalhados,
      'diferença =',
      extrasTotalCombos - somaAcrescimosDetalhados
    );
  }

  // D) cupons + "sem cupom" === card Descontos da Etapa 1 (SUM(orders.discount_amount))
  const somaCupons = cuponsUtilizados.reduce((s, c) => s + c.desconto, 0);
  if (diverge(somaCupons, resumo.descontos)) {
    console.warn(
      '[Relatório Diário] Reconciliação D divergente — total por cupom/sem cupom =',
      somaCupons,
      'vs. card Descontos (Etapa 1) =',
      resumo.descontos,
      'diferença =',
      somaCupons - resumo.descontos
    );
  }
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function renderizarRelatorioDiario(resumo) {
  renderizarCardsFinanceiros(resumo);
  renderizarFormasPagamentoRelatorio(resumo);
  renderizarStatusPagamentoRelatorio(resumo);
  renderizarAtendimentoRelatorio(resumo);
}

function renderizarCardsFinanceiros(resumo) {
  const moeda = obterConfiguracoes().moeda;
  const definir = (id, texto) => {
    document.getElementById(id).textContent = texto;
  };

  definir('rd-faturamento-total', formatarMoeda(resumo.faturamentoTotal, moeda));
  definir('rd-pedidos', resumo.totalPedidos);
  definir('rd-ticket-medio', formatarMoeda(resumo.ticketMedio, moeda));
  definir('rd-faturamento-bruto', formatarMoeda(resumo.faturamentoBruto, moeda));
  definir('rd-descontos', formatarMoeda(resumo.descontos, moeda));
  definir('rd-vendas-apos-descontos', formatarMoeda(resumo.vendasAposDescontos, moeda));
  definir('rd-taxas-entrega', formatarMoeda(resumo.taxasEntrega, moeda));
  definir('rd-cancelamentos', resumo.totalCancelamentos);
  definir('rd-valor-cancelado', formatarMoeda(resumo.valorHistoricoCancelado, moeda));
}

function renderizarFormasPagamentoRelatorio(resumo) {
  const moeda = obterConfiguracoes().moeda;
  const container = document.getElementById('rd-lista-formas-pagamento');

  if (resumo.totalPedidos === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda neste dia.</div>';
    return;
  }

  container.innerHTML = Object.keys(ROTULOS_FORMA_PAGAMENTO)
    .map((chave) => {
      const dados = resumo.porFormaPagamento[chave];
      return `<div class="linha-resumo"><span>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[chave])}</span><span>${dados.qtd} pedido${dados.qtd === 1 ? '' : 's'} · ${formatarMoeda(dados.valor, moeda)}</span></div>`;
    })
    .join('');
}

function renderizarStatusPagamentoRelatorio(resumo) {
  const moeda = obterConfiguracoes().moeda;
  const container = document.getElementById('rd-lista-status-pagamento');

  if (resumo.totalPedidos === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda neste dia.</div>';
    return;
  }

  // "Legado" só aparece se houver pelo menos 1 pedido nesse status no dia.
  const chaves = ORDEM_STATUS_PAGAMENTO_RELATORIO.filter((chave) => chave !== 'legado' || resumo.porStatusPagamento.legado.qtd > 0);

  container.innerHTML = chaves
    .map((chave) => {
      const dados = resumo.porStatusPagamento[chave];
      return `<div class="linha-resumo"><span>${escaparHtml(ROTULOS_STATUS_PAGAMENTO_RELATORIO[chave])}</span><span>${dados.qtd} pedido${dados.qtd === 1 ? '' : 's'} · ${formatarMoeda(dados.valor, moeda)}</span></div>`;
    })
    .join('');
}

function renderizarAtendimentoRelatorio(resumo) {
  const moeda = obterConfiguracoes().moeda;
  const container = document.getElementById('rd-lista-atendimento');

  if (resumo.totalPedidos === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda neste dia.</div>';
    return;
  }

  const retirada = resumo.porAtendimento.retirada;
  const entrega = resumo.porAtendimento.entrega;

  container.innerHTML = `
    <div class="linha-resumo"><span>Retirada</span><span>${retirada.qtd} pedido${retirada.qtd === 1 ? '' : 's'} · ${formatarMoeda(retirada.valor, moeda)}</span></div>
    <div class="linha-resumo"><span>Entrega</span><span>${entrega.qtd} pedido${entrega.qtd === 1 ? '' : 's'} · ${formatarMoeda(entrega.valor, moeda)}</span></div>
    <div class="linha-resumo"><span>Taxas de entrega arrecadadas</span><span>${formatarMoeda(entrega.taxas, moeda)}</span></div>
  `;
}

// ---------------------------------------------------------------------------
// Etapa 2 — Renderização do detalhamento das vendas
// ---------------------------------------------------------------------------

function renderizarVendasPorCategoria(lista) {
  const corpo = document.getElementById('rd-corpo-categorias');
  const vazio = document.getElementById('rd-vazio-categorias');

  if (lista.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = lista
    .map(
      (c) => `
      <tr>
        <td>${escaparHtml(c.categoria)}</td>
        <td>${c.quantidade}</td>
        <td>${formatarMoeda(c.valorVendido, moeda)}</td>
        <td>${c.percentual.toFixed(1)}%</td>
      </tr>`
    )
    .join('');
}

function renderizarProdutosVendidos(lista) {
  const corpo = document.getElementById('rd-corpo-produtos-vendidos');
  const vazio = document.getElementById('rd-vazio-produtos-vendidos');

  if (lista.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = lista
    .map(
      (p) => `
      <tr>
        <td>${escaparHtml(p.nome)}</td>
        <td>${escaparHtml(p.categoria)}</td>
        <td>${p.quantidade}</td>
        <td>${formatarMoeda(p.precoMedio, moeda)}</td>
        <td>${formatarMoeda(p.valorVendido, moeda)}</td>
      </tr>`
    )
    .join('');
}

function renderizarCombosVendidos(lista) {
  const corpo = document.getElementById('rd-corpo-combos-vendidos');
  const vazio = document.getElementById('rd-vazio-combos-vendidos');

  if (lista.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = lista
    .map(
      (c) => `
      <tr>
        <td>${escaparHtml(c.nome)}</td>
        <td>${c.quantidade}</td>
        <td>${formatarMoeda(c.precoBaseMedio, moeda)}</td>
        <td>${formatarMoeda(c.acrescimos, moeda)}</td>
        <td>${formatarMoeda(c.valorVendido, moeda)}</td>
      </tr>`
    )
    .join('');
}

/** { skewer, side, included } — mostra os 3 subgrupos; se o dia inteiro não teve consumo, mostra só o aviso geral e esconde os subtítulos */
function renderizarConsumoCombos(consumo) {
  const totalConsumo = consumo.skewer.length + consumo.side.length + consumo.included.length;
  const vazioGeral = document.getElementById('rd-vazio-consumo');
  const subtitulos = document.querySelectorAll('.rd-subtitulo-consumo');

  if (totalConsumo === 0) {
    vazioGeral.style.display = 'block';
    subtitulos.forEach((el) => (el.style.display = 'none'));
    document.getElementById('rd-lista-consumo-skewer').innerHTML = '';
    document.getElementById('rd-lista-consumo-side').innerHTML = '';
    document.getElementById('rd-lista-consumo-included').innerHTML = '';
    return;
  }

  vazioGeral.style.display = 'none';
  subtitulos.forEach((el) => (el.style.display = ''));

  const preencherGrupo = (id, lista) => {
    const container = document.getElementById(id);
    container.innerHTML =
      lista.length === 0
        ? '<div class="estado-vazio">Nenhum item neste grupo.</div>'
        : lista.map((item) => `<div class="linha-resumo"><span>${escaparHtml(item.nome)}</span><span>${item.consumo}</span></div>`).join('');
  };

  preencherGrupo('rd-lista-consumo-skewer', consumo.skewer);
  preencherGrupo('rd-lista-consumo-side', consumo.side);
  preencherGrupo('rd-lista-consumo-included', consumo.included);
}

function renderizarAcrescimosCombos(lista) {
  const corpo = document.getElementById('rd-corpo-acrescimos');
  const vazio = document.getElementById('rd-vazio-acrescimos');
  const totalEl = document.getElementById('rd-total-acrescimos');
  const totalValorEl = document.getElementById('rd-total-acrescimos-valor');

  if (lista.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    totalEl.style.display = 'none';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = lista
    .map(
      (a) => `
      <tr>
        <td>${escaparHtml(a.nome)}</td>
        <td>${a.quantidadeComAcrescimo}</td>
        <td>${formatarMoeda(a.acrescimoUnitarioMedio, moeda)}</td>
        <td>${formatarMoeda(a.receitaAdicional, moeda)}</td>
      </tr>`
    )
    .join('');

  totalValorEl.textContent = formatarMoeda(
    lista.reduce((s, a) => s + a.receitaAdicional, 0),
    moeda
  );
  totalEl.style.display = '';
}

function renderizarCuponsUtilizados(lista) {
  const corpo = document.getElementById('rd-corpo-cupons');
  const vazio = document.getElementById('rd-vazio-cupons');
  const totalEl = document.getElementById('rd-total-cupons');
  const totalValorEl = document.getElementById('rd-total-cupons-valor');

  if (lista.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    totalEl.style.display = 'none';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = lista
    .map(
      (c) => `
      <tr>
        <td>${escaparHtml(c.codigo || 'Sem cupom / Ajuste manual')}</td>
        <td>${c.pedidos}</td>
        <td>${formatarMoeda(c.desconto, moeda)}</td>
      </tr>`
    )
    .join('');

  totalValorEl.textContent = formatarMoeda(
    lista.reduce((s, c) => s + c.desconto, 0),
    moeda
  );
  totalEl.style.display = '';
}
