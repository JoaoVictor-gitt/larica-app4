/*
 * historico.js
 * Histórico de pedidos, dentro da área Pedidos: período (padrão: últimos 7 dias), busca por número,
 * nome ou telefone do cliente, filtro de situação (válidos/cancelados), resumo do período e detalhes.
 * Pedidos não têm mais etapas: todo pedido não cancelado é "Válido". Cancelados ficam visíveis para
 * auditoria e nunca somam no total. A consulta vai filtrada por período para o servidor
 * (definirPeriodoCachePedidos, storage.js). Pedidos nunca são excluídos por esta tela: o histórico é
 * registro financeiro. Depende de storage.js e utils.js.
 */

let historicoUsuarioEhAdmin = false; // link do nome do cliente -> ficha (clientes.html, só admin). Erro = sem link.
let periodoHistoricoAtual = '7dias';
let buscaHistoricoAtual = '';
let situacaoHistoricoAtual = '';
let _seqCargaHistorico = 0;

document.addEventListener('DOMContentLoaded', async () => {
  montarSeletorPeriodoHistorico();
  ligarEventosFiltrosHistorico();
  ligarEventosModalDetalhePedidoHistorico();
  usuarioEhAdminNoSupabase()
    .then((ehAdmin) => {
      historicoUsuarioEhAdmin = ehAdmin === true;
      renderizarPedidosFinalizados();
    })
    .catch(() => {});
  await carregarPeriodoHistorico();
});

function montarSeletorPeriodoHistorico() {
  const select = document.getElementById('filtro-periodo-historico');
  select.innerHTML = PERIODOS_PADRAO.map(
    (p) => `<option value="${p.chave}" ${p.chave === periodoHistoricoAtual ? 'selected' : ''}>${escaparHtml(p.rotulo)}</option>`
  ).join('');
}

function ligarEventosFiltrosHistorico() {
  const select = document.getElementById('filtro-periodo-historico');
  const de = document.getElementById('filtro-historico-de');
  const ate = document.getElementById('filtro-historico-ate');
  select.addEventListener('change', () => {
    periodoHistoricoAtual = select.value;
    const personalizado = periodoHistoricoAtual === 'personalizado';
    document.getElementById('grupo-periodo-personalizado').style.display = personalizado ? '' : 'none';
    document.getElementById('grupo-periodo-personalizado-ate').style.display = personalizado ? '' : 'none';
    if (!personalizado || (de.value && ate.value)) carregarPeriodoHistorico();
  });
  [de, ate].forEach((campo) =>
    campo.addEventListener('change', () => {
      if (de.value && ate.value) carregarPeriodoHistorico();
    })
  );
  document.getElementById('busca-historico').addEventListener(
    'input',
    debounce(() => {
      buscaHistoricoAtual = document.getElementById('busca-historico').value;
      renderizarPedidosFinalizados();
    }, 200)
  );
  document.getElementById('filtro-situacao-historico').addEventListener('change', (evento) => {
    situacaoHistoricoAtual = evento.target.value;
    renderizarPedidosFinalizados();
  });
}

