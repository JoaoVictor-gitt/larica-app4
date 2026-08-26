// Parser determinístico do WhatsApp (W6.2) — só comandos inequívocos,
// sem custo/rede/IA. Qualquer texto fora da tabela fixa vira
// {intent:'unknown'} e caberá à IA (W6.7, ainda não implementada).
//
// Normalização: NFD + remoção de diacríticos + lowercase + trim +
// colapso de espaços + remoção de pontuação final simples. Isso já
// resolve "cardápio"/"cardapio" como a mesma chave normalizada — a
// tabela de comandos guarda só a forma sem acento, uma vez, sem
// duplicar entradas pra cada variante ortográfica.
//
// PT e EN compartilham UMA tabela só (nenhuma colisão de sentido
// entre os comandos suportados) — o parâmetro `language` é aceito na
// assinatura pra uso futuro (priorizar alias em caso de ambiguidade
// entre idiomas), mas não influencia nenhum resultado nesta etapa.
//
// "ok"/"sim"/"pode"/"beleza"/"yes"/"sure" são DELIBERADAMENTE
// ausentes da tabela — não é omissão, é a regra conservadora do W6.1:
// só uma confirmação inequívoca ("confirmar"/"confirm") promove
// state; qualquer coisa mais frouxa cai em unknown.
//
// "confirmar"/"confirm" nunca está na tabela fixa — é resolvido à
// parte, dependente de state (única ambiguidade real do sistema,
// mesma frase vira 2 RPCs diferentes conforme o W6.1).

import type { WhatsAppIntent, WhatsAppLanguage, WhatsAppSessionState } from './types';

export interface NormalizedWhatsAppText {
  raw: string;
  normalized: string;
}

export function normalizeWhatsAppText(raw: string): NormalizedWhatsAppText {
  const semAcentos = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normalized = semAcentos
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[!?.,;:]+$/g, '')
    .trim();
  return { raw, normalized };
}

const COMANDOS_DETERMINISTICOS: Record<string, WhatsAppIntent> = {
  menu: { intent: 'show_menu' },
  cardapio: { intent: 'show_menu' },

  carrinho: { intent: 'get_cart' },
  cart: { intent: 'get_cart' },

  retirada: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  retirar: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  buscar: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  collection: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },
  pickup: { intent: 'set_fulfilment_type', fulfilment_type: 'collection' },

  entrega: { intent: 'set_fulfilment_type', fulfilment_type: 'delivery' },
  delivery: { intent: 'set_fulfilment_type', fulfilment_type: 'delivery' },

  ajuda: { intent: 'show_help' },
  help: { intent: 'show_help' },

  atendente: { intent: 'request_human_handoff' },
  humano: { intent: 'request_human_handoff' },
  human: { intent: 'request_human_handoff' },
  agent: { intent: 'request_human_handoff' },

  cancelar: { intent: 'cancel_conversation' },
  cancel: { intent: 'cancel_conversation' },
};

export function parseDeterministicIntent(
  text: string,
  state: WhatsAppSessionState,
  language?: WhatsAppLanguage
): WhatsAppIntent {
  void language; // reservado pra desambiguação futura — sem uso nesta etapa

  const { normalized } = normalizeWhatsAppText(text);

  if (normalized === 'confirmar' || normalized === 'confirm') {
    if (state === 'reviewing_order') return { intent: 'confirm_review' };
    if (state === 'awaiting_confirmation') return { intent: 'confirm_order' };
    return { intent: 'unknown' };
  }

  return COMANDOS_DETERMINISTICOS[normalized] ?? { intent: 'unknown' };
}
