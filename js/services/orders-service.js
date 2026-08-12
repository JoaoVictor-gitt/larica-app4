/*
 * orders-service.js
 * Único arquivo que fala com o Supabase para pedidos (tabelas orders,
 * order_items, order_item_selections + as funções RPC create_customer_order
 * e update_order_status). Mapeia o formato relacional do Supabase (inglês)
 * pro formato pt-BR que o resto do app já usa (mesmo "pedido" de sempre:
 * numero, status em solicitado/em_preparo/pronto/finalizado, cliente.nome,
 * fulfilment 'retirada'/'entrega', item.combo.espetos/acompanhamentos/
 * incluidos) — quem chama isso (js/storage.js, js/pedido.js) não precisa
 * saber que existe Supabase por trás. Depende de js/supabase.js
 * (supabaseClient), carregado antes deste arquivo.
 */

const FULFILMENT_PARA_ENUM = { retirada: 'collection', entrega: 'delivery' };
const ENUM_PARA_FULFILMENT = { collection: 'retirada', delivery: 'entrega' };

const PAGAMENTO_PARA_ENUM = { cartao: 'card', dinheiro: 'cash', revolut: 'revolut' };
const ENUM_PARA_PAGAMENTO = { card: 'cartao', cash: 'dinheiro', revolut: 'revolut' };

const STATUS_PARA_ENUM = { solicitado: 'requested', em_preparo: 'preparing', pronto: 'ready', finalizado: 'completed', cancelado: 'cancelled' };
const ENUM_PARA_STATUS = { requested: 'solicitado', preparing: 'em_preparo', ready: 'pronto', completed: 'finalizado', cancelled: 'cancelado' };

const STATUS_PAGAMENTO_PARA_ENUM = { pendente: 'pending', pago: 'paid', pagar_na_entrega: 'pay_on_delivery', legado: 'legacy' };
const ENUM_PARA_STATUS_PAGAMENTO = { pending: 'pendente', paid: 'pago', pay_on_delivery: 'pagar_na_entrega', legacy: 'legado' };

/** Reconstrói o "pedido" no formato de sempre a partir de uma linha de `orders` (com order_items/order_item_selections embutidos) */
function _linhaSupabaseParaPedido(o) {
  const ehEntrega = o.fulfilment_type === 'delivery';
  return {
    id: o.id,
    numero: '#LARICA-' + o.order_number,
    status: ENUM_PARA_STATUS[o.status] || o.status,
    criadoEm: o.created_at,
    aceitoEm: o.accepted_at,
    prontoEm: o.ready_at,
    finalizadoEm: o.completed_at,
    canceladoEm: o.cancelled_at,
    motivoCancelamento: o.cancel_reason,
    statusPagamento: ENUM_PARA_STATUS_PAGAMENTO[o.payment_status] || o.payment_status,
    pagamentoConfirmadoEm: o.payment_confirmed_at,
    pagamentoConfirmadoPor: o.payment_confirmed_by,
    cliente: { nome: o.customer_name, telefone: o.customer_phone },
    fulfilment: ENUM_PARA_FULFILMENT[o.fulfilment_type] || o.fulfilment_type,
    // pickup_time (coluna `time` do Supabase) vem como "HH:MM:SS" — cortamos os segundos.
    // null = "assim que possível"; com valor = horário escolhido pelo cliente.
    retirada: !ehEntrega ? { modo: o.pickup_time ? 'horario' : 'asap', horario: o.pickup_time ? o.pickup_time.slice(0, 5) : null } : null,
    endereco: ehEntrega
      ? {
          eircode: o.eircode || '',
          linha1: o.address_line_1 || '',
          linha2: o.address_line_2 || '',
          area: o.area || '',
          distrito: '',
          instrucoes: o.delivery_instructions || '',
        }
      : null,
    formaPagamento: ENUM_PARA_PAGAMENTO[o.payment_method] || o.payment_method,
    pagamentoDinheiro:
      o.payment_method === 'cash'
        ? { precisaTroco: !!o.needs_change, valorPago: o.cash_amount, troco: o.change_amount }
        : null,
    subtotal: Number(o.subtotal) || 0,
    taxaEntrega: Number(o.delivery_fee) || 0,
    total: Number(o.total) || 0,
    itens: (o.order_items || []).map(_itemSupabaseParaItemPedido),
  };
}

