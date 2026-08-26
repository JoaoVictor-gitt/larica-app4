// Dispatcher determinístico do WhatsApp (W6.3/W6.4) — show_menu,
// get_cart, show_help (local, sem RPC), set_fulfilment_type,
// set_address (+ cálculo/persistência de cotação de entrega),
// set_delivery_instructions. Intents já reconhecíveis pelo parser/
// union mas ainda sem execução real (confirm_review, confirm_order,
// request_human_handoff, cancel_conversation) retornam
// handled:false/reason:'not_implemented' — nunca chamam uma RPC
// errada nem caem num fallback silencioso. unknown retorna
// handled:false/reason:'unknown' sem executar nenhuma RPC mutante —
// esse é o ponto onde a IA entrará futuramente (W6.7).
//
// Nenhuma resposta textual final é produzida aqui — só dados
// estruturados (WhatsAppDispatchResult.data). A camada PT/EN fica
// pro W6.6.
//
// chamarRpcWhatsapp: único ponto de saída pra RPCs do WhatsApp nesta
// etapa, com o nome da RPC restrito a um union literal fechado
// (NOMES_RPC_PERMITIDOS) — nunca aceita uma string vinda do
// usuário/IA; todo chamador passa um literal fixo no código-fonte,
// nunca intent.intent nem qualquer valor derivado de texto livre.
// Mesmo padrão de isolamento de erro já usado em
// chamarRpcMensagemWhatsapp (worker/index.ts): corpo de erro upstream
// nunca é lido/repassado, service_role nunca logado.
//
// WhatsAppServiceEnv é um subconjunto mínimo e local do Env real do
// Worker (só as 2 chaves necessárias pra chamar Supabase) — evita
// importar o Env inteiro de worker/index.ts (sem import circular,
// sem precisar exportar nada de lá); TypeScript aceita o Env real
// como argumento por tipagem estrutural.
//
// show_menu/get_cart NÃO alteram whatsapp_sessions — get_whatsapp_menu
// é STABLE/sem parâmetros, apply_whatsapp_cart_intent(get_cart) é
// somente leitura (a própria RPC não muda cart/state pra esse
// intent). Promover greeting→browsing_menu ao mostrar o menu foi
// avaliado e descartado nesta etapa: não existe nenhuma RPC seguindo
// o padrão do projeto que faça só essa transição, e fazer UPDATE
// direto em whatsapp_sessions a partir do Worker quebraria a regra
// "toda escrita passa por uma RPC SECURITY DEFINER" seguida em 100%
// do resto do motor — não implementado.
//
// calcularCotacaoEntregaWhatsapp (W6.4): movida de worker/index.ts
// pra cá — é lógica de dispatch, não infra genérica de webhook, e
// index.ts importar dispatchWhatsAppIntent enquanto este arquivo
// importasse uma função de lá criaria uma dependência circular de
// valores (diferente de um import type-only, que é seguro). A antiga
// chamarRpcSetWhatsappDeliveryQuote foi eliminada (não só movida):
// seu comportamento era idêntico ao chamarRpcWhatsapp genérico —
// 'set_whatsapp_delivery_quote' virou só mais uma entrada no union de
// RPCs permitidas.

import type { WhatsAppIntent, WhatsAppSessionState } from './types';

export interface WhatsAppServiceEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface WhatsAppDispatchContext {
  env: WhatsAppServiceEnv;
  sessionId: string;
  state: WhatsAppSessionState;
}

export interface WhatsAppDispatchResult {
  handled: boolean;
  intent: WhatsAppIntent['intent'];
  reply_key?: string;
  reason?:
    | 'unknown'
    | 'not_implemented'
    | 'rpc_error'
    | 'product_not_found'
    | 'product_ambiguous'
    | 'product_unavailable'
    | 'combo_not_supported'
    | 'ai_unavailable';
  data?: unknown;
}

