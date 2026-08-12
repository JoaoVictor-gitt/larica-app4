/*
 * configuracoes.js
 * Tela de Configurações. Duas fontes de dados bem separadas:
 * - Moeda/tema: preferências locais (localStorage, via storage.js), como
 *   sempre foram.
 * - Pedidos online / Entrega e retirada / Horário de funcionamento:
 *   public.business_settings e public.business_hours no Supabase, via
 *   js/services/settings-service.js. updated_at/updated_by são geridos por
 *   trigger no banco, nunca enviados daqui.
 * Depende de storage.js, utils.js e settings-service.js.
 */

// Cache do último config completo de business_settings (pt-BR) — necessário porque
// atualizarConfiguracoesNegocioNoSupabase() sempre espera o objeto inteiro (ver salvarConfiguracoesRevolut()).
let configNegocioCache = null;

// Arquivo de QR selecionado (ainda não enviado) — null enquanto não há seleção pendente.
let arquivoQrRevolutSelecionado = null;

const REVOLUT_QR_MIMES_ACEITOS = ['image/png', 'image/jpeg', 'image/webp'];
const REVOLUT_QR_TAMANHO_MAXIMO_BYTES = 2 * 1024 * 1024; // 2 MB — mesmo limite validado em uploadQrRevolut() (settings-service.js)

document.addEventListener('DOMContentLoaded', () => {
  preencherConfiguracoesLocais();
  document.getElementById('form-configuracoes-locais').addEventListener('submit', salvarConfiguracoesLocais);
  document.getElementById('campo-modo-escuro').addEventListener('change', alternarModoEscuro);

  document.getElementById('form-configuracoes-pedidos').addEventListener('submit', salvarConfiguracoesNegocio);
  document.getElementById('form-configuracoes-entrega').addEventListener('submit', salvarConfiguracoesNegocio);
  document.getElementById('form-configuracoes-horarios').addEventListener('submit', salvarHorarios);

  document.getElementById('botao-selecionar-qr-revolut').addEventListener('click', () => {
    document.getElementById('campo-qr-revolut').click();
  });
  document.getElementById('campo-qr-revolut').addEventListener('change', tratarSelecaoQrRevolut);
  document.getElementById('form-configuracoes-revolut').addEventListener('submit', salvarConfiguracoesRevolut);

  carregarConfiguracoesNegocio();
});

// ---------------------------------------------------------------------------
// Moeda / tema (localStorage — inalterado nesta fase)
// ---------------------------------------------------------------------------

function preencherConfiguracoesLocais() {
  const config = obterConfiguracoes();
  document.getElementById('campo-moeda').value = config.moeda;
  document.getElementById('campo-modo-escuro').checked = config.tema === 'escuro';
}

/** Aplica e salva o tema imediatamente ao ligar/desligar o toggle (não espera o Salvar) */
function alternarModoEscuro(evento) {
  const tema = evento.target.checked ? 'escuro' : 'claro';
  aplicarTema(tema);
  salvarConfiguracoes({ tema });
}

function salvarConfiguracoesLocais(evento) {
  evento.preventDefault();
  salvarConfiguracoes({ moeda: document.getElementById('campo-moeda').value });
  mostrarToast('Configurações salvas.', 'sucesso');
}

// ---------------------------------------------------------------------------
// Pedidos online / Entrega e retirada (public.business_settings)
// ---------------------------------------------------------------------------

async function carregarConfiguracoesNegocio() {
  const carregando = document.getElementById('estado-carregando-config-negocio');
  const erroEl = document.getElementById('estado-erro-config-negocio');
  const conteudo = document.getElementById('conteudo-config-negocio');

  carregando.style.display = '';
  erroEl.style.display = 'none';
  conteudo.style.display = 'none';

  try {
    const [config, horarios] = await Promise.all([buscarConfiguracoesNegocioDoSupabase(), buscarHorariosFuncionamentoDoSupabase()]);
    configNegocioCache = config;
    preencherConfiguracoesPedidos(config);
    preencherConfiguracoesEntrega(config);
    preencherConfiguracoesRevolut(config);
    preencherHorarios(horarios);
    carregando.style.display = 'none';
    conteudo.style.display = '';
  } catch (erro) {
    carregando.style.display = 'none';
    erroEl.textContent = 'Não foi possível carregar as configurações: ' + erro.message;
    erroEl.style.display = '';
  }
}

function preencherConfiguracoesPedidos(config) {
  document.getElementById('campo-pedidos-ativos').checked = config.pedidosAtivos;
  document.getElementById('campo-mensagem-fechado').value = config.mensagemFechado;
}

