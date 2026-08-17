/*
 * relatorios-exportacao.js
 * Exportação PDF/Excel do Relatório Diário (Etapa 3) — lê exclusivamente
 * `relatorioAtual` (preenchido por js/relatorios.js) e formata pra cada
 * saída. Nenhuma consulta ao Supabase aqui, nenhuma fórmula recalculada —
 * mesma fonte de verdade da tela, garantindo que tela/PDF/Excel sempre
 * mostrem exatamente os mesmos números pra mesma data.
 *
 * Bibliotecas (carregadas via <script> em relatorios.html, versões fixadas):
 *   jsPDF 4.2.1 + jspdf-autotable 5.0.8 (window.jspdf.jsPDF, doc.autoTable)
 *   SheetJS xlsx 0.18.5 (window.XLSX)
 * Cada função de exportação confere se a biblioteca carregou antes de
 * tentar gerar algo — uma falha de CDN nunca quebra o resto da página.
 *
 * A fonte usada no PDF (Roboto, embutida em js/relatorios-fonte-pdf.js) é
 * obrigatória: as fontes padrão do jsPDF não cobrem "€" nem acentos.
 */

const FORMATO_MOEDA_XLSX = '€ #,##0.00';
const FORMATO_PERCENTUAL_XLSX = '0.00%';
const FORMATO_DATA_XLSX = 'dd/mm/yyyy';

