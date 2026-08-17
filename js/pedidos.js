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
let timeoutRecarregarPedidosRealtime = null;

// Som de pedido novo (Fase 6) — preferência local do dispositivo, nunca vai pra business_settings.
const CHAVE_SOM_PEDIDOS_ATIVO = 'caju_som_pedidos_ativo';
let idsPedidosVistos = null; // Set — populado no 1º carregamento bem-sucedido, sem tocar som nesse load
let audioContextPedidos = null;

// Cancelamento de pedido (Fase 7) — id do pedido atualmente aberto no modal de cancelamento
let pedidoCancelamentoId = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const carregando = document.getElementById('estado-carregando-pedidos');
  const erro = document.getElementById('estado-erro-pedidos');
  const kanban = document.getElementById('kanban-pedidos');
  let sucesso = false;

  try {
    await carregarPedidosClientesCache();
    // Marca tudo que já existe na primeira carga como "visto" — nunca toca som pros pedidos que já estavam lá ao abrir a página.
    idsPedidosVistos = new Set(obterPedidosClientes().map((p) => p.id));
    sucesso = true;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar pedidos:', erroCarregamento);
    erro.textContent = 'Não foi possível carregar os pedidos. ' + erroCarregamento.message;
    erro.style.display = 'block';
  } finally {
    // Sempre sai do "Carregando...", dê certo ou não — nunca fica preso aqui.
    carregando.style.display = 'none';
  }

  if (!sucesso) return;

  kanban.style.display = '';
  renderizarQuadroPedidos();
  ligarEventosFiltrosPedidos();
  ligarEventosModalPedido();
  ligarEventosModalCancelamento();
  ligarEventosSomPedidos();
  // Atualiza "há X min" e o alerta de demora sozinho enquanto a página estiver aberta (não busca dado novo, só redesenha o cache atual)
  setInterval(renderizarQuadroPedidos, 30000);

  iniciarRealtimePedidos();
}

/**
 * Uma única subscription pra mudanças em `orders`. Cada evento (INSERT/
 * UPDATE/DELETE) agenda um recarregamento debounced — se vários eventos
 * chegarem juntos, só uma recarga é feita, evitando refazer as 3 consultas
 * repetidamente à toa.
 */
function iniciarRealtimePedidos() {
  if (canalPedidosRealtime) return;
  canalPedidosRealtime = subscribeToOrders(() => {
    clearTimeout(timeoutRecarregarPedidosRealtime);
    timeoutRecarregarPedidosRealtime = setTimeout(reloadOrders, 400);
  });
}

async function reloadOrders() {
  try {
    await carregarPedidosClientesCache();
    detectarPedidosNovos();
    renderizarQuadroPedidos();
  } catch (erro) {
    console.error('Erro ao recarregar pedidos (realtime):', erro);
  }
}

// ---------------------------------------------------------------------------
// Som de pedido novo
// ---------------------------------------------------------------------------

function somPedidosAtivo() {
  return localStorage.getItem(CHAVE_SOM_PEDIDOS_ATIVO) !== 'nao'; // ligado por padrão
}

function definirSomPedidosAtivo(ativo) {
  localStorage.setItem(CHAVE_SOM_PEDIDOS_ATIVO, ativo ? 'sim' : 'nao');
}

function ligarEventosSomPedidos() {
  const campo = document.getElementById('campo-som-pedidos');
  campo.checked = somPedidosAtivo();
  campo.addEventListener('change', () => {
    definirSomPedidosAtivo(campo.checked);
    obterAudioContextPedidos(); // já é uma interação do usuário — aproveita pra desbloquear o autoplay
  });

  // Qualquer clique na página conta como interação do usuário pro autoplay — desbloqueia
  // o AudioContext o quanto antes, sem esperar o primeiro pedido novo realmente chegar.
  document.addEventListener('click', obterAudioContextPedidos, { once: true });
}

/** Cria/retoma o AudioContext. Só funciona de verdade após alguma interação do usuário na página (regra do navegador) — silencioso se falhar/indisponível. */
function obterAudioContextPedidos() {
  try {
    if (!audioContextPedidos) {
      const AudioContextClasse = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClasse) return null;
      audioContextPedidos = new AudioContextClasse();
    }
    if (audioContextPedidos.state === 'suspended') audioContextPedidos.resume().catch(() => {});
    return audioContextPedidos;
  } catch (erro) {
    return null;
  }
}

