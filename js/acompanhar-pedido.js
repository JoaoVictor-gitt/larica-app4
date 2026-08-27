/*
 * acompanhar-pedido.js
 * Página pública de acompanhamento de pedido (Parte A). Só fala com
 * /api/track-order (proxy do Worker pra get_public_order_tracking) —
 * nunca Supabase direto, nunca RPC mutante. A RPC já devolve o status
 * PÚBLICO derivado do status real do pedido (orders.status +
 * payment_status) — este arquivo só formata/exibe, nunca reinterpreta
 * nem inventa um segundo status.
 *
 * Sem alert()/confirm() — erro sempre inline (#erro-busca-pedido).
 * Pedido não encontrado e número mal formatado dão exatamente a mesma
 * mensagem genérica — nunca revela se telefone/nome bateu com algo.
 *
 * Atualização "ao vivo": polling leve (20s, só com a aba visível) em vez
 * de Realtime — decisão documentada no plano: o RLS real de `orders` não
 * é verificável neste projeto (não rastreado em migrations), então esta
 * página nunca abre uma conexão direta com a tabela; tudo passa pela RPC
 * SECURITY DEFINER, que decide explicitamente o que sai.
 */

const ROTULOS_ETAPA_TIMELINE = [
  { chave: 'aguardando_pagamento', rotulo: 'Aguard. pagamento' },
  { chave: 'solicitado', rotulo: 'Solicitado' },
  { chave: 'em_preparo', rotulo: 'Em preparo' },
  { chave: 'pronto', rotulo: 'Pronto' },
  { chave: 'finalizado', rotulo: 'Finalizado' },
];

const INDICE_ETAPA_TIMELINE = {
  aguardando_pagamento: 0,
  solicitado: 1,
  em_preparo: 2,
  pronto: 3,
  finalizado: 4,
};

const INTERVALO_POLLING_MS = 20000;

let intervaloPolling = null;
let numeroAtualAcompanhado = null;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('botao-buscar-pedido').addEventListener('click', () => {
    buscarEExibirPedido(document.getElementById('campo-numero-pedido').value);
  });

  document.getElementById('campo-numero-pedido').addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter') {
      evento.preventDefault();
      document.getElementById('botao-buscar-pedido').click();
    }
  });

  document.getElementById('botao-buscar-outro-pedido').addEventListener('click', () => {
    pararPolling();
    numeroAtualAcompanhado = null;
    document.getElementById('resultado-acompanhamento').style.display = 'none';
    document.getElementById('form-busca-pedido').style.display = '';
    document.getElementById('erro-busca-pedido').textContent = '';
    document.getElementById('campo-numero-pedido').value = '';
    document.getElementById('campo-numero-pedido').focus();

    const url = new URL(window.location.href);
    url.searchParams.delete('pedido');
    window.history.replaceState({}, '', url);
  });

  // Sobrescreve o botão de carrinho do cabeçalho compartilhado (injetado por
  // montarShellPedido(), js/app.js) — esta página não tem fluxo de carrinho,
  // só navega pro cardápio. Não altera js/app.js/js/pedido.js.
  const botaoCarrinhoCabecalho = document.getElementById('botao-carrinho-cabecalho');
  if (botaoCarrinhoCabecalho) {
    botaoCarrinhoCabecalho.addEventListener('click', () => {
      window.location.href = 'pedido.html';
    });
  }

  const numeroDaUrl = new URLSearchParams(window.location.search).get('pedido');
  if (numeroDaUrl) {
    document.getElementById('campo-numero-pedido').value = numeroDaUrl;
    buscarEExibirPedido(numeroDaUrl);
  }
});

async function buscarEExibirPedido(valorDigitado) {
  const numero = (valorDigitado || '').trim();
  const erroCampo = document.getElementById('erro-busca-pedido');
  erroCampo.textContent = '';

  if (!numero) {
    erroCampo.textContent = 'Informe o número do pedido.';
    return;
  }

  pararPolling();
  document.getElementById('form-busca-pedido').style.display = 'none';
  document.getElementById('resultado-acompanhamento').style.display = 'none';
  document.getElementById('estado-carregando-acompanhamento').style.display = '';

  const dados = await buscarPedidoNaApi(numero);

  document.getElementById('estado-carregando-acompanhamento').style.display = 'none';

  if (!dados) {
    document.getElementById('form-busca-pedido').style.display = '';
    erroCampo.textContent = 'Não encontramos nenhum pedido com esse número. Confira e tente novamente.';
    return;
  }

  numeroAtualAcompanhado = numero;
  const url = new URL(window.location.href);
  url.searchParams.set('pedido', numero);
  window.history.replaceState({}, '', url);

  renderizarResultado(dados);
  document.getElementById('resultado-acompanhamento').style.display = '';
  iniciarPolling();
}

