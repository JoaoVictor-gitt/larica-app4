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
 *   PaymentMethod     -> 'cartao' | 'dinheiro' | 'revolut' | 'transferencia'
 *   CashPaymentInfo   -> { precisaTroco, valorPago, troco } — só quando
 *                        formaPagamento === 'dinheiro'; ponto único a trocar
 *                        futuramente por uma integração real (ex.: Revolut)
 *   FulfilmentType    -> 'retirada' | 'entrega'
 *   Order             -> { itens, fulfilment, cliente, retirada, endereco,
 *                          formaPagamento, pagamentoDinheiro, subtotal,
 *                          taxaEntrega, total }
 */

const CHAVE_PEDIDO_EM_ANDAMENTO = 'caju_pedido_em_andamento';

// Realtime da confirmação Revolut (Fase 9/Etapa 5) — canal isolado, criado diretamente aqui (não em
// orders-service.js: subscribeToOrders() é moldada pro padrão "recarrega tudo" do admin, sem filtro por
// id). Nunca mais de um canal ativo por vez — ver assinarConfirmacaoRevolut()/cancelarAssinaturaConfirmacaoRevolut().
let canalConfirmacaoRevolut = null;
let canalConfirmacaoTransferencia = null;

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

// Disponibilidade do negócio (business_settings/business_hours) — carregada 1x no início,
// nunca via polling; ver carregarDisponibilidadeNegocio()/disponibilidadeNegocioAtual().
let configuracoesNegocio = null; // shape pt-BR de buscarConfiguracoesNegocioDoSupabase()
let horariosNegocio = null; // array de buscarHorariosFuncionamentoDoSupabase()
let configuracoesNegocioCarregadas = false;
let erroConfiguracoesNegocio = null; // string ou null

// Estado do modal de personalização de combo (ver seção "Modal de combo" mais abaixo)
let comboAtual = null; // registro de storage.js sendo personalizado
let comboEmEdicaoItemId = null; // itemId do carrinho, se estiver editando um combo já adicionado
let comboEspetosEscolhidos = []; // [{ id, nome, quantidade, acrescimoUnitario }]
let comboAcompanhamentosEscolhidos = []; // [{ id, nome, quantidade, acrescimoUnitario: 0 }]

function estadoPedidoInicial() {
  return {
    fulfilment: '',
    cliente: { nome: '', telefone: '' },
    retirada: { modo: '', horario: null }, // modo: 'asap' | 'horario'
    endereco: { eircode: '', linha1: '', linha2: '', area: '', distrito: '', instrucoes: '' },
    // { distanciaKm, taxa, modoViagem, duracaoTexto, enderecoCotado: {eircode,linha1,linha2,area} } — null até calcular
    // (ou depois que o endereço mudar) — ver calcularEntrega()/cotacaoEntregaValida() em js/pedido.js
    cotacaoEntrega: null,
    formaPagamento: '',
    dinheiro: null, // { precisaTroco, valorPago, troco } — só quando formaPagamento === 'dinheiro'
    // { codigo, cupomId, tipoDesconto, valorDesconto, valorDescontoCalculado, subtotalValidado } — null até
    // aplicar um cupom válido (validarCupomNoSupabase). Restaurado do localStorage só com `codigo` (ver
    // salvarProgressoPedido()) — subtotalValidado ausente força revalidação em renderizarRevisao().
    cupom: null,
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  carregarEstadoPersistido();
  carregarDisponibilidadeNegocio(); // não bloqueia o cardápio — roda em paralelo

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
  if (etapaAtualPedido() === 'revisao') await renderizarRevisao(); // já revalida um cupom restaurado (ver revalidarCupomSeNecessario)
  atualizarBarraCarrinhoFixa();
  mostrarEtapaAtual();
  ligarEventosGerais();
});

// ---------------------------------------------------------------------------
// Persistência local do progresso (não perder dados preenchidos ao atualizar)
// ---------------------------------------------------------------------------

/**
 * Persiste o progresso — mas NUNCA o desconto calculado do cupom, só o código digitado (item 17 do
 * pedido do usuário). O valor/percentual/id são sempre revalidados via validate_coupon depois de um
 * reload (ver revalidarCupomSeNecessario()), nunca reaproveitados como confiáveis do localStorage.
 */
