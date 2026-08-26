// Tipos do motor conversacional do WhatsApp (W6.2). Só os tipos
// necessários pro parser determinístico desta etapa — a união de
// intents cobre exatamente o que o parser consegue produzir hoje;
// intents futuras (add_item, apply_coupon, etc., desenhadas no W6.1)
// pertencem ao contrato mais amplo da IA (W6.7), não redefinidas aqui
// pra evitar dois contratos divergentes mantidos à mão.
//
// request_human_handoff/cancel_conversation já aparecem na união
// (o parser PODE reconhecer essas palavras) mas nenhuma RPC ainda as
// executa — dispatcher (W6.9) precisa existir antes de agir sobre
// elas. Nenhum campo livre (rpc/sql/action_name) em nenhuma variante.

export type WhatsAppSessionState =
  | 'greeting'
  | 'browsing_menu'
  | 'building_cart'
  | 'collecting_fulfilment'
  | 'collecting_address'
  | 'collecting_payment'
  | 'reviewing_order'
  | 'awaiting_confirmation'
  | 'order_created'
  | 'closed';

export type WhatsAppLanguage = 'pt' | 'en';

export type WhatsAppIntent =
  | { intent: 'show_menu' }
  | { intent: 'get_cart' }
  // W6.7: primeira implementação real (RPC apply_whatsapp_cart_intent
  // já suportava desde o W4.2, nunca ligada ao dispatcher até agora).
  | { intent: 'add_item'; item_name: string; quantity: number }
  | { intent: 'add_item_batch'; items: Array<{ item_name: string; quantity: number }> }
  // Só cart_index (nunca nome) — decisão deliberada (W6.7, seção 12):
  // resolver remoção por nome é ambíguo/arriscado; sem posição
  // numérica clara, a IA deve retornar unknown.
  | { intent: 'remove_item'; cart_index: number }
  | { intent: 'clear_cart' }
  | { intent: 'set_fulfilment_type'; fulfilment_type: 'collection' | 'delivery' }
  // W6.4: sem suporte no parser determinístico ainda (endereço livre
  // não é extraído deterministicamente) — existe na união pra IA
  // futura (structured output, W6.7) já ter o contrato pronto.
  | { intent: 'set_address'; eircode: string; address_line_1: string; address_line_2?: string | null; area?: string | null }
  // W6.4: mesma situação de set_address — sem parser determinístico ainda.
  | { intent: 'set_delivery_instructions'; instructions: string | null }
  // W6.5: sem parser determinístico ainda ("cartão"/"dinheiro"/"troco
  // para 20" continuam unknown) — contrato pronto pra IA futura (W6.7).
  | { intent: 'set_payment_method'; payment_method: 'card' | 'cash' | 'revolut' | 'bank_transfer' }
  | { intent: 'set_cash_change'; needs_change: boolean; cash_amount?: number | null }
  | { intent: 'apply_coupon'; coupon_code: string }
  | { intent: 'remove_coupon' }
  | { intent: 'review_order' }
  | { intent: 'confirm_review' }
  | { intent: 'confirm_order' }
  | { intent: 'show_help' }
  // RPC ainda não existe (W6.9) — parser pode produzir, dispatcher não pode executar ainda.
  | { intent: 'request_human_handoff' }
  // RPC ainda não existe (W6.9) — parser pode produzir, dispatcher não pode executar ainda.
  | { intent: 'cancel_conversation' }
  | { intent: 'unknown' };
