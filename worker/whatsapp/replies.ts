// Camada de respostas determinísticas do WhatsApp (W6.6) — transforma
// WhatsAppDispatchResult + language em texto pronto pra envio. SEM
// integração com a Meta Send API ainda (isso é W6.8) — este módulo só
// produz string | null, não envia nada.
//
// Princípio central: NENHUMA função aqui calcula price/subtotal/
// discount/delivery_fee/total/distance/order_number — só FORMATA
// valores já presentes em result.data (que por sua vez já vieram
// prontos de uma RPC). formatarEuro só chama toFixed(2) sobre um
// número já recebido — nunca soma/multiplica. O carrinho (enriquecido
// pelo dispatcher, ver dispatcher.ts/enriquecerCarrinhoComMenu) e os
// itens do review mostram só o preço UNITÁRIO já pronto; o
// line_total de order_review pode ser exibido porque já foi
// calculado no banco (build_whatsapp_order_preview), nunca no Worker.
//
// language fora de 'pt'|'en' cai em 'pt' — fallback seguro, nunca
// detectado a partir do texto da mensagem (isso seria responsabilidade
// de uma camada de detecção separada, fora de escopo aqui).
//
// Nenhuma função aqui mostra product_id/order_id (UUID) — order_created
// usa só order_number; cart/menu nunca interpolam product_id no texto.

import type { WhatsAppDispatchResult } from './dispatcher';
import type { WhatsAppLanguage } from './types';

function formatarEuro(valor: unknown): string | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  return `€${valor.toFixed(2)}`;
}

const CATEGORIAS_ORDEM = ['combos', 'skewers', 'sides', 'drinks', 'other'] as const;

const ROTULOS_CATEGORIA: Record<(typeof CATEGORIAS_ORDEM)[number], { pt: string; en: string }> = {
  combos: { pt: 'Combos', en: 'Combos' },
  skewers: { pt: 'Espetinhos', en: 'Skewers' },
  sides: { pt: 'Acompanhamentos', en: 'Sides' },
  drinks: { pt: 'Bebidas', en: 'Drinks' },
  other: { pt: 'Outros', en: 'Other' },
};

const ROTULOS_PAGAMENTO: Record<string, { pt: string; en: string }> = {
  card: { pt: 'cartão', en: 'card' },
  cash: { pt: 'dinheiro', en: 'cash' },
  revolut: { pt: 'Revolut', en: 'Revolut' },
  bank_transfer: { pt: 'transferência bancária', en: 'bank transfer' },
};

const ROTULOS_FALTANDO: Record<string, { pt: string; en: string }> = {
  cart_empty: { pt: 'carrinho vazio', en: 'empty cart' },
  fulfilment_type: { pt: 'forma de recebimento', en: 'fulfilment type' },
  address: { pt: 'endereço', en: 'address' },
  delivery_quote: { pt: 'cotação de entrega', en: 'delivery quote' },
  delivery_quote_expired: { pt: 'cotação de entrega expirada', en: 'expired delivery quote' },
  payment_method: { pt: 'forma de pagamento', en: 'payment method' },
  cash_amount: { pt: 'valor para troco', en: 'cash amount for change' },
};

function comoRegistro(valor: unknown): Record<string, unknown> {
  return typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : {};
}

function formatarListaFaltando(missing: unknown, lang: WhatsAppLanguage): string {
  const lista = Array.isArray(missing) ? missing : [];
  const rotulos = lista
    .filter((codigo): codigo is string => typeof codigo === 'string')
    .map((codigo) => ROTULOS_FALTANDO[codigo]?.[lang] ?? codigo);
  return rotulos.join(', ');
}

// ---------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------
function formatarMenu(data: unknown, lang: WhatsAppLanguage): string {
  if (!Array.isArray(data) || data.length === 0) {
    return lang === 'en' ? 'The menu is empty right now.' : 'O cardápio está vazio no momento.';
  }

  const linhas: string[] = [];

  for (const categoria of CATEGORIAS_ORDEM) {
    const itens = data.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).category === categoria
    );
    if (itens.length === 0) continue;

    linhas.push(`*${ROTULOS_CATEGORIA[categoria][lang]}*`);

    for (const item of itens) {
      const nome = typeof item.name === 'string' ? item.name : null;
      if (!nome) continue;

      const preco = formatarEuro(item.price);
      const disponivel = item.is_available !== false;
      const isCombo = item.category === 'combos';

      let linha = `- ${nome}`;
      if (preco) linha += ` — ${preco}`;
      if (!disponivel) linha += lang === 'en' ? ' (unavailable)' : ' (indisponível)';
      if (isCombo) {
        linha += lang === 'en' ? ' (ask for help to build this combo)' : ' (peça ajuda para montar este combo)';
      }
      linhas.push(linha);
    }
  }

  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// cart (já enriquecido pelo dispatcher com name/price/is_available)
