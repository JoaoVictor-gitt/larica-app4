// Casos de teste estáticos da camada de respostas (W6.6). Módulo
// autocontido, sem dependência externa (mesmo padrão de
// parser.test.ts) — runRepliesTests() pode ser chamada manualmente
// por uma etapa futura quando um runner for escolhido; não está
// plugada a nenhum CI/build.

import { buildWhatsAppReply } from './replies';
import type { WhatsAppDispatchResult } from './dispatcher';

interface CasoTesteReply {
  descricao: string;
  result: WhatsAppDispatchResult;
  language: 'pt' | 'en';
  // Verificação por igualdade exata quando o texto é fixo/previsível.
  esperadoExato?: string;
  // Verificação por substring quando o texto é composto (review, menu).
  deveConter?: string[];
  naoDeveConter?: string[];
}

const CASOS: CasoTesteReply[] = [
  // A) menu PT
  {
    descricao: 'A) menu PT',
    language: 'pt',
    result: {
      handled: true,
      intent: 'show_menu',
      reply_key: 'menu',
      data: [{ product_id: 'x', name: 'Frango', category: 'skewers', price: 5, is_available: true }],
    },
    deveConter: ['Espetinhos', 'Frango — €5.00'],
  },
  // B) menu EN
  {
    descricao: 'B) menu EN',
    language: 'en',
    result: {
      handled: true,
      intent: 'show_menu',
      reply_key: 'menu',
      data: [{ product_id: 'x', name: 'Frango', category: 'skewers', price: 5, is_available: true }],
    },
    deveConter: ['Skewers', 'Frango — €5.00'],
  },
  // C) item indisponível
  {
    descricao: 'C) item indisponível',
    language: 'pt',
    result: {
      handled: true,
      intent: 'show_menu',
      reply_key: 'menu',
      data: [{ product_id: 'x', name: 'Coca', category: 'drinks', price: 2, is_available: false }],
    },
    deveConter: ['(indisponível)'],
  },
  // D) cart
  {
    descricao: 'D) cart',
    language: 'pt',
    result: {
      handled: true,
      intent: 'get_cart',
      reply_key: 'cart',
      data: { cart: [{ product_id: 'x', quantity: 2, name: 'Frango', price: 5, is_available: true }] },
    },
    deveConter: ['2x Frango (€5.00 cada)'],
    // V) nenhum cálculo financeiro: NUNCA deve aparecer o total (2*5=€10.00)
    naoDeveConter: ['€10.00'],
  },
  // E) collection
  {
    descricao: 'E) collection',
    language: 'pt',
    result: { handled: true, intent: 'set_fulfilment_type', reply_key: 'fulfilment_collection', data: {} },
    esperadoExato: 'Perfeito, você escolheu retirada.',
  },
  // F) delivery
  {
    descricao: 'F) delivery',
    language: 'pt',
    result: { handled: true, intent: 'set_fulfilment_type', reply_key: 'fulfilment_delivery', data: {} },
    esperadoExato: 'Perfeito, você escolheu entrega. Agora me envie seu endereço e Eircode.',
  },
  // G) delivery_quote
  {
    descricao: 'G) delivery_quote',
    language: 'pt',
    result: {
      handled: true,
      intent: 'set_address',
      reply_key: 'delivery_quote',
      data: { distance_km: 4.2, delivery_fee: 3, duration_seconds: 600 },
    },
    deveConter: ['Taxa de entrega: €3.00', 'Distância: 4.2 km'],
  },
  // H) card
  {
    descricao: 'H) card',
    language: 'pt',
    result: {
      handled: true,
      intent: 'set_payment_method',
      reply_key: 'payment_method',
      data: { payment_method: 'card' },
    },
    esperadoExato: 'Forma de pagamento definida como cartão.',
  },
  // I) cash sem troco
  {
    descricao: 'I) cash sem troco',
    language: 'pt',
    result: {
      handled: true,
      intent: 'set_cash_change',
      reply_key: 'cash_change',
      data: { needs_change: false, cash_amount: null },
    },
    esperadoExato: 'Combinado, sem necessidade de troco.',
  },
  // J) cash com troco
  {
    descricao: 'J) cash com troco',
    language: 'pt',
    result: {
      handled: true,
      intent: 'set_cash_change',
      reply_key: 'cash_change',
      data: { needs_change: true, cash_amount: 20 },
    },
    esperadoExato: 'Combinado, troco para €20.00.',
  },
  // K) coupon
  {
    descricao: 'K) coupon',
    language: 'pt',
    result: {
      handled: true,
      intent: 'apply_coupon',
      reply_key: 'coupon_applied',
      data: { coupon_code: 'TESTE10', discount_amount: 0.5 },
    },
    deveConter: ['Cupom TESTE10 aplicado.', 'Desconto: €0.50'],
  },
  // L) review PT
  {
    descricao: 'L) review PT',
    language: 'pt',
    result: {
      handled: true,
      intent: 'review_order',
      reply_key: 'order_review',
      data: {
        items: [{ product_id: 'x', name: 'Frango', quantity: 1, unit_price: 5, line_total: 5 }],
        subtotal: 5,
        discount_amount: 0.5,
        delivery_fee: 3,
        total: 7.5,
        fulfilment_type: 'delivery',
        address_line_1: 'Rua X',
        eircode: 'D01ABC',
        payment_method: 'card',
        coupon_code: 'TESTE10',
      },
    },
    deveConter: ['1x Frango (€5.00 cada) — €5.00', 'Total: €7.50', 'envie: confirmar'],
  },
  // M) review EN
  {
    descricao: 'M) review EN',
    language: 'en',
    result: {
      handled: true,
      intent: 'review_order',
      reply_key: 'order_review',
      data: {
        items: [{ product_id: 'x', name: 'Frango', quantity: 1, unit_price: 5, line_total: 5 }],
        subtotal: 5,
        discount_amount: 0,
        delivery_fee: 0,
        total: 5,
        fulfilment_type: 'collection',
        payment_method: 'cash',
      },
    },
    deveConter: ['send: confirm'],
  },
  // N) awaiting_confirmation
  {
    descricao: 'N) awaiting_confirmation',
    language: 'pt',
    result: { handled: true, intent: 'confirm_review', reply_key: 'awaiting_confirmation', data: {} },
    esperadoExato: 'Revisão confirmada. Para criar o pedido agora, envie novamente: confirmar',
  },
  // O) order_created duplicate=false
  {
    descricao: 'O) order_created duplicate=false',
    language: 'pt',
    result: {
      handled: true,
      intent: 'confirm_order',
      reply_key: 'order_created',
      data: { duplicate: false, order_number: 29, order_id: 'uuid-nao-deve-aparecer' },
    },
    esperadoExato: 'Pedido #29 criado com sucesso.',
    naoDeveConter: ['uuid-nao-deve-aparecer'],
  },
  // P) order_created duplicate=true
  {
    descricao: 'P) order_created duplicate=true',
    language: 'pt',
    result: {
      handled: true,
      intent: 'confirm_order',
      reply_key: 'order_created',
      data: { duplicate: true, order_number: 29, order_id: 'uuid-nao-deve-aparecer' },
    },
    esperadoExato: 'Seu pedido #29 já está confirmado.',
    naoDeveConter: ['uuid-nao-deve-aparecer'],
  },
  // Q) help
  {
    descricao: 'Q) help',
    language: 'pt',
    result: {
      handled: true,
      intent: 'show_help',
      reply_key: 'help',
      data: { commands: [{ intent: 'show_menu', examples: ['menu', 'cardápio'] }] },
    },
    deveConter: ['Comandos disponíveis:', '- menu / cardápio'],
    naoDeveConter: ['atendente', 'cancelar'],
  },
  // R) unknown
  {
    descricao: 'R) unknown',
    language: 'pt',
    result: { handled: false, intent: 'unknown', reason: 'unknown' },
    deveConter: ["'menu'", "'ajuda'"],
  },
  // S) rpc_error
  {
    descricao: 'S) rpc_error',
    language: 'pt',
    result: { handled: false, intent: 'show_menu', reason: 'rpc_error' },
    esperadoExato: 'Não consegui concluir essa etapa agora. Tente novamente em instantes.',
    naoDeveConter: ['postgres', 'PostgREST', 'rpc/', 'stack'],
  },
];

