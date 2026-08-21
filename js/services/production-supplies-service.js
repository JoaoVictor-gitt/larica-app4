/*
 * production-supplies-service.js
 * Único arquivo que fala com o Supabase para public.production_supplies
 * (Etapa 3A de Produção de Espetos). Cadastro administrativo standalone,
 * mesmo padrão de segurança de ingredients: anon sem GRANT nenhum, staff só
 * visualiza, admin cria/edita/exclui (RLS, ver migration 20260818100000).
 * Depende de js/supabase.js (supabaseClient), carregado antes deste arquivo.
 *
 * Etapa I4: `js/producao.js` removeu o CRUD standalone de Insumos (tela
 * própria em producao.html) — Compras -> Itens de Compra passou a ser a
 * única porta de cadastro/edição de insumos (via save_purchase_item/
 * finalize_purchase_item, que auto-vinculam production_supplies pra
 * category IN ('supply','packaging'), Etapa I2). Consequência: nenhuma UI
 * deste projeto chama mais `criarInsumoProducaoNoSupabase`,
 * `atualizarInsumoProducaoNoSupabase`, `alternarStatusInsumoProducaoNoSupabase`
 * ou `excluirInsumoProducaoNoSupabase` — mantidas aqui como legado interno
 * (nenhum diff desnecessário), não removidas. `buscarInsumosProducaoDoSupabase`
 * continua sendo a única função realmente usada (por `producao.js`, pra
 * popular `insumosProducaoCache` e o seletor "Tipo = Insumo" + lote da
 * Produção de Espetos, Etapa I3).
 */

/** Converte uma linha crua do Supabase (snake_case) pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaInsumoProducao(linha) {
  return {
    id: linha.id,
    nome: linha.name,
    quantidadeCompra: Number(linha.purchase_quantity),
    precoCompra: Number(linha.purchase_price),
    tipoUnidade: linha.unit_type,
    custoPorUnidade: linha.cost_per_unit === null ? null : Number(linha.cost_per_unit),
    ativo: linha.active,
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
    atualizadoPor: linha.updated_by,
  };
}

/** Busca todos os insumos numa única consulta (nunca N+1). Staff enxerga ativos e inativos — o filtro de exibição fica na tela. */
async function buscarInsumosProducaoDoSupabase() {
  const { data, error } = await supabaseClient.from('production_supplies').select('*').order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaInsumoProducao);
}

/**
 * Cria um insumo. RLS restringe esta operação a admin. Grava created_by E
 * updated_by com o usuário atual — diferente de ingredients (só
 * updated_by), esta tabela tem as duas colunas desde a Etapa 3A (mesmo
 * padrão de skewer_production_batches).
 */
async function criarInsumoProducaoNoSupabase(dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('production_supplies')
    .insert({
      name: dados.nome,
      purchase_quantity: dados.quantidadeCompra,
      purchase_price: dados.precoCompra,
      active: dados.ativo !== false,
      created_by: userId,
      updated_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaInsumoProducao(data);
}

/** Atualiza um insumo existente — sempre reenvia todos os campos editáveis. Nunca toca created_by. RLS restringe esta operação a admin. */
async function atualizarInsumoProducaoNoSupabase(id, dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('production_supplies')
    .update({
      name: dados.nome,
      purchase_quantity: dados.quantidadeCompra,
      purchase_price: dados.precoCompra,
      active: dados.ativo !== false,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaInsumoProducao(data);
}

/** Ativa/desativa um insumo (soft toggle) — ação recomendada em vez de exclusão física. updated_at explícito, sem trigger. RLS restringe esta operação a admin. */
async function alternarStatusInsumoProducaoNoSupabase(id, ativo) {
  const { error } = await supabaseClient
    .from('production_supplies')
    .update({ active: ativo, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Exclusão física — disponível no service mas não exposta como ação
 * principal na UI desta etapa (nenhuma tabela referencia
 * production_supplies ainda, já que skewer_batch_components só existe a
 * partir da Etapa 3B). Ativar/desativar é a ação recomendada em qualquer
 * listagem administrativa deste projeto. RLS restringe a admin.
 */
async function excluirInsumoProducaoNoSupabase(id) {
  const { error } = await supabaseClient.from('production_supplies').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
