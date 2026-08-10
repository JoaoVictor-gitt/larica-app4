/*
 * dashboard.js
 * Cartões de resumo e gráficos simples (barras verticais/horizontais
 * construídas com <div>s dimensionados via JS — sem canvas, sem libs).
 * Depende de storage.js e utils.js.
 */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await carregarProdutosCache();
  } catch (erroCarregamento) {
    console.error('Erro ao carregar produtos:', erroCarregamento);
    mostrarToast('Não foi possível carregar os produtos.', 'erro');
    return;
  }

  renderizarCartoesResumo();
  renderizarGraficoVendasSemana();
  renderizarGraficoProdutosMaisVendidos();
});

function renderizarCartoesResumo() {
  const produtos = obterProdutos();
  const vendas = obterHistorico().filter((h) => h.tipo === 'venda');
  const vendidoHoje = vendas.filter((v) => ehHoje(v.timestamp)).reduce((soma, v) => soma + v.valorTotal, 0);
  const moeda = obterConfiguracoes().moeda;

  document.getElementById('cartao-produtos-cadastrados').textContent = produtos.length;
  document.getElementById('cartao-pedidos-realizados').textContent = vendas.length;
  document.getElementById('cartao-valor-vendido-hoje').textContent = formatarMoeda(vendidoHoje, moeda);
  document.getElementById('cartao-estoque-baixo').textContent = obterProdutosEstoqueBaixo().length;
  document.getElementById('cartao-sem-estoque').textContent = obterProdutosSemEstoque().length;
  document.getElementById('cartao-valor-estoque').textContent = formatarMoeda(obterValorTotalEstoque(), moeda);
}

/** yyyy-mm-dd baseado no horário local (evita problemas de fuso ao comparar datas) */
function chaveDataLocal(data) {
  const dois = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;
}

/** Gráfico de barras verticais com o valor vendido em cada um dos últimos 7 dias */
function renderizarGraficoVendasSemana() {
  const vendas = obterHistorico().filter((h) => h.tipo === 'venda');
  const moeda = obterConfiguracoes().moeda;
  const hoje = new Date();

  const dados = [];
  for (let i = 6; i >= 0; i--) {
    const data = new Date(hoje);
    data.setDate(hoje.getDate() - i);
    const chave = chaveDataLocal(data);
    const valorDoDia = vendas
      .filter((v) => chaveDataLocal(new Date(v.timestamp)) === chave)
      .reduce((soma, v) => soma + v.valorTotal, 0);
    const dois = (n) => String(n).padStart(2, '0');
    dados.push({ rotulo: `${dois(data.getDate())}/${dois(data.getMonth() + 1)}`, valor: valorDoDia });
  }

  const maximo = Math.max(1, ...dados.map((d) => d.valor));
  const container = document.getElementById('grafico-vendas-semana');

  if (maximo <= 1 && dados.every((d) => d.valor === 0)) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda registrada nos últimos 7 dias.</div>';
    return;
  }

  container.innerHTML = dados
    .map((d) => {
      const altura = d.valor > 0 ? Math.max(4, Math.round((d.valor / maximo) * 100)) : 0;
      return `
        <div class="coluna-barra-vertical">
          <div class="barra-vertical" style="height:${altura}%;" title="${formatarMoeda(d.valor, moeda)}"></div>
          <span class="rotulo-barra-vertical">${d.rotulo}</span>
        </div>`;
    })
    .join('');
}

/** Gráfico de barras horizontais com os 5 produtos mais vendidos (por quantidade) */
function renderizarGraficoProdutosMaisVendidos() {
  const vendas = obterHistorico().filter((h) => h.tipo === 'venda');
  const quantidadesPorProduto = {};

  vendas.forEach((venda) => {
    venda.itens.forEach((item) => {
      if (!quantidadesPorProduto[item.produtoId]) {
        quantidadesPorProduto[item.produtoId] = { nome: item.nome, quantidade: 0 };
      }
      quantidadesPorProduto[item.produtoId].quantidade += item.quantidade;
    });
  });

  const top5 = Object.values(quantidadesPorProduto)
    .sort((a, b) => b.quantidade - a.quantidade)
    .slice(0, 5);

  const container = document.getElementById('grafico-produtos-mais-vendidos');

  if (top5.length === 0) {
    container.innerHTML = '<div class="estado-vazio">Nenhuma venda registrada ainda.</div>';
    return;
  }

  const maximo = Math.max(...top5.map((p) => p.quantidade));

  container.innerHTML = top5
    .map(
      (p) => `
      <div class="linha-barra-horizontal">
        <span class="rotulo-barra-horizontal" title="${escaparHtml(p.nome)}">${escaparHtml(p.nome)}</span>
        <div class="trilho-barra-horizontal">
          <div class="barra-horizontal" style="width:${Math.round((p.quantidade / maximo) * 100)}%;"></div>
        </div>
        <span class="valor-barra-horizontal">${p.quantidade}</span>
      </div>`
    )
    .join('');
}
