/*
 * pedido.js
 * Área de pedidos completa para o cliente: cardápio -> carrinho -> retirada
 * ou entrega -> dados do cliente/endereço -> forma de pagamento -> revisão
 * -> confirmação. Tudo simulado em front-end (sem backend/API/pagamento
 * real), reaproveitando as mesmas funções de carrinho/produtos de
 * storage.js. Depende de utils.js, storage.js e app.js (carregados antes
 * deste).
 *
 * Formas dos dados usados neste fluxo (documentação, sem TypeScript — o
 * projeto não usa build step):
 *   Product          -> mesmo shape de obterProdutos() (storage.js)
 *   Combo             -> um produto (categoria "Combos") com `comboConfig`
 *                        preenchido: { ordem, allowedSkewers, allowedSides,
 *                        includedItems: [produtoId...], skewerExtraPrices:
 *                        { produtoId: valor } }
 *   CartItem          -> mesmo shape de obterCarrinho() (storage.js); quando
 *                        é um combo, ganha um `itemId` próprio e um campo
 *                        `combo` com a composição escolhida (ver
 *                        montarComposicaoCombo())
 *   Customer          -> { nome, telefone }
 *   DeliveryAddress   -> { eircode, linha1, linha2, area, distrito, instrucoes }
 *   PaymentMethod     -> 'cartao' | 'dinheiro' | 'revolut'
 *   CashPaymentInfo   -> { precisaTroco, valorPago, troco } — só quando
 *                        formaPagamento === 'dinheiro'; ponto único a trocar
 *                        futuramente por uma integração real (ex.: Revolut)
 *   FulfilmentType    -> 'retirada' | 'entrega'
 *   Order             -> { itens, fulfilment, cliente, retirada, endereco,
 *                          formaPagamento, pagamentoDinheiro, subtotal,
 *                          taxaEntrega, total }
 */

const CHAVE_PEDIDO_EM_ANDAMENTO = 'caju_pedido_em_andamento';

const ROTULOS_ETAPA_PEDIDO = {
  cardapio: 'Cardápio',
  carrinho: 'Carrinho',
  recebimento: 'Retirada ou entrega',
  'dados-retirada': 'Seus dados',
  'dados-entrega': 'Seus dados e endereço',
  pagamento: 'Forma de pagamento',
  revisao: 'Revisar pedido',
  confirmacao: 'Confirmação',
};

const ORDEM_CATEGORIAS_PEDIDO = ['Combos', 'Espetinhos', 'Acompanhamentos', 'Bebidas'];
let categoriaSelecionadaPedido = 'Combos';
let pilhaEtapasPedido = ['cardapio'];
let estadoPedido = estadoPedidoInicial();
let ultimoPedidoConfirmado = null;

// Estado do modal de personalização de combo (ver seção "Modal de combo" mais abaixo)
let comboAtual = null; // registro de storage.js sendo personalizado
let comboEmEdicaoItemId = null; // itemId do carrinho, se estiver editando um combo já adicionado
let comboEspetosEscolhidos = []; // [{ id, nome, quantidade, acrescimoUnitario }]
let comboAcompanhamentosEscolhidos = []; // [{ id, nome, quantidade, acrescimoUnitario: 0 }]