// ---------------------------------------------------------------------
function formatarCarrinho(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const cart = Array.isArray(d.cart) ? d.cart : [];

  if (cart.length === 0) {
    return lang === 'en' ? 'Your cart is empty.' : 'Seu carrinho está vazio.';
  }

  const linhas = cart.map((itemBruto) => {
    const item = comoRegistro(itemBruto);
    const quantidade = typeof item.quantity === 'number' ? item.quantity : '?';
    const nome =
      typeof item.name === 'string'
        ? item.name
        : lang === 'en'
          ? 'Item no longer on the menu'
          : 'Item indisponível no cardápio atual';
    const preco = formatarEuro(item.price);

    let linha = `- ${quantidade}x ${nome}`;
    if (preco) linha += lang === 'en' ? ` (${preco} each)` : ` (${preco} cada)`;
    return linha;
  });

  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// item_added / item_removed / cart_cleared (W6.7)
// ---------------------------------------------------------------------
function formatarItemAdicionado(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const nome = typeof d.added_name === 'string' ? d.added_name : null;
  const intro = nome
    ? lang === 'en'
      ? `${nome} added to your cart.`
      : `${nome} adicionado ao carrinho.`
    : lang === 'en'
      ? 'Item added to your cart.'
      : 'Item adicionado ao carrinho.';

  return `${intro}\n${formatarCarrinho(data, lang)}`;
}

function formatarItemRemovido(data: unknown, lang: WhatsAppLanguage): string {
  const intro = lang === 'en' ? 'Item removed.' : 'Item removido.';
  return `${intro}\n${formatarCarrinho(data, lang)}`;
}

// items_added_batch e partial_batch compartilham o mesmo formatador —
// "failed" simplesmente vem vazio no caso de sucesso total. Nunca
// esconde falhas (W6.1/W6.7, seção 11).
function formatarLoteAdicionado(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const added = Array.isArray(d.added) ? d.added : [];
  const failed = Array.isArray(d.failed) ? d.failed : [];

  const linhas: string[] = [];

  if (added.length > 0) {
    linhas.push(lang === 'en' ? 'Added:' : 'Adicionado:');
    for (const itemBruto of added) {
      const item = comoRegistro(itemBruto);
      const nome = typeof item.item_name === 'string' ? item.item_name : lang === 'en' ? 'Item' : 'Item';
      const quantidade = typeof item.quantity === 'number' ? item.quantity : '?';
      linhas.push(`- ${quantidade}x ${nome}`);
    }
  }

  if (failed.length > 0) {
    linhas.push(lang === 'en' ? "Couldn't add:" : 'Não consegui adicionar:');
    for (const itemBruto of failed) {
      const item = comoRegistro(itemBruto);
      const nome = typeof item.item_name === 'string' ? item.item_name : lang === 'en' ? 'item' : 'item';
      linhas.push(`- ${nome}`);
    }
  }

  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// delivery_quote
// ---------------------------------------------------------------------
function formatarCotacaoEntrega(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const distancia = typeof d.distance_km === 'number' ? d.distance_km : null;
  const taxa = formatarEuro(d.delivery_fee);

  const partes: string[] = [];
  if (taxa) partes.push(lang === 'en' ? `Delivery fee: ${taxa}` : `Taxa de entrega: ${taxa}`);
  if (distancia !== null) partes.push(lang === 'en' ? `Distance: ${distancia} km` : `Distância: ${distancia} km`);

  if (partes.length === 0) {
    return lang === 'en' ? 'Delivery quote calculated.' : 'Cotação de entrega calculada.';
  }
  return partes.join('\n');
}

// ---------------------------------------------------------------------
// delivery_instructions — nunca ecoa o conteúdo, só confirma salvo/removido
// ---------------------------------------------------------------------
function formatarInstrucoesEntrega(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const instructions = typeof d.delivery_instructions === 'string' ? d.delivery_instructions.trim() : '';

  if (instructions) {
    return lang === 'en' ? 'Delivery instructions saved.' : 'Instruções de entrega salvas.';
  }
  return lang === 'en' ? 'Delivery instructions removed.' : 'Instruções de entrega removidas.';
}

// ---------------------------------------------------------------------
// payment_method / cash_change
// ---------------------------------------------------------------------
function formatarFormaPagamento(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const metodo = typeof d.payment_method === 'string' ? d.payment_method : null;
  const rotulo = metodo && ROTULOS_PAGAMENTO[metodo] ? ROTULOS_PAGAMENTO[metodo][lang] : null;

  if (!rotulo) {
    return lang === 'en' ? 'Payment method updated.' : 'Forma de pagamento atualizada.';
  }
  return lang === 'en' ? `Payment method set to ${rotulo}.` : `Forma de pagamento definida como ${rotulo}.`;
}

function formatarTroco(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const precisaTroco = d.needs_change === true;

  if (!precisaTroco) {
    return lang === 'en' ? 'Got it, no change needed.' : 'Combinado, sem necessidade de troco.';
  }

  const valor = formatarEuro(d.cash_amount);
  if (valor) {
    return lang === 'en' ? `Got it, change for ${valor}.` : `Combinado, troco para ${valor}.`;
  }
  return lang === 'en' ? 'Got it, change requested.' : 'Combinado, troco solicitado.';
}

// ---------------------------------------------------------------------
// coupon
// ---------------------------------------------------------------------
function formatarCupomAplicado(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const codigo = typeof d.coupon_code === 'string' ? d.coupon_code : null;
  const desconto = formatarEuro(d.discount_amount);

  const partes: string[] = [
    lang === 'en' ? `Coupon${codigo ? ` ${codigo}` : ''} applied.` : `Cupom${codigo ? ` ${codigo}` : ''} aplicado.`,
  ];
  if (desconto) partes.push(lang === 'en' ? `Discount: ${desconto}` : `Desconto: ${desconto}`);

  return partes.join(' ');
}

// ---------------------------------------------------------------------
// order_review / awaiting_confirmation — ambos podem vir com
// ready:false (sessão ainda incompleta); tratado ANTES do preview.
// ---------------------------------------------------------------------
function formatarRevisaoPedido(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);

  if (d.ready === false) {
    const faltando = formatarListaFaltando(d.missing, lang);
    return lang === 'en'
      ? `We still need: ${faltando || 'a few more details'}.`
      : `Ainda falta: ${faltando || 'alguns dados'}.`;
  }

  const itens = Array.isArray(d.items) ? d.items : [];
  const linhasItens = itens.map((itemBruto) => {
    const item = comoRegistro(itemBruto);
    const nome = typeof item.name === 'string' ? item.name : 'Item';
    const quantidade = typeof item.quantity === 'number' ? item.quantity : '?';
    const precoUnitario = formatarEuro(item.unit_price);
    const totalLinha = formatarEuro(item.line_total);

    let linha = `${quantidade}x ${nome}`;
    if (precoUnitario) linha += lang === 'en' ? ` (${precoUnitario} each)` : ` (${precoUnitario} cada)`;
    if (totalLinha) linha += ` — ${totalLinha}`;
    return linha;
  });

  const subtotal = formatarEuro(d.subtotal);
  const desconto = formatarEuro(d.discount_amount);
  const taxaEntrega = formatarEuro(d.delivery_fee);
  const total = formatarEuro(d.total);

  const fulfilment =
    d.fulfilment_type === 'delivery'
      ? lang === 'en'
        ? 'Delivery'
        : 'Entrega'
      : d.fulfilment_type === 'collection'
        ? lang === 'en'
          ? 'Collection'
          : 'Retirada'
        : null;

  const metodoPagamento =
    typeof d.payment_method === 'string' && ROTULOS_PAGAMENTO[d.payment_method]
      ? ROTULOS_PAGAMENTO[d.payment_method][lang]
      : null;

  const cupom = typeof d.coupon_code === 'string' ? d.coupon_code : null;

  const resumo: string[] = [...linhasItens];

  if (subtotal) resumo.push(lang === 'en' ? `Subtotal: ${subtotal}` : `Subtotal: ${subtotal}`);
  if (desconto) resumo.push(lang === 'en' ? `Discount: ${desconto}` : `Desconto: ${desconto}`);
  if (taxaEntrega) resumo.push(lang === 'en' ? `Delivery fee: ${taxaEntrega}` : `Taxa de entrega: ${taxaEntrega}`);
  if (total) resumo.push(lang === 'en' ? `Total: ${total}` : `Total: ${total}`);
  if (fulfilment) resumo.push(lang === 'en' ? `Fulfilment: ${fulfilment}` : `Recebimento: ${fulfilment}`);

  if (d.fulfilment_type === 'delivery') {
    const linhasEndereco = [d.address_line_1, d.address_line_2, d.area, d.eircode]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .join(', ');
    if (linhasEndereco) resumo.push(lang === 'en' ? `Address: ${linhasEndereco}` : `Endereço: ${linhasEndereco}`);
  }

  if (metodoPagamento) resumo.push(lang === 'en' ? `Payment: ${metodoPagamento}` : `Pagamento: ${metodoPagamento}`);
  if (cupom) resumo.push(lang === 'en' ? `Coupon: ${cupom}` : `Cupom: ${cupom}`);

  resumo.push('');
  resumo.push(
    lang === 'en'
      ? 'Please review the order above. If everything is correct, send: confirm'
      : 'Confira os dados acima. Se estiver tudo certo, envie: confirmar'
  );

  return resumo.join('\n');
}

function formatarConfirmacaoRevisao(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);

  if (d.ready === false) {
    const faltando = formatarListaFaltando(d.missing, lang);
    return lang === 'en'
      ? `We still need: ${faltando || 'a few more details'}.`
      : `Ainda falta: ${faltando || 'alguns dados'}.`;
  }

  // Nunca sugere "ok"/"sim" — só a expressão inequívoca aceita pelo
  // parser (W6.5, seção 11).
  return lang === 'en'
    ? 'Review confirmed. To place the order now, send again: confirm'
    : 'Revisão confirmada. Para criar o pedido agora, envie novamente: confirmar';
}

