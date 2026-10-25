/*
 * historico.js
 * Pedidos finalizados e cancelados (área Fazer Pedido, Supabase via
 * carregarPedidosClientesCache()/obterPedidosClientes()) — listar, ver
 * detalhes, excluir individual/em massa/total. Duas abas: Finalizados
 * (excluível, comportamento original) e Cancelados (só consulta/auditoria,
 * nunca excluível por aqui — ver item 8 da Fase 7/Etapa 4). Nunca toca em
 * pedidos Solicitado/Em Preparo/Pronto (esses pertencem ao painel
 * operacional em pedidos.html).
 * Depende de storage.js e utils.js.
 */

let pedidosSelecionadosHistorico = new Set();
let acaoPendenteExclusaoHistorico = null;
let abaHistoricoAtual = 'finalizado'; // 'finalizado' | 'cancelado'
// Link do nome do cliente -> ficha (clientes.html, admin-only). Fail closed: erro ao consultar = sem link.
let historicoUsuarioEhAdmin = false;

document.addEventListener('DOMContentLoaded', async () => {
  const carregando = document.getElementById('estado-carregando-pedidos-finalizados');
  const erro = document.getElementById('estado-erro-pedidos-finalizados');
  try {
    const [, ehAdmin] = await Promise.all([carregarPedidosClientesCache(), usuarioEhAdminNoSupabase().catch(() => false)]);
    historicoUsuarioEhAdmin = ehAdmin === true;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar pedidos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar pedidos. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  renderizarPedidosFinalizados();
  ligarEventosPedidosFinalizados();
  ligarEventosAbasHistorico();
  ligarEventosConfirmacaoExclusaoHistorico();
  ligarEventosModalDetalhePedidoHistorico();
});

function ligarEventosAbasHistorico() {
  document.querySelectorAll('#abas-historico-pedidos .filtro-categoria-botao').forEach((botao) => {
    botao.addEventListener('click', () => {
      abaHistoricoAtual = botao.dataset.abaHistorico;
      document.querySelectorAll('#abas-historico-pedidos .filtro-categoria-botao').forEach((b) => b.classList.toggle('ativo', b === botao));
      pedidosSelecionadosHistorico.clear();
      renderizarPedidosFinalizados();
    });
  });
}

// ---------------------------------------------------------------------------
// Pedidos finalizados/cancelados — listar, selecionar (só Finalizados), excluir (só Finalizados)
// ---------------------------------------------------------------------------

function renderizarPedidosFinalizados() {
  const ehCancelados = abaHistoricoAtual === 'cancelado';

  document.getElementById('titulo-secao-historico-pedidos').textContent = ehCancelados ? 'Pedidos cancelados' : 'Pedidos finalizados';
  document.getElementById('acoes-pedidos-finalizados-wrap').style.display = ehCancelados ? 'none' : '';
  document.getElementById('aviso-historico-cancelados').style.display = ehCancelados ? '' : 'none';

  renderizarCabecalhoTabelaHistorico(ehCancelados);

  const pedidos = ehCancelados
    ? obterPedidosClientes()
        .filter((p) => p.status === STATUS_PEDIDO.CANCELADO)
        .sort((a, b) => new Date(b.canceladoEm || b.criadoEm) - new Date(a.canceladoEm || a.criadoEm))
    : obterPedidosClientes()
        .filter((p) => p.status === STATUS_PEDIDO.FINALIZADO)
        .sort(compararPedidosFinalizadosPorCriacao);

  const corpo = document.getElementById('corpo-tabela-pedidos-finalizados');
  const vazio = document.getElementById('estado-vazio-pedidos-finalizados');
  vazio.textContent = ehCancelados ? 'Nenhum pedido cancelado.' : 'Nenhum pedido finalizado ainda.';

  if (pedidos.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    if (!ehCancelados) {
      document.getElementById('checkbox-selecionar-todos-historico').checked = false;
      atualizarBotaoExcluirSelecionadosHistorico();
    }
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = pedidos.map((p) => (ehCancelados ? linhaPedidoCanceladoHtml(p, moeda) : linhaPedidoFinalizadoHtml(p, moeda))).join('');

  corpo.querySelectorAll('[data-acao="ver-detalhes"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalhePedidoHistorico(botao.dataset.id));
  });

  if (!ehCancelados) {
    corpo.querySelectorAll('[data-acao="excluir"]').forEach((botao) => {
      botao.addEventListener('click', () => excluirPedidoHistoricoComConfirmacao(botao.dataset.id));
    });
    corpo.querySelectorAll('.checkbox-pedido-historico').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) pedidosSelecionadosHistorico.add(checkbox.dataset.id);
        else pedidosSelecionadosHistorico.delete(checkbox.dataset.id);
        atualizarBotaoExcluirSelecionadosHistorico();
      });
    });
    atualizarBotaoExcluirSelecionadosHistorico();
  }
}

