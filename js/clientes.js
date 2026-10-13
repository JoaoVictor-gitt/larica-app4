/*
 * clientes.js
 * Página Clientes (admin-only): leitura + sincronização automática + edição e exclusão
 * (arquivamento) manual de cadastros pela ficha.
 *
 * Cliente cadastrado = cadastro ATIVO (nome; telefone irlandês opcional). O vínculo automático
 * continua exigindo nome + telefone irlandês. Pedido sem vínculo = "não cadastrado", uma linha
 * por pedido, NUNCA agrupado pelo nome (mesmo nome só vira "possível correspondência"). Pedido
 * com nome + telefone válidos ainda sem vínculo = "aguardando sincronização".
 *
 * Editar (admin_update_customer) e Excluir (admin_archive_customer — arquiva o cadastro e
 * desvincula os pedidos, que voltam a "não cadastrado") rodam no banco, com checagem de admin
 * e auditoria. Esta tela nunca apaga nem altera pedidos.
 *
 * Sincronização (sync_phone_customer_links, no banco): roda ao abrir a página, no botão
 * "Atualizar" e a cada 2 min (só com a aba visível, sem ficha aberta e sem outra atualização
 * em andamento). Nunca bloqueia a leitura: espera no máximo 8 s e, se falhar/estiver ocupada,
 * mostra um aviso e carrega os dados mesmo assim.
 *
 * Cadastro manual (botão "Cadastrar cliente"): dados -> revisão de possíveis duplicidades (cada
 * aviso precisa ser confirmado) -> concluído. Eircode opcional, editável pela ficha. Vinculação
 * manual de UM pedido por vez pela seção "Histórico de vínculos" da ficha: pesquisa -> confirmação
 * (avisos de nome/telefone/cancelado e reativação de pedido desvinculado). O banco recalcula e exige
 * tudo isso; aqui é só UX. Pedido vinculado a outro cliente nunca é transferido.
 * Falha de rede = "não confirmado": a tela relê o estado no banco antes de permitir nova tentativa
 * (cadastro repetido com o mesmo id de tentativa não duplica; vínculo repetido vira "já vinculado").
 *
 * Toda agregação roda no banco (js/services/customers-service.js) — esta tela nunca carrega o
 * histórico inteiro de pedidos.
 * Depende de utils.js, storage.js e customers-service.js.
 */

const TAMANHO_PAGINA_CLIENTES = 25;
const TAMANHO_PAGINA_PEDIDOS_FICHA = 20;
const LIMITE_ESPERA_SINCRONIZACAO_MS = 8000;
const INTERVALO_ATUALIZACAO_AUTOMATICA_MS = 120000;

const estadoListaClientes = { busca: '', ordenacao: 'nome', filtro: 'todos', offset: 0, total: 0, seq: 0 };
const estadoFichaCliente = { aberta: false, alvo: null, cadastrado: false, dados: null, perfil: null, pedidos: [], totalPedidos: 0, seq: 0 };
const estadoAtualizacaoClientes = { emAndamento: false };
// Operação de escrita em andamento (editar, excluir, cadastrar, Eircode, vincular): bloqueia cliques
// repetidos e o fechamento da ficha/modais até terminar
const estadoOperacaoCliente = { emAndamento: false };
const estadoCadastroCliente = {
  aberto: false,
  etapa: 'dados',
  previa: null,
  dados: null,
  idTentativa: null,
  tentativaEncerrada: false,
  clienteCriadoId: null,
};
const estadoVincularPedido = { aberto: false, clienteId: null, busca: '', offset: 0, total: 0, pedidos: [], seq: 0, selecionado: null };
const TAMANHO_PAGINA_VINCULAR_PEDIDO = 10;

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosListaClientes();
  ligarEventosFichaCliente();
  ligarEventosEdicaoExclusaoCliente();
  ligarEventosCadastroCliente();
  ligarEventosEircodeCliente();
  ligarEventosVincularPedido();
  document.getElementById('botao-atualizar-clientes').addEventListener('click', () => atualizarClientes({ manual: true }));

  await atualizarClientes({ manual: false });

  const parametros = new URLSearchParams(window.location.search);
  if (parametros.get('cliente')) abrirFichaCliente({ clienteId: parametros.get('cliente') });
  else if (parametros.get('pedido')) abrirFichaCliente({ pedidoId: parametros.get('pedido') });

  setInterval(() => {
    if (
      document.visibilityState !== 'visible' ||
      estadoFichaCliente.aberta ||
      estadoCadastroCliente.aberto ||
      estadoOperacaoCliente.emAndamento ||
      estadoAtualizacaoClientes.emAndamento
    ) {
      return;
    }
    atualizarClientes({ manual: false });
  }, INTERVALO_ATUALIZACAO_AUTOMATICA_MS);
});

// ---------------------------------------------------------------------------
// Atualização (sincronização + releitura)
// ---------------------------------------------------------------------------

/** Sincroniza (não fatal, no máximo 8 s) e recarrega indicadores + página atual da lista (+ ficha aberta, se manual) */
async function atualizarClientes({ manual }) {
  if (estadoAtualizacaoClientes.emAndamento) return;
  estadoAtualizacaoClientes.emAndamento = true;
  const botao = document.getElementById('botao-atualizar-clientes');
  botao.disabled = true;
  document.getElementById('texto-atualizacao-clientes').textContent = 'Sincronizando…';

  try {
    await sincronizarCadastroComLimite();
    await Promise.all([carregarIndicadoresClientes(), carregarListaClientes()]);
    if (manual && estadoFichaCliente.aberta && estadoFichaCliente.alvo) abrirFichaCliente(estadoFichaCliente.alvo);
    document.getElementById('texto-atualizacao-clientes').textContent = 'Atualizado às ' + formatarHora(new Date().toISOString());
  } finally {
    estadoAtualizacaoClientes.emAndamento = false;
    botao.disabled = false;
  }
}

async function sincronizarCadastroComLimite() {
  const aviso = document.getElementById('aviso-sincronizacao-clientes');
  let timer;
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error('tempo limite de sincronização excedido')), LIMITE_ESPERA_SINCRONIZACAO_MS);
  });

  let resultado;
  try {
    resultado = await Promise.race([syncCustomerLinks(), limite]);
  } catch (erro) {
    console.error('Erro ao sincronizar cadastro de clientes:', erro);
    mostrarAvisoSincronizacao(`Não foi possível sincronizar os pedidos novos agora (${erro.message}). Mostrando os dados atuais.`);
    return;
  } finally {
    clearTimeout(timer);
  }

  if (resultado.ocupada) {
    mostrarAvisoSincronizacao('Outra sincronização está em andamento. Os dados podem levar alguns segundos para incluir pedidos novos — clique em Atualizar.');
    return;
  }
  const partes = [];
  if (resultado.vinculados > 0) {
    partes.push(
      `${resultado.vinculados} ${resultado.vinculados === 1 ? 'pedido novo vinculado' : 'pedidos novos vinculados'} automaticamente pelo nome + telefone` +
        (resultado.cadastrosCriados > 0 ? ` (${resultado.cadastrosCriados} ${resultado.cadastrosCriados === 1 ? 'cadastro criado' : 'cadastros criados'})` : '') +
        '.'
    );
  }
  if (resultado.restantes > 0) partes.push(`Ainda há ${resultado.restantes} aguardando sincronização — clique em Atualizar.`);
  if (partes.length > 0) mostrarAvisoSincronizacao(partes.join(' '));
  else aviso.style.display = 'none';
}

function mostrarAvisoSincronizacao(texto) {
  const aviso = document.getElementById('aviso-sincronizacao-clientes');
  aviso.textContent = texto;
  aviso.style.display = '';
}

// ---------------------------------------------------------------------------
// Indicadores gerais
// ---------------------------------------------------------------------------

async function carregarIndicadoresClientes() {
  let ind;
  try {
    ind = await getCustomersOverview();
  } catch (erro) {
    console.error('Erro ao carregar indicadores de clientes:', erro);
    return; // a tabela já mostra o erro; cards ficam como estavam
  }
  const moeda = obterConfiguracoes().moeda;
  document.getElementById('indicador-clientes-cadastrados').textContent = ind.clientesCadastrados;
  document.getElementById('indicador-clientes-compraram').textContent = ind.clientesQueCompraram;
  document.getElementById('indicador-clientes-recorrentes').textContent = ind.clientesRecorrentes;
  document.getElementById('indicador-pedidos-clientes').textContent = ind.qtdPedidos;
  document.getElementById('indicador-total-gasto').textContent = formatarMoeda(ind.totalGasto, moeda);
  document.getElementById('indicador-ticket-medio').textContent = formatarMoeda(ind.ticketMedio, moeda);

  const partes = [];
  if (ind.pedidosNaoCadastrados > 0) {
    partes.push(
      `${ind.pedidosNaoCadastrados} ${ind.pedidosNaoCadastrados === 1 ? 'pedido finalizado não cadastrado' : 'pedidos finalizados não cadastrados'} ` +
        `(${formatarMoeda(ind.valorNaoCadastrados, moeda)}, ${ind.nomesNaoCadastrados} ${ind.nomesNaoCadastrados === 1 ? 'nome' : 'nomes'}` +
        (ind.nomesNaoCadastradosComCorrespondencia > 0 ? `, ${ind.nomesNaoCadastradosComCorrespondencia} com nome igual a um cadastro` : '') +
        ')'
    );
  }
  if (ind.nomesRepetidos > 0) partes.push(`${ind.nomesRepetidos} ${ind.nomesRepetidos === 1 ? 'nome repetido' : 'nomes repetidos'} entre cadastros`);
  if (ind.telefonesCompartilhados > 0) {
    partes.push(`${ind.telefonesCompartilhados} ${ind.telefonesCompartilhados === 1 ? 'telefone compartilhado' : 'telefones compartilhados'}`);
  }
  if (ind.pedidosAguardandoSincronizacao > 0) partes.push(`${ind.pedidosAguardandoSincronizacao} aguardando sincronização`);
  document.getElementById('aviso-qualidade-identificacao').textContent = partes.length > 0 ? partes.join(' · ') + '.' : '';
}

// ---------------------------------------------------------------------------
// Lista (busca/ordenação/filtro/paginação no servidor)
// ---------------------------------------------------------------------------

function ligarEventosListaClientes() {
  document.getElementById('busca-clientes').addEventListener(
    'input',
    debounce((evento) => {
      estadoListaClientes.busca = evento.target.value.trim();
      estadoListaClientes.offset = 0;
      carregarListaClientes();
    }, 300)
  );
  document.getElementById('ordenacao-clientes').addEventListener('change', (evento) => {
    estadoListaClientes.ordenacao = evento.target.value;
    estadoListaClientes.offset = 0;
    carregarListaClientes();
  });
  document.querySelectorAll('#filtros-clientes .filtro-categoria-botao').forEach((botao) => {
    botao.addEventListener('click', () => {
      estadoListaClientes.filtro = botao.dataset.filtroClientes;
      estadoListaClientes.offset = 0;
      document.querySelectorAll('#filtros-clientes .filtro-categoria-botao').forEach((b) => b.classList.toggle('ativo', b === botao));
      carregarListaClientes();
    });
  });
  document.getElementById('botao-pagina-anterior-clientes').addEventListener('click', () => {
    estadoListaClientes.offset = Math.max(0, estadoListaClientes.offset - TAMANHO_PAGINA_CLIENTES);
    carregarListaClientes();
  });
  document.getElementById('botao-pagina-proxima-clientes').addEventListener('click', () => {
    estadoListaClientes.offset += TAMANHO_PAGINA_CLIENTES;
    carregarListaClientes();
  });

  const corpo = document.getElementById('corpo-tabela-clientes');
  const abrirDaLinha = (linha) => {
    if (linha.dataset.cliente) abrirFichaCliente({ clienteId: linha.dataset.cliente });
    else if (linha.dataset.pedido) abrirFichaCliente({ pedidoId: linha.dataset.pedido });
  };
  corpo.addEventListener('click', (evento) => {
    const linha = evento.target.closest('tr.linha-cliente-clicavel');
    if (linha) abrirDaLinha(linha);
  });
  corpo.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Enter') return;
    const linha = evento.target.closest('tr.linha-cliente-clicavel');
    if (linha) abrirDaLinha(linha);
  });
}

