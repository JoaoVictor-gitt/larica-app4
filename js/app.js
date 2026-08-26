/*
 * app.js
 * Controla o shell de navegação (sidebar + header), que agora é diferente
 * para cada área do sistema: "pedido" (fluxo de pedido do cliente,
 * autocontido) e "admin" (Dashboard, Produtos, Estoque, Histórico,
 * Configurações). Cada página declara sua área em
 * <body data-area="pedido|admin">. Roda em todo DOMContentLoaded, antes do
 * script específico de cada página. Depende de storage.js e utils.js
 * (carregados antes deste).
 */

// Menu da área Painel Administrativo (gestão do food truck) — `permissao` é a permissão mínima
// (sempre *.view, exceto Configurações que só tem settings.manage — não existe settings.view, ver
// Fase 10C/Etapa 3) exigida tanto pra aparecer no menu quanto pra acessar a página diretamente por URL.
const MENU_ADMIN = [
  { chave: 'dashboard', rotulo: 'Dashboard', icone: '📊', href: 'dashboard.html', permissao: 'dashboard.view' },
  { chave: 'pedidos', rotulo: 'Pedidos', icone: '📋', href: 'pedidos.html', permissao: 'orders.view' },
  { chave: 'produtos', rotulo: 'Produtos', icone: '🍡', href: 'produtos.html', permissao: 'products.view' },
  { chave: 'estoque', rotulo: 'Estoque', icone: '📦', href: 'estoque.html', permissao: 'stock.view' },
  { chave: 'compras', rotulo: 'Compras', icone: '🛒', href: 'compras.html', permissao: 'purchases.view' },
  { chave: 'producao', rotulo: 'Produção', icone: '🧾', href: 'producao.html', permissao: 'production.view' },
  { chave: 'historico', rotulo: 'Histórico', icone: '🕒', href: 'historico.html', permissao: 'history.view' },
  { chave: 'relatorios', rotulo: 'Relatórios', icone: '📈', href: 'relatorios.html', permissao: 'reports.view' },
  { chave: 'configuracoes', rotulo: 'Configurações', icone: '⚙️', href: 'configuracoes.html', permissao: 'settings.manage' },
];

// Página -> permissão exigida, derivado de MENU_ADMIN (uma só fonte de verdade, nunca duplicado à mão)
const PERMISSAO_POR_PAGINA = Object.fromEntries(MENU_ADMIN.map((item) => [item.chave, item.permissao]));

// Menu da área Fazer Pedido (fluxo único e autocontido, sem sub-navegação própria)
const MENU_PEDIDO = [];

const MENUS_POR_AREA = { admin: MENU_ADMIN, pedido: MENU_PEDIDO };
const SUBTITULOS_POR_AREA = { admin: 'Painel Administrativo', pedido: 'Fazer Pedido' };

// Títulos exibidos no header de cada página
const TITULOS_PAGINA = {
  dashboard: 'Dashboard',
  pedido: 'Fazer Pedido',
  pedidos: 'Pedidos',
  estoque: 'Controle de Estoque',
  compras: 'Compras',
  producao: 'Produção',
  produtos: 'Produtos',
  historico: 'Histórico',
  relatorios: 'Relatório Diário',
  configuracoes: 'Configurações',
};

document.addEventListener('DOMContentLoaded', async () => {
  inicializarStorage();

  const area = MENUS_POR_AREA[document.body.dataset.area] ? document.body.dataset.area : 'pedido';
  let contextoPermissoes = null;

  if (area === 'admin') {
    const autenticacao = await requireStaffAuth();
    if (!autenticacao) return; // requireStaffAuth já está redirecionando para login.html

    try {
      contextoPermissoes = await carregarContextoPermissoesUsuario();
    } catch (erro) {
      // Fail closed (Fase 10C/Etapa 3, item 16): erro ao carregar permissões nunca libera a página —
      // mesmo um admin depende da resposta real de is_admin(), nunca de suposição local.
      await supabaseClient.auth.signOut();
      window.location.href = 'login.html?erro=sem_permissao';
      return;
    }

    const acessoLiberado = garantirAcessoPaginaAtual(contextoPermissoes);
    if (!acessoLiberado) return; // já redirecionou (página não mapeada ou sem a permissão exigida)
  }

  montarShell(contextoPermissoes);
  ligarMenuMobile();
  atualizarContadorCarrinho();
  atualizarContadorPedidosNovos();
  if (area === 'admin') ligarBotaoSair();
});