// ---------------------------------------------------------------------
// order_created — só order_number/duplicate; nunca order_id (UUID)
// ---------------------------------------------------------------------
function formatarPedidoCriado(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const numero = typeof d.order_number === 'number' || typeof d.order_number === 'string' ? d.order_number : null;
  const duplicado = d.duplicate === true;

  if (numero === null) {
    return lang === 'en' ? 'Your order has been placed.' : 'Seu pedido foi criado.';
  }
  if (duplicado) {
    return lang === 'en' ? `Your order #${numero} is already confirmed.` : `Seu pedido #${numero} já está confirmado.`;
  }
  return lang === 'en' ? `Order #${numero} placed successfully.` : `Pedido #${numero} criado com sucesso.`;
}

// ---------------------------------------------------------------------
// help — só lista os comandos já reduzidos em dispatcher.ts/COMANDOS_AJUDA
// ---------------------------------------------------------------------
function formatarAjuda(data: unknown, lang: WhatsAppLanguage): string {
  const d = comoRegistro(data);
  const comandos = Array.isArray(d.commands) ? d.commands : [];

  const linhas = comandos
    .map((comandoBruto) => {
      const comando = comoRegistro(comandoBruto);
      const exemplos = Array.isArray(comando.examples)
        ? comando.examples.filter((e): e is string => typeof e === 'string')
        : [];
      return exemplos.length > 0 ? `- ${exemplos.join(' / ')}` : null;
    })
    .filter((linha): linha is string => linha !== null);

  const intro = lang === 'en' ? 'Available commands:' : 'Comandos disponíveis:';
  return [intro, ...linhas].join('\n');
}

