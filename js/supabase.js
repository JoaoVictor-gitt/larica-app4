/*
 * supabase.js
 * Cliente único do Supabase (usa o build UMD via CDN, carregado antes deste
 * arquivo, que expõe o global `supabase.createClient`) + funções de auth
 * administrativa reutilizadas por login.js e app.js. Só a Publishable Key é
 * usada aqui — nunca service_role. Esta etapa não migra dados de produtos,
 * pedidos, estoque ou configurações: isso continua em localStorage.
 */

const SUPABASE_URL = 'https://ghntpyqdbgxaisfgytto.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_utq0eL8lb1OLVVLrFQPFEw_WcrX4lfe';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Testa se o Supabase está acessível. Chamar no máximo uma vez por carregamento de página (ex.: login.html). */
async function testarConexaoSupabase() {
  try {
    const { error } = await supabaseClient.from('products').select('id').limit(1);
    if (error) {
      console.error('Supabase: falha na conexão —', error.message);
      return;
    }
    console.log('Supabase conectado com sucesso');
  } catch (erro) {
    console.error('Supabase: falha na conexão —', erro.message);
  }
}

/** Busca o perfil (public.profiles) do usuário autenticado pelo id do auth.users. */
async function obterPerfilUsuario(userId) {
  const { data, error } = await supabaseClient.from('profiles').select('*').eq('id', userId).single();
  if (error) {
    console.error('Erro ao consultar perfil:', error.message);
    return null;
  }
  return data;
}

function isAdmin(perfil) {
  return !!perfil && perfil.role === 'admin';
}

function isEmployee(perfil) {
  return !!perfil && perfil.role === 'employee';
}

function isStaff(perfil) {
  return !!perfil && perfil.active === true && (isAdmin(perfil) || isEmployee(perfil));
}

/**
 * Protege as páginas do Painel Administrativo. Chamada por app.js antes de
 * montar a sidebar. Sem sessão ou sem perfil autorizado -> redireciona para
 * login.html e retorna null (quem chamou deve interromper a montagem da página).
 */
async function requireStaffAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }

  const perfil = await obterPerfilUsuario(session.user.id);
  if (!isStaff(perfil)) {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html?erro=sem_permissao';
    return null;
  }

  document.body.classList.add('autenticado');
  return { session, perfil };
}

async function fazerLogoutAdmin() {
  await supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}
