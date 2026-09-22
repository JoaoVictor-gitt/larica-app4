/*
 * home.js
 * Lógica exclusiva da home pública (index.html) — conecta o Hero à mídia
 * configurada em Configurações > Aparência do site (business_settings.
 * hero_media_type/hero_media_path/hero_poster_path, Storage site-media).
 * Nunca é carregado por /pedido nem pelo admin; não compartilha estado com
 * js/app.js ou js/pedido.js.
 *
 * Contrato de segurança: só chama getHeroMediaSettings() (SELECT das 3
 * colunas públicas) e getUrlPublicaMidiaSite() (URL pública a partir de um
 * path), ambas de js/services/settings-service.js. Nunca UPDATE, nunca
 * upload, nunca lista o bucket.
 *
 * Contrato de falha: qualquer problema (Supabase offline, config nula/
 * inválida, path ausente, imagem/vídeo/poster que não carrega) deixa o
 * placeholder/gradiente de css/home-larica.css exatamente como estava —
 * nunca um erro visível ao cliente, só console.warn para diagnóstico.
 */

(function () {
  function inserirOculto(elemento) {
    const heroMedia = document.querySelector('.hero-media');
    if (!heroMedia) return null;
    elemento.classList.add('hero-media-elemento');
    heroMedia.appendChild(elemento);
    return elemento;
  }

  /** Fade-in (opacity 0->1, via classe — ver css/home-larica.css) só depois do navegador confirmar que a mídia está pronta. */
  function revelar(elemento) {
    requestAnimationFrame(() => elemento.classList.add('hero-media-elemento-visivel'));
  }

  function usarImagem(url, tipoMidiaAttr) {
    const heroMedia = document.querySelector('.hero-media');
    if (!heroMedia || !url) return;

    const img = document.createElement('img');
    img.alt = '';
    img.addEventListener(
      'error',
      () => {
        console.warn('[home] Falha ao carregar a imagem do Hero — mantendo o placeholder padrão.');
        img.remove();
      },
      { once: true }
    );
    img.addEventListener('load', () => revelar(img), { once: true });

    heroMedia.dataset.tipoMidia = tipoMidiaAttr;
    inserirOculto(img);
    img.src = url; // definido depois de já estar no DOM — comportamento de carregamento mais consistente entre navegadores
  }

  function usarVideo(url, posterUrl) {
    const heroMedia = document.querySelector('.hero-media');
    if (!heroMedia || !url || !posterUrl) return;

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata'; // nunca 'auto' — não baixa o vídeo inteiro antes de sabermos que ele vai ser usado
    video.poster = posterUrl;
    video.setAttribute('aria-hidden', 'true');

    video.addEventListener(
      'error',
      () => {
        console.warn('[home] Falha ao carregar o vídeo do Hero — mantendo o placeholder padrão.');
        video.remove();
      },
      { once: true }
    );
    video.addEventListener('loadeddata', () => revelar(video), { once: true });

    heroMedia.dataset.tipoMidia = 'video';
    inserirOculto(video);

    const source = document.createElement('source');
    source.type = 'video/mp4';
    source.src = url;
    video.appendChild(source);
  }

  async function carregarMediaDoHero() {
    let config;
    try {
      config = await getHeroMediaSettings();
    } catch (erro) {
      console.warn('[home] Não foi possível carregar a configuração do Hero — mantendo o placeholder padrão.', erro);
      return;
    }

    if (!config || (config.tipo !== 'image' && config.tipo !== 'video')) return;

    if (config.tipo === 'image') {
      if (!config.path) return;
      usarImagem(getUrlPublicaMidiaSite(config.path), 'imagem');
      return;
    }

    // tipo === 'video': path e poster são obrigatórios juntos (mesma regra de updateHeroMediaSettings)
    if (!config.path || !config.posterPath) return;
    const posterUrl = getUrlPublicaMidiaSite(config.posterPath);
    if (!posterUrl) return;

    const prefereReduzirMovimento = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (prefereReduzirMovimento) {
      // Nunca cria/reproduz o <video> nesse caso — usa o poster como imagem estática.
      usarImagem(posterUrl, 'video');
      return;
    }

    usarVideo(getUrlPublicaMidiaSite(config.path), posterUrl);
  }

  // Scripts carregados com defer já garantem DOM pronto neste ponto (readyState "interactive"),
  // mas a checagem abaixo mantém o arquivo seguro mesmo se um dia for carregado de outro jeito.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregarMediaDoHero);
  } else {
    carregarMediaDoHero();
  }
})();

/*
 * Vitrine "Our Menu" — bloco isolado do Hero acima (só toca .menu-larica-*, nunca .hero-media).
 * Reaproveita a mesma cadeia pública já usada por pedido.html: carregarProdutosCache()/
 * pesquisarProdutos()/obterConfiguracoes() (js/storage.js) e formatarMoeda()/escaparHtml()
 * (js/utils.js) — nenhuma fonte de dados nova, nenhum cálculo de estoque/disponibilidade novo.
 *
 * Contrato de falha: qualquer problema (Supabase indisponível, zero produtos elegíveis) remove
 * só a grade (#menu-larica-grade) — título, subtítulo e CTA continuam de pé. Nunca um erro
 * técnico visível ao cliente, só console.warn para diagnóstico.
 */
