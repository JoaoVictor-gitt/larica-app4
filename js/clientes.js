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
 * Toda agregação roda no banco (js/services/customers-service.js) — esta tela nunca carrega o
 * histórico inteiro de pedidos. Vinculação manual de pedidos a um cadastro = Fase 2 (não existe aqui).
 * Depende de utils.js, storage.js e customers-service.js.
 */

const TAMANHO_PAGINA_CLIENTES = 25;
const TAMANHO_PAGINA_PEDIDOS_FICHA = 20;
const LIMITE_ESPERA_SINCRONIZACAO_MS = 8000;
const INTERVALO_ATUALIZACAO_AUTOMATICA_MS = 120000;

const estadoListaClientes = { busca: '', ordenacao: 'nome', filtro: 'todos', offset: 0, total: 0, seq: 0 };
const estadoFichaCliente = { aberta: false, alvo: null, cadastrado: false, dados: null, pedidos: [], totalPedidos: 0, seq: 0 };
const estadoAtualizacaoClientes = { emAndamento: false };
// Edição/exclusão em andamento: bloqueia cliques repetidos e o fechamento da ficha até terminar
const estadoOperacaoCliente = { emAndamento: false };

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosListaClientes();
  ligarEventosFichaCliente();
  ligarEventosEdicaoExclusaoCliente();
  document.getElementById('botao-atualizar-clientes').addEventListener('click', () => atualizarClientes({ manual: true }));

  await atualizarClientes({ manual: false });

  const parametros = new URLSearchParams(window.location.search);
  if (parametros.get('cliente')) abrirFichaCliente({ clienteId: parametros.get('cliente') });
  else if (parametros.get('pedido')) abrirFichaCliente({ pedidoId: parametros.get('pedido') });

  setInterval(() => {
    if (document.visibilityState !== 'visible' || estadoFichaCliente.aberta || estadoAtualizacaoClientes.emAndamento) return;
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
      <p>Telefone: ${cliente.telefone ? telefoneClienteHtml(cliente.telefone, false) : 'Não informado'}</p>`;
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
      <p class="aviso-info"><strong>Não cadastrado.</strong> ${escaparHtml(motivo)} A ficha mostra só este pedido, que não é agrupado com outros pelo nome nem entra nas métricas de clientes. A vinculação manual a um cadastro estará disponível em breve.</p>
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
    ${auditoriaFichaHtml(ficha.auditoria)}`;
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

/** "Histórico de vínculos" — últimos 20 eventos da auditoria (somente inclusão, no banco) */
function auditoriaFichaHtml(eventos) {
  if (!eventos || eventos.length === 0) return '';
  const itens = eventos
    .map((e) => {
      const autor = e.autorId ? 'admin ' + escaparHtml(String(e.autorId).slice(0, 8)) : 'sistema';
      const pedido = e.numeroPedido ? ' · ' + escaparHtml(e.numeroPedido) : '';
      const motivo = e.motivo ? ` · motivo: ${escaparHtml(e.motivo)}` : '';
      return `<li><strong>${escaparHtml(ROTULOS_ACAO_AUDITORIA[e.acao] || e.acao)}</strong>${pedido}
        <small class="texto-secundario-ficha">${escaparHtml(formatarData(e.em))} ${escaparHtml(formatarHora(e.em))} · por ${autor}${motivo}</small></li>`;
    })
    .join('');
  return `
    <div class="detalhe-pedido-secao">
      <div class="detalhe-pedido-titulo">Histórico de vínculos</div>
      <ul class="lista-auditoria-ficha">${itens}</ul>
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
