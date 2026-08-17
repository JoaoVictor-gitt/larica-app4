/*
 * produtos.js
 * Lógica da tela de Produtos: listagem com filtros/ordenação e modal de
 * cadastro/edição. Depende de storage.js e utils.js.
 *
 * Categoria "Combos": além dos campos normais, o formulário mostra também as
 * regras de personalização do combo (espetos/acompanhamentos permitidos,
 * itens inclusos, acréscimo por espeto), salvas dentro de `comboConfig` no
 * próprio produto. Categoria "Acompanhamentos" não tem nada de especial —
 * usa o formulário normal; ela só passa a "existir" como opção de combo
 * porque js/pedido.js busca produtos ativos dessa categoria.
 */

let fotoSelecionadaBase64 = ''; // foto atualmente escolhida no formulário (base64) ou '' se nenhuma

// Custos/Margem (Etapa 2) ----------------------------------------------------
// souAdmin decide só a edição do campo de custo no modal (visualização já é
// liberada pra qualquer staff que acesse esta página — a real barreira de
// escrita é o RLS de product_costs, isto aqui só evita uma tentativa/erro
// previsível pra quem não tem permissão). mapaCustos: product_id -> custo
// numérico ou null (nunca 0 por ausência) — carregado numa única consulta,
// nunca uma por produto (ver carregarCustosProdutos()).
let souAdmin = false;
let mapaCustos = new Map();

