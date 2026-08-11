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
  };
}

/** Busca a linha única de configurações de negócio (id=1) */
async function buscarConfiguracoesNegocioDoSupabase() {
  const { data, error } = await supabaseClient.from('business_settings').select('*').eq('id', 1).single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaConfiguracaoNegocio(data);
}

/**
 * Atualiza a linha única de configurações de negócio (id=1). Nunca envia
 * updated_at/updated_by — isso é responsabilidade do trigger no banco.
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
  const { data, error } = await supabaseClient.from('business_settings').update(linha).eq('id', 1).select().single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaConfiguracaoNegocio(data);
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
  const { data, error } = await supabaseClient.from('business_hours').select('*').order('day_of_week', { ascending: true });
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
  const { data, error } = await supabaseClient.from('business_hours').update(linha).eq('day_of_week', diaSemana).select().single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaHorario(data);
}