function _itemSupabaseParaItemPedido(item) {
  const base = {
    produtoId: item.product_id,
    nome: item.product_name,
    quantidade: item.quantity,
    valorUnitario: Number(item.unit_price) || 0,
    valorTotal: Number(item.total_price) || 0,
  };
  if (item.item_type !== 'combo') return base;

  const selecoes = item.order_item_selections || [];
  return {
    ...base,
    combo: {
      comboId: item.product_id,
      nome: item.product_name,
      precoBase: Number(item.unit_price) || 0,
      espetos: selecoes
        .filter((s) => s.selection_type === 'skewer')
        .map((s) => ({
          produtoId: s.selected_product_id,
          nome: s.selected_product_name,
          quantidade: s.quantity,
          acrescimoUnitario: Number(s.extra_price) || 0,
        })),
      acompanhamentos: selecoes
        .filter((s) => s.selection_type === 'side')
        .map((s) => ({ id: s.selected_product_id, nome: s.selected_product_name, quantidade: s.quantity })),
      incluidos: selecoes.filter((s) => s.selection_type === 'included').map((s) => s.selected_product_name),
      extras: Number(item.extras_total) || 0,
      total: Number(item.total_price) || 0,
    },
  };
}

/**
 * Busca pedidos completos (orders + order_items + order_item_selections) em
 * no máximo 3 consultas em lote — nunca uma consulta por pedido/item. O
 * select aninhado (`orders(order_items(order_item_selections))`) trava a
 * leitura nesta base (confirmado em teste), então a composição é feita aqui
 * mesmo, em JavaScript, a partir de 3 arrays planos.
 *
 * Função central reaproveitada por pedidos.html (Kanban, sem filtro) e
 * historico.html (`status: 'finalizado'`/`'completed'`) — ver
 * js/storage.js:carregarPedidosClientesCache().
 *
 * @param {{ status?: string, orderIds?: string[], dateFrom?: string, dateTo?: string }} filtros
 *   `status` aceita tanto o valor em pt-BR (solicitado/em_preparo/pronto/finalizado)
 *   quanto o enum do banco (requested/preparing/ready/completed).
 */
async function getOrdersWithDetails({ status, orderIds, dateFrom, dateTo } = {}) {
  let consulta = supabaseClient.from('orders').select('*').order('created_at', { ascending: true });
  if (status) consulta = consulta.eq('status', STATUS_PARA_ENUM[status] || status);
  if (orderIds && orderIds.length > 0) consulta = consulta.in('id', orderIds);
  if (dateFrom) consulta = consulta.gte('created_at', dateFrom);
  if (dateTo) consulta = consulta.lte('created_at', dateTo);

  const { data: orders, error: erroOrders } = await consulta;
  if (erroOrders) throw new Error(erroOrders.message);
  if (!orders || orders.length === 0) return [];

  const idsPedidos = orders.map((o) => o.id);
  const { data: orderItems, error: erroItems } = await supabaseClient.from('order_items').select('*').in('order_id', idsPedidos);
  if (erroItems) throw new Error(erroItems.message);

  const idsItens = (orderItems || []).map((i) => i.id);
  let selections = [];
  if (idsItens.length > 0) {
    const { data: selectionsData, error: erroSelections } = await supabaseClient
      .from('order_item_selections')
      .select('*')
      .in('order_item_id', idsItens);
    if (erroSelections) throw new Error(erroSelections.message);
    selections = selectionsData || [];
  }

  const selectionsPorItem = new Map();
  selections.forEach((s) => {
    if (!selectionsPorItem.has(s.order_item_id)) selectionsPorItem.set(s.order_item_id, []);
    selectionsPorItem.get(s.order_item_id).push(s);
  });

  const itensPorPedido = new Map();
  (orderItems || []).forEach((item) => {
    const itemComSelections = { ...item, order_item_selections: selectionsPorItem.get(item.id) || [] };
    if (!itensPorPedido.has(item.order_id)) itensPorPedido.set(item.order_id, []);
    itensPorPedido.get(item.order_id).push(itemComSelections);
  });

  return orders.map((o) => _linhaSupabaseParaPedido({ ...o, order_items: itensPorPedido.get(o.id) || [] }));
}