function salvarProgressoPedido() {
  try {
    const estadoParaPersistir = {
      ...estadoPedido,
      cupom: estadoPedido.cupom ? { codigo: estadoPedido.cupom.codigo } : null,
    };
    localStorage.setItem(CHAVE_PEDIDO_EM_ANDAMENTO, JSON.stringify({ pilhaEtapasPedido, estadoPedido: estadoParaPersistir }));
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

  if (estadoPedido.retirada.modo) {
    document.querySelectorAll('#opcoes-modo-retirada [data-modo-retirada]').forEach((botao) => {
      botao.classList.toggle('selecionada', botao.dataset.modoRetirada === estadoPedido.retirada.modo);
    });
    const ehHorario = estadoPedido.retirada.modo === 'horario';
    document.getElementById('grupo-horario-retirada-escolhido').style.display = ehHorario ? '' : 'none';
    if (ehHorario) {
      document.getElementById('campo-horario-retirada').min = horarioMinimoRetirada();
      document.getElementById('campo-horario-retirada').value = estadoPedido.retirada.horario || '';
    }
  }

  document.getElementById('entrega-nome').value = estadoPedido.cliente.nome || '';
  document.getElementById('entrega-telefone').value = estadoPedido.cliente.telefone || '';
  document.getElementById('entrega-eircode').value = estadoPedido.endereco.eircode || '';
  document.getElementById('entrega-linha1').value = estadoPedido.endereco.linha1 || '';
  document.getElementById('entrega-linha2').value = estadoPedido.endereco.linha2 || '';
  document.getElementById('entrega-area').value = estadoPedido.endereco.area || '';
  document.getElementById('entrega-distrito').value = estadoPedido.endereco.distrito || '';
  document.getElementById('entrega-instrucoes').value = estadoPedido.endereco.instrucoes || '';
  exibirResultadoCalculoEntrega(); // só mostra algo se cotacaoEntrega existir e ainda bater com os campos restaurados acima
  atualizarEstadoBotaoContinuarEntrega();

  if (estadoPedido.fulfilment) {
    document.querySelectorAll('.opcoes-recebimento .opcao-pagamento[data-fulfilment]').forEach((botao) => {
      botao.classList.toggle('selecionada', botao.dataset.fulfilment === estadoPedido.fulfilment);
    });
    document.getElementById('botao-continuar-recebimento').disabled = false;
  }

  if (estadoPedido.formaPagamento) {
    document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((botao) => {
      botao.classList.toggle('selecionada', botao.dataset.forma === estadoPedido.formaPagamento);
    });
    atualizarVisibilidadeSecaoTroco();
    atualizarVisibilidadeDadosTransferencia();

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
// Disponibilidade do negócio (Fase 3 — gate client-side; a proteção real
// server-side fica pra Fase 4, em create_customer_order). Carrega
// business_settings/business_hours 1x aqui; toda checagem depois disso é
// local, sem novas chamadas ao Supabase (ver disponibilidadeNegocioAtual()).
// ---------------------------------------------------------------------------

async function carregarDisponibilidadeNegocio() {
  atualizarBannerDisponibilidade(); // mostra "Verificando disponibilidade..."
  try {
    const [config, horarios] = await Promise.all([buscarConfiguracoesNegocioDoSupabase(), buscarHorariosFuncionamentoDoSupabase()]);
    configuracoesNegocio = config;
    horariosNegocio = horarios;
    erroConfiguracoesNegocio = null;
  } catch (erro) {
    erroConfiguracoesNegocio = (erro && erro.message) || 'Não foi possível verificar se os pedidos estão disponíveis. Tente novamente.';
  } finally {
    configuracoesNegocioCarregadas = true;
    aplicarDisponibilidadeFulfilment();
    invalidarFulfilmentSeIndisponivel();
    aplicarDisponibilidadeRevolut();
    aplicarDisponibilidadeTransferencia();
    invalidarFormaPagamentoSeIndisponivel();
    atualizarBannerDisponibilidade();
  }
}

/**
 * Fonte única de verdade pra saber se Revolut pode ser oferecido/selecionado agora — reaproveitada
 * pelo botão da etapa de pagamento, pela invalidação de estado restaurado e pelo clique defensivo.
 * Exige config carregada sem erro, revolut_enabled=true E um QR realmente cadastrado.
 */
function revolutDisponivel() {
  return (
    configuracoesNegocioCarregadas &&
    !erroConfiguracoesNegocio &&
    !!configuracoesNegocio &&
    !!configuracoesNegocio.revolutAtivo &&
    !!configuracoesNegocio.revolutQrPath
  );
}

/**
 * Mesmo papel de revolutDisponivel(), pra Transferência Bancária. Exige config carregada sem
 * erro, bank_transfer_enabled=true E os 3 dados bancários realmente cadastrados (mesma defesa
 * "cinto e suspensório" do Revolut com o QR — o admin já é bloqueado de ativar sem os 3 campos,
 * mas aqui não confiamos só nisso).
 */
function transferenciaDisponivel() {
  return (
    configuracoesNegocioCarregadas &&
    !erroConfiguracoesNegocio &&
    !!configuracoesNegocio &&
    !!configuracoesNegocio.transferenciaAtiva &&
    !!configuracoesNegocio.transferenciaBeneficiario &&
    !!configuracoesNegocio.transferenciaIban &&
    !!configuracoesNegocio.transferenciaBic
  );
}

/** Dia da semana em Dublin (0=domingo...6=sábado, mesma convenção de business_hours.day_of_week) */
function diaSemanaDublin(agora, fuso) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
  const mapa = {};
  partes.forEach((p) => (mapa[p.type] = p.value));
  // Ancorado ao meio-dia UTC do mesmo dia-calendário de Dublin, pra extrair o dia da semana sem risco de a conversão de fuso empurrar pra outro dia
  const ancora = new Date(Date.UTC(Number(mapa.year), Number(mapa.month) - 1, Number(mapa.day), 12));
  return ancora.getUTCDay();
}

/** Minutos desde a meia-noite, na hora local de Dublin (hourCycle 'h23' evita o bug de hour12:false retornar "24:00" à meia-noite) */
function minutosDoDiaDublin(agora, fuso) {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(agora);
  const mapa = {};
  partes.forEach((p) => (mapa[p.type] = p.value));
  return Number(mapa.hour) * 60 + Number(mapa.minute);
}

/** "HH:MM" ou "HH:MM:SS" (formato que o Postgres `time` retorna) -> minutos desde a meia-noite, ou null se vazio/inválido */
function minutosDoHorario(horaTexto) {
  if (!horaTexto) return null;
  const [h, m] = horaTexto.split(':');
  const horas = Number(h);
  const minutos = Number(m);
  if (Number.isNaN(horas) || Number.isNaN(minutos)) return null;
  return horas * 60 + minutos;
}

/**
 * Está aberto agora, considerando o turno de hoje E o de ontem (caso ontem
 * atravesse a meia-noite e ainda não tenha fechado) — ver item 12 do pedido
 * do usuário: closing_time <= opening_time NUNCA é tratado como erro, só
 * como "esse turno vai até a madrugada do dia seguinte".
 */
function diaEstaAbertoAgora(horarios, diaSemana, minutosAgora) {
  const linhaHoje = horarios.find((h) => h.diaSemana === diaSemana);
  if (linhaHoje && linhaHoje.ativo) {
    const abertura = minutosDoHorario(linhaHoje.horaAbertura);
    const fechamento = minutosDoHorario(linhaHoje.horaFechamento);
    if (abertura != null && fechamento != null) {
      if (fechamento > abertura) {
        if (minutosAgora >= abertura && minutosAgora < fechamento) return true;
      } else if (minutosAgora >= abertura) {
        return true; // turno de hoje atravessa a meia-noite — aberto até 23:59 de hoje
      }
    }
  }

  const diaOntem = (diaSemana + 6) % 7;
  const linhaOntem = horarios.find((h) => h.diaSemana === diaOntem);
  if (linhaOntem && linhaOntem.ativo) {
    const abertura = minutosDoHorario(linhaOntem.horaAbertura);
    const fechamento = minutosDoHorario(linhaOntem.horaFechamento);
    if (abertura != null && fechamento != null && fechamento <= abertura && minutosAgora < fechamento) {
      return true; // madrugada de hoje ainda dentro do turno overnight de ontem
    }
  }

  return false;
}

/**
 * { configurado, aberto }. `configurado=false` quando os 7 dias estão
 * enabled=false (regra de transição do item 13) — nesse caso `aberto` é
 * sempre true, pra não bloquear pedidos por horário antes do admin
 * configurar pelo menos 1 dia.
 */
function obterStatusFuncionamentoAgora(config, horarios, agora) {
  const fuso = (config && config.fusoHorario) || 'Europe/Dublin';
  const configurado = horarios.some((h) => h.ativo);
  if (!configurado) return { configurado: false, aberto: true };

  const diaSemana = diaSemanaDublin(agora, fuso);
  const minutosAgora = minutosDoDiaDublin(agora, fuso);
  return { configurado: true, aberto: diaEstaAbertoAgora(horarios, diaSemana, minutosAgora) };
}

/**
 * Lógica central (única fonte de verdade — nenhum handler duplica isso):
 * orders_enabled -> business_hours -> delivery/collection, nessa ordem
 * (ver "Ordem dos gates" no plano). Pura: não lê DOM nem estado global.
 */
function calcularDisponibilidadeNegocio(config, horarios, agora) {
  if (!config.pedidosAtivos) {
    return { podeFinalizar: false, motivo: 'orders_disabled', mensagem: config.mensagemFechado || 'Pedidos fechados no momento.' };
  }

  const status = obterStatusFuncionamentoAgora(config, horarios, agora);
  if (status.configurado && !status.aberto) {
    return { podeFinalizar: false, motivo: 'outside_hours', mensagem: config.mensagemFechado || 'Pedidos fechados no momento.' };
  }

  if (!config.entregaAtiva && !config.retiradaAtiva) {
    return { podeFinalizar: false, motivo: 'no_methods', mensagem: 'Entrega e retirada estão indisponíveis no momento.' };
  }

  return { podeFinalizar: true, motivo: 'open', mensagem: '' };
}

/** Envolve calcularDisponibilidadeNegocio() com os estados de loading/erro do carregamento inicial */
function disponibilidadeNegocioAtual() {
  if (erroConfiguracoesNegocio) {
    return { podeFinalizar: false, motivo: 'error', mensagem: 'Não foi possível verificar se os pedidos estão disponíveis. Tente novamente.' };
  }
  if (!configuracoesNegocioCarregadas) {
    return { podeFinalizar: false, motivo: 'loading', mensagem: 'Verificando disponibilidade...' };
  }
  return calcularDisponibilidadeNegocio(configuracoesNegocio, horariosNegocio, new Date());
}

/** Banner fora das etapas (visível em qualquer uma) — só aparece quando não está simplesmente "aberto" */
function atualizarBannerDisponibilidade() {
  const disponibilidade = disponibilidadeNegocioAtual();
  const banner = document.getElementById('banner-disponibilidade-pedido');
  if (disponibilidade.motivo === 'open') {
    banner.style.display = 'none';
    banner.classList.remove('aviso-atencao');
    return;
  }
  banner.textContent = disponibilidade.mensagem;
  banner.classList.toggle('aviso-atencao', disponibilidade.motivo !== 'loading');
  banner.style.display = '';
}

/** Desabilita + rotula "Indisponível" o botão de Retirada/Entrega conforme configuracoesNegocio — só roda após carga bem-sucedida */
function aplicarDisponibilidadeFulfilment() {
  if (!configuracoesNegocioCarregadas || erroConfiguracoesNegocio || !configuracoesNegocio) return;

  aplicarDisponibilidadeBotaoFulfilment('retirada', configuracoesNegocio.retiradaAtiva);
  aplicarDisponibilidadeBotaoFulfilment('entrega', configuracoesNegocio.entregaAtiva);

  const nenhumMetodo = !configuracoesNegocio.entregaAtiva && !configuracoesNegocio.retiradaAtiva;
  document.getElementById('aviso-recebimento-indisponivel').style.display = nenhumMetodo ? '' : 'none';
}

function aplicarDisponibilidadeBotaoFulfilment(fulfilment, disponivel) {
  const botao = document.querySelector(`.opcoes-recebimento .opcao-pagamento[data-fulfilment="${fulfilment}"]`);
  if (!botao) return;

  botao.disabled = !disponivel;
  botao.classList.toggle('opcao-indisponivel', !disponivel);

  let selo = botao.querySelector('.selo-indisponivel');
  if (!disponivel && !selo) {
    selo = document.createElement('small');
    selo.className = 'selo-indisponivel';
    selo.textContent = 'Indisponível';
    botao.querySelector('span:last-child').appendChild(selo);
  } else if (disponivel && selo) {
    selo.remove();
  }
}

/** Se o fulfilment restaurado do localStorage não está mais disponível, limpa a seleção e obriga nova escolha (item 18) */
function invalidarFulfilmentSeIndisponivel() {
  if (!configuracoesNegocioCarregadas || erroConfiguracoesNegocio || !configuracoesNegocio) return;
  if (!estadoPedido.fulfilment) return;

  const aindaValido =
    (estadoPedido.fulfilment === 'entrega' && configuracoesNegocio.entregaAtiva) ||
    (estadoPedido.fulfilment === 'retirada' && configuracoesNegocio.retiradaAtiva);
  if (aindaValido) return;

  estadoPedido.fulfilment = '';
  document.querySelectorAll('.opcoes-recebimento .opcao-pagamento[data-fulfilment]').forEach((b) => b.classList.remove('selecionada'));
  document.getElementById('botao-continuar-recebimento').disabled = true;
  salvarProgressoPedido();
  mostrarToast('A opção de recebimento escolhida não está mais disponível. Escolha novamente.', 'erro');
}

/** Desabilita + esmaece visualmente o botão Revolut quando revolutDisponivel() for false — mesmo padrão já usado pro fulfilment */
function aplicarDisponibilidadeRevolut() {
  const botao = document.querySelector('#opcoes-pagamento-pedido .opcao-pagamento[data-forma="revolut"]');
  if (!botao) return;
  const disponivel = revolutDisponivel();
  botao.disabled = !disponivel;
  botao.classList.toggle('opcao-indisponivel', !disponivel);
}

/** Mesmo padrão de aplicarDisponibilidadeRevolut(), pro botão de Transferência Bancária */
function aplicarDisponibilidadeTransferencia() {
  const botao = document.querySelector('#opcoes-pagamento-pedido .opcao-pagamento[data-forma="transferencia"]');
  if (!botao) return;
  const disponivel = transferenciaDisponivel();
  botao.disabled = !disponivel;
  botao.classList.toggle('opcao-indisponivel', !disponivel);
}

/** Se Revolut ou Transferência estavam selecionados (restaurado do localStorage) e não estão mais disponíveis, obriga nova escolha */
function invalidarFormaPagamentoSeIndisponivel() {
  if (estadoPedido.formaPagamento === 'revolut' && !revolutDisponivel()) {
    estadoPedido.formaPagamento = '';
    document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((b) => b.classList.remove('selecionada'));
    document.getElementById('botao-continuar-pagamento').disabled = true;
    salvarProgressoPedido();
    mostrarToast('Pagamento via Revolut temporariamente indisponível. Escolha outra forma de pagamento.', 'erro');
    return;
  }

  if (estadoPedido.formaPagamento === 'transferencia' && !transferenciaDisponivel()) {
    estadoPedido.formaPagamento = '';
    document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((b) => b.classList.remove('selecionada'));
    document.getElementById('secao-dados-transferencia').style.display = 'none';
    document.getElementById('botao-continuar-pagamento').disabled = true;
    salvarProgressoPedido();
    mostrarToast('Pagamento via transferência bancária temporariamente indisponível. Escolha outra forma de pagamento.', 'erro');
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
    const disponibilidade = disponibilidadeNegocioAtual();
    if (!disponibilidade.podeFinalizar) {
      mostrarToast(disponibilidade.mensagem, 'erro');
      return;
    }
    irParaEtapaPedido('recebimento');
  });

  document.getElementById('botao-copiar-codigo-revolut').addEventListener('click', copiarCodigoRevolut);
  document.getElementById('botao-copiar-iban-confirmacao').addEventListener('click', () => copiarIban('confirmacao'));

  ligarEventosRecebimento();
  ligarEventosDadosRetirada();
  ligarEventosDadosEntrega();
  ligarEventosPagamento();
  ligarEventosModalCombo();
  ligarEventosCupom();
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
  const indisponivel = produto.disponivel === false;
  const bloqueado = esgotado || indisponivel;
  // Estoque zerado e indisponibilidade manual usam o mesmo tratamento visual
  // (item continua visível, ação desabilitada) — só o texto muda conforme a causa.
  const rotulo = indisponivel ? 'INDISPONÍVEL' : 'ESGOTADO';

  const foto = produto.foto
    ? `<img src="${produto.foto}" alt="${escaparHtml(produto.nome)}" />`
    : `<div class="card-produto-foto-vazia">🍢</div>`;

  return `
    <div class="card-produto">
      <div class="card-produto-foto-wrap">
        ${foto}
        <span class="card-produto-categoria">${escaparHtml(produto.categoria)}</span>
        ${bloqueado ? `<div class="selo-esgotado">${rotulo}</div>` : ''}
      </div>
      <div class="card-produto-corpo">
        <div class="card-produto-nome">${escaparHtml(produto.nome)}</div>
        <div class="card-produto-descricao">${escaparHtml(produto.descricao || '')}</div>
        <div class="card-produto-rodape">
          <span class="card-produto-preco">${formatarMoeda(produto.preco, moeda)}</span>
          ${bloqueado ? `<span class="card-produto-estoque">${indisponivel ? 'Indisponível' : 'Sem estoque'}</span>` : ''}
        </div>
        <div class="card-produto-acao">
          <input type="number" class="seletor-quantidade" id="pedido-qtd-${produto.id}" min="1" max="${produto.quantidadeEstoque}" value="1" ${bloqueado ? 'disabled' : ''} />
          <button class="btn btn-primario botao-adicionar" data-acao="adicionar" data-id="${produto.id}" ${bloqueado ? 'disabled' : ''}>
            ${indisponivel ? 'Indisponível' : esgotado ? 'Esgotado' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>`;
}

function cardComboPedidoHtml(combo, moeda) {
  const indisponivel = combo.disponivel === false;

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
        ${indisponivel ? '<div class="selo-esgotado">INDISPONÍVEL</div>' : ''}
      </div>
      <div class="card-produto-corpo">
        <div class="card-produto-nome">${escaparHtml(combo.nome)}</div>
        <div class="card-produto-descricao">${escaparHtml(combo.descricao || '')}</div>
        ${avisoInclusos}
        <div class="card-produto-rodape">
          <span class="card-produto-preco">A partir de ${formatarMoeda(combo.preco, moeda)}</span>
          ${indisponivel ? '<span class="card-produto-estoque">Indisponível</span>' : ''}
        </div>
        <div class="card-produto-acao">
          <button class="btn btn-primario botao-adicionar" data-acao="personalizar-combo" data-id="${combo.id}" ${indisponivel ? 'disabled' : ''}>
            ${indisponivel ? 'Indisponível' : 'Personalizar'}
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
  return pesquisarProdutos({ categoria: 'Espetinhos', status: 'ativo', disponivel: true }).map((p) => ({
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
  return pesquisarProdutos({ categoria: 'Acompanhamentos', status: 'ativo', disponivel: true })
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
  if (itens.length === 0) {
    return '<p class="dica-campo">Nenhuma opção disponível no momento.</p>';
  }

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
  document.querySelectorAll('.opcoes-recebimento .opcao-pagamento[data-fulfilment]').forEach((botao) => {
    botao.addEventListener('click', () => {
      estadoPedido.fulfilment = botao.dataset.fulfilment;
      document.querySelectorAll('.opcoes-recebimento .opcao-pagamento[data-fulfilment]').forEach((b) => b.classList.remove('selecionada'));
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

  document.querySelectorAll('#opcoes-modo-retirada [data-modo-retirada]').forEach((botao) => {
    botao.addEventListener('click', () => {
      const modo = botao.dataset.modoRetirada;
      estadoPedido.retirada = { modo, horario: modo === 'horario' ? estadoPedido.retirada.horario || null : null };

      document.querySelectorAll('#opcoes-modo-retirada [data-modo-retirada]').forEach((b) => b.classList.toggle('selecionada', b === botao));

      const grupoHorario = document.getElementById('grupo-horario-retirada-escolhido');
      grupoHorario.style.display = modo === 'horario' ? '' : 'none';
      if (modo === 'horario') {
        document.getElementById('campo-horario-retirada').min = horarioMinimoRetirada();
      }
      document.getElementById('erro-horario-retirada').textContent = '';
      salvarProgressoPedido();
    });
  });

  document.getElementById('campo-horario-retirada').addEventListener('input', () => {
    estadoPedido.retirada.horario = document.getElementById('campo-horario-retirada').value;
    document.getElementById('erro-horario-retirada').textContent = '';
    salvarProgressoPedido();
  });

  document.getElementById('botao-continuar-retirada').addEventListener('click', () => {
    const nome = document.getElementById('retirada-nome').value.trim();
    const telefone = document.getElementById('retirada-telefone').value.trim();

    let valido = true;
    valido = exibirErroCampo('erro-retirada-nome', nome ? '' : 'Informe seu nome.') && valido;
    valido = exibirErroCampo('erro-retirada-telefone', mensagemErroTelefone(telefone)) && valido;

    if (!estadoPedido.retirada.modo) {
      mostrarToast('Escolha quando você quer retirar o pedido.', 'erro');
      valido = false;
    } else if (estadoPedido.retirada.modo === 'horario') {
      const horario = estadoPedido.retirada.horario;
      const mensagemHorario = !horario
        ? 'Escolha um horário para retirada.'
        : !validarHorarioRetirada(horario)
        ? `Escolha um horário a partir de ${horarioMinimoRetirada()}.`
        : '';
      valido = exibirErroCampo('erro-horario-retirada', mensagemHorario) && valido;
    }

    if (!valido) return;

    estadoPedido.cliente = { nome, telefone };
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
    invalidarCotacaoEntrega();
  });
  ['entrega-linha1', 'entrega-linha2', 'entrega-area'].forEach((id) => {
    document.getElementById(id).addEventListener('input', invalidarCotacaoEntrega);
  });

  ligarFormatacaoTelefone('entrega-telefone');

  document.getElementById('botao-calcular-entrega').addEventListener('click', calcularEntrega);

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

    if (!cotacaoEntregaValida()) {
      mostrarToast('Calcule a taxa de entrega antes de continuar.', 'erro');
      return;
    }

    estadoPedido.cliente = { nome, telefone };
    estadoPedido.endereco = { eircode, linha1, linha2, area, distrito, instrucoes };
    salvarProgressoPedido();
    irParaEtapaPedido('pagamento');
  });
}

/** Endereço atualmente digitado nos campos usados pela Edge Function calculate-delivery (não confia em estadoPedido.endereco, que só é gravado ao clicar Continuar) */
function enderecoEntregaDoFormulario() {
  return {
    eircode: document.getElementById('entrega-eircode').value.trim(),
    linha1: document.getElementById('entrega-linha1').value.trim(),
    linha2: document.getElementById('entrega-linha2').value.trim(),
    area: document.getElementById('entrega-area').value.trim(),
  };
}

/** A cotação só é válida se existir E o endereço não tiver mudado desde que foi calculada */
function cotacaoEntregaValida() {
  const cotacao = estadoPedido.cotacaoEntrega;
  if (!cotacao) return false;
  const atual = enderecoEntregaDoFormulario();
  const cotado = cotacao.enderecoCotado || {};
  return atual.eircode === cotado.eircode && atual.linha1 === cotado.linha1 && atual.linha2 === cotado.linha2 && atual.area === cotado.area;
}

/** Zera a cotação (endereço mudou) — obriga o cliente a clicar em "Calcular entrega" de novo antes de continuar */
function invalidarCotacaoEntrega() {
  if (!estadoPedido.cotacaoEntrega) return;
  estadoPedido.cotacaoEntrega = null;
  document.getElementById('resultado-calculo-entrega').style.display = 'none';
  document.getElementById('erro-calculo-entrega').textContent = '';
  atualizarEstadoBotaoContinuarEntrega();
  salvarProgressoPedido();
}

function atualizarEstadoBotaoContinuarEntrega() {
  document.getElementById('botao-continuar-entrega').disabled = !cotacaoEntregaValida();
}

/** Mostra distância/taxa/tempo estimado calculados — ou esconde o bloco se não houver cotação válida */
function exibirResultadoCalculoEntrega() {
  const cotacao = estadoPedido.cotacaoEntrega;
  const resultado = document.getElementById('resultado-calculo-entrega');
  if (!cotacao) {
    resultado.style.display = 'none';
    return;
  }

  const moeda = obterConfiguracoes().moeda;
  document.getElementById('entrega-distancia-valor').textContent = `${Number(cotacao.distanciaKm).toFixed(2).replace('.', ',')} km`;
  document.getElementById('entrega-taxa-valor').textContent = formatarMoeda(cotacao.taxa, moeda);

  const tempoEl = document.getElementById('entrega-tempo-estimado');
  const textoTempo = formatarDuracaoBicicleta(cotacao.duracaoTexto);
  tempoEl.textContent = textoTempo;
  tempoEl.style.display = textoTempo ? '' : 'none';

  resultado.style.display = '';
}

/**
 * Chama a Edge Function calculate-delivery (rota de bicicleta, origem fixa
 * configurada no próprio Supabase) pelo cliente já existente — nunca cria
 * outro client nem expõe chave do Google. Sem fallback: se falhar, não
 * assume nenhuma taxa, só mostra o erro e mantém a cotação zerada.
 */
async function calcularEntrega() {
  const { eircode, linha1, linha2, area } = enderecoEntregaDoFormulario();

  let valido = true;
  valido = exibirErroCampo('erro-entrega-eircode', validarFormatoEircode(eircode) ? '' : 'Informe um Eircode válido.') && valido;
  valido = exibirErroCampo('erro-entrega-linha1', linha1 ? '' : 'Informe o endereço.') && valido;
  if (!valido) return;

  const botao = document.getElementById('botao-calcular-entrega');
  const rotuloOriginal = botao.textContent;
  const erroCalculo = document.getElementById('erro-calculo-entrega');

  estadoPedido.cotacaoEntrega = null;
  document.getElementById('resultado-calculo-entrega').style.display = 'none';
  erroCalculo.textContent = '';
  atualizarEstadoBotaoContinuarEntrega();

  botao.disabled = true;
  botao.textContent = 'Calculando entrega...';

  try {
    const { data, error } = await supabaseClient.functions.invoke('calculate-delivery', {
      body: { eircode, address_line_1: linha1, address_line_2: linha2, area },
    });
    console.log('[Delivery] resposta:', data);

    if (error) {
      console.error('[Delivery] erro:', error);
      throw new Error('Não foi possível calcular a entrega para este endereço.');
    }
    if (!data || data.success !== true || typeof data.delivery_fee !== 'number' || typeof data.distance_km !== 'number') {
      throw new Error((data && data.error) || 'Não foi possível calcular a entrega para este endereço.');
    }

    estadoPedido.cotacaoEntrega = {
      quoteId: data.quote_id || null,
      distanciaKm: data.distance_km,
      taxa: data.delivery_fee,
      modoViagem: data.travel_mode || 'BICYCLE',
      duracaoTexto: data.duration || '',
      enderecoCotado: { eircode, linha1, linha2, area },
    };
    salvarProgressoPedido();
    exibirResultadoCalculoEntrega();
  } catch (erro) {
    console.error('[Delivery] erro:', erro);
    erroCalculo.textContent = erro && erro.message ? erro.message : 'Não foi possível calcular a entrega para este endereço.';
  } finally {
    botao.disabled = false;
    botao.textContent = rotuloOriginal;
    atualizarEstadoBotaoContinuarEntrega();
  }
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
      // Defesa client-side além do disabled/opacidade visual — cobre inclusive o período em que
      // business_settings ainda está carregando (revolutDisponivel()/transferenciaDisponivel() já são false nesse momento).
      if (botao.dataset.forma === 'revolut' && !revolutDisponivel()) {
        mostrarToast('Pagamento via Revolut temporariamente indisponível.', 'erro');
        return;
      }
      if (botao.dataset.forma === 'transferencia' && !transferenciaDisponivel()) {
        mostrarToast('Pagamento via transferência bancária temporariamente indisponível.', 'erro');
        return;
      }

      estadoPedido.formaPagamento = botao.dataset.forma;
      if (botao.dataset.forma !== 'dinheiro') resetarDadosPagamentoDinheiro();

      document.querySelectorAll('#opcoes-pagamento-pedido .opcao-pagamento[data-forma]').forEach((b) => b.classList.remove('selecionada'));
      botao.classList.add('selecionada');
      atualizarVisibilidadeSecaoTroco();
      atualizarVisibilidadeDadosTransferencia();
      document.getElementById('botao-continuar-pagamento').disabled = !pagamentoEstaCompleto();
      salvarProgressoPedido();
    });
  });

  ligarEventosTroco();

  document.getElementById('botao-copiar-iban-inline').addEventListener('click', () => copiarIban('inline'));

  document.getElementById('botao-continuar-pagamento').addEventListener('click', async () => {
    if (estadoPedido.formaPagamento === 'dinheiro' && estadoPedido.dinheiro && estadoPedido.dinheiro.precisaTroco) {
      recalcularTroco(); // o total pode ter mudado (ex.: cliente voltou pro carrinho) desde a última digitação
    }
    if (!pagamentoEstaCompleto()) {
      const mensagem =
        estadoPedido.dinheiro && estadoPedido.dinheiro.precisaTroco
          ? 'O valor informado para troco deve ser igual ou superior ao total do pedido.'
          : 'Escolha uma forma de pagamento para continuar.';
      mostrarToast(mensagem, 'erro');
      return;
    }
    await renderizarRevisao();
    irParaEtapaPedido('revisao');
  });
}

// ROTULOS_FORMA_PAGAMENTO agora vem de utils.js (reaproveitado também pela área Pedidos do admin)

/** Mostra/esconde o bloco "Precisa de troco?" conforme a forma de pagamento escolhida */
function atualizarVisibilidadeSecaoTroco() {
  document.getElementById('secao-troco-dinheiro').style.display = estadoPedido.formaPagamento === 'dinheiro' ? '' : 'none';
}

/**
 * Mostra/esconde o painel "Dados para transferência" assim que o cliente seleciona Transferência
 * Bancária (item 6 do pedido: "mostrar imediatamente"). Preenche a partir de configuracoesNegocio,
 * já carregado por carregarDisponibilidadeNegocio() — nunca hardcoded, nunca nova consulta.
 */
function atualizarVisibilidadeDadosTransferencia() {
  const secao = document.getElementById('secao-dados-transferencia');
  if (estadoPedido.formaPagamento !== 'transferencia') {
    secao.style.display = 'none';
    return;
  }
  secao.style.display = '';
  document.getElementById('transferencia-beneficiario-inline').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaBeneficiario) || '—';
  document.getElementById('transferencia-iban-inline').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaIban) || '—';
  document.getElementById('transferencia-bic-inline').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaBic) || '—';
}

