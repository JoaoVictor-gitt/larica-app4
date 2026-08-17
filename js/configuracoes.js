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
// REVOLUT_QR_TAMANHO_MAXIMO_BYTES vem de js/services/settings-service.js (carregado antes deste arquivo) — mesma constante, não redeclarada aqui.

// Cache da última lista de cupons carregada (pt-BR) — usado pra reabrir o modal de edição sem nova consulta.
let cuponsCache = [];

// ---------------------------------------------------------------------------
// Navegação da central de Configurações (mostrar/esconder, sem recriar nada)
// ---------------------------------------------------------------------------

function ligarEventosNavegacaoConfig() {
  document.querySelectorAll('[data-config-abrir]').forEach((botao) => {
    botao.addEventListener('click', () => abrirSecaoConfig(botao.dataset.configAbrir));
  });
  document.querySelectorAll('[data-config-voltar]').forEach((botao) => {
    botao.addEventListener('click', fecharSecaoConfig);
  });
}

function abrirSecaoConfig(chave) {
  document.getElementById('config-central').style.display = 'none';
  document.querySelectorAll('.config-secao').forEach((secao) => {
    secao.classList.toggle('config-secao-ativa', secao.dataset.configSecao === chave);
  });
}

function fecharSecaoConfig() {
  document.querySelectorAll('.config-secao').forEach((secao) => secao.classList.remove('config-secao-ativa'));
  document.getElementById('config-central').style.display = '';
}

document.addEventListener('DOMContentLoaded', () => {
  ligarEventosNavegacaoConfig();

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

  document.getElementById('form-configuracoes-transferencia').addEventListener('submit', salvarConfiguracoesTransferencia);

  document.getElementById('botao-novo-cupom').addEventListener('click', abrirModalCriacaoCupom);
  document.getElementById('botao-fechar-modal-cupom').addEventListener('click', fecharModalCupom);
  document.getElementById('botao-cancelar-modal-cupom').addEventListener('click', fecharModalCupom);
  document.getElementById('modal-cupom-overlay').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-cupom-overlay') fecharModalCupom();
  });
  document.getElementById('form-cupom').addEventListener('submit', salvarCupom);

  carregarConfiguracoesNegocio();
  carregarCupons(); // independente de carregarConfiguracoesNegocio() — uma falha aqui não pode derrubar o resto de Configurações
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
    preencherConfiguracoesTransferencia(config);
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

