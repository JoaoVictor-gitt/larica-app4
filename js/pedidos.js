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
// Set de deduplicação de ALERTA (som/destaque/título) por order.id — populado no 1º carregamento
// bem-sucedido sem tocar nada. Um id entra aqui uma única vez, seja pelo Realtime, polling,
// reconexão ou volta da aba — então o mesmo pedido nunca alerta duas vezes. Não tem relação com a
// fila de impressão automática (que tem dedupe e claim próprios).
let idsPedidosVistos = null;

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
let _reloadPendente = false; // evento/tick que chegou durante um reload em voo — reexecuta 1x ao terminar, nunca é descartado
let _pedidosInicializado = false; // true só depois de init() concluir com sucesso (pageshow/visibilitychange só religam recursos depois disso)
let _intervaloPollingPedidos = null;
const INTERVALO_POLLING_PEDIDOS_MS = 5000;

// Blindagem do recebimento (Etapa 1). Toda chamada de rede de reloadOrders() tem timeout; se mesmo
// assim um reload passar de RELOAD_PEDIDOS_WATCHDOG_MS, ele é considerado abandonado: o lock é
// liberado e o resultado dele, se chegar depois, é ignorado (_geracaoReloadPedidos).
const RELOAD_PEDIDOS_WATCHDOG_MS = 45000;
let _reloadPedidosIniciadoEm = 0;
let _geracaoReloadPedidos = 0;

// Estado real da conexão — alimenta o indicador 🟢/🟡/🔴 (nunca só navigator.onLine).
let _statusRealtimePedidos = null; // último status do canal: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | null
let _realtimePedidosJaConectou = false; // distingue a 1ª conexão de uma reconexão (que pede resync)
let _ultimaSincronizacaoPedidosOk = null; // Date da última carga de pedidos bem-sucedida
let _falhasSeguidasSincronizacaoPedidos = 0;
const SINCRONIZACAO_VERDE_MAX_MS = 45000;
const SINCRONIZACAO_VERMELHO_APOS_MS = 60000;
const FALHAS_SEGUIDAS_VERMELHO = 3;

// Carga inicial com nova tentativa automática (nunca deixa a página morta esperando um F5).
const ESPERAS_RETRY_CARGA_INICIAL_MS = [2000, 5000, 10000, 30000];

