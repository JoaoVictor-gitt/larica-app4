/*
 * financeiro.js — Fase E: módulo Financeiro.
 *
 * Abas: Resumo (indicadores, DRE gerencial, fluxo de caixa, despesas por categoria),
 * Despesas e receitas (lançamentos), Contas a pagar e receber, Custos dos produtos
 * (rentabilidade, margem, alertas) e Recorrências.
 * Todos os números vêm de get_finance_report (um cálculo só, no banco). A tela deixa
 * explícito o que é estimado e o que falta (cobertura do CMV), sem inventar custo.
 * Exclusivo de admin (o banco também barra). Escopo próprio, sem nomes globais.
 */
(() => {
  const st = {
    admin: false,
    categorias: [],
    lancamentos: [],
    pendentes: [],
    recorrencias: [],
    relatorio: null,
    periodo: { chave: 'mes', de: null, ate: null },
    modal: null, // { modo: 'lancamento'|'recorrencia', id, tipo, req, documentoId }
    acao: null, // { tipo: 'pagar'|'cancelar'|'desfazer', lancamento }
  };
  const $ = (id) => document.getElementById(id);
  const esc = (t) => escaparHtml(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const euro = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—'
    : (Number(v) < 0 ? '−' : '') + '€' + Math.abs(Number(v)).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pct = (v) => (v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toLocaleString('pt-PT', { maximumFractionDigits: 1 })}%`);
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const abrir = (id) => $(id).classList.add('modal-visivel');
  const fechar = (id) => $(id).classList.remove('modal-visivel');
  const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoje = () => iso(new Date());
  const somarDias = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const dataBr = (s) => { const [a, m, d] = String(s || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${a}` : '—'; };

  const ROTULO_TIPO = { expense: 'Despesa', revenue: 'Receita', owner_contribution: 'Aporte', owner_withdrawal: 'Retirada' };
  const ROTULO_FREQ = { weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal', quarterly: 'Trimestral', yearly: 'Anual' };
  const ROTULO_FORMA = { bank_transfer: 'Transferência', direct_debit: 'Débito direto', card: 'Cartão', cash: 'Dinheiro', revolut: 'Revolut', other: 'Outro' };
  const categoriaPorId = (id) => st.categorias.find((c) => c.id === id) || null;

  // ------------------------------------------------------------------ período

  function calcularPeriodo(chave) {
    const h = hoje();
    const d = new Date(h + 'T12:00:00');
    if (chave === 'hoje') return [h, h];
    if (chave === 'ontem') { const o = somarDias(h, -1); return [o, o]; }
    if (chave === '7d') return [somarDias(h, -6), h];
    if (chave === '30d') return [somarDias(h, -29), h];
    if (chave === 'mesanterior') {
      const ini = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const fim = new Date(d.getFullYear(), d.getMonth(), 0);
      return [iso(ini), iso(fim)];
    }
    if (chave === 'personalizado') return [$('fin-de').value || h, $('fin-ate').value || h];
    return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), h];
  }

  function aplicarPeriodo(chave) {
    st.periodo.chave = chave;
    document.querySelectorAll('[data-periodo]').forEach((b) => b.classList.toggle('fin-chip-ativo', b.dataset.periodo === chave));
    $('fin-periodo-custom').style.display = chave === 'personalizado' ? '' : 'none';
    if (chave === 'personalizado' && !$('fin-de').value) {
      const [de, ate] = calcularPeriodo('mes');
      $('fin-de').value = de;
      $('fin-ate').value = ate;
    }
    const [de, ate] = calcularPeriodo(chave);
    if (de > ate) {
      $('fin-periodo-texto').textContent = 'A data inicial é depois da final.';
      return;
    }
    st.periodo.de = de;
    st.periodo.ate = ate;
    $('fin-periodo-texto').textContent = de === ate ? dataBr(de) : `${dataBr(de)} a ${dataBr(ate)}`;
    carregarPeriodo();
  }

  // ------------------------------------------------------------------ carga

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      st.admin = await usuarioEhAdminNoSupabase();
    } catch (erro) {
      return mostrarErroGeral('Não foi possível verificar o acesso. ' + erro.message);
    }
    $('fin-carregando').style.display = 'none';
    if (!st.admin) {
      $('fin-sem-acesso').style.display = '';
      return;
    }
    $('fin-conteudo').style.display = '';
    ligarEventos();
    try {
      // Lançamentos previstos das recorrências (próximos 60 dias) — idempotente no banco.
      await gerarRecorrenciasFinanceiro(somarDias(hoje(), 60));
    } catch (erro) {
      console.error('Não foi possível gerar as recorrências:', erro);
    }
    try {
      await carregarCadastros();
    } catch (erro) {
      return mostrarErroGeral('Não foi possível carregar o Financeiro. ' + erro.message);
    }
    aplicarPeriodo('mes');
  });

  function mostrarErroGeral(msg) {
    $('fin-carregando').style.display = 'none';
    $('fin-erro').textContent = msg;
    $('fin-erro').style.display = 'block';
  }

  async function carregarCadastros() {
    const [categorias, recorrencias, pendentes] = await Promise.all([buscarCategoriasFinanceiro(), buscarRecorrenciasFinanceiro(), buscarPendentesFinanceiro()]);
    st.categorias = categorias;
    st.recorrencias = recorrencias;
    st.pendentes = pendentes;
  }

  let consulta = 0;
  async function carregarPeriodo() {
    const minha = ++consulta;
    $('fin-cartoes').innerHTML = '<p class="dica-campo">Calculando…</p>';
    let rel;
    let lanc;
    try {
      [rel, lanc] = await Promise.all([relatorioFinanceiro(st.periodo.de, st.periodo.ate), buscarLancamentosFinanceiro({ de: st.periodo.de, ate: st.periodo.ate })]);
    } catch (erro) {
      if (minha !== consulta) return;
      $('fin-cartoes').innerHTML = `<p class="fin-erro">Não foi possível calcular. ${esc(erro.message)}</p>`;
      return;
    }
    if (minha !== consulta) return;
    st.relatorio = rel;
    st.lancamentos = lanc;
    renderizarTudo();
  }

  async function recarregarTudo() {
    try {
      await carregarCadastros();
    } catch (erro) {
      mostrarToast('Gravado, mas não foi possível atualizar a tela. Recarregue a página.', 'erro');
      return;
    }
    await carregarPeriodo();
  }

  function renderizarTudo() {
    renderizarResumo();
    renderizarLancamentos();
    renderizarContas();
    renderizarProdutos();
    renderizarRecorrencias();
  }

  // ------------------------------------------------------------------ resumo

  function renderizarResumo() {
    const r = st.relatorio;
    const v = r.sales;
    const c = r.cogs;
    const d = r.dre;
    const caixa = r.cash;
    const receita = Number(d.revenue);
    const cobertura = Number(c.items_revenue) > 0 ? (Number(c.revenue_calculated) + Number(c.revenue_estimated)) / Number(c.items_revenue) : null;
    const margemBruta = receita > 0 ? Number(d.gross_profit) / receita : null;
    const saldoCaixa = Number(caixa.total_in) - Number(caixa.total_out);
    const classe = (n) => (Number(n) < 0 ? 'fin-negativo' : Number(n) > 0 ? 'fin-positivo' : '');
    $('fin-cartoes').innerHTML = `
      <div class="card fin-cartao"><span>Faturamento</span><strong>${euro(receita)}</strong><small>${v.orders} pedido(s)${Number(v.cancelled_orders) ? ` · ${v.cancelled_orders} cancelado(s) fora` : ''}</small></div>
      <div class="card fin-cartao"><span>Recebido</span><strong>${euro(v.received)}</strong><small>${Number(v.receivable) ? `${euro(v.receivable)} a receber` : 'nada pendente'}</small></div>
      <div class="card fin-cartao"><span>CMV</span><strong>${euro(c.total)}</strong><small>cobertura ${pct(cobertura)}${Number(c.estimated) ? ' · parte estimada' : ''}</small></div>
      <div class="card fin-cartao"><span>Lucro bruto</span><strong class="${classe(d.gross_profit)}">${euro(d.gross_profit)}</strong><small>margem ${pct(margemBruta)}</small></div>
      <div class="card fin-cartao"><span>Despesas</span><strong>${euro(d.operating_expenses)}</strong><small>${Number(d.waste) ? `+ ${euro(d.waste)} em perdas` : 'por competência'}</small></div>
      <div class="card fin-cartao fin-cartao-destaque"><span>Resultado operacional</span><strong class="${classe(d.operating_result)}">${euro(d.operating_result)}</strong><small>resultado do período ${euro(d.net_result)}</small></div>
      <div class="card fin-cartao"><span>Caixa do período</span><strong class="${classe(saldoCaixa)}">${euro(saldoCaixa)}</strong><small>entradas − saídas</small></div>`;

    const linha = (rotulo, valor, opc = {}) => `<tr class="${opc.classe || ''}"><td>${rotulo}</td><td class="fin-num ${opc.cor ? classe(valor) : ''}">${opc.sinal || ''}${euro(valor)}</td></tr>`;
    const desp = r.expenses;
    const semClass = Number(desp.total) - Number(desp.fixed) - Number(desp.variable);
    $('fin-dre').innerHTML = [
      linha('<strong>Receita de vendas</strong>', receita, { classe: 'fin-dre-total' }),
      linha('Produtos vendidos', v.subtotal, { classe: 'fin-dre-sub' }),
      Number(v.discounts) ? linha('Descontos', -Number(v.discounts), { classe: 'fin-dre-sub' }) : '',
      Number(v.delivery_fees) ? linha('Taxas de entrega', v.delivery_fees, { classe: 'fin-dre-sub' }) : '',
      linha('(−) CMV — custo das mercadorias vendidas', -Number(c.total)),
      Number(c.estimated) ? linha(`calculado ${euro(c.calculated)} · estimado pelo custo atual`, -Number(c.estimated), { classe: 'fin-dre-sub' }) : '',
      linha('<strong>= Lucro bruto</strong>', d.gross_profit, { classe: 'fin-dre-total', cor: true }),
      Number(d.waste) ? linha('(−) Perdas e desperdícios', -Number(d.waste)) : '',
      linha('(−) Despesas operacionais', -Number(d.operating_expenses)),
      Number(desp.fixed) ? linha('fixas', -Number(desp.fixed), { classe: 'fin-dre-sub' }) : '',
      Number(desp.variable) ? linha('variáveis', -Number(desp.variable), { classe: 'fin-dre-sub' }) : '',
      semClass > 0.004 ? linha('sem classificação (inclui despesas das compras)', -semClass, { classe: 'fin-dre-sub' }) : '',
      linha('<strong>= Resultado operacional</strong>', d.operating_result, { classe: 'fin-dre-total', cor: true }),
      Number(d.other_revenue) ? linha('(+) Outras receitas', d.other_revenue) : '',
      linha('<strong>= Resultado do período</strong>', d.net_result, { classe: 'fin-dre-total fin-dre-final', cor: true }),
    ].join('');

    $('fin-caixa').innerHTML = [
      linha('<strong>Entradas</strong>', caixa.total_in, { classe: 'fin-dre-total' }),
      linha('Vendas recebidas', caixa.sales_received, { classe: 'fin-dre-sub' }),
      Number(caixa.other_received) ? linha('Outras receitas', caixa.other_received, { classe: 'fin-dre-sub' }) : '',
      Number(caixa.contributions) ? linha('Aportes dos sócios', caixa.contributions, { classe: 'fin-dre-sub' }) : '',
      linha('<strong>Saídas</strong>', -Number(caixa.total_out), { classe: 'fin-dre-total' }),
      linha('Compras', -Number(caixa.purchases_paid), { classe: 'fin-dre-sub' }),
      linha('Despesas pagas', -Number(caixa.expenses_paid), { classe: 'fin-dre-sub' }),
      Number(caixa.withdrawals) ? linha('Retiradas dos sócios', -Number(caixa.withdrawals), { classe: 'fin-dre-sub' }) : '',
      linha('<strong>= Saldo do período</strong>', saldoCaixa, { classe: 'fin-dre-total fin-dre-final', cor: true }),
    ].join('');

    const cats = desp.by_category || [];
    const maior = Math.max(1, ...cats.map((x) => Number(x.amount)));
    $('fin-despesas-categorias').innerHTML = cats.length ? cats.map((x) => `
      <div class="fin-barra-cat"><span class="fin-barra-cat-nome">${esc(x.category)}</span>
        <span class="fin-barra-cat-trilho"><span class="fin-barra-cat-valor" style="width:${Math.max(2, (Number(x.amount) / maior) * 100)}%"></span></span>
        <span class="fin-num">${euro(x.amount)}</span></div>`).join('') : '<p class="dica-campo">Nenhuma despesa no período.</p>';

    const notas = [];
    if (Number(c.revenue_unknown) > 0) {
      notas.push(`<strong>CMV incompleto:</strong> ${euro(c.revenue_unknown)} de vendas sem nenhum custo cadastrado (${esc((c.unknown_products || []).slice(0, 6).join(', '))}${(c.unknown_products || []).length > 6 ? '…' : ''}). Esses itens ficam fora do CMV — o lucro bruto real é menor. Registre compras/produção ou o custo em Produtos.`);
    }
    if (Number(c.estimated) > 0) notas.push(`<strong>Parte do CMV é estimada</strong> (${euro(c.estimated)}): vendas anteriores ao cadastro de custo usam o custo atual do produto.`);
    if (Number(v.receivable) > 0) notas.push(`${v.receivable_orders} pedido(s) com pagamento ainda não confirmado (${euro(v.receivable)}) contam no faturamento, mas não no caixa.`);
    notas.push('Compras de estoque não são despesa: entram no CMV quando o produto é vendido. VAT recuperável não entra no resultado. Aportes e retiradas só aparecem no caixa.');
    $('fin-notas').innerHTML = notas.map((n) => `<p class="fin-nota">${n}</p>`).join('');
  }

  // ------------------------------------------------------------------ lançamentos

  function situacaoLancamento(l) {
    if (l.status === 'cancelled') return '<span class="fin-badge fin-badge-cinza">Cancelado</span>';
    if (l.status === 'paid') return `<span class="fin-badge fin-badge-ok">${l.tipo === 'revenue' || l.tipo === 'owner_contribution' ? 'Recebido' : 'Pago'} ${dataBr(l.pagoEm)}</span>`;
    if (l.vencimento < hoje()) return '<span class="fin-badge fin-badge-erro">Vencido</span>';
    return '<span class="fin-badge fin-badge-alerta">Pendente</span>';
  }

  function acoesLancamento(l) {
    if (l.status === 'pending') {
      return `<button type="button" class="btn btn-primario fin-btn-pequeno" data-pagar="${l.id}">${l.tipo === 'revenue' || l.tipo === 'owner_contribution' ? 'Receber' : 'Pagar'}</button>
        <button type="button" class="btn-icone" data-editar="${l.id}" title="Editar">✏️</button>
        <button type="button" class="btn-icone" data-cancelar="${l.id}" title="Cancelar">🗑️</button>`;
    }
    if (l.status === 'paid') return `<button type="button" class="btn btn-secundario fin-btn-pequeno" data-desfazer="${l.id}">Desfazer pagamento</button>`;
    return l.motivoCancelamento ? `<small>${esc(l.motivoCancelamento)}</small>` : '';
  }

  function ligarAcoes(raiz, lista) {
    const achar = (id) => lista.find((l) => l.id === id);
    raiz.querySelectorAll('[data-pagar]').forEach((b) => b.addEventListener('click', () => abrirPagar(achar(b.dataset.pagar))));
    raiz.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => abrirModalLancamento(achar(b.dataset.editar))));
    raiz.querySelectorAll('[data-cancelar]').forEach((b) => b.addEventListener('click', () => abrirMotivo('cancelar', achar(b.dataset.cancelar))));
    raiz.querySelectorAll('[data-desfazer]').forEach((b) => b.addEventListener('click', () => abrirMotivo('desfazer', achar(b.dataset.desfazer))));
  }

  function renderizarLancamentos() {
    const tipo = $('fin-filtro-tipo').value;
    const status = $('fin-filtro-status').value;
    const busca = normalizar($('fin-filtro-busca').value);
    const lista = st.lancamentos.filter((l) => (!tipo || l.tipo === tipo)
      && (!status || (status === 'overdue' ? l.status === 'pending' && l.vencimento < hoje() : l.status === status))
      && (!busca || normalizar(l.descricao).includes(busca)));
    $('fin-vazio-lancamentos').style.display = lista.length ? 'none' : 'block';
    const corpo = $('fin-corpo-lancamentos');
    corpo.innerHTML = lista.map((l) => {
      const cat = categoriaPorId(l.categoriaId);
      const saida = l.tipo === 'expense' || l.tipo === 'owner_withdrawal';
      return `<tr class="${l.status === 'cancelled' ? 'fin-cancelado' : ''}">
        <td>${dataBr(l.competencia)}</td>
        <td><strong>${esc(l.descricao)}</strong>${l.recorrenciaId ? ' <span title="Recorrente">🔁</span>' : ''}${l.documentoId ? ' <span title="Com documento">📎</span>' : ''}<br><small>${ROTULO_TIPO[l.tipo]}${l.tipoDespesa ? ` · ${l.tipoDespesa === 'fixed' ? 'fixa' : 'variável'}` : ''}${l.natureza ? ` · ${l.natureza === 'direct' ? 'direta' : 'indireta'}` : ''}</small></td>
        <td>${esc(cat ? cat.nome : '—')}</td>
        <td class="fin-num ${saida ? 'fin-saida' : 'fin-entrada'}">${saida ? '−' : '+'}${euro(l.valor)}</td>
        <td>${dataBr(l.vencimento)}</td>
        <td>${situacaoLancamento(l)}</td>
        <td class="fin-acoes">${acoesLancamento(l)}</td>
      </tr>`;
    }).join('');
    ligarAcoes(corpo, lista);
  }

  // ------------------------------------------------------------------ contas

  function renderizarContas() {
    const a = st.relatorio.accounts;
    const h = hoje();
    $('fin-cartoes-contas').innerHTML = `
      <div class="card fin-cartao ${Number(a.payable_overdue) ? 'fin-cartao-erro' : ''}"><span>A pagar</span><strong>${euro(a.payable_total)}</strong><small>${Number(a.payable_overdue) ? `${euro(a.payable_overdue)} vencido` : 'nada vencido'}</small></div>
      <div class="card fin-cartao"><span>Vence em 7 dias</span><strong>${euro(a.payable_next7)}</strong></div>
      <div class="card fin-cartao"><span>A receber (lançamentos)</span><strong>${euro(a.receivable_total)}</strong>${Number(a.receivable_overdue) ? `<small>${euro(a.receivable_overdue)} atrasado</small>` : ''}</div>
      <div class="card fin-cartao"><span>Pedidos aguardando pagamento</span><strong>${euro(a.orders_pending_payment)}</strong><small>${a.orders_pending_count} pedido(s) — confirmar em Pedidos</small></div>`;
    const bloco = (lista, vazio) => (lista.length ? `<ul class="fin-lista-contas">${lista.map((l) => {
      const cat = categoriaPorId(l.categoriaId);
      const atraso = l.vencimento < h;
      return `<li class="${atraso ? 'fin-conta-atrasada' : ''}">
        <div><strong>${esc(l.descricao)}</strong><br><small>${esc(cat ? cat.nome : '')} · vence ${dataBr(l.vencimento)}${atraso ? ' · <b>vencido</b>' : ''}</small></div>
        <div class="fin-conta-valor">${euro(l.valor)}</div>
        <div class="fin-acoes">${acoesLancamento(l)}</div></li>`;
    }).join('')}</ul>` : `<p class="dica-campo">${vazio}</p>`);
    const pagar = st.pendentes.filter((l) => l.tipo === 'expense' || l.tipo === 'owner_withdrawal');
    const receber = st.pendentes.filter((l) => l.tipo === 'revenue' || l.tipo === 'owner_contribution');
    $('fin-lista-pagar').innerHTML = bloco(pagar, 'Nenhuma conta a pagar.');
    $('fin-lista-receber').innerHTML = bloco(receber, 'Nenhum valor a receber lançado.');
    ligarAcoes($('fin-lista-pagar'), pagar);
    ligarAcoes($('fin-lista-receber'), receber);
  }

  // ------------------------------------------------------------------ custos dos produtos

  function renderizarProdutos() {
    const filtro = $('fin-filtro-produtos').value;
    const minimo = (Number($('fin-margem-min').value) || 0) / 100;
    const limiteData = somarDias(hoje(), -45);
    const linhas = (st.relatorio.products || []).map((p) => {
      const preco = Number(p.price);
      const qtd = Number(p.qty_sold);
      const custoMedioVendas = p.cogs !== null && qtd > 0 ? Number(p.cogs) / qtd : null;
      const ehCombo = p.category === 'combos';
      const custo = p.unit_cost !== null ? Number(p.unit_cost) : ehCombo ? custoMedioVendas : null;
      const margem = custo !== null && preco > 0 ? (preco - custo) / preco : null;
      const alertas = [];
      if (custo === null) alertas.push('Sem custo');
      else if (!ehCombo && p.cost_updated_at && String(p.cost_updated_at).slice(0, 10) < limiteData) alertas.push('Custo desatualizado');
      if (margem !== null && margem < minimo) alertas.push('Margem baixa');
      if (Number(p.items_without_cost) > 0) alertas.push(`${p.items_without_cost} venda(s) sem custo`);
      return { p, preco, qtd, custo, margem, alertas, ehCombo, contribuicao: p.cogs !== null ? Number(p.revenue) - Number(p.cogs) : null };
    }).filter((x) => (filtro === 'alertas' ? x.alertas.length : filtro === 'vendidos' ? x.qtd > 0 : true));
    $('fin-corpo-produtos').innerHTML = linhas.map((x) => `<tr>
      <td><strong>${esc(x.p.name)}</strong>${x.p.active ? '' : ' <small>(inativo)</small>'}${x.p.cost_source ? `<br><small>custo via ${x.p.cost_source === 'production_batch' ? 'produção' : x.p.cost_source === 'purchase_line' ? 'compras' : esc(x.p.cost_source)}</small>` : ''}</td>
      <td class="fin-num">${euro(x.preco)}</td>
      <td class="fin-num">${x.custo === null ? '<span class="fin-sem">sem custo</span>' : euro(x.custo)}${x.ehCombo && x.custo !== null ? '<br><small>média nas vendas</small>' : ''}</td>
      <td class="fin-num ${x.margem !== null && x.margem < minimo ? 'fin-negativo' : ''}">${x.margem === null ? '—' : `${euro(x.preco - x.custo)}<br><small>${pct(x.margem)}</small>`}</td>
      <td class="fin-num">${x.qtd}</td>
      <td class="fin-num">${euro(x.p.revenue)}</td>
      <td class="fin-num">${x.p.cogs === null ? '—' : euro(x.p.cogs)}</td>
      <td class="fin-num ${x.contribuicao !== null && x.contribuicao < 0 ? 'fin-negativo' : ''}">${x.contribuicao === null ? '—' : euro(x.contribuicao)}</td>
      <td>${x.alertas.map((a) => `<span class="fin-badge ${a === 'Margem baixa' || a === 'Sem custo' ? 'fin-badge-erro' : 'fin-badge-alerta'}">${esc(a)}</span>`).join(' ')}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="estado-vazio">Nenhum produto.</td></tr>';
  }

  // ------------------------------------------------------------------ recorrências

  function proximaOcorrencia(r) {
    const h = hoje();
    const passo = { weekly: [0, 7], biweekly: [0, 14], monthly: [1, 0], quarterly: [3, 0], yearly: [12, 0] }[r.frequencia];
    const ini = new Date(r.inicio + 'T12:00:00');
    for (let n = 0; n < 1000; n++) {
      let d;
      if (passo[0]) {
        d = new Date(ini.getFullYear(), ini.getMonth() + n * passo[0], 1, 12);
        const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(ini.getDate(), ultimo));
      } else {
        d = new Date(ini);
        d.setDate(d.getDate() + n * passo[1]);
      }
      const s = iso(d);
      if (r.fim && s > r.fim) return null;
      if (s >= h) return s;
    }
    return null;
  }

  function renderizarRecorrencias() {
    $('fin-vazio-recorrencias').style.display = st.recorrencias.length ? 'none' : 'block';
    $('fin-corpo-recorrencias').innerHTML = st.recorrencias.map((r) => {
      const cat = categoriaPorId(r.categoriaId);
      const prox = r.ativa ? proximaOcorrencia(r) : null;
      return `<tr class="${r.ativa ? '' : 'fin-cancelado'}">
        <td><strong>${esc(r.descricao)}</strong><br><small>${ROTULO_TIPO[r.tipo]}</small></td>
        <td>${esc(cat ? cat.nome : '—')}</td>
        <td class="fin-num">${euro(r.valor)}</td>
        <td>${ROTULO_FREQ[r.frequencia]}${r.prazoDias ? `<br><small>vence +${r.prazoDias} dia(s)</small>` : ''}</td>
        <td>${prox ? dataBr(prox) : '—'}</td>
        <td>${r.ativa ? '<span class="fin-badge fin-badge-ok">Ativa</span>' : '<span class="fin-badge fin-badge-cinza">Pausada</span>'}</td>
        <td class="fin-acoes"><button type="button" class="btn-icone" data-editar-rec="${r.id}" title="Editar">✏️</button></td>
      </tr>`;
    }).join('');
    $('fin-corpo-recorrencias').querySelectorAll('[data-editar-rec]').forEach((b) => b.addEventListener('click', () => abrirModalRecorrencia(st.recorrencias.find((r) => r.id === b.dataset.editarRec))));
  }

  // ------------------------------------------------------------------ eventos

  function trocarAba(chave) {
    document.querySelectorAll('[data-fin-aba]').forEach((b) => b.classList.toggle('fin-aba-ativa', b.dataset.finAba === chave));
    document.querySelectorAll('[data-fin-painel]').forEach((p) => p.classList.toggle('fin-painel-ativo', p.dataset.finPainel === chave));
  }

  function ligarEventos() {
    document.querySelectorAll('[data-periodo]').forEach((b) => b.addEventListener('click', () => aplicarPeriodo(b.dataset.periodo)));
    ['fin-de', 'fin-ate'].forEach((id) => $(id).addEventListener('change', () => aplicarPeriodo('personalizado')));
    document.querySelectorAll('[data-fin-aba]').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.finAba)));
    ['fin-filtro-tipo', 'fin-filtro-status', 'fin-filtro-busca'].forEach((id) => $(id).addEventListener('input', renderizarLancamentos));
    ['fin-filtro-produtos', 'fin-margem-min'].forEach((id) => $(id).addEventListener('input', renderizarProdutos));
    $('fin-novo-lancamento').addEventListener('click', () => abrirModalLancamento(null));
    $('fin-nova-recorrencia').addEventListener('click', () => abrirModalRecorrencia(null));
    document.querySelectorAll('.fin-tipo').forEach((b) => b.addEventListener('click', () => escolherTipo(b.dataset.tipo)));
    $('fin-lanc-categoria').addEventListener('change', aoEscolherCategoria);
    $('fin-lanc-pago').addEventListener('change', atualizarVisibilidadeModal);
    $('fin-lanc-repetir').addEventListener('change', () => { st.modal.modo = $('fin-lanc-repetir').checked ? 'recorrencia' : 'lancamento'; atualizarVisibilidadeModal(); });
    $('fin-lanc-competencia').addEventListener('change', () => { if (!$('fin-lanc-vencimento').dataset.tocado) $('fin-lanc-vencimento').value = $('fin-lanc-competencia').value; });
    $('fin-lanc-vencimento').addEventListener('input', () => { $('fin-lanc-vencimento').dataset.tocado = '1'; });
    $('fin-lanc-arquivo').addEventListener('change', anexarDocumento);
    $('fin-lanc-fechar-x').addEventListener('click', () => fechar('fin-modal-lancamento'));
    $('fin-lanc-cancelar').addEventListener('click', () => fechar('fin-modal-lancamento'));
    $('fin-form-lancamento').addEventListener('submit', (e) => { e.preventDefault(); salvarModal(); });
    $('fin-pagar-fechar-x').addEventListener('click', () => fechar('fin-modal-pagar'));
    $('fin-pagar-cancelar').addEventListener('click', () => fechar('fin-modal-pagar'));
    $('fin-pagar-confirmar').addEventListener('click', confirmarPagar);
    $('fin-motivo-fechar-x').addEventListener('click', () => fechar('fin-modal-motivo'));
    $('fin-motivo-voltar').addEventListener('click', () => fechar('fin-modal-motivo'));
    $('fin-motivo-confirmar').addEventListener('click', confirmarMotivo);
  }

  // ------------------------------------------------------------------ modal lançamento / recorrência

  function opcoesCategoria(tipo, selecionada) {
    const lista = st.categorias.filter((c) => c.tipo === tipo && (c.ativa || c.id === selecionada));
    return '<option value="">— Escolha —</option>' + lista.map((c) => `<option value="${c.id}" ${c.id === selecionada ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')
      + '<option value="__nova">+ Nova categoria…</option>';
  }

  function escolherTipo(tipo) {
    st.modal.tipo = tipo;
    document.querySelectorAll('.fin-tipo').forEach((b) => b.classList.toggle('fin-tipo-ativo', b.dataset.tipo === tipo));
    $('fin-lanc-categoria').innerHTML = opcoesCategoria(tipo, null);
    atualizarVisibilidadeModal();
  }

  async function aoEscolherCategoria() {
    if ($('fin-lanc-categoria').value !== '__nova') return;
    const nome = (window.prompt('Nome da nova categoria:') || '').trim();
    if (!nome) {
      $('fin-lanc-categoria').value = '';
      return;
    }
    try {
      const nova = await salvarCategoriaFinanceiro(null, nome, st.modal.tipo, true);
      st.categorias.push(nova);
      $('fin-lanc-categoria').innerHTML = opcoesCategoria(st.modal.tipo, nova.id);
    } catch (erro) {
      $('fin-lanc-categoria').value = '';
      mostrarErroModal(erro.message);
    }
  }

  function atualizarVisibilidadeModal() {
    const m = st.modal;
    const rec = m.modo === 'recorrencia';
    $('fin-grupo-classificacao').style.display = m.tipo === 'expense' ? '' : 'none';
    $('fin-grupo-repetir').style.display = !m.id ? '' : 'none';
    $('fin-grupo-recorrencia').style.display = rec ? '' : 'none';
    $('fin-grupo-ativa').style.display = rec && m.id ? '' : 'none';
    $('fin-grupo-vencimento').style.display = rec ? 'none' : '';
    $('fin-grupo-pago').style.display = !rec && !m.id ? '' : 'none';
    $('fin-grupo-pagamento').style.display = !rec && !m.id && $('fin-lanc-pago').checked ? '' : 'none';
    $('fin-grupo-documento').style.display = rec ? 'none' : '';
    $('fin-rotulo-competencia').textContent = rec ? 'Primeira ocorrência' : 'Competência (mês/dia a que se refere)';
    $('fin-lanc-titulo').textContent = rec ? (m.id ? 'Editar recorrência' : 'Nova recorrência') : (m.id ? 'Editar lançamento' : 'Novo lançamento');
  }

  function limparModal() {
    ['fin-lanc-descricao', 'fin-lanc-valor', 'fin-lanc-obs', 'fin-rec-fim'].forEach((id) => { $(id).value = ''; });
    $('fin-lanc-tipo-despesa').value = '';
    $('fin-lanc-natureza').value = '';
    $('fin-lanc-pago').checked = false;
    $('fin-lanc-repetir').checked = false;
    $('fin-lanc-pago-em').value = hoje();
    $('fin-lanc-forma').value = '';
    $('fin-rec-frequencia').value = 'monthly';
    $('fin-rec-prazo').value = 0;
    $('fin-rec-ativa').checked = true;
    $('fin-lanc-competencia').value = hoje();
    $('fin-lanc-vencimento').value = hoje();
    delete $('fin-lanc-vencimento').dataset.tocado;
    $('fin-lanc-arquivo-nome').textContent = '';
    mostrarErroModal('');
  }

  function abrirModalLancamento(l) {
    st.modal = { modo: 'lancamento', id: l ? l.id : null, tipo: l ? l.tipo : 'expense', req: novoId(), documentoId: l ? l.documentoId : null };
    limparModal();
    escolherTipo(st.modal.tipo);
    if (l) {
      $('fin-lanc-descricao').value = l.descricao;
      $('fin-lanc-categoria').innerHTML = opcoesCategoria(l.tipo, l.categoriaId);
      $('fin-lanc-valor').value = l.valor;
      $('fin-lanc-competencia').value = l.competencia;
      $('fin-lanc-vencimento').value = l.vencimento;
      $('fin-lanc-vencimento').dataset.tocado = '1';
      $('fin-lanc-tipo-despesa').value = l.tipoDespesa || '';
      $('fin-lanc-natureza').value = l.natureza || '';
      $('fin-lanc-forma').value = l.formaPagamento || '';
      $('fin-lanc-obs').value = l.observacoes || '';
      if (l.documentoId) $('fin-lanc-arquivo-nome').textContent = 'Documento anexado';
    }
    atualizarVisibilidadeModal();
    abrir('fin-modal-lancamento');
    $('fin-lanc-descricao').focus();
  }

  function abrirModalRecorrencia(r) {
    st.modal = { modo: 'recorrencia', id: r ? r.id : null, tipo: r ? r.tipo : 'expense', req: novoId(), documentoId: null };
    limparModal();
    escolherTipo(st.modal.tipo);
    if (r) {
      $('fin-lanc-descricao').value = r.descricao;
      $('fin-lanc-categoria').innerHTML = opcoesCategoria(r.tipo, r.categoriaId);
      $('fin-lanc-valor').value = r.valor;
      $('fin-lanc-competencia').value = r.inicio;
      $('fin-rec-frequencia').value = r.frequencia;
      $('fin-rec-prazo').value = r.prazoDias;
      $('fin-rec-fim').value = r.fim || '';
      $('fin-rec-ativa').checked = r.ativa;
      $('fin-lanc-tipo-despesa').value = r.tipoDespesa || '';
      $('fin-lanc-natureza').value = r.natureza || '';
      $('fin-lanc-obs').value = r.observacoes || '';
    } else {
      $('fin-lanc-repetir').checked = true;
    }
    atualizarVisibilidadeModal();
    abrir('fin-modal-lancamento');
  }

  async function anexarDocumento(e) {
    const arquivo = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!arquivo) return;
    $('fin-lanc-arquivo-nome').textContent = 'Enviando…';
    try {
      const { documento } = await enviarDocumentoCompra(arquivo);
      st.modal.documentoId = documento.id;
      $('fin-lanc-arquivo-nome').textContent = `✓ ${arquivo.name || 'documento'}`;
    } catch (erro) {
      $('fin-lanc-arquivo-nome').textContent = '';
      mostrarErroModal('Não foi possível anexar: ' + erro.message);
    }
  }

  function mostrarErroModal(msg) {
    $('fin-lanc-erro').textContent = msg || '';
    $('fin-lanc-erro').style.display = msg ? '' : 'none';
  }

  async function salvarModal() {
    const m = st.modal;
    mostrarErroModal('');
    const descricao = $('fin-lanc-descricao').value.trim();
    const categoria = $('fin-lanc-categoria').value;
    const valor = Number(String($('fin-lanc-valor').value).replace(',', '.'));
    const competencia = $('fin-lanc-competencia').value;
    if (!descricao) return mostrarErroModal('Informe a descrição.');
    if (!categoria || categoria === '__nova') return mostrarErroModal('Escolha a categoria.');
    if (!(valor > 0)) return mostrarErroModal('Informe um valor maior que zero.');
    if (!competencia) return mostrarErroModal('Informe a data.');
    const comum = {
      kind: m.tipo,
      category_id: categoria,
      description: descricao,
      amount: Math.round(valor * 100) / 100,
      expense_type: m.tipo === 'expense' ? $('fin-lanc-tipo-despesa').value || null : null,
      cost_nature: m.tipo === 'expense' ? $('fin-lanc-natureza').value || null : null,
      notes: $('fin-lanc-obs').value.trim() || null,
    };
    const botao = $('fin-lanc-salvar');
    botao.disabled = true;
    try {
      if (m.modo === 'recorrencia') {
        await salvarRecorrenciaFinanceiro({
          ...comum, id: m.id, client_request_id: m.id ? null : m.req, frequency: $('fin-rec-frequencia').value, start_date: competencia,
          end_date: $('fin-rec-fim').value || null, due_offset_days: Number($('fin-rec-prazo').value) || 0,
          active: m.id ? $('fin-rec-ativa').checked : true,
        });
        const gerados = await gerarRecorrenciasFinanceiro(somarDias(hoje(), 60));
        mostrarToast(m.id ? 'Recorrência atualizada.' : `Recorrência criada${gerados ? ` — ${gerados} lançamento(s) previsto(s) gerado(s)` : ''}.`, 'sucesso');
      } else {
        const pago = !m.id && $('fin-lanc-pago').checked;
        const res = await salvarLancamentoFinanceiro({
          ...comum, id: m.id, client_request_id: m.req, competence_date: competencia,
          due_date: $('fin-lanc-vencimento').value || competencia,
          paid_at: pago ? $('fin-lanc-pago-em').value || hoje() : null,
          payment_method: $('fin-lanc-forma').value || null,
          document_id: m.documentoId,
        });
        mostrarToast(res.duplicado ? 'Este lançamento já estava registrado.' : 'Lançamento salvo.', 'sucesso');
      }
    } catch (erro) {
      botao.disabled = false;
      return mostrarErroModal(erro.message);
    }
    botao.disabled = false;
    fechar('fin-modal-lancamento');
    await recarregarTudo();
  }

  // ------------------------------------------------------------------ pagar / cancelar / desfazer

  function abrirPagar(l) {
    if (!l) return;
    const entrada = l.tipo === 'revenue' || l.tipo === 'owner_contribution';
    st.acao = { tipo: 'pagar', lancamento: l };
    $('fin-pagar-titulo').textContent = entrada ? 'Registrar recebimento' : 'Registrar pagamento';
    $('fin-pagar-resumo').innerHTML = `<strong>${esc(l.descricao)}</strong> — ${euro(l.valor)} (vence ${dataBr(l.vencimento)})`;
    $('fin-pagar-data').value = hoje();
    $('fin-pagar-forma').value = l.formaPagamento || '';
    $('fin-pagar-erro').style.display = 'none';
    abrir('fin-modal-pagar');
  }

  async function confirmarPagar() {
    const l = st.acao.lancamento;
    const data = $('fin-pagar-data').value;
    if (!data) {
      $('fin-pagar-erro').textContent = 'Informe a data.';
      $('fin-pagar-erro').style.display = '';
      return;
    }
    $('fin-pagar-confirmar').disabled = true;
    try {
      await pagarLancamentoFinanceiro(l.id, data, $('fin-pagar-forma').value || null);
    } catch (erro) {
      $('fin-pagar-confirmar').disabled = false;
      $('fin-pagar-erro').textContent = erro.message;
      $('fin-pagar-erro').style.display = '';
      return;
    }
    $('fin-pagar-confirmar').disabled = false;
    fechar('fin-modal-pagar');
    mostrarToast('Pagamento registrado.', 'sucesso');
    await recarregarTudo();
  }

  function abrirMotivo(tipo, l) {
    if (!l) return;
    st.acao = { tipo, lancamento: l };
    $('fin-motivo-titulo').textContent = tipo === 'cancelar' ? 'Cancelar lançamento' : 'Desfazer pagamento';
    $('fin-motivo-texto').innerHTML = tipo === 'cancelar'
      ? `<strong>${esc(l.descricao)}</strong> fica no histórico como cancelado e sai das contas e relatórios.`
      : `<strong>${esc(l.descricao)}</strong> volta a ficar pendente. O pagamento anterior fica registrado no histórico.`;
    $('fin-motivo-campo').value = '';
    $('fin-motivo-erro').style.display = 'none';
    abrir('fin-modal-motivo');
  }

  async function confirmarMotivo() {
    const motivo = $('fin-motivo-campo').value.trim();
    if (motivo.length < 3) {
      $('fin-motivo-erro').textContent = 'Informe o motivo.';
      $('fin-motivo-erro').style.display = '';
      return;
    }
    const { tipo, lancamento } = st.acao;
    $('fin-motivo-confirmar').disabled = true;
    try {
      if (tipo === 'cancelar') await cancelarLancamentoFinanceiro(lancamento.id, motivo);
      else await desfazerPagamentoFinanceiro(lancamento.id, motivo);
    } catch (erro) {
      $('fin-motivo-confirmar').disabled = false;
      $('fin-motivo-erro').textContent = erro.message;
      $('fin-motivo-erro').style.display = '';
      return;
    }
    $('fin-motivo-confirmar').disabled = false;
    fechar('fin-modal-motivo');
    mostrarToast(tipo === 'cancelar' ? 'Lançamento cancelado.' : 'Pagamento desfeito.', 'sucesso');
    await recarregarTudo();
  }

  window.__financeiro = { st, aplicarPeriodo, trocarAba };
})();
