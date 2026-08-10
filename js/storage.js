/*
 * storage.js
 * Camada única de acesso aos dados do app. A maior parte ainda é
 * localStorage — nenhuma outra parte do sistema deve chamar localStorage
 * diretamente, sempre passar pelas funções daqui. Produtos/combos são
 * exceção: agora vêm do Supabase (via js/services/products-service.js),
 * mantidos aqui num cache em memória pra que obterProdutos()/
 * obterProdutoPorId()/pesquisarProdutos() continuem síncronas pros
 * chamadores existentes (produtos.js, pedido.js, estoque.js, dashboard.js).
 * Depende de utils.js (gerarId) e, pra produtos, de products-service.js.
 */

const CHAVES = {
  produtos: 'caju_produtos',
  carrinho: 'caju_carrinho',
  historico: 'caju_historico',
  configuracoes: 'caju_configuracoes',
  inicializado: 'caju_inicializado',
  pedidosClientes: 'caju_pedidos_clientes',
  acompanhamentos: 'caju_acompanhamentos', // coleção antiga, mantida só para a migração de uma vez (ver _migrarAcompanhamentosECombosParaProdutos)
  combos: 'caju_combos', // idem
  migracaoProdutoUnico: 'caju_migracao_produto_unico',
  proximoNumeroPedido: 'caju_proximo_numero_pedido',
};

const CONFIGURACOES_PADRAO = {
  nomeFoodTruck: 'Larica Food Truck',
  moeda: 'EUR',
  taxaEntrega: 0,
  tema: 'escuro', // 'claro' | 'escuro'
  atualizadoEm: '',
};

/** Lê uma chave do localStorage já convertida de JSON, com valor padrão em caso de erro/ausência */
function _lerChave(chave, valorPadrao) {
  try {
    const bruto = localStorage.getItem(chave);
    if (bruto === null) return valorPadrao;
    return JSON.parse(bruto);
  } catch (erro) {
    console.error('Erro ao ler storage:', chave, erro);
    return valorPadrao;
  }
}

/** Grava um valor no localStorage, serializado em JSON */
function _gravarChave(chave, valor) {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch (erro) {
    console.error('Erro ao gravar storage:', chave, erro);
  }
}

/**
 * Garante que todas as chaves existam com valores padrão e roda o seed de
 * produtos de exemplo apenas na primeira execução (para o sistema não vir
 * vazio, mas sem repopular depois que o usuário apaga os dados manualmente).
 */
function inicializarStorage() {
  if (_lerChave(CHAVES.produtos, null) === null) _gravarChave(CHAVES.produtos, []);
  if (_lerChave(CHAVES.carrinho, null) === null) _gravarChave(CHAVES.carrinho, []);
  if (_lerChave(CHAVES.historico, null) === null) _gravarChave(CHAVES.historico, []);
  if (_lerChave(CHAVES.configuracoes, null) === null) _gravarChave(CHAVES.configuracoes, CONFIGURACOES_PADRAO);
  if (_lerChave(CHAVES.pedidosClientes, null) === null) _gravarChave(CHAVES.pedidosClientes, []);
  // Contador do número do pedido (#LARICA-XXXX): nunca é derivado do tamanho da lista (isso quebraria
  // ao excluir pedidos, repetindo números já usados) — só cresce. Na primeira leitura, começa de onde
  // a numeração antiga (baseada no tamanho da lista) já estava, pra não pular nem repetir pra quem já tem pedidos.
  if (_lerChave(CHAVES.proximoNumeroPedido, null) === null) {
    _gravarChave(CHAVES.proximoNumeroPedido, 1000 + _lerChave(CHAVES.pedidosClientes, []).length);
  }

  const jaInicializado = _lerChave(CHAVES.inicializado, false);
  if (!jaInicializado) {
    _semearProdutosExemplo();
    _gravarChave(CHAVES.inicializado, true);
  }

  _migrarAcompanhamentosECombosParaProdutos();
}

/**
 * Popula produtos de exemplo para o sistema não começar vazio: espetos,
 * bebidas, sobremesas, molhos, acompanhamentos (categoria "Acompanhamentos",
 * sem nenhum campo especial) e 2 combos (categoria "Combos", com
 * `comboConfig` já configurado e vinculado aos espetos acima por id).
 */
