/*
 * products-service.js
 * Único arquivo que fala com o Supabase para produtos/combos (tabelas
 * products, combo_configs, combo_skewer_options, combo_included_products).
 * Faz o mapeamento entre o formato relacional do Supabase (inglês) e o
 * formato que o resto do app já usa (produto pt-BR com `comboConfig`
 * aninhado) — quem chama isso (js/storage.js) não precisa saber que existe
 * Supabase por trás. Depende de js/supabase.js (supabaseClient), carregado
 * antes deste arquivo.
 */

const CATEGORIA_PARA_ENUM = {
  Combos: 'combos',
  Espetinhos: 'skewers',
  Acompanhamentos: 'sides',
  Bebidas: 'drinks',
  Outro: 'other',
};

const ENUM_PARA_CATEGORIA = {
  combos: 'Combos',
  skewers: 'Espetinhos',
  sides: 'Acompanhamentos',
  drinks: 'Bebidas',
  other: 'Outro',
};

function _linhaSupabaseParaProduto(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    categoria: ENUM_PARA_CATEGORIA[linha.category] || 'Outro',
    preco: Number(linha.price) || 0,
    quantidadeEstoque: Number(linha.stock_quantity) || 0,
    descricao: linha.description || '',
    foto: linha.image_url || '',
    status: linha.active ? 'ativo' : 'inativo',
    disponivel: linha.is_available !== false, // disponibilidade operacional — distinta de active/status (ver comentário no schema)
    comboConfig: null, // preenchido por buscarProdutosDoSupabase() quando for combo
    criadoEm: linha.created_at || '',
    atualizadoEm: linha.updated_at || '',
  };
}

/** Forma da linha `products` a partir do objeto "produto" que o formulário monta (js/produtos.js) */
function _produtoParaLinhaSupabase(produto) {
  return {
    name: produto.nome,
    description: produto.descricao || '',
    category: CATEGORIA_PARA_ENUM[produto.categoria] || 'other',
    price: Number(produto.preco) || 0,
    stock_quantity: Math.max(0, Number(produto.quantidadeEstoque) || 0),
    image_url: produto.foto || '',
    active: produto.status === 'ativo',
    display_order: produto.comboConfig ? Math.max(0, Number(produto.comboConfig.ordem) || 0) : 0,
  };
}