function estadoPedidoInicial() {
  return {
    fulfilment: '',
    cliente: { nome: '', telefone: '' },
    retirada: { horario: 'Assim que possível' },
    endereco: { eircode: '', linha1: '', linha2: '', area: '', distrito: '', instrucoes: '' },
    formaPagamento: '',
    dinheiro: null, // { precisaTroco, valorPago, troco } — só quando formaPagamento === 'dinheiro'
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  carregarEstadoPersistido();

  const carregando = document.getElementById('estado-carregando-pedido');
  const erro = document.getElementById('estado-erro-pedido');
  try {
    await carregarProdutosCache();
  } catch (erroCarregamento) {
    console.error('Erro ao carregar produtos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  renderizarFiltroCategoriasPedido();
  renderizarGradePedido();
  renderizarCarrinhoPedido(); // garante a tabela preenchida mesmo se a etapa restaurada não for 'cardapio'
  if (etapaAtualPedido() === 'revisao') renderizarRevisao();
  atualizarBarraCarrinhoFixa();
  mostrarEtapaAtual();
  ligarEventosGerais();
});

// ---------------------------------------------------------------------------
// Persistência local do progresso (não perder dados preenchidos ao atualizar)
// ---------------------------------------------------------------------------

function salvarProgressoPedido() {
  try {
    localStorage.setItem(CHAVE_PEDIDO_EM_ANDAMENTO, JSON.stringify({ pilhaEtapasPedido, estadoPedido }));
  } catch (erro) {}
}

function carregarEstadoPersistido() {
  try {
    const bruto = localStorage.getItem(CHAVE_PEDIDO_EM_ANDAMENTO);
    if (!bruto) return;
    const salvo = JSON.parse(bruto);
    if (salvo && Array.isArray(salvo.pilhaEtapasPedido) && salvo.pilhaEtapasPedido.length > 0) {
      pilhaEtapasPedido = salvo.pilhaEtapasPedido;
      estadoPedido = { ...estadoPedidoInicial(), ...salvo.estadoPedido };
      preencherCamposComEstado();
    }
  } catch (erro) {}
}

/** Preenche os campos de formulário com o que já estava salvo em estadoPedido */
function preencherCamposComEstado() {
  document.getElementById('retirada-nome').value = estadoPedido.cliente.nome || '';
  document.getElementById('retirada-telefone').value = estadoPedido.cliente.telefone || '';
  document.getElementById('retirada-horario').value = estadoPedido.retirada.horario || 'Assim que possível';

  document.getElementById('entrega-nome').value = estadoPedido.cliente.nome || '';
  document.getElementById('entrega-telefone').value = estadoPedido.cliente.telefone || '';
  document.getElementById('entrega-eircode').value = estadoPedido.endereco.eircode || '';
  document.getElementById('entrega-linha1').value = estadoPedido.endereco.linha1 || '';
  document.getElementById('entrega-linha2').value = estadoPedido.endereco.linha2 || '';
  document.getElementById('entrega-area').value = estadoPedido.endereco.area || '';
  document.getElementById('entrega-distrito').value = estadoPedido.endereco.distrito || '';
  document.getElementById('entrega-instrucoes').value = estadoPedido.endereco.instrucoes || '';

  if (estadoPedido.fulfilment) {
    document.querySelectorAll('.opcoes-recebimento .opcao-pagamento').forEach((botao) => {
      botao.classList.toggle('selecionada', botao.dataset.fulfilment === estadoPedido.fulfilment);
    });
    document.getElementById('botao-continuar-recebimento').disabled = false;
  }

  if (estadoPedido.formaPagamento) {
    document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((botao) => {
      botao.classList.toggle('selecionada', botao.dataset.forma === estadoPedido.formaPagamento);
    });
    atualizarVisibilidadeSecaoTroco();

    if (estadoPedido.formaPagamento === 'dinheiro' && estadoPedido.dinheiro) {
      document.querySelectorAll('.opcao-troco').forEach((botao) => {
        botao.classList.toggle('selecionada', (botao.dataset.troco === 'sim') === estadoPedido.dinheiro.precisaTroco);
      });
      if (estadoPedido.dinheiro.precisaTroco) {
        document.getElementById('grupo-valor-troco').style.display = '';
        if (estadoPedido.dinheiro.valorPago != null) {
          document.getElementById('campo-valor-pago').value = estadoPedido.dinheiro.valorPago;
          recalcularTroco();
        }
      }
    }

    document.getElementById('botao-continuar-pagamento').disabled = !pagamentoEstaCompleto();
  }
}

// ---------------------------------------------------------------------------
// Navegação entre etapas
// ---------------------------------------------------------------------------

function etapaAtualPedido() {
  return pilhaEtapasPedido[pilhaEtapasPedido.length - 1];
}

function irParaEtapaPedido(etapa) {
  pilhaEtapasPedido.push(etapa);
  mostrarEtapaAtual();
  salvarProgressoPedido();
}

function voltarEtapaPedido() {
  if (pilhaEtapasPedido.length <= 1) return;
  pilhaEtapasPedido.pop();
  mostrarEtapaAtual();
  salvarProgressoPedido();
}

function mostrarEtapaAtual() {
  const etapa = etapaAtualPedido();
  document.querySelectorAll('.etapa-pedido').forEach((secao) => {
    secao.classList.toggle('etapa-ativa', secao.dataset.etapa === etapa);
  });
  document.getElementById('indicador-etapa-pedido').textContent =
    `Etapa ${pilhaEtapasPedido.length} · ${ROTULOS_ETAPA_PEDIDO[etapa] || ''}`;
  atualizarBarraCarrinhoFixa();
  window.scrollTo(0, 0);
}

function ligarEventosGerais() {
  document.querySelectorAll('[data-acao="voltar"]').forEach((botao) => {
    botao.addEventListener('click', voltarEtapaPedido);
  });

  document.getElementById('botao-ver-carrinho').addEventListener('click', () => {
    renderizarCarrinhoPedido();
    irParaEtapaPedido('carrinho');
  });

  document.getElementById('botao-continuar-carrinho').addEventListener('click', () => {
    if (obterCarrinho().length === 0) return;
    irParaEtapaPedido('recebimento');
  });

  ligarEventosRecebimento();
  ligarEventosDadosRetirada();
  ligarEventosDadosEntrega();
  ligarEventosPagamento();
  ligarEventosModalCombo();
  document.getElementById('botao-confirmar-pedido').addEventListener('click', confirmarPedido);
  document.getElementById('botao-novo-pedido').addEventListener('click', reiniciarPedido);
}

// ---------------------------------------------------------------------------
// Etapa 1: Cardápio
// ---------------------------------------------------------------------------

/**
 * Monta os botões de categoria na ordem fixa ORDEM_CATEGORIAS_PEDIDO
 * (Combos, Espetinhos, Acompanhamentos, Bebidas); qualquer outra categoria
 * em uso (ex.: Sobremesas, Molhos) aparece depois, em ordem alfabética.
 * Sem opção "Todas" — o cliente navega só por categoria.
 */
function renderizarFiltroCategoriasPedido() {
  const categoriasAtivas = Array.from(new Set(obterProdutos().filter((p) => p.status === 'ativo').map((p) => p.categoria)));
  const prioritarias = ORDEM_CATEGORIAS_PEDIDO.filter((c) => categoriasAtivas.includes(c));
  const restantes = categoriasAtivas.filter((c) => !ORDEM_CATEGORIAS_PEDIDO.includes(c)).sort((a, b) => a.localeCompare(b));
  const categorias = prioritarias.concat(restantes);

  // Se a categoria selecionada não existe mais (ex.: admin desativou todos os combos), cai pra primeira disponível.
  if (categorias.length > 0 && !categorias.includes(categoriaSelecionadaPedido)) {
    categoriaSelecionadaPedido = categorias[0];
  }

  const container = document.getElementById('filtro-categorias-pedido');
  container.innerHTML = categorias
    .map(
      (c) =>
        `<button class="filtro-categoria-botao ${c === categoriaSelecionadaPedido ? 'ativo' : ''}" data-categoria="${escaparHtml(c)}">${escaparHtml(c)}</button>`
    )
    .join('');

  container.querySelectorAll('.filtro-categoria-botao').forEach((botao) => {
    botao.addEventListener('click', () => {
      categoriaSelecionadaPedido = botao.dataset.categoria;
      container.querySelectorAll('.filtro-categoria-botao').forEach((b) => b.classList.remove('ativo'));
      botao.classList.add('ativo');
      renderizarGradePedido();
    });
  });
}

function renderizarGradePedido() {
  let itens = pesquisarProdutos({ categoria: categoriaSelecionadaPedido, status: 'ativo' });
  // Combos têm um "ordem de exibição" próprio (definido em Produtos) — só faz
  // sentido aplicar esse critério quando o filtro está especificamente em Combos.
  if (categoriaSelecionadaPedido === 'Combos') {
    itens = itens.slice().sort((a, b) => ((a.comboConfig || {}).ordem || 0) - ((b.comboConfig || {}).ordem || 0));
  }

  const grade = document.getElementById('grade-pedido');
  const estadoVazio = document.getElementById('estado-vazio-pedido');

  if (itens.length === 0) {
    grade.innerHTML = '';
    estadoVazio.style.display = 'block';
    return;
  }
  estadoVazio.style.display = 'none';

  const moeda = obterConfiguracoes().moeda;
  grade.innerHTML = itens.map((item) => (item.comboConfig ? cardComboPedidoHtml(item, moeda) : cardProdutoPedidoHtml(item, moeda))).join('');

  grade.querySelectorAll('[data-acao="adicionar"]').forEach((botao) => {
    botao.addEventListener('click', () => adicionarProdutoAoPedido(botao.dataset.id));
  });
  grade.querySelectorAll('[data-acao="personalizar-combo"]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalCombo(botao.dataset.id));
  });
}

function cardProdutoPedidoHtml(produto, moeda) {
  const esgotado = produto.quantidadeEstoque <= 0;

  const foto = produto.foto
    ? `<img src="${produto.foto}" alt="${escaparHtml(produto.nome)}" />`
    : `<div class="card-produto-foto-vazia">🍢</div>`;

  return `
    <div class="card-produto">
      <div class="card-produto-foto-wrap">
        ${foto}
        <span class="card-produto-categoria">${escaparHtml(produto.categoria)}</span>
        ${esgotado ? '<div class="selo-esgotado">ESGOTADO</div>' : ''}
      </div>
      <div class="card-produto-corpo">
        <div class="card-produto-nome">${escaparHtml(produto.nome)}</div>
        <div class="card-produto-descricao">${escaparHtml(produto.descricao || '')}</div>
        <div class="card-produto-rodape">
          <span class="card-produto-preco">${formatarMoeda(produto.preco, moeda)}</span>
          <span class="card-produto-estoque">${esgotado ? 'Indisponível' : produto.quantidadeEstoque + ' disponíveis'}</span>
        </div>
        <div class="card-produto-acao">
          <input type="number" class="seletor-quantidade" id="pedido-qtd-${produto.id}" min="1" max="${produto.quantidadeEstoque}" value="1" ${esgotado ? 'disabled' : ''} />
          <button class="btn btn-primario botao-adicionar" data-acao="adicionar" data-id="${produto.id}" ${esgotado ? 'disabled' : ''}>
            ${esgotado ? 'Esgotado' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>`;
}

function cardComboPedidoHtml(combo, moeda) {
  const foto = combo.foto
    ? `<img src="${combo.foto}" alt="${escaparHtml(combo.nome)}" />`
    : `<div class="card-produto-foto-vazia">🍽️</div>`;

  const inclusos = itensInclusosDisponiveisCombo((combo.comboConfig || {}).includedItems);
  const avisoInclusos = inclusos.temIndisponivel
    ? '<div class="aviso-card-combo">Alguns itens inclusos deste combo estão temporariamente indisponíveis.</div>'
    : '';

  return `
    <div class="card-produto">
      <div class="card-produto-foto-wrap">
        ${foto}
        <span class="card-produto-categoria">Combos</span>
      </div>
      <div class="card-produto-corpo">
        <div class="card-produto-nome">${escaparHtml(combo.nome)}</div>
        <div class="card-produto-descricao">${escaparHtml(combo.descricao || '')}</div>
        ${avisoInclusos}
        <div class="card-produto-rodape">
          <span class="card-produto-preco">A partir de ${formatarMoeda(combo.preco, moeda)}</span>
        </div>
        <div class="card-produto-acao">
          <button class="btn btn-primario botao-adicionar" data-acao="personalizar-combo" data-id="${combo.id}">
            Personalizar
          </button>
        </div>
      </div>
    </div>`;
}

function adicionarProdutoAoPedido(produtoId) {
  const produto = obterProdutoPorId(produtoId);
  if (!produto) return;

  const campoQtd = document.getElementById('pedido-qtd-' + produtoId);
  let quantidade = Math.floor(Number(campoQtd.value)) || 1;
  quantidade = Math.max(1, Math.min(quantidade, produto.quantidadeEstoque));

  adicionarAoCarrinho(produtoId, quantidade);
  atualizarContadorCarrinho();
  atualizarBarraCarrinhoFixa();
  mostrarToast(`${quantidade}x ${produto.nome} adicionado ao pedido.`, 'sucesso');
}

/** Barra fixa inferior "Ver carrinho • N itens • €X" — só existe nesta área */
function atualizarBarraCarrinhoFixa() {
  const barra = document.getElementById('barra-carrinho-fixa');
  const carrinho = obterCarrinho();
  const totalItens = carrinho.reduce((soma, item) => soma + item.quantidade, 0);

  if (totalItens === 0 || etapaAtualPedido() !== 'cardapio') {
    barra.style.display = 'none';
    return;
  }

  const config = obterConfiguracoes();
  const subtotal = calcularSubtotalCarrinho(carrinho);
  document.getElementById('botao-ver-carrinho').textContent =
    `Ver carrinho • ${totalItens} ${totalItens === 1 ? 'item' : 'itens'} • ${formatarMoeda(subtotal, config.moeda)}`;
  barra.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Etapa 2: Carrinho
// ---------------------------------------------------------------------------

function renderizarCarrinhoPedido() {
  const carrinho = obterCarrinho();
  const config = obterConfiguracoes();

  const corpo = document.getElementById('corpo-tabela-pedido-carrinho');
  const estadoVazio = document.getElementById('estado-vazio-pedido-carrinho');
  const botaoContinuar = document.getElementById('botao-continuar-carrinho');

  if (carrinho.length === 0) {
    corpo.innerHTML = '';
    estadoVazio.style.display = 'block';
    botaoContinuar.disabled = true;
  } else {
    estadoVazio.style.display = 'none';
    botaoContinuar.disabled = false;
    corpo.innerHTML = carrinho
      .map((item) => (item.combo ? linhaComboCarrinhoHtml(item, config.moeda) : linhaCarrinhoPedidoHtml(item, config.moeda)))
      .join('');
    ligarEventosLinhasPedido();
  }

  const subtotal = calcularSubtotalCarrinho(carrinho);
  document.getElementById('pedido-valor-subtotal').textContent = formatarMoeda(subtotal, config.moeda);
  document.getElementById('pedido-valor-total').textContent = formatarMoeda(subtotal, config.moeda);
  document.getElementById('pedido-valor-taxa').textContent = 'A definir na próxima etapa';
}

function linhaCarrinhoPedidoHtml(item, moeda) {
  const produto = obterProdutoPorId(item.produtoId);
  const nome = produto ? produto.nome : '(produto removido)';
  const estoqueMaximo = produto ? produto.quantidadeEstoque : item.quantidade;
  const foto = produto && produto.foto
    ? `<img class="miniatura-carrinho" src="${produto.foto}" alt="${escaparHtml(nome)}" />`
    : `<div class="miniatura-carrinho-vazia">🍢</div>`;
  const subtotalItem = item.precoUnitario * item.quantidade;

  return `
    <tr>
      <td>${foto}</td>
      <td>${escaparHtml(nome)}</td>
      <td>${formatarMoeda(item.precoUnitario, moeda)}</td>
      <td>
        <input type="number" class="quantidade-pedido-carrinho" data-id="${item.produtoId}"
          min="1" max="${Math.max(1, estoqueMaximo)}" value="${item.quantidade}" />
      </td>
      <td>${formatarMoeda(subtotalItem, moeda)}</td>
      <td><button class="btn-icone" data-acao="remover-pedido" data-id="${item.produtoId}" title="Remover">🗑️</button></td>
    </tr>`;
}

/** Linha de carrinho para um combo personalizado — não usa qtd/subtotal em coluna, mostra a composição completa */
function linhaComboCarrinhoHtml(item, moeda) {
  const c = item.combo;
  const linhasEspetos = (c.espetos || [])
    .map(
      (e) =>
        `<li>${e.quantidade}x ${escaparHtml(e.nome)}${e.acrescimoUnitario > 0 ? ` (+${formatarMoeda(e.acrescimoUnitario * e.quantidade, moeda)})` : ''}</li>`
    )
    .join('');
  const linhasAcompanhamentos = (c.acompanhamentos || [])
    .map((a) => `<li>${a.quantidade > 1 ? a.quantidade + 'x ' : ''}${escaparHtml(a.nome)}</li>`)
    .join('');
  const linhasInclusos = (c.incluidos || []).map((i) => `<li>${escaparHtml(i)}</li>`).join('');

  return `
    <tr class="linha-combo-carrinho">
      <td colspan="6">
        <div class="resumo-combo-carrinho">
          <div class="resumo-combo-carrinho-cabecalho">
            <strong>${escaparHtml(c.nome)}</strong>
            <span>${formatarMoeda(item.precoUnitario, moeda)}</span>
          </div>
          ${linhasEspetos ? `<div class="resumo-combo-carrinho-grupo"><span class="resumo-combo-carrinho-rotulo">Espetos</span><ul>${linhasEspetos}</ul></div>` : ''}
          ${linhasAcompanhamentos ? `<div class="resumo-combo-carrinho-grupo"><span class="resumo-combo-carrinho-rotulo">Acompanhamentos</span><ul>${linhasAcompanhamentos}</ul></div>` : ''}
          ${linhasInclusos ? `<div class="resumo-combo-carrinho-grupo"><span class="resumo-combo-carrinho-rotulo">Incluído</span><ul>${linhasInclusos}</ul></div>` : ''}
          <div class="resumo-combo-carrinho-precos">
            <span>Preço base: ${formatarMoeda(c.precoBase, moeda)}</span>
            <span>Extras: ${formatarMoeda(c.extras, moeda)}</span>
          </div>
          <div class="resumo-combo-carrinho-acoes">
            <button type="button" class="btn btn-secundario" data-acao="editar-combo" data-item-id="${item.itemId}">Editar escolhas</button>
            <button type="button" class="btn-icone" data-acao="remover-combo" data-item-id="${item.itemId}" title="Remover">🗑️</button>
          </div>
        </div>
      </td>
    </tr>`;
}

function ligarEventosLinhasPedido() {
  document.querySelectorAll('.quantidade-pedido-carrinho').forEach((campo) => {
    campo.addEventListener('change', () => {
      const maximo = Number(campo.max) || 1;
      let quantidade = Math.floor(Number(campo.value)) || 1;
      quantidade = Math.max(1, Math.min(quantidade, maximo));
      atualizarQuantidadeCarrinho(campo.dataset.id, quantidade);
      atualizarContadorCarrinho();
      renderizarCarrinhoPedido();
    });
  });

  document.querySelectorAll('[data-acao="remover-pedido"]').forEach((botao) => {
    botao.addEventListener('click', () => {
      removerDoCarrinho(botao.dataset.id);
      atualizarContadorCarrinho();
      renderizarCarrinhoPedido();
      mostrarToast('Item removido do pedido.', 'info');
    });
  });

  document.querySelectorAll('[data-acao="editar-combo"]').forEach((botao) => {
    botao.addEventListener('click', () => {
      const item = obterCarrinho().find((i) => i.itemId === botao.dataset.itemId);
      if (!item) return;
      abrirModalCombo(item.produtoId, item.itemId);
    });
  });

  document.querySelectorAll('[data-acao="remover-combo"]').forEach((botao) => {
    botao.addEventListener('click', () => {
      removerItemDoCarrinho(botao.dataset.itemId);
      atualizarContadorCarrinho();
      renderizarCarrinhoPedido();
      mostrarToast('Combo removido do pedido.', 'info');
    });
  });
}

// ---------------------------------------------------------------------------
// Modal de personalização de combo (aberto a partir da grade ou do carrinho)
// ---------------------------------------------------------------------------

/** Lista de espetos disponíveis para escolha dentro de um combo, já com o acréscimo de cada um */
function listaEspetosParaCombo(combo) {
  return pesquisarProdutos({ categoria: 'Espetinhos', status: 'ativo' }).map((p) => ({
    id: p.id,
    nome: p.nome,
    acrescimo: (combo.skewerExtraPrices && combo.skewerExtraPrices[p.id]) || 0,
  }));
}

/**
 * Lista de acompanhamentos disponíveis pra escolha: produtos ativos de
 * categoria "Acompanhamentos" (cadastrados em Produtos), excluindo os que já
 * estão marcados como "incluso" nesse combo (comboConfig.includedItems) —
 * evita duplicar, ex. Farofa/Molho de alho aparecerem também como opção de
 * escolha quando já vêm inclusos.
 */
function listaAcompanhamentosParaCombo(combo) {
  const idsInclusos = new Set((combo && combo.includedItems) || []);
  return pesquisarProdutos({ categoria: 'Acompanhamentos', status: 'ativo' })
    .filter((p) => !idsInclusos.has(p.id))
    .slice()
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map((p) => ({ id: p.id, nome: p.nome, acrescimo: 0 }));
}

/**
 * Resolve os ids de "itens inclusos" (comboConfig.includedItems) para os
 * nomes dos produtos que ainda estão disponíveis (ativos) — um item incluso
 * cujo produto foi desativado/excluído não é mostrado como incluso pro
 * cliente, mas também não é apagado da configuração do combo (isso só se
 * mexe em Produtos). `temIndisponivel` indica se algum foi filtrado, pra
 * mostrar um aviso discreto em vez de simplesmente sumir sem explicação.
 */
function itensInclusosDisponiveisCombo(includedItemsIds) {
  const { disponiveis, indisponiveis } = separarItensInclusosCombo(includedItemsIds, obterProdutos());
  return { nomes: disponiveis.map((p) => p.nome), temIndisponivel: indisponiveis.length > 0 };
}

function abrirModalCombo(produtoId, itemIdParaEditar) {
  const produto = obterProdutoPorId(produtoId);
  if (!produto || !produto.comboConfig) return;

  const combo = { ...produto, ...produto.comboConfig };
  comboAtual = combo;
  comboEmEdicaoItemId = itemIdParaEditar || null;

  if (itemIdParaEditar) {
    const item = obterCarrinho().find((i) => i.itemId === itemIdParaEditar);
    comboEspetosEscolhidos = item && item.combo ? item.combo.espetos.map((e) => ({ id: e.produtoId, nome: e.nome, quantidade: e.quantidade, acrescimoUnitario: e.acrescimoUnitario })) : [];
    comboAcompanhamentosEscolhidos =
      item && item.combo ? item.combo.acompanhamentos.map((a) => ({ id: a.id, nome: a.nome, quantidade: a.quantidade, acrescimoUnitario: 0 })) : [];
  } else {
    comboEspetosEscolhidos = [];
    comboAcompanhamentosEscolhidos = [];
  }

  document.getElementById('combo-modal-nome').textContent = combo.nome;
  document.getElementById('combo-modal-descricao').textContent = combo.descricao || '';
  document.getElementById('combo-titulo-espetos').textContent =
    combo.allowedSkewers === 1 ? 'Escolha seu espeto' : `Escolha ${combo.allowedSkewers} espetos`;
  document.getElementById('combo-titulo-acompanhamentos').textContent =
    combo.allowedSides === 1 ? 'Escolha 1 acompanhamento' : `Escolha ${combo.allowedSides} acompanhamentos`;

  document.getElementById('combo-secao-acompanhamentos').style.display = combo.allowedSides > 0 ? '' : 'none';

  const inclusos = itensInclusosDisponiveisCombo(combo.includedItems);
  const secaoInclusos = document.getElementById('combo-secao-inclusos');
  if (inclusos.nomes.length > 0) {
    secaoInclusos.style.display = '';
    document.getElementById('combo-lista-inclusos').innerHTML = inclusos.nomes.map((nome) => `<li>${escaparHtml(nome)}</li>`).join('');
  } else {
    secaoInclusos.style.display = 'none';
  }
  document.getElementById('combo-aviso-inclusos-indisponiveis').style.display = inclusos.temIndisponivel ? '' : 'none';

  renderizarSeletorEspetosCombo();
  renderizarSeletorAcompanhamentosCombo();
  atualizarTotalCombo();

  document.getElementById('modal-overlay-combo').classList.add('modal-visivel');
}

function fecharModalCombo() {
  document.getElementById('modal-overlay-combo').classList.remove('modal-visivel');
}

function ligarEventosModalCombo() {
  document.getElementById('botao-fechar-modal-combo').addEventListener('click', fecharModalCombo);
  document.getElementById('botao-cancelar-combo').addEventListener('click', fecharModalCombo);
  document.getElementById('modal-overlay-combo').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-combo') fecharModalCombo();
  });
  document.getElementById('botao-adicionar-combo').addEventListener('click', confirmarComboNoCarrinho);
}

