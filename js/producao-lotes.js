/*
 * producao-lotes.js — Fase C: Produzir Espetos, Produzir Acompanhamentos e Histórico.
 *
 * Fluxo curto e sem dependência de compra/lote específico:
 *   Espetos: espeto + matéria-prima + peso bruto (kg) + espetos produzidos.
 *   Acompanhamentos: produto + peso final (kg) + porção (g) [+ ficha técnica usada].
 * Todo cálculo vem do banco (preview_production), o mesmo que a confirmação usa —
 * a prévia nunca diverge do que é gravado. Estoque insuficiente pede autorização
 * explícita. Correção = cancelar com estorno.
 *
 * Tudo dentro de um escopo próprio: esta página também carrega producao.js (Fichas
 * Técnicas) e vários services com funções globais — nada aqui cria nome global.
 */
(() => {
  const estado = {
    produtos: [],
    itens: [],
    receitas: [],
    lotes: [],
    admin: false,
    req: { skewer: null, side: null },
    timers: {},
    loteDetalheId: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (t) => escaparHtml(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const euro = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—'
    : '€' + Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(Number(v)) < 1 && Number(v) !== 0 ? 4 : 2 }));
  const num = (v, casas = 3) => Number(v).toLocaleString('pt-PT', { maximumFractionDigits: casas });
  const kg = (g) => (Math.abs(g) >= 1000 ? `${num(g / 1000)} kg` : `${num(g)} g`);
  const qtdBase = (q, u) => (u === 'g' ? kg(q) : u === 'ml' ? (Math.abs(q) >= 1000 ? `${num(q / 1000)} l` : `${num(q)} ml`) : `${num(q)} ${u || 'un'}`);
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const hoje = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dataBr = (iso) => {
    const [a, m, d] = String(iso || '').slice(0, 10).split('-');
    return d ? `${d}/${m}/${a}` : '';
  };
  const numeroDe = (el) => {
    const v = String(el.value || '').replace(',', '.').trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const abrir = (id) => $(id).classList.add('modal-visivel');
  const fechar = (id) => $(id).classList.remove('modal-visivel');

  const produtoPorId = (id) => estado.produtos.find((p) => p.id === id) || null;
  const itemPorId = (id) => estado.itens.find((i) => i.id === id) || null;
  const receitaPorId = (id) => estado.receitas.find((r) => r.id === id) || null;

  function ehMateriaPrima(item) {
    if (!item.ativo || !item.controlaEstoque || item.unidadeBase !== 'g') return false;
    const p = item.produtoId ? produtoPorId(item.produtoId) : null;
    return !(p && p.stockMode === 'purchased');
  }

  // ------------------------------------------------------------------ carga

  document.addEventListener('DOMContentLoaded', async () => {
    if (!$('pl-form-espeto')) return;
    try {
      await carregar();
    } catch (erro) {
      console.error('Erro ao carregar a Produção:', erro);
      $('pl-historico-carregando').style.display = 'none';
      $('pl-historico-erro').textContent = 'Não foi possível carregar a produção. ' + erro.message;
      $('pl-historico-erro').style.display = 'block';
      ['pl-espeto-erro', 'pl-acomp-erro'].forEach((id) => mostrarErro(id, 'Não foi possível carregar os dados. ' + erro.message));
      return;
    }
    estado.req.skewer = novoId();
    estado.req.side = novoId();
    $('pl-espeto-data').value = hoje();
    $('pl-acomp-data').value = hoje();
    document.querySelectorAll('[data-pl-somente-admin]').forEach((el) => { el.style.display = estado.admin ? 'none' : ''; });
    $('pl-espeto-confirmar').disabled = !estado.admin;
    $('pl-acomp-confirmar').disabled = !estado.admin;
    popularSelects();
    ligarEventos();
    renderizarHistorico();
    renderizarUltimas();
    aoTrocarProdutoEspeto();
    aoTrocarProdutoAcomp();
  });

  async function carregar() {
    const [produtos, itens, receitas, lotes, admin] = await Promise.all([
      buscarProdutosDoSupabase(),
      buscarItensCompraDoSupabase(),
      buscarReceitasDoSupabase(),
      buscarLotesProducaoDoSupabase(),
      usuarioEhAdminNoSupabase(),
    ]);
    estado.produtos = produtos;
    estado.itens = itens;
    estado.receitas = receitas;
    estado.lotes = lotes;
    estado.admin = admin;
  }

  async function recarregarDepoisDeGravar() {
    try {
      const [produtos, itens, lotes] = await Promise.all([buscarProdutosDoSupabase(), buscarItensCompraDoSupabase(), buscarLotesProducaoDoSupabase()]);
      estado.produtos = produtos;
      estado.itens = itens;
      estado.lotes = lotes;
    } catch (erro) {
      console.error('Erro ao recarregar a Produção:', erro);
      mostrarToast('Gravado, mas não foi possível atualizar a tela. Recarregue a página.', 'erro');
      return;
    }
    const espetoSel = $('pl-espeto-produto').value;
    const materiaSel = $('pl-espeto-materia').value;
    const acompSel = $('pl-acomp-produto').value;
    popularSelects();
    $('pl-espeto-produto').value = espetoSel;
    $('pl-espeto-materia').value = materiaSel;
    $('pl-acomp-produto').value = acompSel;
    atualizarInfoMateria();
    renderizarHistorico();
    renderizarUltimas();
  }

  // ------------------------------------------------------------------ selects

  function opcoes(lista, rotulo, vazio) {
    return (vazio ? `<option value="">${esc(vazio)}</option>` : '') + lista.map((x) => `<option value="${x.id}">${esc(rotulo(x))}</option>`).join('');
  }

  function rotuloMateria(i) {
    const custo = i.custoMedio === null ? 'sem custo' : `${euro(i.custoMedio * 1000)}/kg`;
    return `${i.nome} — ${kg(i.estoque)} · ${custo}`;
  }

  function popularSelects() {
    const espetos = estado.produtos.filter((p) => p.categoria === 'Espetinhos' && p.status === 'ativo').sort((a, b) => a.nome.localeCompare(b.nome));
    const acomps = estado.produtos.filter((p) => p.categoria === 'Acompanhamentos' && p.status === 'ativo').sort((a, b) => a.nome.localeCompare(b.nome));
    const materias = estado.itens.filter(ehMateriaPrima)
      .sort((a, b) => (a.categoria === 'meat' ? 0 : 1) - (b.categoria === 'meat' ? 0 : 1) || a.nome.localeCompare(b.nome));
    $('pl-espeto-produto').innerHTML = opcoes(espetos, (p) => `${p.nome} (estoque ${p.quantidadeEstoque})`, espetos.length ? '— Escolha o espeto —' : 'Nenhum espeto ativo');
    $('pl-espeto-materia').innerHTML = opcoes(materias, rotuloMateria, materias.length ? '— Escolha a matéria-prima —' : 'Cadastre a matéria-prima em Compras');
    $('pl-acomp-produto').innerHTML = opcoes(acomps, (p) => `${p.nome} (estoque ${p.quantidadeEstoque})`, acomps.length ? '— Escolha o acompanhamento —' : 'Nenhum acompanhamento ativo');
    $('pl-acomp-receita').innerHTML = opcoes(estado.receitas.filter((r) => r.ativo).sort((a, b) => a.nome.localeCompare(b.nome)), (r) => r.nome, 'Sem ficha técnica');
  }

  function atualizarInfoMateria() {
    const item = itemPorId($('pl-espeto-materia').value);
    $('pl-espeto-materia-info').textContent = item
      ? `Em estoque: ${kg(item.estoque)} · custo médio ${item.custoMedio === null ? 'ainda sem compras registradas' : euro(item.custoMedio * 1000) + '/kg'}`
      : 'A carne bruta é baixada do estoque pelo custo médio das compras.';
  }

  // ------------------------------------------------------------------ eventos

  function ligarEventos() {
    $('pl-espeto-produto').addEventListener('change', aoTrocarProdutoEspeto);
    $('pl-espeto-materia').addEventListener('change', () => { atualizarInfoMateria(); agendarPrevia('skewer'); });
    ['pl-espeto-peso', 'pl-espeto-qtd'].forEach((id) => $(id).addEventListener('input', () => agendarPrevia('skewer')));
    $('pl-acomp-produto').addEventListener('change', aoTrocarProdutoAcomp);
    $('pl-acomp-receita').addEventListener('change', () => { atualizarVezes(); agendarPrevia('side'); });
    ['pl-acomp-peso', 'pl-acomp-porcao', 'pl-acomp-vezes'].forEach((id) => $(id).addEventListener('input', () => agendarPrevia('side')));
    $('pl-form-espeto').addEventListener('submit', (e) => { e.preventDefault(); confirmar('skewer'); });
    $('pl-form-acomp').addEventListener('submit', (e) => { e.preventDefault(); confirmar('side'); });

    ['pl-filtro-tipo', 'pl-filtro-status', 'pl-filtro-de', 'pl-filtro-ate'].forEach((id) => $(id).addEventListener('input', renderizarHistorico));
    $('pl-detalhe-fechar').addEventListener('click', () => fechar('pl-modal-detalhe'));
    $('pl-detalhe-fechar-x').addEventListener('click', () => fechar('pl-modal-detalhe'));
    $('pl-detalhe-cancelar').addEventListener('click', () => {
      $('pl-cancelar-motivo').value = '';
      $('pl-cancelar-erro').style.display = 'none';
      abrir('pl-modal-cancelar');
    });
    $('pl-cancelar-voltar').addEventListener('click', () => fechar('pl-modal-cancelar'));
    $('pl-cancelar-fechar-x').addEventListener('click', () => fechar('pl-modal-cancelar'));
    $('pl-cancelar-confirmar').addEventListener('click', confirmarCancelamento);
  }

  function aoTrocarProdutoEspeto() {
    const p = produtoPorId($('pl-espeto-produto').value);
    if (p && p.producaoItemId && itemPorId(p.producaoItemId) && ehMateriaPrima(itemPorId(p.producaoItemId))) {
      $('pl-espeto-materia').value = p.producaoItemId;
    } else if (!$('pl-espeto-materia').value) {
      const carnes = estado.itens.filter((i) => ehMateriaPrima(i) && i.categoria === 'meat');
      if (carnes.length === 1) $('pl-espeto-materia').value = carnes[0].id;
    }
    atualizarInfoMateria();
    agendarPrevia('skewer');
  }

  function aoTrocarProdutoAcomp() {
    const p = produtoPorId($('pl-acomp-produto').value);
    $('pl-acomp-porcao').value = p && p.porcaoGramas ? p.porcaoGramas : '';
    $('pl-acomp-receita').value = p && p.producaoReceitaId && receitaPorId(p.producaoReceitaId) ? p.producaoReceitaId : '';
    atualizarVezes();
    agendarPrevia('side');
  }

  function atualizarVezes() {
    $('pl-acomp-vezes-grupo').style.display = $('pl-acomp-receita').value ? '' : 'none';
  }

  // ------------------------------------------------------------------ prévia (calculada pelo banco)

  function payloadDe(tipo) {
    if (tipo === 'skewer') {
      const peso = numeroDe($('pl-espeto-peso'));
      return {
        kind: 'skewer',
        product_id: $('pl-espeto-produto').value || null,
        raw_item_id: $('pl-espeto-materia').value || null,
        raw_quantity_g: peso === null ? null : Math.round(peso * 1000 * 1000) / 1000,
        units_produced: numeroDe($('pl-espeto-qtd')),
        produced_at: $('pl-espeto-data').value || null,
      };
    }
    const peso = numeroDe($('pl-acomp-peso'));
    const receita = $('pl-acomp-receita').value || null;
    return {
      kind: 'side',
      product_id: $('pl-acomp-produto').value || null,
      output_weight_g: peso === null ? null : Math.round(peso * 1000 * 1000) / 1000,
      portion_g: numeroDe($('pl-acomp-porcao')),
      recipe_id: receita,
      recipe_multiplier: receita ? numeroDe($('pl-acomp-vezes')) || 1 : null,
      produced_at: $('pl-acomp-data').value || null,
    };
  }

  function faltaPreencher(tipo, p) {
    if (tipo === 'skewer') {
      if (!p.product_id) return 'Escolha o espeto.';
      if (!p.raw_item_id) return 'Escolha a matéria-prima.';
      if (!p.raw_quantity_g || p.raw_quantity_g <= 0) return 'Informe o peso bruto usado.';
      if (!p.units_produced || p.units_produced <= 0 || !Number.isInteger(p.units_produced)) return 'Informe quantos espetos foram produzidos.';
      return null;
    }
    if (!p.product_id) return 'Escolha o acompanhamento.';
    if (!p.output_weight_g || p.output_weight_g <= 0) return 'Informe o peso final produzido.';
    if (!p.portion_g || p.portion_g <= 0) return 'Informe o tamanho da porção.';
    return null;
  }

  function agendarPrevia(tipo) {
    clearTimeout(estado.timers[tipo]);
    estado.timers[tipo] = setTimeout(() => atualizarPrevia(tipo), 250);
  }

  async function atualizarPrevia(tipo) {
    const alvo = $(tipo === 'skewer' ? 'pl-espeto-previa' : 'pl-acomp-previa');
    const p = payloadDe(tipo);
    const falta = faltaPreencher(tipo, p);
    if (falta) {
      alvo.innerHTML = `<p class="pl-previa-vazia">${esc(falta)}</p>`;
      return null;
    }
    alvo.innerHTML = '<p class="pl-previa-vazia">Calculando…</p>';
    let plano;
    try {
      plano = await previsualizarLoteProducaoNoSupabase(p);
    } catch (erro) {
      alvo.innerHTML = `<p class="pl-previa-vazia pl-texto-erro">${esc(erro.message)}</p>`;
      return null;
    }
    // descarta resposta atrasada de uma digitação anterior
    if (JSON.stringify(payloadDe(tipo)) !== JSON.stringify(p)) return null;
    alvo.innerHTML = tipo === 'skewer' ? htmlPreviaEspeto(plano) : htmlPreviaAcomp(plano);
    return plano;
  }

  function htmlAvisos(plano) {
    const avisos = [];
    (plano.shortages || []).forEach((s) => {
      avisos.push(`<li class="pl-aviso-erro">Estoque insuficiente de <strong>${esc(s.name)}</strong>: disponível ${qtdBase(Number(s.available), s.base_unit)}, necessário ${qtdBase(Number(s.required), s.base_unit)}. Registre a compra antes ou confirme para o estoque ficar negativo.</li>`);
    });
    if (plano.cost_status === 'missing') {
      avisos.push(plano.kind === 'skewer'
        ? '<li>Custo desconhecido: a matéria-prima ainda não tem compras registradas. Os espetos entram no estoque, mas o custo do produto não muda.</li>'
        : '<li>Sem dados de custo: escolha a ficha técnica usada para calcular o custo e dar baixa nos ingredientes. Sem ela, só as porções entram no estoque.</li>');
    } else if (plano.cost_status === 'partial') {
      const sem = (plano.inputs || []).filter((i) => i.total_cost === null).map((i) => i.name);
      avisos.push(`<li>Custo parcial (estimado): sem preço para ${esc(sem.join(', '))}. O custo do produto não será alterado.</li>`);
    }
    return avisos.length ? `<ul class="pl-avisos">${avisos.join('')}</ul>` : '';
  }

  function htmlPreviaEspeto(plano) {
    const insumo = plano.inputs[0];
    const custoKg = insumo && insumo.unit_cost !== null ? euro(Number(insumo.unit_cost) * 1000) + '/kg' : '—';
    const depois = insumo ? Number(insumo.stock_before) - Number(insumo.quantity) : null;
    return `
      <dl class="pl-resumo">
        <div class="pl-destaque"><dt>Por espeto</dt><dd>${num(plano.grams_per_unit, 1)} g brutos</dd></div>
        <div><dt>Espetos</dt><dd>${plano.units_produced}</dd></div>
        <div><dt>Custo médio da carne</dt><dd>${custoKg}</dd></div>
        <div><dt>Custo total</dt><dd>${euro(plano.total_cost)}</dd></div>
        <div class="pl-destaque"><dt>Custo por espeto</dt><dd>${euro(plano.unit_cost)}</dd></div>
        <div><dt>${esc(insumo ? insumo.name : 'Matéria-prima')}</dt><dd>${insumo ? `${kg(Number(insumo.stock_before))} → ${kg(depois)}` : '—'}</dd></div>
      </dl>${htmlAvisos(plano)}`;
  }

  function htmlPreviaAcomp(plano) {
    const linhas = (plano.inputs || []).map((i) => `
      <tr><td>${esc(i.name)}</td><td>${qtdBase(Number(i.quantity), i.base_unit)}</td><td>${i.total_cost === null ? '<span class="pl-texto-erro">sem preço</span>' : euro(i.total_cost)}</td>
        <td>${i.stock_moved ? `baixa · ${qtdBase(Number(i.stock_before), i.base_unit)} → ${qtdBase(Number(i.stock_before) - Number(i.quantity), i.base_unit)}` : '<small>sem estoque controlado</small>'}</td></tr>`).join('');
    return `
      <dl class="pl-resumo">
        <div class="pl-destaque"><dt>Porções</dt><dd>${plano.units_produced}</dd></div>
        <div><dt>Peso / porção</dt><dd>${kg(Number(plano.output_weight_g))} / ${num(plano.portion_g, 0)} g</dd></div>
        ${Number(plano.leftover_g) > 0 ? `<div><dt>Sobra</dt><dd>${num(plano.leftover_g, 0)} g</dd></div>` : ''}
        <div><dt>Custo total</dt><dd>${euro(plano.total_cost)}</dd></div>
        <div class="pl-destaque"><dt>Custo por porção</dt><dd>${euro(plano.unit_cost)}</dd></div>
      </dl>
      ${linhas ? `<div class="tabela-producao-wrap"><table class="tabela pl-tabela-compacta"><thead><tr><th>Ingrediente</th><th>Qtd.</th><th>Custo</th><th>Estoque</th></tr></thead><tbody>${linhas}</tbody></table></div>` : ''}
      ${htmlAvisos(plano)}`;
  }

  // ------------------------------------------------------------------ confirmar

  function mostrarErro(id, msg) {
    const el = $(id);
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
  }

  async function confirmar(tipo) {
    if (!estado.admin) return;
    const idErro = tipo === 'skewer' ? 'pl-espeto-erro' : 'pl-acomp-erro';
    const botao = $(tipo === 'skewer' ? 'pl-espeto-confirmar' : 'pl-acomp-confirmar');
    mostrarErro(idErro, '');
    const p = payloadDe(tipo);
    const falta = faltaPreencher(tipo, p);
    if (falta) return mostrarErro(idErro, falta);
    if (!p.produced_at) return mostrarErro(idErro, 'Informe a data.');

    const enviar = async (permitirNegativo) => confirmarLoteProducaoNoSupabase({ ...p, client_request_id: estado.req[tipo], allow_negative: permitirNegativo });
    botao.disabled = true;
    botao.textContent = 'Registrando…';
    let resultado;
    try {
      try {
        resultado = await enviar(false);
      } catch (erro) {
        if (erro.dica !== 'larica:insufficient_stock') throw erro;
        if (!confirm(`${erro.message}\n\nRegistrar a produção mesmo assim?`)) {
          throw new Error('Produção não registrada: estoque insuficiente. Registre a compra da matéria-prima ou confirme o estoque negativo.');
        }
        resultado = await enviar(true);
      }
    } catch (erro) {
      mostrarErro(idErro, erro.message);
      botao.disabled = false;
      botao.textContent = 'Registrar produção';
      return;
    }
    botao.disabled = false;
    botao.textContent = 'Registrar produção';
    estado.req[tipo] = novoId();
    const plano = resultado.plan;
    mostrarToast(resultado.duplicate ? 'Esta produção já estava registrada.'
      : tipo === 'skewer' ? `${plano.units_produced} espeto(s) de ${plano.product_name} no estoque.` : `${plano.units_produced} porção(ões) de ${plano.product_name} no estoque.`, 'sucesso');
    if (tipo === 'skewer') {
      $('pl-espeto-peso').value = '';
      $('pl-espeto-qtd').value = '';
    } else {
      $('pl-acomp-peso').value = '';
    }
    await recarregarDepoisDeGravar();
    agendarPrevia(tipo);
  }

  // ------------------------------------------------------------------ histórico

  function descricaoInsumo(l) {
    if (l.tipo === 'skewer') {
      const item = itemPorId(l.materiaPrimaId);
      return `${item ? esc(item.nome) : 'Matéria-prima'} · ${kg(l.pesoBrutoG)} brutos`;
    }
    const receita = receitaPorId(l.receitaId);
    return `${kg(l.pesoFinalG)} · porção ${num(l.porcaoG, 0)} g${receita ? ` · ${esc(receita.nome)}${l.vezesReceita !== 1 ? ` ×${num(l.vezesReceita)}` : ''}` : ''}`;
  }

  function rotuloCusto(l) {
    if (l.statusCusto === 'missing') return '<span class="pl-sem-dados">sem dados</span>';
    return euro(l.custoTotal) + (l.statusCusto === 'partial' ? ' <small>(parcial)</small>' : '');
  }

  function renderizarHistorico() {
    const tipo = $('pl-filtro-tipo').value;
    const status = $('pl-filtro-status').value;
    const de = $('pl-filtro-de').value;
    const ate = $('pl-filtro-ate').value;
    const lista = estado.lotes.filter((l) => (!tipo || l.tipo === tipo) && (!status || l.status === status) && (!de || l.produzidoEm >= de) && (!ate || l.produzidoEm <= ate));
    $('pl-historico-carregando').style.display = 'none';
    $('pl-historico-vazio').style.display = lista.length ? 'none' : 'block';
    $('pl-corpo-historico').innerHTML = lista.map((l) => {
      const produto = produtoPorId(l.produtoId);
      return `<tr class="${l.status === 'cancelled' ? 'pl-cancelada' : ''}">
        <td>${dataBr(l.produzidoEm)}</td>
        <td>${l.tipo === 'skewer' ? '🍢' : '🥗'} ${esc(produto ? produto.nome : '—')}</td>
        <td>${l.unidades} ${l.tipo === 'skewer' ? 'espeto(s)' : 'porção(ões)'}</td>
        <td>${descricaoInsumo(l)}</td>
        <td>${rotuloCusto(l)}</td>
        <td>${l.statusCusto === 'missing' ? '—' : euro(l.custoUnitario)}</td>
        <td>${l.status === 'cancelled' ? '<span class="pl-status pl-status-cancelada">Cancelada</span>' : '<span class="pl-status pl-status-ok">Confirmada</span>'}${l.estoqueNegativoAutorizado ? ' <span title="Registrada com estoque insuficiente autorizado">⚠</span>' : ''}</td>
        <td><button type="button" class="btn btn-secundario pl-btn-pequeno" data-pl-detalhe="${l.id}">Ver</button></td>
      </tr>`;
    }).join('');
    $('pl-corpo-historico').querySelectorAll('[data-pl-detalhe]').forEach((b) => b.addEventListener('click', () => abrirDetalhe(b.dataset.plDetalhe)));
  }

  function renderizarUltimas() {
    [['skewer', 'pl-espeto-ultimas'], ['side', 'pl-acomp-ultimas']].forEach(([tipo, id]) => {
      const lista = estado.lotes.filter((l) => l.tipo === tipo).slice(0, 5);
      $(id).innerHTML = lista.length ? lista.map((l) => {
        const produto = produtoPorId(l.produtoId);
        return `<button type="button" class="pl-ultima ${l.status === 'cancelled' ? 'pl-cancelada' : ''}" data-pl-detalhe="${l.id}">
          <strong>${esc(produto ? produto.nome : '—')}</strong>
          <span>${dataBr(l.produzidoEm)} · ${l.unidades} ${tipo === 'skewer' ? 'espetos' : 'porções'}${l.statusCusto === 'missing' ? '' : ` · ${euro(l.custoUnitario)}/un`}${l.status === 'cancelled' ? ' · cancelada' : ''}</span>
        </button>`;
      }).join('') : '<p class="dica-campo">Nenhuma produção ainda.</p>';
      $(id).querySelectorAll('[data-pl-detalhe]').forEach((b) => b.addEventListener('click', () => abrirDetalhe(b.dataset.plDetalhe)));
    });
  }

  async function abrirDetalhe(id) {
    const l = estado.lotes.find((x) => x.id === id);
    if (!l) return;
    estado.loteDetalheId = id;
    const produto = produtoPorId(l.produtoId);
    $('pl-detalhe-titulo').textContent = `${l.tipo === 'skewer' ? 'Espetos' : 'Acompanhamento'} — ${produto ? produto.nome : ''}`;
    $('pl-detalhe-cancelar').style.display = estado.admin && l.status === 'confirmed' ? '' : 'none';
    const corpo = $('pl-detalhe-corpo');
    corpo.innerHTML = `
      ${l.status === 'cancelled' ? `<p class="pl-aviso-bloco pl-aviso-erro">Cancelada — ${esc(l.motivoCancelamento || '')}. Estoque e custos foram estornados.</p>` : ''}
      ${l.estoqueNegativoAutorizado ? '<p class="pl-aviso-bloco">Registrada com estoque insuficiente, por autorização explícita.</p>' : ''}
      <dl class="pl-resumo">
        <div><dt>Data</dt><dd>${dataBr(l.produzidoEm)}</dd></div>
        <div class="pl-destaque"><dt>Produzido</dt><dd>${l.unidades} ${l.tipo === 'skewer' ? 'espeto(s)' : 'porção(ões)'}</dd></div>
        ${l.tipo === 'skewer' ? `<div><dt>Por espeto</dt><dd>${num(l.pesoBrutoG / l.unidades, 1)} g brutos</dd></div>` : `<div><dt>Peso / porção</dt><dd>${kg(l.pesoFinalG)} / ${num(l.porcaoG, 0)} g</dd></div>`}
        <div><dt>Custo total</dt><dd>${rotuloCusto(l)}</dd></div>
        <div class="pl-destaque"><dt>Custo por unidade</dt><dd>${l.statusCusto === 'missing' ? '—' : euro(l.custoUnitario)}</dd></div>
        <div><dt>Custo no produto</dt><dd>${l.custoAplicadoNoProduto ? 'Atualizado' : 'Não alterado'}</dd></div>
      </dl>
      <h3 class="producao-subtitulo">Matéria-prima e ingredientes</h3>
      <div id="pl-detalhe-insumos"><p class="dica-campo">Carregando…</p></div>`;
    abrir('pl-modal-detalhe');
    try {
      const insumos = await buscarInsumosLoteProducaoDoSupabase(id);
      if (estado.loteDetalheId !== id) return;
      $('pl-detalhe-insumos').innerHTML = insumos.length ? `<div class="tabela-producao-wrap"><table class="tabela pl-tabela-compacta">
        <thead><tr><th>Item</th><th>Qtd.</th><th>Custo unit.</th><th>Custo</th><th>Estoque</th></tr></thead>
        <tbody>${insumos.map((i) => `<tr><td>${esc(i.nome)}</td><td>${qtdBase(i.quantidade, i.unidadeBase)}</td>
          <td>${i.custoUnitario === null ? '—' : euro(i.custoUnitario * (i.unidadeBase === 'un' ? 1 : 1000)) + (i.unidadeBase === 'g' ? '/kg' : i.unidadeBase === 'ml' ? '/l' : '/un')}</td>
          <td>${i.custoTotal === null ? '—' : euro(i.custoTotal)}</td><td>${i.baixaEstoque ? 'baixado' : '<small>sem estoque controlado</small>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="dica-campo">Sem ficha técnica informada — nenhum ingrediente baixado.</p>';
    } catch (erro) {
      $('pl-detalhe-insumos').innerHTML = `<p class="dica-campo">Não foi possível carregar. ${esc(erro.message)}</p>`;
    }
  }

  async function confirmarCancelamento() {
    const motivo = $('pl-cancelar-motivo').value.trim();
    if (motivo.length < 3) return mostrarErro('pl-cancelar-erro', 'Informe o motivo do cancelamento.');
    const botao = $('pl-cancelar-confirmar');
    botao.disabled = true;
    try {
      await cancelarLoteProducaoNoSupabase(estado.loteDetalheId, motivo);
    } catch (erro) {
      botao.disabled = false;
      return mostrarErro('pl-cancelar-erro', erro.message);
    }
    botao.disabled = false;
    fechar('pl-modal-cancelar');
    mostrarToast('Produção cancelada e estoque estornado.', 'sucesso');
    await recarregarDepoisDeGravar();
    abrirDetalhe(estado.loteDetalheId);
  }

  // Ponto de acesso só para os testes automatizados (não usado pela página).
  window.__producaoLotes = { estado, atualizarPrevia, abrirDetalhe };
})();
