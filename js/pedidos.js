/*
 * pedidos.js
 * Painel operacional de Pedidos (Kanban): Solicitado -> Em Preparo -> Pronto
 * -> Finalizado. Lê/atualiza os mesmos pedidos gravados pela área "Fazer
 * Pedido" (obterPedidosClientes(), storage.js) — nenhuma lógica de status
 * mora aqui, só chama aceitarPedido()/marcarPedidoComoPronto()/
 * concluirPedido() (storage.js), que validam a transição. Depende de
 * utils.js, storage.js e app.js (carregados antes deste).
 */

let filtroTipoPedidos = ''; // '' | 'entrega' | 'retirada'
let termoBuscaPedidos = '';
let canalPedidosRealtime = null;

document.addEventListener('DOMContentLoaded', async () => {
  const carregando = document.getElementById('estado-carregando-pedidos');
  const erro = document.getElementById('estado-erro-pedidos');
  const kanban = document.getElementById('kanban-pedidos');
  try {
    await carregarPedidosClientesCache();
  } catch (erroCarregamento) {
    console.error('Erro ao carregar pedidos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar pedidos. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';
  kanban.style.display = '';

  renderizarQuadroPedidos();
  ligarEventosFiltrosPedidos();
  ligarEventosModalPedido();
  // Atualiza "há X min" e o alerta de demora sozinho enquanto a página estiver aberta (não busca dado novo, só redesenha o cache atual)
  setInterval(renderizarQuadroPedidos, 30000);

  iniciarRealtimePedidos();
});

/** Uma única subscription pra mudanças em orders — em qualquer INSERT/UPDATE/DELETE, recarrega o cache e redesenha o quadro inteiro */
function iniciarRealtimePedidos() {
  if (canalPedidosRealtime) return;
  canalPedidosRealtime = subscribeToOrders(async () => {
    await carregarPedidosClientesCache();
    renderizarQuadroPedidos();
  });
}

window.addEventListener('beforeunload', () => {
  unsubscribeFromOrders(canalPedidosRealtime);
});

function ligarEventosFiltrosPedidos() {
  document.getElementById('campo-busca-pedidos').addEventListener(
    'input',
    debounce(() => {
      termoBuscaPedidos = document.getElementById('campo-busca-pedidos').value;
      renderizarQuadroPedidos();
    }, 250)
  );

  document.getElementById('filtro-tipo-pedidos').addEventListener('change', () => {
    filtroTipoPedidos = document.getElementById('filtro-tipo-pedidos').value;
    renderizarQuadroPedidos();
  });
}

// ---------------------------------------------------------------------------
// Quadro Kanban
// ---------------------------------------------------------------------------

function renderizarQuadroPedidos() {
  const termo = termoBuscaPedidos.trim().toLowerCase();
  let pedidos = obterPedidosClientes();

  if (filtroTipoPedidos) pedidos = pedidos.filter((p) => p.fulfilment === filtroTipoPedidos);
  if (termo) {
    pedidos = pedidos.filter(
      (p) => (p.numero || '').toLowerCase().includes(termo) || ((p.cliente || {}).nome || '').toLowerCase().includes(termo)
    );
  }

  // Mais antigo primeiro em todas as colunas — evita esquecer pedido parado (item 12 do briefing)
  pedidos = pedidos.slice().sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));

  renderizarColunaKanban('solicitado', pedidos.filter((p) => p.status === STATUS_PEDIDO.SOLICITADO));
  renderizarColunaKanban('em_preparo', pedidos.filter((p) => p.status === STATUS_PEDIDO.EM_PREPARO));
  renderizarColunaKanban('pronto', pedidos.filter((p) => p.status === STATUS_PEDIDO.PRONTO));
  renderizarColunaKanban(
    'finalizado',
    pedidos.filter((p) => p.status === STATUS_PEDIDO.FINALIZADO && ehHoje(p.finalizadoEm || p.criadoEm))
  );

  if (typeof atualizarContadorPedidosNovos === 'function') atualizarContadorPedidosNovos();
}

function renderizarColunaKanban(status, pedidosDaColuna) {
  const lista = document.getElementById('lista-pedidos-' + status);
  const vazio = document.getElementById('vazio-coluna-' + status);
  const contador = document.getElementById('contador-coluna-' + status);
  contador.textContent = pedidosDaColuna.length;

  if (pedidosDaColuna.length === 0) {
    lista.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';
  lista.innerHTML = pedidosDaColuna.map((p) => cardPedidoHtml(p)).join('');

  lista.querySelectorAll('[data-acao="ver"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalhesPedido(botao.dataset.id));
  });
  lista.querySelectorAll('[data-acao="aceitar"]').forEach((botao) => {
    botao.addEventListener('click', () => executarAcaoPedido(botao.dataset.id, aceitarPedido, 'Pedido aceito — em preparo.'));
  });
  lista.querySelectorAll('[data-acao="pronto"]').forEach((botao) => {
    botao.addEventListener('click', () => executarAcaoPedido(botao.dataset.id, marcarPedidoComoPronto, 'Pedido marcado como pronto.'));
  });
  lista.querySelectorAll('[data-acao="concluir"]').forEach((botao) => {
    botao.addEventListener('click', () => {
      if (!confirm('Confirmar que este pedido foi entregue/retirado?')) return;
      executarAcaoPedido(botao.dataset.id, concluirPedido, 'Pedido finalizado.');
    });
  });
}