/**
 * Monta o HTML de um seletor de itens de combo (espetos ou acompanhamentos):
 * cards de escolha única (tocar seleciona) quando o limite é 1, ou uma lista
 * com contador +/- por item quando o limite é maior que 1 (permite repetir
 * o mesmo item, ex.: 2 Frangos + 2 Picanhas). A mesma função atende os dois
 * grupos e qualquer combo futuro, seja qual for o limite.
 */
function seletorComboItensHtml({ tipo, itens, limite, escolhidos, moeda }) {
  if (limite === 1) {
    return itens
      .map((item) => {
        const selecionado = escolhidos.some((e) => e.id === item.id);
        return `
          <button type="button" class="opcao-pagamento opcao-combo-item ${selecionado ? 'selecionada' : ''}"
            data-acao="selecionar-unico" data-tipo="${tipo}" data-id="${item.id}">
            <span>${escaparHtml(item.nome)}</span>
            ${item.acrescimo > 0 ? `<span class="combo-item-acrescimo">+ ${formatarMoeda(item.acrescimo, moeda)}</span>` : ''}
          </button>`;
      })
      .join('');
  }

  const totalEscolhido = escolhidos.reduce((soma, e) => soma + e.quantidade, 0);
  return itens
    .map((item) => {
      const escolhido = escolhidos.find((e) => e.id === item.id);
      const quantidade = escolhido ? escolhido.quantidade : 0;
      const atingiuLimite = totalEscolhido >= limite;
      return `
        <div class="linha-escolha-combo">
          <div class="linha-escolha-combo-info">
            <span class="linha-escolha-combo-nome">${escaparHtml(item.nome)}</span>
            ${item.acrescimo > 0 ? `<span class="linha-escolha-combo-acrescimo">+ ${formatarMoeda(item.acrescimo, moeda)} cada</span>` : ''}
          </div>
          <div class="stepper-combo">
            <button type="button" class="stepper-combo-botao" data-acao="diminuir" data-tipo="${tipo}" data-id="${item.id}" ${quantidade <= 0 ? 'disabled' : ''}>−</button>
            <span class="stepper-combo-valor">${quantidade}</span>
            <button type="button" class="stepper-combo-botao" data-acao="aumentar" data-tipo="${tipo}" data-id="${item.id}" ${atingiuLimite ? 'disabled' : ''}>+</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderizarSeletorEspetosCombo() {
  const itens = listaEspetosParaCombo(comboAtual);
  const moeda = obterConfiguracoes().moeda;
  document.getElementById('combo-lista-espetos').innerHTML = seletorComboItensHtml({
    tipo: 'espeto',
    itens,
    limite: comboAtual.allowedSkewers,
    escolhidos: comboEspetosEscolhidos,
    moeda,
  });
  ligarEventosSeletorCombo('espeto');
  atualizarContadorEscolhaCombo('espetos', comboEspetosEscolhidos.reduce((s, e) => s + e.quantidade, 0), comboAtual.allowedSkewers);
}

function renderizarSeletorAcompanhamentosCombo() {
  if (comboAtual.allowedSides <= 0) return;
  const itens = listaAcompanhamentosParaCombo(comboAtual);
  const moeda = obterConfiguracoes().moeda;
  document.getElementById('combo-lista-acompanhamentos').innerHTML = seletorComboItensHtml({
    tipo: 'acompanhamento',
    itens,
    limite: comboAtual.allowedSides,
    escolhidos: comboAcompanhamentosEscolhidos,
    moeda,
  });
  ligarEventosSeletorCombo('acompanhamento');
  atualizarContadorEscolhaCombo(
    'acompanhamentos',
    comboAcompanhamentosEscolhidos.reduce((s, a) => s + a.quantidade, 0),
    comboAtual.allowedSides
  );
}

function atualizarContadorEscolhaCombo(grupo, atual, limite) {
  document.getElementById('combo-contador-' + grupo).textContent = `${atual} de ${limite} selecionados`;
}

function ligarEventosSeletorCombo(tipo) {
  const container = document.getElementById(tipo === 'espeto' ? 'combo-lista-espetos' : 'combo-lista-acompanhamentos');

  container.querySelectorAll('[data-acao="selecionar-unico"]').forEach((botao) => {
    botao.addEventListener('click', () => selecionarItemComboUnico(tipo, botao.dataset.id));
  });
  container.querySelectorAll('[data-acao="aumentar"]').forEach((botao) => {
    botao.addEventListener('click', () => alterarQuantidadeItemCombo(tipo, botao.dataset.id, 1));
  });
  container.querySelectorAll('[data-acao="diminuir"]').forEach((botao) => {
    botao.addEventListener('click', () => alterarQuantidadeItemCombo(tipo, botao.dataset.id, -1));
  });
}

function obterListaEscolhidaCombo(tipo) {
  return tipo === 'espeto' ? comboEspetosEscolhidos : comboAcompanhamentosEscolhidos;
}

function obterItensDisponiveisCombo(tipo) {
  return tipo === 'espeto' ? listaEspetosParaCombo(comboAtual) : listaAcompanhamentosParaCombo(comboAtual);
}

function obterLimiteCombo(tipo) {
  return tipo === 'espeto' ? comboAtual.allowedSkewers : comboAtual.allowedSides;
}

/** Escolha única (limite = 1): tocar num item troca a seleção inteira, como as etapas de retirada/entrega */
function selecionarItemComboUnico(tipo, id) {
  const itemInfo = obterItensDisponiveisCombo(tipo).find((i) => i.id === id);
  if (!itemInfo) return;

  const escolha = { id, nome: itemInfo.nome, quantidade: 1, acrescimoUnitario: itemInfo.acrescimo };
  if (tipo === 'espeto') comboEspetosEscolhidos = [escolha];
  else comboAcompanhamentosEscolhidos = [escolha];

  atualizarModalComboAposEscolha();
}

/** Escolha com repetição (limite > 1): +/- por item, travado no limite total do grupo */
function alterarQuantidadeItemCombo(tipo, id, delta) {
  const lista = obterListaEscolhidaCombo(tipo);
  const limite = obterLimiteCombo(tipo);
  const totalAtual = lista.reduce((s, e) => s + e.quantidade, 0);

  if (delta > 0 && totalAtual >= limite) return;

  const existente = lista.find((e) => e.id === id);
  if (existente) {
    existente.quantidade = Math.max(0, existente.quantidade + delta);
    if (existente.quantidade === 0) lista.splice(lista.indexOf(existente), 1);
  } else if (delta > 0) {
    const itemInfo = obterItensDisponiveisCombo(tipo).find((i) => i.id === id);
    if (!itemInfo) return;
    lista.push({ id, nome: itemInfo.nome, quantidade: 1, acrescimoUnitario: itemInfo.acrescimo });
  }

  atualizarModalComboAposEscolha();
}

function atualizarModalComboAposEscolha() {
  renderizarSeletorEspetosCombo();
  renderizarSeletorAcompanhamentosCombo();
  atualizarTotalCombo();
}

function atualizarTotalCombo() {
  const moeda = obterConfiguracoes().moeda;
  const { total } = calcularTotalCombo(comboAtual.preco, comboEspetosEscolhidos);

  document.getElementById('combo-rotulo-base').textContent = comboAtual.nome;
  document.getElementById('combo-valor-base').textContent = formatarMoeda(comboAtual.preco, moeda);

  document.getElementById('combo-linhas-extras').innerHTML = comboEspetosEscolhidos
    .filter((e) => e.acrescimoUnitario > 0)
    .map(
      (e) =>
        `<div class="linha-resumo"><span>${e.quantidade}x ${escaparHtml(e.nome)}</span><span>+ ${formatarMoeda(e.acrescimoUnitario * e.quantidade, moeda)}</span></div>`
    )
    .join('');

  document.getElementById('combo-valor-total').textContent = formatarMoeda(total, moeda);

  const totalEspetos = comboEspetosEscolhidos.reduce((s, e) => s + e.quantidade, 0);
  const totalAcompanhamentos = comboAcompanhamentosEscolhidos.reduce((s, a) => s + a.quantidade, 0);
  const completo =
    totalEspetos === comboAtual.allowedSkewers && (comboAtual.allowedSides === 0 || totalAcompanhamentos === comboAtual.allowedSides);
  document.getElementById('botao-adicionar-combo').disabled = !completo;
}

/** Monta o objeto de composição gravado no item de carrinho (ver adicionarComboAoCarrinho em storage.js) */
function montarComposicaoCombo() {
  const { extras, total } = calcularTotalCombo(comboAtual.preco, comboEspetosEscolhidos);
  return {
    comboId: comboAtual.id,
    nome: comboAtual.nome,
    precoBase: comboAtual.preco,
    espetos: comboEspetosEscolhidos.map((e) => ({ produtoId: e.id, nome: e.nome, quantidade: e.quantidade, acrescimoUnitario: e.acrescimoUnitario })),
    acompanhamentos: comboAcompanhamentosEscolhidos.map((a) => ({ id: a.id, nome: a.nome, quantidade: a.quantidade })),
    incluidos: itensInclusosDisponiveisCombo(comboAtual.includedItems).nomes,
    extras,
    total,
  };
}

function confirmarComboNoCarrinho() {
  const composicao = montarComposicaoCombo();

  if (comboEmEdicaoItemId) {
    atualizarComboNoCarrinho(comboEmEdicaoItemId, composicao.total, composicao);
    mostrarToast('Combo atualizado.', 'sucesso');
  } else {
    adicionarComboAoCarrinho(comboAtual.id, composicao.total, composicao);
    mostrarToast(`${composicao.nome} adicionado ao pedido.`, 'sucesso');
  }

  atualizarContadorCarrinho();
  atualizarBarraCarrinhoFixa();
  renderizarCarrinhoPedido();
  fecharModalCombo();
}

// ---------------------------------------------------------------------------
// Etapa 3: Retirada ou Entrega
// ---------------------------------------------------------------------------

function ligarEventosRecebimento() {
  document.querySelectorAll('.opcoes-recebimento .opcao-pagamento').forEach((botao) => {
    botao.addEventListener('click', () => {
      estadoPedido.fulfilment = botao.dataset.fulfilment;
      document.querySelectorAll('.opcoes-recebimento .opcao-pagamento').forEach((b) => b.classList.remove('selecionada'));
      botao.classList.add('selecionada');
      document.getElementById('botao-continuar-recebimento').disabled = false;
      salvarProgressoPedido();
    });
  });

  document.getElementById('botao-continuar-recebimento').addEventListener('click', () => {
    if (!estadoPedido.fulfilment) return;
    irParaEtapaPedido(estadoPedido.fulfilment === 'retirada' ? 'dados-retirada' : 'dados-entrega');
  });
}

// ---------------------------------------------------------------------------
// Etapa 4a: Dados para retirada
// ---------------------------------------------------------------------------

function ligarEventosDadosRetirada() {
  ligarFormatacaoTelefone('retirada-telefone');

  document.getElementById('botao-continuar-retirada').addEventListener('click', () => {
    const nome = document.getElementById('retirada-nome').value.trim();
    const telefone = document.getElementById('retirada-telefone').value.trim();

    let valido = true;
    valido = exibirErroCampo('erro-retirada-nome', nome ? '' : 'Informe seu nome.') && valido;
    valido = exibirErroCampo('erro-retirada-telefone', mensagemErroTelefone(telefone)) && valido;
    if (!valido) return;

    estadoPedido.cliente = { nome, telefone };
    estadoPedido.retirada = { horario: document.getElementById('retirada-horario').value };
    salvarProgressoPedido();
    irParaEtapaPedido('pagamento');
  });
}

// ---------------------------------------------------------------------------
// Etapa 4b: Dados para entrega
// ---------------------------------------------------------------------------

function ligarEventosDadosEntrega() {
  const campoEircode = document.getElementById('entrega-eircode');
  campoEircode.addEventListener('input', () => {
    const posicaoCursorNoFim = campoEircode.selectionStart === campoEircode.value.length;
    campoEircode.value = formatarEircode(campoEircode.value);
    if (posicaoCursorNoFim) campoEircode.setSelectionRange(campoEircode.value.length, campoEircode.value.length);
  });

  ligarFormatacaoTelefone('entrega-telefone');

  document.getElementById('botao-continuar-entrega').addEventListener('click', () => {
    const nome = document.getElementById('entrega-nome').value.trim();
    const telefone = document.getElementById('entrega-telefone').value.trim();
    const eircode = document.getElementById('entrega-eircode').value.trim();
    const linha1 = document.getElementById('entrega-linha1').value.trim();
    const linha2 = document.getElementById('entrega-linha2').value.trim();
    const area = document.getElementById('entrega-area').value.trim();
    const distrito = document.getElementById('entrega-distrito').value.trim();
    const instrucoes = document.getElementById('entrega-instrucoes').value.trim();

    let valido = true;
    valido = exibirErroCampo('erro-entrega-nome', nome ? '' : 'Informe seu nome.') && valido;
    valido = exibirErroCampo('erro-entrega-telefone', mensagemErroTelefone(telefone)) && valido;
    valido = exibirErroCampo('erro-entrega-eircode', validarFormatoEircode(eircode) ? '' : 'Informe um Eircode válido.') && valido;
    valido = exibirErroCampo('erro-entrega-linha1', linha1 ? '' : 'Informe o endereço.') && valido;
    if (!valido) return;

    estadoPedido.cliente = { nome, telefone };
    estadoPedido.endereco = { eircode, linha1, linha2, area, distrito, instrucoes };
    salvarProgressoPedido();
    irParaEtapaPedido('pagamento');
  });
}

/**
 * Liga a formatação automática de telefone (padrão irlandês) num campo —
 * mesma função pros dois fluxos (Retirada e Entrega), reaproveitando
 * formatarTelefoneIrlandes() de utils.js.
 */
function ligarFormatacaoTelefone(idCampo) {
  const campo = document.getElementById(idCampo);
  campo.addEventListener('input', () => {
    const posicaoCursorNoFim = campo.selectionStart === campo.value.length;
    campo.value = formatarTelefoneIrlandes(campo.value);
    if (posicaoCursorNoFim) campo.setSelectionRange(campo.value.length, campo.value.length);
  });
}

/** Mensagem de erro pro campo de telefone (vazio ou formato inválido), ou '' se estiver ok */
function mensagemErroTelefone(telefone) {
  if (!telefone) return 'Informe um telefone para contato.';
  if (!validarFormatoTelefoneIrlandes(telefone)) return 'Insira um número de telefone irlandês válido.';
  return '';
}

/** Mostra/esconde a mensagem de erro abaixo de um campo. Retorna true se não há erro. */
function exibirErroCampo(idElementoErro, mensagem) {
  const elemento = document.getElementById(idElementoErro);
  elemento.textContent = mensagem || '';
  return !mensagem;
}

// ---------------------------------------------------------------------------
// Etapa 5: Forma de pagamento
// ---------------------------------------------------------------------------

function ligarEventosPagamento() {
  document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((botao) => {
    botao.addEventListener('click', () => {
      estadoPedido.formaPagamento = botao.dataset.forma;
      if (botao.dataset.forma !== 'dinheiro') resetarDadosPagamentoDinheiro();

      document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((b) => b.classList.remove('selecionada'));
      botao.classList.add('selecionada');
      atualizarVisibilidadeSecaoTroco();
      document.getElementById('botao-continuar-pagamento').disabled = !pagamentoEstaCompleto();
      salvarProgressoPedido();
    });
  });

  ligarEventosTroco();

  document.getElementById('botao-continuar-pagamento').addEventListener('click', () => {
    if (!pagamentoEstaCompleto()) return;
    renderizarRevisao();
    irParaEtapaPedido('revisao');
  });
}

// ROTULOS_FORMA_PAGAMENTO agora vem de utils.js (reaproveitado também pela área Pedidos do admin)

/** Mostra/esconde o bloco "Precisa de troco?" conforme a forma de pagamento escolhida */
function atualizarVisibilidadeSecaoTroco() {
  document.getElementById('secao-troco-dinheiro').style.display = estadoPedido.formaPagamento === 'dinheiro' ? '' : 'none';
}

/** Limpa a resposta de troco (usado ao trocar pra uma forma de pagamento diferente de Dinheiro, ou ao reiniciar o pedido) */
function resetarDadosPagamentoDinheiro() {
  estadoPedido.dinheiro = null;
  document.querySelectorAll('.opcao-troco').forEach((b) => b.classList.remove('selecionada'));
  document.getElementById('grupo-valor-troco').style.display = 'none';
  document.getElementById('campo-valor-pago').value = '';
  document.getElementById('erro-valor-pago').textContent = '';
  document.getElementById('troco-estimado').style.display = 'none';
}

function ligarEventosTroco() {
  document.querySelectorAll('.opcao-troco').forEach((botao) => {
    botao.addEventListener('click', () => {
      const precisaTroco = botao.dataset.troco === 'sim';
      estadoPedido.dinheiro = { precisaTroco, valorPago: null, troco: null };

      document.querySelectorAll('.opcao-troco').forEach((b) => b.classList.remove('selecionada'));
      botao.classList.add('selecionada');

      document.getElementById('grupo-valor-troco').style.display = precisaTroco ? '' : 'none';
      document.getElementById('campo-valor-pago').value = '';
      document.getElementById('erro-valor-pago').textContent = '';
      document.getElementById('troco-estimado').style.display = 'none';

      document.getElementById('botao-continuar-pagamento').disabled = !pagamentoEstaCompleto();
      salvarProgressoPedido();
    });
  });

  document.getElementById('campo-valor-pago').addEventListener('input', () => {
    recalcularTroco();
    document.getElementById('botao-continuar-pagamento').disabled = !pagamentoEstaCompleto();
    salvarProgressoPedido();
  });
}

/** Subtotal/taxa/total do pedido no ponto atual do fluxo — mesmo cálculo usado na Revisão e na Confirmação */
function calcularTotaisPedidoAtual() {
  const carrinho = obterCarrinho();
  const config = obterConfiguracoes();
  const subtotal = calcularSubtotalCarrinho(carrinho);
  const taxaEntrega = estadoPedido.fulfilment === 'entrega' ? Number(config.taxaEntrega) || 0 : 0;
  return { subtotal, taxaEntrega, total: subtotal + taxaEntrega, moeda: config.moeda };
}

/** Recalcula o troco a partir do campo "Troco para quanto?", validando contra o total atual do pedido */
function recalcularTroco() {
  const { total, moeda } = calcularTotaisPedidoAtual();
  const campo = document.getElementById('campo-valor-pago');
  const erro = document.getElementById('erro-valor-pago');
  const estimado = document.getElementById('troco-estimado');
  const valorPago = Number(campo.value);

  if (!estadoPedido.dinheiro) estadoPedido.dinheiro = { precisaTroco: true, valorPago: null, troco: null };

  if (campo.value.trim() === '' || isNaN(valorPago)) {
    estadoPedido.dinheiro.valorPago = null;
    estadoPedido.dinheiro.troco = null;
    erro.textContent = '';
    estimado.style.display = 'none';
    return;
  }

  estadoPedido.dinheiro.valorPago = valorPago;

  if (valorPago < total) {
    estadoPedido.dinheiro.troco = null;
    erro.textContent = 'O valor para troco deve ser igual ou superior ao total do pedido.';
    estimado.style.display = 'none';
    return;
  }

  erro.textContent = '';
  const troco = Math.round((valorPago - total) * 100) / 100;
  estadoPedido.dinheiro.troco = troco;
  estimado.textContent = `Troco estimado: ${formatarMoeda(troco, moeda)}`;
  estimado.style.display = '';
}

/** Se a etapa de pagamento está completa o suficiente pra habilitar "Continuar" */
function pagamentoEstaCompleto() {
  if (!estadoPedido.formaPagamento) return false;
  if (estadoPedido.formaPagamento !== 'dinheiro') return true;

  const d = estadoPedido.dinheiro;
  if (!d || d.precisaTroco === null || d.precisaTroco === undefined) return false;
  if (d.precisaTroco === false) return true;
  return typeof d.troco === 'number' && d.troco >= 0;
}

// ---------------------------------------------------------------------------
// Etapa 6: Revisão do pedido
// ---------------------------------------------------------------------------

/** Bloco "Pagamento" da Revisão — mostra o troco quando a forma escolhida for Dinheiro */
function blocoPagamentoRevisaoHtml(moeda) {
  const rotulo = `<p>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[estadoPedido.formaPagamento] || '')}</p>`;
  if (estadoPedido.formaPagamento !== 'dinheiro') return rotulo;

  const d = estadoPedido.dinheiro;
  const blocoTroco =
    d && d.precisaTroco
      ? `<p>Troco para: ${formatarMoeda(d.valorPago, moeda)}<br/>Troco necessário: ${formatarMoeda(d.troco, moeda)}</p>`
      : '<p>Troco: Não necessário</p>';
  return rotulo + blocoTroco;
}

function renderizarRevisao() {
  const carrinho = obterCarrinho();
  const config = obterConfiguracoes();
  const subtotal = calcularSubtotalCarrinho(carrinho);
  const taxaEntrega = estadoPedido.fulfilment === 'entrega' ? Number(config.taxaEntrega) || 0 : 0;
  const total = subtotal + taxaEntrega;

  const linhasItens = carrinho
    .map((item) => {
      if (item.combo) {
        return `<div class="linha-resumo"><span>${escaparHtml(item.combo.nome)}</span><span>${formatarMoeda(item.precoUnitario * item.quantidade, config.moeda)}</span></div>`;
      }
      const produto = obterProdutoPorId(item.produtoId);
      const nome = produto ? produto.nome : '(produto removido)';
      return `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(nome)}</span><span>${formatarMoeda(item.precoUnitario * item.quantidade, config.moeda)}</span></div>`;
    })
    .join('');

  const blocoEntrega =
    estadoPedido.fulfilment === 'entrega'
      ? `
      <div class="resumo-revisao-secao">
        <div class="resumo-revisao-titulo">Endereço</div>
        <p>${escaparHtml(estadoPedido.endereco.eircode)}<br/>
        ${escaparHtml(estadoPedido.endereco.linha1)}${estadoPedido.endereco.linha2 ? ', ' + escaparHtml(estadoPedido.endereco.linha2) : ''}<br/>
        ${[estadoPedido.endereco.area, estadoPedido.endereco.distrito].filter(Boolean).map(escaparHtml).join(' — ')}</p>
        ${estadoPedido.endereco.instrucoes ? `<p><em>${escaparHtml(estadoPedido.endereco.instrucoes)}</em></p>` : ''}
      </div>`
      : `
      <div class="resumo-revisao-secao">
        <div class="resumo-revisao-titulo">Retirada</div>
        <p>Horário: ${escaparHtml(estadoPedido.retirada.horario)}</p>
      </div>`;

  document.getElementById('conteudo-revisao').innerHTML = `
    <div class="resumo-revisao-secao">
      <div class="resumo-revisao-titulo">Produtos</div>
      ${linhasItens}
    </div>
    <div class="resumo-revisao-secao">
      <div class="resumo-revisao-titulo">${estadoPedido.fulfilment === 'entrega' ? 'Entrega' : 'Retirada'}</div>
      <p>Cliente: ${escaparHtml(estadoPedido.cliente.nome)} · ${escaparHtml(estadoPedido.cliente.telefone)}</p>
    </div>
    ${blocoEntrega}
    <div class="resumo-revisao-secao">
      <div class="resumo-revisao-titulo">Pagamento</div>
      ${blocoPagamentoRevisaoHtml(config.moeda)}
    </div>
    <div class="card resumo-carrinho">
      <div class="linha-resumo"><span>Subtotal</span><span>${formatarMoeda(subtotal, config.moeda)}</span></div>
      <div class="linha-resumo"><span>Taxa de entrega</span><span>${formatarMoeda(taxaEntrega, config.moeda)}</span></div>
      <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(total, config.moeda)}</span></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Etapa 7: Confirmação
