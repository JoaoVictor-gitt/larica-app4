/*
 * pedidos.js
 * Painel operacional de Pedidos (Kanban): Solicitado -> Em Preparo -> Pronto
 * -> Finalizado. Lê/atualiza os mesmos pedidos gravados pela área "Fazer
 * Pedido" (obterPedidosClientes(), storage.js) — nenhuma lógica de status
 * mora aqui, só chama aceitarPedido()/marcarPedidoComoPronto()/
 * concluirPedido() (storage.js), que validam a transição. Depende de
 * utils.js, storage.js e app.js (carregados antes deste).
 */

let filtroTipoPedidos = ''; // '' | 'entrega' | 'comer_no_local' | 'retirada'
let termoBuscaPedidos = '';
let canalPedidosRealtime = null;
let timeoutRecarregarPedidosRealtime = null;

// Som de pedido novo (Fase 6) — preferência local do dispositivo, nunca vai pra business_settings.
const CHAVE_SOM_PEDIDOS_ATIVO = 'caju_som_pedidos_ativo';
let idsPedidosVistos = null; // Set — populado no 1º carregamento bem-sucedido, sem tocar som nesse load
let audioContextPedidos = null;

// Cancelamento de pedido (Fase 7) — id do pedido atualmente aberto no modal de cancelamento
let pedidoCancelamentoId = null;

// Meta de Preparo/SLA (Etapa 3) — carregada 1x em init(), nunca por pedido. null enquanto não carrega
// (ou se a leitura falhar) — nesse caso os indicadores de meta simplesmente não aparecem nos cards,
// sem quebrar o resto da tela (ver calcularTemposPedido()).
let metaPreparoMinutos = null;

// Impressão automática de novos pedidos — carregada 1x em init(), igual à meta de preparo. Ambas
// false/null enquanto não carrega (ou se a leitura falhar) — nesse caso nunca escaneia candidatos,
// nunca imprime automaticamente por engano. Ver seção "Impressão automática" mais abaixo.
let _impressaoAutomaticaAtiva = false;
let _impressaoAutomaticaAtivadaEm = null; // ISO string — pedidos criados antes disso nunca são candidatos

// Fallback do Realtime — recuperação caso o canal pare/seja suspenso (ex.: aba em segundo plano
// no iPad/Safari) ou perca um evento. Ver iniciarPollingPedidos()/reloadOrders() mais abaixo.
let _reloadOrdersEmAndamento = false; // lock separado de _impressaoEmAndamento — nunca 2 reloadOrders() em voo ao mesmo tempo
let _intervaloPollingPedidos = null;
const INTERVALO_POLLING_PEDIDOS_MS = 5000;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  _deviceIdImpressora = obterDeviceIdImpressora();

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

  // Meta de preparo — carregamento independente do resto (uma falha aqui não pode derrubar o
  // Kanban); coluna própria fora da lista pública de business_settings (ver settings-service.js).
  try {
    metaPreparoMinutos = await buscarMetaPreparoDoSupabase();
  } catch (erroMeta) {
    console.error('Não foi possível carregar a meta de preparo:', erroMeta);
  }

  // Impressão automática — mesmo padrão defensivo da meta de preparo: falha aqui nunca derruba o
  // Kanban, só deixa _impressaoAutomaticaAtiva em false (nenhum candidato é escaneado).
  await atualizarConfiguracaoImpressaoAutomatica();

  kanban.style.display = '';
  renderizarQuadroPedidos();
  ligarEventosFiltrosPedidos();
  ligarEventosModalPedido();
  ligarEventosModalCancelamento();
  ligarEventosSomPedidos();
  // Atualiza "há X min" e o alerta de demora sozinho enquanto a página estiver aberta (não busca dado novo, só redesenha o cache atual)
  setInterval(renderizarQuadroPedidos, 30000);

  iniciarRealtimePedidos();
  iniciarPollingPedidos();
  // 1ª varredura logo após a carga inicial — pega tanto pedidos represados (impressora ficou
  // desligada, feature acabou de ser ligada) quanto o caso comum de nada pendente.
  escanearCandidatosImpressaoAutomatica();
}

/**
 * Uma única subscription pra mudanças em `orders`. Cada evento (INSERT/
 * UPDATE/DELETE) agenda um recarregamento debounced — se vários eventos
 * chegarem juntos, só uma recarga é feita, evitando refazer as 3 consultas
 * repetidamente à toa.
 */
function iniciarRealtimePedidos() {
  if (canalPedidosRealtime) return;
  canalPedidosRealtime = subscribeToOrders(
    () => {
      clearTimeout(timeoutRecarregarPedidosRealtime);
      timeoutRecarregarPedidosRealtime = setTimeout(reloadOrders, 400);
    },
    (status) => {
      // Só logging — o SDK do Supabase já gerencia reconexão sozinho, nenhuma reconexão manual aqui.
      console.log('[pedidos] Realtime canal de pedidos:', status);
    }
  );
}

async function reloadOrders() {
  if (_reloadOrdersEmAndamento) return;
  _reloadOrdersEmAndamento = true;
  try {
    await carregarPedidosClientesCache();
    // Reconsulta o toggle a cada reload — uma aba de /pedidos já aberta antes de alguém ligar/
    // desligar em Configurações (em outra aba/dispositivo) precisa enxergar a mudança sem refresh.
    await atualizarConfiguracaoImpressaoAutomatica();
    detectarPedidosNovos();
    renderizarQuadroPedidos();
    escanearCandidatosImpressaoAutomatica();
  } catch (erro) {
    console.error('Erro ao recarregar pedidos (realtime/polling):', erro);
  } finally {
    _reloadOrdersEmAndamento = false;
  }
}

