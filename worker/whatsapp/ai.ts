// Interpretação de linguagem natural via OpenAI structured output
// (W6.7) — SÓ interpreta, nunca executa. IA nunca toca Supabase
// diretamente, nunca escolhe nome de RPC, nunca calcula valor
// financeiro, nunca produz confirm_review/confirm_order/
// request_human_handoff/cancel_conversation/show_help (ausentes do
// schema E do validador abaixo — barreira dupla por OMISSÃO
// estrutural: não é uma checagem que pode falhar, é uma variante que
// simplesmente não existe em nenhum dos dois contratos).
//
// Contexto enviado à OpenAI: mensagem atual, language (fallback 'pt'
// — nenhuma RPC hoje devolve whatsapp_sessions.language, mesmo gap já
// documentado em replies.ts/W6.6), state, cardápio público (nome/
// categoria/preço/disponibilidade — nunca product_costs/fornecedor/
// stock_mode/product_id), carrinho seguro (cart_index 1-based + nome
// + quantidade — nunca product_id). NUNCA enviado: telefone, nome do
// cliente, endereço armazenado da sessão, raw_payload da Meta,
// qualquer secret (SUPABASE_SERVICE_ROLE_KEY/OPENAI_API_KEY/
// META_APP_SECRET), headers, UUID de sessão/produto.
//
// Validação dupla (seção 9 do pedido): mesmo com structured output
// (que já impõe o schema do lado da OpenAI, strict:true), este módulo
// revalida tipo/enum/faixa de cada campo de cada ação recebida —
// nunca confia só na garantia da API. Uma única ação inválida invalida
// o envelope inteiro (retorna null) — zero mutação parcial por
// confiar em dado parcialmente bom.
//
// Timeout de 8s via AbortController. Qualquer erro (rede, timeout,
// resposta não-2xx, JSON malformado, schema inválido) retorna null —
// nunca lança, nunca expõe corpo de erro upstream. O chamador
// (worker/index.ts) trata null como "IA indisponível", zero mutação.

import type { WhatsAppIntent, WhatsAppLanguage, WhatsAppSessionState } from './types';
import { chamarRpcWhatsapp, type WhatsAppServiceEnv } from './dispatcher';

export interface WhatsAppAiServiceEnv extends WhatsAppServiceEnv {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
}

export interface WhatsAppAiInput {
  message: string;
  language: WhatsAppLanguage;
  state: WhatsAppSessionState;
  sessionId: string;
}

const INTENTS_PERMITIDAS_IA = [
  'show_menu',
  'get_cart',
  'add_item',
  'add_item_batch',
  'remove_item',
  'clear_cart',
  'set_fulfilment_type',
  'set_address',
  'set_delivery_instructions',
  'set_payment_method',
  'set_cash_change',
  'apply_coupon',
  'remove_coupon',
  'review_order',
  'unknown',
] as const;

const PROMPT_SISTEMA = `You interpret customer messages for a restaurant WhatsApp ordering assistant. You NEVER execute actions — you only classify intent into the given structured format.
Rules:
- Never invent products — use only the exact names from the provided menu.
- Never calculate price, discount, delivery fee, or total.
- Never confirm or create an order.
- To remove an item, only use its numeric cart_index (never guess by name).
- Only use clear_cart when the customer clearly wants to empty the ENTIRE cart (e.g. "clear my cart", "start over"). A complaint about a single item (e.g. "I don't want that one") must map to remove_item (if you can identify its cart_index from the given cart) or unknown — never clear_cart.
- If the message is ambiguous or doesn't match a clear action, return intent "unknown".
- Always answer only in the structured format — never free text.`;

const ESQUEMA_ITEM_BATCH = {
  type: 'object',
  additionalProperties: false,
  properties: {
    item_name: { type: 'string' },
    quantity: { type: 'integer', minimum: 1 },
  },
  required: ['item_name', 'quantity'],
} as const;

