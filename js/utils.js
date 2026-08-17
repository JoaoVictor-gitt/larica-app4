/*
 * utils.js
 * Funções puras e reutilizáveis: nenhuma delas lê ou grava no localStorage.
 * Usadas por todas as páginas do sistema.
 */

// Categorias padrão sugeridas para os produtos (o campo é texto livre, isso é só sugestão no <select>)
const CATEGORIAS_PADRAO = ['Combos', 'Espetinhos', 'Acompanhamentos', 'Bebidas', 'Outro'];

/**
 * Gera um id único. Usa crypto.randomUUID quando disponível (a maioria dos
 * navegadores modernos), com fallback manual para ambientes mais antigos.
 */
function gerarId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Calcula o status visual do estoque a partir da quantidade.
 * Regra: 0 = cinza (sem estoque), <5 = vermelho, 5-10 = amarelo, >10 = verde.
 * Nunca é armazenado — sempre recalculado a partir da quantidade real.
 */
function calcularStatusEstoque(quantidade) {
  const qtd = Number(quantidade) || 0;
  if (qtd <= 0) return 'cinza';
  if (qtd < 5) return 'vermelho';
  if (qtd <= 10) return 'amarelo';
  return 'verde';
}

/** Rótulo textual para cada status de estoque (usado em badges/tooltips) */
function rotuloStatusEstoque(status) {
  const rotulos = {
    verde: 'Estoque bom',
    amarelo: 'Estoque baixo',
    vermelho: 'Estoque crítico',
    cinza: 'Sem estoque',
  };
  return rotulos[status] || '';
}

/**
 * Formata um valor numérico como moeda, respeitando o código informado
 * (padrão EUR). Usa Intl.NumberFormat para exibir o símbolo correto.
 */
function formatarMoeda(valor, codigoMoeda) {
  const codigo = codigoMoeda || 'EUR';
  const numero = Number(valor) || 0;
  try {
    return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: codigo }).format(numero);
  } catch (erro) {
    return numero.toFixed(2) + ' ' + codigo;
  }
}

/** Formata uma data ISO para o formato dd/mm/aaaa */
function formatarData(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  if (isNaN(data.getTime())) return '';
  return data.toLocaleDateString('pt-PT');
}

/** Formata uma data ISO para o formato hh:mm */
function formatarHora(iso) {
  if (!iso) return '';
  const data = new Date(iso);
  if (isNaN(data.getTime())) return '';
  return data.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

/** Verifica se uma data ISO cai no dia de hoje */
function ehHoje(iso) {
  if (!iso) return false;
  const data = new Date(iso);
  const hoje = new Date();
  return (
    data.getFullYear() === hoje.getFullYear() &&
    data.getMonth() === hoje.getMonth() &&
    data.getDate() === hoje.getDate()
  );
}

/**
 * Calcula o subtotal de um carrinho a partir dos itens e do preço unitário
 * já registado em cada item (snapshot no momento em que foi adicionado).
 */
function calcularSubtotalCarrinho(carrinho) {
  return (carrinho || []).reduce((soma, item) => soma + item.precoUnitario * item.quantidade, 0);
}

/** Calcula o total do carrinho somando a taxa de entrega ao subtotal */
function calcularTotalCarrinho(subtotal, taxaEntrega) {
  return subtotal + (Number(taxaEntrega) || 0);
}

/**
 * Calcula o total de um combo personalizado: preço base + acréscimos dos
 * espetos escolhidos (cada um com sua própria quantidade e acréscimo
 * unitário). Acompanhamentos não têm acréscimo dentro do combo. Função pura,
 * reaproveitada pelo modal de personalização em pedido.js.
 */
function calcularTotalCombo(precoBase, espetosEscolhidos) {
  const extras = (espetosEscolhidos || []).reduce(
    (soma, e) => soma + (Number(e.acrescimoUnitario) || 0) * (Number(e.quantidade) || 0),
    0
  );
  return { extras, total: (Number(precoBase) || 0) + extras };
}

/**
 * Separa os "itens inclusos" de um combo (comboConfig.includedItems, uma
 * lista de ids de produto) entre os que ainda resolvem para um produto ativo
 * e os indisponíveis (produto inativo ou excluído). Não altera nada — só
 * informa, pra quem chamar decidir o que mostrar (aviso no admin, lista pro
 * cliente, snapshot do carrinho, etc.). Função pura, reaproveitada por
 * produtos.js e pedido.js.
 */
function separarItensInclusosCombo(includedItemsIds, produtos) {
  const disponiveis = [];
  const indisponiveis = [];
  (includedItemsIds || []).forEach((id) => {
    const produto = (produtos || []).find((p) => p.id === id);
    if (produto && produto.status === 'ativo' && produto.disponivel) disponiveis.push(produto);
    else indisponiveis.push({ id, nome: produto ? produto.nome : null });
  });
  return { disponiveis, indisponiveis };
}

/** Aplica o tema claro/escuro no elemento <html> (usado pelo toggle em Configurações) */
function aplicarTema(tema) {
  document.documentElement.setAttribute('data-tema', tema === 'escuro' ? 'escuro' : 'claro');
}

/** Escapa texto para uso seguro dentro de innerHTML (evita XSS básico) */
function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto == null ? '' : String(texto);
  return div.innerHTML;
}

