/*
 * skewer-production-service.js
 * Único arquivo que fala com o Supabase para public.skewer_production_batches
 * (Produção de Espetos, Etapa 2). Mesmo padrão de segurança de ingredients/
 * recipes: anon sem GRANT nenhum, staff só visualiza, admin cria/edita/
 * exclui (RLS, ver migration 20260818090000). Isolado de products-service.js
 * e ingredients-service.js de propósito — um lote de produção não é nem um
 * produto nem um ingrediente, só referencia os dois por id.
 *
 * Perda, rendimento, custos, quantidade teórica e sobra NUNCA são calculados
 * nem persistidos aqui — sempre on-read em js/producao.js
 * (calcularIndicadoresLoteEspetos), a partir dos campos brutos gravados
 * nesta tabela. Depende de js/supabase.js (supabaseClient), carregado antes
 * deste arquivo.
 */

/** Converte uma linha crua do Supabase (snake_case) pro formato pt-BR usado no restante do projeto. */
function _linhaSupabaseParaLoteEspeto(linha) {
  return {
    id: linha.id,
    produtoId: linha.product_id,
    ingredienteId: linha.ingredient_id,
    produzidoEm: linha.produced_at,
    pesoBrutoG: Number(linha.gross_weight_g),
    pesoUtilG: Number(linha.usable_weight_g),
    custoTotal: Number(linha.total_cost),
    pesoEspetoG: Number(linha.skewer_weight_g),
    quantidadeReal: Number(linha.actual_quantity),
    criadoEm: linha.created_at,
    atualizadoEm: linha.updated_at,
    criadoPor: linha.created_by,
    atualizadoPor: linha.updated_by,
  };
}

/** Busca todos os lotes numa única consulta (nunca N+1), mais recentes primeiro (produzido em, depois criado em). */
async function buscarLotesEspetosDoSupabase() {
  const { data, error } = await supabaseClient
    .from('skewer_production_batches')
    .select('*')
    .order('produced_at', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_linhaSupabaseParaLoteEspeto);
}

/**
 * Cria um lote de produção. `dados` já deve trazer os pesos convertidos pra
 * gramas (a conversão kg->g acontece na tela, nunca aqui) e `produzidoEm`
 * como string 'YYYY-MM-DD' (sem conversão de fuso). RLS restringe esta
 * operação a admin. Grava created_by E updated_by com o usuário atual —
 * diferente de ingredients/recipes (só updated_by), esta tabela tem as duas
 * colunas desde a Etapa 1.
 */
async function criarLoteEspetosNoSupabase(dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('skewer_production_batches')
    .insert({
      product_id: dados.produtoId,
      ingredient_id: dados.ingredienteId || null,
      produced_at: dados.produzidoEm,
      gross_weight_g: dados.pesoBrutoG,
      usable_weight_g: dados.pesoUtilG,
      total_cost: dados.custoTotal,
      skewer_weight_g: dados.pesoEspetoG,
      actual_quantity: dados.quantidadeReal,
      created_by: userId,
      updated_by: userId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaLoteEspeto(data);
}

/** Atualiza um lote existente — sempre reenvia todos os campos editáveis. Nunca toca created_by. RLS restringe esta operação a admin. */
async function atualizarLoteEspetosNoSupabase(id, dados) {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  const userId = session && session.user ? session.user.id : null;

  const { data, error } = await supabaseClient
    .from('skewer_production_batches')
    .update({
      product_id: dados.produtoId,
      ingredient_id: dados.ingredienteId || null,
      produced_at: dados.produzidoEm,
      gross_weight_g: dados.pesoBrutoG,
      usable_weight_g: dados.pesoUtilG,
      total_cost: dados.custoTotal,
      skewer_weight_g: dados.pesoEspetoG,
      actual_quantity: dados.quantidadeReal,
      updated_at: new Date().toISOString(),
      updated_by: userId,
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return _linhaSupabaseParaLoteEspeto(data);
}

/** Exclusão física — nesta etapa nenhuma tabela referencia skewer_production_batches (sem stock_movements automático ainda), então nenhum erro de FK é esperado. RLS restringe a admin. */
async function excluirLoteEspetosNoSupabase(id) {
  const { error } = await supabaseClient.from('skewer_production_batches').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