// Nenhuma variante abaixo tem price/subtotal/discount/delivery_fee/
// distance/total/order_id/order_number/state/rpc/sql. confirm_review/
// confirm_order/request_human_handoff/cancel_conversation/show_help
// estão AUSENTES de propósito (seção 16/23 do pedido) — impossível
// pro schema aceitar essas intents, não é uma checagem que pode
// falhar em runtime.
export const ESQUEMA_INTENTS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        anyOf: [
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'show_menu' } }, required: ['intent'] },
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'get_cart' } }, required: ['intent'] },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'add_item' }, item_name: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
            required: ['intent', 'item_name', 'quantity'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { const: 'add_item_batch' },
              items: { type: 'array', minItems: 1, maxItems: 10, items: ESQUEMA_ITEM_BATCH },
            },
            required: ['intent', 'items'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'remove_item' }, cart_index: { type: 'integer', minimum: 1 } },
            required: ['intent', 'cart_index'],
          },
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'clear_cart' } }, required: ['intent'] },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'set_fulfilment_type' }, fulfilment_type: { enum: ['collection', 'delivery'] } },
            required: ['intent', 'fulfilment_type'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { const: 'set_address' },
              eircode: { type: 'string' },
              address_line_1: { type: 'string' },
              address_line_2: { type: ['string', 'null'] },
              area: { type: ['string', 'null'] },
            },
            required: ['intent', 'eircode', 'address_line_1', 'address_line_2', 'area'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'set_delivery_instructions' }, instructions: { type: ['string', 'null'] } },
            required: ['intent', 'instructions'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'set_payment_method' }, payment_method: { enum: ['card', 'cash', 'revolut', 'bank_transfer'] } },
            required: ['intent', 'payment_method'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'set_cash_change' }, needs_change: { type: 'boolean' }, cash_amount: { type: ['number', 'null'] } },
            required: ['intent', 'needs_change', 'cash_amount'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { intent: { const: 'apply_coupon' }, coupon_code: { type: 'string' } },
            required: ['intent', 'coupon_code'],
          },
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'remove_coupon' } }, required: ['intent'] },
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'review_order' } }, required: ['intent'] },
          { type: 'object', additionalProperties: false, properties: { intent: { const: 'unknown' } }, required: ['intent'] },
        ],
      },
    },
  },
  required: ['actions'],
} as const;

export function validarWhatsAppIntentDaIa(bruto: unknown): WhatsAppIntent | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const d = bruto as Record<string, unknown>;

  switch (d.intent) {
    case 'show_menu':
    case 'get_cart':
    case 'clear_cart':
    case 'remove_coupon':
    case 'review_order':
    case 'unknown':
      return { intent: d.intent };

    case 'add_item': {
      if (typeof d.item_name !== 'string' || d.item_name.trim() === '') return null;
      if (!Number.isInteger(d.quantity) || (d.quantity as number) < 1) return null;
      return { intent: 'add_item', item_name: d.item_name, quantity: d.quantity as number };
    }

    case 'add_item_batch': {
      if (!Array.isArray(d.items) || d.items.length === 0) return null;
      const items: Array<{ item_name: string; quantity: number }> = [];
      for (const itemBruto of d.items) {
        if (typeof itemBruto !== 'object' || itemBruto === null) return null;
        const item = itemBruto as Record<string, unknown>;
        if (typeof item.item_name !== 'string' || item.item_name.trim() === '') return null;
        if (!Number.isInteger(item.quantity) || (item.quantity as number) < 1) return null;
        items.push({ item_name: item.item_name, quantity: item.quantity as number });
      }
      return { intent: 'add_item_batch', items };
    }

    case 'remove_item': {
      if (!Number.isInteger(d.cart_index) || (d.cart_index as number) < 1) return null;
      return { intent: 'remove_item', cart_index: d.cart_index as number };
    }

    case 'set_fulfilment_type': {
      if (d.fulfilment_type !== 'collection' && d.fulfilment_type !== 'delivery') return null;
      return { intent: 'set_fulfilment_type', fulfilment_type: d.fulfilment_type };
    }

    case 'set_address': {
      if (typeof d.eircode !== 'string' || d.eircode.trim() === '') return null;
      if (typeof d.address_line_1 !== 'string' || d.address_line_1.trim() === '') return null;
      return {
        intent: 'set_address',
        eircode: d.eircode,
        address_line_1: d.address_line_1,
        address_line_2: typeof d.address_line_2 === 'string' ? d.address_line_2 : null,
        area: typeof d.area === 'string' ? d.area : null,
      };
    }

    case 'set_delivery_instructions':
      return {
        intent: 'set_delivery_instructions',
        instructions: typeof d.instructions === 'string' ? d.instructions : null,
      };

    case 'set_payment_method': {
      if (
        d.payment_method !== 'card' &&
        d.payment_method !== 'cash' &&
        d.payment_method !== 'revolut' &&
        d.payment_method !== 'bank_transfer'
      ) {
        return null;
      }
      return { intent: 'set_payment_method', payment_method: d.payment_method };
    }

    case 'set_cash_change': {
      if (typeof d.needs_change !== 'boolean') return null;
      return {
        intent: 'set_cash_change',
        needs_change: d.needs_change,
        cash_amount: typeof d.cash_amount === 'number' ? d.cash_amount : null,
      };
    }

    case 'apply_coupon': {
      if (typeof d.coupon_code !== 'string' || d.coupon_code.trim() === '') return null;
      return { intent: 'apply_coupon', coupon_code: d.coupon_code };
    }

    default:
      // Inclui confirm_review/confirm_order/request_human_handoff/
      // cancel_conversation/show_help/qualquer string desconhecida —
      // nunca produzidos a partir da IA, mesmo que a resposta bruta
      // (por bug/manipulação) contenha um desses valores.
      return null;
  }
}