function _semearProdutosExemplo() {
  const agora = new Date().toISOString();
  const exemplosBase = [
    { nome: 'Frango', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 20, descricao: 'Espetinho de frango temperado, grelhado na brasa.' },
    { nome: 'Linguiça', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 20, descricao: 'Linguiça artesanal grelhada na brasa.' },
    { nome: 'Coração', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 15, descricao: 'Coração de frango temperado.' },
    { nome: 'Queijo coalho', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 15, descricao: 'Queijo coalho grelhado com mel.' },
    { nome: 'Vegetariano', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 10, descricao: 'Legumes grelhados na brasa.' },
    { nome: 'Pão de alho', categoria: 'Espetinhos', preco: 3.5, quantidadeEstoque: 15, descricao: 'Pão de alho tostado na brasa.' },
    { nome: 'Contra-filé', categoria: 'Espetinhos', preco: 5.5, quantidadeEstoque: 15, descricao: 'Contra-filé suculento grelhado na brasa.' },
    { nome: 'Picanha', categoria: 'Espetinhos', preco: 6.5, quantidadeEstoque: 15, descricao: 'Picanha nobre grelhada na brasa.' },
    { nome: 'Guaraná Lata', categoria: 'Bebidas', preco: 2, quantidadeEstoque: 30, descricao: 'Refrigerante gelado 350ml.' },
    { nome: 'Brigadeiro', categoria: 'Sobremesas', preco: 1.5, quantidadeEstoque: 3, descricao: 'Docinho brasileiro tradicional.' },
    { nome: 'Molho Vinagrete', categoria: 'Molhos', preco: 0.5, quantidadeEstoque: 0, descricao: 'Vinagrete fresco para acompanhar.' },
    { nome: 'Farofa', categoria: 'Acompanhamentos', preco: 2, quantidadeEstoque: 999, descricao: 'Farofa crocante de mandioca.' },
    { nome: 'Molho de alho', categoria: 'Acompanhamentos', preco: 1, quantidadeEstoque: 999, descricao: 'Molho de alho da casa.' },
    { nome: 'Arroz', categoria: 'Acompanhamentos', preco: 3, quantidadeEstoque: 999, descricao: '' },
    { nome: 'Batata frita', categoria: 'Acompanhamentos', preco: 4, quantidadeEstoque: 999, descricao: '' },
    { nome: 'Salada de maionese', categoria: 'Acompanhamentos', preco: 3, quantidadeEstoque: 999, descricao: '' },
    { nome: 'Vinagrete', categoria: 'Acompanhamentos', preco: 2, quantidadeEstoque: 999, descricao: '' },
  ];
  const produtos = exemplosBase.map((p) => ({
    id: gerarId(),
    ...p,
    foto: '',
    status: 'ativo',
    comboConfig: null,
    criadoEm: agora,
    atualizadoEm: agora,
  }));

  const idPorNome = (nome) => (produtos.find((p) => p.nome === nome) || {}).id;
  const acrescimos = (mapaPorNome) => {
    const resultado = {};
    Object.entries(mapaPorNome).forEach(([nome, valor]) => {
      const id = idPorNome(nome);
      if (id) resultado[id] = valor;
    });
    return resultado;
  };
  const idsInclusos = ['Farofa', 'Molho de alho'].map(idPorNome).filter(Boolean);

  produtos.push(
    {
      id: gerarId(),
      nome: 'Combo Individual',
      categoria: 'Combos',
      preco: 12,
      quantidadeEstoque: 0,
      descricao: '1 espeto + 1 acompanhamento, com farofa e molho de alho inclusos.',
      foto: '',
      status: 'ativo',
      comboConfig: {
        ordem: 1,
        allowedSkewers: 1,
        allowedSides: 1,
        includedItems: idsInclusos,
        skewerExtraPrices: acrescimos({ 'Contra-filé': 2, Picanha: 4 }),
      },
      criadoEm: agora,
      atualizadoEm: agora,
    },
    {
      id: gerarId(),
      nome: 'Combo para Dividir',
      categoria: 'Combos',
      preco: 35,
      quantidadeEstoque: 0,
      descricao: '4 espetos + 2 acompanhamentos, com farofa e molho de alho inclusos.',
      foto: '',
      status: 'ativo',
      comboConfig: {
        ordem: 2,
        allowedSkewers: 4,
        allowedSides: 2,
        includedItems: idsInclusos,
        skewerExtraPrices: acrescimos({ Picanha: 4 }),
      },
      criadoEm: agora,
      atualizadoEm: agora,
    }
  );

  _gravarChave(CHAVES.produtos, produtos);
}

