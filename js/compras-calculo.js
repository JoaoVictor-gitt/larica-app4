/*
 * compras-calculo.js — cálculos puros da tela de Compras (sem DOM, sem rede).
 *
 * Espelha EXATAMENTE as regras de confirm_purchase (migration 20261123110000)
 * para a prévia mostrar o mesmo valor que o banco vai gravar:
 *   bruto = valor da linha (ou quantidade × preço unitário), 4 casas
 *   desconto geral rateado pelo valor de cada linha após o desconto da linha
 *     (4 casas; a última linha com valor recebe a sobra -> soma exata)
 *   líquido = bruto − desconto da linha − rateio
 *   VAT = arredonda(líquido × taxa, 2)
 *   custo = líquido (+ VAT quando NÃO recuperável)
 *   total calculado = arred(Σ líquido, 2) + arred(Σ VAT, 2)
 * O banco continua sendo quem decide; isto é só prévia.
 */

const TAXAS_VAT_COMPRA = [23, 13.5, 9, 0];
const UNIDADES_LINHA_COMPRA = ['kg', 'g', 'l', 'ml', 'un'];
const UNIDADES_COMPATIVEIS_POR_BASE = { g: ['kg', 'g'], ml: ['l', 'ml'], un: ['un'] };
const DIFERENCA_MAXIMA_TOTAL_PAGO = 1.0;

function arred(valor, casas) {
  const f = Math.pow(10, casas);
  return Math.round((Number(valor) + Number.EPSILON) * f) / f;
}