async function carregarListaClientes() {
  const seq = ++estadoListaClientes.seq; // descarta respostas fora de ordem (busca digitada rápido)
  const carregando = document.getElementById('estado-carregando-clientes');
  const erro = document.getElementById('estado-erro-clientes');
  const vazio = document.getElementById('estado-vazio-clientes');
  carregando.style.display = 'block';
  erro.style.display = 'none';

  let resultado;
  try {
    resultado = await listCustomers({
      busca: estadoListaClientes.busca,
      ordenacao: estadoListaClientes.ordenacao,
      filtro: estadoListaClientes.filtro,
      limite: TAMANHO_PAGINA_CLIENTES,
      offset: estadoListaClientes.offset,
    });
  } catch (erroCarregamento) {
    if (seq !== estadoListaClientes.seq) return;
    console.error('Erro ao carregar clientes:', erroCarregamento);
    carregando.style.display = 'none';
    vazio.style.display = 'none';
    document.getElementById('corpo-tabela-clientes').innerHTML = '';
    document.getElementById('paginacao-clientes').style.display = 'none';
    erro.textContent = 'Não foi possível carregar clientes. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  if (seq !== estadoListaClientes.seq) return;
  carregando.style.display = 'none';

  // Atualização automática pode encolher a lista (ex.: pedidos vinculados) — volta pra última página válida
  if (resultado.clientes.length === 0 && resultado.total > 0 && estadoListaClientes.offset >= resultado.total) {
    estadoListaClientes.offset = Math.max(0, Math.floor((resultado.total - 1) / TAMANHO_PAGINA_CLIENTES) * TAMANHO_PAGINA_CLIENTES);
    return carregarListaClientes();
  }

  estadoListaClientes.total = resultado.total;
  const corpo = document.getElementById('corpo-tabela-clientes');
  const moeda = obterConfiguracoes().moeda;

  if (resultado.clientes.length === 0) {
    corpo.innerHTML = '';
    vazio.textContent =
      estadoListaClientes.busca || estadoListaClientes.filtro !== 'todos' ? 'Nenhum registro encontrado para esse filtro.' : 'Nenhum cliente ainda.';
    vazio.style.display = 'block';
  } else {
    vazio.style.display = 'none';
    corpo.innerHTML = resultado.clientes.map((c) => linhaClienteHtml(c, moeda)).join('');
  }
  atualizarPaginacaoClientes();
}

function linhaClienteHtml(c, moeda) {
  const atributo = c.tipo === 'cadastrado' ? `data-cliente="${escaparHtml(c.clienteId)}"` : `data-pedido="${escaparHtml(c.pedidoId)}"`;
  return `
    <tr ${atributo} tabindex="0" class="linha-cliente-clicavel">
      <td>${escaparHtml(c.nome || 'Não informado')}</td>
      <td>${telefoneClienteHtml(c.telefone, c.telefoneNaoReconhecido)}</td>
      <td><div class="selos-cliente">${selosLinhaClienteHtml(c)}</div></td>
      <td>${c.qtdPedidos}</td>
      <td>${formatarMoeda(c.totalGasto, moeda)}</td>
      <td>${formatarMoeda(c.ticketMedio, moeda)}</td>
      <td>${escaparHtml(formatarData(c.primeiraCompraEm) || '—')}</td>
      <td>${escaparHtml(formatarData(c.ultimaCompraEm) || '—')}</td>
    </tr>`;
}

/** Selos da coluna Situação — só sinalizam, nunca juntam registros */
function selosLinhaClienteHtml(c) {
  const selos = [];
  if (c.tipo === 'cadastrado') {
    selos.push(seloHtml('Cadastrado', 'badge-verde', c.telefone ? 'Cadastro ativo com telefone irlandês' : 'Cadastro ativo sem telefone'));
    if (c.qtdPedidos === 0) selos.push(seloHtml('Sem compras', 'badge-cinza', 'Nenhum pedido finalizado vinculado'));
    if (c.qtdMesmoNome > 0) selos.push(seloHtml('Nome repetido', 'badge-amarelo', `Mais ${c.qtdMesmoNome} cadastro(s) com este nome`));
    if (c.qtdTelefoneCompartilhado > 0) {
      selos.push(seloHtml('Telefone compartilhado / possível vínculo', 'badge-vermelho', `Mais ${c.qtdTelefoneCompartilhado} cadastro(s) com este telefone`));
    }
    if (c.possiveisCorrespondencias > 0) {
      selos.push(seloHtml(`${c.possiveisCorrespondencias} pedido(s) não cadastrado(s) com este nome`, 'badge-cinza', 'Possíveis correspondências — não somadas'));
    }
  } else if (c.tipo === 'aguardando') {
    selos.push(seloHtml('Aguardando sincronização', 'badge-amarelo', 'Tem nome + telefone; será vinculado na próxima sincronização'));
  } else {
    selos.push(seloHtml('Não cadastrado', 'badge-cinza', 'Pedido sem telefone reconhecido — não é agrupado pelo nome'));
    if (c.possiveisCorrespondencias > 0) {
      selos.push(seloHtml(`${c.possiveisCorrespondencias} possível(is) correspondência(s)`, 'badge-amarelo', 'Cadastros ou outros pedidos com o mesmo nome'));
    }
  }
  return selos.join('');
}

function seloHtml(texto, classe, titulo) {
  return `<span class="badge ${classe} selo-cliente" title="${escaparHtml(titulo)}">${escaparHtml(texto)}</span>`;
}

/** Telefone pra exibição — só números irlandeses são reconhecidos; o não reconhecido aparece cru, sinalizado */
function telefoneClienteHtml(telefone, naoReconhecido) {
  if (!telefone) return '—';
  if (naoReconhecido) return `${escaparHtml(telefone)} <small class="texto-secundario-ficha">(não reconhecido)</small>`;
  return escaparHtml(formatarTelefoneIrlandes(telefone));
}

function atualizarPaginacaoClientes() {
  const { offset, total } = estadoListaClientes;
  const paginacao = document.getElementById('paginacao-clientes');
  if (total <= TAMANHO_PAGINA_CLIENTES) {
    paginacao.style.display = 'none';
    return;
  }
  paginacao.style.display = '';
  const pagina = Math.floor(offset / TAMANHO_PAGINA_CLIENTES) + 1;
  const totalPaginas = Math.ceil(total / TAMANHO_PAGINA_CLIENTES);
  document.getElementById('rotulo-pagina-clientes').textContent = `Página ${pagina} de ${totalPaginas} · ${total} registros`;
  document.getElementById('botao-pagina-anterior-clientes').disabled = offset === 0;
  document.getElementById('botao-pagina-proxima-clientes').disabled = offset + TAMANHO_PAGINA_CLIENTES >= total;
}

// ---------------------------------------------------------------------------
// Ficha
// ---------------------------------------------------------------------------

function ligarEventosFichaCliente() {
  document.getElementById('botao-fechar-ficha-cliente').addEventListener('click', fecharFichaCliente);
  document.getElementById('botao-fechar-ficha-cliente-rodape').addEventListener('click', fecharFichaCliente);
  document.getElementById('modal-overlay-ficha-cliente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-ficha-cliente') fecharFichaCliente();
  });
  document.getElementById('ficha-cliente-corpo').addEventListener('click', (evento) => {
    if (evento.target.id === 'botao-carregar-mais-pedidos-ficha') {
      carregarMaisPedidosFicha();
      return;
    }
    const acao = evento.target.closest('[data-acao-ficha]');
    if (acao) {
      if (acao.dataset.acaoFicha === 'editar-eircode') abrirEdicaoEircode();
      else if (acao.dataset.acaoFicha === 'vincular-pedido') abrirVincularPedido();
      return;
    }
    const link = evento.target.closest('[data-abrir-cliente], [data-abrir-pedido]');
    if (!link) return;
    evento.preventDefault();
    if (link.dataset.abrirCliente) abrirFichaCliente({ clienteId: link.dataset.abrirCliente });
    else abrirFichaCliente({ pedidoId: link.dataset.abrirPedido });
  });
}

function fecharFichaCliente() {
  if (estadoOperacaoCliente.emAndamento) return; // edição/exclusão em andamento: espera terminar
  document.getElementById('modal-overlay-ficha-cliente').classList.remove('modal-visivel');
  estadoFichaCliente.seq++; // invalida qualquer carregamento em andamento
  estadoFichaCliente.aberta = false;
  estadoFichaCliente.alvo = null;
  estadoFichaCliente.dados = null;
  estadoFichaCliente.perfil = null;
  atualizarBotoesAcaoFichaCliente();
  // Tira ?pedido= / ?cliente= da URL pra um F5 não reabrir a ficha
  if (window.location.search) history.replaceState(null, '', window.location.pathname);
}

/** @param {{ clienteId?: string, pedidoId?: string }} alvo */
async function abrirFichaCliente(alvo) {
  if (!alvo || (!alvo.clienteId && !alvo.pedidoId)) return;
  const seq = ++estadoFichaCliente.seq; // dois cliques rápidos: só a última ficha pedida é exibida
  estadoFichaCliente.aberta = true;
  estadoFichaCliente.dados = null;
  estadoFichaCliente.perfil = null;
  atualizarBotoesAcaoFichaCliente(); // esconde Editar/Excluir enquanto a ficha carrega
  const corpo = document.getElementById('ficha-cliente-corpo');
  document.getElementById('ficha-cliente-titulo').textContent = 'Cliente';
  corpo.innerHTML = '<div class="estado-vazio">Carregando ficha...</div>';
  document.getElementById('modal-overlay-ficha-cliente').classList.add('modal-visivel');

  let ficha;
  try {
    ficha = await getCustomerDetail({ ...alvo, limite: TAMANHO_PAGINA_PEDIDOS_FICHA, offset: 0 });
  } catch (erro) {
    if (seq !== estadoFichaCliente.seq) return;
    console.error('Erro ao carregar ficha do cliente:', erro);
    corpo.innerHTML = `<div class="estado-vazio">Não foi possível carregar a ficha. ${escaparHtml(erro.message)}</div>`;
    return;
  }
  if (seq !== estadoFichaCliente.seq) return;

  // Ficha por pedido vinculado vira ficha do cliente: "carregar mais"/atualizar passam a usar o id do cadastro
  estadoFichaCliente.alvo = ficha.cadastrado && ficha.cliente.id ? { clienteId: ficha.cliente.id } : alvo;
  estadoFichaCliente.cadastrado = ficha.cadastrado;
  estadoFichaCliente.dados = ficha;
  estadoFichaCliente.pedidos = ficha.pedidos;
  estadoFichaCliente.totalPedidos = ficha.totalPedidos;

  document.getElementById('ficha-cliente-titulo').textContent = ficha.cliente.nome || 'Não informado';
  corpo.innerHTML = fichaClienteHtml(ficha);
  corpo.scrollTop = 0;
  atualizarBotoesAcaoFichaCliente();
  if (ficha.cadastrado && ficha.cliente.id) carregarPerfilFichaCliente(ficha.cliente.id, seq);
}

/** Eircode vem de admin_get_customer_profile (get_customer_detail não o devolve). Falha aqui não derruba a ficha. */
async function carregarPerfilFichaCliente(clienteId, seq) {
  let perfil;
  try {
    perfil = await getCustomerProfile(clienteId);
  } catch (erro) {
    if (seq !== estadoFichaCliente.seq) return;
    console.error('Erro ao carregar o perfil do cliente:', erro);
    atualizarLinhaEircodeFicha(null, 'Não foi possível carregar o Eircode.');
    return;
  }
  if (seq !== estadoFichaCliente.seq) return;
  estadoFichaCliente.perfil = perfil;
  atualizarLinhaEircodeFicha(perfil, null);
}

function atualizarLinhaEircodeFicha(perfil, mensagemErro) {
  const valor = document.getElementById('valor-eircode-ficha');
  const botao = document.getElementById('botao-editar-eircode-ficha');
  if (!valor) return;
  if (mensagemErro) {
    valor.textContent = mensagemErro;
    if (botao) botao.disabled = true;
    return;
  }
  valor.textContent = perfil && perfil.eircode ? formatarEircode(perfil.eircode) : 'Não informado';
  if (botao) botao.disabled = false;
}

