// Fase B — leitura automática (OCR + IA) de notas fiscais de compra.
//
// Fluxo: o navegador (admin logado) já enviou a foto/PDF para o bucket privado
// 'purchase-documents' e registrou o documento (RPC register_purchase_document).
// Esta rota recebe só { document_id }, confere que quem chama é admin (com o JWT do
// próprio usuário), baixa o arquivo com a service role, pede a leitura à IA (Gemini
// se GEMINI_API_KEY estiver configurada; senão OpenAI) e
// grava o resultado em purchase_documents (RPC record_purchase_document_ocr).
//
// Nada é registrado como compra aqui: o resultado é só uma proposta que o usuário
// confere e corrige antes de confirmar (confirm_purchase). Campos ilegíveis voltam
// null — o prompt e a validação proíbem inventar valores.
//
// Nenhum segredo sai do Worker; erros da OpenAI/Supabase nunca são repassados crus.

export interface PurchaseOcrEnv {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  OPENAI_OCR_MODEL?: string;
  // Google Gemini (plano gratuito do AI Studio). Com GEMINI_API_KEY presente, a leitura
  // de notas usa o Gemini; sem ela, continua na OpenAI.
  GEMINI_API_KEY?: string;
  GEMINI_OCR_MODEL?: string;
}

export const GEMINI_MODELO_PADRAO = 'gemini-3.5-flash-lite';
const MODELO_RE = /^[A-Za-z0-9._-]{1,80}$/;

type Ia = { provedor: 'gemini' | 'openai'; modelo: string };

export function escolherIa(env: PurchaseOcrEnv): Ia | null {
  if (env.GEMINI_API_KEY) return { provedor: 'gemini', modelo: env.GEMINI_OCR_MODEL || GEMINI_MODELO_PADRAO };
  const modelo = env.OPENAI_OCR_MODEL || env.OPENAI_MODEL;
  if (env.OPENAI_API_KEY && modelo) return { provedor: 'openai', modelo };
  return null;
}

type Leitura = { ok: true; nota: NotaLida } | { ok: false; motivo: string };

// Converte o texto devolvido pela IA em nota validada (aceita cercas ```json por segurança).
function interpretarTextoNota(texto: string): Leitura {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let bruto: unknown;
  try {
    bruto = JSON.parse(limpo);
  } catch {
    return { ok: false, motivo: 'A IA não devolveu uma leitura válida.' };
  }
  const nota = validarNotaLida(bruto);
  return nota ? { ok: true, nota } : { ok: false, motivo: 'A IA não devolveu uma leitura válida.' };
}