/**
 * { ehAdmin, permissoes }. Admin: 1 chamada (is_admin()), permissoes fica null (não precisa —
 * ehAdmin=true já significa acesso total, nunca interpretar null/[] como "sem acesso", ver temAcesso()).
 * Employee: 1 chamada extra (SELECT das próprias permissões). Nunca mais que 2 chamadas de rede,
 * independente de quantos módulos existirem (Fase 10C/Etapa 3, item 4 — evita N RPCs por item de menu).
 */
async function carregarContextoPermissoesUsuario() {
  const ehAdmin = await usuarioEhAdminNoSupabase();
  if (ehAdmin) return { ehAdmin: true, permissoes: null };
  const permissoes = await listarMinhasPermissoesNoSupabase();
  return { ehAdmin: false, permissoes };
}

/** true se o contexto (admin ou lista de permissões do employee) cobre a permissão informada. Fail closed: contexto ausente = sem acesso. */
function temAcesso(contexto, permissao) {
  if (!contexto || !permissao) return false;
  if (contexto.ehAdmin) return true;
  return (contexto.permissoes || []).includes(permissao);
}

/** Primeira página de MENU_ADMIN que o contexto atual realmente pode acessar, ou null se nenhuma (zero permissões). */
function primeiraPaginaPermitida(contexto) {
  if (!contexto) return null;
  if (contexto.ehAdmin) return MENU_ADMIN[0].href;
  const item = MENU_ADMIN.find((m) => temAcesso(contexto, m.permissao));
  return item ? item.href : null;
}

/**
 * Guard de página (Fase 10C/Etapa 3) — roda depois de requireStaffAuth(), nunca o substitui. Bloqueia
 * acesso direto por URL a um módulo sem a permissão exigida (nunca confia só no menu estar escondido,
 * item 10). Página sem permissão mapeada também é bloqueada por padrão (fail closed, item 16) — nunca
 * libera por esquecimento de mapeamento. Employee sem acesso vai pra primeira página que ele realmente
 * tem (nunca sempre dashboard.html, evita loop de redirect, item 7); zero permissões -> logout.
 */
function garantirAcessoPaginaAtual(contexto) {
  const pagina = document.body.dataset.pagina || '';
  const permissaoNecessaria = PERMISSAO_POR_PAGINA[pagina];

  if (permissaoNecessaria && temAcesso(contexto, permissaoNecessaria)) return true;

  const destino = primeiraPaginaPermitida(contexto);
  if (destino) {
    window.location.href = destino;
  } else {
    supabaseClient.auth.signOut().finally(() => {
      window.location.href = 'login.html?erro=sem_permissao';
    });
  }
  return false;
}