/** Ficha de um cadastro que pode ser editado/excluído: cadastrado, com id e não arquivado */
function fichaPermiteEdicao(ficha) {
  return !!(ficha && ficha.cadastrado && ficha.cliente.id && ficha.cliente.status !== 'archived');
}

/** Editar/Excluir só aparecem na ficha de um cadastro ativo já carregada; desabilitados durante uma operação */
function atualizarBotoesAcaoFichaCliente() {
  const visivel = estadoFichaCliente.aberta && fichaPermiteEdicao(estadoFichaCliente.dados);
  ['botao-editar-cliente', 'botao-excluir-cliente'].forEach((id) => {
    const botao = document.getElementById(id);
    botao.style.display = visivel ? '' : 'none';
    botao.disabled = estadoOperacaoCliente.emAndamento;
  });
  document.getElementById('botao-fechar-ficha-cliente').disabled = estadoOperacaoCliente.emAndamento;
  document.getElementById('botao-fechar-ficha-cliente-rodape').disabled = estadoOperacaoCliente.emAndamento;
}

async function carregarMaisPedidosFicha() {
  const { alvo, seq } = estadoFichaCliente;
  if (!alvo) return;
  const botao = document.getElementById('botao-carregar-mais-pedidos-ficha');
  botao.disabled = true;
  botao.textContent = 'Carregando...';
  let ficha;
  try {
    ficha = await getCustomerDetail({ ...alvo, limite: TAMANHO_PAGINA_PEDIDOS_FICHA, offset: estadoFichaCliente.pedidos.length });
  } catch (erro) {
    if (seq !== estadoFichaCliente.seq) return;
    mostrarToast('Não foi possível carregar mais pedidos. ' + erro.message, 'erro');
    botao.disabled = false;
    botao.textContent = 'Carregar mais';
    return;
  }
  if (seq !== estadoFichaCliente.seq) return; // ficha fechada/trocada no meio do carregamento
  estadoFichaCliente.pedidos = estadoFichaCliente.pedidos.concat(ficha.pedidos);
  estadoFichaCliente.totalPedidos = ficha.totalPedidos;
  document.getElementById('lista-pedidos-ficha-cliente').innerHTML = pedidosFichaHtml();
}

const ROTULOS_ORIGEM_CADASTRO = { backfill: 'migração inicial', auto_phone: 'automático (nome + telefone)', admin: 'administrador' };

function fichaClienteHtml(ficha) {
  const moeda = obterConfiguracoes().moeda;
  const { cliente, metricas } = ficha;

  let blocoSituacao;
  if (ficha.cadastrado) {
    const arquivado = cliente.status === 'archived';
    blocoSituacao = `
      ${arquivado ? '<p class="aviso-info"><strong>Cadastro excluído (arquivado).</strong> Os pedidos deste cliente foram desvinculados e aparecem como Cliente não cadastrado. Este cadastro não pode mais ser editado.</p>' : ''}
      <p>${arquivado ? '<span class="badge badge-cinza">Arquivado</span>' : '<span class="badge badge-verde">Cadastrado</span>'}
        <small class="texto-secundario-ficha">desde ${escaparHtml(formatarData(cliente.cadastradoEm) || '—')} · origem: ${escaparHtml(ROTULOS_ORIGEM_CADASTRO[cliente.origem] || cliente.origem || '—')}</small></p>
      <p>Telefone: ${cliente.telefone ? telefoneClienteHtml(cliente.telefone, false) : 'Não informado'}</p>
      <p class="linha-eircode-ficha">Eircode: <span id="valor-eircode-ficha">carregando…</span>
        ${arquivado ? '' : '<button type="button" class="btn btn-secundario btn-compacto-cliente" id="botao-editar-eircode-ficha" data-acao-ficha="editar-eircode" disabled>Editar Eircode</button>'}</p>`;
  } else {
    let motivo;
    if (ficha.aguardandoSincronizacao) {
      motivo = 'Este pedido tem nome e telefone irlandês válidos e será vinculado automaticamente na próxima sincronização (clique em Atualizar).';
    } else if (ficha.desvinculado) {
      motivo = 'Este pedido foi desvinculado por um administrador e não é vinculado automaticamente.';
    } else if (ficha.telefoneNaoReconhecido) {
      motivo = 'O telefone informado não foi reconhecido como número irlandês.';
    } else {
      motivo = 'O pedido não tem telefone.';
    }
    blocoSituacao = `
      <p class="aviso-info"><strong>Não cadastrado.</strong> ${escaparHtml(motivo)} A ficha mostra só este pedido, que não é agrupado com outros pelo nome nem entra nas métricas de clientes. Para vinculá-lo manualmente, abra a ficha do cliente e use "Vincular pedido" em Histórico de vínculos.</p>
      <p>Telefone: ${cliente.telefone ? telefoneClienteHtml(cliente.telefone, ficha.telefoneNaoReconhecido) : 'Não informado'}</p>`;
  }

  const extrasMetricas = [
    metricas.qtdCancelados > 0 ? `${metricas.qtdCancelados} cancelado(s)` : '',
    metricas.qtdEmAndamento > 0 ? `${metricas.qtdEmAndamento} em andamento` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const produtos =
    ficha.produtosMaisComprados.length > 0
      ? ficha.produtosMaisComprados
          .map(
            (p) =>
              `<div class="linha-resumo"><span>${p.quantidade}x ${escaparHtml(p.nome)} <small class="texto-secundario-ficha">(${p.qtdPedidos} ${p.qtdPedidos === 1 ? 'pedido' : 'pedidos'})</small></span><span>${formatarMoeda(p.valorEmItens, moeda)}</span></div>`
          )
          .join('') + '<p class="texto-secundario-ficha">Valor em itens: antes de cupons e sem taxa de entrega.</p>'
      : '<p class="texto-secundario-ficha">Nenhum pedido finalizado ainda.</p>';

  return `
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Informações</div>
      ${blocoSituacao}
      <p>Primeira compra: ${escaparHtml(formatarData(cliente.primeiraCompraEm) || '—')} · Última compra: ${escaparHtml(formatarData(cliente.ultimaCompraEm) || '—')}</p>
    </div>
    ${alertasFichaHtml(ficha)}
    <div class="grade-metricas-ficha">
      <div class="card cartao-indicador-cliente">
        <span class="cartao-indicador-rotulo">Pedidos finalizados</span>
        <strong class="cartao-indicador-valor">${metricas.qtdPedidos}</strong>
      </div>
      <div class="card cartao-indicador-cliente">
        <span class="cartao-indicador-rotulo">Total gasto</span>
        <strong class="cartao-indicador-valor">${formatarMoeda(metricas.totalGasto, moeda)}</strong>
      </div>
      <div class="card cartao-indicador-cliente">
        <span class="cartao-indicador-rotulo">Ticket médio</span>
        <strong class="cartao-indicador-valor">${formatarMoeda(metricas.ticketMedio, moeda)}</strong>
      </div>
    </div>
    ${extrasMetricas ? `<p class="texto-secundario-ficha">Fora das métricas: ${escaparHtml(extrasMetricas)}</p>` : ''}
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Produtos mais comprados</div>
      ${produtos}
    </div>
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Histórico de compras</div>
      <div id="lista-pedidos-ficha-cliente">${pedidosFichaHtml()}</div>
    </div>
    ${auditoriaFichaHtml(ficha.auditoria, fichaPermiteEdicao(ficha))}`;
}

/** Alertas de possíveis duplicidades — cada item abre a outra ficha, nada é somado a esta */
function alertasFichaHtml(ficha) {
  const blocos = [
    { titulo: 'Nome repetido', texto: 'Outro cadastro com o mesmo nome — tratados como clientes diferentes.', itens: ficha.mesmoNome },
    {
      titulo: 'Telefone compartilhado / possível vínculo',
      texto: ficha.cadastrado ? 'Outro cadastro com o mesmo telefone e outro nome — não agrupado automaticamente.' : 'Cadastro(s) com o mesmo telefone deste pedido.',
      itens: ficha.telefoneCompartilhado,
    },
    {
      titulo: 'Possíveis correspondências',
      texto: ficha.cadastrado
        ? 'Pedidos não cadastrados com o mesmo nome — não foram associados porque não têm telefone que confirme.'
        : 'Cadastros e pedidos com o mesmo nome — nenhum foi associado automaticamente.',
      itens: ficha.possiveisCorrespondencias,
    },
  ].filter((b) => b.itens.length > 0);

  return blocos
    .map(
      (b) => `
      <div class="detalhe-pedido-secao alerta-ficha-cliente">
        <div class="detalhe-pedido-titulo">${escaparHtml(b.titulo)}</div>
        <p class="texto-secundario-ficha">${escaparHtml(b.texto)}</p>
        <ul class="lista-relacionados-ficha">${b.itens.map(itemRelacionadoFichaHtml).join('')}</ul>
      </div>`
    )
    .join('');
}

function itemRelacionadoFichaHtml(r) {
  const moeda = obterConfiguracoes().moeda;
  let detalhes;
  if (r.tipo === 'cadastrado') {
    detalhes = [
      'cadastrado',
      r.telefone ? escaparHtml(formatarTelefoneIrlandes(r.telefone)) : '',
      r.qtdPedidos != null ? `${r.qtdPedidos} ${r.qtdPedidos === 1 ? 'pedido finalizado' : 'pedidos finalizados'}` : '',
    ];
  } else {
    detalhes = [
      r.tipo === 'aguardando' ? 'aguardando sincronização' : 'não cadastrado',
      r.numeroPedido ? escaparHtml(r.numeroPedido) : '',
      r.ultimoPedidoEm ? escaparHtml(formatarData(r.ultimoPedidoEm)) : '',
      r.status ? escaparHtml(ROTULOS_STATUS_PEDIDO[r.status] || r.status) : '',
      r.total != null ? formatarMoeda(r.total, moeda) : '',
      r.telefone ? escaparHtml(r.telefone) : 'sem telefone',
    ];
  }
  const atributo = r.tipo === 'cadastrado' ? `data-abrir-cliente="${escaparHtml(r.clienteId)}"` : `data-abrir-pedido="${escaparHtml(r.pedidoId)}"`;
  const href = r.tipo === 'cadastrado' ? `clientes.html?cliente=${encodeURIComponent(r.clienteId)}` : `clientes.html?pedido=${encodeURIComponent(r.pedidoId)}`;
  return `<li><a href="${href}" ${atributo}>${escaparHtml(r.nome || 'Não informado')}</a> <small class="texto-secundario-ficha">${detalhes.filter(Boolean).join(' · ')}</small></li>`;
}

const CLASSE_BADGE_STATUS_FICHA = { finalizado: 'badge-verde', cancelado: 'badge-vermelho' };

function pedidosFichaHtml() {
  const moeda = obterConfiguracoes().moeda;
  const { pedidos, totalPedidos } = estadoFichaCliente;
  if (pedidos.length === 0) return '<p class="texto-secundario-ficha">Nenhum pedido.</p>';

  const cartoes = pedidos
    .map((p) => {
      const classeBadge = CLASSE_BADGE_STATUS_FICHA[p.status] || 'badge-amarelo';
      const itens = p.itens.map((item) => itemPedidoFichaHtml(item, moeda)).join('');
      const cancelamento =
        p.status === STATUS_PEDIDO.CANCELADO && p.motivoCancelamento ? `<p class="texto-secundario-ficha">Motivo: ${escaparHtml(p.motivoCancelamento)}</p>` : '';
      return `
        <div class="pedido-ficha-cliente">
          <div class="pedido-ficha-cliente-cabecalho">
            <strong>${escaparHtml(p.numero)}</strong>
            <span class="texto-secundario-ficha">${escaparHtml(formatarData(p.criadoEm))} ${escaparHtml(formatarHora(p.criadoEm))}</span>
            <span class="badge ${classeBadge}">${escaparHtml(ROTULOS_STATUS_PEDIDO[p.status] || p.status)}</span>
            <strong class="pedido-ficha-cliente-total">${formatarMoeda(p.total, moeda)}</strong>
          </div>
          ${itens}
          ${cancelamento}
        </div>`;
    })
    .join('');

  const restantes = totalPedidos - pedidos.length;
  const botaoMais =
    restantes > 0 && estadoFichaCliente.cadastrado
      ? `<button type="button" class="btn btn-secundario" id="botao-carregar-mais-pedidos-ficha">Carregar mais (${restantes})</button>`
      : '';
  return cartoes + botaoMais;
}

/** Item do pedido na ficha — combos listam espetos/acompanhamentos/inclusos (mesma leitura de historico.js) */
function itemPedidoFichaHtml(item, moeda) {
  const linha = `<div class="linha-resumo"><span>${item.quantidade}x ${escaparHtml(item.nome)}</span><span>${formatarMoeda(item.valorTotal, moeda)}</span></div>`;
  if (item.tipoItem !== 'combo' || item.selecoes.length === 0) return linha;

  const grupo = (tipo, rotulo) => {
    const lis = item.selecoes
      .filter((s) => s.tipoSelecao === tipo)
      .map(
        (s) =>
          `<li>${s.quantidade > 1 ? s.quantidade + 'x ' : ''}${escaparHtml(s.nome)}${s.acrescimoUnitario > 0 ? ` (+${formatarMoeda(s.acrescimoUnitario * s.quantidade, moeda)})` : ''}</li>`
      )
      .join('');
    return lis ? `<div class="detalhe-combo-pedido-grupo"><span class="detalhe-combo-pedido-rotulo">${rotulo}</span><ul>${lis}</ul></div>` : '';
  };

  return linha + grupo('skewer', 'Espeto') + grupo('side', 'Acompanhamento') + grupo('included', 'Incluso');
}

const ROTULOS_ACAO_AUDITORIA = {
  backfill: 'Vinculado na migração inicial (nome + telefone)',
  auto_link: 'Vinculado automaticamente (nome + telefone)',
  customer_created: 'Cadastro criado',
  link: 'Vinculado manualmente',
  unlink: 'Desvinculado',
  order_deleted: 'Pedido excluído (vínculo removido)',
  link_deleted: 'Vínculo removido',
  customer_updated: 'Cliente editado',
  customer_archived: 'Cliente arquivado',
};

const ROTULOS_ALTERACAO_EIRCODE = { added: 'Eircode incluído', changed: 'Eircode alterado', removed: 'Eircode removido' };

/** Rótulo do evento, com os detalhes que a auditoria guarda (nunca o texto do Eircode) */
function rotuloEventoAuditoria(e) {
  const d = e.detalhes || {};
  if (e.acao === 'customer_updated' && d.field === 'eircode') return ROTULOS_ALTERACAO_EIRCODE[d.change] || 'Eircode alterado';
  if (e.acao === 'customer_created' && d.manual) return 'Cadastro criado manualmente';
  if (e.acao === 'link' && d.reactivated) return 'Vinculado manualmente (pedido reativado)';
  return ROTULOS_ACAO_AUDITORIA[e.acao] || e.acao;
}

/**
 * "Histórico de vínculos" — últimos 20 eventos da auditoria (somente inclusão, no banco). Em cadastro
 * ativo aparece sempre (mesmo sem eventos), com o botão "Vincular pedido".
 */
function auditoriaFichaHtml(eventos, permitirVincular) {
  const lista = eventos || [];
  if (lista.length === 0 && !permitirVincular) return '';
  const itens = lista
    .map((e) => {
      const autor = e.autorId ? 'admin ' + escaparHtml(String(e.autorId).slice(0, 8)) : 'sistema';
      const pedido = e.numeroPedido ? ' · ' + escaparHtml(e.numeroPedido) : '';
      const motivo = e.motivo ? ` · motivo: ${escaparHtml(e.motivo)}` : '';
      return `<li><strong>${escaparHtml(rotuloEventoAuditoria(e))}</strong>${pedido}
        <small class="texto-secundario-ficha">${escaparHtml(formatarData(e.em))} ${escaparHtml(formatarHora(e.em))} · por ${autor}${motivo}</small></li>`;
    })
    .join('');
  const botao = permitirVincular
    ? '<button type="button" class="btn btn-secundario btn-compacto-cliente" data-acao-ficha="vincular-pedido">Vincular pedido</button>'
    : '';
  return `
    <div class="detalhe-pedido-secao">
      <div class="titulo-com-acao-ficha">
        <div class="detalhe-pedido-titulo">Histórico de vínculos</div>
        ${botao}
      </div>
      ${itens ? `<ul class="lista-auditoria-ficha">${itens}</ul>` : '<p class="texto-secundario-ficha">Nenhum evento registrado ainda.</p>'}
    </div>`;
}

// ---------------------------------------------------------------------------
// Edição e exclusão (arquivamento) manual de um cadastro — sempre um cliente por vez,
// a partir da ficha aberta. Toda validação de permissão, duplicidade e telefone acontece
// no banco (admin_update_customer / admin_archive_customer); aqui só UX.
// ---------------------------------------------------------------------------

const BOTOES_MODAIS_OPERACAO_CLIENTE = [
  'botao-salvar-editar-cliente',
  'botao-cancelar-editar-cliente',
  'botao-fechar-editar-cliente',
  'botao-confirmar-excluir-cliente',
  'botao-cancelar-excluir-cliente',
  'botao-fechar-excluir-cliente',
];

function ligarEventosEdicaoExclusaoCliente() {
  document.getElementById('botao-editar-cliente').addEventListener('click', abrirEdicaoCliente);
  document.getElementById('botao-excluir-cliente').addEventListener('click', abrirExclusaoCliente);

  document.getElementById('form-editar-cliente').addEventListener('submit', (evento) => {
    evento.preventDefault();
    salvarEdicaoCliente();
  });
  document.getElementById('botao-cancelar-editar-cliente').addEventListener('click', fecharEdicaoCliente);
  document.getElementById('botao-fechar-editar-cliente').addEventListener('click', fecharEdicaoCliente);
  document.getElementById('modal-overlay-editar-cliente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-editar-cliente') fecharEdicaoCliente();
  });

  document.getElementById('botao-confirmar-excluir-cliente').addEventListener('click', confirmarExclusaoCliente);
  document.getElementById('botao-cancelar-excluir-cliente').addEventListener('click', fecharExclusaoCliente);
  document.getElementById('botao-fechar-excluir-cliente').addEventListener('click', fecharExclusaoCliente);
  document.getElementById('modal-overlay-excluir-cliente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-excluir-cliente') fecharExclusaoCliente();
  });
}

