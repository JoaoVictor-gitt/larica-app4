/*
 * ingredients-service.js
 * Único arquivo que fala com o Supabase para public.ingredients (Etapa 1 de
 * Ingredientes/Fichas Técnicas/Sub-receitas). Tabela administrativa isolada,
 * mesmo padrão de segurança de product_costs: anon sem GRANT nenhum, staff
 * só visualiza, admin cria/edita/exclui (RLS, ver migration 20260817160000).
 * NUNCA carregar este arquivo em pedido.html/js/pedido.js. Isolado de
 * products-service.js de propósito — ingredient não é product. Depende de
 * js/supabase.js (supabaseClient), carregado antes deste arquivo.
 */

/** Converte uma linha crua do Supabase (snake_case) pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaIngrediente(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    tipoUnidade: linha.unit_type,
    unidadeBase: linha.base_unit,
    quantidadeCompraExibicao: Number(linha.purchase_quantity_display),
    unidadeCompraExibicao: linha.purchase_display_unit,
    quantidadeBaseCompra: Number(linha.purchase_quantity_base),
    precoCompra: Number(linha.purchase_price),
    custoPorUnidadeBase: linha.cost_per_base_unit === null ? null : Number(linha.cost_per_base_unit),
    categoria: linha.category,
    ativo: linha.active,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    atualizadoPor: linha.updated_by,
  };
}

/** Busca todos os ingredientes numa única consulta (nunca N+1). Staff enxerga ativos e inativos — o filtro de exibição fica na tela, não aqui. */
async function buscarIngredientesDoSupabase() {
  const { data, error } = await supabaseClient.from('ingredients').select('*').order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaIngrediente);
}

/**
 * Cria um ingrediente. `dados` já deve trazer a quantidade convertida pra
 * unidade base (purchaseQuantityBase) — a conversão kg→g/L→ml acontece na
 * tela, nunca aqui. RLS restringe esta operação a admin.
 */
async function criarIngredienteNoSupabase(dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('ingredients')
    .insert({
      name: dados.nome,
      unit_type: dados.tipoUnidade,
      base_unit: dados.unidadeBase,
      purchase_quantity_display: dados.quantidadeCompraExibicao,
      purchase_display_unit: dados.unidadeCompraExibicao,
      purchase_quantity_base: dados.quantidadeBaseCompra,
      purchase_price: dados.precoCompra,
      category: dados.categoria || null,
      active: dados.ativo !== false,
      updated_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaIngrediente(data);
}

/** Atualiza um ingrediente existente — sempre reenvia todos os campos editáveis (mesmo cuidado de nunca deixar um UPDATE parcial ambíguo sobre o que não foi enviado). RLS restringe esta operação a admin. */
async function atualizarIngredienteNoSupabase(id, dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('ingredients')
    .update({
      name: dados.nome,
      unit_type: dados.tipoUnidade,
      base_unit: dados.unidadeBase,
      purchase_quantity_display: dados.quantidadeCompraExibicao,
      purchase_display_unit: dados.unidadeCompraExibicao,
      purchase_quantity_base: dados.quantidadeBaseCompra,
      purchase_price: dados.precoCompra,
      category: dados.categoria || null,
      active: dados.ativo !== false,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaIngrediente(data);
}

/** Ativa/desativa um ingrediente (soft toggle) — ação recomendada em vez de exclusão física. RLS restringe esta operação a admin. */
async function alternarStatusIngredienteNoSupabase(id, ativo) {
  const { error } = await supabaseClient.from('ingredients').update({ active: ativo, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Exclusão física — disponível no service mas não exposta na UI desta
 * etapa (nenhuma tabela referencia ingredients ainda, já que recipe_items
 * só existe a partir da Etapa 2/3). Ativar/desativar é a ação recomendada
 * em qualquer listagem administrativa deste projeto. RLS restringe a admin.
 */
async function excluirIngredienteNoSupabase(id) {
  const { error } = await supabaseClient.from('ingredients').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
