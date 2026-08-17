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
    const config = await buscarConfiguracoesNegocioDoSupabase();
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

    const resumo = calcularResumoRelatorioDiario(pedidos, cancelados);
    renderizarRelatorioDiario(resumo);

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