function preencherConfiguracoesEntrega(config) {
  document.getElementById('campo-entrega-ativa').checked = config.entregaAtiva;
  document.getElementById('campo-retirada-ativa').checked = config.retiradaAtiva;
  document.getElementById('campo-entrega-taxa-minima').value = config.entregaTaxaMinima;
  document.getElementById('campo-entrega-distancia-minima').value = config.entregaDistanciaMinimaKm;
  document.getElementById('campo-entrega-preco-km').value = config.entregaPrecoPorKm;
  document.getElementById('campo-entrega-distancia-maxima').value =
    config.entregaDistanciaMaximaKm === null ? '' : config.entregaDistanciaMaximaKm;
  document.getElementById('texto-origem-entrega').textContent =
    `${config.entregaOrigemLat.toFixed(6)}, ${config.entregaOrigemLng.toFixed(6)} — ainda não utilizado pelo cálculo de entrega ` +
    `(a Edge Function calculate-delivery continua com a origem fixa; isso muda numa fase futura). Fuso horário: ${config.fusoHorario}.`;
}

/** Lê os campos de Pedidos + Entrega do DOM — os dois formulários juntos formam a linha inteira de business_settings */
function configuracaoNegocioDoFormulario() {
  const distanciaMaximaBruta = document.getElementById('campo-entrega-distancia-maxima').value;
  return {
    pedidosAtivos: document.getElementById('campo-pedidos-ativos').checked,
    mensagemFechado: document.getElementById('campo-mensagem-fechado').value.trim(),
    entregaAtiva: document.getElementById('campo-entrega-ativa').checked,
    retiradaAtiva: document.getElementById('campo-retirada-ativa').checked,
    entregaTaxaMinima: Number(document.getElementById('campo-entrega-taxa-minima').value) || 0,
    entregaDistanciaMinimaKm: Number(document.getElementById('campo-entrega-distancia-minima').value) || 0,
    entregaPrecoPorKm: Number(document.getElementById('campo-entrega-preco-km').value) || 0,
    entregaDistanciaMaximaKm: distanciaMaximaBruta === '' ? null : Number(distanciaMaximaBruta),
  };
}

/** Espelha no cliente a constraint do banco (delivery_max_distance_km >= delivery_minimum_distance_km), só para feedback mais rápido */
function validarConfiguracaoEntrega(config) {
  if (config.entregaDistanciaMaximaKm !== null && config.entregaDistanciaMaximaKm < config.entregaDistanciaMinimaKm) {
    return 'A distância máxima não pode ser menor que a distância mínima.';
  }
  return null;
}