/** Busca todos os espetos ativos direto no Supabase (fonte da verdade pra saber quem pode ter acréscimo num combo) */
async function _buscarEspetosAtivosNoSupabase() {
  const { data, error } = await supabaseClient.from('products').select('id,name').eq('category', 'skewers').eq('active', true);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Sincroniza combo_configs + combo_skewer_options + combo_included_products pra um
 * produto-combo já salvo em `products` (id = produtoId). Sequencial (sem
 * transação real do lado do client) — se um passo falhar no meio, os
 * passos já feitos ficam commitados; é uma limitação conhecida.
 */
async function _salvarComboConfigNoSupabase(produtoId, comboConfig) {
  const { data: existente, error: erroBusca } = await supabaseClient
    .from('combo_configs')
    .select('id')
    .eq('product_id', produtoId)
    .maybeSingle();
  if (erroBusca) throw new Error(erroBusca.message);

  const camposConfig = {
    product_id: produtoId,
    allowed_skewers: Math.max(1, Number(comboConfig.allowedSkewers) || 1),
    allowed_sides: Math.max(0, Number(comboConfig.allowedSides) || 0),
  };

  if (existente) {
    const { error } = await supabaseClient.from('combo_configs').update(camposConfig).eq('id', existente.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabaseClient.from('combo_configs').insert(camposConfig);
    if (error) throw new Error(error.message);
  }

  // Substitui (delete + insert) as opções de espeto: uma linha por espeto ativo, mesmo os de €0 —
  // isso também é o que define quem é selecionável nesse combo hoje (todo espeto ativo é elegível).
  const { error: erroDeleteOpcoes } = await supabaseClient.from('combo_skewer_options').delete().eq('combo_id', produtoId);
  if (erroDeleteOpcoes) throw new Error(erroDeleteOpcoes.message);

  const espetosAtivos = await _buscarEspetosAtivosNoSupabase();
  const linhasOpcoes = espetosAtivos.map((espeto) => ({
    combo_id: produtoId,
    skewer_product_id: espeto.id,
    extra_price: (comboConfig.skewerExtraPrices && comboConfig.skewerExtraPrices[espeto.id]) || 0,
  }));
  if (linhasOpcoes.length > 0) {
    const { error } = await supabaseClient.from('combo_skewer_options').insert(linhasOpcoes);
    if (error) throw new Error(error.message);
  }

  // Substitui os itens inclusos
  const { error: erroDeleteInclusos } = await supabaseClient.from('combo_included_products').delete().eq('combo_id', produtoId);
  if (erroDeleteInclusos) throw new Error(erroDeleteInclusos.message);

  const linhasInclusos = (comboConfig.includedItems || []).map((idIncluso) => ({
    combo_id: produtoId,
    included_product_id: idIncluso,
  }));
  if (linhasInclusos.length > 0) {
    const { error } = await supabaseClient.from('combo_included_products').insert(linhasInclusos);
    if (error) throw new Error(error.message);
  }
}

/** Busca todos os produtos, remontando comboConfig (combo_configs + combo_skewer_options + combo_included_products) pros combos */
async function buscarProdutosDoSupabase() {
  const { data: linhas, error } = await supabaseClient
    .from('products')
    .select('*')
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);

  const produtos = (linhas || []).map(_linhaSupabaseParaProduto);
  const idsCombos = produtos.filter((p) => p.categoria === 'Combos').map((p) => p.id);
  if (idsCombos.length === 0) return produtos;

  const linhaPorId = new Map((linhas || []).map((l) => [l.id, l]));

  const [respConfigs, respOpcoes, respInclusos] = await Promise.all([
    supabaseClient.from('combo_configs').select('*').in('product_id', idsCombos),
    supabaseClient.from('combo_skewer_options').select('*').in('combo_id', idsCombos),
    supabaseClient.from('combo_included_products').select('*').in('combo_id', idsCombos),
  ]);
  if (respConfigs.error) throw new Error(respConfigs.error.message);
  if (respOpcoes.error) throw new Error(respOpcoes.error.message);
  if (respInclusos.error) throw new Error(respInclusos.error.message);

  const configPorProdutoId = new Map((respConfigs.data || []).map((c) => [c.product_id, c]));

  produtos.forEach((produto) => {
    if (produto.categoria !== 'Combos') return;
    const config = configPorProdutoId.get(produto.id);

    const skewerExtraPrices = {};
    (respOpcoes.data || [])
      .filter((o) => o.combo_id === produto.id)
      .forEach((o) => {
        skewerExtraPrices[o.skewer_product_id] = Number(o.extra_price) || 0;
      });

    const includedItems = (respInclusos.data || []).filter((i) => i.combo_id === produto.id).map((i) => i.included_product_id);

    produto.comboConfig = {
      ordem: (linhaPorId.get(produto.id) || {}).display_order || 0,
      allowedSkewers: config ? Number(config.allowed_skewers) || 1 : 1,
      allowedSides: config ? Number(config.allowed_sides) || 0 : 0,
      includedItems,
      skewerExtraPrices,
    };
  });

  return produtos;
}

/** Cria um produto novo (e, se for combo, sua configuração). Retorna o produto já no formato do app. */
async function criarProdutoNoSupabase(produto) {
  const linha = _produtoParaLinhaSupabase(produto);
  const { data, error } = await supabaseClient.from('products').insert(linha).select().single();
  if (error) throw new Error(error.message);

  if (produto.categoria === 'Combos' && produto.comboConfig) {
    await _salvarComboConfigNoSupabase(data.id, produto.comboConfig);
  }

  return _linhaSupabaseParaProduto(data);
}

/** Atualiza um produto existente (e, se for combo, sua configuração). Retorna o produto já no formato do app. */
async function atualizarProdutoNoSupabase(id, produto) {
  const linha = _produtoParaLinhaSupabase(produto);
  linha.updated_at = new Date().toISOString();
  const { data, error } = await supabaseClient.from('products').update(linha).eq('id', id).select().single();
  if (error) throw new Error(error.message);

  if (produto.categoria === 'Combos' && produto.comboConfig) {
    await _salvarComboConfigNoSupabase(id, produto.comboConfig);
  }

  return _linhaSupabaseParaProduto(data);
}

/**
 * Ajuste manual de estoque — usada por ajustarEstoque() (storage.js). Passa
 * por trás pela RPC `adjust_stock` (staff only), que já valida, aplica o
 * delta de forma atômica e grava a movimentação em stock_movements; nunca
 * escreve stock_quantity diretamente daqui. `delta` é um número com sinal
 * (positivo = entrada, negativo = saída). Retorna o produto já atualizado.
 */
async function ajustarEstoqueNoSupabase(id, delta, motivo) {
  const { data, error } = await supabaseClient.rpc('adjust_stock', {
    p_product_id: id,
    p_quantity_change: delta,
    p_reason: motivo || null,
  });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaProduto(data);
}

/**
 * Alterna a disponibilidade operacional de um produto (is_available) —
 * update pontual, isolado do resto do formulário, pra não sobrescrever
 * outros campos nem passar por _produtoParaLinhaSupabase(). Não mexe em
 * estoque nem em active/status.
 */
async function alternarDisponibilidadeNoSupabase(id, disponivel) {
  const { data, error } = await supabaseClient.from('products').update({ is_available: disponivel }).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaProduto(data);
}

/**
 * Busca o histórico de movimentações de estoque (tabela stock_movements),
 * mais recentes primeiro. Sem `produtoId`, traz de todos os produtos.
 */
async function buscarMovimentacoesEstoqueDoSupabase({ produtoId, limite } = {}) {
  let consulta = supabaseClient.from('stock_movements').select('*').order('created_at', { ascending: false });
  if (produtoId) consulta = consulta.eq('product_id', produtoId);
  if (limite) consulta = consulta.limit(limite);

  const { data, error } = await consulta;
  if (error) throw new Error(error.message);
  return data || [];
}

/** Exclui um produto. Se houver combo dependente (violação de FK, código Postgres 23503), lança mensagem amigável. */
async function excluirProdutoNoSupabase(id) {
  const { error } = await supabaseClient.from('products').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') {
      throw new Error('Este produto está sendo usado por um combo e não pode ser excluído.');
    }
    throw new Error(error.message);
  }
}

