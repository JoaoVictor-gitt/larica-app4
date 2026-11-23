/*
 * estoque.js — Fase D: estoque único e rastreável.
 *
 * Abas: Produtos de venda (unidades), Insumos (g/ml/un, custo médio) e
 * Movimentações (histórico unificado com responsável e origem).
 * Todo ajuste manual vai por RPC com motivo obrigatório; "Contagem" informa o saldo
 * contado e o sistema lança só a diferença (serve para o estoque inicial). Nunca
 * deixa saldo negativo por ajuste. Valor em estoque = saldo × custo (itens sem custo
 * aparecem como "sem custo", nunca com valor inventado).
 * Tudo num escopo próprio — esta página também carrega storage.js e services globais.
 */
(() => {
  const st = {
    produtos: [],
    itens: [],
    custos: new Map(),
    admin: false,
    ajuste: null, // { tipo: 'product'|'item', alvo, modo, req }
  };
  const $ = (id) => document.getElementById(id);
  const esc = (t) => escaparHtml(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const euro = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—'
    : '€' + Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(Number(v)) < 1 && Number(v) !== 0 ? 4 : 2 }));
  const num = (v, c = 3) => Number(v).toLocaleString('pt-PT', { maximumFractionDigits: c });
  const fator = (base) => (base === 'g' || base === 'ml' ? 1000 : 1);
  const unidadeExib = (base) => (base === 'g' ? 'kg' : base === 'ml' ? 'l' : 'un');
  const qtdItem = (q, base) => `${num(Number(q) / fator(base))} ${unidadeExib(base)}`;
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const abrir = (id) => $(id).classList.add('modal-visivel');
  const fechar = (id) => $(id).classList.remove('modal-visivel');

  const GRUPOS_MOV = {
    compra: ['purchase_in', 'purchase_reversal'],
    producao: ['production_in', 'production_reversal', 'production_out'],
    venda: ['sale', 'cancellation'],
    ajuste: ['manual_addition', 'manual_removal', 'adjustment_in', 'adjustment_out'],
    perda: ['waste'],
  };
  const ROTULO_MOV = {
    purchase_in: 'Entrada por compra', purchase_reversal: 'Estorno de compra',
    production_in: 'Entrada por produção', production_out: 'Saída para produção', production_reversal: 'Estorno de produção',
    sale: 'Venda', cancellation: 'Pedido cancelado',
    manual_addition: 'Ajuste (entrada)', manual_removal: 'Ajuste (saída)', adjustment_in: 'Ajuste (entrada)', adjustment_out: 'Ajuste (saída)',
    waste: 'Perda',
  };
  const ORIGEM_ESTOQUE = { purchased: 'Comprado', produced: 'Produzido', untracked: '—' };
  const CATEGORIA_ITEM = { ingredient: 'Ingrediente', meat: 'Carne', beverage: 'Bebida', supply: 'Insumo', packaging: 'Embalagem', cleaning: 'Limpeza', other: 'Outros' };

  function estoqueNoProduto(item) {
    const p = item.produtoId ? st.produtos.find((x) => x.id === item.produtoId) : null;
    return !!(p && p.stockMode === 'purchased');
  }
  const produtosEstoque = () => st.produtos.filter((p) => p.categoria !== 'Combos' && p.status === 'ativo');
  const insumosEstoque = () => st.itens.filter((i) => i.ativo && i.controlaEstoque && !estoqueNoProduto(i));

  function situacao(saldo, minimo) {
    if (saldo < 0) return { chave: 'zerado', html: '<span class="est-badge est-badge-erro">Negativo</span>' };
    if (saldo === 0) return { chave: 'zerado', html: '<span class="est-badge est-badge-cinza">Zerado</span>' };
    if (minimo !== null && minimo !== undefined && saldo < minimo) return { chave: 'baixo', html: '<span class="est-badge est-badge-alerta">Baixo</span>' };
    return { chave: 'ok', html: '<span class="est-badge est-badge-ok">OK</span>' };
  }

  // ------------------------------------------------------------------ carga

  document.addEventListener('DOMContentLoaded', async () => {
    ligarEventos();
    try {
      await carregar();
    } catch (erro) {
      console.error('Erro ao carregar o estoque:', erro);
      $('est-carregando').style.display = 'none';
      $('est-erro').textContent = 'Não foi possível carregar o estoque. ' + erro.message;
      $('est-erro').style.display = 'block';
      return;
    }
    $('est-carregando').style.display = 'none';
    renderizarTudo();
  });

  async function carregar() {
    const [produtos, itens, custos, admin] = await Promise.all([
      buscarProdutosDoSupabase(),
      buscarItensCompraDoSupabase(),
      buscarMapaCustosProdutosParaCompras(),
      usuarioEhAdminNoSupabase(),
    ]);
    st.produtos = produtos;
    st.itens = itens;
    st.custos = custos;
    st.admin = admin;
  }

  function renderizarTudo() {
    renderizarResumo();
    renderizarProdutos();
    renderizarInsumos();
    popularAlvosMovimentos();
  }

  // ------------------------------------------------------------------ resumo

  function renderizarResumo() {
    let valor = 0;
    let semCusto = 0;
    let baixos = 0;
    let zerados = 0;
    produtosEstoque().forEach((p) => {
      const custo = st.custos.get(p.id);
      if (p.quantidadeEstoque > 0) { if (custo === null || custo === undefined) semCusto++; else valor += p.quantidadeEstoque * custo; }
      const s = situacao(p.quantidadeEstoque, p.estoqueMinimo).chave;
      if (s === 'baixo') baixos++;
      if (s === 'zerado') zerados++;
    });
    insumosEstoque().forEach((i) => {
      if (i.estoque > 0) { if (i.custoMedio === null) semCusto++; else valor += i.estoque * i.custoMedio; }
      const s = situacao(i.estoque, i.estoqueMinimo).chave;
      if (s === 'baixo') baixos++;
      if (s === 'zerado') zerados++;
    });
    $('est-resumo').innerHTML = `
      <div class="card est-cartao"><span>Valor em estoque (custo)</span><strong>${euro(valor)}</strong>${semCusto ? `<small>${semCusto} item(ns) com saldo e sem custo não entram</small>` : ''}</div>
      <div class="card est-cartao ${baixos ? 'est-cartao-alerta' : ''}"><span>Abaixo do mínimo</span><strong>${baixos}</strong></div>
      <div class="card est-cartao ${zerados ? 'est-cartao-erro' : ''}"><span>Zerados ou negativos</span><strong>${zerados}</strong></div>`;
  }

  // ------------------------------------------------------------------ produtos

  function renderizarProdutos() {
    const busca = normalizar($('est-busca-produtos').value);
    const filtro = $('est-situacao-produtos').value;
    const lista = produtosEstoque()
      .filter((p) => !busca || normalizar(p.nome).includes(busca))
      .filter((p) => !filtro || situacao(p.quantidadeEstoque, p.estoqueMinimo).chave === filtro)
      .sort((a, b) => a.nome.localeCompare(b.nome));
    $('est-vazio-produtos').style.display = lista.length ? 'none' : 'block';
    $('est-corpo-produtos').innerHTML = lista.map((p) => {
      const custo = st.custos.get(p.id);
      const s = situacao(p.quantidadeEstoque, p.estoqueMinimo);
      const valor = p.quantidadeEstoque > 0 && custo !== null && custo !== undefined ? p.quantidadeEstoque * custo : null;
      return `<tr>
        <td><strong>${esc(p.nome)}</strong><br><small>${esc(p.categoria)}</small></td>
        <td>${ORIGEM_ESTOQUE[p.stockMode] || '—'}</td>
        <td class="est-num ${p.quantidadeEstoque < 0 ? 'est-negativo' : ''}">${num(p.quantidadeEstoque, 0)} un</td>
        <td class="est-num">${p.estoqueMinimo === null ? '—' : num(p.estoqueMinimo, 0)}</td>
        <td class="est-num">${custo === null || custo === undefined ? '<span class="est-sem">sem custo</span>' : euro(custo)}</td>
        <td class="est-num">${valor === null ? '—' : euro(valor)}</td>
        <td>${s.html}</td>
        <td class="est-acoes">
          <button type="button" class="btn btn-secundario est-btn-pequeno" data-ajustar-produto="${p.id}">Ajustar</button>
          <button type="button" class="btn-icone" data-historico-produto="${p.id}" title="Movimentações">🕒</button>
        </td>
      </tr>`;
    }).join('');
    $('est-corpo-produtos').querySelectorAll('[data-ajustar-produto]').forEach((b) => b.addEventListener('click', () => abrirAjuste('product', b.dataset.ajustarProduto)));
    $('est-corpo-produtos').querySelectorAll('[data-historico-produto]').forEach((b) => b.addEventListener('click', () => verHistorico('product', b.dataset.historicoProduto)));
  }

  // ------------------------------------------------------------------ insumos

  function renderizarInsumos() {
    const busca = normalizar($('est-busca-insumos').value);
    const filtro = $('est-situacao-insumos').value;
    const lista = insumosEstoque()
      .filter((i) => !busca || normalizar(i.nome).includes(busca))
      .filter((i) => !filtro || (filtro === 'semcusto' ? i.custoMedio === null : situacao(i.estoque, i.estoqueMinimo).chave === filtro))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    $('est-vazio-insumos').style.display = lista.length ? 'none' : 'block';
    $('est-corpo-insumos').innerHTML = lista.map((i) => {
      const s = situacao(i.estoque, i.estoqueMinimo);
      const valor = i.estoque > 0 && i.custoMedio !== null ? i.estoque * i.custoMedio : null;
      return `<tr>
        <td><strong>${esc(i.nome)}</strong></td>
        <td>${CATEGORIA_ITEM[i.categoria] || esc(i.categoria)}</td>
        <td class="est-num ${i.estoque < 0 ? 'est-negativo' : ''}">${qtdItem(i.estoque, i.unidadeBase)}</td>
        <td class="est-num">${i.estoqueMinimo === null ? '—' : qtdItem(i.estoqueMinimo, i.unidadeBase)}</td>
        <td class="est-num">${i.custoMedio === null ? '<span class="est-sem">sem custo</span>' : `${euro(i.custoMedio * fator(i.unidadeBase))}/${unidadeExib(i.unidadeBase)}`}</td>
        <td class="est-num">${valor === null ? '—' : euro(valor)}</td>
        <td>${s.html}</td>
        <td class="est-acoes">
          <button type="button" class="btn btn-secundario est-btn-pequeno" data-ajustar-item="${i.id}">Ajustar</button>
          <button type="button" class="btn-icone" data-historico-item="${i.id}" title="Movimentações">🕒</button>
        </td>
      </tr>`;
    }).join('');
    $('est-corpo-insumos').querySelectorAll('[data-ajustar-item]').forEach((b) => b.addEventListener('click', () => abrirAjuste('item', b.dataset.ajustarItem)));
    $('est-corpo-insumos').querySelectorAll('[data-historico-item]').forEach((b) => b.addEventListener('click', () => verHistorico('item', b.dataset.historicoItem)));
  }

  // ------------------------------------------------------------------ abas e eventos

  function trocarAba(chave) {
    document.querySelectorAll('[data-est-aba]').forEach((b) => b.classList.toggle('est-aba-ativa', b.dataset.estAba === chave));
    document.querySelectorAll('[data-est-painel]').forEach((p) => p.classList.toggle('est-painel-ativo', p.dataset.estPainel === chave));
    if (chave === 'movimentos') carregarMovimentos();
  }

  function ligarEventos() {
    document.querySelectorAll('[data-est-aba]').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.estAba)));
    ['est-busca-produtos', 'est-situacao-produtos'].forEach((id) => $(id).addEventListener('input', renderizarProdutos));
    ['est-busca-insumos', 'est-situacao-insumos'].forEach((id) => $(id).addEventListener('input', renderizarInsumos));
    $('est-mov-livro').addEventListener('input', () => { popularAlvosMovimentos(); carregarMovimentos(); });
    ['est-mov-alvo', 'est-mov-tipo', 'est-mov-de', 'est-mov-ate'].forEach((id) => $(id).addEventListener('input', carregarMovimentos));
    document.querySelectorAll('.est-modo').forEach((b) => b.addEventListener('click', () => escolherModo(b.dataset.modo)));
    ['est-ajuste-qtd', 'est-ajuste-custo'].forEach((id) => $(id).addEventListener('input', atualizarPreviaAjuste));
    $('est-ajuste-fechar-x').addEventListener('click', () => fechar('est-modal-ajuste'));
    $('est-ajuste-cancelar').addEventListener('click', () => fechar('est-modal-ajuste'));
    $('est-form-ajuste').addEventListener('submit', (e) => { e.preventDefault(); salvarAjuste(); });
  }

  // ------------------------------------------------------------------ movimentações

  function popularAlvosMovimentos() {
    const livro = $('est-mov-livro').value;
    const atual = $('est-mov-alvo').value;
    const prods = livro === 'item' ? [] : produtosEstoque().map((p) => ({ id: `product:${p.id}`, nome: p.nome }));
    const itens = livro === 'product' ? [] : insumosEstoque().map((i) => ({ id: `item:${i.id}`, nome: i.nome }));
    const opc = [...prods, ...itens].sort((a, b) => a.nome.localeCompare(b.nome));
    $('est-mov-alvo').innerHTML = '<option value="">Todos</option>' + opc.map((o) => `<option value="${o.id}">${esc(o.nome)}</option>`).join('');
    if (opc.some((o) => o.id === atual)) $('est-mov-alvo').value = atual;
  }

  function verHistorico(tipo, id) {
    $('est-mov-livro').value = tipo;
    popularAlvosMovimentos();
    $('est-mov-alvo').value = `${tipo}:${id}`;
    trocarAba('movimentos');
  }

  function origemTexto(m) {
    if (m.numeroPedido) return `Pedido #LARICA-${m.numeroPedido}`;
    if (m.origemTipo === 'purchase_line') return 'Compra';
    if (['production_batch', 'skewer_production', 'side_production'].includes(m.origemTipo)) return 'Produção';
    if (m.origemTipo === 'manual' || m.origemTipo === 'manual_adjustment' || !m.origemTipo) return 'Ajuste';
    return m.origemTipo;
  }

  let consultaMov = 0;
  async function carregarMovimentos() {
    const alvo = $('est-mov-alvo').value;
    const [livroAlvo, idAlvo] = alvo ? alvo.split(':') : [null, null];
    const grupo = $('est-mov-tipo').value;
    const filtros = {
      ledger: livroAlvo || $('est-mov-livro').value || null,
      target_id: idAlvo,
      types: grupo ? GRUPOS_MOV[grupo] : null,
      date_from: $('est-mov-de').value || null,
      date_to: $('est-mov-ate').value || null,
      limit: 300,
    };
    const minha = ++consultaMov;
    $('est-mov-carregando').style.display = 'block';
    $('est-mov-erro').style.display = 'none';
    let movs;
    try {
      movs = await buscarMovimentosEstoqueRastreavel(filtros);
    } catch (erro) {
      if (minha !== consultaMov) return;
      $('est-mov-carregando').style.display = 'none';
      $('est-mov-erro').textContent = 'Não foi possível carregar as movimentações. ' + erro.message;
      $('est-mov-erro').style.display = 'block';
      return;
    }
    if (minha !== consultaMov) return;
    $('est-mov-carregando').style.display = 'none';
    $('est-mov-vazio').style.display = movs.length ? 'none' : 'block';
    $('est-corpo-movimentos').innerHTML = movs.map((m) => {
      const ehItem = m.livro === 'item';
      const qtd = ehItem ? qtdItem(m.quantidade, m.unidadeBase) : `${num(m.quantidade, 0)} un`;
      const saldo = ehItem ? qtdItem(m.saldoDepois, m.unidadeBase) : `${num(m.saldoDepois, 0)} un`;
      return `<tr>
        <td>${formatarData(m.criadoEm)}<br><small>${formatarHora(m.criadoEm)}</small></td>
        <td>${esc(m.alvoNome)}<br><small>${ehItem ? 'insumo' : 'produto'}</small></td>
        <td>${ROTULO_MOV[m.tipo] || esc(m.tipo)}${m.motivo ? `<br><small>${esc(m.motivo)}</small>` : ''}</td>
        <td class="est-num ${m.quantidade < 0 ? 'est-saida' : 'est-entrada'}">${m.quantidade > 0 ? '+' : ''}${qtd}</td>
        <td class="est-num">${saldo}</td>
        <td class="est-num">${m.valor === null ? '—' : euro(m.valor)}</td>
        <td>${esc(origemTexto(m))}</td>
        <td>${esc(m.responsavel || '—')}</td>
      </tr>`;
    }).join('');
  }

  // ------------------------------------------------------------------ ajuste

  function abrirAjuste(tipo, id) {
    const alvo = tipo === 'product' ? st.produtos.find((p) => p.id === id) : st.itens.find((i) => i.id === id);
    if (!alvo) return;
    st.ajuste = { tipo, alvo, modo: 'count', req: novoId() };
    const base = tipo === 'product' ? 'un' : alvo.unidadeBase;
    const saldo = tipo === 'product' ? alvo.quantidadeEstoque : alvo.estoque;
    $('est-ajuste-titulo').textContent = `Ajustar — ${alvo.nome}`;
    $('est-ajuste-saldo').innerHTML = `Saldo atual: <strong>${tipo === 'product' ? `${num(saldo, 0)} un` : qtdItem(saldo, base)}</strong>`;
    $('est-ajuste-unidade').textContent = unidadeExib(base);
    $('est-ajuste-minimo-unidade').textContent = unidadeExib(base);
    $('est-ajuste-qtd').value = '';
    $('est-ajuste-qtd').step = tipo === 'product' || base === 'un' ? '1' : 'any';
    $('est-ajuste-custo').value = '';
    $('est-ajuste-motivo').value = '';
    const minimo = alvo.estoqueMinimo;
    $('est-ajuste-minimo').value = minimo === null || minimo === undefined ? '' : minimo / fator(base);
    $('est-ajuste-minimo-grupo').style.display = st.admin ? '' : 'none';
    $('est-ajuste-erro').style.display = 'none';
    $('est-ajuste-custo-rotulo').textContent = `Custo por ${unidadeExib(base)} (€) — opcional`;
    escolherModo('count');
    abrir('est-modal-ajuste');
    $('est-ajuste-qtd').focus();
  }

  function escolherModo(modo) {
    if (!st.ajuste) return;
    st.ajuste.modo = modo;
    document.querySelectorAll('.est-modo').forEach((b) => b.classList.toggle('est-modo-ativo', b.dataset.modo === modo));
    $('est-ajuste-qtd-rotulo').textContent = modo === 'count' ? 'Quantidade contada (saldo real agora)' : modo === 'in' ? 'Quantidade que entrou' : modo === 'out' ? 'Quantidade que saiu' : 'Quantidade perdida';
    const ehItem = st.ajuste.tipo === 'item';
    $('est-ajuste-custo-grupo').style.display = ehItem && (modo === 'in' || modo === 'count') ? '' : 'none';
    if (ehItem) {
      const a = st.ajuste.alvo;
      $('est-ajuste-custo-dica').textContent = a.custoMedio === null
        ? 'Sem custo informado, o insumo fica sem valor até a primeira compra registrada.'
        : `Vazio = entra pelo custo médio atual (${euro(a.custoMedio * fator(a.unidadeBase))}/${unidadeExib(a.unidadeBase)}). Informado = entra no custo médio ponderado.`;
    }
    atualizarPreviaAjuste();
  }

  function calcularDelta() {
    const a = st.ajuste;
    const v = Number(String($('est-ajuste-qtd').value).replace(',', '.'));
    if (!$('est-ajuste-qtd').value || !Number.isFinite(v) || v < 0) return null;
    const base = a.tipo === 'product' ? 'un' : a.alvo.unidadeBase;
    const qBase = Math.round(v * fator(base) * 1000) / 1000;
    const saldo = a.tipo === 'product' ? a.alvo.quantidadeEstoque : a.alvo.estoque;
    const delta = a.modo === 'count' ? qBase - saldo : a.modo === 'in' ? qBase : -qBase;
    return { qBase, delta, saldo, novo: saldo + delta, base };
  }

  function atualizarPreviaAjuste() {
    const c = calcularDelta();
    const alvo = $('est-ajuste-previa');
    if (!c) { alvo.textContent = ''; return; }
    const fmt = (q) => (st.ajuste.tipo === 'product' ? `${num(q, 0)} un` : qtdItem(q, c.base));
    if (c.delta === 0) { alvo.innerHTML = 'Sem diferença: nada a ajustar.'; return; }
    alvo.innerHTML = `${fmt(c.saldo)} → <strong class="${c.novo < 0 ? 'est-negativo' : ''}">${fmt(c.novo)}</strong> (${c.delta > 0 ? '+' : ''}${fmt(c.delta)})${c.novo < 0 ? ' — não permitido: o saldo ficaria negativo.' : ''}`;
  }

  function mostrarErroAjuste(msg) {
    $('est-ajuste-erro').textContent = msg;
    $('est-ajuste-erro').style.display = msg ? '' : 'none';
  }

  async function salvarAjuste() {
    const a = st.ajuste;
    if (!a) return;
    mostrarErroAjuste('');
    const c = calcularDelta();
    const motivo = $('est-ajuste-motivo').value.trim();
    if (!c) return mostrarErroAjuste('Informe a quantidade.');
    if (a.tipo === 'product' && !Number.isInteger(c.qBase)) return mostrarErroAjuste('Produto de venda usa quantidade inteira.');
    if (a.modo !== 'count' && c.qBase === 0) return mostrarErroAjuste('Informe uma quantidade maior que zero.');
    if (c.novo < 0) return mostrarErroAjuste('O saldo ficaria negativo. Confira a quantidade.');
    if (motivo.length < 3) return mostrarErroAjuste('Informe o motivo do ajuste.');

    const minimoTexto = $('est-ajuste-minimo').value;
    const minimoNovo = minimoTexto === '' ? null : Math.round(Number(minimoTexto.replace(',', '.')) * fator(c.base) * 1000) / 1000;
    const minimoMudou = st.admin && (minimoNovo ?? null) !== (a.alvo.estoqueMinimo ?? null);
    if (minimoNovo !== null && (!Number.isFinite(minimoNovo) || minimoNovo < 0)) return mostrarErroAjuste('Estoque mínimo inválido.');

    const botao = $('est-ajuste-salvar');
    botao.disabled = true;
    try {
      if (c.delta !== 0) {
        if (a.tipo === 'product') {
          await ajustarProdutoEstoqueRastreavel({ client_request_id: a.req, product_id: a.alvo.id, mode: a.modo, quantity: c.qBase, reason: motivo });
        } else {
          const custoTexto = $('est-ajuste-custo').value;
          const custoBase = custoTexto === '' || c.delta < 0 ? null : Number(custoTexto.replace(',', '.')) / fator(c.base);
          await ajustarInsumoEstoqueRastreavel({ client_request_id: a.req, purchase_item_id: a.alvo.id, mode: a.modo, quantity: c.qBase, unit_cost: custoBase, reason: motivo });
        }
      } else if (!minimoMudou) {
        botao.disabled = false;
        return mostrarErroAjuste('Sem diferença: nada a ajustar.');
      }
      if (minimoMudou) await definirMinimoEstoqueRastreavel(a.tipo, a.alvo.id, minimoNovo);
    } catch (erro) {
      botao.disabled = false;
      return mostrarErroAjuste(erro.message);
    }
    botao.disabled = false;
    fechar('est-modal-ajuste');
    mostrarToast(c.delta !== 0 ? 'Ajuste registrado no histórico.' : 'Estoque mínimo atualizado.', 'sucesso');
    try {
      await carregar();
    } catch (erro) {
      mostrarToast('Gravado, mas não foi possível atualizar a tela. Recarregue a página.', 'erro');
      return;
    }
    renderizarTudo();
    if (document.querySelector('[data-est-painel="movimentos"]').classList.contains('est-painel-ativo')) carregarMovimentos();
  }

  window.__estoque = { st, abrirAjuste, carregarMovimentos, trocarAba };
})();