/**
 * Copia o IBAN cadastrado em Configurações pro clipboard — reaproveita a mesma utilidade genérica
 * usada por copiarCodigoRevolut() (js/utils.js). `contexto` é 'inline' (Etapa 5) ou 'confirmacao'
 * (Etapa 7) — mesmo dado, botões diferentes, cada um com seu próprio feedback temporário.
 */
async function copiarIban(contexto) {
  const iban = (configuracoesNegocio && configuracoesNegocio.transferenciaIban) || '';
  if (!iban) return;

  const botao = document.getElementById(contexto === 'confirmacao' ? 'botao-copiar-iban-confirmacao' : 'botao-copiar-iban-inline');
  const rotuloOriginal = botao.textContent;

  try {
    await copiarTextoParaClipboard(iban);
    botao.textContent = '✓ IBAN copiado';
    mostrarToast('IBAN copiado!', 'sucesso');
  } catch (erro) {
    mostrarToast('Não foi possível copiar o IBAN. Copie manualmente.', 'erro');
  } finally {
    setTimeout(() => {
      botao.textContent = rotuloOriginal;
    }, 2000);
  }
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

/**
 * Subtotal/desconto/taxa/total do pedido no ponto atual do fluxo — única fonte usada por Carrinho,
 * Pagamento (troco), Revisão e confirmarPedido(). O desconto nunca incide sobre a taxa de entrega
 * (item 7 do pedido do usuário: subtotal -> desconto -> +entrega -> total). É só cálculo visual — a
 * fonte real de verdade continua sendo create_customer_order (item 8).
 */
function calcularTotaisPedidoAtual() {
  const carrinho = obterCarrinho();
  const config = obterConfiguracoes();
  const subtotal = calcularSubtotalCarrinho(carrinho);
  const desconto = valorDescontoCupomAplicado();
  const taxaEntrega = taxaEntregaAtual();
  const total = Math.max(0, subtotal - desconto) + taxaEntrega;
  return { subtotal, desconto, taxaEntrega, total, moeda: config.moeda };
}

// ---------------------------------------------------------------------------
// Cupom de desconto (Fase 10B/Etapa 4) — etapa Revisão. Nunca consulta
// .from('coupons'); só validarCupomNoSupabase() (RPC pública validate_coupon).
// ---------------------------------------------------------------------------

// Token simples pra descartar respostas de validate_coupon fora de ordem (item 19) — incrementado a
// cada nova chamada (aplicar/remover/revalidar); uma resposta só é aplicada se ainda for a mais recente.
let tokenRevalidacaoCupom = 0;

/** Valor (já calculado) do desconto do cupom em memória — 0 se não houver cupom aplicado E validado nesta sessão */
function valorDescontoCupomAplicado() {
  const cupom = estadoPedido.cupom;
  return cupom && typeof cupom.valorDescontoCalculado === 'number' ? cupom.valorDescontoCalculado : 0;
}

/** Grava o resultado de uma validação bem-sucedida (validarCupomNoSupabase) como o cupom aplicado atual */
function aplicarResultadoCupomValidado(codigoDigitado, resultado, subtotalValidado) {
  estadoPedido.cupom = {
    codigo: resultado.codigo || codigoDigitado,
    cupomId: resultado.cupomId,
    tipoDesconto: resultado.tipoDesconto,
    valorDesconto: resultado.valorDesconto,
    valorDescontoCalculado: resultado.valorDescontoCalculado,
    subtotalValidado,
  };
}

/** true se há um cupom aplicado cujo desconto foi calculado contra um subtotal diferente do atual (ou nunca validado nesta sessão) */
function cupomPrecisaRevalidar(subtotalAtual) {
  const cupom = estadoPedido.cupom;
  return !!cupom && cupom.subtotalValidado !== subtotalAtual;
}

/**
 * Revalida silenciosamente o cupom aplicado contra o subtotal atual quando necessário (item 6 — nunca
 * deixa o desconto congelado; item 18 — cupom restaurado do localStorage só tem `codigo`, então sempre
 * cai aqui na primeira vez). Chamado só de dentro de renderizarRevisao(), único ponto de reentrada na
 * etapa Revisão depois de qualquer mudança no carrinho (a etapa não tem controles de edição — ver
 * auditoria). Retorna a mensagem de erro se o cupom foi removido por não ser mais válido, ou null.
 */
async function revalidarCupomSeNecessario(subtotalAtual) {
  if (!cupomPrecisaRevalidar(subtotalAtual)) return null;

  const codigo = estadoPedido.cupom.codigo;
  const meuToken = ++tokenRevalidacaoCupom;

  if (subtotalAtual <= 0) {
    estadoPedido.cupom = null;
    return null;
  }

  try {
    const resultado = await validarCupomNoSupabase(codigo, subtotalAtual);
    if (meuToken !== tokenRevalidacaoCupom) return null; // uma revalidação mais nova já assumiu — descarta esta resposta
    aplicarResultadoCupomValidado(codigo, resultado, subtotalAtual);
    return null;
  } catch (erro) {
    if (meuToken !== tokenRevalidacaoCupom) return null;
    estadoPedido.cupom = null;
    return erro.message; // mensagem real da RPC (item 20) — nunca "Erro inesperado"
  }
}

/** Sincroniza o card estático "Cupom de desconto" (input vs. info aplicada) com estadoPedido.cupom */
function atualizarUiCupom() {
  const grupoInput = document.getElementById('grupo-cupom-input');
  const infoAplicado = document.getElementById('cupom-aplicado-info');
  const cupom = estadoPedido.cupom;
  const aplicadoEValido = cupom && typeof cupom.valorDescontoCalculado === 'number';

  if (!aplicadoEValido) {
    grupoInput.style.display = '';
    infoAplicado.style.display = 'none';
    return;
  }

  grupoInput.style.display = 'none';
  infoAplicado.style.display = '';
  const moeda = obterConfiguracoes().moeda;
  const rotuloTipo = cupom.tipoDesconto === 'percentage' ? `${cupom.valorDesconto}% de desconto` : `desconto de ${formatarMoeda(cupom.valorDesconto, moeda)}`;
  document.getElementById('texto-cupom-aplicado').textContent =
    `${cupom.codigo} aplicado — ${rotuloTipo} (-${formatarMoeda(cupom.valorDescontoCalculado, moeda)})`;
}

/** Linha "Cupom CODIGO (rótulo) -€X" do resumo de totais — '' quando não há desconto. `rotulo` opcional (ex.: "10%"), null pra omitir. */
function linhaCupomResumoHtml(codigoCupom, valorDescontoCalculado, moeda, rotulo) {
  if (!codigoCupom || !valorDescontoCalculado) return '';
  const parteRotulo = rotulo ? ` (${escaparHtml(rotulo)})` : '';
  return `<div class="linha-resumo"><span>Cupom ${escaparHtml(codigoCupom)}${parteRotulo}</span><span>-${formatarMoeda(valorDescontoCalculado, moeda)}</span></div>`;
}

async function aplicarCupomPedido() {
  const erroEl = document.getElementById('erro-cupom-pedido');
  erroEl.textContent = '';

  const campo = document.getElementById('campo-cupom-codigo-pedido');
  const codigo = campo.value.trim().toUpperCase();
  if (!codigo) {
    erroEl.textContent = 'Informe o código do cupom.';
    return;
  }

  const subtotalAtual = calcularSubtotalCarrinho(obterCarrinho());
  const botao = document.getElementById('botao-aplicar-cupom');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Aplicando...';

  const meuToken = ++tokenRevalidacaoCupom;
  try {
    const resultado = await validarCupomNoSupabase(codigo, subtotalAtual);
    if (meuToken !== tokenRevalidacaoCupom) return;
    aplicarResultadoCupomValidado(codigo, resultado, subtotalAtual);
    campo.value = '';
    salvarProgressoPedido();
    atualizarUiCupom();
    await renderizarRevisao();
    mostrarToast('Cupom aplicado.', 'sucesso');
  } catch (erro) {
    if (meuToken !== tokenRevalidacaoCupom) return;
    erroEl.textContent = erro.message; // mensagem real da RPC (item 20): "Cupom não encontrado.", "Este cupom está inativo.", etc.
  } finally {
    if (meuToken === tokenRevalidacaoCupom) {
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }
}

/** Remove o cupom aplicado — nunca chama RPC (item 5), só limpa estado local */
async function removerCupomPedido() {
  tokenRevalidacaoCupom++; // invalida qualquer aplicar/revalidar em andamento
  estadoPedido.cupom = null;
  document.getElementById('erro-cupom-pedido').textContent = '';
  document.getElementById('campo-cupom-codigo-pedido').value = '';
  salvarProgressoPedido();
  atualizarUiCupom();
  await renderizarRevisao();
}

function ligarEventosCupom() {
  document.getElementById('botao-aplicar-cupom').addEventListener('click', aplicarCupomPedido);
  document.getElementById('botao-remover-cupom').addEventListener('click', removerCupomPedido);
}

/** Taxa de entrega vinda da cotação real (Edge Function calculate-delivery) — 0 pra Retirada ou se não houver cotação válida. Nunca usa valor fixo/manual. */
function taxaEntregaAtual() {
  if (estadoPedido.fulfilment !== 'entrega' || !estadoPedido.cotacaoEntrega) return 0;
  return Number(estadoPedido.cotacaoEntrega.taxa) || 0;
}

/** Distância (km) da cotação real, ou null se não houver — vai no payload só como dado informativo (ver item 13/14 do pedido do usuário) */
function distanciaEntregaAtual() {
  if (estadoPedido.fulfilment !== 'entrega' || !estadoPedido.cotacaoEntrega) return null;
  return Number(estadoPedido.cotacaoEntrega.distanciaKm);
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

  const troco = calcularTroco(valorPago, total);
  if (troco === null) {
    estadoPedido.dinheiro.troco = null;
    erro.textContent = 'O valor informado para troco deve ser igual ou superior ao total do pedido.';
    estimado.style.display = 'none';
    return;
  }

  erro.textContent = '';
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
  if (d && d.precisaTroco) {
    // Recalcula contra o total atual em vez de confiar no que já estava salvo — o carrinho pode ter mudado
    // desde que o cliente informou o valor pago, e a Revisão nunca deve mostrar um troco obsoleto.
    d.troco = calcularTroco(d.valorPago, calcularTotaisPedidoAtual().total);
  }
  const blocoTroco =
    d && d.precisaTroco
      ? `<p>Troco para: ${formatarMoeda(d.valorPago, moeda)}<br/>Troco necessário: ${formatarMoeda(d.troco, moeda)}</p>`
      : '<p>Sem troco</p>';
  return rotulo + blocoTroco;
}

/**
 * Assíncrona porque, ao entrar na Revisão, pode precisar revalidar um cupom aplicado contra o
 * subtotal atual (item 6/18/19 — ver revalidarCupomSeNecessario()). Chamadores fazem `await`.
 */
async function renderizarRevisao() {
  const subtotalParaValidacao = calcularSubtotalCarrinho(obterCarrinho());
  const motivoRemocaoCupom = await revalidarCupomSeNecessario(subtotalParaValidacao);
  salvarProgressoPedido();
  atualizarUiCupom();
  if (motivoRemocaoCupom) {
    mostrarToast('O cupom não é mais válido: ' + motivoRemocaoCupom, 'info');
  }

  const carrinho = obterCarrinho();
  const { subtotal, desconto, taxaEntrega, total, moeda } = calcularTotaisPedidoAtual();

  const linhasItens = carrinho
    .map((item) => {
      if (item.combo) {
        return `<div class="linha-resumo"><span>${escaparHtml(item.combo.nome)}</span><span>${formatarMoeda(item.precoUnitario * item.quantidade, moeda)}</span></div>`;
      }
      const produto = obterProdutoPorId(item.produtoId);
      const nome = produto ? produto.nome : '(produto removido)';
      return `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(nome)}</span><span>${formatarMoeda(item.precoUnitario * item.quantidade, moeda)}</span></div>`;
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
        <p>Horário: ${escaparHtml(rotuloHorarioRetirada(estadoPedido))}</p>
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
      ${blocoPagamentoRevisaoHtml(moeda)}
    </div>
    <div class="card resumo-carrinho">
      <div class="linha-resumo"><span>Subtotal</span><span>${formatarMoeda(subtotal, moeda)}</span></div>
      ${linhaCupomResumoHtml(estadoPedido.cupom ? estadoPedido.cupom.codigo : null, desconto, moeda, estadoPedido.cupom && estadoPedido.cupom.tipoDesconto === 'percentage' ? `${estadoPedido.cupom.valorDesconto}%` : null)}
      <div class="linha-resumo"><span>Taxa de entrega</span><span>${formatarMoeda(taxaEntrega, moeda)}</span></div>
      <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(total, moeda)}</span></div>
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
  const botaoConfirmar = document.getElementById('botao-confirmar-pedido');
  const rotuloOriginalBotao = botaoConfirmar.textContent;

  // Todo o fluxo (validação, montagem do payload e chamada à RPC) fica dentro deste try —
  // qualquer exceção, esperada ou não, cai no catch em vez de morrer em silêncio.
  try {
    const carrinho = obterCarrinho();
    if (carrinho.length === 0) {
      mostrarToast('Seu carrinho está vazio.', 'erro');
      return;
    }

    // Revalidação final (client-side — a proteção real fica pra Fase 4, em create_customer_order):
    // o estado pode ter sido carregado há vários passos atrás, então recalcula contra "agora".
    const disponibilidade = disponibilidadeNegocioAtual();
    if (!disponibilidade.podeFinalizar) {
      mostrarToast(disponibilidade.mensagem, 'erro');
      return;
    }

    if (!estadoPedido.fulfilment) {
      mostrarToast('Escolha retirada ou entrega para continuar.', 'erro');
      return;
    }

    // Reconfere contra os campos atuais (não só o que foi salvo ao sair da etapa de entrega) —
    // mesma lógica de "nunca confiar em cotação potencialmente obsoleta" do item 8/12 do pedido.
    if (estadoPedido.fulfilment === 'entrega' && !cotacaoEntregaValida()) {
      mostrarToast('Calcule a taxa de entrega antes de continuar.', 'erro');
      return;
    }

    const config = obterConfiguracoes();
    const { subtotal, taxaEntrega, total } = calcularTotaisPedidoAtual();

    // Última checagem contra o total atual antes de gastar uma chamada à RPC — o carrinho pode ter
    // mudado desde que o valor pago foi informado (ex.: cliente voltou e editou o pedido).
    if (estadoPedido.formaPagamento === 'dinheiro' && estadoPedido.dinheiro && estadoPedido.dinheiro.precisaTroco) {
      estadoPedido.dinheiro.troco = calcularTroco(estadoPedido.dinheiro.valorPago, total);
      if (estadoPedido.dinheiro.troco === null) {
        mostrarToast('O valor informado para troco deve ser igual ou superior ao total do pedido.', 'erro');
        return;
      }
    }

    if (!pagamentoEstaCompleto()) {
      mostrarToast('Verifique a forma de pagamento antes de confirmar.', 'erro');
      return;
    }

    botaoConfirmar.disabled = true; // evita duplo clique / pedido duplicado enquanto a requisição está em andamento
    botaoConfirmar.textContent = 'Enviando pedido...';

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
      distanciaEntregaKm: distanciaEntregaAtual(),
      deliveryQuoteId: estadoPedido.fulfilment === 'entrega' && estadoPedido.cotacaoEntrega ? estadoPedido.cotacaoEntrega.quoteId : null,
      formaPagamento: estadoPedido.formaPagamento,
      pagamentoDinheiro: estadoPedido.formaPagamento === 'dinheiro' && estadoPedido.dinheiro ? { ...estadoPedido.dinheiro } : null,
      // Só o código (texto puro) — orders-service.js decide se inclui no payload; nunca id/tipo/valor/desconto
      // calculado localmente (item 8/9). create_customer_order é quem recalcula e decide o desconto real.
      cupomCodigo: estadoPedido.cupom ? estadoPedido.cupom.codigo : null,
      subtotal,
      taxaEntrega,
      total,
    };

    ultimoPedidoConfirmado = await criarPedido(pedido, itensPedido);

    limparCarrinho(); // só depois de confirmado o sucesso no Supabase
    atualizarContadorCarrinho();

    // Revolut: pedido já foi criado no banco (payment_status='pending', decidido só por
    // create_customer_order) mas ainda não está "confirmado" — nunca mostrar a mensagem genérica aqui.
    if (ultimoPedidoConfirmado.formaPagamento === 'revolut') {
      renderizarConfirmacaoRevolut(ultimoPedidoConfirmado, config.moeda);
      mostrarToast('Pedido criado! Aguardando confirmação de pagamento.', 'info');
    } else if (ultimoPedidoConfirmado.formaPagamento === 'transferencia') {
      renderizarConfirmacaoTransferencia(ultimoPedidoConfirmado, config.moeda);
      mostrarToast('Pedido criado! Aguardando confirmação de pagamento.', 'info');
    } else {
      renderizarConfirmacao(ultimoPedidoConfirmado, config.moeda);
      mostrarToast('Pedido confirmado!', 'sucesso');
    }

    irParaEtapaPedido('confirmacao');
    localStorage.removeItem(CHAVE_PEDIDO_EM_ANDAMENTO); // etapa de confirmação nunca deve ser restaurada num refresh
    botaoConfirmar.disabled = false;
    botaoConfirmar.textContent = rotuloOriginalBotao;
  } catch (erro) {
    // Mensagem real da RPC sempre chega ao cliente (item 20) — nunca mascarada, mesmo quando o motivo
    // é o cupom (ex.: admin desativou/expirou entre a aplicação e a confirmação, item 13). Pedido NÃO é
    // criado, carrinho continua intacto. Se havia cupom aplicado, ele é limpo defensivamente (pode não
    // ter sido a causa real da falha — ex. estoque —, mas de qualquer forma exige nova revisão/aplicação
    // antes de tentar de novo, nunca reaproveita um estado de cupom que pode estar obsoleto).
    mostrarToast(erro && erro.message ? erro.message : 'Não foi possível finalizar o pedido.', 'erro');
    if (estadoPedido.cupom) {
      estadoPedido.cupom = null;
      await renderizarRevisao();
      mostrarToast('O cupom foi removido — revise seu pedido antes de tentar novamente.', 'info');
    }
    botaoConfirmar.disabled = false;
    botaoConfirmar.textContent = rotuloOriginalBotao;
    // permanece na etapa de revisão, carrinho e dados intactos — pode corrigir e tentar de novo
  }
}

function renderizarConfirmacao(pedido, moeda) {
  document.getElementById('tela-confirmacao-revolut').style.display = 'none';
  document.getElementById('tela-confirmacao-transferencia').style.display = 'none';
  document.getElementById('tela-confirmacao-padrao').style.display = '';

  document.getElementById('numero-pedido-confirmado').textContent = pedido.numero;

  const linhasItens = pedido.itens
    .map((item) => `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>`)
    .join('');

  // Cartão é sempre presencial (não há pagamento online nesta versão) — reforça isso na confirmação.
  const avisoCartao =
    pedido.formaPagamento === 'cartao' ? '<p class="aviso-info">Pagamento na retirada/entrega, presencialmente.</p>' : '';

  document.getElementById('resumo-confirmacao').innerHTML = `
    ${linhasItens}
    <div class="linha-resumo"><span>${pedido.fulfilment === 'entrega' ? 'Entrega' : 'Retirada'}</span><span></span></div>
    <div class="linha-resumo"><span>Pagamento</span><span>${escaparHtml(ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '')}</span></div>
    ${linhaCupomResumoHtml(pedido.codigoCupom, pedido.valorDesconto, moeda, null)}
    <div class="linha-resumo linha-resumo-total"><span>Total</span><span>${formatarMoeda(pedido.total, moeda)}</span></div>
    ${avisoCartao}
  `;
}

/**
 * Tela de confirmação específica pra Revolut — pedido já existe no banco (payment_status='pending'),
 * mas o pagamento ainda não foi confirmado por um staff, então NUNCA mostra "Pagamento confirmado" nem
 * o texto genérico de renderizarConfirmacao(). O QR real vem de renderizarQrRevolut() (Fase 10A/Etapa 4).
 * #status-pagamento-revolut é o ponto que o Realtime (Fase 9/Etapa 5) atualiza depois, sem reconstruir a tela.
 */
function renderizarConfirmacaoRevolut(pedido, moeda) {
  document.getElementById('tela-confirmacao-padrao').style.display = 'none';
  document.getElementById('tela-confirmacao-transferencia').style.display = 'none';
  document.getElementById('tela-confirmacao-revolut').style.display = '';

  // Reseta pro estado "aguardando" — importante se o cliente fizer mais de um pedido Revolut na mesma sessão
  document.getElementById('revolut-icone').textContent = '⏳';
  document.getElementById('revolut-titulo').textContent = 'Aguardando confirmação de pagamento';
  document.getElementById('revolut-instrucao-transferencia').style.display = '';
  document.getElementById('revolut-qr-wrap').style.display = '';
  document.getElementById('status-pagamento-revolut').textContent =
    'Após recebermos o pagamento, confirmaremos seu pedido e ele seguirá para preparo.';

  document.getElementById('numero-pedido-confirmado-revolut').textContent = pedido.numero;
  document.getElementById('revolut-valor-total').textContent = formatarMoeda(pedido.total, moeda);

  renderizarQrRevolut();
  atualizarBotaoCopiarCodigoRevolut();

  // Realtime é só visual — nunca confirma pagamento nem chama a RPC. Se o pedido criado não tiver id
  // (não deveria acontecer) ou a assinatura falhar, o cliente simplesmente continua vendo "Aguardando
  // confirmação" (nunca finge sucesso por fallback).
  if (pedido.id) {
    assinarConfirmacaoRevolut(pedido.id);
  } else {
    cancelarAssinaturaConfirmacaoRevolut();
  }
}

/**
 * Tela de confirmação específica pra Transferência Bancária — mesmo papel de
 * renderizarConfirmacaoRevolut(): pedido já existe no banco (payment_status='pending'), mas o
 * pagamento ainda não foi confirmado por um staff, então nunca mostra "Pagamento confirmado" nem
 * o texto genérico de renderizarConfirmacao(). Dados bancários vêm de configuracoesNegocio
 * (já carregado), nunca hardcoded.
 */
function renderizarConfirmacaoTransferencia(pedido, moeda) {
  document.getElementById('tela-confirmacao-padrao').style.display = 'none';
  document.getElementById('tela-confirmacao-revolut').style.display = 'none';
  document.getElementById('tela-confirmacao-transferencia').style.display = '';

  // Reseta pro estado "aguardando" — importante se o cliente fizer mais de um pedido por transferência na mesma sessão
  document.getElementById('transferencia-icone').textContent = '⏳';
  document.getElementById('transferencia-titulo').textContent = 'Aguardando confirmação de pagamento';
  document.getElementById('transferencia-instrucao').style.display = '';
  document.getElementById('transferencia-dados-wrap').style.display = '';
  document.getElementById('status-pagamento-transferencia').textContent =
    'Após recebermos o pagamento, confirmaremos seu pedido e ele seguirá para preparo.';

  document.getElementById('numero-pedido-confirmado-transferencia').textContent = pedido.numero;
  document.getElementById('transferencia-valor-total').textContent = formatarMoeda(pedido.total, moeda);

  document.getElementById('transferencia-beneficiario-confirmacao').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaBeneficiario) || '—';
  document.getElementById('transferencia-iban-confirmacao').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaIban) || '—';
  document.getElementById('transferencia-bic-confirmacao').textContent = (configuracoesNegocio && configuracoesNegocio.transferenciaBic) || '—';

  // Realtime é só visual — nunca confirma pagamento nem chama a RPC. Mesmo comportamento defensivo de renderizarConfirmacaoRevolut().
  if (pedido.id) {
    assinarConfirmacaoTransferencia(pedido.id);
  } else {
    cancelarAssinaturaConfirmacaoTransferencia();
  }
}