/** Liga/desliga o estado "operação em andamento": desabilita botões da ficha e dos modais (evita clique repetido) */
function definirOperacaoCliente(ativa) {
  estadoOperacaoCliente.emAndamento = ativa;
  BOTOES_MODAIS_OPERACAO_CLIENTE.forEach((id) => {
    document.getElementById(id).disabled = ativa;
  });
  document.getElementById('campo-editar-cliente-nome').disabled = ativa;
  document.getElementById('campo-editar-cliente-telefone').disabled = ativa;
  atualizarBotoesAcaoFichaCliente();
}

function mostrarErroOperacaoCliente(idElemento, mensagem) {
  const elemento = document.getElementById(idElemento);
  elemento.textContent = mensagem || '';
  elemento.style.display = mensagem ? '' : 'none';
}

/** Recarrega indicadores e a página atual da lista (mantém busca/filtro/paginação) depois de editar/excluir */
async function recarregarListaEIndicadoresClientes() {
  await Promise.all([carregarIndicadoresClientes(), carregarListaClientes()]);
  document.getElementById('texto-atualizacao-clientes').textContent = 'Atualizado às ' + formatarHora(new Date().toISOString());
}

/** Mensagem amigável para o erro do banco, sempre preservando o texto original para diagnóstico */
function mensagemErroEdicaoCliente(erro) {
  const original = (erro && erro.message) || 'erro desconhecido';
  if (/duplic|j[áa] existe|already exists|unique|23505/i.test(original)) {
    return `Já existe outro cadastro ativo com este nome e telefone. Os cadastros NÃO foram mesclados — ajuste o nome ou o telefone, ou revise o outro cadastro. (${original})`;
  }
  if (/acesso negado|permission denied|not authorized|insufficient/i.test(original)) {
    return `Sem permissão para alterar clientes. Entre novamente como administrador. (${original})`;
  }
  if (/telefone|phone/i.test(original)) {
    return `Telefone não aceito: informe um número irlandês (ex.: 087 123 4567) ou deixe o campo vazio para remover. (${original})`;
  }
  return `Não foi possível salvar as alterações. (${original})`;
}

// --- Editar ------------------------------------------------------------------

function abrirEdicaoCliente() {
  const ficha = estadoFichaCliente.dados;
  if (!fichaPermiteEdicao(ficha) || estadoOperacaoCliente.emAndamento) return;

  document.getElementById('campo-editar-cliente-nome').value = ficha.cliente.nome || '';
  document.getElementById('campo-editar-cliente-telefone').value = ficha.cliente.telefone ? formatarTelefoneIrlandes(ficha.cliente.telefone) : '';
  document.getElementById('erro-editar-cliente-nome').textContent = '';
  mostrarErroOperacaoCliente('erro-editar-cliente', '');
  document.getElementById('modal-overlay-editar-cliente').classList.add('modal-visivel');
  document.getElementById('campo-editar-cliente-nome').focus();
}

function fecharEdicaoCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  document.getElementById('modal-overlay-editar-cliente').classList.remove('modal-visivel');
}

async function salvarEdicaoCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  const ficha = estadoFichaCliente.dados;
  if (!fichaPermiteEdicao(ficha)) {
    mostrarErroOperacaoCliente('erro-editar-cliente', 'Este cadastro não pode mais ser editado. Feche e abra a ficha novamente.');
    return;
  }

  const clienteId = ficha.cliente.id;
  const nome = document.getElementById('campo-editar-cliente-nome').value.trim();
  const telefone = document.getElementById('campo-editar-cliente-telefone').value.trim();

  document.getElementById('erro-editar-cliente-nome').textContent = '';
  mostrarErroOperacaoCliente('erro-editar-cliente', '');
  if (!nome) {
    document.getElementById('erro-editar-cliente-nome').textContent = 'Informe o nome do cliente.';
    document.getElementById('campo-editar-cliente-nome').focus();
    return;
  }

  // Nada mudou (mesmo nome; mesmos dígitos de telefone): não chama o banco nem gera auditoria
  const digitos = (valor) => String(valor || '').replace(/\D/g, '');
  if (nome === (ficha.cliente.nome || '') && digitos(telefone) === digitos(ficha.cliente.telefone)) {
    fecharEdicaoCliente();
    mostrarToast('Nenhuma alteração para salvar.', 'info');
    return;
  }

  const botaoSalvar = document.getElementById('botao-salvar-editar-cliente');
  const textoOriginal = botaoSalvar.textContent;
  definirOperacaoCliente(true);
  botaoSalvar.textContent = 'Salvando…';

  try {
    await updateCustomer({ clienteId, nome, telefone });
  } catch (erro) {
    console.error('Erro ao editar cliente:', erro);
    mostrarErroOperacaoCliente('erro-editar-cliente', mensagemErroEdicaoCliente(erro));
    return; // modal continua aberto, com os dados digitados, para corrigir
  } finally {
    definirOperacaoCliente(false);
    botaoSalvar.textContent = textoOriginal;
  }

  fecharEdicaoCliente();
  mostrarToast(telefone ? 'Cliente atualizado.' : 'Cliente atualizado (sem telefone no cadastro).', 'sucesso');
  // Ficha, tabela e indicadores relidos do banco — pedidos e vínculos não mudam com a edição
  abrirFichaCliente({ clienteId });
  recarregarListaEIndicadoresClientes();
}

// --- Excluir (arquivar) ------------------------------------------------------

function abrirExclusaoCliente() {
  const ficha = estadoFichaCliente.dados;
  if (!fichaPermiteEdicao(ficha) || estadoOperacaoCliente.emAndamento) return;

  document.getElementById('excluir-cliente-nome').textContent = ficha.cliente.nome || 'Não informado';
  mostrarErroOperacaoCliente('erro-excluir-cliente', '');
  document.getElementById('modal-overlay-excluir-cliente').classList.add('modal-visivel');
  document.getElementById('botao-cancelar-excluir-cliente').focus(); // foco na opção segura
}

function fecharExclusaoCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  document.getElementById('modal-overlay-excluir-cliente').classList.remove('modal-visivel');
}

async function confirmarExclusaoCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  const ficha = estadoFichaCliente.dados;
  if (!fichaPermiteEdicao(ficha)) {
    mostrarErroOperacaoCliente('erro-excluir-cliente', 'Este cadastro não pode mais ser excluído. Feche e abra a ficha novamente.');
    return;
  }

  const clienteId = ficha.cliente.id;
  const nome = ficha.cliente.nome || 'Cliente';
  const botaoConfirmar = document.getElementById('botao-confirmar-excluir-cliente');
  const textoOriginal = botaoConfirmar.textContent;
  definirOperacaoCliente(true);
  botaoConfirmar.textContent = 'Excluindo…';
  mostrarErroOperacaoCliente('erro-excluir-cliente', '');

  let resultado;
  try {
    resultado = await archiveCustomer(clienteId);
  } catch (erro) {
    console.error('Erro ao excluir (arquivar) cliente:', erro);
    // Erro: confirmação e ficha continuam abertas; nada foi alterado no cadastro
    mostrarErroOperacaoCliente('erro-excluir-cliente', `Não foi possível excluir o cliente. Nenhum dado foi alterado. (${erro.message})`);
    return;
  } finally {
    definirOperacaoCliente(false);
    botaoConfirmar.textContent = textoOriginal;
  }

  fecharExclusaoCliente();
  fecharFichaCliente();
  const n = resultado.pedidosDesvinculados;
  mostrarToast(
    `"${nome}" foi excluído do cadastro. ` +
      (n > 0
        ? `${n} ${n === 1 ? 'pedido foi mantido' : 'pedidos foram mantidos'} no histórico como Cliente não cadastrado.`
        : 'Nenhum pedido estava vinculado.'),
    'sucesso'
  );
  recarregarListaEIndicadoresClientes();
}

// ---------------------------------------------------------------------------
// Mensagens comuns das operações novas (cadastro, Eircode, vinculação). O banco devolve
// `codigo` (HINT larica:*); erro de banco = transação desfeita = nada gravado. Falha de rede =
// "não confirmado" (pode ter sido gravado): a tela relê o estado antes de nova tentativa.
// ---------------------------------------------------------------------------

function mensagemErroComumCliente(erro, acao) {
  if (erro.falhaRede) {
    return `Não foi possível confirmar ${acao} (falha de conexão). Confira a situação atual antes de tentar de novo.`;
  }
  if (erro.codigo === 'busy') {
    return 'Outra operação está em andamento no cadastro (sincronização, edição ou exclusão). Nada foi gravado; tente novamente em alguns segundos.';
  }
  if (erro.codigo === 'forbidden' || /acesso negado|permission denied/i.test(erro.message || '')) {
    return `Sem permissão para esta operação. Entre novamente como administrador. (${erro.message})`;
  }
  return `Não foi possível concluir ${acao}. Nada foi gravado. (${erro.message})`;
}

function linkFichaNovaAbaHtml(clienteId, texto) {
  return `<a href="clientes.html?cliente=${encodeURIComponent(clienteId)}" target="_blank" rel="noopener">${escaparHtml(texto || 'Não informado')}</a>`;
}

// ---------------------------------------------------------------------------
// Cadastrar cliente: dados -> revisão (cada aviso de possível duplicidade confirmado) -> concluído.
// A revisão vem de admin_check_customer_duplicates; admin_create_customer recalcula tudo no banco.
// idTentativa: gerado ao entrar na revisão e reaproveitado nas repetições dessa mesma revisão
// (falha de rede depois do COMMIT não cria duplicado). Mudar os dados = nova revisão = novo id.
// ---------------------------------------------------------------------------

const IDS_BOTOES_CADASTRO_CLIENTE = [
  'botao-avancar-cadastrar-cliente',
  'botao-voltar-cadastrar-cliente',
  'botao-cancelar-cadastrar-cliente',
  'botao-fechar-cadastrar-cliente',
  'botao-abrir-ficha-cadastrado',
];
const IDS_CAMPOS_CADASTRO_CLIENTE = ['campo-cadastrar-cliente-nome', 'campo-cadastrar-cliente-telefone', 'campo-cadastrar-cliente-eircode'];
const MENSAGENS_CAMPO_CADASTRO_CLIENTE = {
  nome: { required: 'Informe o nome do cliente.', too_long: 'Nome muito longo (máximo de 120 caracteres).' },
  telefone: {
    required: 'Informe o telefone do cliente.',
    invalid: 'Telefone não reconhecido: informe um número irlandês (ex.: 087 123 4567).',
  },
  eircode: { invalid: 'Eircode inválido: use 7 letras/números (ex.: D03 FX92).' },
};

function ligarEventosCadastroCliente() {
  document.getElementById('botao-cadastrar-cliente').addEventListener('click', abrirCadastroCliente);
  document.getElementById('form-cadastrar-cliente').addEventListener('submit', (evento) => {
    evento.preventDefault();
    avancarCadastroCliente();
  });
  document.getElementById('botao-cancelar-cadastrar-cliente').addEventListener('click', fecharCadastroCliente);
  document.getElementById('botao-fechar-cadastrar-cliente').addEventListener('click', fecharCadastroCliente);
  document.getElementById('botao-voltar-cadastrar-cliente').addEventListener('click', () => {
    if (estadoOperacaoCliente.emAndamento) return;
    mostrarErroOperacaoCliente('erro-cadastrar-cliente', '');
    mostrarEtapaCadastroCliente('dados');
  });
  document.getElementById('botao-abrir-ficha-cadastrado').addEventListener('click', () => {
    const clienteId = estadoCadastroCliente.clienteCriadoId;
    fecharCadastroCliente();
    if (clienteId) abrirFichaCliente({ clienteId });
  });
  document.getElementById('modal-overlay-cadastrar-cliente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-cadastrar-cliente') fecharCadastroCliente();
  });
  const campoEircode = document.getElementById('campo-cadastrar-cliente-eircode');
  campoEircode.addEventListener('input', () => {
    campoEircode.value = formatarEircode(campoEircode.value);
  });
  document.getElementById('etapa-revisao-cadastro-cliente').addEventListener('change', (evento) => {
    if (evento.target.matches('input[data-aviso-cadastro]')) atualizarBotaoConfirmarCadastro();
  });
}

function abrirCadastroCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  Object.assign(estadoCadastroCliente, {
    aberto: true,
    etapa: 'dados',
    previa: null,
    dados: null,
    idTentativa: null,
    tentativaEncerrada: false,
    clienteCriadoId: null,
  });
  IDS_CAMPOS_CADASTRO_CLIENTE.forEach((id) => {
    document.getElementById(id).value = '';
  });
  mostrarErrosCamposCadastro({});
  mostrarErroOperacaoCliente('erro-cadastrar-cliente', '');
  mostrarEtapaCadastroCliente('dados');
  document.getElementById('modal-overlay-cadastrar-cliente').classList.add('modal-visivel');
  document.getElementById('campo-cadastrar-cliente-nome').focus();
}

function fecharCadastroCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  estadoCadastroCliente.aberto = false;
  document.getElementById('modal-overlay-cadastrar-cliente').classList.remove('modal-visivel');
}

function mostrarEtapaCadastroCliente(etapa) {
  estadoCadastroCliente.etapa = etapa;
  document.getElementById('etapa-dados-cadastro-cliente').style.display = etapa === 'dados' ? '' : 'none';
  document.getElementById('etapa-revisao-cadastro-cliente').style.display = etapa === 'revisao' ? '' : 'none';
  document.getElementById('etapa-concluido-cadastro-cliente').style.display = etapa === 'concluido' ? '' : 'none';
  const avancar = document.getElementById('botao-avancar-cadastrar-cliente');
  avancar.style.display = etapa === 'concluido' ? 'none' : '';
  avancar.textContent = etapa === 'revisao' ? 'Cadastrar cliente' : 'Continuar';
  document.getElementById('botao-voltar-cadastrar-cliente').style.display = etapa === 'revisao' ? '' : 'none';
  document.getElementById('botao-abrir-ficha-cadastrado').style.display = etapa === 'concluido' ? '' : 'none';
  document.getElementById('botao-cancelar-cadastrar-cliente').textContent = etapa === 'concluido' ? 'Fechar' : 'Cancelar';
  if (etapa === 'revisao') atualizarBotaoConfirmarCadastro();
}

/** Liga/desliga a operação do cadastro: trava botões, campos e confirmações (evita clique repetido) */
function definirOperacaoCadastro(ativa, textoBotao) {
  estadoOperacaoCliente.emAndamento = ativa;
  IDS_BOTOES_CADASTRO_CLIENTE.concat(IDS_CAMPOS_CADASTRO_CLIENTE).forEach((id) => {
    document.getElementById(id).disabled = ativa;
  });
  document.querySelectorAll('#etapa-revisao-cadastro-cliente input').forEach((caixa) => {
    caixa.disabled = ativa;
  });
  if (ativa) document.getElementById('botao-avancar-cadastrar-cliente').textContent = textoBotao;
  else mostrarEtapaCadastroCliente(estadoCadastroCliente.etapa); // restaura rótulos e o estado do botão
  atualizarBotoesAcaoFichaCliente();
}

/** erros: { nome?, telefone?, eircode? } com os códigos do banco (required | invalid | too_long) */
function mostrarErrosCamposCadastro(erros) {
  let primeiroCampo = null;
  ['nome', 'telefone', 'eircode'].forEach((campo) => {
    const codigo = erros[campo];
    const texto = codigo ? MENSAGENS_CAMPO_CADASTRO_CLIENTE[campo][codigo] || 'Valor inválido.' : '';
    document.getElementById('erro-cadastrar-cliente-' + campo).textContent = texto;
    if (texto && !primeiroCampo) primeiroCampo = campo;
  });
  if (primeiroCampo) document.getElementById('campo-cadastrar-cliente-' + primeiroCampo).focus();
}

function avancarCadastroCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  if (estadoCadastroCliente.etapa === 'dados') verificarCadastroCliente();
  else if (estadoCadastroCliente.etapa === 'revisao') confirmarCadastroCliente();
}

/** Etapa 1 -> 2: valida localmente (formato) e pede a prévia ao banco (validação definitiva + duplicidades) */
async function verificarCadastroCliente(mensagemRevisao) {
  const dados = estadoCadastroCliente.etapa === 'dados' || !estadoCadastroCliente.dados
    ? {
        nome: document.getElementById('campo-cadastrar-cliente-nome').value.trim(),
        telefone: document.getElementById('campo-cadastrar-cliente-telefone').value.trim(),
        eircode: document.getElementById('campo-cadastrar-cliente-eircode').value.trim(),
      }
    : estadoCadastroCliente.dados;

  mostrarErrosCamposCadastro({});
  mostrarErroOperacaoCliente('erro-cadastrar-cliente', '');
  const errosLocais = {};
  if (!dados.nome) errosLocais.nome = 'required';
  if (!dados.telefone) errosLocais.telefone = 'required';
  if (dados.eircode && !validarFormatoEircode(dados.eircode)) errosLocais.eircode = 'invalid';
  if (Object.keys(errosLocais).length > 0) {
    mostrarEtapaCadastroCliente('dados');
    mostrarErrosCamposCadastro(errosLocais);
    return;
  }

  definirOperacaoCadastro(true, 'Verificando…');
  let previa;
  try {
    previa = await checkCustomerDuplicates(dados);
  } catch (erro) {
    console.error('Erro ao verificar duplicidades do cliente:', erro);
    definirOperacaoCadastro(false);
    mostrarErroOperacaoCliente('erro-cadastrar-cliente', mensagemErroComumCliente(erro, 'a verificação'));
    return;
  }
  definirOperacaoCadastro(false);
  if (!estadoCadastroCliente.aberto) return;

  if (!previa.valido) {
    mostrarEtapaCadastroCliente('dados');
    mostrarErrosCamposCadastro(previa.erros);
    return;
  }

  estadoCadastroCliente.dados = dados;
  estadoCadastroCliente.previa = previa;
  estadoCadastroCliente.idTentativa = gerarId();
  estadoCadastroCliente.tentativaEncerrada = false;
  document.getElementById('etapa-revisao-cadastro-cliente').innerHTML = revisaoCadastroClienteHtml(previa);
  mostrarEtapaCadastroCliente('revisao');
  if (mensagemRevisao) mostrarErroOperacaoCliente('erro-cadastrar-cliente', mensagemRevisao);
}