/** Monta o HTML da sidebar + header e envolve o conteúdo já presente na página */
function montarShell(contextoPermissoes) {
  const paginaAtual = document.body.dataset.pagina || '';
  const areaBruta = document.body.dataset.area;
  const area = MENUS_POR_AREA[areaBruta] ? areaBruta : 'pedido';
  const placeholder = document.getElementById('layout-shell');
  const conteudo = document.querySelector('.conteudo-pagina');
  if (!placeholder || !conteudo) return;

  // Área pública "Fazer Pedido": cabeçalho compacto próprio (logo + carrinho), sem sidebar/menu
  // administrativo — sai daqui antes de qualquer código do shell admin abaixo.
  if (area === 'pedido') {
    montarShellPedido(placeholder);
    return;
  }

  // Admin (área protegida): só os itens que o contexto realmente autoriza.
  const itensMenu = MENU_ADMIN.filter((p) => temAcesso(contextoPermissoes, p.permissao));

  const linksMenu = itensMenu
    .map(
      (p) => `
      <a class="sidebar-link ${p.chave === paginaAtual ? 'ativo' : ''}" href="${p.href}">
        <span>${p.icone}</span><span>${p.rotulo}</span>
        ${p.chave === 'pedidos' ? '<span class="badge-contador" id="badge-contador-pedidos-novos" style="display:none;">0</span>' : ''}
      </a>`
    )
    .join('');

  placeholder.outerHTML = `
    <div class="overlay-mobile" id="overlay-mobile"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-logo"><span class="logo-larica">LAR<span class="logo-chama">🔥</span>CA</span></div>
      <div class="sidebar-subtitulo">${SUBTITULOS_POR_AREA[area]}</div>
      <nav class="sidebar-nav">${linksMenu}</nav>
      <a class="sidebar-link sidebar-link-inicio" href="index.html">
        <span>↩️</span><span>Início</span>
      </a>
      <div class="sidebar-rodape">Brazilian Street Food</div>
    </aside>
  `;

  // Envolve o header + conteúdo em uma coluna principal
  const principal = document.createElement('div');
  principal.className = 'app-principal';

  const header = document.createElement('header');
  header.className = 'header';
  header.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <button class="botao-menu-mobile" id="botao-menu-mobile" aria-label="Abrir menu">☰</button>
      <div class="header-titulo">${TITULOS_PAGINA[paginaAtual] || ''}</div>
    </div>
    <div class="header-acoes">
      ${area === 'admin' ? '<button type="button" class="btn btn-secundario" id="botao-sair-admin">Sair</button>' : ''}
    </div>
  `;

  conteudo.parentNode.insertBefore(principal, conteudo);
  principal.appendChild(header);
  principal.appendChild(conteudo);

  document.body.classList.add('app-shell');
}

/** Monta o cabeçalho compacto da área pública "Fazer Pedido" (logo + acesso ao carrinho) */
function montarShellPedido(placeholder) {
  placeholder.outerHTML = `
    <header class="cabecalho-pedido">
      <a class="cabecalho-pedido-marca" href="index.html" aria-label="Larica — início">
        <img src="logo.png" alt="Larica" class="cabecalho-pedido-logo" />
      </a>
      <button type="button" class="cabecalho-pedido-carrinho" id="botao-carrinho-cabecalho" aria-label="Ver carrinho">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
          <path d="M2 3h2l2.2 12.2a2 2 0 0 0 2 1.8h8.6a2 2 0 0 0 2-1.6L21 8H6" />
        </svg>
        <span class="badge-contador" id="badge-contador-carrinho" style="display:none;">0</span>
      </button>
    </header>
  `;
}

/** Liga o botão hambúrguer (mobile) para abrir/fechar a sidebar */
function ligarMenuMobile() {
  const botao = document.getElementById('botao-menu-mobile');
  const overlay = document.getElementById('overlay-mobile');
  const sidebar = document.getElementById('sidebar');
  if (!botao || !overlay || !sidebar) return;

  const abrir = () => {
    sidebar.classList.add('sidebar-aberta');
    overlay.classList.add('overlay-visivel');
  };
  const fechar = () => {
    sidebar.classList.remove('sidebar-aberta');
    overlay.classList.remove('overlay-visivel');
  };

  botao.addEventListener('click', abrir);
  overlay.addEventListener('click', fechar);
}

/** Liga o botão "Sair" do header (só existe na área admin) ao logout do Supabase */
function ligarBotaoSair() {
  const botao = document.getElementById('botao-sair-admin');
  if (!botao) return;
  botao.addEventListener('click', fazerLogoutAdmin);
}

/**
 * Atualiza o número de itens no badge do carrinho no header (#badge-contador-carrinho,
 * injetado por montarShellPedido() na área "pedido"). No-op seguro em qualquer outra
 * página (admin), onde esse elemento não existe.
 */
function atualizarContadorCarrinho() {
  const badge = document.getElementById('badge-contador-carrinho');
  if (!badge) return;
  const carrinho = obterCarrinho();
  const total = carrinho.reduce((soma, item) => soma + item.quantidade, 0);
  badge.textContent = total;
  badge.style.display = total > 0 ? 'flex' : 'none';
}

/** Atualiza o "Pedidos (n)" no menu lateral do admin com a quantidade de pedidos com status Solicitado */
function atualizarContadorPedidosNovos() {
  const badge = document.getElementById('badge-contador-pedidos-novos');
  if (!badge) return;
  const total = obterPedidosClientes().filter((p) => p.status === STATUS_PEDIDO.SOLICITADO).length;
  badge.textContent = total;
  badge.style.display = total > 0 ? 'flex' : 'none';
}