/**
 * Substitui o conteúdo de #revolut-qr-wrap pela imagem real do QR, a partir de
 * configuracoesNegocio.revolutQrPath (já carregado por carregarDisponibilidadeNegocio(), sem nova
 * consulta). Path já é versionado por natureza (Etapa 1/2) — nenhuma querystring de cache-busting
 * extra é necessária. Se não houver path, ou a imagem falhar ao carregar, mostra indisponibilidade —
 * nunca QR fictício/hardcoded, nunca cancela o pedido automaticamente.
 */
function renderizarQrRevolut() {
  const wrap = document.getElementById('revolut-qr-wrap');
  const path = configuracoesNegocio && configuracoesNegocio.revolutQrPath;
  const url = path ? getUrlPublicaQrRevolut(path) : null;

  wrap.innerHTML = '';

  if (!url) {
    exibirQrRevolutIndisponivel(wrap);
    return;
  }

  const img = document.createElement('img');
  img.className = 'qr-revolut-imagem';
  img.alt = 'QR Code para pagamento via Revolut';
  img.onerror = () => exibirQrRevolutIndisponivel(wrap);
  img.src = url;

  const referencia = document.createElement('p');
  referencia.className = 'qr-revolut-referencia';
  referencia.textContent = 'Se o Revolut permitir adicionar referência/nota, use o número do pedido acima.';

  wrap.appendChild(img);
  wrap.appendChild(referencia);
}