function numeroOuNullCompra(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Mesma normalização de public.normalize_purchase_text. */
function normalizarTextoCompra(texto) {
  const t = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return t || null;
}

/** Valor bruto da linha: valor informado ou quantidade × preço. null quando não dá para calcular. */
function brutoDaLinhaCompra(linha) {
  const informado = numeroOuNullCompra(linha.valorBruto);
  if (informado !== null) return arred(informado, 4);
  const q = numeroOuNullCompra(linha.quantidade);
  const p = numeroOuNullCompra(linha.precoUnitario);
  if (q === null || p === null) return null;
  return arred(q * p, 4);
}

/**
 * Calcula todas as linhas e os totais.
 * linhas: [{ quantidade, precoUnitario, valorBruto, desconto, taxaVat }]
 */
function calcularCompra(linhas, descontoGeral, vatRecuperavel, totalPagoInformado) {
  const hd = arred(numeroOuNullCompra(descontoGeral) || 0, 2);
  const pre = linhas.map((l) => {
    const bruto = brutoDaLinhaCompra(l);
    const desc = arred(numeroOuNullCompra(l.desconto) || 0, 4);
    return { bruto, desc, pre: bruto === null ? 0 : bruto - desc };
  });
  const somaPre = pre.reduce((s, x) => s + x.pre, 0);
  let ultimo = -1;
  pre.forEach((x, i) => { if (x.pre > 0) ultimo = i; });

  let alocado = 0;
  const resultado = pre.map((x, i) => {
    let rateio = 0;
    if (hd > 0 && x.pre > 0 && somaPre > 0) {
      rateio = i === ultimo ? arred(hd - alocado, 4) : arred((hd * x.pre) / somaPre, 4);
      alocado = arred(alocado + rateio, 4);
    }
    const liquido = arred(x.pre - rateio, 4);
    const taxa = numeroOuNullCompra(linhas[i].taxaVat);
    const vat = taxa === null ? 0 : arred((liquido * taxa) / 100, 2);
    const custo = arred(liquido + (vatRecuperavel ? 0 : vat), 4);
    return { bruto: x.bruto, desconto: x.desc, rateio, liquido, vat, custo, total: arred(liquido + vat, 4) };
  });

  const totalBruto = arred(resultado.reduce((s, r) => s + (r.bruto || 0), 0), 2);
  const totalDescLinhas = resultado.reduce((s, r) => s + r.desconto, 0);
  const totalLiquido = arred(resultado.reduce((s, r) => s + r.liquido, 0), 2);
  const totalVat = arred(resultado.reduce((s, r) => s + r.vat, 0), 2);
  const totalCalculado = arred(totalLiquido + totalVat, 2);
  const pagoInformado = numeroOuNullCompra(totalPagoInformado);
  const totalPago = arred(pagoInformado === null ? totalCalculado : pagoInformado, 2);
  const diferenca = arred(totalPago - totalCalculado, 2);

  return {
    linhas: resultado,
    totais: {
      bruto: totalBruto,
      descontos: arred(totalDescLinhas + hd, 2),
      descontoGeral: hd,
      liquido: totalLiquido,
      vat: totalVat,
      calculado: totalCalculado,
      pago: totalPago,
      diferenca,
      descontoGeralExcede: hd > 0 && hd > arred(somaPre, 4),
      diferencaExcede: Math.abs(diferenca) > DIFERENCA_MAXIMA_TOTAL_PAGO,
    },
  };
}

/** Problemas que impedem confirmar uma linha (mensagens curtas para mostrar no card). */
function problemasDaLinhaCompra(linha, item) {
  const p = [];
  if (linha.destino === 'estoque' && !item) p.push('Associe a um item de estoque');
  if (linha.destino === 'despesa' && !linha.categoriaFinanceiraId && !(item && item.categoriaFinanceiraId)) p.push('Escolha a categoria da despesa');
  if (linha.destino === 'despesa' && !item && !normalizarTextoCompra(linha.descricao)) p.push('Descreva a despesa');
  const q = numeroOuNullCompra(linha.quantidade);
  if (q === null || q <= 0) p.push('Quantidade');
  if (!linha.unidade) p.push('Unidade');
  if (item && item.controlaEstoque && linha.unidade && !(UNIDADES_COMPATIVEIS_POR_BASE[item.unidadeBase] || []).includes(linha.unidade)) {
    p.push(`Unidade não combina com o item (${item.unidadeBase === 'g' ? 'peso' : item.unidadeBase === 'ml' ? 'volume' : 'unidade'})`);
  }
  if (brutoDaLinhaCompra(linha) === null) p.push('Preço ou valor da linha');
  const d = numeroOuNullCompra(linha.desconto) || 0;
  const b = brutoDaLinhaCompra(linha);
  if (d < 0 || (b !== null && d > b)) p.push('Desconto maior que o valor');
  if (numeroOuNullCompra(linha.taxaVat) === null || !TAXAS_VAT_COMPRA.includes(numeroOuNullCompra(linha.taxaVat))) p.push('Taxa de VAT');
  return p;
}

/**
 * Converte a leitura da IA em rascunho editável. Nunca preenche o que a IA não
 * leu: unidade/taxa ausentes ficam vazias para o usuário escolher.
 */
function rascunhoDaNotaLida(nota) {
  const avisos = Array.isArray(nota.warnings) ? [...nota.warnings] : [];
  const linhas = (nota.items || []).map((it) => {
    const taxa = TAXAS_VAT_COMPRA.includes(it.vat_rate) ? it.vat_rate : null;
    const desconto = numeroOuNullCompra(it.discount);
    let valorBruto = null;
    let observacao = null;
    if (it.line_total !== null && it.line_total !== undefined) {
      if (it.line_total_includes_vat === true) {
        if (taxa !== null) {
          valorBruto = arred(it.line_total / (1 + taxa / 100) + (desconto || 0), 2);
          observacao = 'Valor da nota incluía VAT — convertido para sem VAT. Confira.';
        } else {
          observacao = 'Valor da nota inclui VAT, mas a taxa não foi lida. Informe a taxa e o valor sem VAT.';
        }
      } else {
        valorBruto = arred(it.line_total + (desconto || 0), 4);
      }
    }
    return {
      descricao: it.description || '',
      quantidade: it.quantity,
      unidade: UNIDADES_LINHA_COMPRA.includes(it.unit) ? it.unit : '',
      precoUnitario: it.unit_price,
      valorBruto,
      desconto,
      taxaVat: taxa,
      observacaoIa: observacao,
    };
  });
  if (nota.legible === false) avisos.unshift('A IA não conseguiu ler este documento com segurança.');
  return {
    fornecedor: nota.supplier_name || '',
    referencia: nota.document_number || '',
    data: nota.document_date || '',
    descontoGeral: nota.discount_total,
    totalPago: nota.total_paid,
    totalVatNota: nota.vat_total,
    moeda: nota.currency,
    linhas,
    avisos,
  };
}

/** Custo por unidade de exibição: g -> €/kg, ml -> €/l, un -> €/un. */
function custoParaExibicaoCompra(custoPorBase, unidadeBase) {
  if (custoPorBase === null || custoPorBase === undefined || !Number.isFinite(Number(custoPorBase))) return null;
  const fator = unidadeBase === 'g' || unidadeBase === 'ml' ? 1000 : 1;
  return Number(custoPorBase) * fator;
}

function rotuloUnidadeExibicaoCompra(unidadeBase) {
  return unidadeBase === 'g' ? 'kg' : unidadeBase === 'ml' ? 'l' : 'un';
}

/** Quantidade em unidade-base -> texto amigável (g -> kg quando ≥ 1000, etc.). */
function quantidadeParaExibicaoCompra(quantidadeBase, unidadeBase) {
  const q = Number(quantidadeBase) || 0;
  if ((unidadeBase === 'g' || unidadeBase === 'ml') && Math.abs(q) >= 1000) {
    return { valor: q / 1000, unidade: unidadeBase === 'g' ? 'kg' : 'l' };
  }
  return { valor: q, unidade: unidadeBase || 'un' };
}

/** Converte quantidade da linha para a unidade-base do item (kg->g, l->ml). null se incompatível. */
function quantidadeBaseDaLinhaCompra(quantidade, unidade, unidadeBase) {
  const q = numeroOuNullCompra(quantidade);
  if (q === null) return null;
  if (unidadeBase === 'g' && unidade === 'g') return q;
  if (unidadeBase === 'g' && unidade === 'kg') return q * 1000;
  if (unidadeBase === 'ml' && unidade === 'ml') return q;
  if (unidadeBase === 'ml' && unidade === 'l') return q * 1000;
  if (unidadeBase === 'un' && unidade === 'un') return q;
  return null;
}

/** Resumo por fornecedor para comparar preços de um item: [{ fornecedor, compras, precoMedio, ultimoPreco, ultimaData }]. */
function compararFornecedoresCompra(historico) {
  const mapa = new Map();
  historico.forEach((h) => {
    const k = h.fornecedor || '—';
    const g = mapa.get(k) || { fornecedor: k, compras: 0, quantidade: 0, custo: 0, ultimoPreco: null, ultimaData: null };
    g.compras += 1;
    g.quantidade += h.quantidadeBase;
    g.custo += h.custo;
    if (!g.ultimaData || h.data > g.ultimaData) {
      g.ultimaData = h.data;
      g.ultimoPreco = h.precoExibicao;
    }
    mapa.set(k, g);
  });
  return [...mapa.values()].map((g) => ({
    fornecedor: g.fornecedor,
    compras: g.compras,
    precoMedioBase: g.quantidade > 0 ? g.custo / g.quantidade : null,
    ultimoPreco: g.ultimoPreco,
    ultimaData: g.ultimaData,
  })).sort((a, b) => (a.precoMedioBase ?? Infinity) - (b.precoMedioBase ?? Infinity));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    arred, calcularCompra, problemasDaLinhaCompra, rascunhoDaNotaLida, normalizarTextoCompra,
    custoParaExibicaoCompra, quantidadeParaExibicaoCompra, quantidadeBaseDaLinhaCompra,
    compararFornecedoresCompra, brutoDaLinhaCompra, TAXAS_VAT_COMPRA,
  };
}
