/*
 * customers-service.js
 * Único arquivo que fala com o Supabase para a página Clientes. Fase 1 (somente leitura +
 * sincronização automática): RPCs sync_phone_customer_links, get_customers_overview,
 * list_customers e get_customer_detail — todas admin-only, checadas com is_admin() no
 * banco. As tabelas do cadastro (customers, order_customer_links, customer_link_audit)
 * não são acessíveis diretamente: só por essas RPCs.
 *
 * Cliente cadastrado = linha ativa em customers (nome; telefone irlandês opcional — pode ser
 * corrigido ou removido pelo admin). O vínculo AUTOMÁTICO continua exigindo nome + telefone
 * irlandês. Pedido sem vínculo = "não cadastrado" (nunca agrupado pelo nome). Pedido com
 * nome + telefone ainda sem vínculo = "aguardando sincronização".
 * Edição/arquivamento manual: admin_update_customer / admin_archive_customer (no banco).
 * Cadastro manual, Eircode e vinculação manual (um pedido por vez): admin_check_customer_duplicates,
 * admin_create_customer, admin_get_customer_profile, admin_update_customer_eircode,
 * admin_search_orders_for_link, admin_link_order_to_customer — regras, avisos e confirmações
 * são exigidos no banco; os erros trazem `codigo` (HINT 'larica:<codigo>') e `detalhes` (DETAIL JSON).
 * Mapeia o retorno (inglês) pro formato pt-BR do resto do app, reaproveitando os mapas
 * ENUM_PARA_* de orders-service.js (carregado antes deste arquivo).
 * Depende de js/supabase.js (supabaseClient).
 */

const ORDENACAO_CLIENTES_PARA_ENUM = { nome: 'name_asc', pedidos: 'orders_desc', gasto: 'spent_desc', ultima: 'last_desc' };
const FILTRO_CLIENTES_PARA_ENUM = {
  todos: 'all',
  cadastrados: 'registered',
  compraram: 'buyers',
  naoCadastrados: 'unregistered',
  duplicidades: 'duplicates',
};
const TIPO_LINHA_CLIENTE = { registered: 'cadastrado', unregistered: 'naoCadastrado', pending: 'aguardando' };

function _numeroOuZero(valor) {
  return Number(valor) || 0;
}

function _linhaClienteSupabase(c) {
  return {
    tipo: TIPO_LINHA_CLIENTE[c.kind] || 'naoCadastrado',
    clienteId: c.customer_id || null,
    pedidoId: c.order_id || null,
    nome: c.display_name || '',
    telefone: c.phone || '',
    qtdPedidos: _numeroOuZero(c.orders_count),
    totalGasto: _numeroOuZero(c.total_spent),
    ticketMedio: _numeroOuZero(c.avg_ticket),
    primeiraCompraEm: c.first_order_at || null,
    ultimaCompraEm: c.last_order_at || null,
    qtdMesmoNome: _numeroOuZero(c.same_name_count),
    qtdTelefoneCompartilhado: _numeroOuZero(c.shared_phone_count),
    possiveisCorrespondencias: _numeroOuZero(c.possible_matches),
    telefoneNaoReconhecido: !!c.phone_unrecognized,
  };
}

/** Outra ficha relacionada (alertas da ficha) — nunca agrupada, só um atalho pra abrir */
function _relacionadoSupabase(r) {
  return {
    tipo: TIPO_LINHA_CLIENTE[r.kind] || 'naoCadastrado',
    clienteId: r.customer_id || null,
    pedidoId: r.order_id || null,
    nome: r.display_name || '',
    telefone: r.phone || '',
    numeroPedido: r.order_number != null ? '#LARICA-' + r.order_number : null,
    status: r.status ? ENUM_PARA_STATUS[r.status] || r.status : null,
    total: r.total != null ? _numeroOuZero(r.total) : null,
    qtdPedidos: r.orders_count != null ? _numeroOuZero(r.orders_count) : null,
    ultimoPedidoEm: r.last_order_at || null,
  };
}