/** O pedido já pode ter sido criado nesse ponto — nunca cancela automaticamente, só orienta contato manual */
function exibirQrRevolutIndisponivel(wrap) {
  wrap.innerHTML = '';
  const aviso = document.createElement('p');
  aviso.className = 'aviso-info aviso-atencao';
  aviso.textContent =
    'Pagamento via Revolut temporariamente indisponível. Entre em contato com a equipe para concluir o pagamento.';
  wrap.appendChild(aviso);
}

/**
 * Mostra/esconde a alternativa "Copiar código Revolut" conforme configuracoesNegocio.revolutPaymentCode
 * existir ou não (mesmo cache já carregado por carregarDisponibilidadeNegocio(), sem nova consulta).
 * Compatibilidade com configuração antiga: sem código cadastrado, o bloco simplesmente não aparece — a
 * tela continua mostrando só o QR Code, exatamente como antes desta melhoria.
 */
function atualizarBotaoCopiarCodigoRevolut() {
  const wrap = document.getElementById('revolut-copiar-codigo-wrap');
  const codigo = configuracoesNegocio && configuracoesNegocio.revolutPaymentCode;
  wrap.style.display = codigo ? '' : 'none';
}

/**
 * Copia o código/link Revolut cadastrado em Configurações pro clipboard do cliente — só facilita a
 * transferência manual, nunca confirma pagamento nem substitui o fluxo de confirmação no Kanban.
 */
