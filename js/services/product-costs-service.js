/*
 * product-costs-service.js
 * Único arquivo que fala com o Supabase para public.product_costs (custo
 * unitário atual de cada produto — Custos/Margem, Etapa 2). Tabela separada
 * de products de propósito (Etapa 1): anon não tem GRANT nenhum aqui, só
 * authenticated (SELECT para staff, INSERT/UPDATE para admin, via RLS —
 * ver migration 20260817140000). NUNCA carregar este arquivo em pedido.html/
 * js/pedido.js (área pública) — só nas páginas admin que precisam mostrar/
 * editar custo (produtos.js). Depende de js/supabase.js (supabaseClient),
 * carregado antes deste arquivo.
 */

/**
 * Busca o custo atual de todos os produtos numa única consulta (nunca uma
 * por produto — evita N+1 na tela de Produtos). Produtos sem linha aqui
 * simplesmente não aparecem no resultado; quem chama trata a ausência como
 * "custo não cadastrado" (equivalente a unit_cost NULL), nunca como 0.
 */
async function buscarCustosProdutosDoSupabase() {
  const { data, error } = await supabaseClient.from('product_costs').select('product_id, unit_cost, updated_at, updated_by');
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Cria ou atualiza o custo de um produto (upsert por product_id, que é
 * PRIMARY KEY). unitCost pode ser `null` — nesse caso a linha é gravada/
 * mantida com unit_cost NULL em vez de removida, pela mesma razão de sempre:
 * ausência física de linha e unit_cost NULL já são equivalentes em toda
 * leitura (create_customer_order, esta tela), então upsert com NULL é mais
 * simples que ter dois caminhos (upsert vs delete) fazendo a mesma coisa.
 * RLS restringe esta operação a admin — um employee que tentar chamar isto
 * recebe erro do Supabase (não é a única barreira: a UI também desabilita o
 * campo pra employee, ver produtos.js, mas a garantia real é aqui).
 */
async function salvarCustoProdutoNoSupabase(productId, unitCost) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { error } = await supabaseClient.from('product_costs').upsert(
    {
      product_id: productId,
      unit_cost: unitCost,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    },
    { onConflict: 'product_id' }
  );
  if (error) throw new Error(error.message);
}
