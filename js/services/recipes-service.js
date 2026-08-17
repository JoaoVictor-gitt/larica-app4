/*
 * recipes-service.js
 * Único arquivo que fala com o Supabase para public.recipes e
 * public.recipe_items (Etapa 2 de Ingredientes/Fichas Técnicas/
 * Sub-receitas). Mesmo padrão de segurança de ingredients: anon sem GRANT
 * nenhum, staff só visualiza, admin cria/edita/exclui (RLS, ver migration
 * 20260817170000). NUNCA carregar este arquivo em pedido.html/js/pedido.js.
 * Nesta etapa só item_type='ingredient' é gravado — subrecipe_id existe no
 * schema mas nenhuma função aqui o preenche (Etapa 3). Custo nunca é
 * calculado nem persistido aqui — isso é sempre feito on-read em
 * js/producao.js a partir de ingredients.cost_per_base_unit, nunca gravado
 * de volta no banco. Depende de js/supabase.js (supabaseClient), carregado
 * antes deste arquivo.
 */

/** Converte uma linha crua de recipes (snake_case) pro formato pt-BR usado no restante do projeto. Sem campo de rendimento — é sempre calculado on-read em js/producao.js a partir de recipe_items, nunca persistido. */
function _linhaSupabaseParaReceita(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    ativo: linha.active,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    atualizadoPor: linha.updated_by,
  };
}

/** Converte uma linha crua de recipe_items pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaItemReceita(linha) {
  return {
    id: linha.id,
    receitaId: linha.recipe_id,
    tipoItem: linha.item_type,
    ingredienteId: linha.ingredient_id,
    subReceitaId: linha.subrecipe_id,
    quantidade: Number(linha.quantity),
    unidade: linha.unit,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
  };
}

/** Busca todas as receitas numa única consulta (nunca N+1). Staff enxerga ativas e inativas — o filtro de exibição fica na tela. */
async function buscarReceitasDoSupabase() {
  const { data, error } = await supabaseClient.from('recipes').select('*').order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaReceita);
}

/**
 * Busca TODOS os itens de TODAS as receitas numa única consulta, sem
 * filtro por recipe_id — quem chama agrupa em memória (Map por receitaId).
 * Evita N+1: nunca uma consulta por receita.
 */
async function buscarItensReceitasDoSupabase() {
  const { data, error } = await supabaseClient.from('recipe_items').select('*');
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaItemReceita);
}

/** Cria uma receita (só Nome — rendimento não é mais um campo cadastrado, é calculado a partir dos itens depois de adicionados). RLS restringe esta operação a admin. */
async function criarReceitaNoSupabase(dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('recipes')
    .insert({
      name: dados.nome,
      active: dados.ativo !== false,
      updated_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaReceita(data);
}

/** Atualiza o nome de uma receita (única coisa editável em metadados agora). RLS restringe a admin. */
async function atualizarReceitaNoSupabase(id, dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('recipes')
    .update({
      name: dados.nome,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaReceita(data);
}

/** Ativa/desativa uma receita (soft toggle). RLS restringe a admin. */
async function alternarStatusReceitaNoSupabase(id, ativo) {
  const { error } = await supabaseClient.from('recipes').update({ active: ativo, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Adiciona um ingrediente a uma receita. `dados.quantidade`/`dados.unidade`
 * já devem estar convertidos pra unidade BASE do ingrediente (g/ml/un) — a
 * conversão kg->g/L->ml acontece na tela, nunca aqui. Sempre
 * item_type='ingredient' nesta etapa. RLS restringe a admin.
 */
async function criarItemReceitaNoSupabase(dados) {
  const { data, error } = await supabaseClient
    .from('recipe_items')
    .insert({
      recipe_id: dados.receitaId,
      item_type: 'ingredient',
      ingredient_id: dados.ingredienteId,
      quantity: dados.quantidade,
      unit: dados.unidade,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemReceita(data);
}

/** Atualiza quantidade/unidade de um item de receita já existente. RLS restringe a admin. */
async function atualizarItemReceitaNoSupabase(id, dados) {
  const { data, error } = await supabaseClient
    .from('recipe_items')
    .update({
      quantity: dados.quantidade,
      unit: dados.unidade,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemReceita(data);
}

/** Remove um item de uma receita. RLS restringe a admin. */
async function excluirItemReceitaNoSupabase(id) {
  const { error } = await supabaseClient.from('recipe_items').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
