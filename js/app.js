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

// Menu da área Painel Administrativo (gestão do food truck)
const MENU_ADMIN = [
  { chave: 'dashboard', rotulo: 'Dashboard', icone: '📊', href: 'dashboard.html' },
  { chave: 'pedidos', rotulo: 'Pedidos', icone: '📋', href: 'pedidos.html' },
  { chave: 'produtos', rotulo: 'Produtos', icone: '🍡', href: 'produtos.html' },
  { chave: 'estoque', rotulo: 'Estoque', icone: '📦', href: 'estoque.html' },
  { chave: 'historico', rotulo: 'Histórico', icone: '🕒', href: 'historico.html' },
  { chave: 'configuracoes', rotulo: 'Configurações', icone: '⚙️', href: 'configuracoes.html' },
];

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
  produtos: 'Produtos',
  historico: 'Histórico',
  configuracoes: 'Configurações',
};

document.addEventListener('DOMContentLoaded', async () => {
  inicializarStorage();

  const area = MENUS_POR_AREA[document.body.dataset.area] ? document.body.dataset.area : 'pedido';
  if (area === 'admin') {
    const autenticacao = await requireStaffAuth();
    if (!autenticacao) return; // requireStaffAuth já está redirecionando para login.html
  }

  montarShell();
  ligarMenuMobile();
  atualizarContadorCarrinho();
  atualizarContadorPedidosNovos();
  if (area === 'admin') ligarBotaoSair();
});

/** Monta o HTML da sidebar + header e envolve o conteúdo já presente na página */
function montarShell() {
  const paginaAtual = document.body.dataset.pagina || '';
  const areaBruta = document.body.dataset.area;
  const area = MENUS_POR_AREA[areaBruta] ? areaBruta : 'pedido';
  const placeholder = document.getElementById('layout-shell');
  const conteudo = document.querySelector('.conteudo-pagina');
  if (!placeholder || !conteudo) return;

  const linksMenu = MENUS_POR_AREA[area]
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
 * Atualiza o número de itens no badge do carrinho no header — hoje nenhuma
 * página tem esse badge (a Loja foi removida), então isso é um no-op seguro.
 * Mantida porque js/pedido.js ainda chama essa função em vários pontos.
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