function normalizarBusca(texto: string): string {
  return texto.toLowerCase();
}

export function runRepliesTests(): { total: number; falhas: string[] } {
  const falhas: string[] = [];

  for (const caso of CASOS) {
    const resultado = buildWhatsAppReply(caso.result, caso.language) ?? '';

    if (caso.esperadoExato !== undefined && resultado !== caso.esperadoExato) {
      falhas.push(`${caso.descricao}: esperado exato "${caso.esperadoExato}", obtido "${resultado}"`);
    }

    if (caso.deveConter) {
      for (const trecho of caso.deveConter) {
        if (!resultado.includes(trecho)) {
          falhas.push(`${caso.descricao}: esperava conter "${trecho}", obtido "${resultado}"`);
        }
      }
    }

    if (caso.naoDeveConter) {
      for (const trecho of caso.naoDeveConter) {
        if (normalizarBusca(resultado).includes(normalizarBusca(trecho))) {
          falhas.push(`${caso.descricao}: NÃO deveria conter "${trecho}", obtido "${resultado}"`);
        }
      }
    }
  }

  // T) valor monetário 7.5 → €7.50 (direto, sem passar por um reply_key)
  {
    const semAcesso = (fn: () => string | null) => fn();
    const resultadoCash = semAcesso(() =>
      buildWhatsAppReply(
        { handled: true, intent: 'set_cash_change', reply_key: 'cash_change', data: { needs_change: true, cash_amount: 7.5 } },
        'pt'
      )
    );
    if (resultadoCash !== 'Combinado, troco para €7.50.') {
      falhas.push(`T) 7.5 → €7.50: obtido "${resultadoCash}"`);
    }
  }

  // U) nenhum UUID mostrado — cart com item sem correspondência no menu
  // (name:null) nunca deve mostrar o product_id.
  {
    const resultadoCart = buildWhatsAppReply(
      {
        handled: true,
        intent: 'get_cart',
        reply_key: 'cart',
        data: { cart: [{ product_id: '11111111-uuid-nao-deve-aparecer', quantity: 1, name: null, price: null }] },
      },
      'pt'
    );
    if (!resultadoCart || resultadoCart.includes('11111111-uuid-nao-deve-aparecer')) {
      falhas.push(`U) UUID vazou no texto do carrinho: "${resultadoCart}"`);
    }
  }

  return { total: CASOS.length + 2, falhas };
}
