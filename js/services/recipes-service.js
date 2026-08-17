/*
 * recipes-service.js
 * Único arquivo que fala com o Supabase para public.recipes e
 * public.recipe_items. Mesmo padrão de segurança de ingredients: anon sem
 * GRANT nenhum, staff só visualiza, admin escreve. NUNCA carregar este
 * arquivo em pedido.html/js/pedido.js.
 *
 * Escrita (criar/editar) de recipe_items — ingrediente OU sub-receita —
 * passa inteira pela RPC administrativa save_recipe_item (migration
 * 20260817172000): nunca um INSERT/UPDATE direto na tabela. A RPC valida
 * unidade (contra ingredients.base_unit ou o rendimento calculado da
 * sub-receita) e detecta ciclo indireto server-side — não confia em nada
 * calculado no client. Remoção de item continua um DELETE direto (RLS já
 * basta, remover não tem risco de ciclo/unidade).
 *
 * Custo/rendimento nunca são calculados nem persistidos aqui — sempre
 * on-read em js/producao.js a partir de ingredients.cost_per_base_unit e
 * recipe_items, nunca gravado de volta no banco. Depende de js/supabase.js
 * (supabaseClient), carregado antes deste arquivo.
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
 * Exclui uma ficha técnica. RLS (recipes_delete_admin) restringe a admin.
 * Se a ficha estiver em uso como preparo de outra (recipe_items.
 * subrecipe_id, sem ON DELETE CASCADE de propósito), o Postgres recusa com
 * violação de FK (23503) — mapeada aqui pra mensagem amigável. Nunca
 * tentamos apagar/desvincular a referência de quem usa antes: a exclusão
 * simplesmente falha, sem efeito cascata escondido.
 */
async function excluirReceitaNoSupabase(id) {
  const { error } = await supabaseClient.from('recipes').delete().eq('id', id);
  if (error) {
    if (error.code === '23503') {
      throw new Error('Esta ficha é usada em outra preparação e não pode ser excluída.');
    }
    throw new Error(error.message);
  }
}

/**
 * Cria (itemId nulo) ou atualiza (itemId preenchido) um item de receita —
 * ingrediente OU sub-receita — sempre via a RPC save_recipe_item, nunca um
 * INSERT/UPDATE direto em recipe_items. `quantidade`/`unidade` já devem
 * estar na unidade BASE do item referenciado (conversão kg->g/L->ml, ou a
 * unidade de rendimento da sub-receita, acontece na tela, nunca aqui). A
 * RPC valida tudo server-side (unidade, ciclo, admin) — não confiar em
 * nenhuma validação feita só no client.
 */
async function salvarItemReceitaNoSupabase({ itemId, receitaId, tipoItem, referenciaId, quantidade, unidade }) {
  const { data, error } = await supabaseClient.rpc('save_recipe_item', {
    p_item_id: itemId || null,
    p_recipe_id: receitaId,
    p_item_type: tipoItem,
    p_reference_id: referenciaId,
    p_quantity: quantidade,
    p_unit: unidade,
  });
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaItemReceita(data);
}

/** Remove um item de uma receita (ingrediente ou sub-receita — remover nunca cria ciclo/incompatibilidade de unidade, por isso continua um DELETE direto, sem RPC). RLS restringe a admin. */
async function excluirItemReceitaNoSupabase(id) {
  const { error } = await supabaseClient.from('recipe_items').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