// ---------------------------------------------------------------------------

/**
 * Cria o pedido no Supabase via RPC create_customer_order (products-service
 * do lado de pedidos: js/services/orders-service.js) — preços e composição
 * do combo são recalculados no banco, não confiamos no que o navegador
 * enviou. Não mexe no carrinho nem no estoque local — quem chama decide o
 * que fazer só depois de confirmado o sucesso.
 */
async function criarPedido(pedido, itensPedido) {
  return await createOrder(pedido, itensPedido);
}

async function confirmarPedido() {
  const carrinho = obterCarrinho();
  if (carrinho.length === 0 || !estadoPedido.fulfilment || !pagamentoEstaCompleto()) return;

  const botaoConfirmar = document.getElementById('botao-confirmar-pedido');
  botaoConfirmar.disabled = true; // evita duplo clique / pedido duplicado enquanto a requisição está em andamento

  const config = obterConfiguracoes();
  const subtotal = calcularSubtotalCarrinho(carrinho);
  const taxaEntrega = estadoPedido.fulfilment === 'entrega' ? Number(config.taxaEntrega) || 0 : 0;
  const total = subtotal + taxaEntrega;

  const itensPedido = carrinho.map((item) => {
    if (item.combo) {
      return {
        produtoId: item.produtoId,
        nome: item.combo.nome,
        quantidade: item.quantidade,
        valorUnitario: item.precoUnitario,
        valorTotal: item.precoUnitario * item.quantidade,
        combo: item.combo,
      };
    }
    const produto = obterProdutoPorId(item.produtoId);
    return {
      produtoId: item.produtoId,
      nome: produto ? produto.nome : '(produto removido)',
      quantidade: item.quantidade,
      valorUnitario: item.precoUnitario,
      valorTotal: item.precoUnitario * item.quantidade,
    };
  });

  const pedido = {
    itens: itensPedido,
    fulfilment: estadoPedido.fulfilment,
    cliente: { ...estadoPedido.cliente },
    retirada: estadoPedido.fulfilment === 'retirada' ? { ...estadoPedido.retirada } : null,
    endereco: estadoPedido.fulfilment === 'entrega' ? { ...estadoPedido.endereco } : null,
    formaPagamento: estadoPedido.formaPagamento,
    pagamentoDinheiro: estadoPedido.formaPagamento === 'dinheiro' && estadoPedido.dinheiro ? { ...estadoPedido.dinheiro } : null,
    subtotal,
    taxaEntrega,
    total,
  };

  try {
    ultimoPedidoConfirmado = await criarPedido(pedido, itensPedido);
  } catch (erro) {
    mostrarToast('Não foi possível enviar o pedido. ' + erro.message, 'erro');
    botaoConfirmar.disabled = false;
    return; // permanece na etapa de revisão, carrinho intacto — pode tentar de novo
  }

  limparCarrinho(); // só depois de confirmado o sucesso no Supabase
  atualizarContadorCarrinho();
  renderizarConfirmacao(ultimoPedidoConfirmado, config.moeda);
  irParaEtapaPedido('confirmacao');
  localStorage.removeItem(CHAVE_PEDIDO_EM_ANDAMENTO); // etapa de confirmação nunca deve ser restaurada num refresh
  mostrarToast('Pedido confirmado!', 'sucesso');
  botaoConfirmar.disabled = false;
}

