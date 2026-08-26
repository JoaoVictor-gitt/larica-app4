// Casos de teste estáticos da validação de saída da IA (W6.7). Mesmo
// padrão autocontido dos demais *.test.ts — runAiTests() disponível
// pra execução manual futura, não plugada a nenhum runner/CI.
//
// Não chama a API real da OpenAI (fora de escopo, sem rede/mocks
// disponíveis neste ambiente) — cobre só as partes puras/sem rede:
// validarWhatsAppIntentDaIa/validarEnvelopeAcoesIa e invariantes de
// segurança sobre o próprio ESQUEMA_INTENTS. Os casos que dependem de
// rede (JSON inválido da API, timeout, HTTP 500) são verificados por
// inspeção do código de chamarOpenAiWhatsapp (sempre retorna null
// nesses casos, nunca lança, nunca expõe corpo de erro) — documentado
// no relatório, não testável sem um mock de fetch.

import { ESQUEMA_INTENTS, validarEnvelopeAcoesIa, validarWhatsAppIntentDaIa } from './ai';

const falhas: string[] = [];

function verificar(condicao: boolean, mensagem: string): void {
  if (!condicao) falhas.push(mensagem);
}

export function runAiTests(): { total: number; falhas: string[] } {
  let total = 0;

  // --- validarWhatsAppIntentDaIa: casos válidos ---
  total++;
  verificar(
    JSON.stringify(validarWhatsAppIntentDaIa({ intent: 'add_item', item_name: 'Frango', quantity: 2 })) ===
      JSON.stringify({ intent: 'add_item', item_name: 'Frango', quantity: 2 }),
    'add_item válido deveria passar'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'add_item', item_name: 'Frango', quantity: 0 }) === null,
    'add_item com quantity=0 deveria ser rejeitado'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'add_item', item_name: 'Frango', quantity: 2.5 }) === null,
    'add_item com quantity fracionária deveria ser rejeitado'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'add_item_batch', items: [{ item_name: 'Frango', quantity: 2 }] }) !== null,
    'add_item_batch válido deveria passar'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'add_item_batch', items: [] }) === null,
    'add_item_batch com items vazio deveria ser rejeitado'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'remove_item', cart_index: 1 }) !== null,
    'remove_item com cart_index válido deveria passar'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'remove_item', cart_index: 0 }) === null,
    'remove_item com cart_index=0 deveria ser rejeitado'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'set_payment_method', payment_method: 'card' }) !== null,
    'set_payment_method com enum válido deveria passar'
  );

  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'set_payment_method', payment_method: 'bitcoin' }) === null,
    'set_payment_method com enum inválido deveria ser rejeitado'
  );

  // --- barreira estrutural: intents que a IA NUNCA pode produzir ---
  const intentsProibidas = ['confirm_review', 'confirm_order', 'request_human_handoff', 'cancel_conversation', 'show_help'];
  for (const intentProibida of intentsProibidas) {
    total++;
    verificar(
      validarWhatsAppIntentDaIa({ intent: intentProibida }) === null,
      `${intentProibida} NUNCA deveria ser aceita vinda da IA`
    );
  }

  // --- campo financeiro/administrativo injetado não deveria "vazar" ---
  total++;
  {
    const resultado = validarWhatsAppIntentDaIa({ intent: 'show_menu', price: 999, rpc: 'create_customer_order' });
    verificar(
      resultado !== null && !('price' in resultado) && !('rpc' in resultado),
      'campos extras (price/rpc) nunca deveriam sobreviver à validação'
    );
  }

  // --- W6.7A: casos de ataque adicionais (C, D, E, F, H, J, M) ---

  // C) product_id injetado em add_item — nunca deveria sobreviver.
  total++;
  {
    const resultado = validarWhatsAppIntentDaIa({
      intent: 'add_item',
      item_name: 'Frango',
      quantity: 1,
      product_id: '11111111-1111-1111-1111-111111111111',
    });
    verificar(
      resultado !== null && !('product_id' in resultado),
      'C) product_id injetado em add_item nunca deveria sobreviver'
    );
  }

  // D) total injetado em set_address — nunca deveria sobreviver.
  total++;
  {
    const resultado = validarWhatsAppIntentDaIa({
      intent: 'set_address',
      eircode: 'D01ABC',
      address_line_1: 'Rua X',
      address_line_2: null,
      area: null,
      total: 999,
    });
    verificar(resultado !== null && !('total' in resultado), 'D) total injetado em set_address nunca deveria sobreviver');
  }

  // E) delivery_fee injetado em set_address — nunca deveria sobreviver.
  total++;
  {
    const resultado = validarWhatsAppIntentDaIa({
      intent: 'set_address',
      eircode: 'D01ABC',
      address_line_1: 'Rua X',
      address_line_2: null,
      area: null,
      delivery_fee: 0,
    });
    verificar(
      resultado !== null && !('delivery_fee' in resultado),
      'E) delivery_fee injetado em set_address nunca deveria sobreviver'
    );
  }

  // F) rpc_name injetado em qualquer ação — nunca deveria sobreviver
  // nem ser usado como nome de RPC (chamarRpcWhatsapp só aceita
  // literais fixos do código-fonte, nunca um campo vindo da IA).
  total++;
  {
    const resultado = validarWhatsAppIntentDaIa({
      intent: 'show_menu',
      rpc_name: 'create_customer_order',
    });
    verificar(resultado !== null && !('rpc_name' in resultado), 'F) rpc_name injetado nunca deveria sobreviver');
  }

  // H) envelope com 6 ações (acima do maxItems=5) deveria ser rejeitado
  // pelo validador server-side, independente do schema da OpenAI.
  total++;
  verificar(
    validarEnvelopeAcoesIa({
      actions: [
        { intent: 'show_menu' },
        { intent: 'get_cart' },
        { intent: 'show_menu' },
        { intent: 'get_cart' },
        { intent: 'show_menu' },
        { intent: 'get_cart' },
      ],
    }) === null,
    'H) envelope com 6 ações deveria ser rejeitado (maxItems=5)'
  );

  // J) quantity negativa deveria ser rejeitada.
  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'add_item', item_name: 'Frango', quantity: -5 }) === null,
    'J) quantity negativa deveria ser rejeitada'
  );

  // M) fulfilment_type inválido deveria ser rejeitado.
  total++;
  verificar(
    validarWhatsAppIntentDaIa({ intent: 'set_fulfilment_type', fulfilment_type: 'teleport' }) === null,
    'M) fulfilment_type fora do enum deveria ser rejeitado'
  );

  // --- validarEnvelopeAcoesIa ---
  total++;
  verificar(
    validarEnvelopeAcoesIa({ actions: [{ intent: 'show_menu' }] }) !== null,
    'envelope com 1 ação válida deveria passar'
  );

  total++;
  verificar(validarEnvelopeAcoesIa({ actions: [] }) === null, 'envelope vazio deveria ser rejeitado');

  total++;
  verificar(
    validarEnvelopeAcoesIa({
      actions: [{ intent: 'set_payment_method', payment_method: 'cash' }, { intent: 'set_cash_change', needs_change: true, cash_amount: 20 }],
    }) !== null,
    'envelope com 2 ações válidas (cash + troco) deveria passar'
  );

  total++;
  verificar(
    validarEnvelopeAcoesIa({ actions: [{ intent: 'show_menu' }, { intent: 'confirm_order' }] }) === null,
    'envelope com QUALQUER ação inválida (confirm_order) invalida tudo — zero mutação parcial'
  );

  total++;
  verificar(validarEnvelopeAcoesIa('não é um objeto') === null, 'JSON que não é objeto deveria ser rejeitado');

  total++;
  verificar(validarEnvelopeAcoesIa(null) === null, 'null deveria ser rejeitado');

  // --- invariantes de segurança do próprio ESQUEMA_INTENTS ---
  const esquemaTexto = JSON.stringify(ESQUEMA_INTENTS);
  const camposProibidos = ['"price"', '"subtotal"', '"discount', '"delivery_fee"', '"distance"', '"total"', '"order_id"', '"order_number"', '"state"', '"rpc', '"sql'];
  for (const campo of camposProibidos) {
    total++;
    verificar(!esquemaTexto.includes(campo), `ESQUEMA_INTENTS não deveria conter o campo ${campo}`);
  }

  const intentsAusentesDoSchema = ['confirm_review', 'confirm_order', 'request_human_handoff', 'cancel_conversation', 'show_help'];
  for (const intentAusente of intentsAusentesDoSchema) {
    total++;
    verificar(
      !esquemaTexto.includes(`"${intentAusente}"`),
      `ESQUEMA_INTENTS não deveria mencionar a intent "${intentAusente}" em nenhuma variante`
    );
  }

  return { total, falhas };
}