/**
 * Migração de uma vez só: converte o que estiver nas antigas coleções
 * separadas de acompanhamentos/combos (de uma versão anterior do sistema)
 * em produtos normais, e zera as coleções antigas. Roda toda vez que a
 * página carrega, mas só faz algo na primeira execução (guardada por
 * CHAVES.migracaoProdutoUnico) — depois disso é um no-op instantâneo.
 */
function _migrarAcompanhamentosECombosParaProdutos() {
  if (_lerChave(CHAVES.migracaoProdutoUnico, false)) return;

  const acompanhamentosAntigos = _lerChave(CHAVES.acompanhamentos, []);
  const combosAntigos = _lerChave(CHAVES.combos, []);
  if (acompanhamentosAntigos.length === 0 && combosAntigos.length === 0) {
    _gravarChave(CHAVES.migracaoProdutoUnico, true);
    return;
  }

  const produtos = obterProdutos();
  const agora = new Date().toISOString();

  acompanhamentosAntigos.forEach((a) => {
    if (produtos.some((p) => p.id === a.id)) return;
    produtos.push({
      id: a.id,
      nome: a.nome,
      categoria: 'Acompanhamentos',
      preco: a.preco || 0,
      quantidadeEstoque: 999,
      descricao: a.descricao || '',
      foto: a.foto || '',
      status: a.status || 'ativo',
      comboConfig: null,
      criadoEm: a.criadoEm || agora,
      atualizadoEm: agora,
    });
  });

  /** Acha (ou cria, se ainda não existir) um produto pelo nome — usado para transformar os antigos "itens inclusos" (texto livre) em referências reais de produto */
  function _obterOuCriarProdutoPorNome(nome) {
    let existente = produtos.find((p) => p.nome === nome);
    if (!existente) {
      existente = {
        id: gerarId(),
        nome,
        categoria: 'Acompanhamentos',
        preco: 0,
        quantidadeEstoque: 999,
        descricao: '',
        foto: '',
        status: 'ativo',
        comboConfig: null,
        criadoEm: agora,
        atualizadoEm: agora,
      };
      produtos.push(existente);
    }
    return existente;
  }

  combosAntigos.forEach((c) => {
    if (produtos.some((p) => p.id === c.id)) return;
    const includedItemsIds = (c.includedItems || []).map((rotulo) => _obterOuCriarProdutoPorNome(rotulo).id);

    produtos.push({
      id: c.id,
      nome: c.nome,
      categoria: 'Combos',
      preco: c.preco || 0,
      quantidadeEstoque: 0,
      descricao: c.descricao || '',
      foto: c.foto || '',
      status: c.status || 'ativo',
      comboConfig: {
        ordem: c.ordem || 0,
        allowedSkewers: c.allowedSkewers || 1,
        allowedSides: c.allowedSides || 0,
        includedItems: includedItemsIds,
        skewerExtraPrices: c.skewerExtraPrices || {},
      },
      criadoEm: c.criadoEm || agora,
      atualizadoEm: agora,
    });
  });

  _gravarChave(CHAVES.produtos, produtos);
  _gravarChave(CHAVES.acompanhamentos, []);
  _gravarChave(CHAVES.combos, []);
  _gravarChave(CHAVES.migracaoProdutoUnico, true);
}

// ---------------------------------------------------------------------------
// Produtos (Supabase — ver js/services/products-service.js; cache em memória
// aqui pra manter obterProdutos()/obterProdutoPorId()/pesquisarProdutos()
// síncronas)
// ---------------------------------------------------------------------------

let _cacheProdutos = null;

/**
 * Busca os produtos no Supabase e guarda no cache em memória. Precisa ser
 * chamada (com await) antes da primeira renderização em qualquer página que
 * use produtos. Sem fallback silencioso: se der erro, ele sobe pra quem
 * chamou mostrar o estado de erro na tela — não cai pro localStorage antigo.
 */
async function carregarProdutosCache() {
  _cacheProdutos = await buscarProdutosDoSupabase();
  return _cacheProdutos;
}

function obterProdutos() {
  return _cacheProdutos || [];
}

function obterProdutoPorId(id) {
  return obterProdutos().find((p) => p.id === id) || null;
}

/** Cria (sem id) ou atualiza (com id) um produto no Supabase, atualiza o cache e retorna o produto salvo. */
async function salvarProduto(produto) {
  const salvo = produto.id ? await atualizarProdutoNoSupabase(produto.id, produto) : await criarProdutoNoSupabase(produto);
  await carregarProdutosCache();
  return salvo;
}