/** Busca no servidor só o período escolhido. Uma resposta antiga nunca sobrescreve a de um período mais novo. */
async function carregarPeriodoHistorico() {
  const seq = ++_seqCargaHistorico;
  const carregando = document.getElementById('estado-carregando-pedidos-finalizados');
  const erro = document.getElementById('estado-erro-pedidos-finalizados');
  carregando.style.display = 'block';
  erro.style.display = 'none';
  const intervalo = intervaloDoPeriodo(
    periodoHistoricoAtual,
    document.getElementById('filtro-historico-de').value,
    document.getElementById('filtro-historico-ate').value
  );
  if (intervalo.de && intervalo.ate && intervalo.ate <= intervalo.de) {
    carregando.style.display = 'none';
    erro.textContent = 'A data final precisa ser igual ou posterior à data inicial.';
    erro.style.display = 'block';
    return;
  }
  definirPeriodoCachePedidos(intervalo.de, intervalo.ate);
  try {
    await carregarPedidosClientesCache();
  } catch (erroCarregamento) {
    if (seq !== _seqCargaHistorico) return;
    console.error('Erro ao carregar pedidos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar pedidos. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  if (seq !== _seqCargaHistorico) return;
  carregando.style.display = 'none';
  renderizarPedidosFinalizados();
}

function pedidoCombinaComBuscaHistorico(pedido, termo) {
  if (!termo) return true;
  const cliente = pedido.cliente || {};
  const digitos = termo.replace(/\D/g, '');
  return (
    String(pedido.numero || '').toLowerCase().includes(termo) ||
    String(cliente.nome || '').toLowerCase().includes(termo) ||
    (digitos.length >= 3 && String(cliente.telefone || '').replace(/\D/g, '').includes(digitos))
  );
}

function pedidosHistoricoFiltrados() {
  const termo = buscaHistoricoAtual.trim().toLowerCase();
  return obterPedidosClientes()
    .filter((p) => {
      const cancelado = p.status === STATUS_PEDIDO.CANCELADO;
      if (situacaoHistoricoAtual === 'validos' && cancelado) return false;
      if (situacaoHistoricoAtual === 'cancelados' && !cancelado) return false;
      return pedidoCombinaComBuscaHistorico(p, termo);
    })
    .sort(compararPedidosFinalizadosPorCriacao);
}

function renderizarResumoHistorico(pedidos) {
  const alvo = document.getElementById('resumo-historico');
  if (!alvo) return;
  const validos = pedidos.filter((p) => p.status !== STATUS_PEDIDO.CANCELADO);
  const cancelados = pedidos.length - validos.length;
  const total = validos.reduce((soma, p) => soma + (Number(p.total) || 0), 0);
  const moeda = obterConfiguracoes().moeda;
  const ticket = validos.length ? total / validos.length : 0;
  alvo.innerHTML = `
    <div class="card resumo-historico-item"><span>Pedidos válidos</span><strong>${validos.length}</strong></div>
    <div class="card resumo-historico-item"><span>Total</span><strong>${formatarMoeda(total, moeda)}</strong></div>
    <div class="card resumo-historico-item"><span>Ticket médio</span><strong>${validos.length ? formatarMoeda(ticket, moeda) : '—'}</strong></div>
    <div class="card resumo-historico-item"><span>Cancelados</span><strong>${cancelados}</strong></div>`;
}

function renderizarPedidosFinalizados() {
  const pedidos = pedidosHistoricoFiltrados();
  renderizarResumoHistorico(pedidos);

  const corpo = document.getElementById('corpo-tabela-pedidos-finalizados');
  const vazio = document.getElementById('estado-vazio-pedidos-finalizados');
  if (document.getElementById('estado-carregando-pedidos-finalizados').style.display === 'block') return;

  if (pedidos.length === 0) {
    corpo.innerHTML = '';
    vazio.textContent = buscaHistoricoAtual.trim() ? 'Nenhum pedido encontrado para essa busca.' : 'Nenhum pedido neste período.';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = pedidos.map((p) => linhaPedidoHistoricoHtml(p, moeda)).join('');
  corpo.querySelectorAll('[data-acao="ver-detalhes"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalhePedidoHistorico(botao.dataset.id));
  });
}

const ROTULOS_TIPO_HISTORICO = { entrega: 'Entrega', comer_no_local: 'Comer no local', retirada: 'Retirada' };

/** Número do pedido + selo do canal (só Deliveroo/Just Eat; Larica fica sem selo). */
function celulaNumeroPedidoHistoricoHtml(pedido) {
  const canal = canalVendaDoPedido(pedido.canal);
  const selo = canal === 'larica' ? '' : ` <span class="selo-canal-venda selo-canal-${canal}">${escaparHtml(rotuloCanalVenda(canal))}</span>`;
  return escaparHtml(pedido.numero) + selo;
}

function linhaPedidoHistoricoHtml(pedido, moeda) {
  const cancelado = pedido.status === STATUS_PEDIDO.CANCELADO;
  const tipoRotulo = ROTULOS_TIPO_HISTORICO[pedido.fulfilment] || 'Retirada';
  const situacao = cancelado
    ? `<span class="badge badge-vermelho" title="${escaparHtml(pedido.motivoCancelamento || '')}">Cancelado</span>`
    : '<span class="badge badge-verde">Válido</span>';
  return `
    <tr class="${cancelado ? 'linha-historico-cancelada' : ''}">
      <td>${celulaNumeroPedidoHistoricoHtml(pedido)}</td>
      <td>${escaparHtml(formatarDataHoraCriacaoHistorico(pedido.criadoEm))}</td>
      <td>${celulaClienteHistoricoHtml(pedido)}</td>
      <td>${escaparHtml(tipoRotulo)}</td>
      <td>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '—')}</td>
      <td>${formatarMoeda(pedido.total, moeda)}</td>
      <td>${situacao}</td>
      <td>
        <div class="acoes-linha">
          <button class="btn btn-secundario" data-acao="ver-detalhes" data-id="${pedido.id}">Ver detalhes</button>
        </div>
      </td>
    </tr>`;
}

/**
 * Nome do cliente — "Não informado" sem nome; link pra ficha só pra admin. O link leva o id do pedido
 * (nunca o telefone): a ficha resolve o cliente no banco (get_customer_detail).
 */
function celulaClienteHistoricoHtml(pedido) {
  const nome = ((pedido.cliente || {}).nome || '').trim();
  if (!nome) return '<span class="cliente-nao-informado">Não informado</span>';
  if (!historicoUsuarioEhAdmin) return escaparHtml(nome);
  return `<a class="link-cliente-historico" href="clientes.html?pedido=${encodeURIComponent(pedido.id)}" title="Ver ficha do cliente">${escaparHtml(nome)}</a>`;
}

// Data = criação do pedido (created_at). Fuso fixo do restaurante via Intl (GMT/IST tratados sozinhos),
// independente do fuso do navegador.
const FUSO_HISTORICO = 'Europe/Dublin';
const FORMATADOR_DATA_HORA_HISTORICO = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUSO_HISTORICO,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Timestamp (ms) de um ISO, ou null se ausente/inválido — nunca inventa data. */
function timestampHistorico(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? null : ms;
}

/** "DD/MM/YYYY HH:mm" em Europe/Dublin, ou "Data indisponível". */
function formatarDataHoraCriacaoHistorico(iso) {
  const ms = timestampHistorico(iso);
  if (ms === null) return 'Data indisponível';
  const partes = Object.fromEntries(FORMATADOR_DATA_HORA_HISTORICO.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

/** Mais recentes primeiro pela criação real. Empate: número do pedido, maior primeiro. Sem data válida vai para o fim. */
function compararPedidosFinalizadosPorCriacao(a, b) {
  const ta = timestampHistorico(a.criadoEm);
  const tb = timestampHistorico(b.criadoEm);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  return String(b.numero || '').localeCompare(String(a.numero || ''), undefined, { numeric: true });
}

// ---------------------------------------------------------------------------
// Modal "Ver detalhes"
// ---------------------------------------------------------------------------

function ligarEventosModalDetalhePedidoHistorico() {
  document.getElementById('botao-fechar-modal-detalhe-historico').addEventListener('click', fecharModalDetalhePedidoHistorico);
  document.getElementById('botao-fechar-modal-detalhe-historico-rodape').addEventListener('click', fecharModalDetalhePedidoHistorico);
  document.getElementById('modal-overlay-detalhe-pedido-historico').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-detalhe-pedido-historico') fecharModalDetalhePedidoHistorico();
  });
}

function fecharModalDetalhePedidoHistorico() {
  document.getElementById('modal-overlay-detalhe-pedido-historico').classList.remove('modal-visivel');
}

function abrirModalDetalhePedidoHistorico(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido) return;

  const moeda = obterConfiguracoes().moeda;
  const cliente = pedido.cliente || {};
  const endereco = pedido.endereco || {};
  const ehEntrega = pedido.fulfilment === 'entrega';
  const ehComerNoLocal = pedido.fulfilment === 'comer_no_local';
  const ehCancelado = pedido.status === STATUS_PEDIDO.CANCELADO;

  document.getElementById('detalhe-pedido-historico-titulo').textContent = pedido.numero;

  let blocoTipo;
  if (ehEntrega) {
    blocoTipo = `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Entrega</div>
        <p>${escaparHtml(endereco.eircode || '')}<br/>
        ${escaparHtml(endereco.linha1 || '')}${endereco.linha2 ? ', ' + escaparHtml(endereco.linha2) : ''}<br/>
        ${[endereco.area, endereco.distrito].filter(Boolean).map(escaparHtml).join(' — ')}</p>
        ${endereco.instrucoes ? `<p><em>${escaparHtml(endereco.instrucoes)}</em></p>` : ''}
        <p>Taxa de entrega: ${formatarMoeda(pedido.taxaEntrega, moeda)}</p>
      </div>`;
  } else if (ehComerNoLocal) {
    blocoTipo = `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Comer no local</div>
        <p>Horário: ${escaparHtml(rotuloHorarioRetirada(pedido))}</p>
      </div>`;
  } else {
    blocoTipo = `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Retirada</div>
        <p>Retirada: ${escaparHtml(rotuloHorarioRetirada(pedido))}</p>
      </div>`;
  }

  const blocoCancelamento = ehCancelado
    ? `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Cancelamento</div>
        <p>Cancelado em: ${escaparHtml(formatarData(pedido.canceladoEm))} ${escaparHtml(formatarHora(pedido.canceladoEm))}</p>
        <p>Motivo: ${escaparHtml(pedido.motivoCancelamento || '—')}</p>
      </div>`
    : '';

  document.getElementById('detalhe-pedido-historico-corpo').innerHTML = `
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Pedido</div>
      <p>Data: ${formatarData(pedido.criadoEm)} · Horário: ${formatarHora(pedido.criadoEm)}</p>
      <p>Status: <span class="badge badge-cinza">${escaparHtml(ROTULOS_STATUS_PEDIDO[pedido.status] || pedido.status)}</span></p>
      <p>Canal: ${escaparHtml(rotuloCanalVenda(pedido.canal))}</p>
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Cliente</div>
      <p>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</p>
    </div>
    ${blocoTipo}
    ${blocoCancelamento}
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Itens do pedido</div>
      ${linhasItensPedidoHistoricoHtml(pedido)}
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Pagamento</div>
      ${blocoPagamentoDetalheHistoricoHtml(pedido)}
    </div>
    <div class="card resumo-carrinho">
      <div class="linha-resumo"><span>Subtotal</span><span>${formatarMoeda(pedido.subtotal, moeda)}</span></div>
      <div class="linha-resumo"><span>Taxa de entrega</span><span>${formatarMoeda(pedido.taxaEntrega, moeda)}</span></div>
      <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(pedido.total, moeda)}</span></div>
    </div>
  `;

  document.getElementById('modal-overlay-detalhe-pedido-historico').classList.add('modal-visivel');
}

function linhasItensPedidoHistoricoHtml(pedido) {
  const moeda = obterConfiguracoes().moeda;
  return (pedido.itens || [])
    .map((item) => {
      if (item.combo) return blocoComboDetalheHistoricoHtml(item, moeda);
      return `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>`;
    })
    .join('');
}

function blocoComboDetalheHistoricoHtml(item, moeda) {
  const c = item.combo;
  const espetos = (c.espetos || [])
    .map(
      (e) =>
        `<li>${e.quantidade}x ${escaparHtml(e.nome)}${e.acrescimoUnitario > 0 ? ` (+${formatarMoeda(e.acrescimoUnitario * e.quantidade, moeda)})` : ''}</li>`
    )
    .join('');
  const acompanhamentos = (c.acompanhamentos || [])
    .map(
      (a) =>
        `<li>${a.quantidade > 1 ? a.quantidade + 'x ' : ''}${escaparHtml(a.nome)}${a.acrescimoUnitario > 0 ? ` (+${formatarMoeda(a.acrescimoUnitario * a.quantidade, moeda)})` : ''}</li>`
    )
    .join('');
  const inclusos = (c.incluidos || []).map((i) => `<li>${escaparHtml(i)}</li>`).join('');

  return `
    <div class="detalhe-combo-pedido">
      <div class="detalhe-combo-pedido-cabecalho">
        <strong>${escaparHtml(c.nome)}</strong>
        <span>${formatarMoeda(item.valorTotal, moeda)}</span>
      </div>
      ${espetos ? `<div class="detalhe-combo-pedido-grupo"><span class="detalhe-combo-pedido-rotulo">Espeto</span><ul>${espetos}</ul></div>` : ''}
      ${acompanhamentos ? `<div class="detalhe-combo-pedido-grupo"><span class="detalhe-combo-pedido-rotulo">Acompanhamento</span><ul>${acompanhamentos}</ul></div>` : ''}
      ${inclusos ? `<div class="detalhe-combo-pedido-grupo"><span class="detalhe-combo-pedido-rotulo">Incluso</span><ul>${inclusos}</ul></div>` : ''}
    </div>`;
}

function blocoPagamentoDetalheHistoricoHtml(pedido) {
  const rotulo = `<p>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '')}</p>`;
  if (pedido.formaPagamento !== 'dinheiro') return rotulo;

  const d = pedido.pagamentoDinheiro;
  const moeda = obterConfiguracoes().moeda;
  const detalheTroco =
    d && d.precisaTroco
      ? `<p class="aviso-troco">Troco para: ${formatarMoeda(d.valorPago, moeda)}<br/>Troco necessário: ${formatarMoeda(d.troco, moeda)}</p>`
      : '<p>Não precisa de troco</p>';
  return rotulo + detalheTroco;
}