document.addEventListener('DOMContentLoaded', async () => {
  const carregando = document.getElementById('estado-carregando-produtos');
  const erro = document.getElementById('estado-erro-produtos');
  try {
    const [, , ehAdmin] = await Promise.all([carregarProdutosCache(), carregarCustosProdutos(), usuarioEhAdminNoSupabase()]);
    souAdmin = ehAdmin;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar produtos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar produtos. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  preencherFiltroCategorias();
  renderizarLista();
  ligarEventosFiltros();
  ligarEventosModal();
});

/** Busca os custos no Supabase (1 consulta só, product_costs) e reconstrói mapaCustos. */
async function carregarCustosProdutos() {
  const linhas = await buscarCustosProdutosDoSupabase();
  mapaCustos = new Map(linhas.map((l) => [l.product_id, l.unit_cost === null || l.unit_cost === undefined ? null : Number(l.unit_cost)]));
}

/**
 * Custo unitário cadastrado de um produto, ou null se não cadastrado.
 * Combos SEMPRE retornam null aqui, mesmo que exista uma linha em
 * product_costs por acidente (ex.: categoria trocada depois de já ter
 * custo cadastrado) — o custo real de um combo depende das escolhas do
 * cliente (espetos/acompanhamentos), nunca de um valor fixo no produto-
 * combo em si (ver item 9 do pedido). Único ponto do código que decide
 * isso, pra nunca ter um lugar mostrando "Variável" e outro usando o
 * valor da linha por engano.
 */
function custoUnitarioDoProduto(produto) {
  if (produto.categoria === 'Combos') return null;
  return mapaCustos.has(produto.id) ? mapaCustos.get(produto.id) : null;
}

/** Preenche o <select> de filtro por categoria com a lista fixa (CATEGORIAS_PADRAO, utils.js) */
function preencherFiltroCategorias() {
  const select = document.getElementById('filtro-categoria');
  select.innerHTML =
    '<option value="">Todas</option>' +
    CATEGORIAS_PADRAO.map((c) => `<option value="${escaparHtml(c)}">${escaparHtml(c)}</option>`).join('');
}

/** Lê os filtros/ordenação atuais da tela e redesenha a tabela */
function renderizarLista() {
  const termo = document.getElementById('campo-pesquisa').value.trim();
  const categoria = document.getElementById('filtro-categoria').value;
  const status = document.getElementById('filtro-status').value;
  const ordenacao = document.getElementById('campo-ordenar').value;

  let produtos = pesquisarProdutos({ termo, categoria, status });
  produtos = ordenarProdutos(produtos, ordenacao);

  const corpo = document.getElementById('corpo-tabela-produtos');
  const estadoVazio = document.getElementById('estado-vazio-produtos');

  if (produtos.length === 0) {
    corpo.innerHTML = '';
    estadoVazio.style.display = 'block';
    return;
  }
  estadoVazio.style.display = 'none';

  corpo.innerHTML = produtos.map(linhaProdutoHtml).join('');

  corpo.querySelectorAll('[data-acao="editar"]').forEach((btn) => {
    btn.addEventListener('click', () => abrirModalEdicao(btn.dataset.id));
  });
  corpo.querySelectorAll('[data-acao="excluir"]').forEach((btn) => {
    btn.addEventListener('click', () => excluirProdutoComConfirmacao(btn.dataset.id));
  });
  corpo.querySelectorAll('[data-acao="alternar-disponibilidade"]').forEach((btn) => {
    btn.addEventListener('click', () => alternarDisponibilidadeComFeedback(btn.dataset.id, btn));
  });
}

function ordenarProdutos(produtos, criterio) {
  const [campo, direcao] = (criterio || 'nome-asc').split('-');
  const copia = [...produtos];
  copia.sort((a, b) => {
    let comparacao = 0;
    if (campo === 'nome') comparacao = a.nome.localeCompare(b.nome);
    else if (campo === 'preco') comparacao = a.preco - b.preco;
    else if (campo === 'estoque') comparacao = a.quantidadeEstoque - b.quantidadeEstoque;
    return direcao === 'desc' ? -comparacao : comparacao;
  });
  return copia;
}

/** Célula "Custo" da tabela — Variável pra combo, "Não cadastrado" (nunca €0,00) se não houver custo, ou o valor formatado */
function celulaCustoHtml(produto) {
  if (produto.categoria === 'Combos') return '<span class="texto-custo-indisponivel">Variável</span>';

  const custo = custoUnitarioDoProduto(produto);
  if (custo === null) return '<span class="texto-custo-indisponivel">Não cadastrado</span>';
  return formatarMoeda(custo, obterConfiguracoes().moeda);
}

/**
 * Célula "Margem" da tabela — Variável pra combo (não calcular margem simples com o
 * custo do produto-combo, que não reflete os componentes escolhidos). Para produto
 * comum, só calcula com custo cadastrado e preço > 0 — senão "—" (nunca inventar
 * margem de 100% para custo ausente, nem dividir por zero).
 */
function celulaMargemHtml(produto) {
  if (produto.categoria === 'Combos') return '<span class="texto-custo-indisponivel">Variável</span>';

  const custo = custoUnitarioDoProduto(produto);
  if (custo === null || !(produto.preco > 0)) return '—';

  const margemPercentual = ((produto.preco - custo) / produto.preco) * 100;
  return `${margemPercentual.toFixed(1)}%`;
}

function linhaProdutoHtml(produto) {
  const foto = produto.foto
    ? `<img class="miniatura-produto" src="${produto.foto}" alt="${escaparHtml(produto.nome)}" />`
    : `<div class="miniatura-produto-vazia">🍢</div>`;

  const status = calcularStatusEstoque(produto.quantidadeEstoque);
  // Combos não têm estoque próprio (ver comboConfig) — não faz sentido mostrar o badge de estoque pra eles.
  const colunaEstoque = produto.comboConfig
    ? '—'
    : `<span class="badge badge-${status}">${produto.quantidadeEstoque}</span>`;

  let avisoCombo = '';
  if (produto.comboConfig) {
    const { indisponiveis } = separarItensInclusosCombo(produto.comboConfig.includedItems, obterProdutos());
    if (indisponiveis.length > 0) {
      avisoCombo = ` <span class="aviso-linha-produto" title="${escaparHtml(formatarAvisoItensInclusos(indisponiveis))}">⚠️</span>`;
    }
  }

  return `
    <tr>
      <td>${foto}</td>
      <td>${escaparHtml(produto.nome)}${avisoCombo}</td>
      <td>${escaparHtml(produto.categoria)}</td>
      <td>${formatarMoeda(produto.preco, obterConfiguracoes().moeda)}</td>
      <td>${celulaCustoHtml(produto)}</td>
      <td>${celulaMargemHtml(produto)}</td>
      <td>${colunaEstoque}</td>
      <td><span class="badge badge-${produto.status === 'ativo' ? 'ativo' : 'inativo'}">${produto.status === 'ativo' ? 'Ativo' : 'Inativo'}</span></td>
      <td>
        <button
          type="button"
          class="badge badge-disponibilidade-toggle badge-${produto.disponivel ? 'disponivel' : 'indisponivel'}"
          data-acao="alternar-disponibilidade"
          data-id="${produto.id}"
          title="Clique para alternar disponibilidade"
        >${produto.disponivel ? 'Disponível' : 'Indisponível'}</button>
      </td>
      <td>
        <div class="acoes-linha">
          <button class="btn-icone" data-acao="editar" data-id="${produto.id}" title="Editar">✏️</button>
          <button class="btn-icone" data-acao="excluir" data-id="${produto.id}" title="Excluir">🗑️</button>
        </div>
      </td>
    </tr>`;
}

async function excluirProdutoComConfirmacao(id) {
  const produto = obterProdutoPorId(id);
  if (!produto) return;
  const confirmado = confirm(`Excluir o produto "${produto.nome}"? Esta ação não pode ser desfeita.`);
  if (!confirmado) return;

  try {
    await removerProduto(id);
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
    return;
  }

  mostrarToast('Produto excluído.', 'sucesso');
  renderizarLista();
}

/**
 * Alterna disponibilidade de um clique só (badge = botão). Otimista: muda o
 * visual na hora e desabilita o botão pra evitar duplo clique; se a
 * gravação falhar, desfaz re-renderizando a partir do cache (que ainda tem
 * o valor antigo) em vez de deixar um estado falso na tela.
 */
async function alternarDisponibilidadeComFeedback(id, botao) {
  const produto = obterProdutoPorId(id);
  if (!produto) return;
  const novoValor = !produto.disponivel;

  botao.disabled = true;
  botao.textContent = novoValor ? 'Disponível' : 'Indisponível';
  botao.className = `badge badge-disponibilidade-toggle badge-${novoValor ? 'disponivel' : 'indisponivel'}`;

  try {
    await alternarDisponibilidade(id, novoValor);
  } catch (erro) {
    renderizarLista();
    mostrarToast('Não foi possível atualizar a disponibilidade. ' + erro.message, 'erro');
    return;
  }

  mostrarToast(
    novoValor ? `${produto.nome} voltou a ficar disponível.` : `${produto.nome} marcado como indisponível.`,
    'sucesso'
  );
  botao.disabled = false;
}

function ligarEventosFiltros() {
  document.getElementById('campo-pesquisa').addEventListener('input', debounce(renderizarLista, 250));
  document.getElementById('filtro-categoria').addEventListener('change', renderizarLista);
  document.getElementById('filtro-status').addEventListener('change', renderizarLista);
  document.getElementById('campo-ordenar').addEventListener('change', renderizarLista);
}

// ---------------------------------------------------------------------------
// Modal de cadastro/edição
// ---------------------------------------------------------------------------

function ligarEventosModal() {
  document.getElementById('botao-novo-produto').addEventListener('click', abrirModalCriacao);
  document.getElementById('botao-fechar-modal').addEventListener('click', fecharModal);
  document.getElementById('botao-cancelar-modal').addEventListener('click', fecharModal);
  document.getElementById('modal-overlay').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay') fecharModal();
  });

  document.getElementById('preview-foto').addEventListener('click', () => {
    document.getElementById('campo-foto').click();
  });
  document.getElementById('campo-foto').addEventListener('change', tratarSelecaoFoto);
  document.getElementById('botao-remover-foto').addEventListener('click', removerFotoSelecionada);

  document.getElementById('form-produto').addEventListener('submit', salvarFormularioProduto);
  ligarEventoCategoria();
}