/** Promise.race com timeout — não cancela a requisição, só impede que uma chamada pendurada segure um lock para sempre. */
function _comTimeout(promessa, ms, rotulo) {
  let timer;
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error('Timeout (' + ms + ' ms): ' + rotulo)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

document.addEventListener('DOMContentLoaded', init);

async function init() {
  _deviceIdImpressora = obterDeviceIdImpressora();
  // Pré-carrega o logo da comanda (local); se falhar, a comanda sai com o texto "LARICA".
  if (typeof prepararLogoComanda === 'function') prepararLogoComanda();

  const kanban = document.getElementById('kanban-pedidos');

  // Indicador e online/offline já desde o início — durante a carga inicial (e suas novas
  // tentativas) a equipe vê o estado real em vez de uma tela parada.
  ligarIndicadorConexaoPedidos();

  // Só retorna depois de carregar com sucesso — tenta de novo sozinho, nunca exige F5.
  await carregarPedidosIniciaisComRetry();
  // Marca tudo que já existe na primeira carga como "visto" — nunca toca som pros pedidos que já estavam lá ao abrir a página.
  idsPedidosVistos = new Set(obterPedidosClientes().map((p) => p.id));

  // Meta de preparo — carregamento independente do resto (uma falha aqui não pode derrubar o
  // Kanban); coluna própria fora da lista pública de business_settings (ver settings-service.js).
  try {
    // Com timeout: se esta leitura pendurasse, init() nunca chegaria a ligar Realtime/polling.
    metaPreparoMinutos = await _comTimeout(buscarMetaPreparoDoSupabase(), 10000, 'meta de preparo');
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
  _pedidosInicializado = true;
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
    (payload) => {
      // Caminho rápido: pedido novo vai direto pra fila de auto-print, sem esperar o reload
      // (a UI é atualizada separadamente, abaixo). O claim no banco continua sendo o portão.
      if (payload && payload.eventType === 'INSERT' && payload.new) {
        try {
          processarInsertRealtimeAutoPrint(payload.new);
        } catch (erroInsert) {
          console.error('[AUTO-PRINT] Falha ao processar INSERT do Realtime:', erroInsert);
        }
        // Alerta (som/destaque/título) na hora, independente da impressão acima e da recarga abaixo.
        try {
          const pedidoNovo = _linhaSupabaseParaPedido({ ...payload.new, order_items: [] });
          if (receberPedidoNovo(pedidoNovo, 'realtime')) registrarAlertaPedidoNovo(1, 'realtime');
        } catch (erroAlerta) {
          console.error('[PEDIDO NOVO] Falha ao alertar INSERT do Realtime:', erroAlerta);
        }
      }
      clearTimeout(timeoutRecarregarPedidosRealtime);
      timeoutRecarregarPedidosRealtime = setTimeout(() => reloadOrders('realtime'), 400);
    },
    (status) => {
      // O SDK do Supabase já gerencia a reconexão sozinho. Aqui só: (1) alimenta o indicador e
      // (2) ao VOLTAR pra SUBSCRIBED depois de uma queda, ressincroniza — pedidos criados durante
      // a queda não geram evento nenhum, só aparecem se buscarmos.
      console.log('[AUTO-PRINT] Realtime status:', status);
      const reconectou = status === 'SUBSCRIBED' && _realtimePedidosJaConectou && _statusRealtimePedidos !== 'SUBSCRIBED';
      _statusRealtimePedidos = status;
      if (status === 'SUBSCRIBED') _realtimePedidosJaConectou = true;
      atualizarIndicadorConexaoPedidos();
      if (reconectou) reloadOrders('realtime-reconectado');
    }
  );
}

/** Carga inicial: tenta até conseguir (2 s, 5 s, 10 s, depois a cada 30 s), mostrando o erro e a próxima tentativa. */
async function carregarPedidosIniciaisComRetry() {
  const carregando = document.getElementById('estado-carregando-pedidos');
  const erro = document.getElementById('estado-erro-pedidos');
  for (let tentativa = 0; ; tentativa++) {
    try {
      await _comTimeout(carregarPedidosClientesCache(), 20000, 'carga inicial de pedidos');
      registrarSincronizacaoPedidos(true);
      erro.style.display = 'none';
      carregando.style.display = 'none';
      return;
    } catch (erroCarregamento) {
      registrarSincronizacaoPedidos(false);
      console.error('Erro ao carregar pedidos (tentativa ' + (tentativa + 1) + '):', erroCarregamento);
      const esperaMs = ESPERAS_RETRY_CARGA_INICIAL_MS[Math.min(tentativa, ESPERAS_RETRY_CARGA_INICIAL_MS.length - 1)];
      carregando.style.display = 'none';
      erro.textContent =
        'Não foi possível carregar os pedidos (' + erroCarregamento.message + '). Tentando novamente em ' + Math.round(esperaMs / 1000) + ' s...';
      erro.style.display = 'block';
      await new Promise((resolver) => setTimeout(resolver, esperaMs));
    }
  }
}

/** origem: 'realtime' | 'polling' | 'visibilitychange' | 'online' | ... — só pro log de diagnóstico, não afeta comportamento. */
async function reloadOrders(origem = 'desconhecida') {
  if (_reloadOrdersEmAndamento) {
    if (Date.now() - _reloadPedidosIniciadoEm < RELOAD_PEDIDOS_WATCHDOG_MS) {
      _reloadPendente = true; // nunca descarta: reexecuta assim que o reload atual terminar
      return;
    }
    // Watchdog: o reload em voo está pendurado há tempo demais — abandona ele (o resultado, se
    // chegar, é ignorado pela geração) e segue com este. Nunca mais um painel congelado até o F5.
    console.warn('[PEDIDOS] Reload anterior travado há mais de ' + RELOAD_PEDIDOS_WATCHDOG_MS / 1000 + ' s — liberando o lock.');
  }
  const geracao = ++_geracaoReloadPedidos;
  _reloadOrdersEmAndamento = true;
  _reloadPedidosIniciadoEm = Date.now();
  try {
    await _comTimeout(carregarPedidosClientesCache(), 20000, 'carregar pedidos');
    if (geracao !== _geracaoReloadPedidos) return; // abandonado pelo watchdog — um reload mais novo assumiu
    registrarSincronizacaoPedidos(true);
    // Reconsulta o toggle a cada reload — uma aba de /pedidos já aberta antes de alguém ligar/
    // desligar em Configurações (em outra aba/dispositivo) precisa enxergar a mudança sem refresh.
    await atualizarConfiguracaoImpressaoAutomatica();
    if (geracao !== _geracaoReloadPedidos) return;
    detectarPedidosNovos(origem); // nunca lança — alerta só ids nunca vistos (dedupe por order.id)
    renderizarQuadroPedidos();
    escanearCandidatosImpressaoAutomatica();
  } catch (erro) {
    if (geracao === _geracaoReloadPedidos) registrarSincronizacaoPedidos(false);
    console.error('Erro ao recarregar pedidos (' + origem + '):', erro);
  } finally {
    // Só o reload "dono" da geração atual mexe no lock — um abandonado nunca solta o lock do novo.
    if (geracao === _geracaoReloadPedidos) {
      _reloadOrdersEmAndamento = false;
      if (_reloadPendente) {
        _reloadPendente = false;
        reloadOrders('pendente');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Indicador de conexão (🟢 online / 🟡 reconectando / 🔴 sem conexão)
// ---------------------------------------------------------------------------

/** Chamado a cada carga de pedidos (inicial ou reload) — base do indicador. */
function registrarSincronizacaoPedidos(sucesso) {
  if (sucesso) {
    _ultimaSincronizacaoPedidosOk = new Date();
    _falhasSeguidasSincronizacaoPedidos = 0;
  } else {
    _falhasSeguidasSincronizacaoPedidos++;
  }
  atualizarIndicadorConexaoPedidos();
}

/**
 * 🟢 canal Realtime SUBSCRIBED e última carga ok há < 45 s.
 * 🔴 navegador offline, 3+ falhas seguidas, ou nenhuma carga ok há > 60 s.
 * 🟡 qualquer outro caso (canal caído/reconectando com a carga ainda ok, ou conectando).
 * Só exibe — nunca decide nada de pedidos/impressão.
 */
function atualizarIndicadorConexaoPedidos() {
  const indicador = document.getElementById('indicador-conexao-pedidos');
  if (!indicador) return;
  const msDesdeSincronizacao = _ultimaSincronizacaoPedidosOk ? Date.now() - _ultimaSincronizacaoPedidosOk.getTime() : Infinity;

  let estado;
  let texto;
  if (navigator.onLine === false) {
    estado = 'vermelho';
    texto = 'Sem conexão (internet)';
  } else if (_falhasSeguidasSincronizacaoPedidos >= FALHAS_SEGUIDAS_VERMELHO || msDesdeSincronizacao > SINCRONIZACAO_VERMELHO_APOS_MS) {
    estado = 'vermelho';
    texto = _ultimaSincronizacaoPedidosOk ? 'Sem conexão — pedidos podem estar desatualizados' : 'Sem conexão — tentando carregar...';
  } else if (_statusRealtimePedidos === 'SUBSCRIBED' && msDesdeSincronizacao <= SINCRONIZACAO_VERDE_MAX_MS) {
    estado = 'verde';
    texto = 'Pedidos online';
  } else {
    estado = 'amarelo';
    texto = _realtimePedidosJaConectou ? 'Reconectando...' : 'Conectando...';
  }

  indicador.dataset.estado = estado;
  document.getElementById('indicador-conexao-texto').textContent = texto;
  document.getElementById('indicador-conexao-hora').textContent = _ultimaSincronizacaoPedidosOk
    ? '· atualizado ' + _ultimaSincronizacaoPedidosOk.toLocaleTimeString('pt-PT')
    : '';
}

/** Liga uma vez: online/offline + reavaliação periódica do indicador (só leitura local, sem rede). */
function ligarIndicadorConexaoPedidos() {
  atualizarIndicadorConexaoPedidos();
  setInterval(atualizarIndicadorConexaoPedidos, 5000);
  window.addEventListener('offline', atualizarIndicadorConexaoPedidos);
  window.addEventListener('online', () => {
    atualizarIndicadorConexaoPedidos();
    // Internet voltou: garante canal + polling e já busca o que chegou durante a queda.
    garantirRecursosPedidos('online');
  });
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
  console.log('[AUTO-PRINT] Polling iniciado, intervalo =', INTERVALO_POLLING_PEDIDOS_MS);
  _intervaloPollingPedidos = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    reloadOrders('polling');
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
    // Timeout obrigatório: sem ele, um fetch pendurado (rede "meio morta" no iPad) segurava o lock
    // de reloadOrders() pra sempre e o painel parava de mostrar pedidos novos até um F5.
    const config = await _comTimeout(buscarImpressaoAutomaticaDoSupabase(), 10000, 'configuração de impressão automática');
    _impressaoAutomaticaAtiva = config.ativa;
    _impressaoAutomaticaAtivadaEm = config.ativadaEm;
  } catch (erro) {
    console.error('Não foi possível carregar a configuração de impressão automática:', erro);
    _impressaoAutomaticaAtiva = false;
    _impressaoAutomaticaAtivadaEm = null;
  }
}

// ---------------------------------------------------------------------------
// Pedido novo: alerta sonoro + destaque do card + título da aba
// ---------------------------------------------------------------------------
//
// Ponto único: receberPedidoNovo(pedido, origem), chamado pelo INSERT do Realtime (na hora) e por
// detectarPedidosNovos() em cada recarga (pedido que o Realtime perdeu: polling, reconexão, volta
// da aba). Só cuida de ALERTA — a interface vem da recarga de sempre e a impressão automática segue
// pelo caminho próprio dela (processarInsertRealtimeAutoPrint/escanear…), intocado. Cada parte tem
// try/catch próprio: falha no som nunca impede o pedido de aparecer/imprimir, e vice-versa.
//
// Som: sons/novo-pedido.wav (local, ~2,8 s) num único HTMLAudioElement reutilizado. Navegadores
// (principalmente Safari/iPad) só deixam tocar depois de um toque do usuário — por isso o estado
// mostrado é sempre o REAL (nunca "ativo" sem um play() ter dado certo).

const ARQUIVO_SOM_NOVO_PEDIDO = 'sons/novo-pedido.wav';
const DURACAO_DESTAQUE_PEDIDO_NOVO_MS = 8000;
const PAUSA_ENTRE_ALERTAS_MS = 2000; // pedidos que chegam enquanto o alerta toca (ou logo depois) não tocam de novo
const FOLGA_PEDIDO_ANTIGO_MS = 5 * 60000; // pedido criado antes da abertura da página (− folga de relógio) nunca alerta
// Recargas que "recuperam" o que chegou com o painel fora (aba oculta, internet/Realtime caídos):
// o lote inteiro vira UM alerta, com aviso de que chegaram enquanto o painel estava fora.
const ORIGENS_RETORNO_PAINEL = new Set(['visibilitychange', 'pageshow', 'online', 'realtime-reconectado']);

const _paginaPedidosAbertaEm = Date.now();
const _tituloOriginalPedidos = document.title;
const _destaquePedidoNovoAte = new Map(); // id -> timestamp até quando o card fica destacado
let _audioAlertaPedido = null;
let _estadoSomPedidos = 'desativado'; // 'desativado' | 'aguardando_toque' | 'ativo' | 'bloqueado' | 'erro'
let _somPedidosOcupadoAte = 0; // até quando um novo alerta é absorvido (som tocando + pausa)
let _tokenReproducaoSom = 0; // invalida um desbloqueio silencioso se um alerta real começou no meio
let _timerMensagemSom = null;
let _qtdPedidosNovosNaoVistos = 0;
let _pedidosChegaramComPainelFora = false;
let _timerLimparContadorNovos = null;

function somPedidosAtivo() {
  try {
    return localStorage.getItem(CHAVE_SOM_PEDIDOS_ATIVO) !== 'nao'; // ligado por padrão
  } catch (erro) {
    return true;
  }
}

function definirSomPedidosAtivo(ativo) {
  try {
    localStorage.setItem(CHAVE_SOM_PEDIDOS_ATIVO, ativo ? 'sim' : 'nao');
  } catch (erro) {
    // localStorage indisponível — vale só nesta sessão
  }
}

/** Elemento de áudio único (criado 1x, reaproveitado). null se o navegador não suportar. */
function obterAudioAlertaPedido() {
  if (_audioAlertaPedido) return _audioAlertaPedido;
  try {
    const audio = new Audio(ARQUIVO_SOM_NOVO_PEDIDO);
    audio.preload = 'auto';
    audio.volume = 1; // máximo do elemento — o volume final continua sendo o do aparelho
    audio.addEventListener('ended', () => {
      _somPedidosOcupadoAte = Date.now() + PAUSA_ENTRE_ALERTAS_MS;
    });
    audio.addEventListener('error', () => {
      console.error('[SOM] Não foi possível carregar ' + ARQUIVO_SOM_NOVO_PEDIDO);
      _audioAlertaPedido = null; // próxima tentativa recria (ex.: arquivo voltou)
      if (somPedidosAtivo()) definirEstadoSomPedidos('erro');
    });
    _audioAlertaPedido = audio;
    return audio;
  } catch (erro) {
    console.error('[SOM] Áudio indisponível neste navegador:', erro);
    return null;
  }
}

/**
 * Toca o alerta completo. play() é chamado de forma SÍNCRONA (sem await antes), então quando
 * chamado dentro de um toque conta como gesto do usuário (exigência do Safari). Nunca lança —
 * retorna 'ok' | 'bloqueado' (navegador exige toque) | 'erro' (arquivo/áudio indisponível).
 */
async function tocarAlertaPedido() {
  const audio = obterAudioAlertaPedido();
  if (!audio) return 'erro';
  _tokenReproducaoSom++;
  try {
    audio.muted = false;
    audio.currentTime = 0;
    const duracaoMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 3000;
    _somPedidosOcupadoAte = Date.now() + duracaoMs + PAUSA_ENTRE_ALERTAS_MS;
    await audio.play();
    return 'ok';
  } catch (erro) {
    _somPedidosOcupadoAte = 0;
    console.warn('[SOM] Reprodução recusada:', erro && erro.name);
    return erro && erro.name === 'NotAllowedError' ? 'bloqueado' : 'erro';
  }
}

/**
 * Libera o áudio sem barulho (play mudo + pause) — usado no 1º toque na tela quando a preferência
 * já estava ligada ao abrir a página, e pra rearmar depois de um bloqueio. Só marca "ativo" se o
 * navegador realmente aceitou o play().
 */
async function desbloquearAudioSilencioso() {
  const audio = obterAudioAlertaPedido();
  if (!audio) return;
  const token = ++_tokenReproducaoSom;
  try {
    audio.muted = true;
    await audio.play();
    if (token === _tokenReproducaoSom) {
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    }
    if (somPedidosAtivo()) definirEstadoSomPedidos('ativo');
  } catch (erro) {
    if (token === _tokenReproducaoSom) audio.muted = false;
  }
}

/** Atualiza o rótulo ao lado do toggle. `mensagem` (opcional) substitui o texto padrão por alguns segundos. */
function definirEstadoSomPedidos(estado, mensagem) {
  _estadoSomPedidos = estado;
  const rotulo = document.getElementById('estado-som-pedidos');
  if (!rotulo) return;
  const textos = {
    ativo: '[ATIVO]',
    desativado: '🔕 Som desativado',
    aguardando_toque: '⚠ Toque na tela para liberar o som',
    bloqueado: '⚠ Som bloqueado pelo navegador — toque aqui para reativar',
    erro: '⚠ Não foi possível ativar o som — toque aqui para tentar de novo',
  };
  rotulo.dataset.estado = estado;
  rotulo.textContent = mensagem || textos[estado] || '';
  clearTimeout(_timerMensagemSom);
  if (mensagem) {
    _timerMensagemSom = setTimeout(() => definirEstadoSomPedidos(_estadoSomPedidos), 4000);
  }
}

function ligarEventosSomPedidos() {
  const campo = document.getElementById('campo-som-pedidos');
  campo.checked = somPedidosAtivo();
  // Preferência ligada de uma abertura anterior: o navegador ainda precisa de um toque NESTA abertura.
  definirEstadoSomPedidos(somPedidosAtivo() ? 'aguardando_toque' : 'desativado');
  obterAudioAlertaPedido(); // já começa a baixar o arquivo (local)

  campo.addEventListener('change', async () => {
    if (!campo.checked) {
      definirSomPedidosAtivo(false);
      if (_audioAlertaPedido) _audioAlertaPedido.pause();
      definirEstadoSomPedidos('desativado');
      return;
    }
    // Ligar = autorização explícita: toca o alerta real como teste e só então marca como ativo.
    campo.disabled = true;
    const resultado = await tocarAlertaPedido(); // play() sai síncrono, ainda dentro do toque
    campo.disabled = false;
    if (resultado === 'ok') {
      definirSomPedidosAtivo(true);
      definirEstadoSomPedidos('ativo', '✓ Som ativado — teste reproduzido');
    } else {
      campo.checked = false; // nunca finge que está ativo
      definirEstadoSomPedidos(
        'erro',
        '⚠ Não foi possível ativar o som — toque no botão novamente e verifique se o navegador permite áudio'
      );
    }
  });

  // Qualquer toque/tecla na página (sempre, não só o 1º) libera/rearma o áudio quando a preferência
  // está ligada mas o navegador ainda não deixou tocar — ex.: ao abrir a página, ou depois que o
  // iPad voltou do bloqueio de tela. Toques no próprio toggle são tratados pelo 'change' acima.
  const rearmar = (evento) => {
    if (!somPedidosAtivo() || _estadoSomPedidos === 'ativo') return;
    if (evento.target && evento.target.closest && evento.target.closest('.linha-toggle-som label')) return;
    if (Date.now() < _somPedidosOcupadoAte) return;
    desbloquearAudioSilencioso();
  };
  document.addEventListener('pointerdown', rearmar, true);
  document.addEventListener('keydown', rearmar, true);
}

/** Card destacado por ~8 s — consultado por cardPedidoHtml(). */
function pedidoEmDestaqueNovo(id) {
  const ate = _destaquePedidoNovoAte.get(id);
  return !!ate && ate > Date.now();
}

/**
 * Decide se este pedido gera alerta. Deduplicação por order.id (idsPedidosVistos): o 1º caminho que
 * enxergar o id (Realtime, polling, reconexão, volta da aba) é o único — os seguintes retornam
 * false. Marca o destaque do card. Retorna true se é um pedido novo que deve alertar.
 */
function receberPedidoNovo(pedido, origem) {
  if (!idsPedidosVistos || !pedido || !pedido.id) return false; // antes da carga inicial: a carga marca tudo como visto
  if (idsPedidosVistos.has(pedido.id)) return false;
  idsPedidosVistos.add(pedido.id);

  // Pedido criado antes de a página abrir (− folga de relógio) não é "novo" — nunca alerta.
  const criadoEmMs = new Date(pedido.criadoEm).getTime();
  if (!(criadoEmMs >= _paginaPedidosAbertaEm - FOLGA_PEDIDO_ANTIGO_MS)) return false;

  try {
    _destaquePedidoNovoAte.set(pedido.id, Date.now() + DURACAO_DESTAQUE_PEDIDO_NOVO_MS);
    setTimeout(() => {
      _destaquePedidoNovoAte.delete(pedido.id);
      renderizarQuadroPedidos();
    }, DURACAO_DESTAQUE_PEDIDO_NOVO_MS + 100);
  } catch (erroDestaque) {
    console.error('[PEDIDO NOVO] Falha no destaque:', erroDestaque);
  }
  console.log('[PEDIDO NOVO] Recebido', { id: pedido.id, numero: pedido.numero, origem });
  return true;
}

/**
 * Um alerta para `quantidade` pedidos novos (1 do Realtime, ou um lote achado numa recarga).
 * Coalescência: se um alerta está tocando (ou acabou há < 2 s), este não toca de novo — só soma
 * no contador/título. Nunca há dois sons sobrepostos, nem uma rajada de sons ao voltar pra aba.
 */
function registrarAlertaPedidoNovo(quantidade, origem) {
  try {
    const semFoco = document.hidden || !document.hasFocus();
    const retornoPainel = ORIGENS_RETORNO_PAINEL.has(origem);
    if (semFoco || retornoPainel) {
      _qtdPedidosNovosNaoVistos += quantidade;
      if (retornoPainel) _pedidosChegaramComPainelFora = true;
      atualizarContadorPedidosNovosNaoVistos();
      if (semFoco) document.title = tituloAlertaPedidosNovos();
      else agendarLimpezaContadorPedidosNovos();
    }
  } catch (erroVisual) {
    console.error('[PEDIDO NOVO] Falha no título/contador:', erroVisual);
  }

  if (!somPedidosAtivo()) return;
  if (Date.now() < _somPedidosOcupadoAte) return; // absorvido pelo alerta que já está tocando
  tocarAlertaPedido().then((resultado) => {
    if (resultado === 'ok') {
      if (_estadoSomPedidos !== 'ativo') definirEstadoSomPedidos('ativo');
    } else if (somPedidosAtivo()) {
      definirEstadoSomPedidos(resultado); // 'bloqueado' ou 'erro' — nunca continua mostrando "ativo"
    }
  });
}

function tituloAlertaPedidosNovos() {
  return _qtdPedidosNovosNaoVistos > 1
    ? '🔴 (' + _qtdPedidosNovosNaoVistos + ') NOVOS PEDIDOS — LARICA'
    : '🔴 NOVO PEDIDO — LARICA';
}

function atualizarContadorPedidosNovosNaoVistos() {
  const contador = document.getElementById('contador-novos-pedidos');
  if (!contador) return;
  const qtd = _qtdPedidosNovosNaoVistos;
  if (qtd <= 0) {
    contador.style.display = 'none';
    contador.textContent = '';
    return;
  }
  contador.textContent =
    '· 🔔 ' + qtd + (qtd === 1 ? ' novo pedido' : ' novos pedidos') +
    (_pedidosChegaramComPainelFora ? (qtd === 1 ? ' chegou' : ' chegaram') + ' enquanto o painel estava fora' : '');
  contador.style.display = '';
}

/** Painel visível e com foco: contador fica 10 s pra ser visto e depois some. */
function agendarLimpezaContadorPedidosNovos() {
  clearTimeout(_timerLimparContadorNovos);
  _timerLimparContadorNovos = setTimeout(() => {
    _qtdPedidosNovosNaoVistos = 0;
    _pedidosChegaramComPainelFora = false;
    atualizarContadorPedidosNovosNaoVistos();
  }, 10000);
}

/** Usuário voltou pro painel: título normal na hora; contador some depois de 10 s. */
function aoVoltarParaPainelPedidos() {
  if (document.hidden || !document.hasFocus()) return;
  document.title = _tituloOriginalPedidos;
  if (_qtdPedidosNovosNaoVistos > 0) agendarLimpezaContadorPedidosNovos();
}
document.addEventListener('visibilitychange', aoVoltarParaPainelPedidos);
window.addEventListener('focus', aoVoltarParaPainelPedidos);

/**
 * Chamado em cada recarga: ids que ainda não foram vistos (o Realtime perdeu) passam por
 * receberPedidoNovo(). O lote inteiro gera no máximo UM alerta. Nunca lança.
 */
function detectarPedidosNovos(origem) {
  if (!idsPedidosVistos) return;
  let quantidade = 0;
  obterPedidosClientes().forEach((p) => {
    try {
      if (receberPedidoNovo(p, origem)) quantidade++;
    } catch (erro) {
      console.error('[PEDIDO NOVO] Falha ao processar pedido:', erro);
    }
  });
  if (quantidade > 0) {
    try {
      registrarAlertaPedidoNovo(quantidade, origem);
    } catch (erro) {
      console.error('[PEDIDO NOVO] Falha no alerta:', erro);
    }
  }
}

// Fallback do Realtime pra iPad/Safari: ao voltar de segundo plano (troca de app, bloqueio de
// tela), o canal pode ter sido suspenso/perdido eventos — força uma recarga imediata.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    garantirRecursosPedidos('visibilitychange');
  }
});

/**
 * Garante Realtime + polling ativos (ambos idempotentes — nunca duplicam canal/intervalo) e faz
 * uma varredura de recuperação. pagehide destrói os dois; sem isto, uma página restaurada do
 * bfcache (iPad/Safari) ficaria sem detecção. Só age depois de init() ter concluído.
 */
function garantirRecursosPedidos(origem) {
  if (!_pedidosInicializado) return;
  iniciarRealtimePedidos();
  iniciarPollingPedidos();
  reloadOrders(origem);
}

window.addEventListener('pageshow', () => garantirRecursosPedidos('pageshow'));

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
  // A impressão física JÁ está confirmada (Epson respondeu sucesso ou um humano confirmou): o pedido
  // nunca volta pra fila automática nesta aba, e o lock é liberado NA HORA — antes ele só soltava
  // depois do register + recarga completa (sem timeout), e uma rede pendurada parava a fila inteira (C1).
  // O registro segue em segundo plano, sem segurar o próximo pedido.
  _idsImpressaoAutomaticaFinalizadosNestaAba.add(id);
  finalizarImpressaoPedido();
  return _registrarImpressaoComRecuperacao(id).then((registrado) => {
    if (registrado) {
      mostrarToast('Impressão registrada.', 'sucesso');
    } else {
      mostrarToast((mensagemFalhaRpc || 'Não foi possível registrar a impressão.') + ' A comanda não será reimpressa automaticamente.', 'erro');
    }
    renderizarQuadroPedidos();
    aplicarBloqueioBotoesImpressao();
  });
}