function _eventoAuditoriaSupabase(a) {
  return {
    id: a.id,
    acao: a.action,
    pedidoId: a.order_id || null,
    numeroPedido: a.order_number != null ? '#LARICA-' + a.order_number : null,
    clienteId: a.customer_id || null,
    clienteAnteriorId: a.previous_customer_id || null,
    autorId: a.actor || null,
    em: a.acted_at,
    motivo: a.reason || '',
    detalhes: a.details || {},
  };
}

function _pedidoClienteSupabase(o) {
  return {
    id: o.id,
    numero: '#LARICA-' + o.order_number,
    status: ENUM_PARA_STATUS[o.status] || o.status,
    criadoEm: o.created_at,
    finalizadoEm: o.completed_at,
    canceladoEm: o.cancelled_at,
    motivoCancelamento: o.cancel_reason,
    nomeCliente: o.customer_name || '',
    telefoneCliente: o.customer_phone || '',
    fulfilment: ENUM_PARA_FULFILMENT[o.fulfilment_type] || o.fulfilment_type,
    formaPagamento: ENUM_PARA_PAGAMENTO[o.payment_method] || o.payment_method,
    subtotal: _numeroOuZero(o.subtotal),
    taxaEntrega: _numeroOuZero(o.delivery_fee),
    valorDesconto: _numeroOuZero(o.discount_amount),
    total: _numeroOuZero(o.total),
    itens: (o.items || []).map((i) => ({
      produtoId: i.product_id,
      nome: i.product_name,
      tipoItem: i.item_type,
      quantidade: _numeroOuZero(i.quantity),
      valorTotal: _numeroOuZero(i.total_price),
      selecoes: (i.selections || []).map((s) => ({
        tipoSelecao: s.selection_type,
        nome: s.selected_product_name,
        quantidade: _numeroOuZero(s.quantity),
        acrescimoUnitario: _numeroOuZero(s.extra_price),
      })),
    })),
  };
}

/**
 * Vincula ao cadastro os pedidos novos com nome + telefone irlandês (regra automática, no banco).
 * Idempotente e limitada; `ocupada: true` = outra sincronização em andamento (não é erro).
 */
async function syncCustomerLinks(limite = 200) {
  const { data, error } = await supabaseClient.rpc('sync_phone_customer_links', { p_limit: limite });
  if (error) throw new Error(error.message);
  const d = data || {};
  return {
    ocupada: !!d.skipped,
    motivo: d.reason || null,
    vinculados: _numeroOuZero(d.linked),
    cadastrosCriados: _numeroOuZero(d.customers_created),
    restantes: _numeroOuZero(d.remaining),
  };
}

/** Indicadores gerais — métricas só de pedidos finalizados VINCULADOS a cadastros ativos. */
async function getCustomersOverview() {
  const { data, error } = await supabaseClient.rpc('get_customers_overview');
  if (error) throw new Error(error.message);
  const d = data || {};
  return {
    clientesCadastrados: _numeroOuZero(d.registered_customers),
    clientesQueCompraram: _numeroOuZero(d.buying_customers),
    clientesRecorrentes: _numeroOuZero(d.recurring_customers),
    qtdPedidos: _numeroOuZero(d.orders_count),
    totalGasto: _numeroOuZero(d.total_spent),
    ticketMedio: _numeroOuZero(d.avg_ticket),
    pedidosNaoCadastrados: _numeroOuZero(d.unregistered_orders),
    valorNaoCadastrados: _numeroOuZero(d.unregistered_total),
    nomesNaoCadastrados: _numeroOuZero(d.unregistered_names),
    nomesNaoCadastradosComCorrespondencia: _numeroOuZero(d.unregistered_name_matches),
    pedidosAguardandoSincronizacao: _numeroOuZero(d.pending_sync_orders),
    nomesRepetidos: _numeroOuZero(d.repeated_names),
    telefonesCompartilhados: _numeroOuZero(d.shared_phones),
  };
}

/**
 * Página da lista — busca/ordenação/filtro/paginação no servidor.
 * @param {{ busca?: string, ordenacao?: 'nome'|'pedidos'|'gasto'|'ultima',
 *           filtro?: 'todos'|'cadastrados'|'compraram'|'naoCadastrados'|'duplicidades', limite?: number, offset?: number }} filtros
 */