/** Busca todos os pedidos, sem filtro — usada pelo cache compartilhado em js/storage.js */
async function getOrders() {
  return getOrdersWithDetails();
}

/**
 * Cria o pedido chamando a RPC create_customer_order (transação única no
 * banco, preços recalculados a partir de products/combo_skewer_options —
 * não confia em nada de preço/composição vindo do cliente). `pedido` é o
 * objeto local montado por confirmarPedido() (pedido.js); `itensPedido` é o
 * array já montado por confirmarPedido() com produtoId/nome/quantidade/
 * valorUnitario/valorTotal (e `combo` quando aplicável) — usado tanto pra
 * montar o payload da RPC quanto pra exibir a tela de confirmação (o
 * cliente já escolheu tudo, não precisa buscar de novo).
 */
async function createOrder(pedido, itensPedido) {
  const payload = {
    customer_name: pedido.cliente.nome,
    customer_phone: pedido.cliente.telefone,
    fulfilment_type: FULFILMENT_PARA_ENUM[pedido.fulfilment],
    eircode: pedido.endereco ? pedido.endereco.eircode : null,
    address_line_1: pedido.endereco ? pedido.endereco.linha1 : null,
    address_line_2: pedido.endereco ? pedido.endereco.linha2 : null,
    pickup_time: pedido.retirada && pedido.retirada.modo === 'horario' ? pedido.retirada.horario : null,
    area: pedido.endereco ? pedido.endereco.area : null,
    delivery_instructions: pedido.endereco ? pedido.endereco.instrucoes : null,
    // delivery_quote_id é a fonte oficial da taxa/distância pro create_customer_order (tabela
    // public.delivery_quotes, criada pela Edge Function calculate-delivery) — delivery_fee/
    // delivery_distance_km abaixo continuam enviados só por compatibilidade, a RPC os ignora
    // pra pedidos de entrega.
    delivery_quote_id: pedido.deliveryQuoteId || null,
    delivery_distance_km: pedido.distanciaEntregaKm != null ? pedido.distanciaEntregaKm : null,
    delivery_fee: pedido.taxaEntrega || 0,
    payment_method: PAGAMENTO_PARA_ENUM[pedido.formaPagamento],
    needs_change: pedido.formaPagamento === 'dinheiro' && pedido.pagamentoDinheiro ? !!pedido.pagamentoDinheiro.precisaTroco : false,
    cash_amount: pedido.formaPagamento === 'dinheiro' && pedido.pagamentoDinheiro ? pedido.pagamentoDinheiro.valorPago : null,
    items: itensPedido.map((item) => {
      if (item.combo) {
        return {
          item_type: 'combo',
          product_id: item.produtoId,
          quantity: item.quantidade,
          selections: {
            skewers: (item.combo.espetos || []).map((e) => ({ product_id: e.produtoId, quantity: e.quantidade })),
            sides: (item.combo.acompanhamentos || []).map((a) => ({ product_id: a.id, quantity: a.quantidade })),
          },
        };
      }
      return { item_type: 'product', product_id: item.produtoId, quantity: item.quantidade };
    }),
  };

  const { data, error } = await supabaseClient.rpc('create_customer_order', { payload });
  if (error) throw new Error(error.message);

  return {
    id: data.id,
    numero: '#LARICA-' + data.order_number,
    status: ENUM_PARA_STATUS[data.status] || data.status,
    criadoEm: data.created_at,
    subtotal: Number(data.subtotal) || 0,
    taxaEntrega: Number(data.delivery_fee) || 0,
    total: Number(data.total) || 0,
    cliente: pedido.cliente,
    fulfilment: pedido.fulfilment,
    retirada: pedido.retirada,
    endereco: pedido.endereco,
    formaPagamento: pedido.formaPagamento,
    pagamentoDinheiro: pedido.pagamentoDinheiro,
    itens: itensPedido,
  };
}