type ResultadoRpcWhatsapp = { ok: true; dados: unknown } | { ok: false };

const NOMES_RPC_PERMITIDOS = [
  'get_whatsapp_menu',
  'apply_whatsapp_cart_intent',
  'set_whatsapp_customer_name',
  'apply_whatsapp_fulfilment_intent',
  'set_whatsapp_delivery_quote',
  'apply_whatsapp_payment_intent',
  'apply_whatsapp_coupon_intent',
  'apply_whatsapp_review_intent',
  'create_order_from_whatsapp_session',
] as const;

type NomeRpcWhatsappPermitido = (typeof NOMES_RPC_PERMITIDOS)[number];

export async function chamarRpcWhatsapp(
  env: WhatsAppServiceEnv,
  nomeRpc: NomeRpcWhatsappPermitido,
  corpo: Record<string, unknown>
): Promise<ResultadoRpcWhatsapp> {
  let upstream: Response;
  try {
    upstream = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${nomeRpc}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
    });
  } catch {
    return { ok: false };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => undefined);
    return { ok: false };
  }

  try {
    const dados = await upstream.json();
    return { ok: true, dados };
  } catch {
    return { ok: false };
  }
}

export interface SessaoEnderecoWhatsapp {
  id: string;
  eircode: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  area: string | null;
}

type ResultadoCotacaoEntregaWhatsapp =
  | {
      ok: true;
      sessionId: string;
      state: string;
      deliveryQuoteId: string;
      distanceKm: number | null;
      deliveryFee: number | null;
      durationSeconds: number | null;
      changed: boolean;
    }
  | { ok: false; error: string };

// route.duration da Google Routes API (repassado sem alteração pela
// Edge Function) vem, na serialização JSON padrão de Duration, como uma
// string "<segundos>s" (ex.: "312s"). Não confirmado contra uma chamada
// real da API nesta etapa (só inferido da convenção do protobuf
// Duration) — por isso extrai defensivamente e devolve null se o
// formato não bater, em vez de assumir e devolver um valor errado.
function extrairDuracaoSegundosWhatsapp(bruto: unknown): number | null {
  if (typeof bruto !== 'string') return null;
  const match = bruto.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Number(match[1]) : null;
}