function abrirModalCriacao() {
  document.getElementById('modal-titulo').textContent = 'Novo Produto';
  document.getElementById('form-produto').reset();
  document.getElementById('campo-id').value = '';
  document.getElementById('campo-estoque').value = 0;
  document.getElementById('campo-status').value = 'ativo';
  document.getElementById('campo-ordem').value = 0;
  document.getElementById('campo-qtd-espetos').value = 1;
  document.getElementById('campo-qtd-acompanhamentos').value = 1;
  definirFotoPreview('');
  atualizarVisibilidadeCamposPorCategoria();
  abrirModal();
}

function abrirModalEdicao(id) {
  const produto = obterProdutoPorId(id);
  if (!produto) return;

  document.getElementById('modal-titulo').textContent = 'Editar Produto';
  document.getElementById('campo-id').value = produto.id;
  document.getElementById('campo-nome').value = produto.nome;
  document.getElementById('campo-categoria').value = produto.categoria;
  document.getElementById('campo-preco').value = produto.preco;
  document.getElementById('campo-estoque').value = produto.quantidadeEstoque;
  document.getElementById('campo-descricao').value = produto.descricao || '';
  document.getElementById('campo-status').value = produto.status;
  // Custo (Etapa 2): combo nunca mostra valor aqui (ver custoUnitarioDoProduto) —
  // atualizarVisibilidadeCamposPorCategoria(), chamada mais abaixo, cuida de
  // desabilitar/limpar o campo pra combo e pra quem não é admin.
  const custoAtual = custoUnitarioDoProduto(produto);
  document.getElementById('campo-custo').value = custoAtual === null ? '' : custoAtual;
  definirFotoPreview(produto.foto || '');

  const combo = produto.comboConfig;
  document.getElementById('campo-ordem').value = combo ? combo.ordem || 0 : 0;
  document.getElementById('campo-qtd-espetos').value = combo ? combo.allowedSkewers : 1;
  document.getElementById('campo-qtd-acompanhamentos').value = combo ? combo.allowedSides : 1;

  atualizarVisibilidadeCamposPorCategoria();
  renderizarListaItensInclusos(combo ? combo.includedItems : []);
  renderizarListaAcrescimosEspetos(combo ? combo.skewerExtraPrices : {});

  abrirModal();
}

