// Casos de teste estáticos do parser determinístico (W6.2). Módulo
// autocontido, sem dependência externa (não há runner de teste no
// projeto e nenhum framework novo foi instalado por causa desta
// etapa) — runParserTests() pode ser chamada manualmente por uma
// etapa futura quando um runner for escolhido; não está plugada a
// nenhum CI/build.

import { normalizeWhatsAppText, parseDeterministicIntent } from './parser';
import type { WhatsAppIntent, WhatsAppSessionState } from './types';

interface CasoTesteIntent {
  descricao: string;
  texto: string;
  state: WhatsAppSessionState;
  esperado: WhatsAppIntent;
}

const CASOS_INTENT: CasoTesteIntent[] = [
  // PT
  { descricao: 'PT menu', texto: 'menu', state: 'greeting', esperado: { intent: 'show_menu' } },
  { descricao: 'PT cardápio', texto: 'cardápio', state: 'greeting', esperado: { intent: 'show_menu' } },
  { descricao: 'PT carrinho', texto: 'carrinho', state: 'building_cart', esperado: { intent: 'get_cart' } },
  {
    descricao: 'PT retirada',
    texto: 'retirada',
    state: 'collecting_fulfilment',
    esperado: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  },
  {
    descricao: 'PT entrega',
    texto: 'entrega',
    state: 'collecting_fulfilment',
    esperado: { intent: 'set_fulfilment_type', fulfilment_type: 'delivery' },
  },
  { descricao: 'PT ajuda', texto: 'ajuda', state: 'greeting', esperado: { intent: 'show_help' } },
  { descricao: 'PT atendente', texto: 'atendente', state: 'greeting', esperado: { intent: 'request_human_handoff' } },
  { descricao: 'PT cancelar', texto: 'cancelar', state: 'building_cart', esperado: { intent: 'cancel_conversation' } },
  {
    descricao: 'PT confirmar em reviewing_order',
    texto: 'confirmar',
    state: 'reviewing_order',
    esperado: { intent: 'confirm_review' },
  },
  {
    descricao: 'PT confirmar em awaiting_confirmation',
    texto: 'confirmar',
    state: 'awaiting_confirmation',
    esperado: { intent: 'confirm_order' },
  },
  {
    descricao: 'PT confirmar em building_cart (não deve promover)',
    texto: 'confirmar',
    state: 'building_cart',
    esperado: { intent: 'unknown' },
  },
  { descricao: 'PT "ok" não é confirmação', texto: 'ok', state: 'awaiting_confirmation', esperado: { intent: 'unknown' } },
  { descricao: 'PT "sim" não é confirmação', texto: 'sim', state: 'reviewing_order', esperado: { intent: 'unknown' } },
  { descricao: 'PT texto livre cai em unknown', texto: 'quero 2 frangos', state: 'building_cart', esperado: { intent: 'unknown' } },

  // EN
  { descricao: 'EN menu', texto: 'menu', state: 'greeting', esperado: { intent: 'show_menu' } },
  { descricao: 'EN cart', texto: 'cart', state: 'building_cart', esperado: { intent: 'get_cart' } },
  {
    descricao: 'EN collection',
    texto: 'collection',
    state: 'collecting_fulfilment',
    esperado: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  },
  {
    descricao: 'EN pickup',
    texto: 'pickup',
    state: 'collecting_fulfilment',
    esperado: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  },
  {
    descricao: 'EN delivery',
    texto: 'delivery',
    state: 'collecting_fulfilment',
    esperado: { intent: 'set_fulfilment_type', fulfilment_type: 'delivery' },
  },
  { descricao: 'EN help', texto: 'help', state: 'greeting', esperado: { intent: 'show_help' } },
  { descricao: 'EN agent', texto: 'agent', state: 'greeting', esperado: { intent: 'request_human_handoff' } },
  { descricao: 'EN cancel', texto: 'cancel', state: 'building_cart', esperado: { intent: 'cancel_conversation' } },
  {
    descricao: 'EN confirm em reviewing_order',
    texto: 'confirm',
    state: 'reviewing_order',
    esperado: { intent: 'confirm_review' },
  },
  {
    descricao: 'EN confirm em awaiting_confirmation',
    texto: 'confirm',
    state: 'awaiting_confirmation',
    esperado: { intent: 'confirm_order' },
  },
  { descricao: 'EN "yes" não é confirmação', texto: 'yes', state: 'awaiting_confirmation', esperado: { intent: 'unknown' } },
  { descricao: 'EN "sure" não é confirmação', texto: 'sure', state: 'reviewing_order', esperado: { intent: 'unknown' } },
];

interface CasoTesteNormalizacao {
  texto: string;
  esperado: string;
}

const CASOS_NORMALIZACAO: CasoTesteNormalizacao[] = [
  { texto: '  CARDÁPIO  ', esperado: 'cardapio' },
  { texto: 'ENTREGA!', esperado: 'entrega' },
  { texto: '   confirm   ', esperado: 'confirm' },
];

function intentsIguais(a: WhatsAppIntent, b: WhatsAppIntent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function runParserTests(): { total: number; falhas: string[] } {
  const falhas: string[] = [];

  for (const caso of CASOS_INTENT) {
    const resultado = parseDeterministicIntent(caso.texto, caso.state, undefined);
    if (!intentsIguais(resultado, caso.esperado)) {
      falhas.push(
        `${caso.descricao}: esperado ${JSON.stringify(caso.esperado)}, obtido ${JSON.stringify(resultado)}`
      );
    }
  }

  for (const caso of CASOS_NORMALIZACAO) {
    const { normalized } = normalizeWhatsAppText(caso.texto);
    if (normalized !== caso.esperado) {
      falhas.push(`normalização "${caso.texto}": esperado "${caso.esperado}", obtido "${normalized}"`);
    }
  }

  return { total: CASOS_INTENT.length + CASOS_NORMALIZACAO.length, falhas };
}