(function () {
  async function carregarMenuDestaqueHome() {
    const grade = document.getElementById('menu-larica-grade');
    if (!grade) return;

    try {
      await carregarProdutosCache();
    } catch (erro) {
      console.warn('[home] Não foi possível carregar os produtos em destaque — ocultando a vitrine.', erro);
      grade.remove();
      return;
    }

    // Mesma regra de bloqueio usada nos cards de pedido.html (cardProdutoPedidoHtml/
    // cardComboPedidoHtml): status ativo, disponível, e — só para não-combos — com estoque.
    const elegiveis = pesquisarProdutos({ status: 'ativo', disponivel: true }).filter(
      (produto) => produto.comboConfig || produto.quantidadeEstoque > 0
    );

    if (elegiveis.length === 0) {
      grade.remove();
      return;
    }

    const categoriasEl = document.getElementById('menu-larica-categorias');
    if (categoriasEl) {
      // Pills navegacionais (levam a pedido.html), derivadas das categorias reais já
      // carregadas — decorativas, sem filtro interativo (evita duplicar o sistema de
      // categorias/estado de pedido.js numa vitrine de só 6 itens).
      const categorias = Array.from(new Set(pesquisarProdutos({ status: 'ativo' }).map((produto) => produto.categoria)));
      categoriasEl.innerHTML = categorias.map((categoria) => `<a href="pedido.html">${escaparHtml(categoria)}</a>`).join('');
    }

    const moeda = obterConfiguracoes().moeda;
    grade.innerHTML = elegiveis
      .slice(0, 6)
      .map((produto) => cardMenuDestaqueHtml(produto, moeda))
      .join('');
  }

  /** Card 100% navegacional — sem seletor de quantidade nem botão adicionar; o card inteiro é um link. */
  function cardMenuDestaqueHtml(produto, moeda) {
    const foto = produto.foto
      ? `<img src="${produto.foto}" alt="${escaparHtml(produto.nome)}" loading="lazy" />`
      : `<div class="menu-larica-card-foto-vazia">${produto.comboConfig ? '🍽️' : '🍢'}</div>`;

    return `
      <a class="menu-larica-card" href="pedido.html">
        <div class="menu-larica-card-foto-wrap">${foto}</div>
        <div class="menu-larica-card-corpo">
          <div class="menu-larica-card-nome">${escaparHtml(produto.nome)}</div>
          <div class="menu-larica-card-descricao">${escaparHtml(produto.descricao || '')}</div>
          <div class="menu-larica-card-preco">${formatarMoeda(produto.preco, moeda)}</div>
        </div>
      </a>`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregarMenuDestaqueHome);
  } else {
    carregarMenuDestaqueHome();
  }
})();

/*
 * Opening Hours (Visit Us) — bloco isolado, só toca #horarios-lista-home. Reaproveita
 * buscarHorariosFuncionamentoDoSupabase() (js/services/settings-service.js, já incluído em
 * index.html pela mídia do Hero) — mesma função pública já usada por pedido.js a partir de
 * pedido.html. Nenhum horário é inventado: falha de carregamento vira uma mensagem neutra, nunca
 * um horário hardcoded.
 */
(function () {
  const DIAS_SEMANA_INGLES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ORDEM_EXIBICAO = [1, 2, 3, 4, 5, 6, 0]; // Monday..Sunday — só ordem de exibição, day_of_week não muda

  /** 'HH:MM:SS' (tipo time do Postgres) -> 'HH:MM' */
  function formatarHora(horaSql) {
    return horaSql ? horaSql.slice(0, 5) : '';
  }

  async function carregarHorariosHome() {
    const lista = document.getElementById('horarios-lista-home');
    if (!lista) return;

    try {
      const horarios = await buscarHorariosFuncionamentoDoSupabase();
      const porDia = new Map(horarios.map((h) => [h.diaSemana, h]));

      lista.innerHTML = ORDEM_EXIBICAO.map((dia) => {
        const h = porDia.get(dia);
        const valor = h && h.ativo ? `${formatarHora(h.horaAbertura)} – ${formatarHora(h.horaFechamento)}` : 'Closed';
        return `<li><span>${DIAS_SEMANA_INGLES[dia]}</span><span>${escaparHtml(valor)}</span></li>`;
      }).join('');
    } catch (erro) {
      console.warn('[home] Não foi possível carregar os horários de funcionamento.', erro);
      lista.innerHTML = '<li class="visita-larica-horarios-indisponivel">Hours currently unavailable.</li>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', carregarHorariosHome);
  } else {
    carregarHorariosHome();
  }
})();