async function listCustomers({ busca = '', ordenacao = 'nome', filtro = 'todos', limite = 25, offset = 0 } = {}) {
  const { data, error } = await supabaseClient.rpc('list_customers', {
    p_search: busca || null,
    p_sort: ORDENACAO_CLIENTES_PARA_ENUM[ordenacao] || 'name_asc',
    p_filter: FILTRO_CLIENTES_PARA_ENUM[filtro] || 'all',
    p_limit: limite,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  const d = data || {};
  return { total: _numeroOuZero(d.total), clientes: (d.rows || []).map(_linhaClienteSupabase) };
}

/**
 * Ficha por cadastro (`clienteId`) ou por pedido (`pedidoId`, link do Histórico): pedido vinculado abre o
 * cliente; pedido sem vínculo abre a ficha de não cadastrado (só aquele pedido + sugestões).
 */
async function getCustomerDetail({ clienteId = null, pedidoId = null, limite = 20, offset = 0 } = {}) {
  const { data, error } = await supabaseClient.rpc('get_customer_detail', {
    p_customer_id: clienteId,
    p_order_id: clienteId ? null : pedidoId,
    p_limit: limite,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  const d = data || {};
  const c = d.customer || {};
  const m = d.metrics || {};
  return {
    cadastrado: !!d.registered,
    aguardandoSincronizacao: !!d.pending_sync,
    desvinculado: !!d.excluded,
    telefoneNaoReconhecido: !!d.phone_unrecognized,
    cliente: {
      id: c.id || null,
      nome: c.display_name || '',
      telefone: c.phone || '',
      status: c.status || null, // 'active' | 'archived' (cadastro arquivado = excluído manualmente)
      origem: c.source || null,
      cadastradoEm: c.created_at || null,
      primeiraCompraEm: c.first_order_at || null,
      ultimaCompraEm: c.last_order_at || null,
    },
    metricas: {
      qtdPedidos: _numeroOuZero(m.orders_count),
      totalGasto: _numeroOuZero(m.total_spent),
      ticketMedio: _numeroOuZero(m.avg_ticket),
      qtdCancelados: _numeroOuZero(m.cancelled_count),
      qtdEmAndamento: _numeroOuZero(m.open_count),
    },
    totalPedidos: _numeroOuZero(d.orders_total),
    pedidos: (d.orders || []).map(_pedidoClienteSupabase),
    produtosMaisComprados: (d.top_products || []).map((p) => ({
      nome: p.product_name,
      quantidade: _numeroOuZero(p.quantity),
      qtdPedidos: _numeroOuZero(p.orders_count),
      valorEmItens: _numeroOuZero(p.items_value),
    })),
    mesmoNome: (d.same_name || []).map(_relacionadoSupabase),
    telefoneCompartilhado: (d.shared_phone || []).map(_relacionadoSupabase),
    possiveisCorrespondencias: (d.possible_matches || []).map(_relacionadoSupabase),
    auditoria: (d.audit || []).map(_eventoAuditoriaSupabase),
  };
}

/**
 * Edita manualmente um cliente cadastrado.
 * Apenas administradores autorizados pelo banco.
 * Telefone vazio remove o número do cadastro.
 */
async function updateCustomer({ clienteId, nome, telefone }) {
  if (!clienteId) throw new Error('Cliente não informado.');

  const { data, error } = await supabaseClient.rpc(
    'admin_update_customer',
    {
      p_customer_id: clienteId,
      p_display_name: nome,
      p_phone: telefone?.trim() || null,
    }
  );

  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error('Não foi possível atualizar o cliente.');

  return {
    sucesso: true,
    clienteId: data.customer_id,
    nome: data.display_name,
    telefone: data.phone || '',
  };
}

/**
 * Arquiva manualmente um cliente.
 * Seus pedidos são preservados e passam a
 * aparecer como "Cliente não cadastrado".
 */
async function archiveCustomer(clienteId) {
  if (!clienteId) throw new Error('Cliente não informado.');

  const { data, error } = await supabaseClient.rpc(
    'admin_archive_customer',
    {
      p_customer_id: clienteId,
    }
  );

  if (error) throw new Error(error.message);
  if (!data?.success) throw new Error('Não foi possível excluir o cliente.');

  return {
    sucesso: true,
    clienteId: data.customer_id,
    pedidosDesvinculados: _numeroOuZero(data.unlinked_orders),
  };
}

// ---------------------------------------------------------------------------
// Cadastro manual, Eircode e vinculação manual
// ---------------------------------------------------------------------------

const SITUACAO_VINCULO_PEDIDO = { none: 'semVinculo', this: 'desteCliente', other: 'outroCliente', excluded: 'excluido' };

/**
 * Erro das RPCs novas com o código da regra de negócio (HINT 'larica:<codigo>') e os dados do DETAIL.
 * `falhaRede`: a requisição pode nem ter chegado ao banco OU ter sido concluída sem resposta —
 * a tela trata como "não confirmado" e relê os dados antes de qualquer nova tentativa.
 */
function _erroRpcCliente(error) {
  const erro = new Error(error.message || 'Erro desconhecido');
  const hint = error.hint || '';
  erro.codigo = hint.startsWith('larica:') ? hint.slice('larica:'.length) : null;
  erro.detalhes = null;
  if (error.details) {
    try {
      erro.detalhes = JSON.parse(error.details);
    } catch (_) {
      erro.detalhes = null;
    }
  }
  erro.falhaRede = !error.code && /fetch|network|timeout|abort/i.test(error.message || '');
  return erro;
}

async function _rpcCliente(nome, parametros) {
  let resposta;
  try {
    resposta = await supabaseClient.rpc(nome, parametros);
  } catch (erroRede) {
    const erro = new Error(erroRede.message || 'Falha de rede');
    erro.codigo = null;
    erro.detalhes = null;
    erro.falhaRede = true;
    throw erro;
  }
  if (resposta.error) throw _erroRpcCliente(resposta.error);
  return resposta.data || {};
}

function _cadastroParecidoSupabase(c) {
  return {
    clienteId: c.customer_id,
    nome: c.display_name || '',
    telefone: c.phone || '',
    status: c.status || null,
    cadastradoEm: c.created_at || null,
  };
}

/** Prévia do cadastro manual (não grava): validação por campo, duplicidade exata e avisos. */
async function checkCustomerDuplicates({ nome, telefone, eircode }) {
  const d = await _rpcCliente('admin_check_customer_duplicates', {
    p_name: nome || '',
    p_phone: telefone || '',
    p_eircode: eircode || null,
  });
  const erros = d.errors || {};
  const normalizado = d.normalized || {};
  return {
    valido: !!d.valid,
    erros: { nome: erros.name || null, telefone: erros.phone || null, eircode: erros.eircode || null },
    normalizado: { nome: normalizado.display_name || '', telefone: normalizado.phone || '', eircode: normalizado.eircode || '' },
    duplicidadeExata: d.exact_match ? _cadastroParecidoSupabase(d.exact_match) : null,
    avisos: d.warnings || [],
    mesmoNome: (d.same_name || []).map(_cadastroParecidoSupabase),
    totalMesmoNome: _numeroOuZero(d.same_name_total),
    mesmoTelefone: (d.same_phone || []).map(_cadastroParecidoSupabase),
    totalMesmoTelefone: _numeroOuZero(d.same_phone_total),
    arquivadosMesmaIdentidade: (d.archived_identity || []).map(_cadastroParecidoSupabase),
    // Somente informativos: nada é vinculado ou reativado pelo cadastro
    pedidosAguardandoSincronizacaoMesmaIdentidade: _numeroOuZero(d.pending_sync_orders_same_identity),
    pedidosDesvinculadosMesmaIdentidade: _numeroOuZero(d.excluded_orders_same_identity),
  };
}

/**
 * Cria o cadastro manual. `avisosConfirmados`: códigos de aviso que o admin confirmou na revisão
 * (o banco recalcula e recusa se faltar algum). `idTentativa`: o MESMO valor em todas as repetições
 * de uma tentativa — se a primeira chegou ao banco, a repetição devolve o mesmo cadastro (`jaCriado`).
 */
async function createCustomer({ nome, telefone, eircode, avisosConfirmados = [], idTentativa = null }) {
  const d = await _rpcCliente('admin_create_customer', {
    p_name: nome || '',
    p_phone: telefone || '',
    p_eircode: eircode || null,
    p_acknowledged_warnings: avisosConfirmados,
    p_request_id: idTentativa,
  });
  if (!d.success) throw new Error('Não foi possível cadastrar o cliente.');
  return {
    clienteId: d.customer_id,
    nome: d.display_name || '',
    telefone: d.phone || '',
    eircode: d.eircode || '',
    jaCriado: !!d.already_created,
  };
}

/** Perfil do cadastro (inclui o Eircode, que a ficha não recebe de get_customer_detail). */
async function getCustomerProfile(clienteId) {
  const d = await _rpcCliente('admin_get_customer_profile', { p_customer_id: clienteId });
  return {
    clienteId: d.customer_id,
    nome: d.display_name || '',
    telefone: d.phone || '',
    eircode: d.eircode || '',
    status: d.status || null,
  };
}

/** Altera ou remove (vazio) só o Eircode. `alterado: false` = já era esse valor (nada gravado). */
async function updateCustomerEircode({ clienteId, eircode }) {
  const d = await _rpcCliente('admin_update_customer_eircode', {
    p_customer_id: clienteId,
    p_eircode: eircode || null,
  });
  if (!d.success) throw new Error('Não foi possível salvar o Eircode.');
  return { alterado: !!d.changed, eircode: d.eircode || '' };
}

/** Pesquisa de pedidos para vincular ao cliente (número, nome ou telefone), com a situação de cada um. */
async function searchOrdersForLink({ clienteId, busca, limite = 10, offset = 0 }) {
  const d = await _rpcCliente('admin_search_orders_for_link', {
    p_customer_id: clienteId,
    p_search: busca || '',
    p_limit: limite,
    p_offset: offset,
  });
  return {
    total: _numeroOuZero(d.total),
    buscaCurta: !!d.too_short,
    pedidos: (d.rows || []).map((p) => ({
      id: p.order_id,
      numero: '#LARICA-' + p.order_number,
      criadoEm: p.created_at,
      status: ENUM_PARA_STATUS[p.status] || p.status,
      total: _numeroOuZero(p.total),
      nomeCliente: p.customer_name || '',
      telefoneCliente: p.customer_phone || '',
      telefoneReconhecido: !!p.phone_recognized,
      situacaoVinculo: SITUACAO_VINCULO_PEDIDO[p.link_state] || 'semVinculo',
      outroClienteId: p.linked_customer_id || null,
      outroClienteNome: p.linked_customer_name || '',
      ultimaAcaoAuditoria: p.last_audit_action || null,
      avisos: p.warnings || [],
    })),
  };
}

/**
 * Vincula UM pedido ao cliente. `avisosConfirmados` e `confirmarReativacao` precisam refletir o que o
 * admin confirmou; o banco recalcula e recusa se faltar algo. Repetir é seguro (`jaVinculado`).
 */
async function linkOrderToCustomer({ clienteId, pedidoId, confirmarReativacao = false, avisosConfirmados = [], motivo = '' }) {
  const d = await _rpcCliente('admin_link_order_to_customer', {
    p_customer_id: clienteId,
    p_order_id: pedidoId,
    p_confirm_reactivation: !!confirmarReativacao,
    p_acknowledged_warnings: avisosConfirmados,
    p_reason: motivo ? motivo.trim() : null,
  });
  if (!d.success) throw new Error('Não foi possível vincular o pedido.');
  return {
    jaVinculado: !!d.already_linked,
    reativado: !!d.reactivated,
    numero: d.order_number != null ? '#LARICA-' + d.order_number : '',
  };
}