async function copiarCodigoRevolut() {
  const codigo = (configuracoesNegocio && configuracoesNegocio.revolutPaymentCode) || '';
  if (!codigo) return;

  const botao = document.getElementById('botao-copiar-codigo-revolut');
  const rotuloOriginal = botao.textContent;

  try {
    await copiarTextoParaClipboard(codigo);
    botao.textContent = '✓ Código copiado';
    mostrarToast('Código Revolut copiado.', 'sucesso');
  } catch (erro) {
    mostrarToast('Não foi possível copiar o código. Copie manualmente.', 'erro');
  } finally {
    setTimeout(() => {
      botao.textContent = rotuloOriginal;
    }, 2000);
  }
}

/**
 * Assina UPDATE em public.orders filtrado pelo id do pedido Revolut recém-criado — canal isolado,
 * nome único por pedido, nunca mais de um ativo (ver cancelarAssinaturaConfirmacaoRevolut() logo abaixo).
 * Só reage quando o próprio evento confirma payment_status='paid' — nunca assume isso localmente.
 */
function assinarConfirmacaoRevolut(pedidoId) {
  cancelarAssinaturaConfirmacaoRevolut();
  canalConfirmacaoRevolut = supabaseClient
    .channel('confirmacao-revolut-' + pedidoId)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'orders', filter: 'id=eq.' + pedidoId },
      (payload) => {
        if (payload.new && payload.new.payment_status === 'paid') {
          exibirPagamentoConfirmadoRevolut();
        }
      }
    )
    .subscribe();
}