function revisaoCadastroClienteHtml(previa) {
  const n = previa.normalizado;
  const resumo = `
    <div class="resumo-cadastro-cliente">
      <p><strong>${escaparHtml(n.nome)}</strong></p>
      <p>Telefone: ${escaparHtml(formatarTelefoneIrlandes(n.telefone))}</p>
      <p>Eircode: ${n.eircode ? escaparHtml(formatarEircode(n.eircode)) : 'Não informado'}</p>
    </div>`;

  if (previa.duplicidadeExata) {
    const d = previa.duplicidadeExata;
    return `${resumo}
      <div class="aviso-erro-cliente">
        <strong>Este cliente já está cadastrado.</strong> Já existe um cadastro ativo com o mesmo nome e telefone; nenhum cadastro novo será criado.
        <p>${linkFichaNovaAbaHtml(d.clienteId, 'Abrir o cadastro existente: ' + d.nome)}</p>
      </div>`;
  }

  const blocos = [];
  if (previa.avisos.includes('same_name')) {
    blocos.push(
      blocoAvisoCadastroHtml(
        'same_name',
        'Nome repetido',
        `${previa.totalMesmoNome} cadastro(s) ativo(s) com este nome e outro telefone (ou sem telefone). Homônimos são permitidos e os cadastros NÃO serão unidos.`,
        previa.mesmoNome,
        'Confirmo que é um cliente diferente e quero um cadastro separado.'
      )
    );
  }
  if (previa.avisos.includes('same_phone')) {
    blocos.push(
      blocoAvisoCadastroHtml(
        'same_phone',
        'Telefone compartilhado',
        `${previa.totalMesmoTelefone} cadastro(s) ativo(s) com este telefone e outro nome. Nenhum cadastro será unido.`,
        previa.mesmoTelefone,
        'Confirmo o cadastro mesmo com o telefone compartilhado.'
      )
    );
  }
  if (previa.avisos.includes('archived_identity')) {
    blocos.push(
      blocoAvisoCadastroHtml(
        'archived_identity',
        'Cadastro excluído com os mesmos dados',
        'Existe um cadastro excluído (arquivado) com o mesmo nome e telefone. Ele continua arquivado; um cadastro novo será criado.',
        previa.arquivadosMesmaIdentidade,
        'Confirmo a criação de um cadastro novo.'
      )
    );
  }

  const introducao =
    blocos.length === 0
      ? '<p class="aviso-info">Nenhuma possível duplicidade encontrada.</p>'
      : '<p>Revise as possíveis duplicidades. Cada aviso precisa ser confirmado para continuar.</p>';
  // Somente informativo: o cadastro não vincula nem reativa nenhum pedido
  const aguardando = previa.pedidosAguardandoSincronizacaoMesmaIdentidade;
  const desvinculados = previa.pedidosDesvinculadosMesmaIdentidade;
  const infoPedidos = [
    aguardando > 0
      ? `${aguardando} pedido(s) com este nome e telefone ainda sem vínculo serão vinculados pela sincronização automática.`
      : '',
    desvinculados > 0
      ? `${desvinculados} pedido(s) com este nome e telefone foram desvinculados anteriormente e continuarão desvinculados — só "Vincular pedido", com confirmação explícita, pode reativá-los.`
      : '',
  ]
    .filter(Boolean)
    .map((texto) => `<p class="texto-secundario-ficha">${escaparHtml(texto)}</p>`)
    .join('');
  return resumo + introducao + blocos.join('') + infoPedidos;
}