/** POST /api/track-order — normalização de "#LARICA-31"/"LARICA-31"/"31" acontece server-side (RPC), nunca aqui */
async function buscarPedidoNaApi(numero) {
  try {
    const resposta = await fetch('/api/track-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_number: numero }),
    });
    if (!resposta.ok) return null;
    const corpo = await resposta.json().catch(() => null);
    return corpo && typeof corpo === 'object' && corpo.order_number != null ? corpo : null;
  } catch {
    return null;
  }
}

function iniciarPolling() {
  pararPolling();
  intervaloPolling = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !numeroAtualAcompanhado) return;
    const dados = await buscarPedidoNaApi(numeroAtualAcompanhado);
    if (dados) renderizarResultado(dados);
  }, INTERVALO_POLLING_MS);
}

function pararPolling() {
  if (intervaloPolling) {
    clearInterval(intervaloPolling);
    intervaloPolling = null;
  }
}

/** UTC (o que a RPC devolve) -> "HH:MM" na hora local de Dublin, com horário de verão tratado automaticamente pelo navegador */
function formatarHorarioDublin(isoTexto) {
  if (!isoTexto) return null;
  const data = new Date(isoTexto);
  if (Number.isNaN(data.getTime())) return null;
  return new Intl.DateTimeFormat('pt-IE', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(data);
}

function renderizarResultado(dados) {
  document.getElementById('numero-pedido-acompanhado').textContent = '#LARICA-' + dados.order_number;

  if (dados.status === 'cancelado') {
    document.getElementById('status-atual-pedido').innerHTML = '<strong>Pedido cancelado.</strong>';
    document.getElementById('timeline-pedido').innerHTML = '';
    document.getElementById('cartao-previsao-pedido').style.display = 'none';
    return;
  }

  document.getElementById('status-atual-pedido').innerHTML = formatarTextoStatus(dados);
  renderizarTimeline(dados.status);
  renderizarPrevisao(dados);
}

function formatarTextoStatus(dados) {
  const entrega = dados.fulfilment_type === 'delivery';
  switch (dados.status) {
    case 'aguardando_pagamento':
      return '<strong>Aguardando confirmação de pagamento.</strong>';
    case 'solicitado':
      return '<strong>Pedido solicitado.</strong> Em instantes começamos o preparo.';
    case 'em_preparo':
      return '<strong>Seu pedido está em preparo.</strong>';
    case 'pronto':
      return entrega
        ? '<strong>Seu pedido está pronto e seguirá para entrega.</strong>'
        : '<strong>Seu pedido está pronto para retirada.</strong>';
    case 'finalizado': {
      const horario = formatarHorarioDublin(dados.completed_at);
      return '<strong>Pedido finalizado.</strong>' + (horario ? ` Finalizado às ${horario}.` : '');
    }
    default:
      return '<strong>Status: ' + escaparHtml(dados.status) + '</strong>';
  }
}

// Ícone de "concluído" — mesma família de SVG inline do redesign (viewBox 24x24, stroke currentColor), nunca emoji.
const ICONE_CHECK_TIMELINE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

function renderizarTimeline(statusAtual) {
  const container = document.getElementById('timeline-pedido');
  const indiceAtual = INDICE_ETAPA_TIMELINE[statusAtual];
  if (indiceAtual === undefined) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = ROTULOS_ETAPA_TIMELINE.map((etapa, indice) => {
    const concluida = indice < indiceAtual || statusAtual === 'finalizado';
    const atual = indice === indiceAtual && statusAtual !== 'finalizado';
    const classeEtapa =
      'etapa-timeline' + (concluida ? ' etapa-timeline--concluida' : '') + (atual ? ' etapa-timeline--atual' : '');
    return `
      <div class="${classeEtapa}">
        <span class="etapa-timeline-marcador">${concluida ? ICONE_CHECK_TIMELINE : ''}</span>
        <span class="etapa-timeline-rotulo">${escaparHtml(etapa.rotulo)}</span>
      </div>
    `;
  }).join('');
}

function renderizarPrevisao(dados) {
  const cartao = document.getElementById('cartao-previsao-pedido');
  const horario = formatarHorarioDublin(dados.estimated_ready_at);
  if (!horario) {
    cartao.style.display = 'none';
    return;
  }
  document.getElementById('previsao-horario-pedido').textContent = 'aproximadamente ' + horario;
  cartao.style.display = '';
}
