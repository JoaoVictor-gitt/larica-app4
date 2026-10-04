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
// Colunas de texto em Font A (12 dots/caractere) com addTextSize(1, 1) — 576 / 12. Com largura 2x, metade.
const EPSON_PRINT_COLUNAS = 48;

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
 * Linha "rótulo ........ valor" com o valor alinhado à direita em `colunas` caracteres
 * (fonte monoespaçada). Se não couber numa linha, o rótulo fica sozinho e o valor desce
 * pra linha seguinte, ainda alinhado à direita — nunca corta nada.
 */
function _linhaDuasColunasComanda(esquerda, direita, colunas) {
  const largura = colunas || EPSON_PRINT_COLUNAS;
  const espacos = largura - esquerda.length - direita.length;
  if (espacos >= 1) return esquerda + ' '.repeat(espacos) + direita + '\n';
  return esquerda + '\n' + ' '.repeat(Math.max(0, largura - direita.length)) + direita + '\n';
}

/**
 * "2x Nome do produto ........ 14,00 €" — valor na 1ª linha, alinhado à direita. Se o texto não
 * couber ao lado do valor, quebra por palavras (palavra maior que a linha é partida, nunca
 * cortada) e as linhas seguintes ficam recuadas 3 espaços, sem ocupar a coluna do valor.
 * `recuo` (opcional) desloca o bloco inteiro — usado nos componentes do combo.
 */
function _linhasItemComanda(texto, valor, recuo) {
  const recuoInicial = recuo || '';
  const recuoContinuacao = recuoInicial + '   ';
  const larguraTexto = EPSON_PRINT_COLUNAS - valor.length - 1;
  const linhas = [];
  let atual = '';
  String(texto).split(/\s+/).filter(Boolean).forEach(function (palavra) {
    if (!atual) {
      atual = recuoInicial + palavra;
    } else if ((atual + ' ' + palavra).length <= larguraTexto) {
      atual += ' ' + palavra;
    } else {
      linhas.push(atual);
      atual = recuoContinuacao + palavra;
    }
    while (atual.length > larguraTexto) {
      linhas.push(atual.slice(0, larguraTexto));
      atual = recuoContinuacao + atual.slice(larguraTexto);
    }
  });
  if (atual) linhas.push(atual);
  return _linhaDuasColunasComanda(linhas[0] || '', valor) + linhas.slice(1).map(function (l) { return l + '\n'; }).join('');
}

// --- Logo do topo da comanda ---
// logo-comanda.png: versão preto-e-branco (1 bit, fundo branco, 384px = 48mm) derivada de logo.png
// pra impressora térmica. Carregada UMA vez, localmente, num canvas — gerarComandaEposPrintXml é
// síncrona, então só usa o logo se ele já estiver pronto; senão (ou se algo falhar) imprime o texto
// "LARICA" de sempre. Só a tela de Pedidos chama prepararLogoComanda() (pedido.html não baixa nada).
let _logoComanda = null;

function prepararLogoComanda(url) {
  if (_logoComanda || typeof document === 'undefined') return;
  try {
    const imagem = new Image();
    imagem.onload = function () {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = imagem.naturalWidth;
        canvas.height = imagem.naturalHeight;
        const contexto = canvas.getContext('2d');
        contexto.fillStyle = '#fff';
        contexto.fillRect(0, 0, canvas.width, canvas.height);
        contexto.drawImage(imagem, 0, 0);
        contexto.getImageData(0, 0, 1, 1); // canvas "contaminado" (ex.: file://) lança aqui -> fallback texto
        _logoComanda = { contexto: contexto, largura: canvas.width, altura: canvas.height };
      } catch (erro) {
        console.warn('[COMANDA] Logo indisponível, usando texto LARICA:', erro);
      }
    };
    imagem.onerror = function () {
      console.warn('[COMANDA] Não foi possível carregar o logo, usando texto LARICA.');
    };
    imagem.src = url || 'logo-comanda.png';
  } catch (erro) {
    console.warn('[COMANDA] Logo indisponível, usando texto LARICA:', erro);
  }
}

function logoComandaDisponivel() {
  return !!_logoComanda;
}

