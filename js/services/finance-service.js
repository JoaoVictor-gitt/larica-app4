/*
 * finance-service.js — Fase E (Financeiro)
 *
 * Escrita só por RPC (admin, validado no banco), com histórico de eventos:
 *   save_finance_entry (idempotente na criação), pay_finance_entry, undo_finance_payment,
 *   cancel_finance_entry, save_finance_recurrence, generate_finance_recurrences (não
 *   duplica competências), save_finance_category.
 * Leitura: tabelas finance_* (RLS admin) e get_finance_report (DRE, caixa, CMV, contas,
 * rentabilidade — um cálculo só, no banco).
 * Nomes com "Financeiro" para não colidir com funções globais de outras telas.
 */

function _erroFinanceiro(error) {
  const e = new Error(error.message);
  e.dica = error.hint || null;
  return e;
}

function _linhaParaLancamentoFinanceiro(l) {
  return {
    id: l.id,
    tipo: l.kind,
    categoriaId: l.category_id,
    descricao: l.description,
    valor: Number(l.amount),
    competencia: l.competence_date,
    vencimento: l.due_date,
    pagoEm: l.paid_at,
    status: l.status,
    formaPagamento: l.payment_method,
    tipoDespesa: l.expense_type,
    natureza: l.cost_nature,
    observacoes: l.notes,
    documentoId: l.document_id,
    recorrenciaId: l.recurrence_id,
    motivoCancelamento: l.cancel_reason,
    criadoEm: l.created_at,
  };
}

function _linhaParaRecorrenciaFinanceira(r) {
  return {
    id: r.id,
    tipo: r.kind,
    categoriaId: r.category_id,
    descricao: r.description,
    valor: Number(r.amount),
    frequencia: r.frequency,
    inicio: r.start_date,
    fim: r.end_date,
    prazoDias: r.due_offset_days,
    tipoDespesa: r.expense_type,
    natureza: r.cost_nature,
    formaPagamento: r.payment_method,
    observacoes: r.notes,
    ativa: r.active,
  };
}

async function buscarCategoriasFinanceiro() {
  const { data, error } = await supabaseClient.from('finance_categories').select('*').order('name');
  if (error) throw _erroFinanceiro(error);
  return (data || []).map((c) => ({ id: c.id, nome: c.name, tipo: c.kind, chave: c.system_key, ativa: c.active }));
}

/** filtros: { de, ate } por competência (YYYY-MM-DD). Sem filtro: últimos registros. */
async function buscarLancamentosFinanceiro({ de, ate } = {}) {
  let q = supabaseClient.from('finance_entries').select('*').order('competence_date', { ascending: false }).order('created_at', { ascending: false });
  if (de) q = q.gte('competence_date', de);
  if (ate) q = q.lte('competence_date', ate);
  const { data, error } = await q.limit(1000);
  if (error) throw _erroFinanceiro(error);
  return (data || []).map(_linhaParaLancamentoFinanceiro);
}

/** Pendentes (qualquer data) — para contas a pagar/receber. */
async function buscarPendentesFinanceiro() {
  const { data, error } = await supabaseClient.from('finance_entries').select('*').eq('status', 'pending').order('due_date').limit(1000);
  if (error) throw _erroFinanceiro(error);
  return (data || []).map(_linhaParaLancamentoFinanceiro);
}

async function buscarRecorrenciasFinanceiro() {
  const { data, error } = await supabaseClient.from('finance_recurrences').select('*').order('description');
  if (error) throw _erroFinanceiro(error);
  return (data || []).map(_linhaParaRecorrenciaFinanceira);
}

async function buscarEventosLancamentoFinanceiro(id) {
  const { data, error } = await supabaseClient.from('finance_entry_events').select('*').eq('entry_id', id).order('acted_at');
  if (error) throw _erroFinanceiro(error);
  return data || [];
}

async function relatorioFinanceiro(de, ate) {
  const { data, error } = await supabaseClient.rpc('get_finance_report', { p_from: de, p_to: ate });
  if (error) throw _erroFinanceiro(error);
  return data;
}

async function salvarLancamentoFinanceiro(payload) {
  const { data, error } = await supabaseClient.rpc('save_finance_entry', { p_payload: payload });
  if (error) throw _erroFinanceiro(error);
  return { duplicado: !!data.duplicate, lancamento: _linhaParaLancamentoFinanceiro(data.entry) };
}

async function pagarLancamentoFinanceiro(id, pagoEm, forma) {
  const { error } = await supabaseClient.rpc('pay_finance_entry', { p_id: id, p_paid_at: pagoEm, p_payment_method: forma || null });
  if (error) throw _erroFinanceiro(error);
}

async function desfazerPagamentoFinanceiro(id, motivo) {
  const { error } = await supabaseClient.rpc('undo_finance_payment', { p_id: id, p_reason: motivo });
  if (error) throw _erroFinanceiro(error);
}

async function cancelarLancamentoFinanceiro(id, motivo) {
  const { error } = await supabaseClient.rpc('cancel_finance_entry', { p_id: id, p_reason: motivo });
  if (error) throw _erroFinanceiro(error);
}

async function salvarRecorrenciaFinanceiro(payload) {
  const { data, error } = await supabaseClient.rpc('save_finance_recurrence', { p_payload: payload });
  if (error) throw _erroFinanceiro(error);
  return _linhaParaRecorrenciaFinanceira(data);
}

async function gerarRecorrenciasFinanceiro(ate) {
  const { data, error } = await supabaseClient.rpc('generate_finance_recurrences', { p_until: ate });
  if (error) throw _erroFinanceiro(error);
  return Number(data) || 0;
}

async function salvarCategoriaFinanceiro(id, nome, tipo, ativa) {
  const { data, error } = await supabaseClient.rpc('save_finance_category', { p_id: id || null, p_name: nome, p_kind: tipo, p_active: ativa !== false });
  if (error) throw _erroFinanceiro(error);
  return { id: data.id, nome: data.name, tipo: data.kind, chave: data.system_key, ativa: data.active };
}