/** Preenche o toggle + código copiável + preview do QR atual, e limpa qualquer seleção pendente de arquivo novo */
function preencherConfiguracoesRevolut(config) {
  document.getElementById('campo-revolut-ativo').checked = !!config.revolutAtivo;
  document.getElementById('campo-revolut-codigo').value = config.revolutPaymentCode || '';

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
 * salva só o toggle, preservando revolutQrPath atual (nunca envia null sem intenção). O código/link
 * copiável (revolutPaymentCode) é sempre enviado com o valor atual do campo — sem a mesma ambiguidade
 * do upload de arquivo, então não precisa da mesma proteção condicional. Sempre manda o config completo
 * em cache pra atualizarConfiguracoesNegocioNoSupabase() (ver achado da auditoria) — nunca um objeto
 * parcial, senão os outros campos de negócio seriam zerados.
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

    const revolutPaymentCode = document.getElementById('campo-revolut-codigo').value.trim();
    const config = { ...configNegocioCache, revolutAtivo, revolutPaymentCode };
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
// Transferência Bancária (business_settings.bank_transfer_enabled/
// bank_transfer_beneficiary/bank_transfer_iban/bank_transfer_bic)
// ---------------------------------------------------------------------------

/** Preenche o toggle + os 3 campos de texto (sem upload de arquivo, ao contrário do Revolut) */
function preencherConfiguracoesTransferencia(config) {
  document.getElementById('campo-transferencia-ativa').checked = !!config.transferenciaAtiva;
  document.getElementById('campo-transferencia-beneficiario').value = config.transferenciaBeneficiario || '';
  document.getElementById('campo-transferencia-iban').value = config.transferenciaIban || '';
  document.getElementById('campo-transferencia-bic').value = config.transferenciaBic || '';
}

/**
 * Se o toggle estiver marcado, Beneficiário/IBAN/BIC são obrigatórios (depois de trim —
 * string só com espaços não conta como preenchido). Sempre manda o config completo em
 * cache pra atualizarConfiguracoesNegocioNoSupabase() (mesmo motivo do Revolut) — nunca
 * um objeto parcial, senão os outros campos de negócio seriam zerados.
 */
async function salvarConfiguracoesTransferencia(evento) {
  evento.preventDefault();

  const erroEl = document.getElementById('erro-configuracoes-transferencia');
  erroEl.textContent = '';

  const transferenciaAtiva = document.getElementById('campo-transferencia-ativa').checked;
  const transferenciaBeneficiario = document.getElementById('campo-transferencia-beneficiario').value.trim();
  const transferenciaIban = document.getElementById('campo-transferencia-iban').value.trim();
  const transferenciaBic = document.getElementById('campo-transferencia-bic').value.trim();

  if (transferenciaAtiva && (!transferenciaBeneficiario || !transferenciaIban || !transferenciaBic)) {
    erroEl.textContent = 'Preencha Beneficiário, IBAN e BIC antes de ativar a transferência bancária.';
    return;
  }

  const botao = document.getElementById('botao-salvar-transferencia');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    const config = { ...configNegocioCache, transferenciaAtiva, transferenciaBeneficiario, transferenciaIban, transferenciaBic };
    const atualizado = await atualizarConfiguracoesNegocioNoSupabase(config);
    configNegocioCache = atualizado;
    preencherConfiguracoesTransferencia(atualizado);
    mostrarToast('Configurações de transferência bancária salvas.', 'sucesso');
  } catch (erro) {
    erroEl.textContent = erro.message || 'Não foi possível salvar as configurações de transferência.';
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

// ---------------------------------------------------------------------------
// Cupons e descontos (public.coupons, via js/services/coupons-service.js)
// ---------------------------------------------------------------------------

/** "YYYY-MM-DDTHH:MM" (Dublin) formatado pra exibição "dd/mm/aaaa HH:MM" — sempre no fuso do estabelecimento, nunca o do navegador */
function formatarDataHoraCupomDublin(isoUtc) {
  const localDublin = timestamptzParaDatetimeLocal(isoUtc, 'Europe/Dublin');
  if (!localDublin) return '';
  const [data, hora] = localDublin.split('T');
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano} ${hora}`;
}

function formatarValidadeCupom(cupom) {
  if (!cupom.inicioEm && !cupom.fimEm) return '—';
  if (cupom.inicioEm && !cupom.fimEm) return `A partir de ${formatarDataHoraCupomDublin(cupom.inicioEm)}`;
  if (!cupom.inicioEm && cupom.fimEm) return `Até ${formatarDataHoraCupomDublin(cupom.fimEm)}`;
  return `${formatarDataHoraCupomDublin(cupom.inicioEm)} – ${formatarDataHoraCupomDublin(cupom.fimEm)}`;
}

function formatarDescontoCupom(cupom) {
  if (cupom.tipoDesconto === 'percentage') return `${cupom.valorDesconto}%`;
  // Defensivo: um cupom 'fixed' criado fora da UI (banco direto) continua listado de forma coerente, sem quebrar.
  return formatarMoeda(cupom.valorDesconto);
}

function formatarMinimoCupom(cupom) {
  return cupom.valorMinimoPedido === null || cupom.valorMinimoPedido === undefined ? '—' : formatarMoeda(cupom.valorMinimoPedido);
}

function linhaCupomHtml(cupom) {
  return `
    <tr data-id="${cupom.id}">
      <td><code>${escaparHtml(cupom.codigo)}</code></td>
      <td>${cupom.nome ? escaparHtml(cupom.nome) : '—'}</td>
      <td>${formatarDescontoCupom(cupom)}</td>
      <td><span class="badge badge-${cupom.ativo ? 'ativo' : 'inativo'}">${cupom.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>${formatarValidadeCupom(cupom)}</td>
      <td>${formatarMinimoCupom(cupom)}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn-icone" data-acao="editar" data-id="${cupom.id}" title="Editar">✏️</button>
        <button type="button" class="btn-icone" data-acao="alternar-status" data-id="${cupom.id}" title="${cupom.ativo ? 'Desativar' : 'Ativar'}">${cupom.ativo ? '⏸️' : '▶️'}</button>
      </td>
    </tr>`;
}

function renderizarTabelaCupons() {
  const corpo = document.getElementById('corpo-tabela-cupons');
  corpo.innerHTML = cuponsCache.map(linhaCupomHtml).join('');

  corpo.querySelectorAll('[data-acao="editar"]').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalEdicaoCupom(btn.dataset.id));
  });
  corpo.querySelectorAll('[data-acao="alternar-status"]').forEach((btn) => {
    btn.addEventListener('click', () => alternarStatusCupom(btn.dataset.id));
  });
}

async function carregarCupons() {
  const carregando = document.getElementById('estado-carregando-cupons');
  const erroEl = document.getElementById('estado-erro-cupons');
  const vazioEl = document.getElementById('estado-vazio-cupons');
  const tabela = document.querySelector('#corpo-tabela-cupons').closest('table');

  carregando.style.display = '';
  erroEl.style.display = 'none';
  vazioEl.style.display = 'none';
  tabela.style.display = 'none';

  try {
    cuponsCache = await listarCuponsNoSupabase();
    carregando.style.display = 'none';
    if (cuponsCache.length === 0) {
      vazioEl.style.display = '';
      return;
    }
    tabela.style.display = '';
    renderizarTabelaCupons();
  } catch (erro) {
    carregando.style.display = 'none';
    erroEl.textContent = 'Não foi possível carregar os cupons: ' + erro.message;
    erroEl.style.display = '';
  }
}

function abrirModalCupom() {
  document.getElementById('modal-cupom-overlay').classList.add('modal-visivel');
}

function fecharModalCupom() {
  document.getElementById('modal-cupom-overlay').classList.remove('modal-visivel');
}

function limparFormularioCupom() {
  document.getElementById('erro-modal-cupom').textContent = '';
  document.getElementById('campo-cupom-id').value = '';
  document.getElementById('campo-cupom-codigo').value = '';
  document.getElementById('campo-cupom-nome').value = '';
  document.getElementById('campo-cupom-desconto').value = '';
  document.getElementById('campo-cupom-ativo').checked = true;
  document.getElementById('campo-cupom-inicio').value = '';
  document.getElementById('campo-cupom-fim').value = '';
  document.getElementById('campo-cupom-minimo').value = '';
}

function abrirModalCriacaoCupom() {
  limparFormularioCupom();
  document.getElementById('modal-cupom-titulo').textContent = 'Novo cupom';
  abrirModalCupom();
}

/**
 * V1 só sabe editar cupons percentuais — um cupom 'fixed' (só possível hoje via banco direto,
 * já que a UI nunca cria um) é visualizável na lista, mas a edição é bloqueada aqui com aviso,
 * em vez de abrir um formulário que assumiria incorretamente um desconto percentual.
 */
function abrirModalEdicaoCupom(id) {
  const cupom = cuponsCache.find((c) => c.id === id);
  if (!cupom) return;

  if (cupom.tipoDesconto !== 'percentage') {
    mostrarToast('Este tipo de cupom ainda não pode ser editado nesta versão.', 'info');
    return;
  }

  limparFormularioCupom();
  document.getElementById('modal-cupom-titulo').textContent = 'Editar cupom';
  document.getElementById('campo-cupom-id').value = cupom.id;
  document.getElementById('campo-cupom-codigo').value = cupom.codigo;
  document.getElementById('campo-cupom-nome').value = cupom.nome || '';
  document.getElementById('campo-cupom-desconto').value = cupom.valorDesconto;
  document.getElementById('campo-cupom-ativo').checked = cupom.ativo;
  document.getElementById('campo-cupom-inicio').value = timestamptzParaDatetimeLocal(cupom.inicioEm, 'Europe/Dublin');
  document.getElementById('campo-cupom-fim').value = timestamptzParaDatetimeLocal(cupom.fimEm, 'Europe/Dublin');
  document.getElementById('campo-cupom-minimo').value = cupom.valorMinimoPedido === null ? '' : cupom.valorMinimoPedido;
  abrirModalCupom();
}

/** Lê o formulário e converte início/fim (datetime-local, Dublin) para UTC — pode lançar (horário inexistente/ambíguo, ver utils.js) */
function cupomDoFormulario() {
  const minimoBruto = document.getElementById('campo-cupom-minimo').value;
  return {
    codigo: document.getElementById('campo-cupom-codigo').value.trim().toUpperCase(),
    nome: document.getElementById('campo-cupom-nome').value.trim() || null,
    tipoDesconto: 'percentage',
    valorDesconto: Number(document.getElementById('campo-cupom-desconto').value),
    ativo: document.getElementById('campo-cupom-ativo').checked,
    inicioEm: datetimeLocalParaUtcIso(document.getElementById('campo-cupom-inicio').value, 'Europe/Dublin'),
    fimEm: datetimeLocalParaUtcIso(document.getElementById('campo-cupom-fim').value, 'Europe/Dublin'),
    valorMinimoPedido: minimoBruto === '' ? null : Number(minimoBruto),
  };
}

/** Espelha no cliente as constraints do banco (item B da Etapa 1), só para feedback mais rápido — o banco continua a fonte real */
function validarFormularioCupom(dados) {
  if (!dados.codigo) return 'Informe o código do cupom.';
  if (!(dados.valorDesconto > 0) || dados.valorDesconto > 100) return 'O desconto deve ser maior que 0 e no máximo 100%.';
  if (dados.valorMinimoPedido !== null && dados.valorMinimoPedido < 0) return 'O pedido mínimo não pode ser negativo.';
  if (dados.inicioEm && dados.fimEm && dados.fimEm <= dados.inicioEm) return 'O fim da validade deve ser depois do início.';
  return null;
}

async function salvarCupom(evento) {
  evento.preventDefault();

  const erroEl = document.getElementById('erro-modal-cupom');
  erroEl.textContent = '';

  let dados;
  try {
    dados = cupomDoFormulario();
  } catch (erroConversao) {
    // Horário inexistente/ambíguo na transição de DST (ver datetimeLocalParaUtcIso em utils.js)
    erroEl.textContent = erroConversao.message;
    return;
  }

  const erroValidacao = validarFormularioCupom(dados);
  if (erroValidacao) {
    erroEl.textContent = erroValidacao;
    return;
  }

  const id = document.getElementById('campo-cupom-id').value;
  const botao = evento.target.querySelector('button[type="submit"]');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  try {
    if (id) {
      await atualizarCupomNoSupabase(id, dados);
    } else {
      await criarCupomNoSupabase(dados);
    }
    fecharModalCupom();
    await carregarCupons();
    mostrarToast('Cupom salvo.', 'sucesso');
  } catch (erro) {
    // 23505 = violação de unique(code) — mensagem amigável sem remover a proteção real, que é do banco
    erroEl.textContent = erro.message && erro.message.includes('duplicate key') ? 'Já existe um cupom com este código.' : erro.message;
  } finally {
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

async function alternarStatusCupom(id) {
  const cupom = cuponsCache.find((c) => c.id === id);
  if (!cupom) return;

  try {
    await atualizarCupomNoSupabase(id, { ativo: !cupom.ativo });
    await carregarCupons();
    mostrarToast(cupom.ativo ? 'Cupom desativado.' : 'Cupom ativado.', 'sucesso');
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível atualizar o cupom.', 'erro');
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