// ---------------------------------------------------------------------
// Motivos de falha de resolução de produto (W6.7) — todos usam
// data.item_name (e data.candidates, quando ambíguo); nunca inventam
// nome, nunca mostram product_id.
// ---------------------------------------------------------------------
function formatarMotivoProduto(
  reason: 'product_not_found' | 'product_ambiguous' | 'product_unavailable' | 'combo_not_supported',
  data: unknown,
  lang: WhatsAppLanguage
): string {
  const d = comoRegistro(data);
  const itemName = typeof d.item_name === 'string' ? d.item_name : null;

  switch (reason) {
    case 'product_not_found':
      return itemName
        ? lang === 'en'
          ? `I couldn't find "${itemName}" on the menu.`
          : `Não encontrei "${itemName}" no cardápio.`
        : lang === 'en'
          ? "I couldn't find that item on the menu."
          : 'Não encontrei esse item no cardápio.';

    case 'product_ambiguous': {
      const candidatos = Array.isArray(d.candidates) ? d.candidates.filter((c): c is string => typeof c === 'string') : [];
      const lista = candidatos.join(', ');
      return lang === 'en'
        ? `I found more than one match${itemName ? ` for "${itemName}"` : ''}${lista ? `: ${lista}` : ''}. Which one did you mean?`
        : `Encontrei mais de uma opção${itemName ? ` para "${itemName}"` : ''}${lista ? `: ${lista}` : ''}. Qual você quer?`;
    }

    case 'product_unavailable':
      return itemName
        ? lang === 'en'
          ? `${itemName} is unavailable right now.`
          : `${itemName} está indisponível no momento.`
        : lang === 'en'
          ? 'That item is unavailable right now.'
          : 'Esse item está indisponível no momento.';

    case 'combo_not_supported':
      return lang === 'en'
        ? 'Combos still need skewer/side choices — please ask for help to build this one for now.'
        : 'Os combos ainda precisam das escolhas dos espetos/acompanhamentos — por enquanto peça ajuda para montar este combo.';
  }
}