/** Recria o <thead> conforme a aba ativa — colunas diferentes pra Finalizados (com seleção/exclusão) e Cancelados (sem nenhuma das duas) */
function renderizarCabecalhoTabelaHistorico(ehCancelados) {
  const cabecalho = document.getElementById('cabecalho-tabela-historico');
  // historico.css estiliza as colunas por posição, e as posições diferem entre as abas
  cabecalho.closest('table').dataset.aba = ehCancelados ? 'cancelado' : 'finalizado';
  cabecalho.innerHTML = ehCancelados
    ? `<tr>
        <th>Pedido</th>
        <th>Cliente</th>
        <th>Tipo</th>
        <th>Total</th>
        <th>Cancelado em</th>
        <th>Motivo</th>
        <th></th>
      </tr>`
    : `<tr>
        <th><input type="checkbox" id="checkbox-selecionar-todos-historico" aria-label="Selecionar todos" /></th>
        <th>Pedido</th>
        <th>Cliente</th>
        <th>Data</th>
        <th>Total</th>
        <th>Status</th>
        <th></th>
      </tr>`;

  // O checkbox "selecionar todos" é recriado a cada troca de aba (thead é regenerado) — precisa religar aqui.
  if (!ehCancelados) {
    document.getElementById('checkbox-selecionar-todos-historico').addEventListener('change', (evento) => {
      const marcado = evento.target.checked;
      document.querySelectorAll('.checkbox-pedido-historico').forEach((checkbox) => {
        checkbox.checked = marcado;
        if (marcado) pedidosSelecionadosHistorico.add(checkbox.dataset.id);
        else pedidosSelecionadosHistorico.delete(checkbox.dataset.id);
      });
      atualizarBotaoExcluirSelecionadosHistorico();
    });
  }
}

/** Linha da aba Cancelados — total é histórico/informativo (já excluído do Dashboard), sem checkbox nem botão de excluir (item 8) */
const ROTULOS_TIPO_HISTORICO = { entrega: 'Entrega', comer_no_local: 'Comer no local', retirada: 'Retirada' };

/** Número do pedido + selo do canal (só Deliveroo/Just Eat; Larica fica sem selo). */
function celulaNumeroPedidoHistoricoHtml(pedido) {
  const canal = canalVendaDoPedido(pedido.canal);
  const selo = canal === 'larica' ? '' : ` <span class="selo-canal-venda selo-canal-${canal}">${escaparHtml(rotuloCanalVenda(canal))}</span>`;
  return escaparHtml(pedido.numero) + selo;
}

function linhaPedidoCanceladoHtml(pedido, moeda) {
  const tipoRotulo = ROTULOS_TIPO_HISTORICO[pedido.fulfilment] || 'Retirada';
  return `
    <tr>
      <td>${celulaNumeroPedidoHistoricoHtml(pedido)}</td>
      <td>${celulaClienteHistoricoHtml(pedido)}</td>
      <td>${escaparHtml(tipoRotulo)}</td>
      <td>${formatarMoeda(pedido.total, moeda)}</td>
      <td>${escaparHtml(formatarData(pedido.canceladoEm))} ${escaparHtml(formatarHora(pedido.canceladoEm))}</td>
      <td>${escaparHtml(pedido.motivoCancelamento || '—')}</td>
      <td>
        <div class="acoes-linha">
          <button class="btn btn-secundario" data-acao="ver-detalhes" data-id="${pedido.id}">Ver detalhes</button>
        </div>
      </td>
    </tr>`;
}

/**
 * Nome do cliente nas duas abas — "Não informado" sem nome; link pra ficha só pra admin. O link leva o
 * id do pedido (nunca o telefone): a ficha resolve o cliente no banco (get_customer_detail).
 */
function celulaClienteHistoricoHtml(pedido) {
  const nome = ((pedido.cliente || {}).nome || '').trim();
  if (!nome) return '<span class="cliente-nao-informado">Não informado</span>';
  if (!historicoUsuarioEhAdmin) return escaparHtml(nome);
  return `<a class="link-cliente-historico" href="clientes.html?pedido=${encodeURIComponent(pedido.id)}" title="Ver ficha do cliente">${escaparHtml(nome)}</a>`;
}