/**
 * Migração manual (não é chamada automaticamente em lugar nenhum): lê os
 * produtos que ainda estão no localStorage antigo (caju_produtos) e cria no
 * Supabase os que ainda não existem lá (comparando nome + categoria).
 * Espetos/acompanhamentos são migrados antes dos combos, e as referências
 * internas do combo (itens inclusos, acréscimo por espeto) são remapeadas
 * pros novos ids gerados no Supabase. Rodar manualmente pelo console:
 *   await migrateLocalProductsToSupabase()
 */
async function migrateLocalProductsToSupabase() {
  const bruto = JSON.parse(localStorage.getItem(CHAVES.produtos) || '[]');
  if (bruto.length === 0) {
    console.log('Nenhum produto local encontrado para migrar.');
    return;
  }

  const existentes = await buscarProdutosDoSupabase();
  const jaExiste = (produtoLocal) =>
    existentes.some(
      (p) => p.nome.trim().toLowerCase() === (produtoLocal.nome || '').trim().toLowerCase() && p.categoria === produtoLocal.categoria
    );

  // Combos por último, pra garantir que espetos/itens inclusos que eles referenciam já existam no Supabase.
  const ordenados = [...bruto].sort((a, b) => (a.categoria === 'Combos' ? 1 : 0) - (b.categoria === 'Combos' ? 1 : 0));

  const idsAntigosParaNovos = {};
  let criados = 0;
  let ignorados = 0;

  for (const produtoLocal of ordenados) {
    if (jaExiste(produtoLocal)) {
      ignorados++;
      continue;
    }

    const comboConfig = produtoLocal.comboConfig
      ? {
          ...produtoLocal.comboConfig,
          includedItems: (produtoLocal.comboConfig.includedItems || []).map((idAntigo) => idsAntigosParaNovos[idAntigo] || idAntigo),
          skewerExtraPrices: Object.fromEntries(
            Object.entries(produtoLocal.comboConfig.skewerExtraPrices || {}).map(([idAntigo, valor]) => [
              idsAntigosParaNovos[idAntigo] || idAntigo,
              valor,
            ])
          ),
        }
      : null;

    const criado = await criarProdutoNoSupabase({ ...produtoLocal, comboConfig });
    idsAntigosParaNovos[produtoLocal.id] = criado.id;
    criados++;
  }

  console.log(`Migração concluída: ${criados} produto(s) criado(s), ${ignorados} ignorado(s) (já existiam).`);
}