// ---------------------------------------------------------------------------
// Campos que só aparecem quando a categoria é "Combos"
// ---------------------------------------------------------------------------

/** Mostra/esconde os campos de combo reagindo à troca de categoria (select fixo) */
function ligarEventoCategoria() {
  document.getElementById('campo-categoria').addEventListener('change', () => {
    const secao = document.getElementById('secao-campos-combo');
    const estavaVisivel = secao.style.display !== 'none';
    atualizarVisibilidadeCamposPorCategoria();
    const agoraVisivel = secao.style.display !== 'none';
    // Só reseta os checklists na primeira vez que a seção aparece — evita apagar
    // marcações já feitas se o admin continuar digitando/corrigindo a categoria.
    if (agoraVisivel && !estavaVisivel) {
      renderizarListaItensInclusos([]);
      renderizarListaAcrescimosEspetos({});
    }
  });
}

function atualizarVisibilidadeCamposPorCategoria() {
  const ehCombo = document.getElementById('campo-categoria').value.trim() === 'Combos';
  document.getElementById('secao-campos-combo').style.display = ehCombo ? '' : 'none';
  document.getElementById('grupo-estoque').style.display = ehCombo ? 'none' : '';
  document.getElementById('campo-estoque').required = !ehCombo;
  document.getElementById('campo-qtd-espetos').required = ehCombo;
  document.getElementById('campo-qtd-acompanhamentos').required = ehCombo;
  atualizarEstadoCampoCusto(ehCombo);
}

/**
 * Custo unitário (Etapa 2): desabilitado + campo limpo quando é combo (custo real
 * vem dos componentes, nunca de um valor fixo aqui — item 9 do pedido); desabilitado
 * também para quem não é admin (visualização continua liberada pra staff, só a edição
 * é restrita — a barreira real é o RLS de product_costs, isto é só UX). Os dois avisos
 * são mutuamente exclusivos: combo tem prioridade sobre "somente admin" quando os dois
 * se aplicam, porque é o motivo mais específico.
 */
function atualizarEstadoCampoCusto(ehCombo) {
  const campo = document.getElementById('campo-custo');
  const dicaCombo = document.getElementById('dica-custo-combo');
  const dicaSomenteAdmin = document.getElementById('dica-custo-somente-admin');

  if (ehCombo) {
    campo.value = '';
    campo.disabled = true;
    dicaCombo.style.display = '';
    dicaSomenteAdmin.style.display = 'none';
  } else {
    campo.disabled = !souAdmin;
    dicaCombo.style.display = 'none';
    dicaSomenteAdmin.style.display = souAdmin ? 'none' : '';
  }
}

/** Monta a mensagem de aviso "Este combo possui item(ns) incluso(s) indisponível(is): ..." */
function formatarAvisoItensInclusos(indisponiveis) {
  const nomes = indisponiveis.map((i) => i.nome || 'item removido');
  return `Este combo possui item(ns) incluso(s) indisponível(is): ${nomes.join(', ')}.`;
}

/**
 * Checklist de produtos que podem ser marcados como "já inclusos" no combo
 * (produtos ativos, exceto o próprio produto e outros combos). Um item já
 * marcado que tenha ficado inativo/excluído continua aparecendo (acinzentado,
 * "indisponível") pra não sumir da configuração sem querer só por causa de
 * salvar o formulário de novo — ver separarItensInclusosCombo() em utils.js.
 */