// Data da aba Finalizados = criação do pedido (created_at), nunca a finalização — completed_at continua
// no banco/objeto (finalizadoEm) para outras telas. Fuso fixo do restaurante via Intl (GMT/IST tratados
// sozinhos), independente do fuso do navegador; formatarData/formatarHora (utils.js) não são usadas aqui
// porque seguem o fuso do dispositivo.
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

/**
 * Mais recentes primeiro pela criação real (timestamp, nunca o texto formatado). Empate: número do
 * pedido (sequencial), maior primeiro. Pedidos sem criação válida vão para o fim.
 */
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

function linhaPedidoFinalizadoHtml(pedido, moeda) {
  const marcado = pedidosSelecionadosHistorico.has(pedido.id);
  return `
    <tr>
      <td><input type="checkbox" class="checkbox-pedido-historico" data-id="${pedido.id}" ${marcado ? 'checked' : ''} /></td>
      <td>${celulaNumeroPedidoHistoricoHtml(pedido)}</td>
      <td>${celulaClienteHistoricoHtml(pedido)}</td>
      <td>${escaparHtml(formatarDataHoraCriacaoHistorico(pedido.criadoEm))}</td>
      <td>${formatarMoeda(pedido.total, moeda)}</td>
      <td><span class="badge badge-cinza">${escaparHtml(ROTULOS_STATUS_PEDIDO[pedido.status] || pedido.status)}</span></td>
      <td>
        <div class="acoes-linha">
          <button class="btn btn-secundario" data-acao="ver-detalhes" data-id="${pedido.id}">Ver detalhes</button>
          <button class="btn-icone" data-acao="excluir" data-id="${pedido.id}" title="Excluir pedido">🗑️</button>
        </div>
      </td>
    </tr>`;
}

function atualizarBotaoExcluirSelecionadosHistorico() {
  const botao = document.getElementById('botao-excluir-selecionados-historico');
  const total = pedidosSelecionadosHistorico.size;
  botao.style.display = total > 0 ? '' : 'none';
  botao.textContent = `Excluir selecionados (${total})`;
}

function ligarEventosPedidosFinalizados() {
  // checkbox-selecionar-todos-historico é religado a cada render em renderizarCabecalhoTabelaHistorico()
  // (o <thead> é recriado a cada troca de aba, então o elemento em si muda).
  document.getElementById('botao-excluir-selecionados-historico').addEventListener('click', excluirSelecionadosHistoricoComConfirmacao);
  document.getElementById('botao-limpar-historico').addEventListener('click', limparHistoricoPedidosComConfirmacao);
}

function excluirPedidoHistoricoComConfirmacao(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido) return;
  abrirConfirmacaoExclusaoHistorico({
    titulo: 'Excluir este pedido?',
    mensagem: 'Esta ação removerá o pedido do histórico.',
    rotuloBotao: 'Excluir pedido',
    aoConfirmar: async () => {
      try {
        await removerPedidoCliente(id);
      } catch (erro) {
        mostrarToast('Não foi possível excluir o pedido. ' + erro.message, 'erro');
        return;
      }
      pedidosSelecionadosHistorico.delete(id);
      mostrarToast('Pedido excluído do histórico.', 'sucesso');
      renderizarPedidosFinalizados();
    },
  });
}

function excluirSelecionadosHistoricoComConfirmacao() {
  const ids = Array.from(pedidosSelecionadosHistorico);
  if (ids.length === 0) return;
  abrirConfirmacaoExclusaoHistorico({
    titulo: `Excluir ${ids.length} ${ids.length === 1 ? 'pedido' : 'pedidos'}?`,
    mensagem: `Deseja excluir os ${ids.length} pedidos selecionados?`,
    rotuloBotao: 'Excluir pedidos',
    aoConfirmar: async () => {
      try {
        await removerPedidosClientes(ids);
      } catch (erro) {
        mostrarToast('Não foi possível excluir os pedidos. ' + erro.message, 'erro');
        return;
      }
      pedidosSelecionadosHistorico.clear();
      mostrarToast('Pedidos excluídos do histórico.', 'sucesso');
      renderizarPedidosFinalizados();
    },
  });
}

function limparHistoricoPedidosComConfirmacao() {
  if (obterPedidosClientes().filter((p) => p.status === STATUS_PEDIDO.FINALIZADO).length === 0) return;
  abrirConfirmacaoExclusaoHistorico({
    titulo: 'Tem certeza que deseja excluir todos os pedidos do histórico?',
    mensagem: 'Esta ação não poderá ser desfeita.',
    rotuloBotao: 'Excluir todos',
    aoConfirmar: async () => {
      try {
        await limparPedidosFinalizados();
      } catch (erro) {
        mostrarToast('Não foi possível limpar o histórico. ' + erro.message, 'erro');
        return;
      }
      pedidosSelecionadosHistorico.clear();
      mostrarToast('Histórico de pedidos limpo.', 'sucesso');
      renderizarPedidosFinalizados();
    },
  });
}