/**
 * Fallback do Realtime — recuperação caso o canal pare, seja suspenso (ex.: aba em segundo
 * plano no iPad/Safari) ou perca um evento. Reaproveita reloadOrders() (mesmo fluxo de sempre:
 * recarrega pedidos, atualiza auto_print_enabled, renderiza, escaneia candidatos) — nunca cria
 * um segundo caminho de impressão. Só age com a página visível; reloadOrders() já se protege
 * sozinho contra sobreposição com o Realtime via _reloadOrdersEmAndamento.
 */
function iniciarPollingPedidos() {
  if (_intervaloPollingPedidos) return;
  _intervaloPollingPedidos = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    reloadOrders();
  }, INTERVALO_POLLING_PEDIDOS_MS);
}

/**
 * Busca o estado atual de auto_print_enabled/auto_print_enabled_at e atualiza as variáveis em
 * memória — reaproveitada por init() e por todo reloadOrders(), nunca duplicada.
 *
 * Fail-safe: se a consulta falhar, força _impressaoAutomaticaAtiva = false e
 * _impressaoAutomaticaAtivadaEm = null NESTE ciclo — nunca reaproveita um `true`/data antigos que
 * possam estar desatualizados. Nunca lança (erro é só logado), então uma falha aqui nunca impede
 * o resto de reloadOrders()/init() de continuar — pedidos sempre aparecem no painel normalmente,
 * só a impressão automática fica pausada até o próximo ciclo bem-sucedido.
 */
async function atualizarConfiguracaoImpressaoAutomatica() {
  try {
    const config = await buscarImpressaoAutomaticaDoSupabase();
    _impressaoAutomaticaAtiva = config.ativa;
    _impressaoAutomaticaAtivadaEm = config.ativadaEm;
  } catch (erro) {
    console.error('Não foi possível carregar a configuração de impressão automática:', erro);
    _impressaoAutomaticaAtiva = false;
    _impressaoAutomaticaAtivadaEm = null;
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

// Fallback do Realtime pra iPad/Safari: ao voltar de segundo plano (troca de app, bloqueio de
// tela), o canal pode ter sido suspenso/perdido eventos — força uma recarga imediata.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reloadOrders();
  }
});

/**
 * Limpa timers/subscription do painel — chamada em beforeunload e pagehide (iPad/Safari nem
 * sempre dispara beforeunload ao trocar de app/bloquear a tela). Segura contra chamadas
 * repetidas: clearTimeout/clearInterval em ids já limpos são no-ops do próprio JS, e
 * _intervaloPollingPedidos/canalPedidosRealtime são zerados depois de usados — uma 2ª chamada
 * vê tudo null e não faz nada (unsubscribeFromOrders já checa `if (canal)` internamente).
 */
function limparRecursosPedidos() {
  clearTimeout(timeoutRecarregarPedidosRealtime);
  clearInterval(_intervaloPollingPedidos);
  _intervaloPollingPedidos = null;
  unsubscribeFromOrders(canalPedidosRealtime);
  canalPedidosRealtime = null;
}