/** Chama a transição de status (storage.js), mostra toast e redesenha o quadro — trata erro de transição inválida sem quebrar a tela */
async function executarAcaoPedido(id, funcaoTransicao, mensagemSucesso) {
  try {
    await funcaoTransicao(id);
    mostrarToast(mensagemSucesso, 'sucesso');
    renderizarQuadroPedidos();
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível atualizar o pedido.', 'erro');
  }
}

// ---------------------------------------------------------------------------
// Card do pedido
// ---------------------------------------------------------------------------

function cardPedidoHtml(pedido) {
  const novo = pedido.status === STATUS_PEDIDO.SOLICITADO;
  const totalItens = (pedido.itens || []).reduce((soma, item) => soma + item.quantidade, 0);
  const minutosDesdeCriacao = Math.max(0, Math.floor((Date.now() - new Date(pedido.criadoEm).getTime()) / 60000));
  const nivelDemora = pedido.status === STATUS_PEDIDO.FINALIZADO ? 'normal' : calcularNivelDemoraPedido(minutosDesdeCriacao);
  const tipoRotulo = pedido.fulfilment === 'entrega' ? '🚗 Entrega' : '📍 Retirada';
  const tempoRotulo = formatarTempoDecorrido(obterTimestampEtapaAtual(pedido));
  const moeda = obterConfiguracoes().moeda;

  return `
    <div class="card card-pedido ${novo ? 'card-pedido-novo' : ''} demora-${nivelDemora}" data-id="${pedido.id}">
      <div class="card-pedido-cabecalho">
        <strong>${escaparHtml(pedido.numero)}</strong>
        ${novo ? '<span class="badge-novo">Novo</span>' : ''}
      </div>
      <div class="card-pedido-info">
        <span>${formatarHora(pedido.criadoEm)} · ${escaparHtml(tempoRotulo)}</span>
        <span>${tipoRotulo}</span>
      </div>
      <div class="card-pedido-cliente">${escaparHtml((pedido.cliente || {}).nome || '(sem nome)')}</div>
      ${pedido.status === STATUS_PEDIDO.PRONTO ? blocoProntoParaHtml(pedido) : ''}
      <div class="card-pedido-rodape">
        <span>${totalItens} ${totalItens === 1 ? 'item' : 'itens'}</span>
        <span>${formatarMoeda(pedido.total, moeda)}</span>
      </div>
      <div class="card-pedido-acoes">
        <button type="button" class="btn btn-secundario" data-acao="ver" data-id="${pedido.id}">Ver pedido</button>
        ${botaoPrincipalPedidoHtml(pedido)}
      </div>
    </div>`;
}

/** Timestamp relevante pro "há X min" mostrado no card, conforme o status atual */
function obterTimestampEtapaAtual(pedido) {
  if (pedido.status === STATUS_PEDIDO.EM_PREPARO) return pedido.aceitoEm || pedido.criadoEm;
  if (pedido.status === STATUS_PEDIDO.PRONTO) return pedido.prontoEm || pedido.criadoEm;
  if (pedido.status === STATUS_PEDIDO.FINALIZADO) return pedido.finalizadoEm || pedido.criadoEm;
  return pedido.criadoEm;
}

function botaoPrincipalPedidoHtml(pedido) {
  if (pedido.status === STATUS_PEDIDO.SOLICITADO) {
    return `<button type="button" class="btn btn-primario" data-acao="aceitar" data-id="${pedido.id}">Aceitar pedido</button>`;
  }
  if (pedido.status === STATUS_PEDIDO.EM_PREPARO) {
    return `<button type="button" class="btn btn-primario" data-acao="pronto" data-id="${pedido.id}">Marcar como pronto</button>`;
  }
  if (pedido.status === STATUS_PEDIDO.PRONTO) {
    const rotulo = pedido.fulfilment === 'entrega' ? 'Pedido entregue' : 'Pedido retirado';
    return `<button type="button" class="btn btn-primario" data-acao="concluir" data-id="${pedido.id}">${rotulo}</button>`;
  }
  return '';
}

/** Bloco de destaque no card quando o pedido está Pronto — o que o funcionário precisa pra liberar/entregar */
function blocoProntoParaHtml(pedido) {
  const cliente = pedido.cliente || {};
  const linhaTroco = linhaTrocoNecessarioHtml(pedido);

  if (pedido.fulfilment === 'entrega') {
    const endereco = pedido.endereco || {};
    return `
      <div class="bloco-pronto-para">
        <strong>Pronto para entrega</strong>
        <span>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</span>
        <span>${escaparHtml(endereco.eircode || '')}</span>
        <span>${escaparHtml(endereco.linha1 || '')}${endereco.linha2 ? ', ' + escaparHtml(endereco.linha2) : ''}</span>
        ${linhaTroco}
      </div>`;
  }
  return `
    <div class="bloco-pronto-para">
      <strong>Pronto para retirada</strong>
      <span>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</span>
      ${linhaTroco}
    </div>`;
}

