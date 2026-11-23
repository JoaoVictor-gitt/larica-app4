/*
 * login.js
 * Tela de login do Painel Administrativo (login.html). Depende de
 * js/supabase.js e js/services/permissions-service.js (carregados antes
 * deste) para o client e as funções obterPerfilUsuario/isStaff/
 * listarMinhasPermissoesNoSupabase. Não usa js/app.js nem js/storage.js —
 * esta página não tem sidebar e não depende dos dados locais do app.
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

  window.location.href = await primeiraPaginaAposLogin(perfil);
}

/**
 * Todo mundo começa pelo Menu (menu.html), a página principal do painel, que só mostra os cards das
 * áreas que o usuário pode abrir. Isso é só UX — se a consulta de permissões falhar (rede), também vai
 * para 'menu.html' e o guard central de app.js decide corretamente
 * a partir daí (inclusive fail closed/logout se for o caso) — login.js nunca é o boundary de segurança.
 */
async function primeiraPaginaAposLogin(perfil) {
  // A página principal do painel agora é o Menu (cards para as áreas). Admin vai direto para ela.
  if (isAdmin(perfil)) return 'menu.html';

  try {
    const permissoes = await listarMinhasPermissoesNoSupabase();
    // Funcionário com ao menos uma permissão também começa pelo Menu (ele só vê os cards que pode abrir).
    if (permissoes.length > 0) return 'menu.html';
  } catch (erro) {
    // sem problema — o guard de app.js na página de destino trata isso corretamente
  }

  // Sem permissão (ou falha de rede): o guard de app.js no Menu decide — inclusive logout se não houver acesso.
  return 'menu.html';
}

function exibirErroLogin(mensagem) {
  document.getElementById('erro-login').textContent = mensagem || '';
}

function definirCarregandoLogin(carregando) {
  const botao = document.getElementById('botao-entrar');
  botao.disabled = carregando;
  botao.textContent = carregando ? 'Entrando...' : 'Entrar';
}
