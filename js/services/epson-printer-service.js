/*
 * epson-printer-service.js
 * Comunicação HTTP direta com o ePOS-Print clássico da Epson
 * (/cgi-bin/epos/service.cgi) — sem ePOSDevice, sem Socket.IO. Recebe o XML
 * já pronto de js/services/epson-print-builder.js (<epos-print>...) e é o
 * ÚNICO lugar do projeto que embrulha isso no envelope SOAP; o builder nunca
 * sabe que SOAP existe.
 *
 * EpsonPrinterService.imprimir(xml) representa exatamente UMA tentativa —
 * nunca tenta de novo sozinho, nem em timeout, nem em erro de rede, porque
 * nesses dois casos não há garantia de que a impressora não recebeu/imprimiu
 * a requisição (ver classificação de código abaixo). Decidir se oferece
 * "tentar novamente" ao operador é responsabilidade de quem chama isto, não
 * deste arquivo.
 *
 * Nunca fala com Supabase, nunca chama a RPC register_order_print, nunca
 * alfera print_count/status de pedido, nunca chama window.print(). Essas
 * decisões pertencem exclusivamente a quem chamar este serviço.
 */

const EPSON_PRINTER_CONFIG = {
  hostname: '6mab5o3v6up2v5ueyws25tzr5o5njduk4dldd5rxes2y6mby45bq.omnilinkcert.epson.biz',
  porta: null, // 443 implícita (sem porta na URL) ou '8043' — ainda depende do teste físico
  deviceId: 'local_printer',
  eposTimeoutMs: 10000, // vai SOMENTE na query string ?timeout=... (lido pela própria impressora)
  requestTimeoutMs: 15000, // vai SOMENTE no AbortController (lado do navegador) — nunca o mesmo valor do eposTimeoutMs
};

const EPSON_LIMITE_CORPO_BRUTO = 4000; // caracteres — evita guardar resposta ilimitada em resposta.corpoBruto

/** Monta a URL do endpoint clássico, com devid/timeout como query string (mesma convenção do SDK oficial). */
function _epsonMontarUrl() {
  const sufixoPorta = EPSON_PRINTER_CONFIG.porta ? ':' + EPSON_PRINTER_CONFIG.porta : '';
  const devid = encodeURIComponent(EPSON_PRINTER_CONFIG.deviceId);
  const timeout = encodeURIComponent(String(EPSON_PRINTER_CONFIG.eposTimeoutMs));
  return 'https://' + EPSON_PRINTER_CONFIG.hostname + sufixoPorta + '/cgi-bin/epos/service.cgi?devid=' + devid + '&timeout=' + timeout;
}

/** Único ponto do projeto que escreve o envelope SOAP — o builder nunca faz isso. */
function _epsonMontarEnvelopeSoap(xmlEposPrint) {
  return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' + '<s:Body>' + xmlEposPrint + '</s:Body>' + '</s:Envelope>';
}

/**
 * Localiza <response> de forma robusta a namespace/prefixo — getElementsByTagNameNS('*', 'response')
 * casa pelo nome local independente de namespace/prefixo (ex.: <response>, <s:response>,
 * <response xmlns="...">); getElementsByTagName é só um fallback pra ambientes sem NS API.
 */
function _epsonLocalizarElementoResponse(doc) {
  let candidatos = null;
  if (typeof doc.getElementsByTagNameNS === 'function') {
    candidatos = doc.getElementsByTagNameNS('*', 'response');
  }
  if ((!candidatos || candidatos.length === 0) && typeof doc.getElementsByTagName === 'function') {
    candidatos = doc.getElementsByTagName('response');
  }
  return candidatos && candidatos.length > 0 ? candidatos[0] : null;
}

function _epsonExtrairAtributos(elemento) {
  const atributos = {};
  if (!elemento || !elemento.attributes) return atributos;
  for (let i = 0; i < elemento.attributes.length; i++) {
    const atributo = elemento.attributes[i];
    atributos[atributo.name] = atributo.value;
  }
  return atributos;
}

function _epsonLimitarCorpo(texto) {
  if (typeof texto !== 'string') return texto;
  return texto.length > EPSON_LIMITE_CORPO_BRUTO ? texto.slice(0, EPSON_LIMITE_CORPO_BRUTO) + '… (truncado)' : texto;
}

