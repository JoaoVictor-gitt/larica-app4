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
