/*
 * settings-service.js
 * Fala com o Supabase para public.business_settings (linha única, id=1) e
 * public.business_hours (7 linhas, day_of_week 0=domingo...6=sábado).
 * Mapeia pro formato pt-BR usado pelo resto do app. Sem fallback silencioso
 * — erro sobe pra quem chamou. updated_at/updated_by são geridos por
 * trigger no banco (set_updated_metadata), nunca enviados daqui.
 * Depende de js/supabase.js (supabaseClient).
 */

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

// Listas explícitas das colunas com GRANT de SELECT pra anon/authenticated — nunca '*'/select() vazio,
// que pediriam também `updated_by` (sem grant público) e derrubariam a consulta inteira.
const BUSINESS_SETTINGS_COLUNAS_PUBLICAS =
  'id, orders_enabled, closed_message, delivery_enabled, collection_enabled, delivery_minimum_fee, delivery_minimum_distance_km, delivery_price_per_km, delivery_max_distance_km, delivery_origin_lat, delivery_origin_lng, timezone, updated_at, revolut_enabled, revolut_qr_path, revolut_payment_code';
const BUSINESS_HOURS_COLUNAS_PUBLICAS = 'day_of_week, enabled, opening_time, closing_time, updated_at';

function _linhaSupabaseParaConfiguracaoNegocio(linha) {
  return {
    pedidosAtivos: linha.orders_enabled,
    mensagemFechado: linha.closed_message || '',
    entregaAtiva: linha.delivery_enabled,
    retiradaAtiva: linha.collection_enabled,
    entregaTaxaMinima: Number(linha.delivery_minimum_fee) || 0,
    entregaDistanciaMinimaKm: Number(linha.delivery_minimum_distance_km) || 0,
    entregaPrecoPorKm: Number(linha.delivery_price_per_km) || 0,
    entregaDistanciaMaximaKm: linha.delivery_max_distance_km === null ? null : Number(linha.delivery_max_distance_km),
    entregaOrigemLat: Number(linha.delivery_origin_lat),
    entregaOrigemLng: Number(linha.delivery_origin_lng),
    fusoHorario: linha.timezone,
    atualizadoEm: linha.updated_at,
    revolutAtivo: linha.revolut_enabled,
    revolutQrPath: linha.revolut_qr_path,
    revolutPaymentCode: linha.revolut_payment_code || '',
  };
}

/** Busca a linha única de configurações de negócio (id=1) */
async function buscarConfiguracoesNegocioDoSupabase() {
  const { data, error } = await supabaseClient.from('business_settings').select(BUSINESS_SETTINGS_COLUNAS_PUBLICAS).eq('id', 1).single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaConfiguracaoNegocio(data);
}

/**
 * Atualiza a linha única de configurações de negócio (id=1). Nunca envia
 * updated_at/updated_by — isso é responsabilidade do trigger no banco.
 *
 * revolutAtivo/revolutQrPath/revolutPaymentCode só entram no UPDATE quando a própria
 * chamada os inclui explicitamente em `config` (via hasOwnProperty) — os 2 formulários
 * existentes de Configurações (Pedidos online / Entrega e retirada) nunca os enviam, e
 * se eles fossem tratados como os demais campos (sempre incondicionais), qualquer
 * salvamento desses formulários apagaria silenciosamente o QR/código Revolut já
 * cadastrados (undefined vira false/null). Assim o Revolut só muda quando alguém
 * realmente pede pra mudar.
 */
async function atualizarConfiguracoesNegocioNoSupabase(config) {
  const linha = {
    orders_enabled: !!config.pedidosAtivos,
    closed_message: config.mensagemFechado || '',
    delivery_enabled: !!config.entregaAtiva,
    collection_enabled: !!config.retiradaAtiva,
    delivery_minimum_fee: Math.max(0, Number(config.entregaTaxaMinima) || 0),
    delivery_minimum_distance_km: Math.max(0, Number(config.entregaDistanciaMinimaKm) || 0),
    delivery_price_per_km: Math.max(0, Number(config.entregaPrecoPorKm) || 0),
    delivery_max_distance_km:
      config.entregaDistanciaMaximaKm === null || config.entregaDistanciaMaximaKm === ''
        ? null
        : Math.max(0, Number(config.entregaDistanciaMaximaKm) || 0),
  };
  if (Object.prototype.hasOwnProperty.call(config, 'revolutAtivo')) {
    linha.revolut_enabled = !!config.revolutAtivo;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'revolutQrPath')) {
    linha.revolut_qr_path = config.revolutQrPath || null;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'revolutPaymentCode')) {
    linha.revolut_payment_code = config.revolutPaymentCode || null;
  }
  const { data, error } = await supabaseClient
    .from('business_settings')
    .update(linha)
    .eq('id', 1)
    .select(BUSINESS_SETTINGS_COLUNAS_PUBLICAS)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaConfiguracaoNegocio(data);
}