/** Beep curto via Web Audio API (sem arquivo/biblioteca externa). Nunca lança — autoplay bloqueado é ignorado silenciosamente. */
function tocarSomNovoPedido() {
  if (!somPedidosAtivo()) return;
  try {
    const ctx = obterAudioContextPedidos();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    ganho.gain.setValueAtTime(0.0001, ctx.currentTime);
    ganho.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(ganho);
    ganho.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (erro) {
    // Som é só um extra — autoplay bloqueado ou API indisponível nunca deve quebrar a tela.
  }
}

/** Compara os pedidos atuais com idsPedidosVistos — qualquer id que apareceu de novo toca o som e entra no set. */
function detectarPedidosNovos() {
  if (!idsPedidosVistos) return;
  let temPedidoNovo = false;
  obterPedidosClientes().forEach((p) => {
    if (!idsPedidosVistos.has(p.id)) {
      idsPedidosVistos.add(p.id);
      temPedidoNovo = true;
    }
  });
  if (temPedidoNovo) tocarSomNovoPedido();
}

window.addEventListener('beforeunload', () => {
  clearTimeout(timeoutRecarregarPedidosRealtime);
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

  renderizarColunaKanban('aguardando_pagamento', pedidos.filter(pedidoAguardandoPagamento));
  renderizarColunaKanban(
    'solicitado',
    pedidos.filter((p) => p.status === STATUS_PEDIDO.SOLICITADO && !pedidoAguardandoPagamento(p))
  );
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
    botao.addEventListener('click', () => executarAcaoPedido(botao, aceitarPedido, 'Pedido aceito — em preparo.'));
  });
  lista.querySelectorAll('[data-acao="pronto"]').forEach((botao) => {
    botao.addEventListener('click', () => executarAcaoPedido(botao, marcarPedidoComoPronto, 'Pedido marcado como pronto.'));
  });
  lista.querySelectorAll('[data-acao="concluir"]').forEach((botao) => {
    botao.addEventListener('click', () => {
      if (!confirm('Confirmar que este pedido foi entregue/retirado?')) return;
      executarAcaoPedido(botao, concluirPedido, 'Pedido finalizado.');
    });
  });
  lista.querySelectorAll('[data-acao="cancelar"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalCancelamento(botao.dataset.id));
  });
  lista.querySelectorAll('[data-acao="confirmar-pagamento"]').forEach((botao) => {
    botao.addEventListener('click', () => executarAcaoPedido(botao, confirmarPagamentoPedido, 'Pagamento confirmado.'));
  });
}

/**
 * Pedido Revolut ou Transferência Bancária ainda não confirmado pela equipe — sai das colunas
 * operacionais normais e vai pra área própria "Aguardando pagamento" (Fase 9, estendida pra
 * transferência). Pedidos 'legado' nunca batem aqui (statusPagamento nunca é 'pendente' pra eles),
 * então seguem só pela regra operacional antiga, sem exceção especial.
 */
function pedidoAguardandoPagamento(pedido) {
  return (
    (pedido.formaPagamento === 'revolut' || pedido.formaPagamento === 'transferencia') &&
    pedido.statusPagamento === STATUS_PAGAMENTO.PENDENTE &&
    pedido.status === STATUS_PEDIDO.SOLICITADO
  );
}

/**
 * Chama a transição de status (storage.js), mostra toast e redesenha o quadro — trata erro de
 * transição inválida sem quebrar a tela. Desabilita o botão clicado enquanto a RPC está em
 * andamento (evita clique duplo disparar 2 transições); no sucesso o quadro inteiro é redesenhado,
 * então o botão antigo já some do DOM — só precisa reabilitar explicitamente no erro.
 */