// ---------------------------------------------------------------------------
// Modal de confirmação de exclusão (reaproveitado pelos 3 casos acima e pelo modal de detalhes)
// ---------------------------------------------------------------------------

function abrirConfirmacaoExclusaoHistorico({ titulo, mensagem, rotuloBotao, aoConfirmar }) {
  document.getElementById('confirmar-exclusao-titulo').textContent = titulo;
  document.getElementById('confirmar-exclusao-mensagem').textContent = mensagem;
  document.getElementById('botao-confirmar-exclusao').textContent = rotuloBotao;
  acaoPendenteExclusaoHistorico = aoConfirmar;
  document.getElementById('modal-overlay-confirmar-exclusao').classList.add('modal-visivel');
}

function fecharConfirmacaoExclusaoHistorico() {
  document.getElementById('modal-overlay-confirmar-exclusao').classList.remove('modal-visivel');
  acaoPendenteExclusaoHistorico = null;
}

function ligarEventosConfirmacaoExclusaoHistorico() {
  document.getElementById('botao-cancelar-exclusao').addEventListener('click', fecharConfirmacaoExclusaoHistorico);
  document.getElementById('botao-fechar-modal-confirmar-exclusao').addEventListener('click', fecharConfirmacaoExclusaoHistorico);
  document.getElementById('modal-overlay-confirmar-exclusao').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-confirmar-exclusao') fecharConfirmacaoExclusaoHistorico();
  });
  document.getElementById('botao-confirmar-exclusao').addEventListener('click', () => {
    const acao = acaoPendenteExclusaoHistorico;
    fecharConfirmacaoExclusaoHistorico();
    if (acao) acao();
  });
}

// ---------------------------------------------------------------------------
// Modal "Ver detalhes" de um pedido finalizado
// ---------------------------------------------------------------------------

let idPedidoDetalheHistoricoAtual = null;

function ligarEventosModalDetalhePedidoHistorico() {
  document.getElementById('botao-fechar-modal-detalhe-historico').addEventListener('click', fecharModalDetalhePedidoHistorico);
  document.getElementById('botao-fechar-modal-detalhe-historico-rodape').addEventListener('click', fecharModalDetalhePedidoHistorico);
  document.getElementById('modal-overlay-detalhe-pedido-historico').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-detalhe-pedido-historico') fecharModalDetalhePedidoHistorico();
  });
  document.getElementById('botao-excluir-pedido-detalhe-historico').addEventListener('click', () => {
    if (!idPedidoDetalheHistoricoAtual) return;
    const id = idPedidoDetalheHistoricoAtual;
    abrirConfirmacaoExclusaoHistorico({
      titulo: 'Excluir este pedido?',
      mensagem: 'Esta ação removerá o pedido do histórico.',
      rotuloBotao: 'Excluir pedido',
      aoConfirmar: async () => {
        try {
          await removerPedidoCliente(id);
        } catch (erro) {
          mostrarToast('Não foi possível excluir o pedido. ' + erro.message, 'erro');
          return;
        }
        pedidosSelecionadosHistorico.delete(id);
        fecharModalDetalhePedidoHistorico();
        mostrarToast('Pedido excluído do histórico.', 'sucesso');
        renderizarPedidosFinalizados();
      },
    });
  });
}

function fecharModalDetalhePedidoHistorico() {
  document.getElementById('modal-overlay-detalhe-pedido-historico').classList.remove('modal-visivel');
  idPedidoDetalheHistoricoAtual = null;
}

function abrirModalDetalhePedidoHistorico(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido) return;
  idPedidoDetalheHistoricoAtual = id;

  const moeda = obterConfiguracoes().moeda;
  const cliente = pedido.cliente || {};
  const endereco = pedido.endereco || {};
  const ehEntrega = pedido.fulfilment === 'entrega';
  const ehComerNoLocal = pedido.fulfilment === 'comer_no_local';
  const ehCancelado = pedido.status === STATUS_PEDIDO.CANCELADO;

  // Pedido cancelado não pode ser excluído por aqui (item 8 — mantém rastreabilidade do estorno de estoque)
  document.getElementById('botao-excluir-pedido-detalhe-historico').style.display = ehCancelado ? 'none' : '';

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