function blocoAvisoCadastroHtml(codigo, titulo, texto, itens, textoConfirmacao) {
  const lista = itens
    .map((c) => {
      const detalhes = [
        c.status === 'archived' ? 'arquivado' : 'ativo',
        c.telefone ? escaparHtml(formatarTelefoneIrlandes(c.telefone)) : 'sem telefone',
        c.cadastradoEm ? 'desde ' + escaparHtml(formatarData(c.cadastradoEm)) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<li>${linkFichaNovaAbaHtml(c.clienteId, c.nome)} <small class="texto-secundario-ficha">${detalhes}</small></li>`;
    })
    .join('');
  return `
    <div class="detalhe-pedido-secao alerta-ficha-cliente">
      <div class="detalhe-pedido-titulo">${escaparHtml(titulo)}</div>
      <p class="texto-secundario-ficha">${escaparHtml(texto)}</p>
      ${lista ? `<ul class="lista-relacionados-ficha">${lista}</ul>` : ''}
      <label class="confirmacao-cliente"><input type="checkbox" data-aviso-cadastro="${escaparHtml(codigo)}" /> <span>${escaparHtml(textoConfirmacao)}</span></label>
    </div>`;
}

function atualizarBotaoConfirmarCadastro() {
  const botao = document.getElementById('botao-avancar-cadastrar-cliente');
  const previa = estadoCadastroCliente.previa;
  if (!previa || previa.duplicidadeExata || estadoCadastroCliente.tentativaEncerrada) {
    botao.disabled = true;
    return;
  }
  const caixas = Array.from(document.querySelectorAll('#etapa-revisao-cadastro-cliente input[data-aviso-cadastro]'));
  botao.disabled = estadoOperacaoCliente.emAndamento || caixas.some((caixa) => !caixa.checked);
}

/** Etapa 2 -> 3: cria o cadastro com os avisos confirmados (o banco recalcula e recusa se faltar algum) */
async function confirmarCadastroCliente() {
  const { previa, dados, idTentativa } = estadoCadastroCliente;
  if (!previa || previa.duplicidadeExata || !dados || estadoCadastroCliente.tentativaEncerrada) return;
  const caixas = Array.from(document.querySelectorAll('#etapa-revisao-cadastro-cliente input[data-aviso-cadastro]'));
  if (caixas.some((caixa) => !caixa.checked)) return;

  mostrarErroOperacaoCliente('erro-cadastrar-cliente', '');
  definirOperacaoCadastro(true, 'Cadastrando…');
  let resultado;
  try {
    resultado = await createCustomer({ ...dados, avisosConfirmados: previa.avisos, idTentativa });
  } catch (erro) {
    console.error('Erro ao cadastrar cliente:', erro);
    definirOperacaoCadastro(false);
    tratarErroCadastroCliente(erro);
    return;
  }
  definirOperacaoCadastro(false);

  estadoCadastroCliente.clienteCriadoId = resultado.clienteId;
  document.getElementById('etapa-concluido-cadastro-cliente').innerHTML = `
    <p class="aviso-info"><strong>${escaparHtml(resultado.nome)}</strong> ${
      resultado.jaCriado ? 'já tinha sido cadastrado nesta mesma tentativa — nenhum cadastro duplicado foi criado.' : 'foi cadastrado.'
    }</p>
    <p>Telefone: ${escaparHtml(formatarTelefoneIrlandes(resultado.telefone))} · Eircode: ${
      resultado.eircode ? escaparHtml(formatarEircode(resultado.eircode)) : 'Não informado'
    }</p>
    <p class="texto-secundario-ficha">Pedidos novos com este nome e telefone serão vinculados automaticamente. Para vincular pedidos já existentes, abra a ficha e use "Vincular pedido".</p>`;
  mostrarEtapaCadastroCliente('concluido');
  mostrarToast(resultado.jaCriado ? 'O cliente já estava cadastrado (nenhum duplicado criado).' : 'Cliente cadastrado.', 'sucesso');
  recarregarListaEIndicadoresClientes();
}

function tratarErroCadastroCliente(erro) {
  if (erro.codigo === 'confirmation_required') {
    // Outro cadastro surgiu depois da revisão: refaz a prévia com os mesmos dados (nova tentativa)
    verificarCadastroCliente('Os dados do cadastro mudaram desde a revisão (há novas possíveis duplicidades). Revise e confirme novamente. Nada foi gravado.');
    return;
  }
  if (erro.codigo === 'customer_exists') {
    verificarCadastroCliente('Já existe um cadastro ativo com este nome e telefone. Nenhum cadastro foi criado.');
    return;
  }
  if (erro.codigo === 'request_already_used') {
    // A tentativa já tinha criado um cadastro que depois foi arquivado/removido: nada novo é criado
    const d = erro.detalhes || {};
    estadoCadastroCliente.idTentativa = null;
    estadoCadastroCliente.tentativaEncerrada = true; // só uma nova revisão (Voltar -> Continuar) libera o botão
    document.getElementById('etapa-revisao-cadastro-cliente').insertAdjacentHTML(
      'beforeend',
      d.customer_id ? `<p>${linkFichaNovaAbaHtml(d.customer_id, 'Abrir o cadastro criado por esta tentativa')}</p>` : ''
    );
    mostrarErroOperacaoCliente('erro-cadastrar-cliente', `${erro.message}`);
    document.getElementById('botao-avancar-cadastrar-cliente').disabled = true;
    return;
  }
  if (erro.codigo === 'request_conflict') {
    // Mesmo id de tentativa com dados diferentes: começa uma revisão nova (novo id)
    verificarCadastroCliente('Os dados mudaram em relação à tentativa anterior. Revise e confirme novamente. Nada foi gravado.');
    return;
  }
  if (erro.codigo === 'invalid') {
    const d = erro.detalhes || {};
    mostrarEtapaCadastroCliente('dados');
    mostrarErrosCamposCadastro({ nome: d.name, telefone: d.phone, eircode: d.eircode });
    mostrarErroOperacaoCliente('erro-cadastrar-cliente', 'Revise os dados informados. Nenhum cadastro foi criado.');
    return;
  }
  if (erro.falhaRede) {
    // Mesmo idTentativa na próxima tentativa: se o cadastro já tiver sido criado, o banco devolve o mesmo
    mostrarErroOperacaoCliente(
      'erro-cadastrar-cliente',
      'Não foi possível confirmar o cadastro (falha de conexão). Clique em "Cadastrar cliente" novamente: se ele já tiver sido criado nesta tentativa, nenhum cadastro duplicado será gerado.'
    );
    return;
  }
  mostrarErroOperacaoCliente('erro-cadastrar-cliente', mensagemErroComumCliente(erro, 'o cadastro'));
}

// ---------------------------------------------------------------------------
// Eircode do cadastro (ficha de cadastro ativo). Só o Eircode muda; pedidos não são tocados.
// ---------------------------------------------------------------------------

const IDS_CONTROLES_EIRCODE_CLIENTE = [
  'campo-eircode-cliente',
  'botao-salvar-eircode-cliente',
  'botao-cancelar-eircode-cliente',
  'botao-fechar-eircode-cliente',
];

function ligarEventosEircodeCliente() {
  document.getElementById('form-eircode-cliente').addEventListener('submit', (evento) => {
    evento.preventDefault();
    salvarEircodeCliente();
  });
  document.getElementById('botao-cancelar-eircode-cliente').addEventListener('click', fecharEdicaoEircode);
  document.getElementById('botao-fechar-eircode-cliente').addEventListener('click', fecharEdicaoEircode);
  document.getElementById('modal-overlay-eircode-cliente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-eircode-cliente') fecharEdicaoEircode();
  });
  const campo = document.getElementById('campo-eircode-cliente');
  campo.addEventListener('input', () => {
    campo.value = formatarEircode(campo.value);
  });
}

function abrirEdicaoEircode() {
  const ficha = estadoFichaCliente.dados;
  const perfil = estadoFichaCliente.perfil;
  if (!fichaPermiteEdicao(ficha) || !perfil || estadoOperacaoCliente.emAndamento) return;
  document.getElementById('campo-eircode-cliente').value = perfil.eircode ? formatarEircode(perfil.eircode) : '';
  document.getElementById('erro-campo-eircode-cliente').textContent = '';
  mostrarErroOperacaoCliente('erro-eircode-cliente', '');
  document.getElementById('modal-overlay-eircode-cliente').classList.add('modal-visivel');
  document.getElementById('campo-eircode-cliente').focus();
}

function fecharEdicaoEircode() {
  if (estadoOperacaoCliente.emAndamento) return;
  document.getElementById('modal-overlay-eircode-cliente').classList.remove('modal-visivel');
}

function definirOperacaoEircode(ativa) {
  estadoOperacaoCliente.emAndamento = ativa;
  IDS_CONTROLES_EIRCODE_CLIENTE.forEach((id) => {
    document.getElementById(id).disabled = ativa;
  });
  document.getElementById('botao-salvar-eircode-cliente').textContent = ativa ? 'Salvando…' : 'Salvar Eircode';
  atualizarBotoesAcaoFichaCliente();
}

async function salvarEircodeCliente() {
  if (estadoOperacaoCliente.emAndamento) return;
  const ficha = estadoFichaCliente.dados;
  const perfil = estadoFichaCliente.perfil;
  if (!fichaPermiteEdicao(ficha) || !perfil) {
    mostrarErroOperacaoCliente('erro-eircode-cliente', 'Este cadastro não pode mais ser editado. Feche e abra a ficha novamente.');
    return;
  }

  const clienteId = ficha.cliente.id;
  const valor = document.getElementById('campo-eircode-cliente').value.trim();
  document.getElementById('erro-campo-eircode-cliente').textContent = '';
  mostrarErroOperacaoCliente('erro-eircode-cliente', '');
  if (valor && !validarFormatoEircode(valor)) {
    document.getElementById('erro-campo-eircode-cliente').textContent = MENSAGENS_CAMPO_CADASTRO_CLIENTE.eircode.invalid;
    return;
  }
  const compacto = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');
  if (compacto(valor) === compacto(perfil.eircode)) {
    fecharEdicaoEircode();
    mostrarToast('Nenhuma alteração para salvar.', 'info');
    return;
  }

  definirOperacaoEircode(true);
  let resultado;
  try {
    resultado = await updateCustomerEircode({ clienteId, eircode: valor });
  } catch (erro) {
    console.error('Erro ao salvar o Eircode:', erro);
    definirOperacaoEircode(false);
    if (erro.codigo === 'invalid') {
      document.getElementById('erro-campo-eircode-cliente').textContent = MENSAGENS_CAMPO_CADASTRO_CLIENTE.eircode.invalid;
      return;
    }
    if (erro.falhaRede || erro.codigo === 'customer_archived' || erro.codigo === 'customer_not_found') {
      // Estado incerto ou cadastro mudou: fecha e relê a ficha do banco
      fecharEdicaoEircode();
      mostrarToast(
        erro.falhaRede ? mensagemErroComumCliente(erro, 'o Eircode') : 'Este cadastro foi arquivado ou não existe mais. Nada foi gravado.',
        'erro'
      );
      abrirFichaCliente({ clienteId });
      return;
    }
    mostrarErroOperacaoCliente('erro-eircode-cliente', mensagemErroComumCliente(erro, 'o Eircode'));
    return;
  }
  definirOperacaoEircode(false);

  fecharEdicaoEircode();
  mostrarToast(!resultado.alterado ? 'Nenhuma alteração para salvar.' : resultado.eircode ? 'Eircode salvo.' : 'Eircode removido.', resultado.alterado ? 'sucesso' : 'info');
  abrirFichaCliente({ clienteId }); // relê Eircode e histórico de vínculos
}

// ---------------------------------------------------------------------------
// Vincular pedido (um por vez): pesquisa -> confirmação. Pedido de outro cliente nunca é
// selecionável; desvinculado (excluded) exige confirmar a reativação; divergências de nome,
// telefone e pedido cancelado exigem confirmação. O banco recalcula e exige tudo isso.
// ---------------------------------------------------------------------------

const IDS_BOTOES_VINCULAR_PEDIDO = [
  'botao-fechar-vincular-pedido',
  'botao-cancelar-vincular-pedido',
  'botao-voltar-vincular-pedido',
  'botao-confirmar-vincular-pedido',
  'botao-buscar-vincular-pedido',
  'botao-anterior-vincular-pedido',
  'botao-proxima-vincular-pedido',
  'campo-busca-vincular-pedido',
];
const ROTULOS_AVISO_VINCULO = { name_mismatch: 'Nome diferente', phone_mismatch: 'Telefone diferente ou ausente', order_cancelled: 'Pedido cancelado' };
const ROTULOS_ULTIMA_ACAO_DESVINCULO = {
  customer_archived: 'o cliente foi excluído (arquivado)',
  unlink: 'desvinculado manualmente',
  link_deleted: 'vínculo removido',
};

function ligarEventosVincularPedido() {
  document.getElementById('form-busca-vincular-pedido').addEventListener('submit', (evento) => {
    evento.preventDefault();
    if (estadoOperacaoCliente.emAndamento) return;
    estadoVincularPedido.busca = document.getElementById('campo-busca-vincular-pedido').value.trim();
    estadoVincularPedido.offset = 0;
    buscarPedidosParaVincular();
  });
  document.getElementById('botao-anterior-vincular-pedido').addEventListener('click', () => {
    estadoVincularPedido.offset = Math.max(0, estadoVincularPedido.offset - TAMANHO_PAGINA_VINCULAR_PEDIDO);
    buscarPedidosParaVincular();
  });
  document.getElementById('botao-proxima-vincular-pedido').addEventListener('click', () => {
    estadoVincularPedido.offset += TAMANHO_PAGINA_VINCULAR_PEDIDO;
    buscarPedidosParaVincular();
  });
  document.getElementById('resultados-vincular-pedido').addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-selecionar-pedido]');
    if (botao) selecionarPedidoParaVincular(botao.dataset.selecionarPedido);
  });
  document.getElementById('etapa-confirmar-vincular-pedido').addEventListener('change', atualizarBotaoConfirmarVinculo);
  document.getElementById('botao-cancelar-vincular-pedido').addEventListener('click', fecharVincularPedido);
  document.getElementById('botao-fechar-vincular-pedido').addEventListener('click', fecharVincularPedido);
  document.getElementById('botao-voltar-vincular-pedido').addEventListener('click', () => {
    if (estadoOperacaoCliente.emAndamento) return;
    mostrarErroOperacaoCliente('erro-vincular-pedido', '');
    mostrarEtapaVincularPedido('busca');
  });
  document.getElementById('botao-confirmar-vincular-pedido').addEventListener('click', confirmarVincularPedido);
  document.getElementById('modal-overlay-vincular-pedido').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-vincular-pedido') fecharVincularPedido();
  });
}

function abrirVincularPedido() {
  const ficha = estadoFichaCliente.dados;
  if (!fichaPermiteEdicao(ficha) || estadoOperacaoCliente.emAndamento) return;
  Object.assign(estadoVincularPedido, { aberto: true, clienteId: ficha.cliente.id, busca: '', offset: 0, total: 0, pedidos: [], selecionado: null });
  estadoVincularPedido.seq++;
  document.getElementById('vincular-pedido-titulo').textContent = 'Vincular pedido a ' + (ficha.cliente.nome || 'cliente');
  document.getElementById('campo-busca-vincular-pedido').value = '';
  document.getElementById('resultados-vincular-pedido').innerHTML =
    '<p class="texto-secundario-ficha">Pesquise pelo número do pedido (ex.: 123 ou #LARICA-123), pelo nome ou pelo telefone.</p>';
  document.getElementById('paginacao-vincular-pedido').style.display = 'none';
  mostrarErroOperacaoCliente('erro-vincular-pedido', '');
  mostrarEtapaVincularPedido('busca');
  document.getElementById('modal-overlay-vincular-pedido').classList.add('modal-visivel');
  document.getElementById('campo-busca-vincular-pedido').focus();
}

function fecharVincularPedido() {
  if (estadoOperacaoCliente.emAndamento) return;
  estadoVincularPedido.aberto = false;
  estadoVincularPedido.seq++; // descarta pesquisa em andamento
  document.getElementById('modal-overlay-vincular-pedido').classList.remove('modal-visivel');
}

function mostrarEtapaVincularPedido(etapa) {
  const confirmar = etapa === 'confirmar';
  document.getElementById('etapa-busca-vincular-pedido').style.display = confirmar ? 'none' : '';
  document.getElementById('etapa-confirmar-vincular-pedido').style.display = confirmar ? '' : 'none';
  document.getElementById('botao-voltar-vincular-pedido').style.display = confirmar ? '' : 'none';
  document.getElementById('botao-confirmar-vincular-pedido').style.display = confirmar ? '' : 'none';
  document.getElementById('botao-cancelar-vincular-pedido').textContent = confirmar ? 'Cancelar' : 'Fechar';
  if (confirmar) atualizarBotaoConfirmarVinculo();
  else estadoVincularPedido.selecionado = null;
}

function definirOperacaoVinculo(ativa) {
  estadoOperacaoCliente.emAndamento = ativa;
  IDS_BOTOES_VINCULAR_PEDIDO.forEach((id) => {
    document.getElementById(id).disabled = ativa;
  });
  document.querySelectorAll('#etapa-confirmar-vincular-pedido input, #etapa-confirmar-vincular-pedido textarea').forEach((campo) => {
    campo.disabled = ativa;
  });
  document.getElementById('botao-confirmar-vincular-pedido').textContent = ativa ? 'Vinculando…' : 'Confirmar vinculação';
  if (!ativa) {
    atualizarPaginacaoVincularPedido();
    atualizarBotaoConfirmarVinculo();
  }
  atualizarBotoesAcaoFichaCliente();
}

async function buscarPedidosParaVincular() {
  const estado = estadoVincularPedido;
  const seq = ++estado.seq;
  const resultados = document.getElementById('resultados-vincular-pedido');
  mostrarErroOperacaoCliente('erro-vincular-pedido', '');
  if (estado.busca.length < 2) {
    resultados.innerHTML = '<p class="texto-secundario-ficha">Digite ao menos 2 caracteres.</p>';
    estado.total = 0;
    estado.pedidos = [];
    atualizarPaginacaoVincularPedido();
    return;
  }
  resultados.innerHTML = '<div class="estado-vazio">Buscando pedidos...</div>';

  let resposta;
  try {
    resposta = await searchOrdersForLink({
      clienteId: estado.clienteId,
      busca: estado.busca,
      limite: TAMANHO_PAGINA_VINCULAR_PEDIDO,
      offset: estado.offset,
    });
  } catch (erro) {
    if (seq !== estado.seq) return;
    console.error('Erro ao pesquisar pedidos para vincular:', erro);
    resultados.innerHTML = `<div class="estado-vazio">Não foi possível pesquisar os pedidos. ${escaparHtml(erro.message)}</div>`;
    estado.total = 0;
    estado.pedidos = [];
    atualizarPaginacaoVincularPedido();
    return;
  }
  if (seq !== estado.seq) return;

  estado.total = resposta.total;
  estado.pedidos = resposta.pedidos;
  resultados.innerHTML =
    resposta.pedidos.length > 0
      ? resposta.pedidos.map(linhaPedidoVincularHtml).join('')
      : '<div class="estado-vazio">Nenhum pedido encontrado.</div>';
  atualizarPaginacaoVincularPedido();
}

function atualizarPaginacaoVincularPedido() {
  const { offset, total } = estadoVincularPedido;
  const paginacao = document.getElementById('paginacao-vincular-pedido');
  if (total <= TAMANHO_PAGINA_VINCULAR_PEDIDO) {
    paginacao.style.display = 'none';
    return;
  }
  paginacao.style.display = '';
  const pagina = Math.floor(offset / TAMANHO_PAGINA_VINCULAR_PEDIDO) + 1;
  const totalPaginas = Math.ceil(total / TAMANHO_PAGINA_VINCULAR_PEDIDO);
  document.getElementById('rotulo-pagina-vincular-pedido').textContent = `Página ${pagina} de ${totalPaginas} · ${total} pedidos`;
  document.getElementById('botao-anterior-vincular-pedido').disabled = estadoOperacaoCliente.emAndamento || offset === 0;
  document.getElementById('botao-proxima-vincular-pedido').disabled =
    estadoOperacaoCliente.emAndamento || offset + TAMANHO_PAGINA_VINCULAR_PEDIDO >= total;
}

function pedidoSelecionavelParaVinculo(p) {
  return p.situacaoVinculo === 'semVinculo' || p.situacaoVinculo === 'excluido';
}

function linhaPedidoVincularHtml(p) {
  const moeda = obterConfiguracoes().moeda;
  let situacao;
  if (p.situacaoVinculo === 'desteCliente') {
    situacao = seloHtml('Já vinculado a este cliente', 'badge-verde', 'Nada a fazer');
  } else if (p.situacaoVinculo === 'outroCliente') {
    situacao = `${seloHtml('Vinculado a outro cliente', 'badge-vermelho', 'Não pode ser transferido por aqui')} ${
      p.outroClienteId ? linkFichaNovaAbaHtml(p.outroClienteId, p.outroClienteNome || 'outro cadastro') : ''
    }`;
  } else if (p.situacaoVinculo === 'excluido') {
    const motivo = p.ultimaAcaoAuditoria ? ROTULOS_ULTIMA_ACAO_DESVINCULO[p.ultimaAcaoAuditoria] || p.ultimaAcaoAuditoria : 'motivo não registrado';
    situacao = seloHtml('Desvinculado anteriormente', 'badge-amarelo', 'Fora da sincronização automática: ' + motivo);
  } else {
    situacao = seloHtml('Sem vínculo', 'badge-cinza', 'Pedido sem cliente');
  }
  const avisos = pedidoSelecionavelParaVinculo(p)
    ? p.avisos.map((a) => seloHtml(ROTULOS_AVISO_VINCULO[a] || a, a === 'order_cancelled' ? 'badge-vermelho' : 'badge-amarelo', 'Exigirá confirmação')).join('')
    : '';
  const acao = pedidoSelecionavelParaVinculo(p)
    ? `<button type="button" class="btn btn-secundario btn-compacto-cliente" data-selecionar-pedido="${escaparHtml(p.id)}">Selecionar</button>`
    : '';
  return `
    <div class="pedido-vincular">
      <div class="pedido-ficha-cliente-cabecalho">
        <strong>${escaparHtml(p.numero)}</strong>
        <span class="texto-secundario-ficha">${escaparHtml(formatarData(p.criadoEm))} ${escaparHtml(formatarHora(p.criadoEm))}</span>
        <span class="badge ${CLASSE_BADGE_STATUS_FICHA[p.status] || 'badge-amarelo'}">${escaparHtml(ROTULOS_STATUS_PEDIDO[p.status] || p.status)}</span>
        <strong class="pedido-ficha-cliente-total">${formatarMoeda(p.total, moeda)}</strong>
      </div>
      <p class="texto-secundario-ficha">${escaparHtml(p.nomeCliente || 'Sem nome')} · ${p.telefoneCliente ? escaparHtml(p.telefoneCliente) : 'sem telefone'}</p>
      <div class="pedido-vincular-rodape">
        <div class="selos-cliente">${situacao}${avisos}</div>
        ${acao}
      </div>
    </div>`;
}

function selecionarPedidoParaVincular(pedidoId) {
  if (estadoOperacaoCliente.emAndamento) return;
  const pedido = estadoVincularPedido.pedidos.find((p) => p.id === pedidoId);
  if (!pedido || !pedidoSelecionavelParaVinculo(pedido)) return;
  estadoVincularPedido.selecionado = pedido;
  document.getElementById('etapa-confirmar-vincular-pedido').innerHTML = confirmacaoVinculoHtml(pedido);
  mostrarErroOperacaoCliente('erro-vincular-pedido', '');
  mostrarEtapaVincularPedido('confirmar');
}

function confirmacaoVinculoHtml(p) {
  const moeda = obterConfiguracoes().moeda;
  const cliente = (estadoFichaCliente.dados && estadoFichaCliente.dados.cliente) || {};
  const telefoneCadastro = cliente.telefone ? formatarTelefoneIrlandes(cliente.telefone) : 'sem telefone';
  const textosAviso = {
    name_mismatch: `O nome no pedido ("${p.nomeCliente || 'sem nome'}") é diferente do cadastro ("${cliente.nome || ''}"). Confirmo que o pedido é deste cliente.`,
    phone_mismatch: `O telefone do pedido (${p.telefoneCliente || 'não informado'}) não confirma o cadastro (${telefoneCadastro}). Confirmo que o pedido é deste cliente.`,
    order_cancelled: 'O pedido está CANCELADO. Confirmo a vinculação mesmo assim (pedidos cancelados não entram nas métricas; o pedido não é alterado).',
  };
  const confirmacoes = p.avisos.map(
    (a) =>
      `<label class="confirmacao-cliente"><input type="checkbox" data-aviso-vinculo="${escaparHtml(a)}" /> <span>${escaparHtml(
        textosAviso[a] || a
      )}</span></label>`
  );
  if (p.situacaoVinculo === 'excluido') {
    const motivo = p.ultimaAcaoAuditoria ? ROTULOS_ULTIMA_ACAO_DESVINCULO[p.ultimaAcaoAuditoria] || p.ultimaAcaoAuditoria : 'motivo não registrado';
    confirmacoes.unshift(
      `<label class="confirmacao-cliente"><input type="checkbox" data-confirmacao-reativacao="sim" /> <span>${escaparHtml(
        `Este pedido foi desvinculado anteriormente (${motivo}) e está fora da sincronização automática. Confirmo a reativação do vínculo com este cliente.`
      )}</span></label>`
    );
  }

  return `
    <div class="comparacao-vinculo">
      <div class="resumo-cadastro-cliente">
        <div class="detalhe-pedido-titulo">Pedido</div>
        <p><strong>${escaparHtml(p.numero)}</strong> · ${escaparHtml(ROTULOS_STATUS_PEDIDO[p.status] || p.status)} · ${formatarMoeda(p.total, moeda)}</p>
        <p>${escaparHtml(formatarData(p.criadoEm))} ${escaparHtml(formatarHora(p.criadoEm))}</p>
        <p>${escaparHtml(p.nomeCliente || 'Sem nome')} · ${p.telefoneCliente ? escaparHtml(p.telefoneCliente) : 'sem telefone'}</p>
      </div>
      <div class="resumo-cadastro-cliente">
        <div class="detalhe-pedido-titulo">Cliente</div>
        <p><strong>${escaparHtml(cliente.nome || 'Não informado')}</strong></p>
        <p>${escaparHtml(telefoneCadastro)}</p>
      </div>
    </div>
    ${
      confirmacoes.length > 0
        ? `<p>Confirme cada item para continuar:</p>${confirmacoes.join('')}`
        : '<p class="aviso-info">Nome e telefone do pedido conferem com o cadastro.</p>'
    }
    <div class="form-grupo">
      <label for="campo-motivo-vincular-pedido">Motivo (opcional)</label>
      <textarea class="input" id="campo-motivo-vincular-pedido" maxlength="500" rows="2" placeholder="Ex.: cliente confirmou por telefone"></textarea>
    </div>
    <p class="texto-secundario-ficha">O pedido não é alterado. A vinculação fica registrada no histórico com o administrador e a data.</p>`;
}

function atualizarBotaoConfirmarVinculo() {
  const botao = document.getElementById('botao-confirmar-vincular-pedido');
  const caixas = Array.from(document.querySelectorAll('#etapa-confirmar-vincular-pedido input[type="checkbox"]'));
  botao.disabled = estadoOperacaoCliente.emAndamento || !estadoVincularPedido.selecionado || caixas.some((caixa) => !caixa.checked);
}

async function confirmarVincularPedido() {
  if (estadoOperacaoCliente.emAndamento) return;
  const estado = estadoVincularPedido;
  const pedido = estado.selecionado;
  if (!pedido) return;
  const caixas = Array.from(document.querySelectorAll('#etapa-confirmar-vincular-pedido input[type="checkbox"]'));
  if (caixas.some((caixa) => !caixa.checked)) return;

  const avisosConfirmados = Array.from(document.querySelectorAll('#etapa-confirmar-vincular-pedido input[data-aviso-vinculo]')).map(
    (caixa) => caixa.dataset.avisoVinculo
  );
  const confirmarReativacao = !!document.querySelector('#etapa-confirmar-vincular-pedido input[data-confirmacao-reativacao]:checked');
  const motivo = document.getElementById('campo-motivo-vincular-pedido').value.trim();

  mostrarErroOperacaoCliente('erro-vincular-pedido', '');
  definirOperacaoVinculo(true);
  let resultado;
  try {
    resultado = await linkOrderToCustomer({ clienteId: estado.clienteId, pedidoId: pedido.id, confirmarReativacao, avisosConfirmados, motivo });
  } catch (erro) {
    console.error('Erro ao vincular pedido:', erro);
    definirOperacaoVinculo(false);
    tratarErroVinculoPedido(erro, pedido);
    return;
  }
  definirOperacaoVinculo(false);

  const clienteId = estado.clienteId;
  fecharVincularPedido();
  mostrarToast(
    resultado.jaVinculado
      ? `${pedido.numero} já estava vinculado a este cliente.`
      : resultado.reativado
        ? `${pedido.numero} reativado e vinculado ao cliente.`
        : `${pedido.numero} vinculado ao cliente.`,
    'sucesso'
  );
  abrirFichaCliente({ clienteId });
  recarregarListaEIndicadoresClientes();
}

function tratarErroVinculoPedido(erro, pedido) {
  const estado = estadoVincularPedido;
  if (erro.codigo === 'customer_archived' || erro.codigo === 'customer_not_found') {
    const clienteId = estado.clienteId;
    fecharVincularPedido();
    mostrarToast('Este cadastro foi arquivado ou não existe mais. Nenhum pedido foi vinculado.', 'erro');
    abrirFichaCliente({ clienteId });
    return;
  }
  if (erro.codigo === 'invalid') {
    mostrarErroOperacaoCliente('erro-vincular-pedido', `${erro.message} Nada foi gravado.`);
    return;
  }
  if (erro.codigo === 'busy' || erro.codigo === 'forbidden' || (!erro.codigo && !erro.falhaRede)) {
    mostrarErroOperacaoCliente('erro-vincular-pedido', mensagemErroComumCliente(erro, 'a vinculação'));
    return; // continua na confirmação para tentar de novo
  }

  // Situação do pedido mudou (avisos, desvínculo, outro cliente, excluído) ou resposta perdida na rede:
  // relê o pedido no banco antes de qualquer nova tentativa.
  let mensagem;
  if (erro.falhaRede) mensagem = mensagemErroComumCliente(erro, 'a vinculação');
  else if (erro.codigo === 'linked_to_other') mensagem = erro.message;
  else if (erro.codigo === 'order_not_found') mensagem = 'Este pedido não existe mais (pode ter sido excluído). Nada foi gravado.';
  else mensagem = 'Os dados do pedido mudaram desde a pesquisa. Revise a situação atualizada e confirme novamente. Nada foi gravado.';
  reconsultarPedidoParaVincular(pedido, mensagem);
}

async function reconsultarPedidoParaVincular(pedido, mensagem) {
  const estado = estadoVincularPedido;
  estado.busca = pedido.numero;
  estado.offset = 0;
  document.getElementById('campo-busca-vincular-pedido').value = pedido.numero;
  mostrarEtapaVincularPedido('busca');
  await buscarPedidosParaVincular();
  if (!estado.aberto) return;

  const atual = estado.pedidos.find((p) => p.id === pedido.id);
  if (atual && atual.situacaoVinculo === 'desteCliente') {
    mostrarErroOperacaoCliente('erro-vincular-pedido', '');
    mostrarToast(`${pedido.numero} está vinculado a este cliente (a operação anterior foi concluída).`, 'sucesso');
    abrirFichaCliente({ clienteId: estado.clienteId });
    recarregarListaEIndicadoresClientes();
    return;
  }
  if (atual && pedidoSelecionavelParaVinculo(atual)) selecionarPedidoParaVincular(atual.id);
  mostrarErroOperacaoCliente('erro-vincular-pedido', mensagem);
}