async function executarAcaoPedido(botao, funcaoTransicao, mensagemSucesso) {
  const id = botao.dataset.id;
  const rotuloOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Aguarde...';

  try {
    await funcaoTransicao(id);
    mostrarToast(mensagemSucesso, 'sucesso');
    renderizarQuadroPedidos();
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível atualizar o pedido.', 'erro');
    botao.disabled = false;
    botao.textContent = rotuloOriginal;
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
  const tipoRotulo =
    pedido.fulfilment === 'entrega' ? '🚗 Entrega' : `📍 Retirada · ${escaparHtml(rotuloCompactoHorarioRetirada(pedido))}`;
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
      <div class="card-pedido-pagamento">${rotuloPagamentoCompacto(pedido)}</div>
      ${pedido.status === STATUS_PEDIDO.PRONTO ? blocoProntoParaHtml(pedido) : ''}
      <div class="card-pedido-rodape">
        <span>${totalItens} ${totalItens === 1 ? 'item' : 'itens'}</span>
        <span>${formatarMoeda(pedido.total, moeda)}</span>
      </div>
      <div class="card-pedido-acoes">
        <button type="button" class="btn btn-secundario" data-acao="ver" data-id="${pedido.id}">Ver pedido</button>
        ${botaoPrincipalPedidoHtml(pedido)}
      </div>
      ${pedidoPodeSerCancelado(pedido) ? `<button type="button" class="link-cancelar-pedido" data-acao="cancelar" data-id="${pedido.id}">Cancelar pedido</button>` : ''}
    </div>`;
}

/** Cancelável só em Solicitado/Em Preparo — nunca Pronto/Finalizado/Cancelado (mesma regra da RPC cancel_order) */
function pedidoPodeSerCancelado(pedido) {
  return pedido.status === STATUS_PEDIDO.SOLICITADO || pedido.status === STATUS_PEDIDO.EM_PREPARO;
}

/** Timestamp relevante pro "há X min" mostrado no card, conforme o status atual */
function obterTimestampEtapaAtual(pedido) {
  if (pedido.status === STATUS_PEDIDO.EM_PREPARO) return pedido.aceitoEm || pedido.criadoEm;
  if (pedido.status === STATUS_PEDIDO.PRONTO) return pedido.prontoEm || pedido.criadoEm;
  if (pedido.status === STATUS_PEDIDO.FINALIZADO) return pedido.finalizadoEm || pedido.criadoEm;
  return pedido.criadoEm;
}

function botaoPrincipalPedidoHtml(pedido) {
  if (pedidoAguardandoPagamento(pedido)) {
    return `<button type="button" class="btn btn-primario" data-acao="confirmar-pagamento" data-id="${pedido.id}">Confirmar pagamento</button>`;
  }
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

/** true quando o pedido é pago em Dinheiro e precisa de troco — checagem única, reaproveitada no card e no bloco "Pronto para..." */
function precisaDeTroco(pedido) {
  return pedido.formaPagamento === 'dinheiro' && !!pedido.pagamentoDinheiro && !!pedido.pagamentoDinheiro.precisaTroco;
}

/** Rótulo curto de pagamento pro card do Kanban (ex.: "💳 Cartão", "💶 Dinheiro · Troco") — visível em qualquer status, não só Pronto */
function rotuloPagamentoCompacto(pedido) {
  const icones = { cartao: '💳', dinheiro: '💶', revolut: '🔵', transferencia: '🏦' };
  const icone = icones[pedido.formaPagamento] || '';
  const rotulo = ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '';
  const statusPendente =
    (pedido.formaPagamento === 'revolut' || pedido.formaPagamento === 'transferencia') && pedido.statusPagamento === STATUS_PAGAMENTO.PENDENTE
      ? ` · ${ROTULOS_STATUS_PAGAMENTO.pendente}`
      : '';
  return `${icone} ${rotulo}${statusPendente}${precisaDeTroco(pedido) ? ' · Troco' : ''}`.trim();
}

/**
 * Linha de "troco necessário" (com o valor) pra pagamento em Dinheiro — reaproveitada no
 * bloco de destaque "Pronto para..." e no modal de detalhes do pedido.
 * Retorna '' quando não for dinheiro ou não precisar de troco.
 */
function linhaTrocoNecessarioHtml(pedido) {
  if (!precisaDeTroco(pedido)) return '';
  const moeda = obterConfiguracoes().moeda;
  return `<span class="destaque-troco">💶 Troco necessário: ${formatarMoeda(pedido.pagamentoDinheiro.troco, moeda)}</span>`;
}

/** Bloco "Pagamento" do modal de detalhes — destaca o troco quando a forma for Dinheiro */
function blocoPagamentoDetalhePedidoHtml(pedido) {
  const rotulo = `<p>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '')}</p>`;
  const rotuloStatusPagamento = pedido.statusPagamento
    ? `<p>${escaparHtml(ROTULOS_STATUS_PAGAMENTO[pedido.statusPagamento] || '')}</p>`
    : '';

  if (pedido.formaPagamento !== 'dinheiro') return rotulo + rotuloStatusPagamento;

  const d = pedido.pagamentoDinheiro;
  const moeda = obterConfiguracoes().moeda;
  const detalheTroco =
    d && d.precisaTroco
      ? `<p class="aviso-troco">Troco para: ${formatarMoeda(d.valorPago, moeda)}<br/>Troco necessário: ${formatarMoeda(d.troco, moeda)}</p>`
      : '<p>Não precisa de troco</p>';
  return rotulo + rotuloStatusPagamento + detalheTroco;
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
  // Reaproveita o MESMO modal/função de cancelamento do card — só fecha "Ver pedido" e abre o de cancelamento.
  document.getElementById('botao-cancelar-pedido-detalhe').addEventListener('click', (evento) => {
    const id = evento.target.dataset.id;
    if (!id) return;
    fecharModalPedido();
    abrirModalCancelamento(id);
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

  const botaoCancelarDetalhe = document.getElementById('botao-cancelar-pedido-detalhe');
  if (pedidoPodeSerCancelado(pedido)) {
    botaoCancelarDetalhe.style.display = '';
    botaoCancelarDetalhe.dataset.id = pedido.id;
  } else {
    botaoCancelarDetalhe.style.display = 'none';
    delete botaoCancelarDetalhe.dataset.id;
  }

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
        <p>Retirada: ${escaparHtml(rotuloHorarioRetirada(pedido))}</p>
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

// ---------------------------------------------------------------------------
// Modal "Cancelar pedido" (Fase 7) — reaproveitado tanto pelo botão do card
// quanto pelo botão dentro do modal "Ver pedido" (mesma função, sem duplicar)
// ---------------------------------------------------------------------------

function ligarEventosModalCancelamento() {
  document.getElementById('botao-fechar-modal-cancelar').addEventListener('click', fecharModalCancelamento);
  document.getElementById('botao-voltar-cancelamento').addEventListener('click', fecharModalCancelamento);
  document.getElementById('modal-overlay-cancelar-pedido').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-cancelar-pedido') fecharModalCancelamento();
  });
  document.getElementById('botao-confirmar-cancelamento').addEventListener('click', confirmarCancelamentoPedido);
}

function abrirModalCancelamento(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido || !pedidoPodeSerCancelado(pedido)) return;

  pedidoCancelamentoId = id;
  document.getElementById('cancelar-pedido-numero').textContent = pedido.numero;
  document.getElementById('cancelar-pedido-cliente').textContent = (pedido.cliente || {}).nome || '(sem nome)';
  document.getElementById('campo-motivo-cancelamento').value = '';
  document.getElementById('erro-motivo-cancelamento').textContent = '';

  document.getElementById('modal-overlay-cancelar-pedido').classList.add('modal-visivel');
  document.getElementById('campo-motivo-cancelamento').focus();
}

function fecharModalCancelamento() {
  document.getElementById('modal-overlay-cancelar-pedido').classList.remove('modal-visivel');
  pedidoCancelamentoId = null;
  document.getElementById('campo-motivo-cancelamento').value = '';
  document.getElementById('erro-motivo-cancelamento').textContent = '';
}

/** Valida motivo obrigatório no cliente (a RPC também valida — não depende só disso), desabilita o botão durante a chamada e trata sucesso/erro sem deixar clique duplo disparar 2 cancelamentos. */
async function confirmarCancelamentoPedido() {
  if (!pedidoCancelamentoId) return;

  const campoMotivo = document.getElementById('campo-motivo-cancelamento');
  const erroMotivo = document.getElementById('erro-motivo-cancelamento');
  const motivo = campoMotivo.value.trim();

  if (!motivo) {
    erroMotivo.textContent = 'Informe o motivo do cancelamento.';
    campoMotivo.focus();
    return;
  }
  erroMotivo.textContent = '';

  const botao = document.getElementById('botao-confirmar-cancelamento');
  const rotuloOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Cancelando...';

  try {
    await cancelarPedido(pedidoCancelamentoId, motivo);
    mostrarToast('Pedido cancelado.', 'sucesso');
    fecharModalCancelamento();
    renderizarQuadroPedidos();
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível cancelar o pedido.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = rotuloOriginal;
  }
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