/**
 * Linha de "troco necessário" pra pagamento em Dinheiro — reaproveitada no
 * bloco de destaque "Pronto para..." e no modal de detalhes do pedido.
 * Retorna '' quando não for dinheiro ou não precisar de troco.
 */
function linhaTrocoNecessarioHtml(pedido) {
  if (pedido.formaPagamento !== 'dinheiro' || !pedido.pagamentoDinheiro || !pedido.pagamentoDinheiro.precisaTroco) return '';
  const moeda = obterConfiguracoes().moeda;
  return `<span class="destaque-troco">💶 Troco necessário: ${formatarMoeda(pedido.pagamentoDinheiro.troco, moeda)}</span>`;
}

/** Bloco "Pagamento" do modal de detalhes — destaca o troco quando a forma for Dinheiro */
function blocoPagamentoDetalhePedidoHtml(pedido) {
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

// ---------------------------------------------------------------------------
// Modal "Ver pedido"
// ---------------------------------------------------------------------------

function ligarEventosModalPedido() {
  document.getElementById('botao-fechar-modal-pedido').addEventListener('click', fecharModalPedido);
  document.getElementById('botao-fechar-modal-pedido-rodape').addEventListener('click', fecharModalPedido);
  document.getElementById('modal-overlay-pedido').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-pedido') fecharModalPedido();
  });
}

function fecharModalPedido() {
  document.getElementById('modal-overlay-pedido').classList.remove('modal-visivel');
}

function abrirModalDetalhesPedido(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido) return;

  const moeda = obterConfiguracoes().moeda;
  const cliente = pedido.cliente || {};
  const endereco = pedido.endereco || {};
  const ehEntrega = pedido.fulfilment === 'entrega';

  document.getElementById('pedido-modal-titulo').textContent = pedido.numero;

  const blocoTipo = ehEntrega
    ? `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Entrega</div>
        <p>${escaparHtml(endereco.eircode || '')}<br/>
        ${escaparHtml(endereco.linha1 || '')}${endereco.linha2 ? ', ' + escaparHtml(endereco.linha2) : ''}<br/>
        ${[endereco.area, endereco.distrito].filter(Boolean).map(escaparHtml).join(' — ')}</p>
        ${endereco.instrucoes ? `<p><em>${escaparHtml(endereco.instrucoes)}</em></p>` : ''}
        <p>Taxa de entrega: ${formatarMoeda(pedido.taxaEntrega, moeda)}</p>
      </div>`
    : `
      <div class="detalhe-pedido-secao">
        <div class="detalhe-pedido-titulo">Retirada</div>
        <p>Horário: ${escaparHtml((pedido.retirada || {}).horario || '—')}</p>
      </div>`;

  document.getElementById('pedido-modal-corpo').innerHTML = `
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Pedido</div>
      <p>Data: ${formatarData(pedido.criadoEm)} · Horário: ${formatarHora(pedido.criadoEm)}</p>
      <p>Status: <span class="badge badge-status-${pedido.status}">${escaparHtml(ROTULOS_STATUS_PEDIDO[pedido.status] || pedido.status)}</span></p>
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Cliente</div>
      <p>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</p>
    </div>
    ${blocoTipo}
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Itens do pedido</div>
      ${linhasItensPedidoHtml(pedido)}
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Pagamento</div>
      ${blocoPagamentoDetalhePedidoHtml(pedido)}
    </div>
    <div class="card resumo-carrinho">
      <div class="linha-resumo"><span>Subtotal</span><span>${formatarMoeda(pedido.subtotal, moeda)}</span></div>
      <div class="linha-resumo"><span>Taxa de entrega</span><span>${formatarMoeda(pedido.taxaEntrega, moeda)}</span></div>
      <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(pedido.total, moeda)}</span></div>
    </div>
  `;

  document.getElementById('modal-overlay-pedido').classList.add('modal-visivel');
}

function linhasItensPedidoHtml(pedido) {
  const moeda = obterConfiguracoes().moeda;
  return (pedido.itens || [])
    .map((item) => {
      if (item.combo) return blocoComboDetalhePedidoHtml(item, moeda);
      return `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>`;
    })
    .join('');
}

/** Composição de um combo já congelada no pedido (item.combo) — mesma informação mostrada no carrinho do cliente, sem recalcular nada */
function blocoComboDetalhePedidoHtml(item, moeda) {
  const c = item.combo;
  const espetos = (c.espetos || [])
    .map(
      (e) =>
        `<li>${e.quantidade}x ${escaparHtml(e.nome)}${e.acrescimoUnitario > 0 ? ` (+${formatarMoeda(e.acrescimoUnitario * e.quantidade, moeda)})` : ''}</li>`
    )
    .join('');
  const acompanhamentos = (c.acompanhamentos || [])
    .map((a) => `<li>${a.quantidade > 1 ? a.quantidade + 'x ' : ''}${escaparHtml(a.nome)}</li>`)
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