function renderizarConfirmacao(pedido, moeda) {
  document.getElementById('numero-pedido-confirmado').textContent = pedido.numero;

  const linhasItens = pedido.itens
    .map((item) => `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>`)
    .join('');

  document.getElementById('resumo-confirmacao').innerHTML = `
    ${linhasItens}
    <div class="linha-resumo"><span>${pedido.fulfilment === 'entrega' ? 'Entrega' : 'Retirada'}</span><span></span></div>
    <div class="linha-resumo"><span>Pagamento</span><span>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '')}</span></div>
    <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(pedido.total, moeda)}</span></div>
  `;
}

function reiniciarPedido() {
  pilhaEtapasPedido = ['cardapio'];
  estadoPedido = estadoPedidoInicial();
  ultimoPedidoConfirmado = null;
  categoriaSelecionadaPedido = 'Combos';
  localStorage.removeItem(CHAVE_PEDIDO_EM_ANDAMENTO);

  ['retirada-nome', 'retirada-telefone', 'entrega-nome', 'entrega-telefone', 'entrega-eircode', 'entrega-linha1', 'entrega-linha2', 'entrega-area', 'entrega-distrito', 'entrega-instrucoes'].forEach(
    (id) => (document.getElementById(id).value = '')
  );
  document.getElementById('retirada-horario').value = 'Assim que possível';
  document
    .querySelectorAll('.opcoes-recebimento .opcao-pagamento, #opcoes-pagamento-pedido .opcao-pagamento')
    .forEach((b) => b.classList.remove('selecionada'));
  resetarDadosPagamentoDinheiro();
  atualizarVisibilidadeSecaoTroco();
  document.getElementById('botao-continuar-recebimento').disabled = true;
  document.getElementById('botao-continuar-pagamento').disabled = true;
  ['erro-retirada-nome', 'erro-retirada-telefone', 'erro-entrega-nome', 'erro-entrega-telefone', 'erro-entrega-eircode', 'erro-entrega-linha1'].forEach(
    (id) => (document.getElementById(id).textContent = '')
  );

  renderizarFiltroCategoriasPedido();
  renderizarGradePedido();
  mostrarEtapaAtual();
}