/** dd/mm/aaaa a partir de 'yyyy-mm-dd' — só formatação de texto, mesma data já validada pelo resto da página */
function formatarDataRelatorioPtBr(yyyyMmDd) {
  const [ano, mes, dia] = yyyyMmDd.split('-');
  return `${dia}/${mes}/${ano}`;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function exportarRelatorioPdf(relatorio) {
  if (!relatorio) return; // botão já fica desabilitado sem relatório carregado — defensivo

  if (!(window.jspdf && window.jspdf.jsPDF)) {
    mostrarToast('Não foi possível carregar o recurso de exportação. Tente novamente.', 'erro');
    return;
  }

  const botao = document.getElementById('botao-exportar-pdf');
  const rotuloOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Gerando PDF...';

  try {
    const doc = construirPdfRelatorio(relatorio);
    doc.save(`larica-relatorio-${relatorio.data}.pdf`);
  } catch (erro) {
    console.error('Erro ao gerar PDF do relatório:', erro);
    mostrarToast('Não foi possível gerar o PDF. Tente novamente.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = rotuloOriginal;
  }
}

/** Quebra de página manual antes de um título de seção, se não sobrar espaço mínimo na página atual */
function garantirEspacoPdf(doc, y, alturaMinima) {
  const alturaPagina = doc.internal.pageSize.getHeight();
  if (y + alturaMinima > alturaPagina - 40) {
    doc.addPage();
    return 50;
  }
  return y;
}

function adicionarTituloSecaoPdf(doc, texto, y, margemEsquerda) {
  y = garantirEspacoPdf(doc, y, 60);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(12);
  doc.text(texto, margemEsquerda, y);
  return y + 14;
}

/** Desenha uma tabela via autoTable — sempre com a fonte Roboto (nunca a padrão do jsPDF, que não cobre €/acentos) */
function desenharTabelaPdf(doc, { startY, head, body, margemEsquerda, margemDireita }) {
  doc.autoTable({
    startY,
    head: [head],
    body,
    styles: { font: 'Roboto', fontStyle: 'normal', fontSize: 9, cellPadding: 5 },
    headStyles: { font: 'Roboto', fontStyle: 'normal', fillColor: [51, 51, 51], textColor: [255, 255, 255] },
    margin: { left: margemEsquerda, right: margemDireita },
    showHead: 'everyPage',
  });
  return doc.lastAutoTable.finalY + 16;
}

/** "Página X de Y" no rodapé de cada página — só dá pra saber Y depois de tudo desenhado */
function adicionarRodapePaginasPdf(doc, margemEsquerda) {
  const totalPaginas = doc.internal.getNumberOfPages();
  const alturaPagina = doc.internal.pageSize.getHeight();
  const largura = doc.internal.pageSize.getWidth();

  for (let i = 1; i <= totalPaginas; i++) {
    doc.setPage(i);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(8);
    doc.text(`Página ${i} de ${totalPaginas}`, largura - margemEsquerda, alturaPagina - 20, { align: 'right' });
  }
}

function construirPdfRelatorio(relatorio) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  registrarFontePdf(doc);

  const moeda = obterConfiguracoes().moeda;
  const margemEsquerda = 40;
  const margemDireita = 40;
  const r = relatorio.resumo;
  let y = 50;

  // Cabeçalho — só o nome "LARICA" (sem logo: o projeto não tem um arquivo de imagem de logo,
  // só o texto/emoji estilizado via CSS na sidebar — usar isso aqui exigiria captura de tela ou
  // recriação manual do desenho, adicionando fragilidade sem necessidade).
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(20);
  doc.text('LARICA', margemEsquerda, y);
  y += 24;
  doc.setFontSize(13);
  doc.text('Relatório Diário', margemEsquerda, y);
  y += 18;
  doc.setFontSize(10);
  doc.text(formatarDataRelatorioPtBr(relatorio.data), margemEsquerda, y);
  y += 24;

  // Resumo financeiro
  y = adicionarTituloSecaoPdf(doc, 'Resumo financeiro', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Indicador', 'Valor'],
    body: [
      ['Faturamento total', formatarMoeda(r.faturamentoTotal, moeda)],
      ['Faturamento bruto', formatarMoeda(r.faturamentoBruto, moeda)],
      ['Descontos', formatarMoeda(r.descontos, moeda)],
      ['Taxas de entrega', formatarMoeda(r.taxasEntrega, moeda)],
      ['Vendas após descontos', formatarMoeda(r.vendasAposDescontos, moeda)],
      ['Pedidos', String(r.totalPedidos)],
      ['Ticket médio', formatarMoeda(r.ticketMedio, moeda)],
      ['Cancelamentos', String(r.totalCancelamentos)],
    ],
    margemEsquerda,
    margemDireita,
  });

  // Formas de pagamento
  y = adicionarTituloSecaoPdf(doc, 'Formas de pagamento', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Forma de pagamento', 'Pedidos', 'Valor'],
    body: Object.keys(ROTULOS_FORMA_PAGAMENTO).map((chave) => {
      const dados = r.porFormaPagamento[chave];
      return [ROTULOS_FORMA_PAGAMENTO[chave], String(dados.qtd), formatarMoeda(dados.valor, moeda)];
    }),
    margemEsquerda,
    margemDireita,
  });

  // Status dos pagamentos ("Legado" só se houver pelo menos 1 pedido — mesma regra da tela)
  y = adicionarTituloSecaoPdf(doc, 'Status dos pagamentos', y, margemEsquerda);
  const chavesStatus = ORDEM_STATUS_PAGAMENTO_RELATORIO.filter((chave) => chave !== 'legado' || r.porStatusPagamento.legado.qtd > 0);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Status', 'Pedidos', 'Valor'],
    body: chavesStatus.map((chave) => {
      const dados = r.porStatusPagamento[chave];
      return [ROTULOS_STATUS_PAGAMENTO_RELATORIO[chave], String(dados.qtd), formatarMoeda(dados.valor, moeda)];
    }),
    margemEsquerda,
    margemDireita,
  });

  // Atendimento (retirada sempre com taxa de entrega €0,00)
  y = adicionarTituloSecaoPdf(doc, 'Atendimento', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Tipo', 'Pedidos', 'Valor', 'Taxas de entrega'],
    body: [
      ['Retirada', String(r.porAtendimento.retirada.qtd), formatarMoeda(r.porAtendimento.retirada.valor, moeda), formatarMoeda(0, moeda)],
      [
        'Entrega',
        String(r.porAtendimento.entrega.qtd),
        formatarMoeda(r.porAtendimento.entrega.valor, moeda),
        formatarMoeda(r.porAtendimento.entrega.taxas, moeda),
      ],
    ],
    margemEsquerda,
    margemDireita,
  });

  // Vendas por categoria
  y = adicionarTituloSecaoPdf(doc, 'Vendas por categoria', y, margemEsquerda);
  y = garantirEspacoPdf(doc, y, 20);
  doc.setFont('Roboto', 'normal');
  doc.setFontSize(8);
  doc.text('% sobre vendas de itens antes de descontos e entrega.', margemEsquerda, y);
  y += 12;
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Categoria', 'Quantidade', 'Valor vendido', '%'],
    body: relatorio.vendasPorCategoria.length
      ? relatorio.vendasPorCategoria.map((c) => [c.categoria, String(c.quantidade), formatarMoeda(c.valorVendido, moeda), `${c.percentual.toFixed(1)}%`])
      : [['Nenhuma venda neste dia.', '', '', '']],
    margemEsquerda,
    margemDireita,
  });

  // Produtos vendidos
  y = adicionarTituloSecaoPdf(doc, 'Produtos vendidos', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Produto', 'Categoria', 'Quantidade', 'Preço médio/unidade', 'Valor vendido'],
    body: relatorio.produtosVendidos.length
      ? relatorio.produtosVendidos.map((p) => [p.nome, p.categoria, String(p.quantidade), formatarMoeda(p.precoMedio, moeda), formatarMoeda(p.valorVendido, moeda)])
      : [['Nenhum produto vendido neste dia.', '', '', '', '']],
    margemEsquerda,
    margemDireita,
  });

  // Combos vendidos
  y = adicionarTituloSecaoPdf(doc, 'Combos vendidos', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Combo', 'Quantidade', 'Preço base médio', 'Acréscimos', 'Valor vendido'],
    body: relatorio.combosVendidos.length
      ? relatorio.combosVendidos.map((c) => [
          c.nome,
          String(c.quantidade),
          formatarMoeda(c.precoBaseMedio, moeda),
          formatarMoeda(c.acrescimos, moeda),
          formatarMoeda(c.valorVendido, moeda),
        ])
      : [['Nenhum combo vendido neste dia.', '', '', '', '']],
    margemEsquerda,
    margemDireita,
  });

  // Consumo dos combos — 3 sub-tabelas (Espetos/Acompanhamentos/Itens inclusos)
  y = adicionarTituloSecaoPdf(doc, 'Consumo dos combos', y, margemEsquerda);
  const temConsumo = relatorio.consumoCombos.skewer.length || relatorio.consumoCombos.side.length || relatorio.consumoCombos.included.length;
  if (!temConsumo) {
    y = garantirEspacoPdf(doc, y, 16);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.text('Nenhum componente de combo consumido neste dia.', margemEsquerda, y);
    y += 20;
  } else {
    const rotulosConsumo = { skewer: 'Espetos', side: 'Acompanhamentos', included: 'Itens inclusos' };
    ['skewer', 'side', 'included'].forEach((tipo) => {
      y = garantirEspacoPdf(doc, y, 40);
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(10);
      doc.text(rotulosConsumo[tipo], margemEsquerda, y);
      y += 10;
      const lista = relatorio.consumoCombos[tipo];
      y = desenharTabelaPdf(doc, {
        startY: y,
        head: ['Produto', 'Quantidade consumida'],
        body: lista.length ? lista.map((item) => [item.nome, String(item.consumo)]) : [['Nenhum item neste grupo.', '']],
        margemEsquerda,
        margemDireita,
      });
    });
  }

  // Acréscimos dos combos
  y = adicionarTituloSecaoPdf(doc, 'Acréscimos dos combos', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Produto', 'Quantidade com acréscimo', 'Acréscimo unitário', 'Receita adicional'],
    body: relatorio.acrescimosCombos.length
      ? relatorio.acrescimosCombos.map((a) => [
          a.nome,
          String(a.quantidadeComAcrescimo),
          formatarMoeda(a.acrescimoUnitarioMedio, moeda),
          formatarMoeda(a.receitaAdicional, moeda),
        ])
      : [['Nenhum acréscimo neste dia.', '', '', '']],
    margemEsquerda,
    margemDireita,
  });
  if (relatorio.acrescimosCombos.length) {
    const totalAcrescimos = relatorio.acrescimosCombos.reduce((s, a) => s + a.receitaAdicional, 0);
    y = garantirEspacoPdf(doc, y, 16);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    doc.text(`Total de acréscimos: ${formatarMoeda(totalAcrescimos, moeda)}`, margemEsquerda, y);
    y += 20;
  }

  // Cupons utilizados
  y = adicionarTituloSecaoPdf(doc, 'Cupons utilizados', y, margemEsquerda);
  y = desenharTabelaPdf(doc, {
    startY: y,
    head: ['Cupom', 'Pedidos', 'Desconto concedido'],
    body: relatorio.cuponsUtilizados.length
      ? relatorio.cuponsUtilizados.map((c) => [c.codigo || 'Sem cupom / Ajuste manual', String(c.pedidos), formatarMoeda(c.desconto, moeda)])
      : [['Nenhum cupom utilizado neste dia.', '', '']],
    margemEsquerda,
    margemDireita,
  });
  if (relatorio.cuponsUtilizados.length) {
    const totalCupons = relatorio.cuponsUtilizados.reduce((s, c) => s + c.desconto, 0);
    y = garantirEspacoPdf(doc, y, 16);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    doc.text(`Total de descontos: ${formatarMoeda(totalCupons, moeda)}`, margemEsquerda, y);
    y += 20;
  }

  // Cancelamentos — só aparece se houve algum no dia
  if (r.totalCancelamentos > 0) {
    y = adicionarTituloSecaoPdf(doc, 'Cancelamentos', y, margemEsquerda);
    y = garantirEspacoPdf(doc, y, 50);
    doc.setFont('Roboto', 'normal');
    doc.setFontSize(9);
    doc.text('Pedidos cancelados não integram o faturamento.', margemEsquerda, y);
    y += 14;
    doc.text(`Quantidade de cancelamentos: ${r.totalCancelamentos}`, margemEsquerda, y);
    y += 14;
    doc.text(`Valor histórico dos pedidos cancelados: ${formatarMoeda(r.valorHistoricoCancelado, moeda)}`, margemEsquerda, y);
  }

  adicionarRodapePaginasPdf(doc, margemEsquerda);

  return doc;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------