export function validarEnvelopeAcoesIa(bruto: unknown): WhatsAppIntent[] | null {
  if (typeof bruto !== 'object' || bruto === null) return null;
  const d = bruto as Record<string, unknown>;
  if (!Array.isArray(d.actions) || d.actions.length === 0 || d.actions.length > 5) return null;

  const acoes: WhatsAppIntent[] = [];
  for (const acaoBruta of d.actions) {
    const acaoValidada = validarWhatsAppIntentDaIa(acaoBruta);
    if (!acaoValidada) return null; // uma ação inválida invalida o envelope inteiro
    acoes.push(acaoValidada);
  }
  return acoes;
}

async function chamarOpenAiWhatsapp(
  env: WhatsAppAiServiceEnv,
  mensagens: Array<{ role: 'system' | 'user'; content: string }>
): Promise<unknown | null> {
  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) return null;

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), 8000);

  let upstream: Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        messages: mensagens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'whatsapp_actions', strict: true, schema: ESQUEMA_INTENTS },
        },
      }),
      signal: controlador.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!upstream.ok) {
    // Corpo de erro sempre drenado, nunca lido/repassado — nenhum
    // detalhe interno da OpenAI chega ao chamador.
    await upstream.text().catch(() => undefined);
    return null;
  }

  let corpo: unknown;
  try {
    corpo = await upstream.json();
  } catch {
    return null;
  }

  const conteudo = (corpo as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof conteudo !== 'string') return null;

  try {
    return JSON.parse(conteudo);
  } catch {
    return null;
  }
}

export async function interpretWhatsAppMessageWithAI(
  input: WhatsAppAiInput,
  env: WhatsAppAiServiceEnv
): Promise<WhatsAppIntent[] | null> {
  if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) return null;

  const [resultadoMenu, resultadoCart] = await Promise.all([
    chamarRpcWhatsapp(env, 'get_whatsapp_menu', {}),
    chamarRpcWhatsapp(env, 'apply_whatsapp_cart_intent', {
      p_session_id: input.sessionId,
      p_intent: 'get_cart',
      p_payload: {},
    }),
  ]);

  const menu = resultadoMenu.ok && Array.isArray(resultadoMenu.dados) ? (resultadoMenu.dados as Record<string, unknown>[]) : [];

  // Só campos já públicos de get_whatsapp_menu — nunca product_costs/
  // fornecedor/stock_mode/product_id.
  const menuParaIa = menu.map((p) => ({
    name: p.name,
    category: p.category,
    price: p.price,
    is_available: p.is_available,
  }));

  const cartBruto =
    resultadoCart.ok && typeof resultadoCart.dados === 'object' && resultadoCart.dados !== null
      ? (resultadoCart.dados as Record<string, unknown>).cart
      : [];

  // cart_index 1-based + nome — nunca product_id.
  const cartParaIa = (Array.isArray(cartBruto) ? cartBruto : []).map((itemBruto, indice) => {
    const item = itemBruto as Record<string, unknown>;
    const produto = menu.find((p) => p.product_id === item.product_id);
    return {
      cart_index: indice + 1,
      name: typeof produto?.name === 'string' ? produto.name : null,
      quantity: item.quantity,
    };
  });

  const contexto = {
    message: input.message,
    language: input.language,
    state: input.state,
    menu: menuParaIa,
    cart: cartParaIa,
    allowed_intents: INTENTS_PERMITIDAS_IA,
  };

  const bruto = await chamarOpenAiWhatsapp(env, [
    { role: 'system', content: PROMPT_SISTEMA },
    { role: 'user', content: JSON.stringify(contexto) },
  ]);

  if (bruto === null) return null;
  return validarEnvelopeAcoesIa(bruto);
}
