/*
 * login.js
 * Tela de login do Painel Administrativo (login.html). Depende de
 * js/supabase.js (carregado antes deste) para o client e as funções
 * obterPerfilUsuario/isStaff. Não usa js/app.js nem js/storage.js — esta
 * página não tem sidebar e não depende dos dados locais do app.
 */

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

  window.location.href = 'dashboard.html';
}

function exibirErroLogin(mensagem) {
  document.getElementById('erro-login').textContent = mensagem || '';
}

function definirCarregandoLogin(carregando) {
  const botao = document.getElementById('botao-entrar');
  botao.disabled = carregando;
  botao.textContent = carregando ? 'Entrando...' : 'Entrar';
}
