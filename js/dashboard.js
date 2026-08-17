/*
 * dashboard.js
 * Cards "hoje" (fixos) + seção de Relatórios com filtro de período — tudo a
 * partir de dados reais do Supabase (orders/order_items, via
 * js/services/orders-service.js). Fuso horário tratado explicitamente como
 * Europe/Dublin (ver chaveDataDublin()), nunca o fuso do navegador/servidor.
 * Gráficos continuam sendo <div>s dimensionados via JS (sem canvas/lib).
 * Depende de storage.js, utils.js e js/services/orders-service.js.
 */

let periodoAtualDashboard = 'hoje';
let pedidosHojeCache = null; // preenchido por carregarCardsHoje(), reaproveitado se o período "Hoje" for selecionado logo em seguida
let canceladosHojeCache = null; // idem, mas para getCancelledOrdersForReport() (filtrado por cancelled_at, não created_at)

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await carregarProdutosCache();
  } catch (erroCarregamento) {
    console.error('Erro ao carregar produtos:', erroCarregamento);
    mostrarToast('Não foi possível carregar os produtos.', 'erro');
    return;
  }

  renderizarCartoesEstoque();
  ligarEventosFiltroPeriodo();

  await carregarCardsHoje();
  await carregarRelatorioPeriodo('hoje');
});

// ---------------------------------------------------------------------------
// Timezone — Europe/Dublin (nunca o fuso do navegador/servidor)
// ---------------------------------------------------------------------------

