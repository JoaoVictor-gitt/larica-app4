/*
 * login.js
 * Tela de login do Painel Administrativo (login.html). Depende de
 * js/supabase.js e js/services/permissions-service.js (carregados antes
 * deste) para o client e as funções obterPerfilUsuario/isStaff/
 * listarMinhasPermissoesNoSupabase. Não usa js/app.js nem js/storage.js —
 * esta página não tem sidebar e não depende dos dados locais do app.
 */

/**
 * Ordem de prioridade pra decidir a primeira página após login de um employee — espelha a ordem/
 * permissão de MENU_ADMIN (js/app.js), duplicada aqui de propósito: login.js não carrega app.js nem
 * storage.js (ver cabeçalho acima), e MENU_ADMIN depende de storage.js indiretamente via o resto do
 * app.js. Lista pequena e estável (Fase 10C/Etapa 1 já aceitou o mesmo tipo de duplicação controlada
 * pra permissões), mantida manualmente em sincronia com MENU_ADMIN se um módulo for adicionado/reordenado.
 */
const PAGINAS_POR_PERMISSAO_LOGIN = [
  { permissao: 'dashboard.view', href: 'dashboard.html' },
  { permissao: 'orders.view', href: 'pedidos.html' },
  { permissao: 'products.view', href: 'produtos.html' },
  { permissao: 'stock.view', href: 'estoque.html' },
  { permissao: 'history.view', href: 'historico.html' },
  { permissao: 'settings.manage', href: 'configuracoes.html' },
];

document.addEventListener('DOMContentLoaded', () => {
  testarConexaoSupabase();
  mostrarErroDaUrlSePresente();
  document.getElementById('form-login').addEventListener('submit', tratarSubmitLogin);
});

/** Se app.js redirecionou aqui por falta de permissão, mostra a mesma mensagem ao carregar. */
function mostrarErroDaUrlSePresente() {
  const parametros = new URLSearchParams(window.location.search);
  if (parametros.get('erro') === 'sem_permissao') {
    exibirErroLogin('Usuário sem permissão para acessar o painel.');
  }
}

async function tratarSubmitLogin(evento) {
  evento.preventDefault();
  exibirErroLogin('');

  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;
  definirCarregandoLogin(true);

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: senha });
  if (error) {
    exibirErroLogin('E-mail ou senha inválidos.');
    definirCarregandoLogin(false);
    return;
  }

  const perfil = await obterPerfilUsuario(data.user.id);
  if (!isStaff(perfil)) {
    await supabaseClient.auth.signOut();
    exibirErroLogin('Usuário sem permissão para acessar o painel.');
    definirCarregandoLogin(false);
    return;
  }

  window.location.href = await primeiraPaginaAposLogin(perfil);
}

/**
 * Admin sempre vai pro Dashboard. Employee vai pra primeira página que ele realmente tem permissão
 * (evita o guard de app.js barrar e redirecionar de novo logo em seguida). Isso é só UX — se a consulta
 * de permissões falhar (rede), cai pra 'dashboard.html' e o guard central de app.js decide corretamente
 * a partir daí (inclusive fail closed/logout se for o caso) — login.js nunca é o boundary de segurança.
 */
async function primeiraPaginaAposLogin(perfil) {
  if (isAdmin(perfil)) return 'dashboard.html';

  try {
    const permissoes = await listarMinhasPermissoesNoSupabase();
    const encontrada = PAGINAS_POR_PERMISSAO_LOGIN.find((p) => permissoes.includes(p.permissao));
    if (encontrada) return encontrada.href;
  } catch (erro) {
    // sem problema — o guard de app.js na página de destino trata isso corretamente
  }

  return 'dashboard.html';
}

function exibirErroLogin(mensagem) {
  document.getElementById('erro-login').textContent = mensagem || '';
}

function definirCarregandoLogin(carregando) {
  const botao = document.getElementById('botao-entrar');
  botao.disabled = carregando;
  botao.textContent = carregando ? 'Entrando...' : 'Entrar';
}