function cancelarAssinaturaConfirmacaoRevolut() {
  if (canalConfirmacaoRevolut) {
    supabaseClient.removeChannel(canalConfirmacaoRevolut);
    canalConfirmacaoRevolut = null;
  }
}

/** Troca a tela pra "Pagamento confirmado" em resposta a um UPDATE real recebido via Realtime — nunca muda orders.status, nunca chama RPC. */
function exibirPagamentoConfirmadoRevolut() {
  cancelarAssinaturaConfirmacaoRevolut(); // já confirmado, não precisa mais escutar

  document.getElementById('revolut-icone').textContent = '✅';
  document.getElementById('revolut-titulo').textContent = 'Pagamento confirmado';
  document.getElementById('revolut-instrucao-transferencia').style.display = 'none';
  document.getElementById('revolut-qr-wrap').style.display = 'none';
  document.getElementById('status-pagamento-revolut').textContent = 'Seu pedido foi recebido e seguirá para preparo.';
}

/** Mesmo padrão de assinarConfirmacaoRevolut(), canal isolado por pedido, pra Transferência Bancária */
function assinarConfirmacaoTransferencia(pedidoId) {
  cancelarAssinaturaConfirmacaoTransferencia();
  canalConfirmacaoTransferencia = supabaseClient
    .channel('confirmacao-transferencia-' + pedidoId)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'orders', filter: 'id=eq.' + pedidoId },
      (payload) => {
        if (payload.new && payload.new.payment_status === 'paid') {
          exibirPagamentoConfirmadoTransferencia();
        }
      }
    )
    .subscribe();
}