/** Debounce simples — atrasa a execução de uma função até o usuário parar de digitar */
function debounce(fn, atraso) {
  let temporizador;
  return function (...args) {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn.apply(this, args), atraso || 300);
  };
}

/** Exibe uma notificação toast simples no canto da tela */
function mostrarToast(mensagem, tipo) {
  const container = document.getElementById('toast-container') || criarContainerToast();
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + (tipo || 'info');
  toast.textContent = mensagem;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visivel'));
  setTimeout(() => {
    toast.classList.remove('toast-visivel');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function criarContainerToast() {
  const container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);
  return container;
}

/**
 * Copia texto pro clipboard — Clipboard API quando disponível (contexto seguro/HTTPS), com fallback via
 * <textarea> temporário + document.execCommand('copy') pra navegadores/contextos sem suporte. Nunca falha
 * em silêncio: lança erro se as duas estratégias não funcionarem, pra quem chama poder avisar o usuário.
 */
async function copiarTextoParaClipboard(texto) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(texto);
    return;
  }

  const campoTemporario = document.createElement('textarea');
  campoTemporario.value = texto;
  campoTemporario.style.position = 'fixed';
  campoTemporario.style.opacity = '0';
  document.body.appendChild(campoTemporario);
  campoTemporario.focus();
  campoTemporario.select();

  let sucesso = false;
  try {
    sucesso = document.execCommand('copy');
  } catch (erro) {
    sucesso = false;
  }
  document.body.removeChild(campoTemporario);

  if (!sucesso) throw new Error('Não foi possível copiar automaticamente.');
}

/**
 * Formata um Eircode enquanto o usuário digita: maiúsculas + espaço na
 * posição certa (3 caracteres + espaço + 4 caracteres). Ex.: "d03fx92" -> "D03 FX92".
 */