// ---------------------------------------------------------------------
// Textos fixos (sem dados) — nunca expõem Postgres/PostgREST/stack/
// endpoint/nome de RPC.
// ---------------------------------------------------------------------
const TEXTOS: Record<string, { pt: string; en: string }> = {
  unknown: {
    pt: "Não consegui entender esse pedido ainda. Você pode enviar 'menu', 'carrinho', 'entrega', 'retirada' ou 'ajuda'.",
    en: "I couldn't understand that yet. You can send 'menu', 'cart', 'delivery', 'collection' or 'help'.",
  },
  notImplemented: {
    pt: 'Ainda não consigo fazer isso por aqui.',
    en: "I can't do that here yet.",
  },
  rpcError: {
    pt: 'Não consegui concluir essa etapa agora. Tente novamente em instantes.',
    en: 'I could not complete that step right now. Please try again shortly.',
  },
  aiUnavailable: {
    pt: "Não consegui entender sua mensagem agora. Tente novamente ou use um comando como 'menu' ou 'ajuda'.",
    en: "I couldn't process your message right now. Please try again or use a command like 'menu' or 'help'.",
  },
  fulfilmentCollection: {
    pt: 'Perfeito, você escolheu retirada.',
    en: 'Great, you chose collection.',
  },
  fulfilmentDelivery: {
    pt: 'Perfeito, você escolheu entrega. Agora me envie seu endereço e Eircode.',
    en: 'Great, you chose delivery. Please send me your address and Eircode.',
  },
  couponRemoved: {
    pt: 'Cupom removido.',
    en: 'Coupon removed.',
  },
  cartCleared: {
    pt: 'Carrinho esvaziado.',
    en: 'Cart cleared.',
  },
};

// ---------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------
export function buildWhatsAppReply(result: WhatsAppDispatchResult, language: WhatsAppLanguage): string | null {
  // Fallback seguro: qualquer valor que não seja exatamente 'en' vira
  // 'pt'. Nunca detectado a partir do texto da mensagem aqui.
  const lang: WhatsAppLanguage = language === 'en' ? 'en' : 'pt';

  if (!result.handled) {
    switch (result.reason) {
      case 'unknown':
        return TEXTOS.unknown[lang];
      case 'not_implemented':
        return TEXTOS.notImplemented[lang];
      case 'ai_unavailable':
        return TEXTOS.aiUnavailable[lang];
      case 'product_not_found':
      case 'product_ambiguous':
      case 'product_unavailable':
      case 'combo_not_supported':
        return formatarMotivoProduto(result.reason, result.data, lang);
      case 'rpc_error':
      default:
        return TEXTOS.rpcError[lang];
    }
  }

  switch (result.reply_key) {
    case 'menu':
      return formatarMenu(result.data, lang);
    case 'cart':
      return formatarCarrinho(result.data, lang);
    case 'item_added':
      return formatarItemAdicionado(result.data, lang);
    case 'items_added_batch':
    case 'partial_batch':
      return formatarLoteAdicionado(result.data, lang);
    case 'item_removed':
      return formatarItemRemovido(result.data, lang);
    case 'cart_cleared':
      return TEXTOS.cartCleared[lang];
    case 'fulfilment_collection':
      return TEXTOS.fulfilmentCollection[lang];
    case 'fulfilment_delivery':
      return TEXTOS.fulfilmentDelivery[lang];
    case 'delivery_quote':
      return formatarCotacaoEntrega(result.data, lang);
    case 'delivery_instructions':
      return formatarInstrucoesEntrega(result.data, lang);
    case 'payment_method':
      return formatarFormaPagamento(result.data, lang);
    case 'cash_change':
      return formatarTroco(result.data, lang);
    case 'coupon_applied':
      return formatarCupomAplicado(result.data, lang);
    case 'coupon_removed':
      return TEXTOS.couponRemoved[lang];
    case 'order_review':
      return formatarRevisaoPedido(result.data, lang);
    case 'awaiting_confirmation':
      return formatarConfirmacaoRevisao(result.data, lang);
    case 'order_created':
      return formatarPedidoCriado(result.data, lang);
    case 'help':
      return formatarAjuda(result.data, lang);
    default:
      // reply_key desconhecido/ausente — nada seguro a dizer, melhor
      // não responder do que inventar um texto genérico incorreto.
      return null;
  }
}