function cancelarAssinaturaConfirmacaoTransferencia() {
  if (canalConfirmacaoTransferencia) {
    supabaseClient.removeChannel(canalConfirmacaoTransferencia);
    canalConfirmacaoTransferencia = null;
  }
}

/** Mesmo padrão de exibirPagamentoConfirmadoRevolut() — nunca muda orders.status, nunca chama RPC */
function exibirPagamentoConfirmadoTransferencia() {
  cancelarAssinaturaConfirmacaoTransferencia(); // já confirmado, não precisa mais escutar

  document.getElementById('transferencia-icone').textContent = '✅';
  document.getElementById('transferencia-titulo').textContent = 'Pagamento confirmado';
  document.getElementById('transferencia-instrucao').style.display = 'none';
  document.getElementById('transferencia-dados-wrap').style.display = 'none';
  document.getElementById('status-pagamento-transferencia').textContent = 'Seu pedido foi recebido e seguirá para preparo.';
}

function reiniciarPedido() {
  cancelarAssinaturaConfirmacaoRevolut(); // único caminho de saída da etapa "confirmação" — nunca deixa canal órfão
  cancelarAssinaturaConfirmacaoTransferencia();
  pilhaEtapasPedido = ['cardapio'];
  estadoPedido = estadoPedidoInicial();
  ultimoPedidoConfirmado = null;
  categoriaSelecionadaPedido = 'Combos';
  localStorage.removeItem(CHAVE_PEDIDO_EM_ANDAMENTO);

  ['retirada-nome', 'retirada-telefone', 'entrega-nome', 'entrega-telefone', 'entrega-eircode', 'entrega-linha1', 'entrega-linha2', 'entrega-area', 'entrega-distrito', 'entrega-instrucoes'].forEach(
    (id) => (document.getElementById(id).value = '')
  );
  document.getElementById('campo-horario-retirada').value = '';
  document.getElementById('grupo-horario-retirada-escolhido').style.display = 'none';
  document
    .querySelectorAll('.opcoes-recebimento .opcao-pagamento, #opcoes-pagamento-pedido .opcao-pagamento')
    .forEach((b) => b.classList.remove('selecionada'));
  resetarDadosPagamentoDinheiro();
  atualizarVisibilidadeSecaoTroco();
  atualizarVisibilidadeDadosTransferencia();
  tokenRevalidacaoCupom++; // invalida qualquer aplicar/revalidar de cupom ainda em andamento do pedido anterior
  document.getElementById('campo-cupom-codigo-pedido').value = '';
  document.getElementById('erro-cupom-pedido').textContent = '';
  document.getElementById('grupo-cupom-input').style.display = '';
  document.getElementById('cupom-aplicado-info').style.display = 'none';
  document.getElementById('botao-continuar-recebimento').disabled = true;
  document.getElementById('botao-continuar-pagamento').disabled = true;
  document.getElementById('botao-continuar-entrega').disabled = false;
  document.getElementById('resultado-calculo-entrega').style.display = 'none';
  document.getElementById('erro-calculo-entrega').textContent = '';
  ['erro-retirada-nome', 'erro-retirada-telefone', 'erro-horario-retirada', 'erro-entrega-nome', 'erro-entrega-telefone', 'erro-entrega-eircode', 'erro-entrega-linha1'].forEach(
    (id) => (document.getElementById(id).textContent = '')
  );

  renderizarFiltroCategoriasPedido();
  renderizarGradePedido();
  mostrarEtapaAtual();
}

window.addEventListener('beforeunload', cancelarAssinaturaConfirmacaoRevolut);
window.addEventListener('beforeunload', cancelarAssinaturaConfirmacaoTransferencia);