window.addEventListener('beforeunload', limparRecursosPedidos);
window.addEventListener('pagehide', limparRecursosPedidos);

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
  lista.querySelectorAll('[data-acao="imprimir"]').forEach((botao) => {
    botao.addEventListener('click', () => iniciarImpressaoPedido(botao.dataset.id));
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
// Impressão de comanda
// ---------------------------------------------------------------------------
//
// Lock global (_impressaoEmAndamento) — não é "desabilitar o botão clicado":
// enquanto true, TODO botão Imprimir/Reimprimir nasce desabilitado, mesmo os
// recriados por um re-render do Kanban (setInterval de 30s ou Realtime) ou
// reabertos no modal — porque cardPedidoHtml() e aplicarBloqueioBotoesImpressao()
// leem esta variável a cada desenho, em vez de depender de um estado por-botão
// que um re-render apagaria. iniciarImpressaoPedido() recebe só o id (nunca um
// elemento de botão), então duas chamadas concorrentes — clique duplo, clique
// em outro pedido, ou chamada programática — são resolvidas pelo mesmo guard,
// sem depender do atributo disabled do HTML.

// Feature flag — enquanto false, EpsonPrinterService/gerarComandaEposPrintXml
// NUNCA são chamados por nenhum caminho a partir do clique em Imprimir/Reimprimir.
// O SDK/builder/service já estão carregados (pedidos.html), mas ficam como código
// morto até isto virar true — nenhum fetch pra Epson acontece com a flag em false.
const IMPRESSAO_EPSON_DIRETA_ATIVA = true;

let _impressaoEmAndamento = false;
let _pedidoIdImpressaoPendente = null;

/**
 * Ponto único de entrada, compartilhado pelos dois caminhos (AirPrint e Epson
 * direta) — aquisição do pedido, snapshot e lock acontecem exatamente uma vez
 * aqui, nunca duplicados entre os dois. A escolha do caminho é decidida uma
 * única vez, pela flag; nenhuma das duas tentativas pode coexistir com a outra.
 */
function iniciarImpressaoPedido(id) {
  if (_impressaoEmAndamento) {
    mostrarToast('Já existe uma impressão em andamento.', 'erro');
    return;
  }

  const pedido = obterPedidoClientePorId(id);
  if (!pedido) return;

  // Snapshot próprio, desconectado do cache — o Realtime pode substituir
  // _cachePedidosClientes inteiro enquanto a tentativa estiver em andamento;
  // a comanda já montada (e, no caminho AirPrint, o id confirmado depois no
  // afterprint) nunca dependem desse objeto mutável de novo.
  const snapshot = JSON.parse(JSON.stringify(pedido));

  _impressaoEmAndamento = true;
  _pedidoIdImpressaoPendente = id;
  aplicarBloqueioBotoesImpressao();

  if (IMPRESSAO_EPSON_DIRETA_ATIVA) {
    _iniciarTentativaEpsonDireta(id, snapshot);
  } else {
    _iniciarTentativaAirPrint(snapshot);
  }
}

/** Caminho atual (único ativo em produção hoje) — exatamente as mesmas 2 linhas que já existiam em iniciarImpressaoPedido(). */
function _iniciarTentativaAirPrint(snapshot) {
  renderizarComandaParaImpressao(snapshot);
  window.print();
}

// Único listener global, registrado uma única vez — nunca duplicado por
// render. Como _pedidoIdImpressaoPendente só é lido aqui (nunca escrito por
// mais ninguém enquanto _impressaoEmAndamento é true), o id confirmado é
// exatamente o capturado no início deste job. Pertence exclusivamente ao
// caminho AirPrint — a tentativa Epson direta nunca depende deste evento.
window.addEventListener('afterprint', () => {
  if (!_impressaoEmAndamento) return;
  const id = _pedidoIdImpressaoPendente;

  // O navegador não informa se o trabalho chegou na impressora física —
  // afterprint só diz que a folha de impressão fechou (inclusive se o
  // usuário cancelou). Confirmação humana é o sinal mais confiável
  // disponível nessa arquitetura (sem bridge local).
  if (confirm('A comanda foi impressa corretamente?')) {
    _registrarImpressaoEFinalizar(id);
  } else {
    mostrarToast('Impressão não registrada. Toque em Imprimir/Reimprimir pra tentar de novo.', 'erro');
    finalizarImpressaoPedido();
  }
});

/**
 * Chama register_order_print e finaliza — único lugar que faz isso, reaproveitado
 * pelo "Sim" do afterprint (AirPrint) e pelo caminho Epson (SUCESSO/"Já imprimiu"),
 * pra nunca duplicar a mesma sequência RPC→toast→finalizar em 3 lugares diferentes.
 * mensagemFalhaRpc permite uma mensagem mais específica quando quem chama já sabe
 * que a impressão física foi confirmada por outro meio (ex.: Epson respondeu sucesso).
 */
function _registrarImpressaoEFinalizar(id, mensagemFalhaRpc) {
  return registrarImpressaoPedido(id)
    .then(() => mostrarToast('Impressão registrada.', 'sucesso'))
    .catch((erro) => mostrarToast(mensagemFalhaRpc || erro.message || 'Não foi possível registrar a impressão.', 'erro'))
    .finally(finalizarImpressaoPedido);
}

// ---------------------------------------------------------------------------
// Impressão direta Epson (ePOS-Print via EpsonPrinterService) — só alcançável
// quando IMPRESSAO_EPSON_DIRETA_ATIVA === true. Nenhuma função abaixo é chamada
// por nenhum outro lugar do arquivo enquanto a flag estiver false.
// ---------------------------------------------------------------------------

/**
 * gerarComandaEposPrintXml()/EpsonPrinterService.imprimir() só são chamados
 * aqui dentro — nunca em iniciarImpressaoPedido() diretamente, nem em nenhum
 * handler de clique. id/snapshot chegam por parâmetro (já capturados por
 * iniciarImpressaoPedido()); esta função nunca lê nem depende de
 * _pedidoIdImpressaoPendente, que é exclusivo do fluxo AirPrint/afterprint.
 */
async function _iniciarTentativaEpsonDireta(id, snapshot) {
  let xml;
  try {
    xml = gerarComandaEposPrintXml(snapshot);
  } catch (erroBuilder) {
    mostrarToast('Não foi possível montar a comanda para a Epson: ' + (erroBuilder && erroBuilder.message ? erroBuilder.message : erroBuilder), 'erro');
    finalizarImpressaoPedido();
    return;
  }

  const resultado = await EpsonPrinterService.imprimir(xml);

  switch (resultado.codigo) {
    case 'SUCESSO':
      // Impressão confirmada pela impressora — só agora chama a RPC, nunca antes.
      _registrarImpressaoEFinalizar(
        id,
        'A comanda foi enviada e confirmada pela impressora, mas não foi possível registrar a impressão no sistema.'
      );
      break;
    case 'TIMEOUT':
    case 'ERRO_REDE':
      _epsonTratarResultadoAmbiguo(id, snapshot, resultado);
      break;
    case 'EPSON_REJEITOU':
    case 'HTTP_ERRO':
    case 'XML_INVALIDO':
    default:
      _epsonTratarResultadoErro(id, snapshot, resultado);
      break;
  }
}

/**
 * TIMEOUT/ERRO_REDE — resultado ambíguo: o navegador não sabe dizer se a
 * impressora recebeu/imprimiu. Nenhuma das 4 opções roda sozinha; todas
 * exigem uma escolha explícita do operador (confirm() nativo, mesmo padrão
 * já usado no restante do painel). Interface provisória — pode virar um
 * modal dedicado quando a flag for ativada de verdade; a lógica abaixo já
 * está completa e correta, só falta um visual melhor no futuro.
 */
function _epsonTratarResultadoAmbiguo(id, snapshot, resultado) {
  const mensagem = 'Não foi possível confirmar se a comanda foi impressa. Verifique a impressora antes de tentar novamente.';

  if (confirm(mensagem + '\n\nVocê já verificou fisicamente e a comanda SAIU impressa?')) {
    // "Já imprimiu" — registra sem imprimir de novo.
    _registrarImpressaoEFinalizar(id);
    return;
  }

  if (confirm('Tentar imprimir novamente pela Epson agora?')) {
    // "Tentar novamente" — encerra COMPLETAMENTE a tentativa atual (libera o lock)
    // e só depois disso inicia uma tentativa nova e independente.
    finalizarImpressaoPedido();
    iniciarImpressaoPedido(id);
    return;
  }

  if (confirm('Imprimir pelo navegador (AirPrint) agora?')) {
    // "Imprimir pelo navegador" — encerra o estado da tentativa Epson (a chamada já
    // terminou, não há mais nada "em voo") e entra no fluxo AirPrint existente sem
    // soltar o lock: o mesmo snapshot já capturado segue pro afterprint normal, que
    // vai chamar finalizarImpressaoPedido() sozinho quando aquele fluxo terminar.
    _iniciarTentativaAirPrint(snapshot);
    return;
  }

  // "Cancelar" — não registra, não imprime de novo.
  mostrarToast('Impressão não registrada. Toque em Imprimir/Reimprimir pra tentar de novo.', 'erro');
  finalizarImpressaoPedido();
}

/**
 * EPSON_REJEITOU/HTTP_ERRO/XML_INVALIDO — a impressora respondeu (ou o HTTP/XML
 * já são conhecidos), então não há a mesma ambiguidade do timeout/erro de rede.
 * Nunca chama a RPC. Nunca reenvia sozinho. Nunca inventa tradução para
 * atributosEpson desconhecidos — só exibe o que veio, cru, pra diagnóstico.
 */
function _epsonTratarResultadoErro(id, snapshot, resultado) {
  let detalhe = resultado.mensagem || 'A impressora não confirmou a impressão.';
  if (resultado.resposta && resultado.resposta.atributosEpson) {
    detalhe += ' Detalhes: ' + JSON.stringify(resultado.resposta.atributosEpson);
  }

  if (confirm(detalhe + '\n\nTentar imprimir novamente pela Epson?')) {
    finalizarImpressaoPedido();
    iniciarImpressaoPedido(id);
    return;
  }

  if (confirm('Imprimir pelo navegador (AirPrint) agora?')) {
    _iniciarTentativaAirPrint(snapshot);
    return;
  }

  mostrarToast('Impressão não registrada. Toque em Imprimir/Reimprimir pra tentar de novo.', 'erro');
  finalizarImpressaoPedido();
}

/**
 * Único ponto de liberação do lock — roda sempre (RPC ok, RPC falhou, ou
 * usuário respondeu "Não"). Nunca depende da referência do botão original:
 * redesenha o Kanban inteiro (cardPedidoHtml() já nasce com o disabled certo,
 * pois lê _impressaoEmAndamento) e reaplica o estado no botão do modal à
 * parte, porque o modal não é recriado por renderizarQuadroPedidos().
 */
function finalizarImpressaoPedido() {
  _impressaoEmAndamento = false;
  _pedidoIdImpressaoPendente = null;
  aplicarBloqueioBotoesImpressao();
  renderizarQuadroPedidos();
  // Libera a vez do próximo candidato da fila de impressão automática, se houver — roda tanto
  // depois de um print manual (AirPrint/Epson) quanto de um automático, sempre que o lock solta.
  processarFilaImpressaoAutomatica();
}

/** Aplica o lock atual ao botão de imprimir do modal "Ver pedido" — os botões do Kanban se resolvem sozinhos em cardPedidoHtml() a cada render. */
function aplicarBloqueioBotoesImpressao() {
  const botaoModal = document.getElementById('botao-imprimir-pedido-detalhe');
  if (!botaoModal) return;
  botaoModal.disabled = _impressaoEmAndamento;
  const pedidoModal = obterPedidoClientePorId(botaoModal.dataset.id);
  if (pedidoModal) botaoModal.textContent = pedidoModal.qtdImpressoes > 0 ? '🖨️ Reimprimir' : '🖨️ Imprimir';
}

// ---------------------------------------------------------------------------
// Impressão automática de novos pedidos (Epson direta)
//
// Caminho IRMÃO de iniciarImpressaoPedido() — nunca chamado a partir do clique
// em Imprimir/Reimprimir, nunca chama iniciarImpressaoPedido(). Reaproveita
// _impressaoEmAndamento só pra garantir exclusão mútua com um print manual NA
// MESMA aba (a impressora física é um recurso só, um trabalho de cada vez);
// entre abas/dispositivos diferentes, a única proteção real é o claim atômico
// no Supabase (claim_order_auto_print) — _impressaoEmAndamento de uma aba não
// enxerga nem afeta a de outra.
//
// "Candidato" é decidido inteiramente por campos do próprio pedido (nunca por
// "isso é novo pra essa aba", que é o padrão frágil já usado só pro som —
// idsPedidosVistos — e que não seria seguro aqui): impressoEm nulo,
// autoPrintStatus nulo, não cancelado, e criado depois da última ativação do
// toggle. Isso garante que reabrir/atualizar a página, reconectar o Realtime,
// ou reindexar o mesmo id 2x nunca reconsidera um pedido já resolvido — e que
// pedidos anteriores à ativação nunca entram na fila, mesmo que nunca tenham
// sido impressos.
// ---------------------------------------------------------------------------

const CHAVE_DEVICE_ID_IMPRESSORA = 'larica_printer_device_id';
let _deviceIdImpressora = null;

/** UUID persistente por navegador/dispositivo (nunca por aba) — gerado uma vez, reaproveitado depois via localStorage. */
function obterDeviceIdImpressora() {
  try {
    let id = localStorage.getItem(CHAVE_DEVICE_ID_IMPRESSORA);
    if (!id) {
      id = gerarId(); // js/utils.js — já usa crypto.randomUUID() com fallback seguro
      localStorage.setItem(CHAVE_DEVICE_ID_IMPRESSORA, id);
    }
    return id;
  } catch (erro) {
    // localStorage indisponível (modo privado raro/quota) — id só desta sessão, nunca quebra a página.
    return gerarId();
  }
}

let _filaImpressaoAutomatica = []; // ids aguardando tentativa, nesta aba
const _idsImpressaoAutomaticaEmFilaOuTentados = new Set(); // evita enfileirar o mesmo id 2x enquanto não resolvido

/** Único ponto que decide se um pedido pode ser candidato — mesma regra tanto ao escanear quanto ao revalidar na hora de tentar. */
function pedidoEhCandidatoImpressaoAutomatica(pedido) {
  if (!_impressaoAutomaticaAtiva || !_impressaoAutomaticaAtivadaEm) return false;
  if (!IMPRESSAO_EPSON_DIRETA_ATIVA) return false; // impressão automática só existe pelo caminho Epson direto
  if (pedido.impressoEm) return false;
  if (pedido.autoPrintStatus) return false; // claimed/succeeded/failed/ambiguous — nunca reconsiderado aqui
  if (pedido.status === STATUS_PEDIDO.CANCELADO) return false;
  return new Date(pedido.criadoEm).getTime() >= new Date(_impressaoAutomaticaAtivadaEm).getTime();
}

/** Chamado após init() e após todo reloadOrders() (nunca dentro de renderizarQuadroPedidos(), que só redesenha o cache atual). */
function escanearCandidatosImpressaoAutomatica() {
  if (!_impressaoAutomaticaAtiva) return;
  obterPedidosClientes().forEach((pedido) => {
    if (_idsImpressaoAutomaticaEmFilaOuTentados.has(pedido.id)) return;
    if (!pedidoEhCandidatoImpressaoAutomatica(pedido)) return;
    _idsImpressaoAutomaticaEmFilaOuTentados.add(pedido.id);
    _filaImpressaoAutomatica.push(pedido.id);
  });
  processarFilaImpressaoAutomatica();
}

/** Só avança quando a impressora (representada por _impressaoEmAndamento) está livre — nunca 2 tentativas ao mesmo tempo nesta aba. */
function processarFilaImpressaoAutomatica() {
  if (_impressaoEmAndamento) return;
  const id = _filaImpressaoAutomatica.shift();
  if (!id) return;
  iniciarImpressaoAutomaticaPedido(id);
}

/**
 * Uma tentativa completa de impressão automática de UM pedido. Usa o mesmo
 * builder/serviço do caminho manual (gerarComandaEposPrintXml/EpsonPrinterService),
 * inalterados. Nunca chama iniciarImpressaoPedido()/_iniciarTentativaEpsonDireta() —
 * caminho paralelo, não uma variação deles.
 */
async function iniciarImpressaoAutomaticaPedido(id) {
  const pedido = obterPedidoClientePorId(id);
  if (!pedido || !pedidoEhCandidatoImpressaoAutomatica(pedido)) {
    // Já não é mais candidato (impresso/cancelado/claim resolvido nesse meio-tempo) — não é erro.
    processarFilaImpressaoAutomatica();
    return;
  }

  const snapshot = JSON.parse(JSON.stringify(pedido));
  _impressaoEmAndamento = true;
  aplicarBloqueioBotoesImpressao();

  let resultadoClaim;
  try {
    resultadoClaim = await claimOrderAutoPrintNoSupabase(id, _deviceIdImpressora);
  } catch (erroClaim) {
    console.error('Erro ao reivindicar impressão automática do pedido ' + id + ':', erroClaim);
    finalizarImpressaoPedido();
    return;
  }

  if (!resultadoClaim.claimed) {
    // Outro dispositivo já reivindicou, ou um humano já imprimiu manualmente, ou a impressão
    // automática foi desativada entre o escaneamento e agora — resultado esperado, não é erro.
    finalizarImpressaoPedido();
    return;
  }

  let xml;
  try {
    xml = gerarComandaEposPrintXml(snapshot);
  } catch (erroBuilder) {
    console.error('Não foi possível montar a comanda para impressão automática:', erroBuilder);
    await _resolverImpressaoAutomaticaSemLancar(id, 'failed');
    finalizarImpressaoPedido();
    return;
  }

  const resultado = await EpsonPrinterService.imprimir(xml);

  if (resultado.codigo === 'SUCESSO') {
    await _resolverImpressaoAutomaticaSemLancar(id, 'succeeded');
    // Mesmo helper do caminho manual — RPC register_order_print, toast e finalizarImpressaoPedido()
    // (que já avança a fila) rodam exatamente como numa impressão manual bem-sucedida.
    _registrarImpressaoEFinalizar(
      id,
      'A comanda foi enviada e confirmada pela impressora, mas não foi possível registrar a impressão automática no sistema.'
    );
    return;
  }

  // TIMEOUT/ERRO_REDE = ambíguo (a impressora pode ter impresso); qualquer outro código = falha
  // definitiva. Nos dois casos: nunca chama register_order_print, nunca reenvia sozinho.
  const statusResolucao = resultado.codigo === 'TIMEOUT' || resultado.codigo === 'ERRO_REDE' ? 'ambiguous' : 'failed';
  await _resolverImpressaoAutomaticaSemLancar(id, statusResolucao);
  finalizarImpressaoPedido();
}

/** Grava o resultado terminal do claim; nunca lança — uma falha ao gravar não pode travar o lock nem a fila. */
async function _resolverImpressaoAutomaticaSemLancar(id, status) {
  try {
    await resolveOrderAutoPrintNoSupabase(id, _deviceIdImpressora, status);
  } catch (erroResolver) {
    console.error('Não foi possível registrar o resultado (' + status + ') da impressão automática do pedido ' + id + ':', erroResolver);
    // Segue mesmo assim — o pedido fica "claimed" sem resolução, tratado como ambíguo na UI (ver
    // alertaImpressaoAutomaticaHtml) e nunca reconsiderado automaticamente por nenhum dispositivo.
  }
  try {
    await carregarPedidosClientesCache(); // traz o autoPrintStatus novo antes do próximo render
  } catch (erroRecarregar) {
    console.error('Não foi possível recarregar pedidos após resolver impressão automática:', erroRecarregar);
  }
}

// Um claim 'claimed' sem resolução por tempo demais (aba fechou/recarregou entre o claim e o
// resolve) é tratado igual a 'ambiguous' na UI — mesmo destaque, sem inventar outro estado no banco.
const MINUTOS_CLAIM_IMPRESSAO_AUTOMATICA_TRAVADO = 5;

/** HTML do alerta de impressão automática pro card do Kanban — '' quando não há nada a destacar. */
function alertaImpressaoAutomaticaHtml(pedido) {
  if (pedido.impressoEm) return ''; // já impresso (manual ou automático) — nunca mostra alerta
  if (pedido.autoPrintStatus === 'failed') {
    return '<div class="alerta-impressao-automatica alerta-impressao-erro">⚠️ Impressão automática falhou — imprimir manualmente</div>';
  }
  if (pedido.autoPrintStatus === 'ambiguous') {
    return '<div class="alerta-impressao-automatica alerta-impressao-ambiguo">⚠️ Verifique a impressora antes de reimprimir</div>';
  }
  if (pedido.autoPrintStatus === 'claimed') {
    const minutosDesdeClaim = pedido.autoPrintClaimedAt
      ? (Date.now() - new Date(pedido.autoPrintClaimedAt).getTime()) / 60000
      : Infinity;
    if (minutosDesdeClaim >= MINUTOS_CLAIM_IMPRESSAO_AUTOMATICA_TRAVADO) {
      return '<div class="alerta-impressao-automatica alerta-impressao-ambiguo">⚠️ Verifique a impressora antes de reimprimir</div>';
    }
  }
  return '';
}

function renderizarComandaParaImpressao(pedido) {
  const cliente = pedido.cliente || {};
  const endereco = pedido.endereco || {};
  const ehEntrega = pedido.fulfilment === 'entrega';
  const moeda = obterConfiguracoes().moeda;
  const horarioSolicitado = !ehEntrega && pedido.retirada && pedido.retirada.modo === 'horario' ? pedido.retirada.horario : null;
  // 3 modalidades nomeadas explicitamente — nunca um "ehEntrega ? X : Y" tratando comer_no_local como retirada.
  const ROTULO_TIPO_COMANDA = { entrega: 'ENTREGA', comer_no_local: 'COMER NO LOCAL', retirada: 'RETIRADA' };

  document.getElementById('comanda-impressao').innerHTML = `
    <div class="comanda-cabecalho">
      <div class="comanda-marca">LARICA</div>
      <div class="comanda-subtitulo">ORDEM DE PEDIDO</div>
    </div>
    <div class="comanda-numero">${escaparHtml(pedido.numero)}</div>
    <div class="comanda-linha-info">${formatarData(pedido.criadoEm)} - ${formatarHora(pedido.criadoEm)}</div>
    <div class="comanda-tipo">${ROTULO_TIPO_COMANDA[pedido.fulfilment] || 'RETIRADA'}</div>
    <hr/>
    <div class="comanda-itens">${linhasItensPedidoHtml(pedido)}</div>
    ${
      ehEntrega && endereco.instrucoes
        ? `<hr/><div class="comanda-observacoes">
             <div class="comanda-observacoes-titulo">OBSERVAÇÕES DE ENTREGA</div>
             <div>${escaparHtml(endereco.instrucoes)}</div>
           </div>`
        : ''
    }
    <hr/>
    ${
      ehEntrega
        ? `<div class="comanda-endereco">
             <div>${escaparHtml(endereco.eircode || '')}</div>
             <div>${escaparHtml(endereco.linha1 || '')}${endereco.linha2 ? ', ' + escaparHtml(endereco.linha2) : ''}</div>
             <div>${escaparHtml(endereco.area || '')}</div>
             <div>${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</div>
           </div>`
        : `<div class="comanda-cliente">${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}</div>`
    }
    <hr/>
    <div class="comanda-total">TOTAL: ${formatarMoeda(pedido.total, moeda)}</div>
    <div class="comanda-pagamento">Pagamento: ${escaparHtml((ROTULOS_FORMA_PAGAMENTO[pedido.formaPagamento] || '').toUpperCase())}</div>
    ${
      horarioSolicitado
        ? `<hr/><div class="comanda-horario-solicitado">
             <div class="comanda-horario-rotulo">HORÁRIO SOLICITADO</div>
             <div class="comanda-horario-valor">${escaparHtml(horarioSolicitado)}</div>
           </div>`
        : ''
    }
  `;
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
    pedido.fulfilment === 'entrega'
      ? '🚗 Entrega'
      : pedido.fulfilment === 'comer_no_local'
      ? '🍽️ Comer no local'
      : `📍 Retirada · ${escaparHtml(rotuloCompactoHorarioRetirada(pedido))}`;
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
      ${blocoTemposPedidoHtml(pedido)}
      <div class="card-pedido-pagamento">${rotuloPagamentoCompacto(pedido)}</div>
      ${alertaImpressaoAutomaticaHtml(pedido)}
      ${pedido.status === STATUS_PEDIDO.PRONTO ? blocoProntoParaHtml(pedido) : ''}
      <div class="card-pedido-rodape">
        <span>${totalItens} ${totalItens === 1 ? 'item' : 'itens'}</span>
        <span>${formatarMoeda(pedido.total, moeda)}</span>
      </div>
      <div class="card-pedido-acoes">
        <button type="button" class="btn btn-secundario" data-acao="ver" data-id="${pedido.id}">Ver pedido</button>
        <button type="button" class="btn btn-secundario" data-acao="imprimir" data-id="${pedido.id}" ${_impressaoEmAndamento ? 'disabled' : ''}>${pedido.qtdImpressoes > 0 ? '🖨️ Reimprimir' : '🖨️ Imprimir'}</button>
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

// ---------------------------------------------------------------------------
// Tempo de Preparo (Etapa 1) — accepted_at/ready_at/completed_at já são
// gravados server-side por update_order_status() (confirmado no diagnóstico:
// FOR UPDATE, sem regressão de status, sem trigger customizado). Aqui só
// calculamos e exibimos a diferença — nunca gravamos hora nenhuma pelo
// navegador. O timer "ao vivo" pra requested/preparing é só a re-renderização
// já existente (setInterval(renderizarQuadroPedidos, 30000) em init() e o
// reload do Realtime), que já roda pra atualizar "há X min" — não criamos
// um segundo timer.
// ---------------------------------------------------------------------------

/**
 * Diferença em segundos entre dois instantes ISO, ou null se algum estiver ausente, for inválido, ou
 * se `fimIso` vier antes de `inicioIso` (item 21 — timestamp historicamente inconsistente nunca vira
 * duração negativa na tela; console.warn técnico pra diagnóstico, sem quebrar nada). Nunca usa o
 * fallback aceitoEm||criadoEm de obterTimestampEtapaAtual() — aqui os campos crus entram direto,
 * porque um accepted_at NULL precisa continuar sendo "sem dado" (—), nunca virar "0s de espera"
 * (item 22).
 */
function diferencaSegundos(inicioIso, fimIso) {
  if (!inicioIso || !fimIso) return null;
  const inicio = new Date(inicioIso).getTime();
  const fim = new Date(fimIso).getTime();
  if (isNaN(inicio) || isNaN(fim)) return null;

  const diffSegundos = (fim - inicio) / 1000;
  if (diffSegundos < 0) {
    console.warn('[Pedidos] Timestamp inconsistente ao calcular tempo de preparo — fim anterior ao início.', { inicioIso, fimIso });
    return null;
  }
  return diffSegundos;
}

/**
 * Tempos operacionais do pedido (item 1): espera (criadoEm->aceitoEm), preparo (aceitoEm->prontoEm) e
 * ateFicarPronto (criadoEm->prontoEm), mais ateFinalizar (criadoEm->finalizadoEm, secundário, só
 * quando finalizado). requested/preparing usam "agora" pro lado ainda aberto — dinâmico, recalculado a
 * cada chamada, nunca gravado; ready/completed usam só timestamps fechados do banco, nunca mais mudam.
 * Não é chamado para pedido cancelado (a coluna Kanban nunca renderiza cancelados, ver
 * renderizarQuadroPedidos) — decisão deliberada de não criar UI especial de cancelamento nesta etapa.
 *
 * `dentroDaMeta` (Etapa 3 — Meta/SLA): null se a meta não carregou ou o preparo ainda não tem valor
 * (requested, item 16: meta nunca se aplica antes de accepted_at); caso contrário, compara o `preparo`
 * calculado acima (sempre accepted_at-based, nunca created_at-based) contra metaPreparoMinutos*60 — pra
 * preparing é dinâmico (mesmo timer de renderizarQuadroPedidos, sem setInterval novo); pra ready/
 * completed é o valor histórico fechado.
 */
function calcularTemposPedido(pedido) {
  const agoraIso = new Date().toISOString();

  if (pedido.status === STATUS_PEDIDO.SOLICITADO) {
    return { espera: diferencaSegundos(pedido.criadoEm, agoraIso), preparo: null, ateFicarPronto: null, ateFinalizar: null, dentroDaMeta: null };
  }

  if (pedido.status === STATUS_PEDIDO.EM_PREPARO) {
    const preparo = diferencaSegundos(pedido.aceitoEm, agoraIso);
    return {
      espera: diferencaSegundos(pedido.criadoEm, pedido.aceitoEm),
      preparo,
      ateFicarPronto: null,
      ateFinalizar: null,
      dentroDaMeta: metaPreparoMinutos !== null && preparo !== null ? preparo <= metaPreparoMinutos * 60 : null,
    };
  }

  if (pedido.status === STATUS_PEDIDO.PRONTO || pedido.status === STATUS_PEDIDO.FINALIZADO) {
    const preparo = diferencaSegundos(pedido.aceitoEm, pedido.prontoEm);
    return {
      espera: diferencaSegundos(pedido.criadoEm, pedido.aceitoEm),
      preparo,
      ateFicarPronto: diferencaSegundos(pedido.criadoEm, pedido.prontoEm),
      ateFinalizar: pedido.status === STATUS_PEDIDO.FINALIZADO ? diferencaSegundos(pedido.criadoEm, pedido.finalizadoEm) : null,
      dentroDaMeta: metaPreparoMinutos !== null && preparo !== null ? preparo <= metaPreparoMinutos * 60 : null,
    };
  }

  return { espera: null, preparo: null, ateFicarPronto: null, ateFinalizar: null, dentroDaMeta: null };
}

/**
 * Indicador discreto de meta ao lado do valor de Preparo (item 15/17). Em preparing: só aparece
 * quando JÁ passou da meta ("Acima da meta") — dentro da meta fica silencioso, sem alerta. Em ready/
 * completed: sempre mostra o resultado histórico fechado ("Dentro"/"Fora da meta"). Puramente visual —
 * não bloqueia status, não grava nada no banco.
 */
function badgeMetaPreparoHtml(pedido, tempos) {
  if (tempos.dentroDaMeta === null) return '';

  if (pedido.status === STATUS_PEDIDO.EM_PREPARO) {
    return tempos.dentroDaMeta ? '' : '<span class="badge-meta-preparo badge-meta-fora">Acima da meta</span>';
  }

  return tempos.dentroDaMeta
    ? '<span class="badge-meta-preparo badge-meta-dentro">Dentro da meta</span>'
    : '<span class="badge-meta-preparo badge-meta-fora">Fora da meta</span>';
}

/** Bloco compacto "⏱ Tempos" do card — Espera/Preparo/Até pronto sempre; Até finalizar só quando finalizado e calculável */
function blocoTemposPedidoHtml(pedido) {
  const t = calcularTemposPedido(pedido);
  const secundario =
    pedido.status === STATUS_PEDIDO.FINALIZADO && t.ateFinalizar !== null
      ? `<div class="card-pedido-tempo-item card-pedido-tempo-secundario">
          <span class="card-pedido-tempo-rotulo">Até finalizar</span>
          <span class="card-pedido-tempo-valor">${formatarDuracao(t.ateFinalizar)}</span>
        </div>`
      : '';

  return `
    <div class="card-pedido-tempos">
      <div class="card-pedido-tempo-item">
        <span class="card-pedido-tempo-rotulo">Espera</span>
        <span class="card-pedido-tempo-valor">${formatarDuracao(t.espera)}</span>
      </div>
      <div class="card-pedido-tempo-item">
        <span class="card-pedido-tempo-rotulo">Preparo</span>
        <span class="card-pedido-tempo-valor">${formatarDuracao(t.preparo)}</span>
        ${badgeMetaPreparoHtml(pedido, t)}
      </div>
      <div class="card-pedido-tempo-item">
        <span class="card-pedido-tempo-rotulo">Até pronto</span>
        <span class="card-pedido-tempo-valor">${formatarDuracao(t.ateFicarPronto)}</span>
      </div>
      ${secundario}
    </div>`;
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
    const rotulo =
      pedido.fulfilment === 'entrega' ? 'Pedido entregue' : pedido.fulfilment === 'comer_no_local' ? 'Pedido servido' : 'Pedido retirado';
    return `<button type="button" class="btn btn-primario" data-acao="concluir" data-id="${pedido.id}">${rotulo}</button>`;
  }
  return '';
}

/** Bloco de destaque no card quando o pedido está Pronto — o que o funcionário precisa pra liberar/entregar */
function blocoProntoParaHtml(pedido) {
  const cliente = pedido.cliente || {};
  const linhaTroco = linhaTrocoNecessarioHtml(pedido);
  const nomeTelefone = `${escaparHtml(cliente.nome || '')} · ${escaparHtml(cliente.telefone || '')}`;

  if (pedido.fulfilment === 'entrega') {
    const endereco = pedido.endereco || {};
    return `
      <div class="bloco-pronto-para">
        <strong>Pronto para entrega</strong>
        <span>${nomeTelefone}</span>
        <span>${escaparHtml(endereco.eircode || '')}</span>
        <span>${escaparHtml(endereco.linha1 || '')}${endereco.linha2 ? ', ' + escaparHtml(endereco.linha2) : ''}</span>
        ${linhaTroco}
      </div>`;
  }
  if (pedido.fulfilment === 'comer_no_local') {
    return `
      <div class="bloco-pronto-para">
        <strong>Pronto — comer no local</strong>
        <span>${nomeTelefone}</span>
        ${linhaTroco}
      </div>`;
  }
  // retirada
  return `
    <div class="bloco-pronto-para">
      <strong>Pronto para retirada</strong>
      <span>${nomeTelefone}</span>
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
  document.getElementById('botao-imprimir-pedido-detalhe').addEventListener('click', (evento) => {
    iniciarImpressaoPedido(evento.currentTarget.dataset.id);
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
  const ehComerNoLocal = pedido.fulfilment === 'comer_no_local';

  document.getElementById('pedido-modal-titulo').textContent = pedido.numero;

  const botaoCancelarDetalhe = document.getElementById('botao-cancelar-pedido-detalhe');
  if (pedidoPodeSerCancelado(pedido)) {
    botaoCancelarDetalhe.style.display = '';
    botaoCancelarDetalhe.dataset.id = pedido.id;
  } else {
    botaoCancelarDetalhe.style.display = 'none';
    delete botaoCancelarDetalhe.dataset.id;
  }

  const botaoImprimirDetalhe = document.getElementById('botao-imprimir-pedido-detalhe');
  botaoImprimirDetalhe.dataset.id = pedido.id;
  botaoImprimirDetalhe.textContent = pedido.qtdImpressoes > 0 ? '🖨️ Reimprimir' : '🖨️ Imprimir';
  botaoImprimirDetalhe.disabled = _impressaoEmAndamento;

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