/** Transição de status via RPC (valida no banco, além do que já é validado no cliente) */
async function updateOrderStatusNoSupabase(id, novoStatusPt) {
  const novoStatusEnum = STATUS_PARA_ENUM[novoStatusPt];
  const { data, error } = await supabaseClient.rpc('update_order_status', { p_order_id: id, p_new_status: novoStatusEnum });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaPedido(data);
}

/**
 * Cancela um pedido (Solicitado/Em Preparo) via RPC cancel_order — RPC própria, separada de
 * update_order_status. Toda a lógica de estorno de estoque roda no banco; aqui só chama e mapeia
 * o retorno, nunca calcula nem devolve estoque no frontend.
 */
async function cancelOrderNoSupabase(id, motivo) {
  const { data, error } = await supabaseClient.rpc('cancel_order', { p_order_id: id, p_reason: motivo });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaPedido(data);
}

/**
 * Confirma manualmente o pagamento de um pedido Revolut pendente via RPC confirm_order_payment —
 * toda a validação (payment_method/payment_status/status, quem confirmou) roda no banco; aqui só
 * chama e mapeia o retorno. Nunca grava payment_status/payment_confirmed_at/payment_confirmed_by
 * direto na tabela — a única forma de confirmar pagamento é essa RPC.
 */
async function confirmOrderPaymentNoSupabase(id) {
  const { data, error } = await supabaseClient.rpc('confirm_order_payment', { p_order_id: id });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaPedido(data);
}

async function deleteOrderNoSupabase(id) {
  const { error } = await supabaseClient.from('orders').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

async function deleteOrdersNoSupabase(ids) {
  const { error } = await supabaseClient.from('orders').delete().in('id', ids);
  if (error) throw new Error(error.message);
}

async function clearCompletedOrdersNoSupabase() {
  const { error } = await supabaseClient.from('orders').delete().eq('status', 'completed');
  if (error) throw new Error(error.message);
}

/** Assina mudanças em `orders` (INSERT/UPDATE/DELETE). Retorna o canal, pra poder dar unsubscribe depois. */
function subscribeToOrders(aoMudar) {
  return supabaseClient
    .channel('pedidos-admin')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, aoMudar)
    .subscribe();
}

function unsubscribeFromOrders(canal) {
  if (canal) supabaseClient.removeChannel(canal);
}

/**
 * Busca pedidos "enxutos" pra relatório (Dashboard) — só as colunas de
 * `orders` usadas em métricas financeiras, sem `order_items`/seleções de
 * combo (uma única consulta, nada de N+1). `desdeUtc`/`ateUtc` são strings
 * ISO em UTC; o chamador (js/dashboard.js) é responsável por já ter
 * calculado uma janela larga o bastante pra cobrir o período desejado em
 * horário de Dublin (ver função de timezone em dashboard.js) — aqui só
 * filtra e devolve, sem nenhuma lógica de fuso.
 */
