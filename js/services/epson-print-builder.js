/*
 * epson-print-builder.js
 * Gera o XML ePOS-Print (<epos-print>...</epos-print>) de uma comanda de
 * cozinha a partir do objeto "pedido" já produzido por
 * js/services/orders-service.js (_linhaSupabaseParaPedido). Usa o builder
 * oficial da Epson (window.epson.ePOSBuilder, exposto por
 * vendor/epson/epos-2.27.0.js — "ePOS-Print API Version 5.0.0") — nunca
 * concatena XML na mão. Todo conteúdo variável (nome, endereço, instruções)
 * passa por builder.addText(), que já escapa < > & ' " internamente
 * (escapeMarkup, dentro do próprio SDK) — isso é o que impede injeção de XML,
 * não uma checagem extra feita aqui.
 *
 * Puro: não faz fetch(), não conecta a nenhuma impressora, não depende de
 * pedidos.js/pedidos.html. Precisa que vendor/epson/epos-2.27.0.js e
 * js/utils.js (formatarData/formatarHora/formatarMoeda) já estejam
 * carregados antes deste arquivo.
 *
 * Limitação conhecida do modelo de dados (não inventada aqui, já mapeada
 * em auditorias anteriores): não existe observação livre por item nem
 * observação geral do pedido — só combo.espetos/acompanhamentos/incluidos
 * (escolhas estruturadas) e endereco.instrucoes (só entrega). Por isso este
 * builder nunca imprime uma linha "Obs:" por item — essa informação
 * simplesmente não existe no objeto de pedido hoje.
 */

const EPSON_PRINT_LARGURA_DOTS = 576; // 80mm de papel, ~72mm de área imprimível (8 dots/mm)

const ROTULOS_FORMA_PAGAMENTO_COMANDA = {
  cartao: 'CARTÃO',
  dinheiro: 'DINHEIRO',
  revolut: 'REVOLUT',
  transferencia: 'TRANSFERÊNCIA',
};

// 3 modalidades nomeadas explicitamente — nunca um "ehEntrega ? X : Y" tratando
// comer_no_local como retirada. Mesmo padrão visual (2x2/negrito/centralizado)
// já usado para RETIRADA/ENTREGA, só o texto muda.
const ROTULO_TIPO_COMANDA_EPSON = { entrega: 'ENTREGA', comer_no_local: 'COMER NO LOCAL', retirada: 'RETIRADA' };
const ROTULO_COBRAR_COMANDA_EPSON = { entrega: 'COBRAR NA ENTREGA', comer_no_local: 'COBRAR NO LOCAL', retirada: 'COBRAR NA RETIRADA' };

/**
 * Gera o XML <epos-print> completo de uma comanda de cozinha.
 * @param {object} pedido — mesmo formato retornado por orders-service.js.
 * @returns {string} XML pronto para ir dentro de <s:Body> no POST a /cgi-bin/epos/service.cgi.
 */
