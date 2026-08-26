// Worker/API proxy — L2.3F + L2.3G (rate limit + Turnstile) + L2.4B (headers de segurança).
//
// Desde L2.4B, run_worker_first=true (wrangler.jsonc) faz este Worker rodar
// em TODA requisição, não só /api/* — necessário para anexar os security
// headers também às respostas de assets estáticos (HTML/CSS/JS). Caminhos
// fora de /api/* continuam sendo só repassados pra env.ASSETS.fetch(), sem
// nenhuma mudança de conteúdo — só os headers da resposta são ajustados
// (ver aplicarSecurityHeaders).
//
// Nenhuma URL é montada a partir de input do cliente: os 3 destinos fixos
// de /api/* são sempre caminhos fixos sob SUPABASE_URL — não existe proxy
// genérico.

import type { WhatsAppIntent, WhatsAppLanguage, WhatsAppSessionState } from './whatsapp/types';
import { parseDeterministicIntent } from './whatsapp/parser';
import { chamarRpcWhatsapp, dispatchWhatsAppActions } from './whatsapp/dispatcher';
import { interpretWhatsAppMessageWithAI } from './whatsapp/ai';

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  WHATSAPP_VERIFY_TOKEN: string;
  META_APP_SECRET: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  // W6.7D — endpoint temporário de diagnóstico (remover junto com a rota
  // /internal/whatsapp/ai-preview quando a Meta for desbloqueada e o W6.8 existir).
  AI_TEST_TOKEN: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  RATE_LIMIT_DELIVERY: RateLimitBinding;
  RATE_LIMIT_COUPON: RateLimitBinding;
  RATE_LIMIT_ORDER: RateLimitBinding;
}

const LIMITE_BYTES: Record<string, number> = {
  '/api/delivery': 8 * 1024,
  '/api/coupon': 2 * 1024,
  '/api/order': 64 * 1024,
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type LeituraCorpo =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

async function lerCorpoComLimite(request: Request, limiteBytes: number): Promise<LeituraCorpo> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > limiteBytes) {
    return { ok: false, response: jsonResponse({ error: 'Corpo da requisição excede o limite permitido.' }, 413) };
  }

  let texto: string;
  try {
    texto = await request.text();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Não foi possível ler o corpo da requisição.' }, 400) };
  }

  // Segunda camada: Content-Length pode estar ausente ou não bater com o
  // corpo real — não confiar só no header.
  if (texto.length > limiteBytes) {
    return { ok: false, response: jsonResponse({ error: 'Corpo da requisição excede o limite permitido.' }, 413) };
  }

  let corpo: unknown;
  try {
    corpo = texto ? JSON.parse(texto) : {};
  } catch {
    return { ok: false, response: jsonResponse({ error: 'JSON inválido.' }, 400) };
  }

  return { ok: true, body: corpo };
}

type ConfigSupabase =
  | { ok: true; url: string; key: string }
  | { ok: false; response: Response };

function obterConfigSupabase(env: Env): ConfigSupabase {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { ok: false, response: jsonResponse({ error: 'Configuração do servidor ausente.' }, 500) };
  }
  return { ok: true, url: env.SUPABASE_URL, key: env.SUPABASE_PUBLISHABLE_KEY };
}

function obterIpCliente(request: Request): string {
  // Só CF-Connecting-IP (definido pela própria Cloudflare na borda) — nunca
  // X-Forwarded-For, que o cliente pode enviar com qualquer valor.
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

type ResultadoTurnstile = { ok: true } | { ok: false; response: Response };

async function validarTurnstile(token: string | null, secretKey: string, remoteIp: string | null): Promise<ResultadoTurnstile> {
  if (!token) {
    return { ok: false, response: jsonResponse({ error: 'Verificação de segurança ausente.' }, 403) };
  }

  const params = new URLSearchParams();
  params.set('secret', secretKey);
  params.set('response', token);
  if (remoteIp) params.set('remoteip', remoteIp);

  let upstream: Response;
  try {
    upstream = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Falha ao validar verificação de segurança.' }, 503) };
  }

  let resultado: { success?: boolean };
  try {
    resultado = await upstream.json();
  } catch {
    return { ok: false, response: jsonResponse({ error: 'Falha ao validar verificação de segurança.' }, 503) };
  }

  // Nunca repassa o corpo bruto do Turnstile (pode incluir error-codes
  // internos) — só o resultado booleano importa pro chamador.
  if (resultado.success !== true) {
    return { ok: false, response: jsonResponse({ error: 'Verificação de segurança inválida.' }, 403) };
  }

  return { ok: true };
}

async function repassarParaSupabase(destino: string, key: string, corpo: unknown): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(destino, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'apikey': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
    });
  } catch {
    return jsonResponse({ error: 'Falha ao contatar o servidor.' }, 502);
  }

  const texto = await upstream.text();
  return new Response(texto, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}