function renderizarListaItensInclusos(idsSelecionados) {
  const idAtual = document.getElementById('campo-id').value;
  const ativos = pesquisarProdutos({ status: 'ativo' }).filter((p) => p.categoria !== 'Combos' && p.id !== idAtual);
  const marcados = new Set(idsSelecionados || []);

  const { indisponiveis } = separarItensInclusosCombo(idsSelecionados, obterProdutos());
  const indisponiveisComNome = indisponiveis.filter((i) => i.nome);
  const candidatos = ativos.concat(indisponiveisComNome.map((i) => ({ id: i.id, nome: i.nome, indisponivel: true })));

  const container = document.getElementById('lista-itens-inclusos');
  if (candidatos.length === 0) {
    container.innerHTML = '<p class="dica-campo">Nenhum produto ativo cadastrado ainda.</p>';
  } else {
    container.innerHTML = candidatos
      .map(
        (p) => `
        <label class="linha-item-incluso ${p.indisponivel ? 'linha-item-incluso-indisponivel' : ''}">
          <input type="checkbox" class="campo-item-incluso" value="${p.id}" ${marcados.has(p.id) ? 'checked' : ''} />
          <span>${escaparHtml(p.nome)}${p.indisponivel ? ' <em>(indisponível)</em>' : ''}</span>
        </label>`
      )
      .join('');
  }

  const aviso = document.getElementById('aviso-itens-inclusos');
  if (indisponiveis.length > 0) {
    aviso.textContent = formatarAvisoItensInclusos(indisponiveis);
    aviso.style.display = '';
  } else {
    aviso.style.display = 'none';
  }
}

function lerItensInclusosMarcados() {
  return Array.from(document.querySelectorAll('.campo-item-incluso:checked')).map((c) => c.value);
}

/** Checklist dos espetos ativos com um campo de acréscimo (€) cada, pré-preenchido se vier de um combo existente */
function renderizarListaAcrescimosEspetos(acrescimosExistentes) {
  const espetos = pesquisarProdutos({ categoria: 'Espetinhos', status: 'ativo' });
  const container = document.getElementById('lista-acrescimos-espetos');

  if (espetos.length === 0) {
    container.innerHTML = '<p class="dica-campo">Nenhum espeto ativo cadastrado (categoria Espetinhos) ainda.</p>';
    return;
  }

  container.innerHTML = espetos
    .map((espeto) => {
      const valorAtual = (acrescimosExistentes && acrescimosExistentes[espeto.id]) || 0;
      return `
        <div class="linha-acrescimo-espeto">
          <span>${escaparHtml(espeto.nome)}</span>
          <div class="campo-acrescimo">
            <span>+ €</span>
            <input type="number" class="input campo-acrescimo-espeto" data-produto-id="${espeto.id}" min="0" step="0.5" value="${valorAtual}" />
          </div>
        </div>`;
    })
    .join('');
}

/**
 * Lê todos os campos de acréscimo renderizados (um por espeto ativo) e monta
 * { produtoId: valor } — inclui os que ficaram em 0, já que no Supabase essa
 * lista também define quais espetos são selecionáveis nesse combo (ver
 * products-service.js).
 */
function lerAcrescimosEspetosPreenchidos() {
  const resultado = {};
  document.querySelectorAll('.campo-acrescimo-espeto').forEach((campo) => {
    resultado[campo.dataset.produtoId] = Number(campo.value) || 0;
  });
  return resultado;
}

/**
 * Lê o campo de custo distinguindo "" (não cadastrado) de "0" (custo real zero) —
 * nunca usar `Number(valor) || 0`, que transformaria os dois casos no mesmo 0.
 * Um valor que o <input type="number"> não conseguiu interpretar como número já
 * chega aqui como "" (comportamento nativo do navegador), então cai no mesmo
 * caminho de "não cadastrado" sem precisar de validação extra.
 */
function lerCustoUnitarioDoFormulario() {
  const bruto = document.getElementById('campo-custo').value;
  if (bruto === '') return null;
  const numero = Number(bruto);
  return Number.isFinite(numero) ? numero : null;
}

function abrirModal() {
  document.getElementById('modal-overlay').classList.add('modal-visivel');
}