const EpsonPrinterService = {
  /**
   * Envia xmlEposPrint (saída de gerarComandaEposPrintXml) pro endpoint clássico ePOS-Print.
   * Representa exatamente uma tentativa — nunca reenvia sozinho.
   * @param {string} xmlEposPrint
   * @returns {Promise<{sucesso:boolean, codigo:string, mensagem:string, resposta:object, duracaoMs:number}>}
   *   Nunca rejeita/lança — qualquer falha vira um objeto de retorno com sucesso:false.
   */
  async imprimir(xmlEposPrint) {
    const inicio = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

    function finalizar(codigo, mensagem, resposta) {
      const fim = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      return {
        sucesso: codigo === 'SUCESSO',
        codigo,
        mensagem,
        resposta: resposta || { httpStatus: null, contentType: null, corpoBruto: null, xmlValido: false, epsonSuccess: null, atributosEpson: null },
        duracaoMs: Math.round(fim - inicio),
      };
    }

    try {
      if (typeof xmlEposPrint !== 'string' || xmlEposPrint.trim().indexOf('<epos-print') !== 0) {
        return finalizar('ERRO_INESPERADO', 'XML de comanda inválido ou vazio — nada foi enviado à impressora.', null);
      }

      const url = _epsonMontarUrl();
      const corpo = _epsonMontarEnvelopeSoap(xmlEposPrint);

      const controlador = new AbortController();
      const timer = setTimeout(function () {
        controlador.abort();
      }, EPSON_PRINTER_CONFIG.requestTimeoutMs);

      let resposta;
      try {
        resposta = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'If-Modified-Since': 'Thu, 01 Jun 1970 00:00:00 GMT',
            'SOAPAction': '""',
          },
          body: corpo,
          signal: controlador.signal,
        });
      } catch (erroFetch) {
        // Ambíguo de propósito: nem timeout nem erro de rede/CORS provam que a impressora
        // NÃO recebeu/imprimiu — o navegador simplesmente não sabe dizer isso. Por isso nunca
        // reenviamos automaticamente e a mensagem nunca afirma "não imprimiu".
        const mensagemAmbigua = 'Não foi possível confirmar o resultado da impressão. Verifique a impressora antes de tentar novamente.';
        if (erroFetch && erroFetch.name === 'AbortError') {
          return finalizar('TIMEOUT', mensagemAmbigua, null);
        }
        return finalizar('ERRO_REDE', mensagemAmbigua, null);
      } finally {
        clearTimeout(timer);
      }

      // HTTP interpretado ANTES de qualquer coisa relacionada ao <response> da Epson.
      const httpStatus = resposta.status;
      const contentType = resposta.headers && typeof resposta.headers.get === 'function' ? resposta.headers.get('content-type') : null;

      let corpoBrutoCompleto;
      try {
        corpoBrutoCompleto = await resposta.text();
      } catch (erroLeitura) {
        return finalizar('ERRO_INESPERADO', 'Não foi possível ler a resposta da impressora.', {
          httpStatus,
          contentType,
          corpoBruto: null,
          xmlValido: false,
          epsonSuccess: null,
          atributosEpson: null,
        });
      }
      const corpoBrutoLimitado = _epsonLimitarCorpo(corpoBrutoCompleto);

      if (httpStatus !== 200) {
        return finalizar('HTTP_ERRO', 'A impressora respondeu com um erro HTTP (' + httpStatus + ').', {
          httpStatus,
          contentType,
          corpoBruto: corpoBrutoLimitado,
          xmlValido: false,
          epsonSuccess: null,
          atributosEpson: null,
        });
      }

      let elementoResponse = null;
      let xmlValido = false;
      try {
        const doc = new DOMParser().parseFromString(corpoBrutoCompleto, 'text/xml');
        const erroParse = doc.getElementsByTagName('parsererror');
        xmlValido = erroParse.length === 0;
        if (xmlValido) {
          elementoResponse = _epsonLocalizarElementoResponse(doc);
        }
      } catch (erroParseCatch) {
        xmlValido = false;
      }

      if (!xmlValido || elementoResponse === null) {
        return finalizar('XML_INVALIDO', 'A impressora respondeu, mas o conteúdo não pôde ser interpretado.', {
          httpStatus,
          contentType,
          corpoBruto: corpoBrutoLimitado,
          xmlValido,
          epsonSuccess: null,
          atributosEpson: null,
        });
      }

      const atributosEpson = _epsonExtrairAtributos(elementoResponse);
      const valorSuccess = elementoResponse.getAttribute('success');
      const epsonSuccess = /^(1|true)$/.test(valorSuccess || '');

      if (epsonSuccess) {
        return finalizar('SUCESSO', 'Impressão enviada e confirmada pela impressora.', {
          httpStatus,
          contentType,
          corpoBruto: corpoBrutoLimitado,
          xmlValido: true,
          epsonSuccess: true,
          atributosEpson,
        });
      }

      // Não inventamos significado pra atributos/códigos de erro que ainda não conhecemos —
      // eles ficam disponíveis em atributosEpson pra quem quiser investigar, sem interpretação aqui.
      return finalizar('EPSON_REJEITOU', 'A impressora recebeu a requisição, mas recusou a impressão.', {
        httpStatus,
        contentType,
        corpoBruto: corpoBrutoLimitado,
        xmlValido: true,
        epsonSuccess: false,
        atributosEpson,
      });
    } catch (erroInesperado) {
      // Rede de segurança final — nenhuma exceção deve escapar de imprimir() em hipótese nenhuma.
      return finalizar('ERRO_INESPERADO', 'Erro inesperado ao tentar imprimir: ' + (erroInesperado && erroInesperado.message ? erroInesperado.message : String(erroInesperado)), null);
    }
  },
};
