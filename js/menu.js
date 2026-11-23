/*
 * menu.js
 * Página Menu (menu.html) — página principal do painel. Mostra um card para cada área que o
 * usuário pode abrir, na mesma ordem da sidebar. A lista de áreas e as permissões vêm de
 * MENU_ADMIN / itemMenuLiberado (js/app.js): uma só fonte de verdade, nada duplicado aqui.
 * Espera o evento 'larica:shell-pronto' (disparado por app.js depois de carregar as permissões),
 * então não faz nenhuma consulta extra ao banco. Isto é só navegação: cada página de destino
 * continua protegida pelo guard de app.js e o banco pela RLS.
 *
 * Tudo dentro de uma IIFE: nenhum nome global novo (ver colisões entre scripts da mesma página).
 */
(function () {
  'use strict';

  const FUSO = 'Europe/Dublin';

  function escapar(texto) {
    return String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function preencherCabecalho() {
    const agora = new Date();
    const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', hourCycle: 'h23' }).format(agora));
    const saudacao = hora >= 5 && hora < 12 ? 'Bom dia' : hora >= 12 && hora < 18 ? 'Boa tarde' : 'Boa noite';
    const data = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long', day: 'numeric', month: 'long' }).format(agora);
    document.getElementById('menu-saudacao').textContent = saudacao;
    document.getElementById('menu-data').textContent = data.charAt(0).toUpperCase() + data.slice(1);
  }

  function cardHtml(item, contexto, destaque) {
    // Páginas que ficam "dentro" desta área (ex.: Histórico e Clientes dentro de Pedidos) viram atalhos no card
    const atalhos = MENU_ADMIN.filter((i) => i.oculto && i.dentroDe === item.chave && itemMenuLiberado(contexto, i));
    return `
      <article class="menu-card${destaque ? ' menu-card-destaque' : ''}">
        <span class="menu-card-icone" aria-hidden="true">${item.icone}</span>
        <div class="menu-card-texto">
          <h2><a class="menu-card-link" href="${escapar(item.href)}">${escapar(item.rotulo)}</a></h2>
          <p>${escapar(item.descricao || '')}</p>
        </div>
        <span class="menu-card-seta" aria-hidden="true">→</span>
        ${atalhos.length ? `<div class="menu-card-atalhos">${atalhos
          .map((a) => `<a href="${escapar(a.href)}">${a.icone} ${escapar(a.rotulo)}</a>`)
          .join('')}</div>` : ''}
      </article>`;
  }

  function montarCards(contexto) {
    const grade = document.getElementById('menu-grade');
    if (!grade) return;
    const areas = MENU_ADMIN.filter((i) => !i.oculto && !i.todos && itemMenuLiberado(contexto, i));
    if (!areas.length) {
      grade.innerHTML = '<div class="estado-vazio">Nenhuma área liberada para o seu usuário.</div>';
      return;
    }
    // Pedidos é a operação do dia: ganha destaque quando o usuário tem acesso
    grade.innerHTML = areas.map((item) => cardHtml(item, contexto, item.chave === 'pedidos')).join('');
  }

  document.addEventListener('larica:shell-pronto', (evento) => {
    preencherCabecalho();
    montarCards(evento.detail && evento.detail.contexto);
  });
})();
