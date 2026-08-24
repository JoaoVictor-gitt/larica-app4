/*
 * coupons-service.js
 * Único arquivo que fala com o Supabase para cupons de desconto (tabela
 * coupons + RPC pública validate_coupon). Mapeia o formato relacional do
 * Supabase (inglês) pro formato pt-BR que o resto do app já usa. Depende de
 * js/supabase.js (supabaseClient), carregado antes deste arquivo.
 *
 * Sem função de exclusão — cupons nunca são apagados, só desativados
 * (active=false), pra preservar auditoria de pedidos antigos que já usaram
 * o cupom (snapshot em orders.coupon_code/discount_*).
 *
 * validarCupomNoSupabase() é a única função pensada pra rodar sem sessão
 * (cliente anônimo no checkout) — nunca consulta a tabela coupons
 * diretamente, só a RPC validate_coupon. As demais (listar/criar/atualizar)
 * dependem da RLS staff-only da tabela e só fazem sentido logado como staff.
 */

const COUPONS_COLUNAS =
  'id, code, name, discount_type, discount_value, active, starts_at, ends_at, minimum_order_value, created_at, updated_at';

function _linhaSupabaseParaCupom(linha) {
  return {
    id: linha.id,
    codigo: linha.code,
    nome: linha.name,
    tipoDesconto: linha.discount_type,
    valorDesconto: Number(linha.discount_value),
    ativo: linha.active,
    inicioEm: linha.starts_at,
    fimEm: linha.ends_at,
    valorMinimoPedido: linha.minimum_order_value === null ? null : Number(linha.minimum_order_value),
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

/** Forma da linha `coupons` a partir do objeto pt-BR — nunca inclui id/created_at/updated_at/created_by/updated_by. */
function _cupomParaLinhaSupabase(cupom) {
  return {
    code: (cupom.codigo || '').trim(),
    name: cupom.nome || null,
    discount_type: cupom.tipoDesconto,
    discount_value: Number(cupom.valorDesconto),
    active: !!cupom.ativo,
    starts_at: cupom.inicioEm || null,
    ends_at: cupom.fimEm || null,
    minimum_order_value: cupom.valorMinimoPedido === null || cupom.valorMinimoPedido === '' ? null : Number(cupom.valorMinimoPedido),
  };
}

/** Lista todos os cupons (staff only — RLS restringe). Ordenados por código. */
async function listarCuponsNoSupabase() {
  const { data, error } = await supabaseClient.from('coupons').select(COUPONS_COLUNAS).order('code', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaCupom);
}

/** Cria um cupom novo. O banco normaliza `code` (upper/trim) via trigger — o trim aqui é só UX. */
async function criarCupomNoSupabase(dados) {
  const linha = _cupomParaLinhaSupabase(dados);
  const { data, error } = await supabaseClient.from('coupons').insert(linha).select(COUPONS_COLUNAS).single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaCupom(data);
}

/**
 * Atualiza um cupom existente. Só envia os campos presentes em `dados`
 * (hasOwnProperty) — evita sobrescrever campos não enviados com `undefined`,
 * mesmo padrão usado em atualizarConfiguracoesNegocioNoSupabase().
 * updated_at/updated_by ficam por conta do trigger no banco.
 */
async function atualizarCupomNoSupabase(id, dados) {
  const linhaCompleta = _cupomParaLinhaSupabase(dados);
  const linha = {};
  if (Object.prototype.hasOwnProperty.call(dados, 'codigo')) linha.code = linhaCompleta.code;
  if (Object.prototype.hasOwnProperty.call(dados, 'nome')) linha.name = linhaCompleta.name;
  if (Object.prototype.hasOwnProperty.call(dados, 'tipoDesconto')) linha.discount_type = linhaCompleta.discount_type;
  if (Object.prototype.hasOwnProperty.call(dados, 'valorDesconto')) linha.discount_value = linhaCompleta.discount_value;
  if (Object.prototype.hasOwnProperty.call(dados, 'ativo')) linha.active = linhaCompleta.active;
  if (Object.prototype.hasOwnProperty.call(dados, 'inicioEm')) linha.starts_at = linhaCompleta.starts_at;
  if (Object.prototype.hasOwnProperty.call(dados, 'fimEm')) linha.ends_at = linhaCompleta.ends_at;
  if (Object.prototype.hasOwnProperty.call(dados, 'valorMinimoPedido')) linha.minimum_order_value = linhaCompleta.minimum_order_value;

  const { data, error } = await supabaseClient.from('coupons').update(linha).eq('id', id).select(COUPONS_COLUNAS).single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaCupom(data);
}

/**
 * Valida um código de cupom pro checkout (cliente anônimo) — L2.3H: chama
 * a rota /api/coupon do Worker (proxy pra RPC pública validate_coupon, com
 * rate limiting; sem Turnstile nesta rota), nunca consulta a tabela coupons
 * diretamente. A RPC continua a única fonte de verdade da validade/valor do
 * desconto; erro (cupom inválido/inativo/fora da janela de datas/abaixo do
 * mínimo) sempre vem como RAISE EXCEPTION no banco — nunca reimplementar
 * essas regras aqui. Sem fallback: se /api/coupon falhar, nunca cai de
 * volta pra chamar a RPC direto.
 */
async function validarCupomNoSupabase(codigo, subtotal) {
  const resposta = await fetch('/api/coupon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: codigo, subtotal: subtotal }),
  });
  const corpo = await resposta.json().catch(() => null);

  if (!resposta.ok) {
    throw new Error(_mensagemErroRotaApiCoupon(resposta.status, corpo));
  }

  const data = corpo;
  return {
    valido: data.valid,
    cupomId: data.coupon_id,
    codigo: data.code,
    tipoDesconto: data.discount_type,
    valorDesconto: Number(data.discount_value),
    valorDescontoCalculado: Number(data.discount_amount),
  };
}

/** Mapeia status HTTP de /api/coupon pra mensagem amigável — preserva mensagem de negócio do Supabase quando houver. */
function _mensagemErroRotaApiCoupon(status, corpo) {
  if (status === 403) return 'Não foi possível validar a verificação de segurança. Tente novamente.';
  if (status === 429) return 'Muitas tentativas. Aguarde alguns instantes e tente novamente.';
  if (status === 502 || status === 503) return 'Serviço temporariamente indisponível. Tente novamente.';
  if (corpo && typeof corpo.message === 'string') return corpo.message;
  if (corpo && typeof corpo.error === 'string') return corpo.error;
  return 'Não foi possível completar a operação. Tente novamente.';
}