/**
 * Registra (register_order_print) uma impressão que JÁ ACONTECEU — nunca reenvia nada à Epson.
 * Até 3 tentativas. register_order_print NÃO é idempotente (print_count + 1), então antes de cada nova
 * tentativa recupera o estado do pedido: se printed_at já estiver gravado (a tentativa anterior chegou
 * ao banco e só a resposta se perdeu), para sem registrar de novo; se não der pra conferir, não
 * registra às cegas naquela rodada. Nunca lança. Retorna true se o pedido terminou registrado.
 */
async function _registrarImpressaoComRecuperacao(id) {
  for (let tentativa = 0; tentativa <= ESPERAS_RECUPERACAO_IMPRESSAO_MS.length; tentativa++) {
    if (tentativa > 0) {
      await _esperarMs(ESPERAS_RECUPERACAO_IMPRESSAO_MS[tentativa - 1]);
      let estado;
      try {
        const lista = await _comTimeout(getOrdersWithDetails({ orderIds: [id] }), 15000, 'conferir registro de impressão');
        estado = lista && lista[0];
      } catch (erroEstado) {
        console.error('[IMPRESSÃO] Não foi possível conferir o registro do pedido ' + id + ':', erroEstado);
        continue;
      }
      if (!estado) return false; // pedido não existe mais — nada a registrar
      if (estado.impressoEm) {
        const noCache = obterPedidoClientePorId(id);
        if (noCache) {
          noCache.impressoEm = estado.impressoEm;
          noCache.qtdImpressoes = estado.qtdImpressoes;
          noCache.ultimaImpressaoEm = estado.ultimaImpressaoEm;
        }
        return true;
      }
    }
    try {
      await registrarImpressaoPedido(id);
      return true;
    } catch (erroRegistro) {
      console.error('[IMPRESSÃO] Falha ao registrar a impressão do pedido ' + id + ' (tentativa ' + (tentativa + 1) + '):', erroRegistro);
    }
  }
  return false;
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
  // Já foi à Epson por ação manual: a impressão automática nunca o pega depois nesta aba (qualquer resultado —
  // num ambíguo/erro quem decide reimprimir é o operador, nos diálogos abaixo).
  _idsImpressaoAutomaticaFinalizadosNestaAba.add(id);

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
// Guarda contra impressão duplicada NESTA aba: todo pedido que já foi enviado à Epson (qualquer
// resultado — sucesso, falha ou ambíguo) ou cuja impressão foi confirmada por um humano nunca volta
// pra fila automática, mesmo que o banco ainda mostre claimed/nulo porque resolve/register falharam.
const _idsImpressaoAutomaticaFinalizadosNestaAba = new Set();
// Pedidos cujo claim deu erro/timeout (≠ claimed:false) — podem ser tentados de novo (ver C3 abaixo).
const _idsComFalhaDeClaim = new Set();
// Esperas antes de repetir o que é SEGURO repetir (conferir/registrar impressão já confirmada,
// resolve idempotente). Nunca usado pra reenviar nada à Epson.
const ESPERAS_RECUPERACAO_IMPRESSAO_MS = [3000, 10000];

function _esperarMs(ms) {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

// Mesmo valor usado no WHERE de claim_order_auto_print (SQL, migration
// 20260923090000_allow_reclaim_abandoned_auto_print.sql) — mantenha os dois em sincronia.
// Só um 'claimed' pode "expirar"; succeeded/failed/ambiguous nunca voltam a ser candidatos.
const MINUTOS_CLAIM_IMPRESSAO_AUTOMATICA_ABANDONADO = 2;

function claimImpressaoAutomaticaAbandonado(pedido) {
  if (pedido.autoPrintStatus !== 'claimed' || !pedido.autoPrintClaimedAt) return false;
  const minutosDesdeClaim = (Date.now() - new Date(pedido.autoPrintClaimedAt).getTime()) / 60000;
  return minutosDesdeClaim >= MINUTOS_CLAIM_IMPRESSAO_AUTOMATICA_ABANDONADO;
}

/** Único ponto que decide se um pedido pode ser candidato — mesma regra tanto ao escanear quanto ao revalidar na hora de tentar. */
function pedidoEhCandidatoImpressaoAutomatica(pedido) {
  if (!_impressaoAutomaticaAtiva || !_impressaoAutomaticaAtivadaEm) return false;
  if (!IMPRESSAO_EPSON_DIRETA_ATIVA) return false; // impressão automática só existe pelo caminho Epson direto
  if (_idsImpressaoAutomaticaFinalizadosNestaAba.has(pedido.id)) return false; // já foi à Epson nesta aba — nunca de novo
  if (pedido.impressoEm) return false;
  // succeeded/failed/ambiguous nunca são reconsiderados; um 'claimed' só volta a ser candidato
  // depois de MINUTOS_CLAIM_IMPRESSAO_AUTOMATICA_ABANDONADO (claim_order_auto_print reavalia
  // isso de novo, atomicamente, no banco — este pré-filtro só evita uma tentativa óbvia que o
  // banco recusaria de qualquer jeito).
  if (pedido.autoPrintStatus && !claimImpressaoAutomaticaAbandonado(pedido)) return false;
  if (pedido.status === STATUS_PEDIDO.CANCELADO) return false;
  return new Date(pedido.criadoEm).getTime() >= new Date(_impressaoAutomaticaAtivadaEm).getTime();
}

// Metadados por id (só pra logs de latência e pra checar elegibilidade de um pedido que veio só
// do Realtime e ainda não está no cache): { detectadoEm (ms), origem, criadoEm, leve }.
const _metaImpressaoAutomatica = new Map();

/** Único ponto que entra na fila — deduplica por order.id (Set) e loga detecção/fila. Retorna true se enfileirou. */
function enfileirarImpressaoAutomatica(pedido, origem) {
  if (_idsImpressaoAutomaticaEmFilaOuTentados.has(pedido.id)) return false;
  _idsImpressaoAutomaticaEmFilaOuTentados.add(pedido.id);
  _filaImpressaoAutomatica.push(pedido.id);
  _metaImpressaoAutomatica.set(pedido.id, { detectadoEm: Date.now(), origem, criadoEm: pedido.criadoEm, leve: pedido });
  const msDesdeCriacao = pedido.criadoEm ? Date.now() - new Date(pedido.criadoEm).getTime() : null;
  console.log('[AUTO-PRINT] Pedido detectado', { id: pedido.id, numero: pedido.numero, origem, msDesdeCriacao });
  console.log('[AUTO-PRINT] Entrou na fila', { id: pedido.id, numero: pedido.numero, posicao: _filaImpressaoAutomatica.length, impressaoEmAndamento: _impressaoEmAndamento });
  return true;
}

/**
 * Caminho rápido do Realtime: linha crua de INSERT (sem itens) → mesma regra única de elegibilidade
 * → fila → processamento imediato. Itens completos só são buscados depois do claim.
 */
function processarInsertRealtimeAutoPrint(linha) {
  console.log('[AUTO-PRINT] Realtime INSERT recebido', { id: linha.id, numero: linha.order_number });
  if (!_impressaoAutomaticaAtiva) return;
  const leve = _linhaSupabaseParaPedido({ ...linha, order_items: [] });
  if (!pedidoEhCandidatoImpressaoAutomatica(leve)) return;
  if (enfileirarImpressaoAutomatica(leve, 'realtime')) processarFilaImpressaoAutomatica();
}

/** Chamado após init() e após todo reloadOrders() (nunca dentro de renderizarQuadroPedidos(), que só redesenha o cache atual). */
function escanearCandidatosImpressaoAutomatica() {
  if (!_impressaoAutomaticaAtiva) return;
  const pedidos = obterPedidosClientes();

  pedidos.forEach((pedido) => {
    if (_idsImpressaoAutomaticaEmFilaOuTentados.has(pedido.id)) return;
    if (!pedidoEhCandidatoImpressaoAutomatica(pedido)) return;
    enfileirarImpressaoAutomatica(pedido, 'scan');
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
  const meta = _metaImpressaoAutomatica.get(id) || { detectadoEm: Date.now(), origem: 'desconhecida', leve: null };
  const pedidoParaChecar = obterPedidoClientePorId(id) || meta.leve;
  if (!pedidoParaChecar || !pedidoEhCandidatoImpressaoAutomatica(pedidoParaChecar)) {
    // Já não é mais candidato (impresso/cancelado/claim resolvido ou ainda não abandonado
    // nesse meio-tempo) — não é erro.
    console.log('[AUTO-PRINT] Descartado antes do claim (não é mais candidato)', { id });
    _metaImpressaoAutomatica.delete(id);
    // Sai do Set: se o descarte foi momentâneo (ex.: configuração da impressão automática não carregou
    // naquele ciclo), a próxima varredura reavalia. Seguro — a candidatura continua decidida pelo
    // estado do pedido + claim atômico no banco; nada foi enviado à Epson.
    _idsImpressaoAutomaticaEmFilaOuTentados.delete(id);
    processarFilaImpressaoAutomatica();
    return;
  }
  const numero = pedidoParaChecar.numero;

  _impressaoEmAndamento = true;
  aplicarBloqueioBotoesImpressao();
  console.log('[AUTO-PRINT] Iniciando processamento', {
    id,
    numero,
    origem: meta.origem,
    esperouNaFilaMs: Date.now() - meta.detectadoEm,
    restantesNaFila: _filaImpressaoAutomatica.length,
  });

  try {
    await _executarImpressaoAutomaticaClaimed(id, numero, meta);
  } catch (erroInesperado) {
    // Rede de segurança: qualquer exceção não prevista nunca pode deixar o lock preso nem a fila parada.
    console.error('[AUTO-PRINT] Erro inesperado no processamento', { id, numero }, erroInesperado);
    finalizarImpressaoPedido();
  } finally {
    _metaImpressaoAutomatica.delete(id);
  }
}

/** Corpo da tentativa (claim → dados completos → XML → Epson → resolve). Toda saída termina em finalizarImpressaoPedido(), direta ou via _registrarImpressaoEFinalizar. */
async function _executarImpressaoAutomaticaClaimed(id, numero, meta) {
  const tClaim = Date.now();
  let resultadoClaim;
  try {
    resultadoClaim = await _comTimeout(claimOrderAutoPrintNoSupabase(id, _deviceIdImpressora), 10000, 'claim_order_auto_print');
  } catch (erroClaim) {
    // C3: falha de rede/timeout no claim NÃO é "outro dispositivo pegou" — o pedido nunca chegou à
    // Epson. Sai do Set pra próxima varredura tentar de novo (antes ficava preso nele até recarregar a
    // página e o pedido simplesmente não imprimia). O claim atômico no banco continua decidindo quem imprime.
    console.error('[AUTO-PRINT] Claim falhou — será tentado de novo na próxima varredura', { id, numero }, erroClaim);
    _idsComFalhaDeClaim.add(id);
    _idsImpressaoAutomaticaEmFilaOuTentados.delete(id);
    finalizarImpressaoPedido();
    return;
  }

  if (!resultadoClaim || !resultadoClaim.claimed) {
    // Se este pedido já teve um claim com erro, o UPDATE daquele claim pode ter gravado e só a resposta
    // se perdido (claim órfão desta própria aba, que nunca chegou à Epson). Libera pra reavaliação: o
    // banco só concede de novo quando o claim for considerado abandonado (2 min, regra de sempre).
    if (_idsComFalhaDeClaim.has(id)) _idsImpressaoAutomaticaEmFilaOuTentados.delete(id);
    // Outro dispositivo já reivindicou, ou um humano já imprimiu manualmente, ou a impressão
    // automática foi desativada entre o escaneamento e agora — resultado esperado, não é erro.
    console.log('[AUTO-PRINT] Claim recusado (claimed:false) — outro dispositivo/aba, já impresso, desativado ou fora da regra do banco', {
      id,
      numero,
      claimMs: Date.now() - tClaim,
    });
    finalizarImpressaoPedido();
    return;
  }
  _idsComFalhaDeClaim.delete(id);
  console.log('[AUTO-PRINT] Claim adquirido', { id, numero, claimMs: Date.now() - tClaim, desdeDeteccaoMs: Date.now() - meta.detectadoEm });

  // Dados completos: do cache se já estiver lá; senão (veio só do Realtime) busca só este pedido.
  let pedidoCompleto = obterPedidoClientePorId(id);
  if (!pedidoCompleto) {
    try {
      const lista = await _comTimeout(getOrdersWithDetails({ orderIds: [id] }), 15000, 'buscar pedido completo');
      pedidoCompleto = lista && lista[0];
    } catch (erroBusca) {
      console.error('[AUTO-PRINT] Não foi possível carregar o pedido completo:', { id, numero }, erroBusca);
    }
    if (!pedidoCompleto) {
      await _resolverImpressaoAutomaticaSemLancar(id, 'failed');
      console.log('[AUTO-PRINT] Resolve failed', { id, numero });
      finalizarImpressaoPedido();
      return;
    }
  }
  const snapshot = JSON.parse(JSON.stringify(pedidoCompleto));

  let xml;
  try {
    xml = gerarComandaEposPrintXml(snapshot);
  } catch (erroBuilder) {
    console.error('[AUTO-PRINT] Não foi possível montar a comanda:', erroBuilder);
    await _resolverImpressaoAutomaticaSemLancar(id, 'failed');
    console.log('[AUTO-PRINT] Resolve failed', { id, numero });
    finalizarImpressaoPedido();
    return;
  }

  console.log('[AUTO-PRINT] Enviando para Epson', { id, numero, desdeDeteccaoMs: Date.now() - meta.detectadoEm });
  const tEpson = Date.now();
  const resultado = await EpsonPrinterService.imprimir(xml);
  // A partir daqui o pedido JÁ FOI enviado à Epson: nunca mais entra na fila automática nesta aba,
  // independente do resultado e de resolve/register conseguirem gravar.
  _idsImpressaoAutomaticaFinalizadosNestaAba.add(id);
  console.log('[AUTO-PRINT] Epson result', {
    id,
    numero,
    codigo: resultado.codigo,
    mensagem: resultado.mensagem,
    sucesso: resultado.sucesso,
    epsonMs: Date.now() - tEpson,
  });

  if (resultado.codigo === 'SUCESSO') {
    await _resolverImpressaoAutomaticaSemLancar(id, 'succeeded');
    console.log('[AUTO-PRINT] Resolve success', { id, numero, totalDesdeDeteccaoMs: Date.now() - meta.detectadoEm });
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
  console.log(statusResolucao === 'ambiguous' ? '[AUTO-PRINT] Resolve ambiguous' : '[AUTO-PRINT] Resolve failed', { id, numero });
  // Aviso explícito ao operador (o card também mostra) — nunca reimprime sozinho.
  mostrarToast(
    statusResolucao === 'ambiguous'
      ? '⚠️ Pedido ' + numero + ': a impressora não confirmou — verifique se a comanda saiu antes de reimprimir.'
      : '⚠️ Pedido ' + numero + ': a impressão automática falhou — imprima manualmente.',
    'erro'
  );
  finalizarImpressaoPedido();
}

/** Uma tentativa de resolve; true se a RPC respondeu (resolved true ou false — repetir não muda um false). */
async function _tentarResolverImpressaoAutomatica(id, status) {
  try {
    await _comTimeout(resolveOrderAutoPrintNoSupabase(id, _deviceIdImpressora, status), 10000, 'resolve_order_auto_print');
    return true;
  } catch (erroResolver) {
    console.error('Não foi possível registrar o resultado (' + status + ') da impressão automática do pedido ' + id + ':', erroResolver);
    return false;
  }
}

/**
 * Grava o resultado terminal do claim; nunca lança — uma falha ao gravar não pode travar o lock nem a
 * fila. Se a 1ª tentativa falhar, repete EM SEGUNDO PLANO (sem segurar o lock): resolve_order_auto_print
 * é idempotente (só muda 'claimed' -> final, e só pro dono do claim), então repetir é seguro — e gravar
 * o resultado evita que, depois de 2 min, outro dispositivo trate o claim como abandonado e imprima de novo.
 * Retorna true se a 1ª tentativa gravou.
 */
async function _resolverImpressaoAutomaticaSemLancar(id, status) {
  const gravou = await _tentarResolverImpressaoAutomatica(id, status);
  if (!gravou) {
    (async () => {
      for (const espera of ESPERAS_RECUPERACAO_IMPRESSAO_MS) {
        await _esperarMs(espera);
        if (await _tentarResolverImpressaoAutomatica(id, status)) {
          console.log('[AUTO-PRINT] Resolve gravado na nova tentativa', { id, status });
          return;
        }
      }
      // Sem conseguir gravar: o pedido fica "claimed", tratado como ambíguo na UI (alertaImpressaoAutomaticaHtml);
      // nesta aba nunca volta pra fila (_idsImpressaoAutomaticaFinalizadosNestaAba).
      console.error('[AUTO-PRINT] Resolve não gravado após novas tentativas', { id, status });
    })();
  }
  // Recarga completa do cache em segundo plano — NÃO bloqueia o lock/fila (com histórico grande
  // isso atrasava o próximo pedido). Traz o autoPrintStatus novo e redesenha quando terminar.
  _comTimeout(carregarPedidosClientesCache(), 20000, 'recarregar pedidos após resolve')
    .then(() => renderizarQuadroPedidos())
    .catch((erroRecarregar) => {
      console.error('Não foi possível recarregar pedidos após resolver impressão automática:', erroRecarregar);
    });
  return gravou;
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
      ${
        typeof logoComandaDisponivel === 'function' && logoComandaDisponivel()
          ? '<img class="comanda-logo" src="logo-comanda.png" alt="LARICA" />'
          : '<div class="comanda-marca">LARICA</div>'
      }
      <div class="comanda-subtitulo">ORDEM DE PEDIDO</div>
    </div>
    <div class="comanda-numero">${escaparHtml(pedido.numero)}</div>
    <div class="comanda-linha-info">${formatarData(pedido.criadoEm)} - ${formatarHora(pedido.criadoEm)}</div>
    <div class="comanda-tipo">${ROTULO_TIPO_COMANDA[pedido.fulfilment] || 'RETIRADA'}</div>
    <hr/>
    <div class="comanda-itens">${linhasItensComandaHtml(pedido, moeda)}</div>
    <hr/>
    ${resumoFinanceiroComandaHtml(pedido, moeda)}
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

/**
 * Itens da comanda impressa (AirPrint) — exclusivo da comanda; o modal "Ver pedido" continua
 * usando linhasItensPedidoHtml(). Mesmo layout do builder Epson: "qtd x nome ...... total da linha"
 * (order_items.total_price, já com extras) e, abaixo, os complementos do combo sem preço.
 */
function linhasItensComandaHtml(pedido, moeda) {
  return (pedido.itens || [])
    .map((item) => {
      // Espeto/acompanhamento com acréscimo: valor informativo (já incluso no total do combo), de
      // extra_price gravado no pedido — extra × qtd da seleção × qtd do combo, a mesma conta do banco.
      const componenteHtml = (c) =>
        c.acrescimoUnitario > 0
          ? `<div class="comanda-item-complemento comanda-linha-valor"><span>${c.quantidade}x ${escaparHtml(c.nome)} (extra)</span><span>+${formatarMoeda(c.acrescimoUnitario * c.quantidade * item.quantidade, moeda)}</span></div>`
          : `<div class="comanda-item-complemento">${c.quantidade}x ${escaparHtml(c.nome)}</div>`;
      const complementos = item.combo
        ? [
            ...(item.combo.espetos || []).map(componenteHtml),
            ...(item.combo.acompanhamentos || []).map(componenteHtml),
            ...(item.combo.incluidos || []).map((i) => `<div class="comanda-item-complemento">${escaparHtml(i)}</div>`),
          ].join('')
        : '';
      return `
        <div class="comanda-item">
          <div class="comanda-item-nome comanda-linha-valor"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>
          ${complementos}
        </div>`;
    })
    .join('');
}

/** Subtotal/entrega/cupom/desconto/TOTAL da comanda — só valores gravados em orders, nada recalculado. */
function resumoFinanceiroComandaHtml(pedido, moeda) {
  const linha = (rotulo, valor) => `<div class="comanda-linha-valor"><span>${rotulo}</span><span>${valor}</span></div>`;
  const rotuloEntrega = pedido.taxaEntregaOriginal != null
    ? `ENTREGA GRÁTIS (era ${formatarMoeda(pedido.taxaEntregaOriginal, moeda)}):`
    : 'ENTREGA:';
  const rotuloDesconto = pedido.tipoDesconto === 'percentage' && pedido.valorDescontoCupom != null
    ? `DESCONTO (${String(pedido.valorDescontoCupom).replace('.', ',')}%):`
    : 'DESCONTO:';
  return `
    <div class="comanda-resumo">
      ${linha('SUBTOTAL:', formatarMoeda(pedido.subtotal, moeda))}
      ${pedido.fulfilment === 'entrega' ? linha(rotuloEntrega, formatarMoeda(pedido.taxaEntrega, moeda)) : ''}
      ${pedido.codigoCupom ? `<div class="comanda-cupom">CUPOM: ${escaparHtml(pedido.codigoCupom)}</div>` : ''}
      ${pedido.valorDesconto > 0 ? linha(rotuloDesconto, '-' + formatarMoeda(pedido.valorDesconto, moeda)) : ''}
    </div>
    <hr/>
    <div class="comanda-total comanda-linha-valor"><span>TOTAL:</span><span>${formatarMoeda(pedido.total, moeda)}</span></div>`;
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
    <div class="card card-pedido ${novo ? 'card-pedido-novo' : ''} ${pedidoEmDestaqueNovo(pedido.id) ? 'pedido-novo-alerta' : ''} demora-${nivelDemora}" data-id="${pedido.id}">
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
