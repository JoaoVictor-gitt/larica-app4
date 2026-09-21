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
