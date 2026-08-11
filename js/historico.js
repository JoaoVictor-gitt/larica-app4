/*
 * historico.js
 * Pedidos finalizados (área Fazer Pedido, Supabase via
 * carregarPedidosClientesCache()/obterPedidosClientes()) — listar, ver
 * detalhes, excluir individual/em massa/total. Só mexe em status
 * "finalizado"; nunca toca em pedidos Solicitado/Em Preparo/Pronto (esses
 * pertencem ao painel operacional em pedidos.html).
 * Depende de storage.js e utils.js.
 */

let pedidosSelecionadosHistorico = new Set();
let acaoPendenteExclusaoHistorico = null;

document.addEventListener('DOMContentLoaded', async () => {
  const carregando = document.getElementById('estado-carregando-pedidos-finalizados');
  const erro = document.getElementById('estado-erro-pedidos-finalizados');
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

  renderizarPedidosFinalizados();
  ligarEventosPedidosFinalizados();
  ligarEventosConfirmacaoExclusaoHistorico();
  ligarEventosModalDetalhePedidoHistorico();
});

// ---------------------------------------------------------------------------
// Pedidos finalizados (área Fazer Pedido) — listar, selecionar, excluir
// ---------------------------------------------------------------------------

function renderizarPedidosFinalizados() {
  const pedidos = obterPedidosClientes()
    .filter((p) => p.status === STATUS_PEDIDO.FINALIZADO)
    .sort((a, b) => new Date(b.finalizadoEm || b.criadoEm) - new Date(a.finalizadoEm || a.criadoEm));

  const corpo = document.getElementById('corpo-tabela-pedidos-finalizados');
  const vazio = document.getElementById('estado-vazio-pedidos-finalizados');

  if (pedidos.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    document.getElementById('checkbox-selecionar-todos-historico').checked = false;
    atualizarBotaoExcluirSelecionadosHistorico();
    return;
  }
  vazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  corpo.innerHTML = pedidos.map((p) => linhaPedidoFinalizadoHtml(p, moeda)).join('');

  corpo.querySelectorAll('[data-acao="ver-detalhes"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalDetalhePedidoHistorico(botao.dataset.id));
  });
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

function linhaPedidoFinalizadoHtml(pedido, moeda) {
  const marcado = pedidosSelecionadosHistorico.has(pedido.id);
  return `
    <tr>
      <td><input type="checkbox" class="checkbox-pedido-historico" data-id="${pedido.id}" ${marcado ? 'checked' : ''} /></td>
      <td>${escaparHtml(pedido.numero)}</td>
      <td>${formatarData(pedido.finalizadoEm || pedido.criadoEm)}</td>
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
  document.getElementById('checkbox-selecionar-todos-historico').addEventListener('change', (evento) => {
    const marcado = evento.target.checked;
    document.querySelectorAll('.checkbox-pedido-historico').forEach((checkbox) => {
      checkbox.checked = marcado;
      if (marcado) pedidosSelecionadosHistorico.add(checkbox.dataset.id);
      else pedidosSelecionadosHistorico.delete(checkbox.dataset.id);
    });
    atualizarBotaoExcluirSelecionadosHistorico();
  });

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

  document.getElementById('detalhe-pedido-historico-titulo').textContent = pedido.numero;

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

  document.getElementById('detalhe-pedido-historico-corpo').innerHTML = `
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Pedido</div>
      <p>Data: ${formatarData(pedido.criadoEm)} · Horário: ${formatarHora(pedido.criadoEm)}</p>
      <p>Status: <span class="badge badge-cinza">${escaparHtml(ROTULOS_STATUS_PEDIDO[pedido.status] || pedido.status)}</span></p>
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Cliente</div>
      <p>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</p>
    </div>
    ${blocoTipo}
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