function formatarEircode(valor) {
  const limpo = (valor == null ? '' : String(valor)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
  if (limpo.length <= 3) return limpo;
  return limpo.slice(0, 3) + ' ' + limpo.slice(3);
}

/**
 * Valida apenas o FORMATO de um Eircode irlandês (routing key de 3 caracteres +
 * identificador único de 4), sem checar endereço real via API. Ponto único a
 * trocar futuramente por uma validação real contra um serviço de Eircode/endereços.
 */
function validarFormatoEircode(valor) {
  const normalizado = (valor == null ? '' : String(valor)).toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{3}[A-Z0-9]{4}$/.test(normalizado);
}

/**
 * Formata um telefone enquanto o usuário digita, no padrão irlandês:
 * nacional "08X XXX XXXX" (10 dígitos) ou internacional "+353 XX XXX XXXX"
 * (quando começa com "+" ou "353"). Puramente visual — não valida.
 */
function formatarTelefoneIrlandes(valor) {
  const bruto = valor == null ? '' : String(valor);
  const comMais = bruto.trim().startsWith('+');
  const digitos = bruto.replace(/\D/g, '');

  if (comMais || digitos.startsWith('353')) {
    const resto = digitos.startsWith('353') ? digitos.slice(3) : digitos;
    const limitado = resto.slice(0, 9);
    let formatado = '+353';
    if (limitado.length > 0) formatado += ' ' + limitado.slice(0, 2);
    if (limitado.length > 2) formatado += ' ' + limitado.slice(2, 5);
    if (limitado.length > 5) formatado += ' ' + limitado.slice(5, 9);
    return formatado;
  }

  const limitado = digitos.slice(0, 10);
  let formatado = limitado.slice(0, 3);
  if (limitado.length > 3) formatado += ' ' + limitado.slice(3, 6);
  if (limitado.length > 6) formatado += ' ' + limitado.slice(6, 10);
  return formatado;
}

/**
 * Valida apenas o FORMATO de um telefone irlandês: nacional "08" + 8 dígitos
 * (10 no total, ex.: 0838097018) ou internacional "353" + "8" + 8 dígitos
 * (ex.: 353838097018, equivalente a +353 83 809 7018). Sem checagem real
 * junto a operadora — só formato.
 */
function validarFormatoTelefoneIrlandes(valor) {
  const digitos = (valor == null ? '' : String(valor)).replace(/\D/g, '');
  if (digitos.startsWith('353')) {
    return /^8\d{8}$/.test(digitos.slice(3));
  }
  return /^08\d{8}$/.test(digitos);
}

// ---------------------------------------------------------------------------
// Pedidos: status, rótulos e formas de pagamento (usado por pedido.js e
// pedidos.js — estrutura central, nada de string solta espalhada pelo código)
// ---------------------------------------------------------------------------

/** Chaves internas de status de um pedido, na ordem em que acontecem */
const STATUS_PEDIDO = {
  SOLICITADO: 'solicitado',
  EM_PREPARO: 'em_preparo',
  PRONTO: 'pronto',
  FINALIZADO: 'finalizado',
  CANCELADO: 'cancelado',
};

// Representa SOMENTE o fluxo operacional normal (Aceitar -> Pronto -> Concluir) — cancelado é um desvio
// à parte (RPC própria, cancel_order), nunca faz parte dessa sequência linear.
const SEQUENCIA_STATUS_PEDIDO = [STATUS_PEDIDO.SOLICITADO, STATUS_PEDIDO.EM_PREPARO, STATUS_PEDIDO.PRONTO, STATUS_PEDIDO.FINALIZADO];

const ROTULOS_STATUS_PEDIDO = {
  solicitado: 'Solicitado',
  em_preparo: 'Em Preparo',
  pronto: 'Pronto',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
};

const ROTULOS_FORMA_PAGAMENTO = { cartao: 'Cartão', dinheiro: 'Dinheiro', revolut: 'Revolut', transferencia: 'Transferência bancária' };

/**
 * Status do PAGAMENTO de um pedido — conceito separado de STATUS_PEDIDO (esse é o status do fluxo
 * operacional: Solicitado/Em Preparo/Pronto/Finalizado/Cancelado). 'legado' só existe em pedidos
 * criados antes desta feature (Fase 9) — nenhum código novo atribui 'legado' a um pedido.
 */
const STATUS_PAGAMENTO = {
  PENDENTE: 'pendente',
  PAGO: 'pago',
  PAGAR_NA_ENTREGA: 'pagar_na_entrega',
  LEGADO: 'legado',
};

const ROTULOS_STATUS_PAGAMENTO = {
  pendente: 'Aguardando confirmação',
  pago: 'Pagamento confirmado',
  pagar_na_entrega: 'Pagamento na retirada/entrega',
  legado: 'Pagamento anterior ao novo sistema',
};

/** Rótulos pt-BR pros movement_type de stock_movements (tela Estoque > Movimentações recentes) */
const ROTULOS_TIPO_MOVIMENTACAO_ESTOQUE = { sale: 'Venda', manual_addition: 'Entrada', manual_removal: 'Saída' };

/** Converte a duração da Edge Function calculate-delivery (ex.: "532s") num texto amigável em minutos, ou '' se inválida */
function formatarDuracaoBicicleta(duracaoTexto) {
  const segundos = parseInt(String(duracaoTexto || '').replace(/[^0-9]/g, ''), 10);
  if (!segundos || isNaN(segundos)) return '';
  const minutos = Math.max(1, Math.round(segundos / 60));
  return `Tempo estimado de bicicleta: aproximadamente ${minutos} min`;
}

/** Troco = valorPago - total, arredondado a 2 casas; null se valorPago inválido ou menor que o total (nunca negativo) */
function calcularTroco(valorPago, total) {
  if (typeof valorPago !== 'number' || isNaN(valorPago) || valorPago < total) return null;
  return Math.round((valorPago - total) * 100) / 100;
}

/** Limites (em minutos) usados pro indicador de demora dos pedidos — centralizados aqui, fácil de reconfigurar depois */
const LIMITES_ALERTA_DEMORA_PEDIDO = { atencaoMin: 15, atrasadoMin: 25 };

/** 'normal' | 'atencao' | 'atrasado', a partir dos minutos decorridos desde que o pedido foi feito */
function calcularNivelDemoraPedido(minutos) {
  if (minutos >= LIMITES_ALERTA_DEMORA_PEDIDO.atrasadoMin) return 'atrasado';
  if (minutos >= LIMITES_ALERTA_DEMORA_PEDIDO.atencaoMin) return 'atencao';
  return 'normal';
}

/** Formata "há X min" / "há Xh Ymin" a partir de uma data ISO até agora */
function formatarTempoDecorrido(iso) {
  if (!iso) return '';
  const inicio = new Date(iso).getTime();
  if (isNaN(inicio)) return '';
  const minutos = Math.max(0, Math.floor((Date.now() - inicio) / 60000));
  if (minutos < 1) return 'agora mesmo';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto > 0 ? `há ${horas}h ${resto}min` : `há ${horas}h`;
}

/**
 * Formata uma DURAÇÃO (não um "há X" a partir de agora) em segundos, de forma compacta e sem
 * timestamps crus/frações de hora — usada pelo Tempo de Preparo (Etapa 1, Pedidos). `segundos` null/
 * inválido/negativo devolve "—" (nunca quebra a tela, nunca mostra duração negativa — timestamps
 * inconsistentes já são filtrados antes de chegar aqui, ver calcularTemposPedido() em pedidos.js).
 * Regra: <1min mostra só segundos; <1h mostra minutos, e só acrescenta segundos se sobrar resto
 * (não mostra "4 min 0s"); >=1h mostra horas+minutos, nunca segundos (granularidade grossa o
 * suficiente pra não precisar).
 */
function formatarDuracao(segundos) {
  if (segundos === null || segundos === undefined || !Number.isFinite(segundos) || segundos < 0) return '—';

  const totalSegundos = Math.floor(segundos);
  const horas = Math.floor(totalSegundos / 3600);
  const minutos = Math.floor((totalSegundos % 3600) / 60);
  const segundosRestantes = totalSegundos % 60;

  if (horas > 0) return `${horas}h ${minutos}min`;
  if (totalSegundos < 60) return `${segundosRestantes}s`;
  return segundosRestantes > 0 ? `${minutos} min ${segundosRestantes}s` : `${minutos} min`;
}

// ---------------------------------------------------------------------------
// Cupons: conversão datetime-local <-> Europe/Dublin (validade de cupons)
// ---------------------------------------------------------------------------

/** timestamptz do Supabase (ISO/UTC) -> valor pronto pro <input type="datetime-local">, no fuso informado. */
function timestamptzParaDatetimeLocal(isoUtc, fuso) {
  if (!isoUtc) return '';
  const data = new Date(isoUtc);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso || 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(data);
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${mapa.year}-${mapa.month}-${mapa.day}T${mapa.hour}:${mapa.minute}`;
}

/** Offset (em minutos) do fuso informado num instante específico — formata o instante nesse fuso e reinterpreta como UTC pra medir a diferença. */
function _offsetMinutosDoFusoEm(instanteMs, fuso) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instanteMs));
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  const comoUtcMs = Date.UTC(
    Number(mapa.year),
    Number(mapa.month) - 1,
    Number(mapa.day),
    Number(mapa.hour),
    Number(mapa.minute),
    Number(mapa.second)
  );
  return Math.round((comoUtcMs - instanteMs) / 60000);
}

/**
 * Offsets (minutos) candidatos pra resolver um datetime-local em Europe/Dublin, amostrados em 1º de
 * janeiro e 1º de julho do ano informado (datas sempre bem distantes de qualquer transição de DST) —
 * pra Dublin isso dá [0, 60] (GMT e IST). Não é uma solução genérica pra "descobrir todos os offsets
 * de qualquer fuso": é uma estratégia desenhada especificamente pra Europe/Dublin, que só tem essas
 * duas transições por ano (não serve como garantia pra fusos com regras de DST diferentes).
 */
function _offsetsCandidatosDoAno(ano, fuso) {
  const offsetJaneiro = _offsetMinutosDoFusoEm(Date.UTC(ano, 0, 1, 12), fuso);
  const offsetJulho = _offsetMinutosDoFusoEm(Date.UTC(ano, 6, 1, 12), fuso);
  return Array.from(new Set([offsetJaneiro, offsetJulho]));
}

/**
 * "YYYY-MM-DDTHH:MM" (valor de <input type="datetime-local">) -> instante UTC correto no fuso
 * informado, como ISO string. Necessário porque `new Date('YYYY-MM-DDTHH:MM')` usa o fuso do
 * navegador, não o do estabelecimento.
 *
 * Não assume convergência em 1 passo: testa cada offset que o fuso realmente assume naquele ano
 * (via _offsetsCandidatosDoAno) e só aceita um candidato se o round-trip (candidato -> fuso alvo ->
 * datetime-local de novo) bater exatamente com o valor pedido. Se nenhum candidato bater, o horário
 * local não existe (pulo da mudança pro horário de verão) — erro. Se mais de um candidato bater, o
 * horário é ambíguo (ocorre duas vezes na volta do horário de verão) — erro pedindo outro horário,
 * nunca escolhe uma das duas ocorrências arbitrariamente.
 */
function datetimeLocalParaUtcIso(valor, fuso) {
  if (!valor) return null;
  const fusoAlvo = fuso || 'Europe/Dublin';
  const ano = Number(valor.slice(0, 4));
  const alvoComoUtcMs = new Date(valor + ':00.000Z').getTime();

  const candidatosValidos = [];
  for (const offsetMinutos of _offsetsCandidatosDoAno(ano, fusoAlvo)) {
    const candidatoUtcMs = alvoComoUtcMs - offsetMinutos * 60000;
    if (timestamptzParaDatetimeLocal(new Date(candidatoUtcMs).toISOString(), fusoAlvo) === valor) {
      candidatosValidos.push(candidatoUtcMs);
    }
  }

  if (candidatosValidos.length === 0) {
    throw new Error('Este horário não existe (a mudança para o horário de verão pula essa hora). Escolha outro horário.');
  }
  if (candidatosValidos.length > 1) {
    throw new Error('Este horário é ambíguo — ocorre duas vezes por causa da volta do horário de verão. Escolha outro horário.');
  }

  return new Date(candidatosValidos[0]).toISOString();
}

// ---------------------------------------------------------------------------
// Horário de retirada (Fazer Pedido, etapa "Dados para retirada")
// ---------------------------------------------------------------------------

/** Tempo mínimo (minutos) entre agora e o horário de retirada que o cliente pode escolher — só mexer aqui pra reconfigurar */
const MINUTOS_MINIMOS_PREPARO_RETIRADA = 20;

/** Menor horário (HH:MM, no fuso local, hoje) que o cliente pode escolher pra retirada, dado o tempo mínimo de preparo */
function horarioMinimoRetirada() {
  const minimo = new Date(Date.now() + MINUTOS_MINIMOS_PREPARO_RETIRADA * 60000);
  const dois = (n) => String(n).padStart(2, '0');
  return `${dois(minimo.getHours())}:${dois(minimo.getMinutes())}`;
}

/** Um horário (HH:MM) é válido pra retirada se não for antes de agora + MINUTOS_MINIMOS_PREPARO_RETIRADA */
function validarHorarioRetirada(horarioHHMM) {
  return !!horarioHHMM && horarioHHMM >= horarioMinimoRetirada();
}

/** "Assim que possível" ou "HH:MM" — usado nos detalhes completos do pedido (modal admin) */
function rotuloHorarioRetirada(pedido) {
  const retirada = pedido.retirada || {};
  return retirada.modo === 'horario' && retirada.horario ? retirada.horario : 'Assim que possível';
}

/** "ASAP" ou "HH:MM" — versão compacta, usada no card do Kanban */
function rotuloCompactoHorarioRetirada(pedido) {
  const retirada = pedido.retirada || {};
  return retirada.modo === 'horario' && retirada.horario ? retirada.horario : 'ASAP';
}