/** Handler compartilhado pelos formulários de Pedidos e de Entrega/retirada — ambos gravam a mesma linha de business_settings */
async function salvarConfiguracoesNegocio(evento) {
  evento.preventDefault();

  const erroEntregaEl = document.getElementById('erro-configuracoes-entrega');
  erroEntregaEl.textContent = '';

  const config = configuracaoNegocioDoFormulario();
  const erroValidacao = validarConfiguracaoEntrega(config);
  if (erroValidacao) {
    erroEntregaEl.textContent = erroValidacao;
    return;
  }

  const botao = evento.target.querySelector('button[type="submit"]');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    const atualizado = await atualizarConfiguracoesNegocioNoSupabase(config);
    configNegocioCache = atualizado;
    preencherConfiguracoesPedidos(atualizado);
    preencherConfiguracoesEntrega(atualizado);
    mostrarToast('Configurações salvas.', 'sucesso');
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível salvar as configurações.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ---------------------------------------------------------------------------
// Pagamento Revolut (business_settings.revolut_enabled/revolut_qr_path + Storage)
// ---------------------------------------------------------------------------

/** Preenche o toggle + preview do QR atual, e limpa qualquer seleção pendente de arquivo novo */
function preencherConfiguracoesRevolut(config) {
  document.getElementById('campo-revolut-ativo').checked = !!config.revolutAtivo;

  arquivoQrRevolutSelecionado = null;
  document.getElementById('campo-qr-revolut').value = '';
  document.getElementById('preview-qr-revolut-novo-wrap').style.display = 'none';

  atualizarPreviewQrRevolutAtual(config.revolutQrPath);
}

/** Mostra a imagem atual (via URL pública, sem nova query) ou o estado vazio, conforme revolutQrPath */
function atualizarPreviewQrRevolutAtual(path) {
  const img = document.getElementById('preview-qr-revolut-atual');
  const vazio = document.getElementById('estado-vazio-qr-revolut');
  const url = getUrlPublicaQrRevolut(path);

  if (url) {
    img.src = url;
    img.style.display = '';
    vazio.style.display = 'none';
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    vazio.style.display = '';
  }
}

/** Valida MIME/tamanho (mesmas regras de uploadQrRevolut) e mostra a prévia local — nada é enviado ainda */
function tratarSelecaoQrRevolut(evento) {
  const erroEl = document.getElementById('erro-configuracoes-revolut');
  erroEl.textContent = '';

  const arquivo = evento.target.files[0];
  if (!arquivo) return;

  if (!REVOLUT_QR_MIMES_ACEITOS.includes(arquivo.type)) {
    erroEl.textContent = 'Formato de imagem inválido. Envie PNG, JPEG ou WEBP.';
    evento.target.value = '';
    return;
  }
  if (arquivo.size > REVOLUT_QR_TAMANHO_MAXIMO_BYTES) {
    erroEl.textContent = 'A imagem precisa ter no máximo 2 MB.';
    evento.target.value = '';
    return;
  }

  arquivoQrRevolutSelecionado = arquivo;

  const leitor = new FileReader();
  leitor.onload = () => {
    document.getElementById('preview-qr-revolut-novo').src = leitor.result;
    document.getElementById('preview-qr-revolut-novo-wrap').style.display = '';
  };
  leitor.readAsDataURL(arquivo);
}

/**
 * Se houver arquivo novo selecionado: upload primeiro, só então persiste business_settings com o path
 * novo — se o upload falhar, nada é salvo (path anterior continua oficial). Se não houver arquivo novo,
 * salva só o toggle, preservando revolutQrPath atual (nunca envia null sem intenção). Sempre manda o
 * config completo em cache pra atualizarConfiguracoesNegocioNoSupabase() (ver achado da auditoria) —
 * nunca um objeto parcial, senão os outros campos de negócio seriam zerados.
 */
async function salvarConfiguracoesRevolut(evento) {
  evento.preventDefault();

  const erroEl = document.getElementById('erro-configuracoes-revolut');
  erroEl.textContent = '';

  const revolutAtivo = document.getElementById('campo-revolut-ativo').checked;
  const temQrAtual = !!(configNegocioCache && configNegocioCache.revolutQrPath);
  const temArquivoNovo = !!arquivoQrRevolutSelecionado;

  if (revolutAtivo && !temQrAtual && !temArquivoNovo) {
    erroEl.textContent = 'Cadastre um QR Code antes de ativar o pagamento via Revolut.';
    return;
  }

  const botao = document.getElementById('botao-salvar-revolut');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    let novoPath = null;
    if (temArquivoNovo) {
      novoPath = await uploadQrRevolut(arquivoQrRevolutSelecionado);
    }

    const config = { ...configNegocioCache, revolutAtivo };
    if (novoPath) config.revolutQrPath = novoPath;

    const atualizado = await atualizarConfiguracoesNegocioNoSupabase(config);
    configNegocioCache = atualizado;
    preencherConfiguracoesRevolut(atualizado);
    mostrarToast('Configurações do Revolut salvas.', 'sucesso');
  } catch (erro) {
    erroEl.textContent = erro.message || 'Não foi possível salvar as configurações do Revolut.';
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ---------------------------------------------------------------------------
// Horário de funcionamento (public.business_hours)
// ---------------------------------------------------------------------------

function linhaHorarioHtml(horario) {
  const abertura = horario.horaAbertura ? horario.horaAbertura.slice(0, 5) : '';
  const fechamento = horario.horaFechamento ? horario.horaFechamento.slice(0, 5) : '';
  const desabilitado = horario.ativo ? '' : 'disabled';
  return `
    <tr data-dia="${horario.diaSemana}">
      <td>${escaparHtml(horario.rotuloDia)}</td>
      <td><input type="checkbox" class="campo-horario-ativo" ${horario.ativo ? 'checked' : ''} /></td>
      <td><input type="time" class="input campo-horario-abertura" value="${abertura}" ${desabilitado} /></td>
      <td><input type="time" class="input campo-horario-fechamento" value="${fechamento}" ${desabilitado} /></td>
    </tr>`;
}

function preencherHorarios(horarios) {
  const corpo = document.getElementById('corpo-tabela-horarios');
  corpo.innerHTML = horarios.map(linhaHorarioHtml).join('');

  corpo.querySelectorAll('.campo-horario-ativo').forEach((checkbox) => {
    checkbox.addEventListener('change', (evento) => {
      const linha = evento.target.closest('tr');
      const ativo = evento.target.checked;
      linha.querySelector('.campo-horario-abertura').disabled = !ativo;
      linha.querySelector('.campo-horario-fechamento').disabled = !ativo;
    });
  });
}

async function salvarHorarios(evento) {
  evento.preventDefault();

  const linhas = Array.from(document.querySelectorAll('#corpo-tabela-horarios tr'));

  for (const linha of linhas) {
    const ativo = linha.querySelector('.campo-horario-ativo').checked;
    const abertura = linha.querySelector('.campo-horario-abertura').value;
    const fechamento = linha.querySelector('.campo-horario-fechamento').value;
    if (ativo && (!abertura || !fechamento)) {
      mostrarToast('Preencha abertura e fechamento para os dias marcados como abertos.', 'erro');
      return;
    }
  }

  const botao = evento.target.querySelector('button[type="submit"]');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    for (const linha of linhas) {
      const diaSemana = Number(linha.dataset.dia);
      const ativo = linha.querySelector('.campo-horario-ativo').checked;
      const horaAbertura = linha.querySelector('.campo-horario-abertura').value || null;
      const horaFechamento = linha.querySelector('.campo-horario-fechamento').value || null;
      await atualizarHorarioFuncionamentoNoSupabase(diaSemana, { ativo, horaAbertura, horaFechamento });
    }
    mostrarToast('Horários salvos.', 'sucesso');
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível salvar os horários.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}