async function postarComPrazo(url: string, headers: Record<string, string>, body: string): Promise<Response | null> {
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), 60000);
  try {
    return await fetch(url, { method: 'POST', headers, body, signal: controlador.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function chamarGeminiNota(env: PurchaseOcrEnv, mime: string, base64: string, modelo: string): Promise<Leitura> {
  if (!MODELO_RE.test(modelo)) return { ok: false, motivo: 'Nome de modelo do Gemini inválido em GEMINI_OCR_MODEL.' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  // A chave vai no cabeçalho (nunca na URL, para não aparecer em logs).
  const headers = { 'x-goog-api-key': env.GEMINI_API_KEY || '', 'Content-Type': 'application/json' };
  const montar = (comEsquema: boolean) => JSON.stringify({
    systemInstruction: { parts: [{ text: PROMPT_SISTEMA }] },
    contents: [{
      role: 'user',
      parts: [
        { text: comEsquema ? 'Leia esta nota de compra.' : `Leia esta nota de compra. Responda só com um JSON exatamente neste esquema: ${JSON.stringify(ESQUEMA_NOTA)}` },
        { inlineData: { mimeType: mime, data: base64 } },
      ],
    }],
    generationConfig: comEsquema
      ? { responseMimeType: 'application/json', responseJsonSchema: ESQUEMA_NOTA }
      : { responseMimeType: 'application/json' },
  });

  let r = await postarComPrazo(url, headers, montar(true));
  if (!r) return { ok: false, motivo: 'A leitura demorou demais ou a IA está indisponível.' };
  let corpoErro = '';
  if (r.status === 400) {
    corpoErro = await r.text().catch(() => '');
    // Se o modelo não aceitar o esquema, tenta de novo pedindo o JSON pelo texto
    // (a validação abaixo continua descartando qualquer coisa fora do formato).
    if (/schema/i.test(corpoErro) && !/api.?key/i.test(corpoErro)) {
      r = await postarComPrazo(url, headers, montar(false));
      if (!r) return { ok: false, motivo: 'A leitura demorou demais ou a IA está indisponível.' };
      corpoErro = '';
    }
  }

  if (!r.ok) {
    if (!corpoErro) corpoErro = await r.text().catch(() => '');
    // Só a classificação do erro é usada; o corpo nunca é repassado.
    if (r.status === 401 || (r.status === 400 && /api.?key/i.test(corpoErro))) {
      return { ok: false, motivo: 'A chave do Gemini (GEMINI_API_KEY no Worker) foi recusada. Confira o valor no Cloudflare.' };
    }
    if (r.status === 403) {
      return { ok: false, motivo: 'O Google recusou a chave do Gemini (chave inválida, bloqueada ou projeto precisando de verificação em aistudio.google.com).' };
    }
    if (r.status === 404) {
      return { ok: false, motivo: `O modelo "${modelo}" não existe ou não está disponível para esta chave. Configure GEMINI_OCR_MODEL no Cloudflare.` };
    }
    if (r.status === 429) {
      return { ok: false, motivo: 'Limite gratuito do Gemini atingido (por minuto ou por dia). Aguarde um pouco e tente de novo.' };
    }
    if (r.status === 400 && /mime|unsupported|inline/i.test(corpoErro)) {
      return { ok: false, motivo: 'O Gemini não aceitou este tipo de arquivo. Tente uma foto JPG/PNG.' };
    }
    if (r.status >= 500) return { ok: false, motivo: 'O Gemini está indisponível no momento. Tente de novo em instantes.' };
    return { ok: false, motivo: 'A IA não conseguiu processar o documento.' };
  }

  const corpo = await r.json().catch(() => null) as {
    promptFeedback?: { blockReason?: unknown };
    candidates?: Array<{ finishReason?: unknown; content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
  } | null;
  if (corpo?.promptFeedback?.blockReason) return { ok: false, motivo: 'O Gemini recusou ler este documento.' };
  const candidato = corpo?.candidates?.[0];
  const fim = candidato?.finishReason;
  if (fim === 'MAX_TOKENS') return { ok: false, motivo: 'A nota é longa demais para a leitura automática.' };
  const texto = (candidato?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('');
  if (!texto) {
    return { ok: false, motivo: fim && fim !== 'STOP' ? 'O Gemini recusou ler este documento.' : 'A IA não devolveu uma leitura válida.' };
  }
  return interpretarTextoNota(texto);
}

export const LIMITE_ARQUIVO_OCR = 10 * 1024 * 1024;
const UNIDADES = ['g', 'kg', 'ml', 'l', 'un'] as const;
const TAXAS_VAT = [0, 9, 13.5, 23];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMINHO_RE = /^uploads\/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/;

export interface ItemLido {
  description: string;
  quantity: number | null;
  unit: (typeof UNIDADES)[number] | null;
  unit_price: number | null;
  discount: number | null;
  line_total: number | null;
  line_total_includes_vat: boolean | null;
  vat_rate: number | null;
}

export interface NotaLida {
  legible: boolean;
  supplier_name: string | null;
  document_number: string | null;
  document_date: string | null;
  currency: string | null;
  items: ItemLido[];
  discount_total: number | null;
  subtotal: number | null;
  vat_breakdown: Array<{ rate: number | null; base: number | null; vat: number | null }>;
  vat_total: number | null;
  total_paid: number | null;
  warnings: string[];
}

const NUM_OU_NULL = { type: ['number', 'null'] };
const TXT_OU_NULL = { type: ['string', 'null'] };

export const ESQUEMA_NOTA = {
  type: 'object',
  additionalProperties: false,
  required: ['legible', 'supplier_name', 'document_number', 'document_date', 'currency', 'items',
    'discount_total', 'subtotal', 'vat_breakdown', 'vat_total', 'total_paid', 'warnings'],
  properties: {
    legible: { type: 'boolean' },
    supplier_name: TXT_OU_NULL,
    document_number: TXT_OU_NULL,
    document_date: TXT_OU_NULL,
    currency: TXT_OU_NULL,
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit', 'unit_price', 'discount', 'line_total', 'line_total_includes_vat', 'vat_rate'],
        properties: {
          description: { type: 'string' },
          quantity: NUM_OU_NULL,
          unit: { type: ['string', 'null'], enum: [...UNIDADES, null] },
          unit_price: NUM_OU_NULL,
          discount: NUM_OU_NULL,
          line_total: NUM_OU_NULL,
          line_total_includes_vat: { type: ['boolean', 'null'] },
          vat_rate: NUM_OU_NULL,
        },
      },
    },
    discount_total: NUM_OU_NULL,
    subtotal: NUM_OU_NULL,
    vat_breakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rate', 'base', 'vat'],
        properties: { rate: NUM_OU_NULL, base: NUM_OU_NULL, vat: NUM_OU_NULL },
      },
    },
    vat_total: NUM_OU_NULL,
    total_paid: NUM_OU_NULL,
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const PROMPT_SISTEMA = [
  'Você lê notas fiscais e recibos de compra de um restaurante na Irlanda e devolve os dados em JSON.',
  'Regras obrigatórias:',
  '- Transcreva SOMENTE o que está visível no documento. Nunca invente, estime ou complete valores.',
  '- Qualquer campo ilegível, cortado ou ausente deve ser null. Explique em "warnings" o que não foi possível ler.',
  '- Se o documento não for uma nota/recibo de compra ou estiver ilegível, use legible=false e items vazio.',
  '- description: o texto do item exatamente como aparece (sem traduzir).',
  '- quantity/unit: a quantidade comprada e a unidade; use g, kg, ml, l ou un (un para unidades, caixas, pacotes). Se a unidade não estiver clara, unit=null.',
  '- unit_price: preço por unidade como impresso. line_total: valor total da linha como impresso.',
  '- line_total_includes_vat: true se o total da linha já inclui VAT, false se é sem VAT, null se não for possível saber.',
  '- vat_rate: a taxa de VAT da linha em % (na Irlanda normalmente 0, 9, 13.5 ou 23). null se não constar.',
  '- discount: desconto da linha em valor (positivo). discount_total: desconto geral da nota (positivo).',
  '- document_date no formato YYYY-MM-DD. Valores monetários como número, com ponto decimal, sem símbolo de moeda.',
  '- total_paid: o total efetivamente pago/cobrado da nota.',
].join('\n');

function numeroOuNull(v: unknown, opts: { min?: number; max?: number } = {}): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (opts.min !== undefined && v < opts.min) return null;
  if (opts.max !== undefined && v > opts.max) return null;
  return Math.round(v * 10000) / 10000;
}

function textoOuNull(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function dataOuNull(v: unknown): string | null {
  const t = textoOuNull(v, 10);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(t + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) return null;
  return t;
}

// Valida e limpa a saída da IA: tudo que não estiver no formato esperado vira null,
// nunca um valor "consertado". Retorna null se o envelope inteiro for inválido.
export function validarNotaLida(bruto: unknown): NotaLida | null {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  if (typeof o.legible !== 'boolean' || !Array.isArray(o.items)) return null;

  const itens: ItemLido[] = [];
  for (const it of o.items.slice(0, 200)) {
    if (!it || typeof it !== 'object') continue;
    const i = it as Record<string, unknown>;
    const descricao = textoOuNull(i.description, 300);
    if (!descricao) continue;
    const unidade = typeof i.unit === 'string' && (UNIDADES as readonly string[]).includes(i.unit.toLowerCase())
      ? (i.unit.toLowerCase() as ItemLido['unit']) : null;
    const taxa = numeroOuNull(i.vat_rate, { min: 0, max: 100 });
    itens.push({
      description: descricao,
      quantity: numeroOuNull(i.quantity, { min: 0.0001, max: 1e9 }),
      unit: unidade,
      unit_price: numeroOuNull(i.unit_price, { min: 0, max: 1e7 }),
      discount: numeroOuNull(i.discount, { min: 0, max: 1e7 }),
      line_total: numeroOuNull(i.line_total, { min: 0, max: 1e8 }),
      line_total_includes_vat: typeof i.line_total_includes_vat === 'boolean' ? i.line_total_includes_vat : null,
      vat_rate: taxa !== null && TAXAS_VAT.includes(taxa) ? taxa : null,
    });
  }

  const quebra = Array.isArray(o.vat_breakdown) ? o.vat_breakdown.slice(0, 10) : [];
  const avisos = Array.isArray(o.warnings) ? o.warnings.map((w) => textoOuNull(w, 300)).filter((w): w is string => !!w).slice(0, 20) : [];

  const moeda = textoOuNull(o.currency, 3);
  return {
    legible: o.legible,
    supplier_name: textoOuNull(o.supplier_name, 120),
    document_number: textoOuNull(o.document_number, 80),
    document_date: dataOuNull(o.document_date),
    currency: moeda ? moeda.toUpperCase() : null,
    items: o.legible ? itens : [],
    discount_total: numeroOuNull(o.discount_total, { min: 0, max: 1e8 }),
    subtotal: numeroOuNull(o.subtotal, { min: 0, max: 1e8 }),
    vat_breakdown: quebra
      .filter((v) => v && typeof v === 'object')
      .map((v) => {
        const x = v as Record<string, unknown>;
        const r = numeroOuNull(x.rate, { min: 0, max: 100 });
        return { rate: r !== null && TAXAS_VAT.includes(r) ? r : null, base: numeroOuNull(x.base, { min: 0 }), vat: numeroOuNull(x.vat, { min: 0 }) };
      }),
    vat_total: numeroOuNull(o.vat_total, { min: 0, max: 1e8 }),
    total_paid: numeroOuNull(o.total_paid, { min: 0, max: 1e8 }),
    warnings: avisos,
  };
}

export function arrayBufferParaBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const passo = 0x8000;
  for (let i = 0; i < bytes.length; i += passo) {
    bin += String.fromCharCode(...bytes.subarray(i, i + passo));
  }
  return btoa(bin);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Resultado<T> = { ok: true; value: T } | { ok: false; response: Response };

// Confere com o JWT do próprio usuário (nunca com a service role) que ele é admin ativo.
async function exigirAdmin(request: Request, env: PurchaseOcrEnv): Promise<Resultado<null>> {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(auth);
  if (!m) return { ok: false, response: json({ error: 'Faça login novamente.' }, 401) };
  let r: Response;
  try {
    r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: { 'apikey': env.SUPABASE_PUBLISHABLE_KEY, 'Authorization': `Bearer ${m[1]}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    return { ok: false, response: json({ error: 'Falha ao verificar o acesso.' }, 502) };
  }
  if (r.status === 401) return { ok: false, response: json({ error: 'Sessão expirada. Faça login novamente.' }, 401) };
  const corpo = await r.json().catch(() => null);
  if (!r.ok || corpo !== true) return { ok: false, response: json({ error: 'Apenas administradores podem ler notas.' }, 403) };
  return { ok: true, value: null };
}

// Cabeçalhos da chave de serviço. Chave nova do Supabase ("sb_secret_...") não é JWT:
// vai só no cabeçalho apikey (mandá-la como Authorization: Bearer faz o Supabase
// responder 401). Chave antiga (JWT service_role) continua indo nos dois.
export function cabecalhosServico(env: PurchaseOcrEnv): Record<string, string> {
  const chave = env.SUPABASE_SERVICE_ROLE_KEY;
  return chave.startsWith('sb_') ? { 'apikey': chave } : { 'apikey': chave, 'Authorization': `Bearer ${chave}` };
}

const ERRO_CHAVE_SERVICO = 'Configuração do servidor: a chave de serviço do Supabase (SUPABASE_SERVICE_ROLE_KEY no Worker) foi recusada. Confira o valor no Cloudflare.';

async function chamarRpcServico(env: PurchaseOcrEnv, nome: string, args: unknown): Promise<Response> {
  return fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { ...cabecalhosServico(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

async function registrarStatus(env: PurchaseOcrEnv, id: string, status: 'processing' | 'done' | 'failed', resultado: NotaLida | null, modelo: string | null, erro: string | null): Promise<void> {
  try {
    const r = await chamarRpcServico(env, 'record_purchase_document_ocr', {
      p_document_id: id, p_status: status, p_result: resultado, p_model: modelo, p_error: erro,
    });
    await r.text().catch(() => undefined);
  } catch {
    // o status é informativo; a resposta ao usuário já carrega o resultado
  }
}

export async function chamarOpenAiNota(env: PurchaseOcrEnv, mime: string, base64: string, modelo: string): Promise<{ ok: true; nota: NotaLida } | { ok: false; motivo: string }> {
  const conteudoArquivo = mime === 'application/pdf'
    ? { type: 'file', file: { filename: 'nota.pdf', file_data: `data:application/pdf;base64,${base64}` } }
    : { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } };

  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), 60000);
  let r: Response;
  try {
    r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelo,
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user', content: [{ type: 'text', text: 'Leia esta nota de compra.' }, conteudoArquivo] },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'nota_compra', strict: true, schema: ESQUEMA_NOTA } },
      }),
      signal: controlador.signal,
    });
  } catch {
    return { ok: false, motivo: 'A leitura demorou demais ou a IA está indisponível.' };
  } finally {
    clearTimeout(timeout);
  }

  if (!r.ok) {
    const corpoErro = await r.text().catch(() => '');
    // Só a classificação do erro é usada; o corpo nunca é repassado.
    if (r.status === 400 && /image|file|vision|modalit|support/i.test(corpoErro)) {
      return { ok: false, motivo: 'O modelo de IA configurado não aceita imagens/PDF. Configure OPENAI_OCR_MODEL com um modelo com visão.' };
    }
    if (r.status === 429 && /insufficient_quota|billing|exceeded your current quota/i.test(corpoErro)) {
      return { ok: false, motivo: 'A conta da OpenAI está sem créditos (insufficient_quota). Adicione créditos ou uma forma de pagamento em platform.openai.com → Billing.' };
    }
    if (r.status === 429) return { ok: false, motivo: 'Muitas leituras seguidas na OpenAI (limite por minuto). Aguarde um pouco e tente de novo.' };
    if (r.status === 401) return { ok: false, motivo: 'A chave da OpenAI (OPENAI_API_KEY no Worker) foi recusada. Confira o valor no Cloudflare.' };
    return { ok: false, motivo: 'A IA não conseguiu processar o documento.' };
  }

  const corpo = await r.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> } | null;
  const conteudo = corpo?.choices?.[0]?.message?.content;
  if (typeof conteudo !== 'string') return { ok: false, motivo: 'A IA não devolveu uma leitura válida.' };
  let bruto: unknown;
  try {
    bruto = JSON.parse(conteudo);
  } catch {
    return { ok: false, motivo: 'A IA não devolveu uma leitura válida.' };
  }
  const nota = validarNotaLida(bruto);
  if (!nota) return { ok: false, motivo: 'A IA não devolveu uma leitura válida.' };
  return { ok: true, nota };
}

export async function tratarOcrCompra(request: Request, env: PurchaseOcrEnv, corpo: unknown): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Configuração do servidor ausente.' }, 500);
  }
  const ia = escolherIa(env);
  if (!ia) {
    return json({ error: 'Leitura automática indisponível: a IA não está configurada. Preencha a compra manualmente.', code: 'ocr_unavailable' }, 503);
  }

  const admin = await exigirAdmin(request, env);
  if (!admin.ok) return admin.response;

  const documentId = (corpo as { document_id?: unknown } | null)?.document_id;
  if (typeof documentId !== 'string' || !UUID_RE.test(documentId)) {
    return json({ error: 'Documento inválido.' }, 400);
  }

  let doc: { id: string; storage_path: string; mime_type: string; size_bytes: number } | undefined;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/purchase_documents?id=eq.${documentId}&select=id,storage_path,mime_type,size_bytes`, {
      headers: cabecalhosServico(env),
    });
    if (r.status === 401 || r.status === 403) {
      await r.text().catch(() => undefined);
      return json({ error: ERRO_CHAVE_SERVICO, code: 'service_key_rejected' }, 500);
    }
    if (!r.ok) {
      await r.text().catch(() => undefined);
      return json({ error: 'Falha ao buscar o documento.' }, 502);
    }
    const linhas = await r.json() as Array<typeof doc>;
    doc = linhas[0];
  } catch {
    return json({ error: 'Falha ao buscar o documento.' }, 502);
  }
  if (!doc) return json({ error: 'Documento não encontrado.' }, 404);
  if (!CAMINHO_RE.test(doc.storage_path) || doc.size_bytes > LIMITE_ARQUIVO_OCR) {
    return json({ error: 'Documento inválido.' }, 400);
  }

  const modelo = ia.modelo;
  await registrarStatus(env, doc.id, 'processing', null, modelo, null);

  let arquivo: ArrayBuffer;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/purchase-documents/${doc.storage_path}`, {
      headers: cabecalhosServico(env),
    });
    if (r.status === 401 || r.status === 403) {
      await r.text().catch(() => undefined);
      return json({ error: ERRO_CHAVE_SERVICO, code: 'service_key_rejected' }, 500);
    }
    if (!r.ok) {
      await r.text().catch(() => undefined);
      await registrarStatus(env, doc.id, 'failed', null, modelo, 'arquivo indisponível');
      return json({ error: 'Arquivo do documento não encontrado.' }, 404);
    }
    arquivo = await r.arrayBuffer();
  } catch {
    await registrarStatus(env, doc.id, 'failed', null, modelo, 'falha ao baixar');
    return json({ error: 'Falha ao baixar o documento.' }, 502);
  }
  if (arquivo.byteLength === 0 || arquivo.byteLength > LIMITE_ARQUIVO_OCR) {
    await registrarStatus(env, doc.id, 'failed', null, modelo, 'tamanho inválido');
    return json({ error: 'Arquivo vazio ou grande demais (máx. 10 MB).' }, 400);
  }

  const base64 = arrayBufferParaBase64(arquivo);
  const leitura = ia.provedor === 'gemini'
    ? await chamarGeminiNota(env, doc.mime_type, base64, modelo)
    : await chamarOpenAiNota(env, doc.mime_type, base64, modelo);
  if (!leitura.ok) {
    await registrarStatus(env, doc.id, 'failed', null, modelo, leitura.motivo);
    return json({ error: `${leitura.motivo} Você pode preencher a compra manualmente.` }, 502);
  }

  await registrarStatus(env, doc.id, 'done', leitura.nota, modelo, null);
  return json({ ok: true, document_id: doc.id, model: modelo, result: leitura.nota }, 200);
}
