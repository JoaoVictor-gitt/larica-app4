/*
 * permissions-service.js
 * Único arquivo que fala com o Supabase para permissões granulares (RPCs
 * has_permission/is_admin + tabela user_permissions). Depende de
 * js/supabase.js (supabaseClient), carregado antes deste arquivo.
 *
 * PERMISSOES_SISTEMA é só catálogo de UI (rótulos pra telas futuras) — a
 * segurança real continua inteiramente no CHECK de user_permissions.permission
 * e na lógica de has_permission()/is_admin() no banco.
 *
 * listarMinhasPermissoesNoSupabase() devolvendo [] é o resultado NORMAL para
 * um admin (que nunca precisa de linhas em user_permissions) — nunca
 * interpretar array vazio como "sem acesso". Quem decide acesso de verdade é
 * sempre temPermissaoNoSupabase()/usuarioEhAdminNoSupabase().
 */

const PERMISSOES_SISTEMA = [
  { codigo: 'dashboard.view', modulo: 'Dashboard', acao: 'Visualizar' },
  { codigo: 'orders.view', modulo: 'Pedidos', acao: 'Visualizar' },
  { codigo: 'orders.manage', modulo: 'Pedidos', acao: 'Gerenciar' },
  { codigo: 'products.view', modulo: 'Produtos', acao: 'Visualizar' },
  { codigo: 'products.manage', modulo: 'Produtos', acao: 'Gerenciar' },
  { codigo: 'stock.view', modulo: 'Estoque', acao: 'Visualizar' },
  { codigo: 'stock.manage', modulo: 'Estoque', acao: 'Gerenciar' },
  { codigo: 'production.view', modulo: 'Produção', acao: 'Visualizar' },
  { codigo: 'history.view', modulo: 'Histórico', acao: 'Visualizar' },
  { codigo: 'reports.view', modulo: 'Relatórios', acao: 'Visualizar' },
  { codigo: 'settings.manage', modulo: 'Configurações', acao: 'Gerenciar' },
  { codigo: 'users.manage', modulo: 'Usuários', acao: 'Gerenciar' },
];

/** Se o usuário autenticado atual tem a permissão informada — fonte de verdade é a RPC has_permission() (banco), nunca inferida no cliente. */
async function temPermissaoNoSupabase(permissao) {
  const { data, error } = await supabaseClient.rpc('has_permission', { p_permission: permissao });
  if (error) throw new Error(error.message);
  return !!data;
}

/** Se o usuário autenticado atual é admin — fonte de verdade é a RPC is_admin() (banco). */
async function usuarioEhAdminNoSupabase() {
  const { data, error } = await supabaseClient.rpc('is_admin');
  if (error) throw new Error(error.message);
  return !!data;
}

/**
 * Permissões concedidas ao próprio usuário autenticado. RLS já limita employee
 * a só suas linhas, mas o filtro por user_id é sempre explícito aqui — nunca
 * dependemos só da policy pra restringir (admin consegue ler todo mundo via
 * RLS, então um SELECT sem filtro seria perigoso se este arquivo for
 * reaproveitado de outro jeito no futuro).
 */
async function listarMinhasPermissoesNoSupabase() {
  const {
    data: { session },
    error: erroSessao,
  } = await supabaseClient.auth.getSession();
  if (erroSessao) throw new Error(erroSessao.message);
  if (!session || !session.user || !session.user.id) throw new Error('Nenhuma sessão autenticada.');

  const { data, error } = await supabaseClient.from('user_permissions').select('permission').eq('user_id', session.user.id);
  if (error) throw new Error(error.message);
  return (data || []).map((linha) => linha.permission);
}

/** Permissões concedidas a um usuário específico — uso pretendido: área admin (tela de usuários, futura). RLS decide quem pode chamar; não há bypass aqui. */
async function listarPermissoesUsuarioNoSupabase(userId) {
  const { data, error } = await supabaseClient
    .from('user_permissions')
    .select('user_id, permission, granted_at, granted_by')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Concede uma permissão a um usuário. Nunca envia granted_at/granted_by (o
 * banco preenche). Sem upsert — se a concessão já existir (23505, PK
 * duplicada), trata como no-op idempotente; qualquer outro erro (incluindo
 * RLS recusando por quem chama não ser admin) sobe normalmente.
 */
async function concederPermissaoNoSupabase(userId, permissao) {
  const { error } = await supabaseClient.from('user_permissions').insert({ user_id: userId, permission: permissao });
  if (error) {
    if (error.code === '23505') return;
    throw new Error(error.message);
  }
}

/** Revoga uma permissão de um usuário. RLS garante admin-only — nenhuma checagem extra aqui. */
async function revogarPermissaoNoSupabase(userId, permissao) {
  const { error } = await supabaseClient.from('user_permissions').delete().eq('user_id', userId).eq('permission', permissao);
  if (error) throw new Error(error.message);
}
