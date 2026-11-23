/*
 * dashboard-service.js — Fase F. Uma leitura só: get_dashboard (vendas, série diária,
 * mais vendidos, alertas de estoque, produções recentes; bloco financeiro só para admin).
 */
async function buscarPainelDashboard(de, ate) {
  const { data, error } = await supabaseClient.rpc('get_dashboard', { p_from: de, p_to: ate });
  if (error) throw new Error(error.message);
  return data;
}