async function getOrdersForReport({ desdeUtc, ateUtc } = {}) {
  let consulta = supabaseClient
    .from('orders')
    .select(
      'id, order_number, created_at, cancelled_at, status, fulfilment_type, payment_method, subtotal, delivery_fee, total, cash_amount, change_amount, needs_change'
    )
    .order('created_at', { ascending: true });
  if (desdeUtc) consulta = consulta.gte('created_at', desdeUtc);
  if (ateUtc) consulta = consulta.lt('created_at', ateUtc);

  const { data, error } = await consulta;
  if (error) throw new Error(error.message);

  return (data || []).map((o) => ({
    id: o.id,
    numero: '#LARICA-' + o.order_number,
    criadoEm: o.created_at,
    canceladoEm: o.cancelled_at,
    status: ENUM_PARA_STATUS[o.status] || o.status,
    fulfilment: ENUM_PARA_FULFILMENT[o.fulfilment_type] || o.fulfilment_type,
    formaPagamento: ENUM_PARA_PAGAMENTO[o.payment_method] || o.payment_method,
    subtotal: Number(o.subtotal) || 0,
    taxaEntrega: Number(o.delivery_fee) || 0,
    total: Number(o.total) || 0,
    // Mesmos nomes pt-BR já usados em _linhaSupabaseParaPedido() (dentro de pagamentoDinheiro) — reaproveitados
    // aqui de propósito, sem nomenclatura paralela.
    precisaTroco: !!o.needs_change,
    valorPago: Number(o.cash_amount) || 0,
    troco: Number(o.change_amount) || 0,
  }));
}

/**
 * Busca pedidos cancelados pra relatório, filtrados por cancelled_at (não created_at) — fonte oficial
 * pra métricas de cancelamento por período. Corrige a limitação de getOrdersForReport(): como aquela
 * consulta filtra por created_at, um pedido criado fora da janela do período mas cancelado dentro dela
 * nunca aparece ali. Mesmo padrão enxuto: uma única consulta, lista explícita de colunas, sem
 * order_items/seleções de combo.
 */
async function getCancelledOrdersForReport({ desdeUtc, ateUtc } = {}) {
  let consulta = supabaseClient
    .from('orders')
    .select('id, order_number, cancelled_at, total')
    .eq('status', 'cancelled')
    .order('cancelled_at', { ascending: true });
  if (desdeUtc) consulta = consulta.gte('cancelled_at', desdeUtc);
  if (ateUtc) consulta = consulta.lt('cancelled_at', ateUtc);

  const { data, error } = await consulta;
  if (error) throw new Error(error.message);

  return (data || []).map((o) => ({
    id: o.id,
    numero: '#LARICA-' + o.order_number,
    canceladoEm: o.cancelled_at,
    total: Number(o.total) || 0,
  }));
}

/**
 * Ranking de produtos/combos mais vendidos dentro de um conjunto de pedidos
 * já carregado (`orderIds`, vindo de getOrdersForReport). Uma única consulta
 * em `order_items`, sem tocar `order_item_selections` — cada combo já é UMA
 * linha em order_items, então os componentes internos (espeto/acompanhamento/
 * incluso) nunca entram nesse ranking, só o combo em si.
 */
async function getTopProductsForReport(orderIds, limite = 10) {
  if (!orderIds || orderIds.length === 0) return [];

  const { data, error } = await supabaseClient
    .from('order_items')
    .select('product_id, product_name, quantity, total_price')
    .in('order_id', orderIds);
  if (error) throw new Error(error.message);

  const porProduto = new Map();
  (data || []).forEach((item) => {
    const atual = porProduto.get(item.product_id) || { produtoId: item.product_id, nome: item.product_name, quantidade: 0, valorVendido: 0 };
    atual.quantidade += Number(item.quantity) || 0;
    atual.valorVendido += Number(item.total_price) || 0;
    porProduto.set(item.product_id, atual);
  });

  return Array.from(porProduto.values())
    .sort((a, b) => b.quantidade - a.quantidade)
    .slice(0, limite);
}