async function exportarRelatorioExcel(relatorio) {
  if (!relatorio) return;

  if (!window.XLSX) {
    mostrarToast('Não foi possível carregar o recurso de exportação. Tente novamente.', 'erro');
    return;
  }

  const botao = document.getElementById('botao-exportar-excel');
  const rotuloOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Gerando Excel...';

  try {
    const wb = construirExcelRelatorio(relatorio);
    XLSX.writeFile(wb, `larica-relatorio-${relatorio.data}.xlsx`);
  } catch (erro) {
    console.error('Erro ao gerar Excel do relatório:', erro);
    mostrarToast('Não foi possível gerar o Excel. Tente novamente.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = rotuloOriginal;
  }
}

/** Aplica um formato de célula (`.z`) num intervalo de linhas de uma coluna — linhas/coluna em índice 0 */
function formatarColunaXlsx(worksheet, coluna, linhaInicio, linhaFim, formato) {
  for (let linha = linhaInicio; linha <= linhaFim; linha++) {
    const endereco = XLSX.utils.encode_cell({ r: linha, c: coluna });
    if (worksheet[endereco]) worksheet[endereco].z = formato;
  }
}

function definirLargurasXlsx(worksheet, larguras) {
  worksheet['!cols'] = larguras.map((wch) => ({ wch }));
}

function construirExcelRelatorio(relatorio) {
  const wb = XLSX.utils.book_new();
  const r = relatorio.resumo;

  // --- Aba 1: Resumo ---
  const [ano, mes, dia] = relatorio.data.split('-').map(Number);
  const dataObjeto = new Date(Date.UTC(ano, mes - 1, dia));
  const linhasResumo = [
    ['Data do relatório', dataObjeto],
    ['Faturamento total', r.faturamentoTotal],
    ['Faturamento bruto', r.faturamentoBruto],
    ['Descontos', r.descontos],
    ['Taxas de entrega', r.taxasEntrega],
    ['Vendas após descontos', r.vendasAposDescontos],
    ['Pedidos', r.totalPedidos],
    ['Ticket médio', r.ticketMedio],
    ['Cancelamentos', r.totalCancelamentos],
  ];
  const wsResumo = XLSX.utils.aoa_to_sheet(linhasResumo);
  formatarColunaXlsx(wsResumo, 1, 0, 0, FORMATO_DATA_XLSX); // linha 0 = Data do relatório
  [1, 2, 3, 4, 5, 7].forEach((linha) => formatarColunaXlsx(wsResumo, 1, linha, linha, FORMATO_MOEDA_XLSX));
  definirLargurasXlsx(wsResumo, [26, 18]);
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

  // --- Aba 2: Pagamentos (2 tabelas empilhadas — formas de pagamento + status de pagamento) ---
  const linhasFormaPagamento = Object.keys(ROTULOS_FORMA_PAGAMENTO).map((chave) => {
    const dados = r.porFormaPagamento[chave];
    return [ROTULOS_FORMA_PAGAMENTO[chave], dados.qtd, dados.valor];
  });
  const chavesStatus = ORDEM_STATUS_PAGAMENTO_RELATORIO.filter((chave) => chave !== 'legado' || r.porStatusPagamento.legado.qtd > 0);
  const linhasStatusPagamento = chavesStatus.map((chave) => {
    const dados = r.porStatusPagamento[chave];
    return [ROTULOS_STATUS_PAGAMENTO_RELATORIO[chave], dados.qtd, dados.valor];
  });

  const linhaInicioStatus = 1 + linhasFormaPagamento.length + 1; // cabeçalho + linhas da 1ª tabela + linha em branco
  const aoaPagamentos = [
    ['Forma de pagamento', 'Pedidos', 'Valor'],
    ...linhasFormaPagamento,
    [],
    ['Status de pagamento', 'Pedidos', 'Valor'],
    ...linhasStatusPagamento,
  ];
  const wsPagamentos = XLSX.utils.aoa_to_sheet(aoaPagamentos);
  formatarColunaXlsx(wsPagamentos, 2, 1, linhasFormaPagamento.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsPagamentos, 2, linhaInicioStatus + 1, linhaInicioStatus + linhasStatusPagamento.length, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsPagamentos, [24, 10, 14]);
  XLSX.utils.book_append_sheet(wb, wsPagamentos, 'Pagamentos');

  // --- Aba 3: Atendimento ---
  const aoaAtendimento = [
    ['Tipo', 'Pedidos', 'Valor', 'Taxas de entrega'],
    ['Retirada', r.porAtendimento.retirada.qtd, r.porAtendimento.retirada.valor, 0],
    ['Entrega', r.porAtendimento.entrega.qtd, r.porAtendimento.entrega.valor, r.porAtendimento.entrega.taxas],
  ];
  const wsAtendimento = XLSX.utils.aoa_to_sheet(aoaAtendimento);
  formatarColunaXlsx(wsAtendimento, 2, 1, 2, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsAtendimento, 3, 1, 2, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsAtendimento, [12, 10, 14, 16]);
  XLSX.utils.book_append_sheet(wb, wsAtendimento, 'Atendimento');

  // --- Aba 4: Categorias ---
  const aoaCategorias = [
    ['Categoria', 'Quantidade', 'Valor vendido', 'Percentual'],
    ...relatorio.vendasPorCategoria.map((c) => [c.categoria, c.quantidade, c.valorVendido, c.percentual / 100]),
  ];
  const wsCategorias = XLSX.utils.aoa_to_sheet(aoaCategorias);
  formatarColunaXlsx(wsCategorias, 2, 1, relatorio.vendasPorCategoria.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsCategorias, 3, 1, relatorio.vendasPorCategoria.length, FORMATO_PERCENTUAL_XLSX);
  definirLargurasXlsx(wsCategorias, [20, 12, 14, 12]);
  XLSX.utils.book_append_sheet(wb, wsCategorias, 'Categorias');

  // --- Aba 5: Produtos ---
  const aoaProdutos = [
    ['Produto', 'Categoria', 'Quantidade', 'Preço médio/unidade', 'Valor vendido'],
    ...relatorio.produtosVendidos.map((p) => [p.nome, p.categoria, p.quantidade, p.precoMedio, p.valorVendido]),
  ];
  const wsProdutos = XLSX.utils.aoa_to_sheet(aoaProdutos);
  formatarColunaXlsx(wsProdutos, 3, 1, relatorio.produtosVendidos.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsProdutos, 4, 1, relatorio.produtosVendidos.length, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsProdutos, [26, 18, 12, 18, 14]);
  XLSX.utils.book_append_sheet(wb, wsProdutos, 'Produtos');

  // --- Aba 6: Combos ---
  const aoaCombos = [
    ['Combo', 'Quantidade', 'Preço base médio', 'Acréscimos', 'Valor vendido'],
    ...relatorio.combosVendidos.map((c) => [c.nome, c.quantidade, c.precoBaseMedio, c.acrescimos, c.valorVendido]),
  ];
  const wsCombos = XLSX.utils.aoa_to_sheet(aoaCombos);
  formatarColunaXlsx(wsCombos, 2, 1, relatorio.combosVendidos.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsCombos, 3, 1, relatorio.combosVendidos.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsCombos, 4, 1, relatorio.combosVendidos.length, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsCombos, [26, 12, 16, 12, 14]);
  XLSX.utils.book_append_sheet(wb, wsCombos, 'Combos');

  // --- Aba 7: Consumo Combos ---
  const rotulosConsumoXlsx = { skewer: 'Espeto', side: 'Acompanhamento', included: 'Item incluso' };
  const linhasConsumo = [];
  ['skewer', 'side', 'included'].forEach((tipo) => {
    relatorio.consumoCombos[tipo].forEach((item) => {
      linhasConsumo.push([rotulosConsumoXlsx[tipo], item.nome, item.consumo]);
    });
  });
  const wsConsumo = XLSX.utils.aoa_to_sheet([['Tipo', 'Produto', 'Quantidade consumida'], ...linhasConsumo]);
  definirLargurasXlsx(wsConsumo, [18, 26, 20]);
  XLSX.utils.book_append_sheet(wb, wsConsumo, 'Consumo Combos');

  // --- Aba 8: Acréscimos ---
  const aoaAcrescimos = [
    ['Produto', 'Quantidade com acréscimo', 'Acréscimo unitário', 'Receita adicional'],
    ...relatorio.acrescimosCombos.map((a) => [a.nome, a.quantidadeComAcrescimo, a.acrescimoUnitarioMedio, a.receitaAdicional]),
  ];
  const wsAcrescimos = XLSX.utils.aoa_to_sheet(aoaAcrescimos);
  formatarColunaXlsx(wsAcrescimos, 2, 1, relatorio.acrescimosCombos.length, FORMATO_MOEDA_XLSX);
  formatarColunaXlsx(wsAcrescimos, 3, 1, relatorio.acrescimosCombos.length, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsAcrescimos, [26, 20, 16, 16]);
  XLSX.utils.book_append_sheet(wb, wsAcrescimos, 'Acréscimos');

  // --- Aba 9: Cupons ---
  const aoaCupons = [
    ['Cupom', 'Pedidos', 'Desconto concedido'],
    ...relatorio.cuponsUtilizados.map((c) => [c.codigo || 'Sem cupom / Ajuste manual', c.pedidos, c.desconto]),
  ];
  const wsCupons = XLSX.utils.aoa_to_sheet(aoaCupons);
  formatarColunaXlsx(wsCupons, 2, 1, relatorio.cuponsUtilizados.length, FORMATO_MOEDA_XLSX);
  definirLargurasXlsx(wsCupons, [22, 10, 16]);
  XLSX.utils.book_append_sheet(wb, wsCupons, 'Cupons');

  // --- Aba 10: Cancelamentos (só se houve algum no dia) ---
  if (r.totalCancelamentos > 0) {
    const aoaCancelamentos = [
      ['Observação', 'Pedidos cancelados não integram o faturamento.'],
      ['Quantidade de cancelamentos', r.totalCancelamentos],
      ['Valor histórico dos pedidos cancelados', r.valorHistoricoCancelado],
    ];
    const wsCancelamentos = XLSX.utils.aoa_to_sheet(aoaCancelamentos);
    formatarColunaXlsx(wsCancelamentos, 1, 2, 2, FORMATO_MOEDA_XLSX);
    definirLargurasXlsx(wsCancelamentos, [34, 22]);
    XLSX.utils.book_append_sheet(wb, wsCancelamentos, 'Cancelamentos');
  }

  return wb;
}