function fecharModal() {
  document.getElementById('modal-overlay').classList.remove('modal-visivel');
}

function tratarSelecaoFoto(evento) {
  const arquivo = evento.target.files[0];
  if (!arquivo) return;

  const leitor = new FileReader();
  leitor.onload = () => definirFotoPreview(leitor.result);
  leitor.readAsDataURL(arquivo);
}

function removerFotoSelecionada() {
  definirFotoPreview('');
  document.getElementById('campo-foto').value = '';
}

function definirFotoPreview(base64) {
  fotoSelecionadaBase64 = base64 || '';
  const texto = document.getElementById('preview-foto-texto');
  const img = document.getElementById('preview-foto-img');
  const botaoRemover = document.getElementById('botao-remover-foto');

  if (fotoSelecionadaBase64) {
    img.src = fotoSelecionadaBase64;
    img.style.display = 'block';
    texto.style.display = 'none';
    botaoRemover.style.display = 'inline-flex';
  } else {
    img.style.display = 'none';
    texto.style.display = 'block';
    botaoRemover.style.display = 'none';
  }
}

async function salvarFormularioProduto(evento) {
  evento.preventDefault();

  const id = document.getElementById('campo-id').value;
  const categoria = document.getElementById('campo-categoria').value;
  const ehCombo = categoria === 'Combos';

  const produto = {
    nome: document.getElementById('campo-nome').value.trim(),
    categoria,
    preco: Number(document.getElementById('campo-preco').value) || 0,
    quantidadeEstoque: ehCombo ? 0 : Math.max(0, Number(document.getElementById('campo-estoque').value) || 0),
    descricao: document.getElementById('campo-descricao').value.trim(),
    foto: fotoSelecionadaBase64,
    status: document.getElementById('campo-status').value,
    comboConfig: ehCombo
      ? {
          ordem: Math.max(0, Number(document.getElementById('campo-ordem').value) || 0),
          allowedSkewers: Math.max(1, Number(document.getElementById('campo-qtd-espetos').value) || 1),
          allowedSides: Math.max(0, Number(document.getElementById('campo-qtd-acompanhamentos').value) || 0),
          includedItems: lerItensInclusosMarcados(),
          skewerExtraPrices: lerAcrescimosEspetosPreenchidos(),
        }
      : null,
  };

  if (!produto.nome || !produto.categoria) {
    mostrarToast('Preencha nome e categoria.', 'erro');
    return;
  }

  if (id) produto.id = id;

  let salvo;
  try {
    salvo = await salvarProduto(produto);
  } catch (erro) {
    mostrarToast('Não foi possível salvar o produto. ' + erro.message, 'erro');
    return;
  }

  // Custo (Etapa 2): gravado à parte em product_costs, nunca dentro do payload de
  // products (ver product-costs-service.js). Combo nunca grava custo fixo aqui — o
  // campo já vem sempre limpo/desabilitado nesse caso (atualizarEstadoCampoCusto()).
  // Produto novo com o campo vazio não precisa criar linha nenhuma (item 13 do
  // pedido); editando um produto existente, sempre grava — inclusive vazio, pra
  // realmente limpar um custo que já estava cadastrado (senão o valor antigo
  // ficaria "preso" no banco enquanto a tela mostraria "Não cadastrado").
  let avisoCusto = '';
  if (!ehCombo && souAdmin) {
    const custoDigitado = lerCustoUnitarioDoFormulario();
    if (id || custoDigitado !== null) {
      try {
        await salvarCustoProdutoNoSupabase(salvo.id, custoDigitado);
        mapaCustos.set(salvo.id, custoDigitado);
      } catch (erroCusto) {
        console.error('Erro ao salvar custo do produto:', erroCusto);
        avisoCusto = 'Produto salvo, mas não foi possível salvar o custo. ' + erroCusto.message;
        // Recarrega do banco pra refletir o estado verdadeiro — não fingir que o
        // valor digitado foi salvo quando na verdade a gravação falhou.
        try {
          await carregarCustosProdutos();
        } catch (erroRecarregar) {
          console.error('Erro ao recarregar custos após falha:', erroRecarregar);
        }
      }
    }
  }

  mostrarToast(avisoCusto || (id ? 'Produto atualizado.' : 'Produto cadastrado.'), avisoCusto ? 'erro' : 'sucesso');
  fecharModal();
  renderizarLista();
}