function gerarComandaEposPrintXml(pedido) {
  if (!pedido) {
    throw new Error('gerarComandaEposPrintXml: "pedido" é obrigatório.');
  }
  if (typeof epson === 'undefined' || typeof epson.ePOSBuilder === 'undefined') {
    throw new Error('epson.ePOSBuilder não está disponível — carregue vendor/epson/epos-2.27.0.js antes deste arquivo.');
  }

  const builder = new epson.ePOSBuilder();
  const ehEntrega = pedido.fulfilment === 'entrega';
  const itens = pedido.itens || [];
  const cliente = pedido.cliente || {};
  const endereco = pedido.endereco || {};

  // --- Cabeçalho ---
  builder.addTextAlign(builder.ALIGN_CENTER);

  builder.addTextStyle(undefined, undefined, true);
  builder.addTextSize(2, 2);
  builder.addText('LARICA\n');
  builder.addTextSize(1, 1);
  builder.addTextStyle(undefined, undefined, false);

  builder.addFeedLine(1);

  builder.addTextStyle(undefined, undefined, true);
  builder.addTextSize(2, 2);
  builder.addText('PEDIDO ' + (pedido.numero || '') + '\n');
  builder.addTextSize(1, 1);
  builder.addTextStyle(undefined, undefined, false);

  builder.addText(formatarData(pedido.criadoEm) + ' - ' + formatarHora(pedido.criadoEm) + '\n');

  builder.addTextStyle(undefined, undefined, true);
  builder.addText((ROTULO_TIPO_COMANDA_EPSON[pedido.fulfilment] || 'RETIRADA') + '\n');
  builder.addTextStyle(undefined, undefined, false);

  // Horário solicitado — só existe pra retirada com modo "horario" (retirada "asap" ou entrega não têm isso)
  const horarioSolicitado = !ehEntrega && pedido.retirada && pedido.retirada.modo === 'horario' ? pedido.retirada.horario : null;
  if (horarioSolicitado) {
    builder.addTextStyle(undefined, undefined, true);
    builder.addText('Horário: ' + horarioSolicitado + '\n');
    builder.addTextStyle(undefined, undefined, false);
  }

  // Cliente/telefone/troco — mesmos campos reais já usados no bloco de entrega
  // (cliente.nome/telefone) e no modal de detalhes do pedido (pagamentoDinheiro).
  // Cada linha só é emitida se o dado existir e for válido; troco nunca é
  // recalculado aqui — pedido.pagamentoDinheiro.troco já vem calculado/persistido.
  if (cliente.nome) {
    builder.addText('Cliente: ' + cliente.nome + '\n');
  }
  if (cliente.telefone) {
    builder.addText('Telefone: ' + cliente.telefone + '\n');
  }
  if (pedido.formaPagamento === 'dinheiro' && pedido.pagamentoDinheiro && pedido.pagamentoDinheiro.precisaTroco) {
    const valorPago = pedido.pagamentoDinheiro.valorPago;
    const troco = pedido.pagamentoDinheiro.troco;
    if (typeof valorPago === 'number' && !isNaN(valorPago)) {
      builder.addText('Troco para: ' + formatarMoeda(valorPago) + '\n');
    }
    if (typeof troco === 'number' && !isNaN(troco)) {
      builder.addText('Troco necessário: ' + formatarMoeda(troco) + '\n');
    }
  }

  builder.addFeedLine(1);
  builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_THICK);
  builder.addFeedLine(1);

  // --- Itens ---
  builder.addTextAlign(builder.ALIGN_LEFT);
  itens.forEach(function (item, indice) {
    builder.addTextStyle(undefined, undefined, true);
    builder.addTextSize(2, 2);
    builder.addText(item.quantidade + 'x ' + item.nome + '\n');
    builder.addTextSize(1, 1);
    builder.addTextStyle(undefined, undefined, false);

    // Complementos — só existem quando o item é um combo (espetos/acompanhamentos/incluidos
    // são as únicas estruturas de "complemento" que existem no modelo real hoje).
    if (item.combo) {
      (item.combo.espetos || []).forEach(function (espeto) {
        builder.addText('  ' + espeto.quantidade + 'x ' + espeto.nome + '\n');
      });
      (item.combo.acompanhamentos || []).forEach(function (acompanhamento) {
        builder.addText('  ' + acompanhamento.quantidade + 'x ' + acompanhamento.nome + '\n');
      });
      (item.combo.incluidos || []).forEach(function (nomeIncluido) {
        builder.addText('  ' + nomeIncluido + '\n');
      });
    }

    if (indice < itens.length - 1) {
      builder.addFeedLine(1);
    }
  });

  builder.addFeedLine(1);

  // --- Entrega (bloco inteiro condicional — só existe quando fulfilment === 'entrega') ---
  if (ehEntrega) {
    builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_THIN);
    builder.addFeedLine(1);

    builder.addTextStyle(undefined, undefined, true);
    builder.addText('ENTREGA\n');
    builder.addTextStyle(undefined, undefined, false);

    const nomeTelefone = [cliente.nome, cliente.telefone].filter(Boolean).join(' - ');
    if (nomeTelefone) builder.addText(nomeTelefone + '\n');

    const linhaEndereco = [endereco.linha1, endereco.linha2].filter(Boolean).join(', ');
    if (linhaEndereco) builder.addText(linhaEndereco + '\n');
    if (endereco.area) builder.addText(endereco.area + '\n');
    if (endereco.eircode) builder.addText(endereco.eircode + '\n');

    // instrucoes é o único campo de texto livre que realmente existe no modelo — só entrega.
    if (endereco.instrucoes) {
      builder.addTextStyle(undefined, undefined, true);
      builder.addText('Obs: ' + endereco.instrucoes + '\n');
      builder.addTextStyle(undefined, undefined, false);
    }

    builder.addFeedLine(1);
  }

  // --- Pagamento ---
  builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_MEDIUM);
  builder.addFeedLine(1);
  builder.addTextAlign(builder.ALIGN_CENTER);

  const rotuloPagamento = ROTULOS_FORMA_PAGAMENTO_COMANDA[pedido.formaPagamento] || String(pedido.formaPagamento || '').toUpperCase();
  builder.addText('Pagamento: ' + rotuloPagamento + '\n');

  // Pagamento pendente de confirmação manual (Revolut/Transferência) — só informação
  // impressa pra cozinha/equipe; NUNCA participa da elegibilidade do auto-print (isso é
  // decidido só por auto_print_*/created_at, ver claim_order_auto_print). Cash/Card e
  // pagamentos já confirmados (statusPagamento 'pago') nunca mostram isto.
  if ((pedido.formaPagamento === 'revolut' || pedido.formaPagamento === 'transferencia') && pedido.statusPagamento === 'pendente') {
    builder.addTextStyle(undefined, undefined, true);
    builder.addTextSize(2, 1);
    builder.addText('*** PAGAMENTO PENDENTE ***\n');
    builder.addTextSize(1, 1);
    builder.addTextStyle(undefined, undefined, false);
  }

  // "Precisa cobrar no momento" = statusPagamento 'pagar_na_entrega' (campo real, não inventado).
  if (pedido.statusPagamento === 'pagar_na_entrega') {
    builder.addTextStyle(undefined, undefined, true);
    builder.addTextSize(2, 1);
    builder.addText((ROTULO_COBRAR_COMANDA_EPSON[pedido.fulfilment] || 'COBRAR NA RETIRADA') + '\n');
    builder.addTextSize(1, 1);
    builder.addTextStyle(undefined, undefined, false);
  }

  builder.addFeedLine(1);
  builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_THICK);
  builder.addFeedLine(1);

  // --- Total + rodapé ---
  builder.addTextStyle(undefined, undefined, true);
  builder.addTextSize(2, 2);
  builder.addText('TOTAL: ' + formatarMoeda(pedido.total) + '\n');
  builder.addTextSize(1, 1);
  builder.addTextStyle(undefined, undefined, false);

  builder.addFeedLine(1);

  builder.addTextStyle(undefined, undefined, true);
  builder.addText((pedido.numero || '') + '\n');
  builder.addTextStyle(undefined, undefined, false);

  builder.addFeedLine(4);
  builder.addCut(builder.CUT_FEED);

  return builder.toString();
}