/** 5 -> "5%", 7.5 -> "7,5%" — só formatação do valor já gravado em orders.discount_value. */
function _percentualComanda(valor) {
  return String(valor).replace('.', ',') + '%';
}

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

  // Logo (centralizado pelo ALIGN_CENTER acima). addImage só grava no XML depois de converter a
  // imagem inteira, então se lançar nada fica pela metade e o texto "LARICA" entra no lugar.
  let logoImpresso = false;
  if (_logoComanda) {
    try {
      builder.halftone = builder.HALFTONE_THRESHOLD;
      builder.brightness = 1.0;
      builder.addImage(_logoComanda.contexto, 0, 0, _logoComanda.largura, _logoComanda.altura, builder.COLOR_1, builder.MODE_MONO);
      logoImpresso = true;
    } catch (erroLogo) {
      console.warn('[COMANDA] Falha ao adicionar o logo, usando texto LARICA:', erroLogo);
    }
  }
  if (!logoImpresso) {
    builder.addTextStyle(undefined, undefined, true);
    builder.addTextSize(2, 2);
    builder.addText('LARICA\n');
    builder.addTextSize(1, 1);
    builder.addTextStyle(undefined, undefined, false);
  }

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
    // Largura 1x/altura 2x: mesma altura de antes (leitura na cozinha), metade da largura — as
    // 48 colunas continuam valendo. Preço = item.valorTotal (order_items.total_price, já com
    // extras), nunca recalculado, alinhado à direita na mesma linha do nome.
    builder.addTextStyle(undefined, undefined, true);
    builder.addTextSize(1, 2);
    builder.addText(_linhasItemComanda(item.quantidade + 'x ' + item.nome, formatarMoeda(item.valorTotal)));
    builder.addTextSize(1, 1);
    builder.addTextStyle(undefined, undefined, false);

    // Complementos — só existem quando o item é um combo (espetos/acompanhamentos/incluidos
    // são as únicas estruturas de "complemento" que existem no modelo real hoje). Sem preço:
    // já estão no total do combo. Espeto ou acompanhamento com acréscimo pago mostra o acréscimo
    // (só informativo, já incluso em item.valorTotal) a partir de acrescimoUnitario =
    // order_item_selections.extra_price gravado no pedido — mesma conta do banco:
    // extra × qtd da seleção × qtd do combo.
    if (item.combo) {
      const imprimirComponente = function (componente) {
        if (componente.acrescimoUnitario > 0) {
          const acrescimo = componente.acrescimoUnitario * componente.quantidade * item.quantidade;
          builder.addText(_linhasItemComanda(componente.quantidade + 'x ' + componente.nome + ' (extra)', '+' + formatarMoeda(acrescimo), '   '));
        } else {
          builder.addText('   ' + componente.quantidade + 'x ' + componente.nome + '\n');
        }
      };
      (item.combo.espetos || []).forEach(imprimirComponente);
      (item.combo.acompanhamentos || []).forEach(imprimirComponente);
      (item.combo.incluidos || []).forEach(function (nomeIncluido) {
        builder.addText('   ' + nomeIncluido + '\n');
      });
    }

    if (indice < itens.length - 1) {
      builder.addFeedLine(1);
    }
  });

  builder.addFeedLine(1);

  // --- Resumo financeiro ---
  // Só valores já gravados em orders (subtotal/delivery_fee/original_delivery_fee/coupon_code/
  // discount_*/total) — nada recalculado, então a comanda sempre bate com o valor cobrado.
  builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_THIN);
  builder.addFeedLine(1);

  builder.addText(_linhaDuasColunasComanda('SUBTOTAL:', formatarMoeda(pedido.subtotal)));

  // Taxa só existe em entrega — retirada/comer no local não imprimem linha de entrega.
  if (ehEntrega) {
    const rotuloEntrega = pedido.taxaEntregaOriginal != null
      ? 'ENTREGA GRÁTIS (era ' + formatarMoeda(pedido.taxaEntregaOriginal) + '):'
      : 'ENTREGA:';
    builder.addText(_linhaDuasColunasComanda(rotuloEntrega, formatarMoeda(pedido.taxaEntrega)));
  }

  if (pedido.codigoCupom) {
    builder.addFeedLine(1);
    builder.addText('CUPOM: ' + pedido.codigoCupom + '\n');
  }
  if (pedido.valorDesconto > 0) {
    const rotuloDesconto = pedido.tipoDesconto === 'percentage' && pedido.valorDescontoCupom != null
      ? 'DESCONTO (' + _percentualComanda(pedido.valorDescontoCupom) + '):'
      : 'DESCONTO:';
    builder.addText(_linhaDuasColunasComanda(rotuloDesconto, '-' + formatarMoeda(pedido.valorDesconto)));
  }

  builder.addHLine(0, EPSON_PRINT_LARGURA_DOTS - 1, builder.LINE_THIN);
  builder.addFeedLine(1);

  // TOTAL continua em destaque (2x2 = 24 colunas por linha).
  builder.addTextStyle(undefined, undefined, true);
  builder.addTextSize(2, 2);
  builder.addText(_linhaDuasColunasComanda('TOTAL:', formatarMoeda(pedido.total), EPSON_PRINT_COLUNAS / 2));
  builder.addTextSize(1, 1);
  builder.addTextStyle(undefined, undefined, false);

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

  // --- Rodapé (TOTAL agora fica no resumo financeiro, logo após os itens) ---
  builder.addTextStyle(undefined, undefined, true);
  builder.addText((pedido.numero || '') + '\n');
  builder.addTextStyle(undefined, undefined, false);

  builder.addFeedLine(4);
  builder.addCut(builder.CUT_FEED);

  return builder.toString();
}