// Orquestra: calcula via calculate-delivery (service_role, sem
// Turnstile — a Edge Function em si nunca checou Turnstile, isso
// sempre foi responsabilidade de processarRotaProtegida na rota
// /api/delivery) e, se bem-sucedido, persiste via
// set_whatsapp_delivery_quote. distance_km/delivery_fee/duration
// devolvidos aqui são só pra exibição ao cliente na conversa — a RPC
// de criação do pedido (fora deste arquivo) continua sendo quem relê
// delivery_quotes e decide o valor final de verdade.
async function calcularCotacaoEntregaWhatsapp(
  env: WhatsAppServiceEnv,
  session: SessaoEnderecoWhatsapp
): Promise<ResultadoCotacaoEntregaWhatsapp> {
  if (!session.eircode || !session.address_line_1) {
    return { ok: false, error: 'Endereço incompleto para calcular entrega.' };
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${env.SUPABASE_URL}/functions/v1/calculate-delivery`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eircode: session.eircode,
        address_line_1: session.address_line_1,
        address_line_2: session.address_line_2,
        area: session.area,
      }),
    });
  } catch {
    return { ok: false, error: 'Não foi possível calcular a entrega no momento.' };
  }

  let dadosEntrega: unknown;
  try {
    dadosEntrega = await upstream.json();
  } catch {
    return { ok: false, error: 'Não foi possível calcular a entrega no momento.' };
  }

  if (!upstream.ok) {
    // Nunca repassa o corpo bruto de erro da Edge Function (pode conter
    // detalhe interno do Google/Supabase) — só mensagem genérica.
    return { ok: false, error: 'Não foi possível calcular a entrega para este endereço.' };
  }

  const resposta = dadosEntrega as {
    quote_id?: unknown;
    distance_km?: unknown;
    delivery_fee?: unknown;
    duration?: unknown;
  };

  const quoteId = typeof resposta.quote_id === 'string' ? resposta.quote_id : null;
  if (!quoteId) {
    return { ok: false, error: 'Não foi possível calcular a entrega para este endereço.' };
  }

  const persistencia = await chamarRpcWhatsapp(env, 'set_whatsapp_delivery_quote', {
    p_session_id: session.id,
    p_delivery_quote_id: quoteId,
  });
  if (!persistencia.ok) {
    return { ok: false, error: 'Não foi possível salvar a cotação de entrega.' };
  }

  const dadosPersistencia = persistencia.dados as Record<string, unknown>;

  return {
    ok: true,
    sessionId: typeof dadosPersistencia.session_id === 'string' ? dadosPersistencia.session_id : session.id,
    state: typeof dadosPersistencia.state === 'string' ? dadosPersistencia.state : '',
    deliveryQuoteId: quoteId,
    distanceKm: typeof resposta.distance_km === 'number' ? resposta.distance_km : null,
    deliveryFee: typeof resposta.delivery_fee === 'number' ? resposta.delivery_fee : null,
    durationSeconds: extrairDuracaoSegundosWhatsapp(resposta.duration),
    changed: typeof dadosPersistencia.changed === 'boolean' ? dadosPersistencia.changed : true,
  };
}

// Valida defensivamente o retorno de apply_whatsapp_fulfilment_intent
// (set_address) — nunca confia cegamente no shape do JSON. eircode e
// address_line_1 são obrigatórios pra calcular entrega; sem eles,
// devolve null (forma mínima segura) em vez de seguir com dado
// incompleto. Usa os campos DEVOLVIDOS pela RPC, nunca os valores
// crus da intent — garante que a cotação usa exatamente o estado
// persistido/normalizado no banco.
function extrairSessaoEnderecoWhatsapp(dados: unknown, sessionIdFallback: string): SessaoEnderecoWhatsapp | null {
  if (typeof dados !== 'object' || dados === null) return null;
  const d = dados as Record<string, unknown>;

  const eircode = typeof d.eircode === 'string' ? d.eircode : null;
  const addressLine1 = typeof d.address_line_1 === 'string' ? d.address_line_1 : null;
  if (!eircode || !addressLine1) return null;

  return {
    id: typeof d.session_id === 'string' ? d.session_id : sessionIdFallback,
    eircode,
    address_line_1: addressLine1,
    address_line_2: typeof d.address_line_2 === 'string' ? d.address_line_2 : null,
    area: typeof d.area === 'string' ? d.area : null,
  };
}

// request_human_handoff/cancel_conversation NÃO aparecem aqui (W6.6,
// seção 14) — o parser até reconhece essas palavras, mas nenhuma RPC
// as executa ainda (W6.9). Listar como "disponível" no help seria
// prometer uma funcionalidade que não existe.
const COMANDOS_AJUDA = [
  { intent: 'show_menu', examples: ['menu', 'cardápio'] },
  { intent: 'get_cart', examples: ['carrinho', 'cart'] },
  { intent: 'set_fulfilment_type', examples: ['retirada', 'entrega', 'collection', 'delivery'] },
] as const;

// Resolução de referência humana de produto (W6.7) — a IA/parser nunca
// produz product_id, só item_name em texto livre. Normaliza (NFD +
// remove diacríticos + lowercase + trim + colapsa espaços, mesma
// técnica de worker/whatsapp/parser.ts) e faz match EXATO contra o
// menu — nunca fuzzy-match silencioso. Aliases hardcoded, auditáveis
// (vazio por padrão, nenhum confirmado ainda contra o cardápio real).
export type ResolucaoProdutoWhatsapp =
  | { ok: true; productId: string; name: string }
  | {
      ok: false;
      reason: 'product_not_found' | 'product_ambiguous' | 'product_unavailable' | 'combo_not_supported';
      candidates?: string[];
    };

function normalizarNomeProdutoWhatsapp(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const ALIASES_PRODUTO_WHATSAPP: Record<string, string> = {};

export function resolveProductReference(
  itemName: string,
  menu: Record<string, unknown>[]
): ResolucaoProdutoWhatsapp {
  const normalizado = normalizarNomeProdutoWhatsapp(itemName);
  const alvo = ALIASES_PRODUTO_WHATSAPP[normalizado] ?? normalizado;

  const candidatos = menu.filter(
    (p) => typeof p.name === 'string' && normalizarNomeProdutoWhatsapp(p.name) === alvo
  );

  if (candidatos.length === 0) {
    return { ok: false, reason: 'product_not_found' };
  }
  if (candidatos.length > 1) {
    return {
      ok: false,
      reason: 'product_ambiguous',
      candidates: candidatos.map((c) => (typeof c.name === 'string' ? c.name : '')).filter(Boolean),
    };
  }

  const produto = candidatos[0];

  // Ordem exata pedida (W6.7, seção 10): not_found → ambiguous →
  // unavailable → combo_not_supported.
  if (produto.is_available === false) {
    return { ok: false, reason: 'product_unavailable' };
  }
  if (produto.category === 'combos') {
    return { ok: false, reason: 'combo_not_supported' };
  }

  return {
    ok: true,
    productId: String(produto.product_id),
    name: typeof produto.name === 'string' ? produto.name : itemName,
  };
}

// Enriquece o cart (só {item_type, product_id, quantity} no retorno
// de apply_whatsapp_cart_intent) com nome/preço/disponibilidade do
// menu — replies.ts (W6.6) não pode formatar um carrinho útil sem
// isso, e nunca deve inventar nome. Só leitura, nenhuma mutação nova.
// Se get_whatsapp_menu falhar, degrada graciosamente (name/price/
// is_available viram null pra todos os itens) — nunca bloqueia a
// resposta do carrinho por causa disso.
async function enriquecerCarrinhoComMenu(
  env: WhatsAppServiceEnv,
  dadosCarrinho: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cartBruto = Array.isArray(dadosCarrinho.cart) ? dadosCarrinho.cart : [];
  if (cartBruto.length === 0) {
    return { ...dadosCarrinho, cart: [] };
  }

  const resultadoMenu = await chamarRpcWhatsapp(env, 'get_whatsapp_menu', {});
  const menu = resultadoMenu.ok && Array.isArray(resultadoMenu.dados)
    ? (resultadoMenu.dados as Record<string, unknown>[])
    : [];

  const cartEnriquecido = cartBruto.map((itemBruto) => {
    const item = itemBruto as Record<string, unknown>;
    const produto = menu.find((p) => p.product_id === item.product_id);
    return {
      product_id: item.product_id,
      quantity: item.quantity,
      name: typeof produto?.name === 'string' ? produto.name : null,
      price: typeof produto?.price === 'number' ? produto.price : null,
      is_available: typeof produto?.is_available === 'boolean' ? produto.is_available : null,
    };
  });

  return { ...dadosCarrinho, cart: cartEnriquecido };
}

export async function dispatchWhatsAppIntent(
  intent: WhatsAppIntent,
  context: WhatsAppDispatchContext
): Promise<WhatsAppDispatchResult> {
  switch (intent.intent) {
    case 'show_menu': {
      const resultado = await chamarRpcWhatsapp(context.env, 'get_whatsapp_menu', {});
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'menu', data: resultado.dados };
    }

    case 'get_cart': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_cart_intent', {
        p_session_id: context.sessionId,
        p_intent: 'get_cart',
        p_payload: {},
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      const dadosEnriquecidos = await enriquecerCarrinhoComMenu(context.env, resultado.dados as Record<string, unknown>);
      return { handled: true, intent: intent.intent, reply_key: 'cart', data: dadosEnriquecidos };
    }

    case 'add_item': {
      const resultadoMenu = await chamarRpcWhatsapp(context.env, 'get_whatsapp_menu', {});
      if (!resultadoMenu.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      const menu = Array.isArray(resultadoMenu.dados) ? (resultadoMenu.dados as Record<string, unknown>[]) : [];

      const resolucao = resolveProductReference(intent.item_name, menu);
      if (!resolucao.ok) {
        return {
          handled: false,
          intent: intent.intent,
          reason: resolucao.reason,
          data: { item_name: intent.item_name, candidates: resolucao.candidates },
        };
      }

      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_cart_intent', {
        p_session_id: context.sessionId,
        p_intent: 'add_item',
        p_payload: { product_id: resolucao.productId, quantity: intent.quantity },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }

      const enriquecido = await enriquecerCarrinhoComMenu(context.env, resultado.dados as Record<string, unknown>);
      return {
        handled: true,
        intent: intent.intent,
        reply_key: 'item_added',
        data: { ...enriquecido, added_name: resolucao.name },
      };
    }

    case 'add_item_batch': {
      const resultadoMenu = await chamarRpcWhatsapp(context.env, 'get_whatsapp_menu', {});
      if (!resultadoMenu.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      const menu = Array.isArray(resultadoMenu.dados) ? (resultadoMenu.dados as Record<string, unknown>[]) : [];

      const added: Array<{ item_name: string; quantity: number }> = [];
      const failed: Array<{ item_name: string; reason: string; candidates?: string[] }> = [];

      // Aplica os itens válidos, reporta os inválidos (W6.1) — nunca
      // tudo-ou-nada. Política independente da de dispatchWhatsAppActions
      // (que para no primeiro item da SEQUÊNCIA DE AÇÕES que falhar) —
      // aqui é dentro de UMA ação só, com múltiplos itens.
      for (const itemPedido of intent.items) {
        const resolucao = resolveProductReference(itemPedido.item_name, menu);
        if (!resolucao.ok) {
          failed.push({ item_name: itemPedido.item_name, reason: resolucao.reason, candidates: resolucao.candidates });
          continue;
        }

        const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_cart_intent', {
          p_session_id: context.sessionId,
          p_intent: 'add_item',
          p_payload: { product_id: resolucao.productId, quantity: itemPedido.quantity },
        });
        if (!resultado.ok) {
          failed.push({ item_name: itemPedido.item_name, reason: 'rpc_error' });
          continue;
        }

        added.push({ item_name: resolucao.name, quantity: itemPedido.quantity });
      }

      return {
        handled: true,
        intent: intent.intent,
        reply_key: failed.length === 0 ? 'items_added_batch' : 'partial_batch',
        data: { added, failed },
      };
    }

    case 'remove_item': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_cart_intent', {
        p_session_id: context.sessionId,
        p_intent: 'remove_item',
        p_payload: { cart_index: intent.cart_index },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      const enriquecido = await enriquecerCarrinhoComMenu(context.env, resultado.dados as Record<string, unknown>);
      return { handled: true, intent: intent.intent, reply_key: 'item_removed', data: enriquecido };
    }

    case 'clear_cart': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_cart_intent', {
        p_session_id: context.sessionId,
        p_intent: 'clear_cart',
        p_payload: {},
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'cart_cleared', data: resultado.dados };
    }

    case 'show_help':
      return {
        handled: true,
        intent: intent.intent,
        reply_key: 'help',
        data: { commands: COMANDOS_AJUDA },
      };

    case 'set_fulfilment_type': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_fulfilment_intent', {
        p_session_id: context.sessionId,
        p_intent: 'set_fulfilment_type',
        p_payload: { fulfilment_type: intent.fulfilment_type },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      // Nunca calcula entrega aqui, mesmo pra 'delivery' — endereço
      // ainda não foi informado nesse ponto do fluxo.
      const replyKey = intent.fulfilment_type === 'collection' ? 'fulfilment_collection' : 'fulfilment_delivery';
      return { handled: true, intent: intent.intent, reply_key: replyKey, data: resultado.dados };
    }

    case 'set_address': {
      const resultadoFulfilment = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_fulfilment_intent', {
        p_session_id: context.sessionId,
        p_intent: 'set_address',
        p_payload: {
          eircode: intent.eircode,
          address_line_1: intent.address_line_1,
          address_line_2: intent.address_line_2 ?? null,
          area: intent.area ?? null,
        },
      });
      if (!resultadoFulfilment.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error', data: { stage: 'set_address' } };
      }

      // Sequência obrigatória: set_address → calcularCotacaoEntregaWhatsapp
      // (que internamente chama set_whatsapp_delivery_quote) → retorno
      // final. Usa os dados DEVOLVIDOS pela RPC (extrairSessaoEnderecoWhatsapp),
      // nunca os valores crus do intent.
      const sessaoEndereco = extrairSessaoEnderecoWhatsapp(resultadoFulfilment.dados, context.sessionId);
      if (!sessaoEndereco) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error', data: { stage: 'set_address' } };
      }

      const cotacao = await calcularCotacaoEntregaWhatsapp(context.env, sessaoEndereco);
      if (!cotacao.ok) {
        return {
          handled: false,
          intent: intent.intent,
          reason: 'rpc_error',
          data: { stage: 'calculate_delivery', error: cotacao.error },
        };
      }

      return {
        handled: true,
        intent: intent.intent,
        reply_key: 'delivery_quote',
        data: {
          session_id: cotacao.sessionId,
          state: cotacao.state,
          delivery_quote_id: cotacao.deliveryQuoteId,
          distance_km: cotacao.distanceKm,
          delivery_fee: cotacao.deliveryFee,
          duration_seconds: cotacao.durationSeconds,
          changed: cotacao.changed,
        },
      };
    }

    case 'set_delivery_instructions': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_fulfilment_intent', {
        p_session_id: context.sessionId,
        p_intent: 'set_delivery_instructions',
        p_payload: { instructions: intent.instructions },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'delivery_instructions', data: resultado.dados };
    }

    case 'set_payment_method': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_payment_intent', {
        p_session_id: context.sessionId,
        p_intent: 'set_payment_method',
        p_payload: { payment_method: intent.payment_method },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      // A RPC continua sendo a autoridade pra enum válido/disponibilidade
      // de Revolut/bank_transfer/limpeza de needs_change/cash_amount/
      // state — o dispatcher só repassa o resultado.
      return { handled: true, intent: intent.intent, reply_key: 'payment_method', data: resultado.dados };
    }

    case 'set_cash_change': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_payment_intent', {
        p_session_id: context.sessionId,
        p_intent: 'set_cash_change',
        p_payload: { needs_change: intent.needs_change, cash_amount: intent.cash_amount ?? null },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      // Nenhum cálculo/comparação de troco aqui — a RPC de criação do
      // pedido (fora deste arquivo) é quem valida cash_amount contra o
      // total, no momento real da confirmação.
      return { handled: true, intent: intent.intent, reply_key: 'cash_change', data: resultado.dados };
    }

    case 'apply_coupon': {
      // Só trim — sem uppercase: apply_whatsapp_coupon_intent/validate_coupon
      // já normalizam (upper(trim(...))) internamente, duplicar aqui seria
      // redundante.
      const couponCode = intent.coupon_code.trim();
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_coupon_intent', {
        p_session_id: context.sessionId,
        p_intent: 'apply_coupon',
        p_payload: { coupon_code: couponCode },
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'coupon_applied', data: resultado.dados };
    }

    case 'remove_coupon': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_coupon_intent', {
        p_session_id: context.sessionId,
        p_intent: 'remove_coupon',
        p_payload: {},
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'coupon_removed', data: resultado.dados };
    }

    case 'review_order': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_review_intent', {
        p_session_id: context.sessionId,
        p_intent: 'get_review',
        p_payload: {},
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      // Itens/subtotal/desconto/delivery_fee/total já vêm prontos de
      // build_whatsapp_order_preview (dentro da RPC) — puro passthrough,
      // nenhum recálculo no Worker.
      return { handled: true, intent: intent.intent, reply_key: 'order_review', data: resultado.dados };
    }

    case 'confirm_review': {
      const resultado = await chamarRpcWhatsapp(context.env, 'apply_whatsapp_review_intent', {
        p_session_id: context.sessionId,
        p_intent: 'confirm_review',
        p_payload: {},
      });
      if (!resultado.ok) {
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      return { handled: true, intent: intent.intent, reply_key: 'awaiting_confirmation', data: resultado.dados };
    }

    case 'confirm_order': {
      // Ponto crítico: chama SOMENTE a RPC de criação do pedido a partir
      // da sessão — nenhum payload montado aqui, nenhum total
      // recalculado, nenhuma baixa de estoque manual, nenhum state
      // atualizado diretamente. A RPC é a única autoridade.
      const resultado = await chamarRpcWhatsapp(context.env, 'create_order_from_whatsapp_session', {
        p_session_id: context.sessionId,
      });
      if (!resultado.ok) {
        // Cobre quota expirada/produto indisponível/cash insuficiente/
        // negócio fechado/cupom/qualquer regra final — a RPC levanta
        // exceção, chamarRpcWhatsapp devolve ok:false. Nunca corrige
        // silenciosamente nem tenta de novo automaticamente.
        return { handled: false, intent: intent.intent, reason: 'rpc_error' };
      }
      // duplicate=true (retry/segunda "confirmar" numa sessão que já
      // tem pedido) e duplicate=false (criação nova) são AMBOS sucesso
      // — a idempotência já é garantida dentro da RPC (W5.2), que
      // devolve o mesmo order_id/order_number nos dois casos. Isso é
      // TOTALMENTE diferente de duplicate=true da mensagem inbound da
      // Meta (esse já é tratado antes, em processarMensagemWhatsapp —
      // o dispatcher nem chega a rodar nesse caso). Nenhuma lógica
      // condicional extra aqui: o dispatcher sempre repassa o data como
      // veio, nunca tenta criar de novo por outro caminho.
      return { handled: true, intent: intent.intent, reply_key: 'order_created', data: resultado.dados };
    }

    case 'request_human_handoff':
    case 'cancel_conversation':
      return { handled: false, intent: intent.intent, reason: 'not_implemented' };

    case 'unknown':
      return { handled: false, intent: intent.intent, reason: 'unknown' };
  }
}

// Executor sequencial do envelope de ações da IA (W6.7, seção 15).
// Política: PARA na primeira ação não tratada (handled:false) — evita
// compor erros (ex.: se set_payment_method falha porque Revolut está
// desabilitado, não faz sentido ainda tentar set_cash_change logo
// depois). Independente da política interna de add_item_batch
// ("aplica válidos, reporta inválidos") — são níveis diferentes: essa
// aqui é entre ações distintas da mesma mensagem, aquela é dentro de
// uma única ação com múltiplos itens.
export async function dispatchWhatsAppActions(
  actions: WhatsAppIntent[],
  context: WhatsAppDispatchContext
): Promise<WhatsAppDispatchResult[]> {
  const resultados: WhatsAppDispatchResult[] = [];

  for (const acao of actions) {
    const resultado = await dispatchWhatsAppIntent(acao, context);
    resultados.push(resultado);
    if (!resultado.handled) break;
  }

  return resultados;
}
