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
  'id, orders_enabled, closed_message, delivery_enabled, collection_enabled, delivery_minimum_fee, delivery_minimum_distance_km, delivery_price_per_km, delivery_max_distance_km, delivery_origin_lat, delivery_origin_lng, timezone, updated_at, revolut_enabled, revolut_qr_path, revolut_payment_code, bank_transfer_enabled, bank_transfer_beneficiary, bank_transfer_iban, bank_transfer_bic';
const BUSINESS_HOURS_COLUNAS_PUBLICAS = 'day_of_week, enabled, opening_time, closing_time, updated_at';

// preparation_target_minutes (Tempo de Preparo, Etapa 3) — DELIBERADAMENTE fora de
// BUSINESS_SETTINGS_COLUNAS_PUBLICAS: essa lista é lida tanto pelo admin quanto pelo checkout público
// (js/pedido.js chama buscarConfiguracoesNegocioDoSupabase()), e a coluna não tem GRANT a anon (só
// authenticated, ver migration 20260817150000) — colocá-la na lista pública derrubaria a consulta
// inteira pro cliente anônimo. Por isso uma consulta própria, bem menor, usada só pelas páginas admin
// (Pedidos, Relatórios, Configurações) — nunca por pedido.html.
const BUSINESS_SETTINGS_COLUNA_META_PREPARO = 'id, preparation_target_minutes';

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
    transferenciaAtiva: linha.bank_transfer_enabled,
    transferenciaBeneficiario: linha.bank_transfer_beneficiary || '',
    transferenciaIban: linha.bank_transfer_iban || '',
    transferenciaBic: linha.bank_transfer_bic || '',
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
 * revolutAtivo/revolutQrPath/revolutPaymentCode (e, no mesmo esquema,
 * transferenciaAtiva/transferenciaBeneficiario/transferenciaIban/transferenciaBic) só
 * entram no UPDATE quando a própria chamada os inclui explicitamente em `config` (via
 * hasOwnProperty) — os 2 formulários existentes de Configurações (Pedidos online /
 * Entrega e retirada) nunca os enviam, e se eles fossem tratados como os demais campos
 * (sempre incondicionais), qualquer salvamento desses formulários apagaria
 * silenciosamente o QR/código Revolut ou os dados bancários já cadastrados (undefined
 * vira false/null). Assim cada seção só muda quando alguém realmente pede pra mudar.
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
  if (Object.prototype.hasOwnProperty.call(config, 'transferenciaAtiva')) {
    linha.bank_transfer_enabled = !!config.transferenciaAtiva;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'transferenciaBeneficiario')) {
    linha.bank_transfer_beneficiary = config.transferenciaBeneficiario || null;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'transferenciaIban')) {
    linha.bank_transfer_iban = config.transferenciaIban || null;
  }
  if (Object.prototype.hasOwnProperty.call(config, 'transferenciaBic')) {
    linha.bank_transfer_bic = config.transferenciaBic || null;
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
// Meta de Preparo / SLA (Tempo de Preparo, Etapa 3) — business_settings.
// preparation_target_minutes, coluna administrativa própria (fora da lista pública lida
// pelo checkout, ver nota acima). Policies reais confirmadas no Supabase: SELECT/INSERT/
// UPDATE de business_settings usam `authenticated + is_staff()` — sem distinção admin/
// employee nessa tabela. Por isso não há checagem de admin nem aqui nem na UI
// (configuracoes.js): qualquer staff autenticado pode ler e gravar esta coluna,
// exatamente como já podia com as demais colunas de business_settings.
// ---------------------------------------------------------------------------

/** Meta de preparo em minutos (número inteiro) — administrativa, nunca lida pelo checkout público. */
async function buscarMetaPreparoDoSupabase() {
  const { data, error } = await supabaseClient.from('business_settings').select(BUSINESS_SETTINGS_COLUNA_META_PREPARO).eq('id', 1).single();
  if (error) throw new Error(error.message);
  return Number(data.preparation_target_minutes) || 0;
}

/**
 * Atualiza só a meta de preparo — nunca envia o restante da linha (mesmo cuidado já usado em
 * Revolut/Transferência: um UPDATE parcial explícito, nunca arriscando zerar outro campo por engano).
 * RLS (authenticated + is_staff()) é a barreira real — qualquer staff autenticado pode chamar isto.
 */
async function atualizarMetaPreparoNoSupabase(minutos) {
  const { data, error } = await supabaseClient
    .from('business_settings')
    .update({ preparation_target_minutes: minutos })
    .eq('id', 1)
    .select(BUSINESS_SETTINGS_COLUNA_META_PREPARO)
    .single();
  if (error) throw new Error(error.message);
  return Number(data.preparation_target_minutes) || 0;
}

// ---------------------------------------------------------------------------
// Impressão automática de novos pedidos (Epson direta) — business_settings.
// Coluna administrativa própria, fora de BUSINESS_SETTINGS_COLUNAS_PUBLICAS —
// mesmo raciocínio de preparation_target_minutes: só usada por /pedidos e
// /configuracoes, nunca pelo checkout público (js/pedido.js nunca chama isto).
// ---------------------------------------------------------------------------

const BUSINESS_SETTINGS_COLUNAS_IMPRESSAO_AUTOMATICA = 'id, auto_print_enabled, auto_print_enabled_at';

function _linhaSupabaseParaImpressaoAutomatica(linha) {
  return {
    ativa: !!linha.auto_print_enabled,
    ativadaEm: linha.auto_print_enabled_at,
  };
}

/** { ativa, ativadaEm } — lido por /pedidos (decide se escaneia candidatos a impressão automática) e /configuracoes (preenche o toggle). */
async function buscarImpressaoAutomaticaDoSupabase() {
  const { data, error } = await supabaseClient
    .from('business_settings')
    .select(BUSINESS_SETTINGS_COLUNAS_IMPRESSAO_AUTOMATICA)
    .eq('id', 1)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaImpressaoAutomatica(data);
}

/**
 * Liga/desliga a impressão automática. Cada chamada representa uma ação explícita do
 * usuário no toggle (nunca um resave em lote de outro formulário — este campo não faz
 * parte de atualizarConfiguracoesNegocioNoSupabase). auto_print_enabled_at só é
 * carimbado numa transição real false/null -> true — nunca ao repetir true -> true
 * (evita que um resave/reclique acidental empurre a data pra frente e exclua pedidos
 * já aguardando impressão). Ao desligar, NUNCA mexe em auto_print_enabled_at (fica sem
 * efeito enquanto desligada, já que claim_order_auto_print exige auto_print_enabled=true
 * antes de olhar a data) — religar depois carimba de novo, criando uma nova janela.
 */
async function atualizarImpressaoAutomaticaNoSupabase(ativa) {
  const linha = { auto_print_enabled: !!ativa };

  if (ativa) {
    const atual = await buscarImpressaoAutomaticaDoSupabase();
    if (!atual.ativa) {
      linha.auto_print_enabled_at = new Date().toISOString();
    }
  }

  const { data, error } = await supabaseClient
    .from('business_settings')
    .update(linha)
    .eq('id', 1)
    .select(BUSINESS_SETTINGS_COLUNAS_IMPRESSAO_AUTOMATICA)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaImpressaoAutomatica(data);
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

// ---------------------------------------------------------------------------
// Mídia do Hero (redesign Larica, Etapa 2.3) — Supabase Storage, bucket
// site-media (migration 20260920140000). Bucket próprio, separado de
// business-assets (QR Revolut) e do image_url em base64 de produtos —
// nenhum dos dois é tocado por este bloco.
// ---------------------------------------------------------------------------

const SITE_MEDIA_BUCKET = 'site-media';
const SITE_MEDIA_MIME_PARA_EXTENSAO = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};
const SITE_MEDIA_TAMANHO_MAXIMO_IMAGEM_BYTES = 5 * 1024 * 1024; // 5 MB — limite do frontend (bucket permite até 30 MB, ver migration 20260920140000)
const SITE_MEDIA_TAMANHO_MAXIMO_VIDEO_BYTES = 30 * 1024 * 1024; // 30 MB — mesmo teto do bucket

/**
 * Envia uma mídia (imagem ou vídeo) pro bucket site-media — nunca sobrescreve, sempre gera
 * um path novo com gerarId() (js/utils.js), nunca o nome original do arquivo. Retorna só
 * {path, tipo} — nunca a URL (mesmo padrão de uploadQrRevolut): quem chama decide quando/como
 * persistir em business_settings, via updateHeroMediaSettings(...).
 */
async function uploadMidiaSite(file) {
  if (!file) throw new Error('Selecione um arquivo de imagem ou vídeo.');

  const extensao = SITE_MEDIA_MIME_PARA_EXTENSAO[file.type];
  if (!extensao) throw new Error('Formato inválido. Envie JPG, PNG, WEBP ou MP4.');

  const tipo = file.type === 'video/mp4' ? 'video' : 'image';
  const limite = tipo === 'video' ? SITE_MEDIA_TAMANHO_MAXIMO_VIDEO_BYTES : SITE_MEDIA_TAMANHO_MAXIMO_IMAGEM_BYTES;
  if (file.size > limite) {
    throw new Error(tipo === 'video' ? 'O vídeo precisa ter no máximo 30 MB.' : 'A imagem precisa ter no máximo 5 MB.');
  }

  const pasta = tipo === 'video' ? 'hero/videos' : 'hero/images';
  const path = `${pasta}/${gerarId()}.${extensao}`;

  const { error } = await supabaseClient.storage
    .from(SITE_MEDIA_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);

  return { path, tipo };
}

/** URL pública de uma mídia do site a partir do path salvo (hero_media_path/hero_poster_path) — sem query, nunca signed URL. */
function getUrlPublicaMidiaSite(path) {
  if (!path) return null;
  const { data } = supabaseClient.storage.from(SITE_MEDIA_BUCKET).getPublicUrl(path);
  return (data && data.publicUrl) || null;
}

/**
 * Lista as mídias hoje no bucket site-media (hero/images + hero/videos), normalizadas pra
 * uma futura tela de Galeria. list() do Storage não é recursivo — por isso duas chamadas,
 * uma por pasta; o "tipo" já é conhecido pela pasta, não precisa inferir por MIME.
 * created_at/updated_at vêm do próprio Storage (metadado do objeto, não inventado aqui) — se
 * um dia vierem ausentes pra algum item, criadoEm fica null, nunca um valor fabricado.
 */
async function listarMidiasSite() {
  const pastas = [
    { prefixo: 'hero/images', tipo: 'image' },
    { prefixo: 'hero/videos', tipo: 'video' },
  ];

  const listas = await Promise.all(
    pastas.map(async ({ prefixo, tipo }) => {
      const { data, error } = await supabaseClient.storage
        .from(SITE_MEDIA_BUCKET)
        .list(prefixo, { sortBy: { column: 'created_at', order: 'desc' } });
      if (error) throw new Error(error.message);
      return (data || [])
        .filter((item) => item.id) // list() também pode devolver placeholder de pasta (id null) — nunca um arquivo real
        .map((item) => {
          const path = `${prefixo}/${item.name}`;
          return {
            path,
            nome: item.name,
            tipo,
            url: getUrlPublicaMidiaSite(path),
            criadoEm: item.created_at || item.updated_at || null,
          };
        });
    })
  );

  return listas.flat().sort((a, b) => {
    if (!a.criadoEm && !b.criadoEm) return 0;
    if (!a.criadoEm) return 1;
    if (!b.criadoEm) return -1;
    return new Date(b.criadoEm) - new Date(a.criadoEm);
  });
}

const BUSINESS_SETTINGS_COLUNAS_HERO = 'hero_media_type, hero_media_path, hero_poster_path';

function _linhaSupabaseParaHeroMedia(linha) {
  return {
    tipo: linha.hero_media_type,
    path: linha.hero_media_path,
    posterPath: linha.hero_poster_path,
  };
}

/**
 * Lê só a configuração pública do Hero — nunca select('*'), nunca nenhuma outra coluna de
 * business_settings. Mesma consulta serve tanto a futura home pública (anon) quanto
 * Configurações (authenticated) — igual ao raciocínio de BUSINESS_SETTINGS_COLUNAS_PUBLICAS.
 */
async function getHeroMediaSettings() {
  const { data, error } = await supabaseClient
    .from('business_settings')
    .select(BUSINESS_SETTINGS_COLUNAS_HERO)
    .eq('id', 1)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaHeroMedia(data);
}

/**
 * Grava a configuração do Hero — só 3 estados coerentes são aceitos:
 *   - tipo:'image'  -> path obrigatório, posterPath sempre forçado a null;
 *   - tipo:'video'  -> path e posterPath obrigatórios;
 *   - tipo:null     -> remove a mídia do Hero (os 3 campos voltam a null).
 * Validado aqui antes de qualquer UPDATE — nunca deixa a tabela num estado incoerente
 * (ex.: video sem poster, ou null com path preenchido).
 */
async function updateHeroMediaSettings({ tipo, path, posterPath }) {
  let linha;

  if (tipo === 'image') {
    if (!path) throw new Error('Selecione uma imagem para o Hero.');
    linha = { hero_media_type: 'image', hero_media_path: path, hero_poster_path: null };
  } else if (tipo === 'video') {
    if (!path) throw new Error('Selecione um vídeo para o Hero.');
    if (!posterPath) throw new Error('Selecione uma imagem de poster/fallback para o vídeo.');
    linha = { hero_media_type: 'video', hero_media_path: path, hero_poster_path: posterPath };
  } else if (tipo === null) {
    linha = { hero_media_type: null, hero_media_path: null, hero_poster_path: null };
  } else {
    throw new Error('Tipo de mídia inválido.');
  }

  const { data, error } = await supabaseClient
    .from('business_settings')
    .update(linha)
    .eq('id', 1)
    .select(BUSINESS_SETTINGS_COLUNAS_HERO)
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaHeroMedia(data);
}

/**
 * Exclui uma mídia de site-media, mas nunca se ela estiver configurada como hero_media_path
 * ou hero_poster_path no momento — lê a config atual antes de apagar. Proteção só de
 * aplicação/UX (chamada a partir do client, sem RPC SECURITY DEFINER): não é garantia
 * transacional server-side contra uma corrida entre "salvar Hero" e "excluir" ao mesmo
 * tempo — endurecer isso com uma RPC fica pra depois, se necessário.
 */
async function excluirMidiaSite(path) {
  if (!path) throw new Error('Nenhuma mídia selecionada para excluir.');

  const heroAtual = await getHeroMediaSettings();
  if (path === heroAtual.path || path === heroAtual.posterPath) {
    throw new Error('Esta mídia está sendo usada atualmente pelo Hero.');
  }

  const { error } = await supabaseClient.storage.from(SITE_MEDIA_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}