async function removerProduto(id) {
  await excluirProdutoNoSupabase(id);
  await carregarProdutosCache();
}

/** Filtra produtos por termo de busca (nome/descrição), categoria e status */
function pesquisarProdutos({ termo, categoria, status } = {}) {
  let resultado = obterProdutos();
  if (termo) {
    const alvo = termo.toLowerCase();
    resultado = resultado.filter(
      (p) => p.nome.toLowerCase().includes(alvo) || (p.descricao || '').toLowerCase().includes(alvo)
    );
  }
  if (categoria) resultado = resultado.filter((p) => p.categoria === categoria);
  if (status) resultado = resultado.filter((p) => p.status === status);
  return resultado;
}

// ---------------------------------------------------------------------------
// Estoque (opera sobre produtos + grava em histórico)
// ---------------------------------------------------------------------------

/**
 * Ajusta a quantidade em estoque de um produto e registra o movimento no
 * histórico. tipo: 'entrada' (soma), 'saida' ou 'venda' (subtrai, travado em 0),
 * 'ajuste' (define o valor absoluto informado).
 */
async function ajustarEstoque(produtoId, { tipo, quantidade, observacao } = {}) {
  const produto = obterProdutoPorId(produtoId);
  if (!produto) throw new Error('Produto não encontrado: ' + produtoId);

  const qtd = Number(quantidade) || 0;
  let novaQuantidade = produto.quantidadeEstoque;

  if (tipo === 'entrada') novaQuantidade = produto.quantidadeEstoque + qtd;
  else if (tipo === 'saida' || tipo === 'venda') novaQuantidade = Math.max(0, produto.quantidadeEstoque - qtd);
  else if (tipo === 'ajuste') novaQuantidade = Math.max(0, qtd);

  await atualizarEstoqueNoSupabase(produto.id, novaQuantidade);
  await carregarProdutosCache();

  return registrarHistorico({
    tipo: tipo,
    itens: [
      {
        produtoId: produto.id,
        nome: produto.nome,
        quantidade: qtd,
        valorUnitario: produto.preco,
        valorTotal: produto.preco * qtd,
      },
    ],
    observacao: observacao || '',
  });
}

/** Soma quantidadeEstoque * preco de todos os produtos — Combos não são item físico de estoque, não entram na conta */
function obterValorTotalEstoque() {
  return obterProdutos()
    .filter((p) => p.categoria !== 'Combos')
    .reduce((soma, p) => soma + p.quantidadeEstoque * p.preco, 0);
}

function obterProdutosEstoqueBaixo() {
  return obterProdutos()
    .filter((p) => p.categoria !== 'Combos')
    .filter((p) => {
      const status = calcularStatusEstoque(p.quantidadeEstoque);
      return status === 'amarelo' || status === 'vermelho';
    });
}

function obterProdutosSemEstoque() {
  return obterProdutos().filter((p) => p.categoria !== 'Combos' && p.quantidadeEstoque <= 0);
}

// ---------------------------------------------------------------------------
// Carrinho
// ---------------------------------------------------------------------------

/** Retorna o carrinho já removendo itens órfãos (produto excluído depois de adicionado) — um combo também é um produto, então cai no mesmo caso */
function obterCarrinho() {
  const carrinho = _lerChave(CHAVES.carrinho, []);
  const produtos = obterProdutos();
  const valido = carrinho.filter((item) => produtos.some((p) => p.id === item.produtoId));
  if (valido.length !== carrinho.length) _gravarChave(CHAVES.carrinho, valido);
  return valido;
}

