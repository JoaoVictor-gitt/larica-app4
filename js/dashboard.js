/*
 * dashboard.js — Fase F: visão rápida do negócio (get_dashboard).
 *
 * Forma por tarefa (skill de dataviz): faturamento do período = número de destaque com
 * comparação ao período anterior; indicadores = cartões; evolução das vendas = colunas de
 * uma série (dia a dia; semanas quando o período passa de 62 dias), com dica no hover/foco
 * e tabela alternativa; mais vendidos/rentáveis = barras horizontais ordenadas com o valor
 * na ponta; estoque baixo e produções = listas com ícone + texto (nunca só cor).
 * Um filtro de período acima de tudo; ao trocar, o painel anterior fica esmaecido até os
 * dados novos chegarem (sem piscar). Bloco financeiro só para admin (o banco decide).
 * Nomes vindos do banco entram sempre por textContent. Escopo próprio, sem globais.
 */
(() => {
  const SVG = 'http://www.w3.org/2000/svg';
  const st = { periodo: 'mes', de: null, ate: null, dados: null, consulta: 0 };
  const $ = (id) => document.getElementById(id);
  // Separador de milhar sempre (pt-PT só agrupa a partir de 5 dígitos: "4783,48" -> "4 783,48").
  const euro = (v, casas = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—'
    : (Number(v) < 0 ? '−' : '') + '€' + Math.abs(Number(v)).toLocaleString('pt-PT', { minimumFractionDigits: casas, maximumFractionDigits: casas, useGrouping: 'always' }));
  const euroCompacto = (v) => {
    const n = Math.abs(Number(v));
    if (n >= 10000) return '€' + (Number(v) / 1000).toLocaleString('pt-PT', { maximumFractionDigits: 1 }) + 'K';
    return '€' + Number(v).toLocaleString('pt-PT', { maximumFractionDigits: 0 });
  };
  const num = (v, c = 0) => Number(v).toLocaleString('pt-PT', { maximumFractionDigits: c });
  const pct = (v) => `${(v * 100).toLocaleString('pt-PT', { maximumFractionDigits: 1 })}%`;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoje = () => iso(new Date());
  const somarDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const dataCurta = (s) => { const [, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}`; };
  const dataBr = (s) => { const [a, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${a}`; };
  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined && texto !== null) e.textContent = texto;
    return e;
  }

  // ------------------------------------------------------------------ período

  function calcularPeriodo(chave) {
    const h = hoje();
    const d = new Date(h + 'T12:00:00');
    if (chave === 'hoje') return [h, h];
    if (chave === '7d') return [somarDias(h, -6), h];
    if (chave === '30d') return [somarDias(h, -29), h];
    if (chave === 'mesanterior') return [iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), iso(new Date(d.getFullYear(), d.getMonth(), 0))];
    if (chave === 'personalizado') return [$('pn-de').value || h, $('pn-ate').value || h];
    return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), h];
  }

  function aplicarPeriodo(chave) {
    st.periodo = chave;
    document.querySelectorAll('[data-periodo]').forEach((b) => b.classList.toggle('pn-chip-ativo', b.dataset.periodo === chave));
    $('pn-custom').style.display = chave === 'personalizado' ? '' : 'none';
    if (chave === 'personalizado' && !$('pn-de').value) {
      const [a, b] = calcularPeriodo('mes');
      $('pn-de').value = a;
      $('pn-ate').value = b;
    }
    const [de, ate] = calcularPeriodo(chave);
    if (de > ate) { $('pn-periodo-texto').textContent = 'A data inicial é depois da final.'; return; }
    st.de = de;
    st.ate = ate;
    $('pn-periodo-texto').textContent = de === ate ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}`;
    carregar();
  }

  // ------------------------------------------------------------------ carga

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-periodo]').forEach((b) => b.addEventListener('click', () => aplicarPeriodo(b.dataset.periodo)));
    ['pn-de', 'pn-ate'].forEach((id) => $(id).addEventListener('change', () => aplicarPeriodo('personalizado')));
    $('pn-vendas-alternar').addEventListener('click', alternarTabelaVendas);
    window.addEventListener('resize', () => { if (st.dados) renderizarVendas(); });
    aplicarPeriodo('mes');
  });

  async function carregar() {
    const minha = ++st.consulta;
    if (st.dados) $('pn-conteudo').classList.add('pn-atualizando');
    let dados;
    try {
      dados = await buscarPainelDashboard(st.de, st.ate);
    } catch (erro) {
      if (minha !== st.consulta) return;
      $('pn-conteudo').classList.remove('pn-atualizando');
      $('pn-carregando').style.display = 'none';
      $('pn-erro').textContent = 'Não foi possível carregar o Dashboard. ' + erro.message;
      $('pn-erro').style.display = 'block';
      return;
    }
    if (minha !== st.consulta) return;
    st.dados = dados;
    $('pn-erro').style.display = 'none';
    $('pn-carregando').style.display = 'none';
    $('pn-conteudo').style.display = '';
    $('pn-conteudo').classList.remove('pn-atualizando');
    $('pn-link-financeiro').style.display = dados.finance ? '' : 'none';
    renderizarTopo();
    renderizarVendas();
    renderizarMaisVendidos();
    renderizarRentaveis();
    renderizarEstoque();
    renderizarProducoes();
    renderizarNotas();
  }

  // ------------------------------------------------------------------ número de destaque + cartões

  function renderizarTopo() {
    const d = st.dados;
    const atual = Number(d.sales.revenue);
    const anterior = Number(d.previous.revenue);
    const hero = $('pn-hero');
    hero.replaceChildren();
    hero.append(el('span', 'pn-hero-rotulo', 'Faturamento do período'), el('strong', 'pn-hero-valor', euro(atual)));
    const delta = el('span', 'pn-delta');
    if (anterior > 0) {
      const v = (atual - anterior) / anterior;
      const sobe = v >= 0;
      delta.classList.add(sobe ? 'pn-delta-bom' : 'pn-delta-ruim');
      delta.textContent = `${sobe ? '▲' : '▼'} ${pct(Math.abs(v))} ${sobe ? 'acima' : 'abaixo'} de ${dataCurta(d.previous.from)}–${dataCurta(d.previous.to)} (${euro(anterior)})`;
    } else {
      delta.textContent = `Sem vendas em ${dataCurta(d.previous.from)}–${dataCurta(d.previous.to)} para comparar`;
    }
    hero.append(delta, el('span', 'pn-hero-sub', `${num(d.sales.orders)} pedido(s) · ticket médio ${euro(d.sales.avg_ticket)}${Number(d.sales.cancelled) ? ` · ${d.sales.cancelled} cancelado(s) fora` : ''}`));

    const tiles = [{ rotulo: 'Faturamento hoje', valor: euro(d.today.revenue), sub: `${num(d.today.orders)} pedido(s)` }];
    const f = d.finance;
    if (f) {
      const cob = Number(f.cogs.items_revenue) > 0 ? (Number(f.cogs.revenue_calculated) + Number(f.cogs.revenue_estimated)) / Number(f.cogs.items_revenue) : null;
      const caixa = Number(f.cash.total_in) - Number(f.cash.total_out);
      tiles.push(
        { rotulo: 'Despesas do período', valor: euro(f.dre.operating_expenses), sub: Number(f.dre.waste) ? `+ ${euro(f.dre.waste)} em perdas` : 'por competência' },
        { rotulo: 'CMV', valor: euro(f.cogs.total), sub: cob === null ? 'sem vendas' : `cobre ${pct(cob)} do faturamento` },
        { rotulo: 'Resultado operacional', valor: euro(f.dre.operating_result), sub: `lucro bruto ${euro(f.dre.gross_profit)}`, sinal: Number(f.dre.operating_result) },
        { rotulo: 'Caixa do período', valor: euro(caixa), sub: 'entradas − saídas', sinal: caixa },
      );
    } else {
      tiles.push({ rotulo: 'Pedidos no período', valor: num(d.sales.orders), sub: `ticket médio ${euro(d.sales.avg_ticket)}` });
    }
    const alvo = $('pn-tiles');
    alvo.replaceChildren(...tiles.map((t) => {
      const c = el('div', 'card pn-tile');
      const valor = el('strong', 'pn-tile-valor', t.valor);
      if (t.sinal !== undefined && t.sinal < 0) valor.classList.add('pn-negativo');
      c.append(el('span', 'pn-tile-rotulo', t.rotulo), valor, el('span', 'pn-tile-sub', t.sub));
      return c;
    }));
  }

  // ------------------------------------------------------------------ evolução das vendas (colunas, uma série)

  function serieVendas() {
    const diario = st.dados.daily || [];
    if (diario.length <= 62) {
      return { agrupado: 'dia', pontos: diario.map((p) => ({ rotulo: dataCurta(p.date), titulo: dataBr(p.date), valor: Number(p.revenue), pedidos: Number(p.orders) })) };
    }
    const semanas = [];
    for (let i = 0; i < diario.length; i += 7) {
      const fatia = diario.slice(i, i + 7);
      semanas.push({
        rotulo: dataCurta(fatia[0].date),
        titulo: `${dataBr(fatia[0].date)} a ${dataBr(fatia[fatia.length - 1].date)}`,
        valor: fatia.reduce((s, p) => s + Number(p.revenue), 0),
        pedidos: fatia.reduce((s, p) => s + Number(p.orders), 0),
      });
    }
    return { agrupado: 'semana', pontos: semanas };
  }

  function ticksLimpos(max) {
    if (max <= 0) return [0];
    const bruto = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto) || mag * 10;
    const ticks = [];
    for (let v = 0; v <= max + passo * 0.001; v += passo) ticks.push(Math.round(v * 100) / 100);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + passo);
    return ticks;
  }

  function renderizarVendas() {
    const { agrupado, pontos } = serieVendas();
    $('pn-vendas-titulo').textContent = agrupado === 'semana' ? 'Evolução das vendas (por semana)' : 'Evolução das vendas';
    const alvo = $('pn-grafico-vendas');
    alvo.replaceChildren();
    const largura = Math.max(300, Math.round(alvo.clientWidth || 640));
    const altura = 220;
    const m = { e: 52, d: 8, t: 22, b: 28 };
    const ticks = ticksLimpos(Math.max(0, ...pontos.map((p) => p.valor)));
    const topo = ticks[ticks.length - 1] || 1;
    const larguraPlot = largura - m.e - m.d;
    const alturaPlot = altura - m.t - m.b;
    const banda = larguraPlot / Math.max(1, pontos.length);
    const larguraBarra = Math.max(2, Math.min(24, banda * 0.62));
    const y = (v) => m.t + alturaPlot - (v / topo) * alturaPlot;

    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${largura} ${altura}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(altura));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Faturamento por ${agrupado}: ${pontos.length} ${agrupado === 'semana' ? 'semanas' : 'dias'}. Use a tabela para ver todos os valores.`);
    const ns = (tag, attrs) => { const n = document.createElementNS(SVG, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };

    ticks.forEach((t) => {
      svg.append(ns('line', { x1: m.e, x2: largura - m.d, y1: y(t), y2: y(t), class: t === 0 ? 'pn-eixo' : 'pn-grade' }));
      const rot = ns('text', { x: m.e - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'pn-eixo-texto' });
      rot.textContent = euroCompacto(t);
      svg.append(rot);
    });

    const passoRotulo = Math.max(1, Math.ceil(pontos.length / Math.max(2, Math.floor(larguraPlot / 64))));
    let maiorIdx = -1;
    pontos.forEach((p, i) => { if (p.valor > 0 && (maiorIdx < 0 || p.valor > pontos[maiorIdx].valor)) maiorIdx = i; });

    pontos.forEach((p, i) => {
      const cx = m.e + banda * i + banda / 2;
      const x = cx - larguraBarra / 2;
      const base = y(0);
      const yt = y(p.valor);
      const h = base - yt;
      if (p.valor > 0) {
        const r = Math.min(4, h, larguraBarra / 2);
        const d = `M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + larguraBarra - r} Q${x + larguraBarra},${yt} ${x + larguraBarra},${yt + r} V${base} Z`;
        svg.append(ns('path', { d, class: 'pn-barra', 'data-i': i }));
      }
      if (i % passoRotulo === 0 || i === pontos.length - 1) {
        const rx = ns('text', { x: cx, y: altura - 8, 'text-anchor': 'middle', class: 'pn-eixo-texto' });
        rx.textContent = p.rotulo;
        svg.append(rx);
      }
      // rótulo direto só no maior valor (seletivo)
      if (i === maiorIdx) {
        const rv = ns('text', { x: cx, y: Math.max(12, yt - 6), 'text-anchor': 'middle', class: 'pn-rotulo-valor' });
        rv.textContent = euroCompacto(p.valor);
        svg.append(rv);
      }
      // alvo de hover/foco: a coluna inteira da banda (maior que a barra)
      const alvoHit = ns('rect', { x: m.e + banda * i, y: m.t, width: Math.max(banda, 1), height: alturaPlot, class: 'pn-hit', tabindex: '0', role: 'img',
        'aria-label': `${p.titulo}: ${euro(p.valor)}, ${p.pedidos} pedido(s)` });
      const mostrar = (ev) => {
        svg.querySelectorAll('.pn-barra-ativa').forEach((b) => b.classList.remove('pn-barra-ativa'));
        const barra = svg.querySelector(`.pn-barra[data-i="${i}"]`);
        if (barra) barra.classList.add('pn-barra-ativa');
        mostrarTooltip(ev, euro(p.valor), [p.titulo, `${p.pedidos} pedido(s)`]);
      };
      alvoHit.addEventListener('pointermove', mostrar);
      alvoHit.addEventListener('focus', mostrar);
      alvoHit.addEventListener('pointerleave', esconderTooltip);
      alvoHit.addEventListener('blur', esconderTooltip);
      svg.append(alvoHit);
    });
    alvo.append(svg);
    if (!pontos.some((p) => p.valor > 0)) alvo.append(el('p', 'pn-vazio', 'Nenhuma venda no período.'));

    const tabela = el('table', 'tabela pn-tabela');
    const cab = el('thead');
    const trc = el('tr');
    [agrupado === 'semana' ? 'Semana' : 'Dia', 'Faturamento', 'Pedidos'].forEach((t) => trc.append(el('th', null, t)));
    cab.append(trc);
    const corpo = el('tbody');
    pontos.forEach((p) => {
      const tr = el('tr');
      tr.append(el('td', null, p.titulo), el('td', 'pn-num', euro(p.valor)), el('td', 'pn-num', num(p.pedidos)));
      corpo.append(tr);
    });
    tabela.append(cab, corpo);
    $('pn-tabela-vendas').replaceChildren(tabela);
  }

  function alternarTabelaVendas() {
    const tabela = $('pn-tabela-vendas');
    const mostrar = tabela.hidden;
    tabela.hidden = !mostrar;
    $('pn-grafico-vendas').hidden = mostrar;
    $('pn-vendas-alternar').textContent = mostrar ? 'Ver gráfico' : 'Ver tabela';
    $('pn-vendas-alternar').setAttribute('aria-pressed', String(mostrar));
  }

  // ------------------------------------------------------------------ tooltip (valor forte, rótulo secundário)

  function mostrarTooltip(ev, valor, linhas) {
    const tt = $('pn-tooltip');
    tt.replaceChildren(el('strong', null, valor), ...linhas.map((l) => el('span', null, l)));
    tt.hidden = false;
    let px;
    let py;
    if (ev && ev.clientX !== undefined && ev.type !== 'focus') {
      px = ev.clientX;
      py = ev.clientY;
    } else {
      const r = ev.target.getBoundingClientRect();
      px = r.left + r.width / 2;
      py = r.top;
    }
    const lt = tt.offsetWidth || 160;
    tt.style.left = `${Math.min(window.innerWidth - lt - 8, Math.max(8, px + 12))}px`;
    tt.style.top = `${Math.max(8, py - 48)}px`;
  }

  function esconderTooltip() {
    $('pn-tooltip').hidden = true;
    document.querySelectorAll('.pn-barra-ativa').forEach((b) => b.classList.remove('pn-barra-ativa'));
  }

  // ------------------------------------------------------------------ barras horizontais ordenadas

  function barrasOrdenadas(alvo, itens, formatar, vazio) {
    alvo.replaceChildren();
    if (!itens.length) { alvo.append(el('p', 'pn-vazio', vazio)); return; }
    const max = Math.max(...itens.map((i) => i.valor), 1);
    const lista = el('ol', 'pn-ranking');
    itens.forEach((i) => {
      const li = el('li', 'pn-ranking-linha');
      li.tabIndex = 0;
      li.setAttribute('aria-label', `${i.nome}: ${formatar(i.valor)}${i.extra ? `, ${i.extra}` : ''}`);
      const nome = el('span', 'pn-ranking-nome', i.nome);
      const trilho = el('span', 'pn-ranking-trilho');
      const barra = el('span', 'pn-ranking-barra');
      barra.style.width = `${Math.max(2, (i.valor / max) * 100)}%`;
      trilho.append(barra, el('span', 'pn-ranking-valor', formatar(i.valor)));
      li.append(nome, trilho);
      const mostrar = (ev) => mostrarTooltip(ev, formatar(i.valor), [i.nome, i.extra].filter(Boolean));
      li.addEventListener('pointermove', mostrar);
      li.addEventListener('focus', mostrar);
      li.addEventListener('pointerleave', esconderTooltip);
      li.addEventListener('blur', esconderTooltip);
      lista.append(li);
    });
    alvo.append(lista);
  }

  function renderizarMaisVendidos() {
    const itens = (st.dados.top_products || []).map((p) => ({ nome: p.name || '—', valor: Number(p.qty), extra: `${euro(p.revenue)} em vendas` }));
    barrasOrdenadas($('pn-mais-vendidos'), itens, (v) => `${num(v)} un`, 'Nenhuma venda no período.');
  }

  function renderizarRentaveis() {
    const f = st.dados.finance;
    $('pn-bloco-rentaveis').style.display = f ? '' : 'none';
    if (!f) return;
    const comCusto = (f.products || []).filter((p) => Number(p.qty_sold) > 0 && p.cogs !== null);
    const itens = comCusto
      .map((p) => ({ nome: p.name, valor: Number(p.revenue) - Number(p.cogs), extra: `margem ${Number(p.revenue) > 0 ? pct((Number(p.revenue) - Number(p.cogs)) / Number(p.revenue)) : '—'} · ${num(p.qty_sold)} vendido(s)` }))
      .filter((i) => i.valor > 0)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 8);
    barrasOrdenadas($('pn-mais-rentaveis'), itens, (v) => euro(v), 'Sem vendas com custo conhecido no período.');
    const semCusto = (f.products || []).filter((p) => Number(p.qty_sold) > 0 && p.cogs === null).length;
    const negativos = comCusto.filter((p) => Number(p.revenue) - Number(p.cogs) <= 0).length;
    const avisos = [];
    if (semCusto) avisos.push(`${semCusto} produto(s) vendido(s) sem custo ficam fora.`);
    if (negativos) avisos.push(`${negativos} produto(s) com contribuição zero ou negativa — veja Financeiro → Custos dos produtos.`);
    if (avisos.length) $('pn-mais-rentaveis').append(el('p', 'pn-sub', avisos.join(' ')));
  }

  // ------------------------------------------------------------------ listas

  function quantidade(valor, unidade) {
    const v = Number(valor);
    if (unidade === 'g') return `${num(v / 1000, 3)} kg`;
    if (unidade === 'ml') return `${num(v / 1000, 3)} l`;
    return `${num(v, 3)} ${unidade || 'un'}`;
  }

  function renderizarEstoque() {
    const alvo = $('pn-estoque');
    alvo.replaceChildren();
    const alertas = st.dados.stock_alerts || [];
    if (!alertas.length) { alvo.append(el('p', 'pn-vazio', '✓ Nada abaixo do mínimo.')); return; }
    const NIVEL = { negative: ['⛔', 'Negativo', 'pn-status-critico'], zero: ['⚠', 'Zerado', 'pn-status-alerta'], low: ['▼', 'Abaixo do mínimo', 'pn-status-serio'] };
    const lista = el('ul', 'pn-lista');
    alertas.slice(0, 8).forEach((a) => {
      const [icone, rotulo, classe] = NIVEL[a.level] || NIVEL.low;
      const li = el('li', 'pn-lista-item');
      const status = el('span', `pn-status ${classe}`);
      status.append(el('span', 'pn-status-icone', icone), el('span', null, rotulo));
      const info = el('span', 'pn-lista-info');
      info.append(el('strong', null, a.name), el('small', null, `${quantidade(a.stock, a.unit)}${a.min !== null && a.min !== undefined ? ` · mínimo ${quantidade(a.min, a.unit)}` : ''} · ${a.kind === 'item' ? 'insumo' : 'produto'}`));
      li.append(info, status);
      lista.append(li);
    });
    alvo.append(lista);
    if (alertas.length > 8) alvo.append(el('p', 'pn-sub', `+ ${alertas.length - 8} item(ns) — veja o Estoque.`));
  }

  function renderizarProducoes() {
    const alvo = $('pn-producoes');
    alvo.replaceChildren();
    const lista = st.dados.recent_productions || [];
    if (!lista.length) { alvo.append(el('p', 'pn-vazio', 'Nenhuma produção registrada ainda.')); return; }
    const ul = el('ul', 'pn-lista');
    lista.forEach((p) => {
      const li = el('li', 'pn-lista-item');
      const info = el('span', 'pn-lista-info');
      info.append(el('strong', null, `${p.kind === 'skewer' ? '🍢' : '🥗'} ${p.product_name}`),
        el('small', null, `${dataBr(p.produced_at)} · ${num(p.units_produced)} ${p.kind === 'skewer' ? 'espeto(s)' : 'porção(ões)'}`));
      const direita = el('span', 'pn-lista-valor', p.status === 'cancelled' ? 'cancelada' : p.cost_status === 'missing' ? 'sem custo' : `${euro(p.unit_cost)}/un`);
      if (p.status === 'cancelled') li.classList.add('pn-cancelada');
      li.append(info, direita);
      ul.append(li);
    });
    alvo.append(ul);
  }

  function renderizarNotas() {
    const notas = [];
    const f = st.dados.finance;
    if (f && Number(f.cogs.revenue_unknown) > 0) {
      notas.push(`O CMV não cobre ${euro(f.cogs.revenue_unknown)} de vendas de produtos sem custo — o resultado real é menor. Registre compras, produção ou estoque inicial com custo.`);
    }
    if (f && Number(f.cogs.estimated) > 0) notas.push(`Parte do CMV (${euro(f.cogs.estimated)}) é estimada pelo custo atual dos produtos.`);
    notas.push('Faturamento = pedidos não cancelados no período (inclui pagamentos ainda não confirmados).');
    $('pn-notas').replaceChildren(...notas.map((n) => el('p', 'pn-nota', n)));
  }

  window.__dashboard = { st, aplicarPeriodo };
})();