/** yyyy-mm-dd no fuso de Dublin, a partir de uma data ISO (UTC) ou objeto Date — usa Intl com timeZone explícito, já trata GMT/IST (DST) sozinho */
function chaveDataDublin(data) {
  const objeto = data instanceof Date ? data : new Date(data);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(objeto);
  const porTipo = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${porTipo.year}-${porTipo.month}-${porTipo.day}`;
}

function hojeDublin() {
  return chaveDataDublin(new Date());
}

/** Âncora em UTC ao meio-dia de uma data yyyy-mm-dd — meio-dia nunca cruza a meia-noite em Dublin (offset é sempre 0 ou +1h), então dá pra somar/subtrair dias com segurança sem se preocupar com DST */
function ancoraUtc(yyyyMmDd) {
  return new Date(`${yyyyMmDd}T12:00:00.000Z`);
}

function somarDias(yyyyMmDd, dias) {
  const data = ancoraUtc(yyyyMmDd);
  data.setUTCDate(data.getUTCDate() + dias);
  return chaveDataDublin(data);
}

/** Rótulo dd/mm a partir de yyyy-mm-dd, pro eixo do gráfico */
function rotuloDiaCurto(yyyyMmDd) {
  const [, mes, dia] = yyyyMmDd.split('-');
  return `${dia}/${mes}`;
}

/**
 * Lista de dias (yyyy-mm-dd, Dublin) do período selecionado + uma janela em
 * UTC "generosa" (2 dias de folga de cada lado) só pra não trazer o Supabase
 * inteiro na consulta — a contagem/filtragem por dia real acontece depois,
 * em JS, com chaveDataDublin(), nunca confiando na data UTC crua.
 */
function calcularJanelaPeriodo(tipo, inicioPersonalizado, fimPersonalizado) {
  const hoje = hojeDublin();
  let dias = [];

  if (tipo === '7dias') {
    for (let i = 6; i >= 0; i--) dias.push(somarDias(hoje, -i));
  } else if (tipo === '30dias') {
    for (let i = 29; i >= 0; i--) dias.push(somarDias(hoje, -i));
  } else if (tipo === 'mes') {
    const diaDoMes = Number(hoje.split('-')[2]);
    for (let i = diaDoMes - 1; i >= 0; i--) dias.push(somarDias(hoje, -i));
  } else if (tipo === 'personalizado' && inicioPersonalizado && fimPersonalizado) {
    let cursor = inicioPersonalizado;
    let protecao = 0;
    while (cursor <= fimPersonalizado && protecao < 400) {
      dias.push(cursor);
      cursor = somarDias(cursor, 1);
      protecao++;
    }
  } else {
    dias = [hoje]; // 'hoje' (ou fallback)
  }

  const desdeUtc = new Date(ancoraUtc(dias[0]).getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const ateUtc = new Date(ancoraUtc(dias[dias.length - 1]).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();

  return { dias, desdeUtc, ateUtc };
}

// ---------------------------------------------------------------------------
// Cards de estoque (inalterados — já liam do Supabase via cache de produtos)
// ---------------------------------------------------------------------------

function renderizarCartoesEstoque() {
  const moeda = obterConfiguracoes().moeda;
  document.getElementById('cartao-produtos-cadastrados').textContent = obterProdutos().length;
  document.getElementById('cartao-estoque-baixo').textContent = obterProdutosEstoqueBaixo().length;
  document.getElementById('cartao-sem-estoque').textContent = obterProdutosSemEstoque().length;
  document.getElementById('cartao-valor-estoque').textContent = formatarMoeda(obterValorTotalEstoque(), moeda);
}

// ---------------------------------------------------------------------------
// Cards fixos "Hoje"
// ---------------------------------------------------------------------------

function calcularResumoPedidos(pedidos) {
  const faturamento = pedidos.reduce((soma, p) => soma + p.total, 0);
  const taxaEntrega = pedidos.reduce((soma, p) => soma + p.taxaEntrega, 0);
  const totalPedidos = pedidos.length;
  return { faturamento, taxaEntrega, totalPedidos, ticketMedio: totalPedidos > 0 ? faturamento / totalPedidos : 0 };
}

/**
 * Resumo do bloco "Fechamento" — função pura, sem consulta nenhuma. `pedidosValidos` já vem sem
 * cancelados (mesma regra do resto do Dashboard); `cancelados` vem de getCancelledOrdersForReport()
 * (filtrado por cancelled_at). trocoInformado é só informativo — nunca entra em faturamento, nunca
 * soma valorPago. valorHistoricoCancelado fica sempre separado de faturamento.
 */
function calcularResumoFechamento(pedidosValidos, cancelados) {
  const faturamento = pedidosValidos.reduce((soma, p) => soma + p.total, 0);
  const totalPedidos = pedidosValidos.length;
  const ticketMedio = totalPedidos > 0 ? faturamento / totalPedidos : 0;
  const taxasEntrega = pedidosValidos.reduce((soma, p) => soma + p.taxaEntrega, 0);

  const somaPorFiltro = (predicado) => pedidosValidos.filter(predicado).reduce((soma, p) => soma + p.total, 0);
  const cartao = somaPorFiltro((p) => p.formaPagamento === 'cartao');
  const dinheiro = somaPorFiltro((p) => p.formaPagamento === 'dinheiro');
  const revolut = somaPorFiltro((p) => p.formaPagamento === 'revolut');
  const transferencia = somaPorFiltro((p) => p.formaPagamento === 'transferencia');
  const delivery = somaPorFiltro((p) => p.fulfilment === 'entrega');
  const retirada = somaPorFiltro((p) => p.fulfilment === 'retirada');

  const trocoInformado = pedidosValidos
    .filter((p) => p.formaPagamento === 'dinheiro' && p.precisaTroco === true)
    .reduce((soma, p) => soma + p.troco, 0);

  const totalCancelamentos = cancelados.length;
  const valorHistoricoCancelado = cancelados.reduce((soma, c) => soma + c.total, 0);

  return {
    faturamento,
    totalPedidos,
    ticketMedio,
    taxasEntrega,
    cartao,
    dinheiro,
    revolut,
    transferencia,
    delivery,
    retirada,
    trocoInformado,
    totalCancelamentos,
    valorHistoricoCancelado,
  };
}

async function carregarCardsHoje() {
  const moeda = obterConfiguracoes().moeda;
  try {
    const { dias, desdeUtc, ateUtc } = calcularJanelaPeriodo('hoje');
    const brutos = await getOrdersForReport({ desdeUtc, ateUtc });
    const doDia = brutos.filter((p) => dias.includes(chaveDataDublin(p.criadoEm)));

    // Cancelados nunca contam em nenhuma métrica de venda (faturamento/pedidos/ticket médio/taxa/
    // pagamento/produtos) — filtrado uma única vez aqui, o resto do Dashboard reaproveita este array.
    const pedidos = doDia.filter((p) => p.status !== STATUS_PEDIDO.CANCELADO);
    const resumo = calcularResumoPedidos(pedidos);

    document.getElementById('cartao-faturamento-hoje').textContent = formatarMoeda(resumo.faturamento, moeda);
    document.getElementById('cartao-pedidos-hoje').textContent = resumo.totalPedidos;
    document.getElementById('cartao-ticket-medio-hoje').textContent = formatarMoeda(resumo.ticketMedio, moeda);
    document.getElementById('cartao-taxa-entrega-hoje').textContent = formatarMoeda(resumo.taxaEntrega, moeda);

    // "Cancelamentos hoje" é informativo — nunca entra em faturamento/pedidos/ticket médio/taxa.
    // Fonte oficial: getCancelledOrdersForReport(), filtrada por cancelled_at (não created_at) — assim
    // um pedido criado dias atrás e cancelado hoje também é contado (getOrdersForReport()/brutos, que
    // filtra por created_at, não serviria pra isso).
    const canceladosBrutos = await getCancelledOrdersForReport({ desdeUtc, ateUtc });
    const canceladosHoje = canceladosBrutos.filter((c) => dias.includes(chaveDataDublin(c.canceladoEm)));
    const cartaoCancelamentos = document.getElementById('cartao-cancelamentos-hoje');
    if (cartaoCancelamentos) cartaoCancelamentos.textContent = canceladosHoje.length;

    pedidosHojeCache = pedidos;
    canceladosHojeCache = canceladosHoje;
  } catch (erro) {
    console.error('Erro ao carregar cards de hoje:', erro);
    ['cartao-faturamento-hoje', 'cartao-pedidos-hoje', 'cartao-ticket-medio-hoje', 'cartao-taxa-entrega-hoje', 'cartao-cancelamentos-hoje'].forEach((id) => {
      const elemento = document.getElementById(id);
      if (elemento) elemento.textContent = '—';
    });
  }
}

// ---------------------------------------------------------------------------
// Relatórios (seção com filtro de período)
// ---------------------------------------------------------------------------

function ligarEventosFiltroPeriodo() {
  document.querySelectorAll('#filtro-periodo-dashboard .filtro-categoria-botao').forEach((botao) => {
    botao.addEventListener('click', () => {
      const periodo = botao.dataset.periodo;
      document.querySelectorAll('#filtro-periodo-dashboard .filtro-categoria-botao').forEach((b) => b.classList.toggle('ativo', b === botao));
      document.getElementById('grupo-periodo-personalizado').style.display = periodo === 'personalizado' ? '' : 'none';
      periodoAtualDashboard = periodo;
      if (periodo !== 'personalizado') carregarRelatorioPeriodo(periodo);
    });
  });

  document.getElementById('botao-aplicar-periodo-personalizado').addEventListener('click', () => {
    const inicio = document.getElementById('campo-periodo-inicio').value;
    const fim = document.getElementById('campo-periodo-fim').value;
    const erro = document.getElementById('erro-periodo-personalizado');

    if (!inicio || !fim) {
      erro.textContent = 'Escolha as duas datas.';
      return;
    }
    if (inicio > fim) {
      erro.textContent = 'A data inicial precisa ser antes da data final.';
      return;
    }
    erro.textContent = '';
    carregarRelatorioPeriodo('personalizado', inicio, fim);
  });
}

async function carregarRelatorioPeriodo(tipo, inicioPersonalizado, fimPersonalizado) {
  const carregando = document.getElementById('estado-carregando-relatorios');
  const erro = document.getElementById('estado-erro-relatorios');
  const conteudo = document.getElementById('conteudo-relatorios-dashboard');

  erro.style.display = 'none';
  conteudo.style.display = 'none';
  carregando.style.display = 'block';

  try {
    const { dias, desdeUtc, ateUtc } = calcularJanelaPeriodo(tipo, inicioPersonalizado, fimPersonalizado);

    let pedidos;
    let cancelados;
    if (tipo === 'hoje' && pedidosHojeCache && canceladosHojeCache) {
      // já carregados em carregarCardsHoje() para a mesma janela — evita repetir as duas consultas
      pedidos = pedidosHojeCache; // já filtrado sem cancelados
      cancelados = canceladosHojeCache; // já filtrado por cancelled_at
    } else {
      const brutos = await getOrdersForReport({ desdeUtc, ateUtc });
      pedidos = brutos.filter((p) => dias.includes(chaveDataDublin(p.criadoEm)) && p.status !== STATUS_PEDIDO.CANCELADO);

      const canceladosBrutos = await getCancelledOrdersForReport({ desdeUtc, ateUtc });
      cancelados = canceladosBrutos.filter((c) => dias.includes(chaveDataDublin(c.canceladoEm)));
    }

    const topProdutos = await getTopProductsForReport(
      pedidos.map((p) => p.id),
      10
    );

    renderizarGraficoFaturamentoPorDia(pedidos, dias);
    renderizarFormasPagamento(pedidos);
    renderizarDeliveryCollection(pedidos);
    renderizarTopProdutos(topProdutos);
    renderizarFechamento(calcularResumoFechamento(pedidos, cancelados));

    carregando.style.display = 'none';
    conteudo.style.display = '';
  } catch (erroCarregamento) {
    console.error('Erro ao carregar relatórios:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os relatórios. ' + erroCarregamento.message;
    erro.style.display = 'block';
  }
}

/** Gráfico de barras verticais com o faturamento de cada dia do período selecionado */
function renderizarGraficoFaturamentoPorDia(pedidos, dias) {
  const moeda = obterConfiguracoes().moeda;
  const porDia = new Map(dias.map((d) => [d, 0]));
  pedidos.forEach((p) => {
    const chave = chaveDataDublin(p.criadoEm);
    if (porDia.has(chave)) porDia.set(chave, porDia.get(chave) + p.total);
  });

  const valores = Array.from(porDia.values());
  const maximo = Math.max(1, ...valores);
  const container = document.getElementById('grafico-faturamento-periodo');

  if (valores.every((v) => v === 0)) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda no período.</div>';
    return;
  }

  container.innerHTML = dias
    .map((d) => {
      const valor = porDia.get(d);
      const altura = valor > 0 ? Math.max(4, Math.round((valor / maximo) * 100)) : 0;
      return `
        <div class="coluna-barra-vertical">
          <div class="barra-vertical" style="height:${altura}%;" title="${formatarMoeda(valor, moeda)}"></div>
          <span class="rotulo-barra-vertical">${rotuloDiaCurto(d)}</span>
        </div>`;
    })
    .join('');
}

/** Total recebido por forma de pagamento (Cartão/Dinheiro/Revolut), no período selecionado */
function renderizarFormasPagamento(pedidos) {
  const moeda = obterConfiguracoes().moeda;
  const porForma = { cartao: { qtd: 0, valor: 0 }, dinheiro: { qtd: 0, valor: 0 }, revolut: { qtd: 0, valor: 0 }, transferencia: { qtd: 0, valor: 0 } };
  pedidos.forEach((p) => {
    if (!porForma[p.formaPagamento]) return;
    porForma[p.formaPagamento].qtd += 1;
    porForma[p.formaPagamento].valor += p.total;
  });

  const container = document.getElementById('lista-formas-pagamento');
  if (pedidos.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda no período.</div>';
    return;
  }

  container.innerHTML = Object.keys(ROTULOS_FORMA_PAGAMENTO)
    .map((chave) => {
      const dados = porForma[chave];
      return `<div class="linha-resumo"><span>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[chave])}</span><span>${dados.qtd} pedido${dados.qtd === 1 ? '' : 's'} · ${formatarMoeda(dados.valor, moeda)}</span></div>`;
    })
    .join('');
}

/** Pedidos e faturamento de Delivery vs. Collection, no período selecionado */
function renderizarDeliveryCollection(pedidos) {
  const moeda = obterConfiguracoes().moeda;
  const porFulfilment = { entrega: { qtd: 0, valor: 0 }, retirada: { qtd: 0, valor: 0 } };
  pedidos.forEach((p) => {
    if (!porFulfilment[p.fulfilment]) return;
    porFulfilment[p.fulfilment].qtd += 1;
    porFulfilment[p.fulfilment].valor += p.total;
  });

  const container = document.getElementById('lista-delivery-collection');
  if (pedidos.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda no período.</div>';
    return;
  }

  container.innerHTML = `
    <div class="linha-resumo"><span>Delivery</span><span>${porFulfilment.entrega.qtd} pedido${porFulfilment.entrega.qtd === 1 ? '' : 's'} · ${formatarMoeda(porFulfilment.entrega.valor, moeda)}</span></div>
    <div class="linha-resumo"><span>Collection</span><span>${porFulfilment.retirada.qtd} pedido${porFulfilment.retirada.qtd === 1 ? '' : 's'} · ${formatarMoeda(porFulfilment.retirada.valor, moeda)}</span></div>
  `;
}

/**
 * Preenche o bloco "Fechamento" (por período) com o resumo de calcularResumoFechamento(). dashboard.html
 * ainda não tem esses elementos — cada id é procurado individualmente e só preenchido se existir, mesmo
 * padrão defensivo já usado em cartao-cancelamentos-hoje (ver carregarCardsHoje()), pra não quebrar nada
 * enquanto o HTML/CSS dessa seção não é criado.
 */
function renderizarFechamento(resumo) {
  const moeda = obterConfiguracoes().moeda;
  const definir = (id, texto) => {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = texto;
  };

  definir('fechamento-faturamento', formatarMoeda(resumo.faturamento, moeda));
  definir('fechamento-pedidos', resumo.totalPedidos);
  definir('fechamento-ticket-medio', formatarMoeda(resumo.ticketMedio, moeda));
  definir('fechamento-taxas-entrega', formatarMoeda(resumo.taxasEntrega, moeda));
  definir('fechamento-cartao', formatarMoeda(resumo.cartao, moeda));
  definir('fechamento-dinheiro', formatarMoeda(resumo.dinheiro, moeda));
  definir('fechamento-revolut', formatarMoeda(resumo.revolut, moeda));
  definir('fechamento-transferencia', formatarMoeda(resumo.transferencia, moeda));
  definir('fechamento-delivery', formatarMoeda(resumo.delivery, moeda));
  definir('fechamento-retirada', formatarMoeda(resumo.retirada, moeda));
  definir('fechamento-troco', formatarMoeda(resumo.trocoInformado, moeda));
  definir('fechamento-cancelamentos', resumo.totalCancelamentos);
  definir('fechamento-valor-cancelado', formatarMoeda(resumo.valorHistoricoCancelado, moeda));
}

/** Ranking de produtos/combos mais vendidos (por quantidade) no período selecionado */
function renderizarTopProdutos(topProdutos) {
  const moeda = obterConfiguracoes().moeda;
  const corpo = document.getElementById('corpo-tabela-top-produtos');
  const vazio = document.getElementById('estado-vazio-top-produtos');

  if (topProdutos.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = topProdutos
    .map(
      (p) => `
      <tr>
        <td>${escaparHtml(p.nome)}</td>
        <td>${p.quantidade}</td>
        <td>${formatarMoeda(p.valorVendido, moeda)}</td>
      </tr>`
    )
    .join('');
}
