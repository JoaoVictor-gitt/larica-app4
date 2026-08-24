// Worker/API proxy — L2.3F + L2.3G (rate limit + Turnstile).
//
// Intercepta só /api/* (via assets.run_worker_first em wrangler.jsonc).
// Todo o resto (HTML/CSS/JS) continua servido direto pelos Static Assets,
// sem passar por este arquivo.
//
// Nenhuma URL é montada a partir de input do cliente: os 3 destinos abaixo
// são sempre caminhos fixos sob SUPABASE_URL — não existe proxy genérico.

interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

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
  },
};