// ---------------------------------------------------------------------------
// QR Code Revolut (Fase 10A) — Supabase Storage, bucket business-assets
// ---------------------------------------------------------------------------

const REVOLUT_QR_BUCKET = 'business-assets';
const REVOLUT_QR_MIME_PARA_EXTENSAO = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const REVOLUT_QR_TAMANHO_MAXIMO_BYTES = 2 * 1024 * 1024; // 2 MB — espelha o file_size_limit do bucket; a proteção real é o bucket/policy no banco

/**
 * Envia um novo QR Code do Revolut pro Storage — nunca sobrescreve/apaga o anterior, sempre gera um
 * path novo (cache-busting real por URL diferente). Extensão vem do MIME real do arquivo, nunca do
 * nome original. Retorna só o path (não a URL) — quem chama decide quando/como persistir em
 * business_settings, via atualizarConfiguracoesNegocioNoSupabase({ revolutQrPath: path, ... }).
 */
async function uploadQrRevolut(file) {
  if (!file) throw new Error('Selecione um arquivo de imagem.');

  const extensao = REVOLUT_QR_MIME_PARA_EXTENSAO[file.type];
  if (!extensao) throw new Error('Formato de imagem inválido. Envie PNG, JPEG ou WEBP.');

  if (file.size > REVOLUT_QR_TAMANHO_MAXIMO_BYTES) throw new Error('A imagem precisa ter no máximo 2 MB.');

  const path = `revolut/qr-${Date.now()}.${extensao}`;

  const { error } = await supabaseClient.storage
    .from(REVOLUT_QR_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);

  return path;
}

/** URL pública do QR Revolut a partir do path salvo em business_settings.revolut_qr_path — sem query, sem download, nunca signed URL. */
function getUrlPublicaQrRevolut(path) {
  if (!path) return null;
  const { data } = supabaseClient.storage.from(REVOLUT_QR_BUCKET).getPublicUrl(path);
  return (data && data.publicUrl) || null;
}

function _linhaSupabaseParaHorario(linha) {
  return {
    diaSemana: linha.day_of_week,
    rotuloDia: DIAS_SEMANA[linha.day_of_week],
    ativo: linha.enabled,
    horaAbertura: linha.opening_time,
    horaFechamento: linha.closing_time,
    atualizadoEm: linha.updated_at,
  };
}

/** Busca as 7 linhas de horário de funcionamento, ordenadas por dia (0=domingo...6=sábado) */
async function buscarHorariosFuncionamentoDoSupabase() {
  const { data, error } = await supabaseClient
    .from('business_hours')
    .select(BUSINESS_HOURS_COLUNAS_PUBLICAS)
    .order('day_of_week', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaHorario);
}

/**
 * Atualiza a linha de um dia da semana. Quando ativo=false, força
 * horaAbertura/horaFechamento para null (a constraint do banco exige
 * isso — resolvendo aqui evita um round-trip de erro desnecessário).
 */
async function atualizarHorarioFuncionamentoNoSupabase(diaSemana, { ativo, horaAbertura, horaFechamento }) {
  const linha = {
    enabled: !!ativo,
    opening_time: ativo ? horaAbertura || null : null,
    closing_time: ativo ? horaFechamento || null : null,
  };
  const { data, error } = await supabaseClient
    .from('business_hours')
    .update(linha)
    .eq('day_of_week', diaSemana)
    .select(BUSINESS_HOURS_COLUNAS_PUBLICAS)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaHorario(data);
}