function adicionarAoCarrinho(produtoId, quantidade) {
  const produto = obterProdutoPorId(produtoId);
  if (!produto) throw new Error('Produto não encontrado: ' + produtoId);

  const carrinho = obterCarrinho();
  const existente = carrinho.find((item) => item.produtoId === produtoId);
  const qtd = Number(quantidade) || 1;

  if (existente) {
    existente.quantidade += qtd;
  } else {
    carrinho.push({
      produtoId,
      quantidade: qtd,
      precoUnitario: produto.preco,
      adicionadoEm: new Date().toISOString(),
    });
  }
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

function removerDoCarrinho(produtoId) {
  const carrinho = obterCarrinho().filter((item) => item.produtoId !== produtoId);
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

function atualizarQuantidadeCarrinho(produtoId, quantidade) {
  const carrinho = obterCarrinho();
  const item = carrinho.find((i) => i.produtoId === produtoId);
  if (!item) return carrinho;
  item.quantidade = Math.max(1, Number(quantidade) || 1);
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

function limparCarrinho() {
  _gravarChave(CHAVES.carrinho, []);
}

/**
 * Adiciona um combo já personalizado ao carrinho. Diferente de
 * adicionarAoCarrinho(), NUNCA funde com uma linha existente — duas
 * montagens do mesmo combo podem ter escolhas diferentes, então cada uma
 * vira sua própria linha, identificada por um itemId próprio.
 */
function adicionarComboAoCarrinho(comboId, precoUnitario, composicaoCombo) {
  const carrinho = obterCarrinho();
  carrinho.push({
    itemId: gerarId(),
    produtoId: comboId,
    quantidade: 1,
    precoUnitario,
    combo: composicaoCombo,
    adicionadoEm: new Date().toISOString(),
  });
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

/** Atualiza a personalização (e o preço) de um combo já no carrinho, usado por "Editar escolhas" */
function atualizarComboNoCarrinho(itemId, precoUnitario, composicaoCombo) {
  const carrinho = obterCarrinho();
  const item = carrinho.find((i) => i.itemId === itemId);
  if (!item) return carrinho;
  item.precoUnitario = precoUnitario;
  item.combo = composicaoCombo;
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

/** Remove um item do carrinho pelo itemId (usado pelos itens de combo, que não têm produtoId único) */
function removerItemDoCarrinho(itemId) {
  const carrinho = obterCarrinho().filter((item) => item.itemId !== itemId);
  _gravarChave(CHAVES.carrinho, carrinho);
  return carrinho;
}

/**
 * Finaliza uma venda a partir do carrinho: abate o estoque de cada produto
 * (travado em 0, mesmo que o carrinho tenha ficado com quantidade acima do
 * estoque real por alguma alteração posterior) e grava UMA única entrada
 * no histórico com todos os itens do pedido e a forma de pagamento. Não
 * mexe no carrinho em si — quem chama é responsável por limparCarrinho()
 * depois. Retorna a entrada de histórico criada.
 */
async function finalizarVenda(itensCarrinho, formaPagamento) {
  const itensHistorico = [];

  for (const item of itensCarrinho) {
    if (item.combo) {
      // Combos não têm estoque próprio (não há ficha técnica/baixa por ingrediente
      // hoje) — só entra no histórico com o preço já calculado da personalização.
      // Ponto certo, no futuro, pra dar baixa nos produtos que compõem o combo
      // (ex.: item.combo.espetos/acompanhamentos/incluidos) — não implementado ainda.
      itensHistorico.push({
        produtoId: item.produtoId,
        nome: item.combo.nome,
        quantidade: item.quantidade,
        valorUnitario: item.precoUnitario,
        valorTotal: item.precoUnitario * item.quantidade,
      });
      continue;
    }

    const produto = obterProdutoPorId(item.produtoId);
    if (!produto) continue; // produto pode ter sido excluído nesse meio-tempo

    const quantidadeVendida = Math.min(item.quantidade, produto.quantidadeEstoque);
    await atualizarEstoqueNoSupabase(produto.id, Math.max(0, produto.quantidadeEstoque - quantidadeVendida));

    itensHistorico.push({
      produtoId: produto.id,
      nome: produto.nome,
      quantidade: quantidadeVendida,
      valorUnitario: item.precoUnitario,
      valorTotal: item.precoUnitario * quantidadeVendida,
    });
  }

  await carregarProdutosCache();

  return registrarHistorico({ tipo: 'venda', itens: itensHistorico, formaPagamento });
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

function obterHistorico() {
  return _lerChave(CHAVES.historico, []);
}

/** Adiciona uma entrada ao histórico (vendas e movimentos de estoque) */
function registrarHistorico({ tipo, itens, observacao, formaPagamento } = {}) {
  const historico = obterHistorico();
  const valorTotal = (itens || []).reduce((soma, item) => soma + (item.valorTotal || 0), 0);
  const entrada = {
    id: gerarId(),
    timestamp: new Date().toISOString(),
    tipo,
    itens: itens || [],
    valorTotal,
    observacao: observacao || '',
    formaPagamento: formaPagamento || '', // só preenchido em vendas
  };
  historico.unshift(entrada);
  _gravarChave(CHAVES.historico, historico);
  return entrada;
}

/** Filtra histórico por texto (nome de produto/observação), tipo e período (datas ISO) */
function pesquisarHistorico({ termo, tipo, dataInicio, dataFim } = {}) {
  let resultado = obterHistorico();

  if (termo) {
    const alvo = termo.toLowerCase();
    resultado = resultado.filter(
      (h) =>
        (h.observacao || '').toLowerCase().includes(alvo) ||
        h.itens.some((item) => item.nome.toLowerCase().includes(alvo))
    );
  }
  if (tipo) resultado = resultado.filter((h) => h.tipo === tipo);
  if (dataInicio) resultado = resultado.filter((h) => h.timestamp >= dataInicio);
  if (dataFim) resultado = resultado.filter((h) => h.timestamp <= dataFim);

  return resultado;
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------

/** Retorna as configurações sempre mescladas com os padrões (nunca undefined) */
function obterConfiguracoes() {
  const salvas = _lerChave(CHAVES.configuracoes, {});
  return { ...CONFIGURACOES_PADRAO, ...salvas };
}

function salvarConfiguracoes(config) {
  const atual = obterConfiguracoes();
  const nova = { ...atual, ...config, atualizadoEm: new Date().toISOString() };
  _gravarChave(CHAVES.configuracoes, nova);
  return nova;
}

// ---------------------------------------------------------------------------
// Pedidos de clientes (Supabase — ver js/services/orders-service.js; cache em
// memória aqui, mesmo padrão já usado pra produtos, pra manter
// obterPedidosClientes()/obterPedidoClientePorId() síncronas)
// ---------------------------------------------------------------------------

let _cachePedidosClientes = null;

/** Busca os pedidos no Supabase e guarda no cache em memória. Sem fallback silencioso — erro sobe pra quem chamou. */
async function carregarPedidosClientesCache() {
  _cachePedidosClientes = await getOrders();
  return _cachePedidosClientes;
}

function obterPedidosClientes() {
  return _cachePedidosClientes || [];
}

function obterPedidoClientePorId(id) {
  return obterPedidosClientes().find((p) => p.id === id) || null;
}

/**
 * Exclusão de pedidos — centralizada aqui de propósito (no futuro dá pra
 * restringir a admins só validando antes de chamar essas 3 funções, sem
 * mexer na tela). O número do pedido nunca é reaproveitado: é
 * `orders.order_number` (identity) no Supabase, não depende do tamanho da
 * lista local.
 */
async function removerPedidoCliente(id) {
  await deleteOrderNoSupabase(id);
  await carregarPedidosClientesCache();
}

async function removerPedidosClientes(ids) {
  await deleteOrdersNoSupabase(ids);
  await carregarPedidosClientesCache();
}

/** "Limpar histórico": remove só os pedidos Finalizado — nunca Solicitado/Em Preparo/Pronto (esses são operacionais, ver Painel > Pedidos) */
async function limparPedidosFinalizados() {
  await clearCompletedOrdersNoSupabase();
  await carregarPedidosClientesCache();
}

/**
 * Move um pedido de um status pro próximo via RPC update_order_status — o
 * banco valida de novo que o pedido está exatamente no status esperado
 * (reforço além da checagem que já existe aqui), grava o timestamp da
 * transição e recusa pular etapa.
 */
async function _atualizarStatusPedido(id, novoStatus) {
  const atualizado = await updateOrderStatusNoSupabase(id, novoStatus);
  await carregarPedidosClientesCache();
  return atualizado;
}

/** Funcionário aceitou o pedido: Solicitado -> Em Preparo */
async function aceitarPedido(id) {
  return _atualizarStatusPedido(id, STATUS_PEDIDO.EM_PREPARO);
}

/** Pedido ficou pronto: Em Preparo -> Pronto */
async function marcarPedidoComoPronto(id) {
  return _atualizarStatusPedido(id, STATUS_PEDIDO.PRONTO);
}

/** Pedido foi entregue/retirado: Pronto -> Finalizado */
async function concluirPedido(id) {
  return _atualizarStatusPedido(id, STATUS_PEDIDO.FINALIZADO);
}

// Acompanhamentos e combos não são mais coleções próprias — são produtos
// (categoria "Acompanhamentos" ou "Combos", esta última com `comboConfig`).
// Use pesquisarProdutos()/obterProdutoPorId()/salvarProduto() normalmente.
