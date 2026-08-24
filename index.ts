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

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  WHATSAPP_VERIFY_TOKEN: string;
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
// do arquivo pras rotas /api/*. POST retorna 501 nesta etapa: o
// recebimento de eventos reais (verificação de assinatura, dedup,
// sessão) é escopo de uma etapa futura — 501 explícito evita que um
// evento real da Meta seja processado incorretamente antes disso existir.
async function tratarRotaWebhook(request: Request, env: Env, path: string): Promise<Response> {
  if (path !== '/webhooks/whatsapp') {
    return jsonResponse({ error: 'Rota não encontrada.' }, 404);
  }

  if (request.method === 'GET') {
    return tratarHandshakeWhatsapp(request, env);
  }

  if (request.method === 'POST') {
    return jsonResponse({ error: 'Webhook ainda não implementado.' }, 501);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/webhooks/')) {
      const respostaWebhook = await tratarRotaWebhook(request, env, path);
      return aplicarSecurityHeaders(respostaWebhook, { cspReportOnly: false });
    }

    if (!path.startsWith('/api/')) {
      const respostaAsset = await env.ASSETS.fetch(request);
      return aplicarSecurityHeaders(respostaAsset, { cspReportOnly: true });
    }

    const resposta = await tratarRotaApi(request, env, path);
    return aplicarSecurityHeaders(resposta, { cspReportOnly: false });
  },
};