// Ordem das defesas (L2.3G item 6), aplicada a cada rota protegida:
// (1) método — já validado antes de chamar este helper;
// (2) env necessário; (3) rate limit; (4)+(5) corpo/JSON; (6) Turnstile
// quando aplicável; (7) chamar o Supabase. Objetivo: bloquear abuso antes
// de gastar chamada ao Google/Supabase.
async function processarRotaProtegida(opts: {
  request: Request;
  env: Env;
  limiteBytes: number;
  rateLimiter: RateLimitBinding;
  exigeTurnstile: boolean;
  montarChamada: (corpo: unknown, config: { url: string; key: string }) => Promise<Response>;
}): Promise<Response> {
  const { request, env, limiteBytes, rateLimiter, exigeTurnstile, montarChamada } = opts;

  // (2) env necessário
  const config = obterConfigSupabase(env);
  if (!config.ok) return config.response;
  if (exigeTurnstile && !env.TURNSTILE_SECRET_KEY) {
    return jsonResponse({ error: 'Configuração do servidor ausente.' }, 500);
  }

  // (3) rate limit — binding nativo do Workers, nunca contador em memória
  const ip = obterIpCliente(request);
  const { success } = await rateLimiter.limit({ key: ip });
  if (!success) {
    return jsonResponse({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' }, 429);
  }

  // (4)+(5) corpo/JSON
  const leitura = await lerCorpoComLimite(request, limiteBytes);
  if (!leitura.ok) return leitura.response;

  // (6) Turnstile, só quando a rota exige
  if (exigeTurnstile) {
    const token = request.headers.get('X-Turnstile-Token');
    const turnstile = await validarTurnstile(token, env.TURNSTILE_SECRET_KEY, ip === 'unknown' ? null : ip);
    if (!turnstile.ok) return turnstile.response;
  }

  // (7) chamar o Supabase
  return montarChamada(leitura.body, config);
}

const ROTAS_VALIDAS = new Set(['/api/delivery', '/api/coupon', '/api/order']);

// L2.4B — headers básicos de segurança, aplicados a TODA resposta (assets e /api/*), num único
// lugar. Preserva todos os headers já existentes na resposta (Content-Type, Allow, etc.) — só
// adiciona os headers abaixo. HSTS/COOP/CORP ficam para etapas posteriores. L2.4C validou esta
// política em Content-Security-Policy-Report-Only em produção sem violações nos fluxos
// testados; L2.4D promoveu para Content-Security-Policy real (enforcement) — mesma política,
// só o nome do header mudou. Continua só nas respostas de assets (documentos/CSS/JS
// consumidos pelo navegador) — nunca nas respostas JSON de /api/*. Sem
// report-uri/report-to/Reporting-Endpoints ainda (sem endpoint de coleta configurado).
const CSP_REPORT_ONLY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://challenges.cloudflare.com https://cdnjs.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'self' https://ghntpyqdbgxaisfgytto.supabase.co wss://ghntpyqdbgxaisfgytto.supabase.co https://challenges.cloudflare.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self';";

function aplicarSecurityHeaders(response: Response, opts: { cspReportOnly: boolean }): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
  );
  if (opts.cspReportOnly) {
    headers.set('Content-Security-Policy', CSP_REPORT_ONLY);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Mesma lógica de antes (roteamento /api/*), só extraída do fetch() principal para que
// aplicarSecurityHeaders possa envolver o resultado num único ponto, sem duplicar em cada return.
async function tratarRotaApi(request: Request, env: Env, path: string): Promise<Response> {
  if (!ROTAS_VALIDAS.has(path)) {
    return jsonResponse({ error: 'Rota não encontrada.' }, 404);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Allow': 'POST, OPTIONS' } });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Método não permitido.' }, 405);
  }

  if (path === '/api/delivery') {
    return processarRotaProtegida({
      request,
      env,
      limiteBytes: LIMITE_BYTES[path],
      rateLimiter: env.RATE_LIMIT_DELIVERY,
      exigeTurnstile: true,
      montarChamada: (corpo, config) =>
        repassarParaSupabase(`${config.url}/functions/v1/calculate-delivery`, config.key, corpo),
    });
  }

  if (path === '/api/coupon') {
    return processarRotaProtegida({
      request,
      env,
      limiteBytes: LIMITE_BYTES[path],
      rateLimiter: env.RATE_LIMIT_COUPON,
      exigeTurnstile: false,
      montarChamada: (corpo, config) => {
        const c = corpo as { code?: unknown; subtotal?: unknown };
        return repassarParaSupabase(`${config.url}/rest/v1/rpc/validate_coupon`, config.key, {
          p_code: c.code,
          p_subtotal: c.subtotal,
        });
      },
    });
  }

  // path === '/api/order'
  return processarRotaProtegida({
    request,
    env,
    limiteBytes: LIMITE_BYTES[path],
    rateLimiter: env.RATE_LIMIT_ORDER,
    exigeTurnstile: true,
    montarChamada: (corpo, config) =>
      repassarParaSupabase(`${config.url}/rest/v1/rpc/create_customer_order`, config.key, { payload: corpo }),
  });
}

// Rotas /webhooks/* — separadas de /api/* (ROTAS_VALIDAS/tratarRotaApi):
// não herdam Turnstile nem os rate limiters de /api/*, porque a origem
// (Meta) é infraestrutura server-to-server compartilhada, não um
// navegador humano — aplicar esses controles pensados pra tráfego de
// browser arriscaria limitar entrega legítima da própria Meta. Só o
// caminho exato /webhooks/whatsapp existe; qualquer outro sob /webhooks/
// é 404 — mesma filosofia de "sem proxy genérico" já documentada no topo
// do arquivo pras rotas /api/*. GET é o handshake de verificação;
// POST é o recebimento real de eventos (assinatura + dedup + sessão +
// gravação — ver tratarWebhookPost), sem IA e sem resposta ao WhatsApp
// nesta etapa.
async function tratarRotaWebhook(request: Request, env: Env, path: string): Promise<Response> {
  if (path !== '/webhooks/whatsapp') {
    return jsonResponse({ error: 'Rota não encontrada.' }, 404);
  }

  if (request.method === 'GET') {
    return tratarHandshakeWhatsapp(request, env);
  }

  if (request.method === 'POST') {
    return tratarWebhookPost(request, env);
  }

  return jsonResponse({ error: 'Método não permitido.' }, 405);
}

// Handshake de verificação da Meta (GET). hub.challenge só é ecoado como
// texto puro (nunca dentro de JSON — a Meta exige o valor literal) quando
// hub.mode/hub.verify_token batem exatamente com o esperado.
function tratarHandshakeWhatsapp(request: Request, env: Env): Response {
  if (!env.WHATSAPP_VERIFY_TOKEN) {
    return jsonResponse({ error: 'Configuração do servidor ausente.' }, 500);
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || token !== env.WHATSAPP_VERIFY_TOKEN || !challenge) {
    return jsonResponse({ error: 'Verificação não autorizada.' }, 403);
  }

  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
  });
}

// ---------------------------------------------------------------------
// POST /webhooks/whatsapp — recebimento real de eventos da Meta Cloud
// API. Ordem obrigatória: (1) env necessário; (2) ler corpo bruto;
// (3) validar assinatura ANTES de qualquer JSON.parse; (4) parsear;
// (5) extrair mensagens (evento sem messages, ex. status update, é 200
// sem processamento); (6)-(10) normalizar telefone/tipo/corpo/payload
// sanitizado; (11) chamar a RPC record_whatsapp_inbound_message via
// service_role; (12) duplicata ou nova, sempre só persiste e responde
// 200 — nenhuma IA, nenhuma resposta ao WhatsApp, nenhum pedido nesta
// etapa. Sem Turnstile, sem rate limit por IP (mesma razão já
// documentada acima em tratarRotaWebhook).
// ---------------------------------------------------------------------

interface WhatsappContato {
  wa_id?: string;
  profile?: { name?: string };
}

interface WhatsappMensagem {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  image?: { id?: string; caption?: string };
  document?: { id?: string; caption?: string };
  video?: { id?: string; caption?: string };
  audio?: { id?: string };
  sticker?: { id?: string };
  reaction?: { emoji?: string };
  contacts?: unknown[];
}

interface MensagemWhatsappComContato {
  mensagem: WhatsappMensagem;
  nomePerfil: string | null;
}

const TIPOS_MENSAGEM_CONHECIDOS = new Set([
  'text', 'interactive', 'image', 'document', 'audio', 'location',
  'video', 'sticker', 'contacts', 'button', 'reaction', 'order', 'system',
]);

function bufferParaHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function calcularAssinaturaHmacSha256(segredo: string, corpoBytes: ArrayBuffer): Promise<string> {
  const encoder = new TextEncoder();
  const chave = await crypto.subtle.importKey(
    'raw',
    encoder.encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  // HMAC calculado direto sobre os bytes exatos recebidos — nunca sobre
  // uma string re-decodificada/re-encodada, que poderia divergir dos
  // bytes originais em casos raros de encoding.
  const assinatura = await crypto.subtle.sign('HMAC', chave, corpoBytes);
  return bufferParaHex(assinatura);
}

// Comparação em tempo constante do hex (comprimento sempre igual, já que
// SHA-256 é fixo) — evita vazar informação de timing sobre o quanto o
// hash calculado bate com o recebido.
function compararEmTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diferenca === 0;
}

// Formato exigido do header: "sha256=" + exatamente 64 caracteres hex
// (um digest SHA-256). Qualquer coisa fora disso é rejeitada antes mesmo
// de calcular o HMAC — não vale a pena gastar a chamada de crypto pra um
// header obviamente malformado.
const REGEX_ASSINATURA_SHA256 = /^[0-9a-f]{64}$/i;

async function validarAssinaturaMeta(request: Request, corpoBytes: ArrayBuffer, appSecret: string): Promise<boolean> {
  const header = request.headers.get('X-Hub-Signature-256');
  if (!header || !header.startsWith('sha256=')) return false;

  const assinaturaRecebida = header.slice('sha256='.length);
  if (!REGEX_ASSINATURA_SHA256.test(assinaturaRecebida)) return false;

  const assinaturaCalculada = await calcularAssinaturaHmacSha256(appSecret, corpoBytes);
  return compararEmTempoConstante(assinaturaRecebida.toLowerCase(), assinaturaCalculada);
}

// Estrutura padrão da Cloud API: entry[].changes[].value.messages[], com
// value.contacts[] trazendo o profile.name de quem enviou. Eventos sem
// messages (ex.: status de entrega/leitura) resultam em array vazio —
// tratarWebhookPost devolve 200 sem chamar a RPC nesse caso.
function extrairMensagensWhatsapp(payload: unknown): MensagemWhatsappComContato[] {
  const resultado: MensagemWhatsappComContato[] = [];
  const entradas = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entradas)) return resultado;

  for (const entrada of entradas) {
    const mudancas = (entrada as { changes?: unknown })?.changes;
    if (!Array.isArray(mudancas)) continue;

    for (const mudanca of mudancas) {
      const valor = (mudanca as { value?: unknown })?.value as
        | { messages?: unknown; contacts?: unknown }
        | undefined;
      const mensagens = valor?.messages;
      if (!Array.isArray(mensagens)) continue;

      const contatos: WhatsappContato[] = Array.isArray(valor?.contacts) ? (valor!.contacts as WhatsappContato[]) : [];

      for (const mensagem of mensagens as WhatsappMensagem[]) {
        const contato = contatos.find((c) => c.wa_id === mensagem.from) ?? contatos[0];
        const nomePerfil = typeof contato?.profile?.name === 'string' ? contato.profile.name : null;
        resultado.push({ mensagem, nomePerfil });
      }
    }
  }

  return resultado;
}

function normalizarTelefoneWhatsapp(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const digitos = bruto.replace(/\D/g, '');
  return digitos.length > 0 ? digitos : null;
}

function mapearTipoMensagemWhatsapp(tipoBruto: unknown): string {
  return typeof tipoBruto === 'string' && TIPOS_MENSAGEM_CONHECIDOS.has(tipoBruto) ? tipoBruto : 'unknown';
}

// Só extrai texto quando o próprio tipo naturalmente tem um — nunca
// inventa corpo pra tipos sem conteúdo textual (ex.: sticker, location).
function extrairCorpoMensagemWhatsapp(mensagem: WhatsappMensagem, tipo: string): string | null {
  switch (tipo) {
    case 'text':
      return mensagem.text?.body ?? null;
    case 'button':
      return mensagem.button?.text ?? null;
    case 'interactive':
      return mensagem.interactive?.button_reply?.title ?? mensagem.interactive?.list_reply?.title ?? null;
    case 'image':
      return mensagem.image?.caption ?? null;
    case 'document':
      return mensagem.document?.caption ?? null;
    case 'video':
      return mensagem.video?.caption ?? null;
    case 'reaction':
      return mensagem.reaction?.emoji ?? null;
    default:
      return null;
  }
}

// raw_payload minimizado — nunca o payload inteiro da Meta. location e
// contacts têm teto próprio e mais restrito (nem message_id/timestamp
// entram ali) porque são os dois tipos com maior risco de PII (GPS
// exato; cartão de contato de terceiro). Nunca inclui assinatura,
// headers, tokens, app secret ou service_role — só o que já veio no
// corpo JSON já validado.
function construirRawPayloadSanitizado(
  mensagem: WhatsappMensagem,
  tipo: string,
  nomePerfil: string | null
): Record<string, unknown> {
  if (tipo === 'location') {
    return { location_received: true };
  }

  if (tipo === 'contacts') {
    return { contacts_count: Array.isArray(mensagem.contacts) ? mensagem.contacts.length : 0 };
  }

  const base: Record<string, unknown> = {
    message_id: mensagem.id ?? null,
    type: tipo,
    timestamp: mensagem.timestamp ?? null,
    profile_name: nomePerfil,
  };

  if (tipo === 'image' || tipo === 'document' || tipo === 'audio' || tipo === 'video' || tipo === 'sticker') {
    const midia = (mensagem as Record<string, { id?: string } | undefined>)[tipo];
    base.media_id = midia?.id ?? null;
  }

  if (tipo === 'interactive') {
    base.interactive_id = mensagem.interactive?.button_reply?.id ?? mensagem.interactive?.list_reply?.id ?? null;
  }

  return base;
}

// Wrapper dedicado pra chamar a RPC do WhatsApp — deliberadamente NÃO
// reaproveita repassarParaSupabase aqui. repassarParaSupabase existe pra
// repassar a mensagem de erro do Supabase pro navegador (ex.: "Estoque
// insuficiente" nas rotas /api/*, onde isso é o comportamento correto e
// não deve mudar). Pra Meta, o corpo de ERRO da resposta upstream nunca é
// lido nem repassado — só o status importa nesse caso. O corpo de
// SUCESSO agora É lido e validado (W6.3): o dispatcher precisa de
// duplicate/session_id/state/human_handoff pra decidir se processa a
// mensagem — nunca confia cegamente no shape do JSON recebido. Qualquer
// mensagem/hint/detail de erro do Postgres/PostgREST fica só do lado do
// Supabase; a chave service_role nunca é logada nem aparece em nenhuma
// resposta.

const ESTADOS_WHATSAPP_VALIDOS = new Set<WhatsAppSessionState>([
  'greeting', 'browsing_menu', 'building_cart', 'collecting_fulfilment',
  'collecting_address', 'collecting_payment', 'reviewing_order',
  'awaiting_confirmation', 'order_created', 'closed',
]);

interface RetornoRpcInboundWhatsapp {
  duplicate: boolean;
  session_id: string;
  message_id: string | null;
  state: WhatsAppSessionState;
  language: WhatsAppLanguage;
  human_handoff: boolean;
}

function validarRetornoRpcInboundWhatsapp(dados: unknown): RetornoRpcInboundWhatsapp | null {
  if (typeof dados !== 'object' || dados === null) return null;
  const d = dados as Record<string, unknown>;

  if (typeof d.duplicate !== 'boolean') return null;
  if (typeof d.session_id !== 'string' || d.session_id.length === 0) return null;
  if (typeof d.human_handoff !== 'boolean') return null;
  if (typeof d.state !== 'string' || !ESTADOS_WHATSAPP_VALIDOS.has(d.state as WhatsAppSessionState)) return null;

  return {
    duplicate: d.duplicate,
    session_id: d.session_id,
    message_id: typeof d.message_id === 'string' ? d.message_id : null,
    state: d.state as WhatsAppSessionState,
    // Fallback pontual (nunca invalida o payload inteiro): valor
    // ausente/inesperado (ex.: RPC antiga ainda não versionada em
    // staging) cai em 'pt', mesmo padrão já usado por message_id.
    language: d.language === 'pt' || d.language === 'en' ? d.language : 'pt',
    human_handoff: d.human_handoff,
  };
}

type ResultadoRpcInboundWhatsapp =
  | { ok: true; dados: RetornoRpcInboundWhatsapp }
  | { ok: false };

async function chamarRpcMensagemWhatsapp(env: Env, corpo: Record<string, unknown>): Promise<ResultadoRpcInboundWhatsapp> {
  let upstream: Response;
  try {
    upstream = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_whatsapp_inbound_message`, {
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
    // Corpo de erro sempre drenado (evita stream pendurada), mas nunca
    // lido/usado/repassado — nenhum detail do Postgres/PostgREST chega
    // à Meta.
    await upstream.text().catch(() => undefined);
    return { ok: false };
  }

  let dados: unknown;
  try {
    dados = await upstream.json();
  } catch {
    return { ok: false };
  }

  const validado = validarRetornoRpcInboundWhatsapp(dados);
  if (!validado) {
    return { ok: false };
  }

  return { ok: true, dados: validado };
}

// Uma mensagem sem from/id utilizável não é falha de infraestrutura — só
// é ignorada (não há chave de idempotência nem telefone válido pra
// persistir com segurança).
//
// Ordem obrigatória (W6.3, seguindo exatamente o desenho aprovado):
// persistir → duplicate? parar → human_handoff? parar → capturar
// profile.name (melhor esforço, nunca bloqueia) → sem corpo textual?
// parar (nunca inventa intent pra imagem/sticker/etc.) → parser
// determinístico → dispatcher. Falha do dispatcher (RPC downstream
// indisponível, etc.) NUNCA vira retorno {ok:false} depois que a
// inbound já foi persistida com sucesso — só a falha da própria
// persistência (chamarRpcMensagemWhatsapp) contribui pro 500/retry da
// Meta (tratarWebhookPost), evitando retry infinito por causa de uma
// funcionalidade puramente downstream.
async function processarMensagemWhatsapp(item: MensagemWhatsappComContato, env: Env): Promise<{ ok: true } | { ok: false }> {
  const phone = normalizarTelefoneWhatsapp(item.mensagem.from);
  const providerMessageId = typeof item.mensagem.id === 'string' ? item.mensagem.id : null;

  if (!phone || !providerMessageId) {
    return { ok: true };
  }

  const tipo = mapearTipoMensagemWhatsapp(item.mensagem.type);
  const corpoTexto = extrairCorpoMensagemWhatsapp(item.mensagem, tipo);
  const rawPayload = construirRawPayloadSanitizado(item.mensagem, tipo, item.nomePerfil);

  const resultado = await chamarRpcMensagemWhatsapp(env, {
    p_phone: phone,
    p_provider_message_id: providerMessageId,
    p_message_type: tipo,
    p_body: corpoTexto,
    p_raw_payload: rawPayload,
  });

  if (!resultado.ok) {
    return { ok: false };
  }

  const inbound = resultado.dados;

  // Mensagem já processada antes (duplicata da Meta/retry) — nunca
  // reinterpreta, nunca reaplica intent, nunca chama o dispatcher de novo.
  if (inbound.duplicate) {
    return { ok: true };
  }

  // Atendimento humano em andamento — persistiu, mas nenhum
  // processamento automático (nem sequer captura de nome) roda daqui
  // pra frente.
  if (inbound.human_handoff) {
    return { ok: true };
  }

  // Melhor esforço: nome só é obrigatório em create_order (W5.2), nunca
  // em menu/carrinho — falha aqui nunca bloqueia o resto do
  // processamento. Sem logging (nenhum padrão de log seguro existe
  // ainda no projeto pra introduzir agora).
  if (item.nomePerfil) {
    await chamarRpcWhatsapp(env, 'set_whatsapp_customer_name', {
      p_session_id: inbound.session_id,
      p_customer_name: item.nomePerfil,
    }).catch(() => undefined);
  }

  if (!corpoTexto || corpoTexto.trim().length === 0) {
    // Tipo sem corpo textual (imagem, sticker, localização, etc.) —
    // nunca inventa intent; a persistência já aconteceu, processamento
    // automático para por aqui.
    return { ok: true };
  }

  // language vem da própria sessão (W6.7B) — record_whatsapp_inbound_message
  // agora devolve o valor persistido em whatsapp_sessions.language,
  // nunca mais um fallback hardcoded no caminho normal.
  const intentDeterministica = parseDeterministicIntent(corpoTexto, inbound.state, inbound.language);

  let acoes: WhatsAppIntent[];

  if (intentDeterministica.intent !== 'unknown') {
    // Comando inequívoco — NUNCA chama a IA (regra obrigatória, W6.7).
    acoes = [intentDeterministica];
  } else {
    const acoesIa = await interpretWhatsAppMessageWithAI(
      { message: corpoTexto, language: inbound.language, state: inbound.state, sessionId: inbound.session_id },
      env
    ).catch(() => null);

    if (acoesIa === null) {
      // IA não configurada/indisponível/timeout/schema inválido — ZERO
      // mutação. Quando a Meta Send API existir (W6.8), este ramo deve
      // montar {handled:false, intent:'unknown', reason:'ai_unavailable'}
      // e chamar buildWhatsAppReply; hoje é só descartado, igual a todo
      // o resto do pipeline de dispatch (sem envio ainda).
      return { ok: true };
    }

    acoes = acoesIa;
  }

  // Resultado computado e descartado nesta etapa — sem Meta Send API
  // ainda (W6.8). .catch defensivo extra: dispatchWhatsAppActions já
  // isola falha de RPC internamente, mas nenhuma falha de dispatch
  // pode propagar e virar {ok:false} depois da persistência bem-sucedida.
  await dispatchWhatsAppActions(acoes, {
    env,
    sessionId: inbound.session_id,
    state: inbound.state,
  }).catch(() => undefined);

  return { ok: true };
}

// POST real do webhook. A ordem (env → corpo bruto → assinatura → parse)
// é obrigatória: nunca processa payload sem assinatura validada contra o
// corpo bruto exato (nunca um corpo re-serializado). Múltiplas mensagens
// no mesmo evento são processadas sequencialmente (nunca Promise.all) —
// mais simples de raciocinar/depurar pro volume esperado (webhooks da
// Meta normalmente trazem 1 mensagem por evento), e evita disparar N
// chamadas concorrentes à mesma RPC sem necessidade. Se alguma mensagem
// falhar, a função ainda tenta processar as demais (maximiza o que fica
// persistido nesta entrega) e só então devolve 500 pra Meta reenviar o
// lote inteiro — reenvio do lote é seguro mesmo pras mensagens que já
// foram persistidas com sucesso, porque record_whatsapp_inbound_message
// é idempotente por provider_message_id (viram duplicate:true, sem
// efeito colateral).
async function tratarWebhookPost(request: Request, env: Env): Promise<Response> {
  if (!env.META_APP_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Configuração do servidor ausente.' }, 500);
  }

  let corpoBytes: ArrayBuffer;
  try {
    corpoBytes = await request.arrayBuffer();
  } catch {
    return jsonResponse({ error: 'Não foi possível ler o corpo da requisição.' }, 400);
  }

  // Assinatura calculada sobre os bytes EXATOS recebidos, antes de
  // qualquer decodificação/parse — nunca sobre uma string re-encodada.
  const assinaturaValida = await validarAssinaturaMeta(request, corpoBytes, env.META_APP_SECRET);
  if (!assinaturaValida) {
    return jsonResponse({ error: 'Assinatura inválida.' }, 401);
  }

  const corpoBruto = new TextDecoder('utf-8').decode(corpoBytes);

  let payload: unknown;
  try {
    payload = corpoBruto ? JSON.parse(corpoBruto) : {};
  } catch {
    return jsonResponse({ error: 'JSON inválido.' }, 400);
  }

  const mensagens = extrairMensagensWhatsapp(payload);
  if (mensagens.length === 0) {
    // Evento sem messages (ex.: status de entrega/leitura) — não é erro.
    return jsonResponse({ ok: true }, 200);
  }

  let houveFalha = false;
  for (const item of mensagens) {
    const resultado = await processarMensagemWhatsapp(item, env);
    if (!resultado.ok) houveFalha = true;
  }

  if (houveFalha) {
    return jsonResponse({ error: 'Falha ao processar evento.' }, 500);
  }

  return jsonResponse({ ok: true }, 200);
}

// ---------------------------------------------------------------------
// W6.7D — POST /internal/whatsapp/ai-preview: endpoint TEMPORÁRIO de
// diagnóstico, criado só porque o Meta for Developers está bloqueado
// (verificação de conta) e precisamos testar a OpenAI real sem depender
// do webhook. Reutiliza EXATAMENTE interpretWhatsAppMessageWithAI (mesma
// função que o webhook real usa) — nunca chama dispatchWhatsAppIntent/
// dispatchWhatsAppActions nem nenhuma RPC mutante diretamente. Só devolve
// o preview das intents interpretadas, nunca executa nada. Remover esta
// seção (e o campo AI_TEST_TOKEN em Env) quando a Meta for desbloqueada e
// o W6.8 (envio real de resposta) existir.
// ---------------------------------------------------------------------

function validarTokenAiPreview(request: Request, env: Env): { ok: true } | { ok: false; response: Response } {
  if (!env.AI_TEST_TOKEN) {
    return { ok: false, response: jsonResponse({ error: 'Configuração do servidor ausente.' }, 500) };
  }

  // Só header — nunca query string. Token nunca é ecoado em nenhuma resposta.
  const token = request.headers.get('X-AI-Test-Token');
  if (!token || !compararEmTempoConstante(token, env.AI_TEST_TOKEN)) {
    return { ok: false, response: jsonResponse({ error: 'Não autorizado.' }, 401) };
  }

  return { ok: true };
}

interface PayloadAiPreview {
  message: string;
  language: WhatsAppLanguage;
  state: WhatsAppSessionState;
}

// Allowlist estrita: exatamente {message, language, state}. Qualquer campo
// fora disso (session_id, phone, customer_name, product_id, price, total,
// delivery_fee, order_id, rpc, sql, etc.) rejeita o payload inteiro — nunca
// ignora silenciosamente um campo desconhecido.
function validarPayloadAiPreview(corpo: unknown): PayloadAiPreview | null {
  if (typeof corpo !== 'object' || corpo === null) return null;

  const chaves = Object.keys(corpo as Record<string, unknown>);
  const chavesPermitidas = new Set(['message', 'language', 'state']);
  if (chaves.length !== 3 || chaves.some((k) => !chavesPermitidas.has(k))) return null;

  const d = corpo as Record<string, unknown>;
  if (typeof d.message !== 'string' || d.message.trim().length === 0) return null;
  if (d.language !== 'pt' && d.language !== 'en') return null;
  if (typeof d.state !== 'string' || !ESTADOS_WHATSAPP_VALIDOS.has(d.state as WhatsAppSessionState)) return null;

  return { message: d.message, language: d.language, state: d.state as WhatsAppSessionState };
}

// sessionId fictício/reservado (nunca gerado por gen_random_uuid()) — toda
// RPC do projeto segue o padrão "lock → valida existência → muta", então
// apply_whatsapp_cart_intent (chamada internamente por
// interpretWhatsAppMessageWithAI pra buscar o carrinho) levanta exceção pra
// sessão inexistente ANTES de qualquer leitura/mutação. chamarRpcWhatsapp
// devolve {ok:false} nesse caso, e interpretWhatsAppMessageWithAI já
// degrada pra carrinho vazio (comportamento existente, sem alteração em
// ai.ts) — carrinho vazio de verdade, zero sessão real tocada.
const SESSION_ID_DIAGNOSTICO_AI_PREVIEW = '00000000-0000-0000-0000-000000000000';

async function tratarAiPreviewWhatsapp(request: Request, env: Env): Promise<Response> {
  const auth = validarTokenAiPreview(request, env);
  if (!auth.ok) return auth.response;

  const leitura = await lerCorpoComLimite(request, 4 * 1024);
  if (!leitura.ok) return leitura.response;

  const payload = validarPayloadAiPreview(leitura.body);
  if (!payload) {
    return jsonResponse({ error: 'Payload inválido.' }, 400);
  }

  const acoes = await interpretWhatsAppMessageWithAI(
    {
      message: payload.message,
      language: payload.language,
      state: payload.state,
      sessionId: SESSION_ID_DIAGNOSTICO_AI_PREVIEW,
    },
    env
  ).catch(() => null);

  // null (IA indisponível/timeout/schema inválido) e [{intent:'unknown'}]
  // (IA respondeu mas não entendeu a mensagem) contam como o mesmo
  // resultado de diagnóstico "sem interpretação útil".
  if (acoes === null || (acoes.length === 1 && acoes[0].intent === 'unknown')) {
    return jsonResponse({ ok: false, reason: 'ai_unavailable_or_invalid' }, 200);
  }

  return jsonResponse({ ok: true, actions: acoes }, 200);
}

async function tratarRotaInternal(request: Request, env: Env, path: string): Promise<Response> {
  if (path !== '/internal/whatsapp/ai-preview') {
    return jsonResponse({ error: 'Rota não encontrada.' }, 404);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Método não permitido.' }, 405);
  }
  return tratarAiPreviewWhatsapp(request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/webhooks/')) {
      const respostaWebhook = await tratarRotaWebhook(request, env, path);
      return aplicarSecurityHeaders(respostaWebhook, { cspReportOnly: false });
    }

    if (path.startsWith('/internal/')) {
      const respostaInternal = await tratarRotaInternal(request, env, path);
      return aplicarSecurityHeaders(respostaInternal, { cspReportOnly: false });
    }

    if (!path.startsWith('/api/')) {
      const respostaAsset = await env.ASSETS.fetch(request);
      return aplicarSecurityHeaders(respostaAsset, { cspReportOnly: true });
    }

    const resposta = await tratarRotaApi(request, env, path);
    return aplicarSecurityHeaders(resposta, { cspReportOnly: false });
  },
};
