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

// Foto do produto (Supabase Storage, bucket site-media/products/images/) — o upload só
// acontece ao Salvar, nunca ao selecionar o arquivo, pra nunca deixar um arquivo órfão
// se o admin cancelar o formulário (ver salvarFormularioProduto()).
let fotoAtualUrl = ''; // valor já salvo no produto (base64, URL externa ou Storage) — mostrado ao abrir o modal
let fotoNovoArquivo = null; // File escolhido agora, ainda não enviado ao Storage
let fotoRemovida = false; // true = admin clicou "Remover foto"; só efetivado no Save
let fotoPreviewObjectUrl = null; // Object URL do preview do novo arquivo, revogado assim que deixa de ser necessário

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
  // Botão "Adicionais" só com a migration de adicionais aplicada.
  document.getElementById('botao-adicionais').style.display = adicionaisProdutosDisponivel() ? '' : 'none';

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
  const proprio = custoProprioDoProduto(produto);
  if (proprio !== null) return proprio;
  return custoPelaComposicao(produto);
}

/** Custo cadastrado no próprio produto (product_costs), ou null. É o único que o formulário edita. */
function custoProprioDoProduto(produto) {
  return mapaCustos.has(produto.id) ? mapaCustos.get(produto.id) : null;
}

/**
 * Produto composto (sanduíche) sem custo próprio: soma custo × quantidade dos itens — mesma regra do
 * create_customer_order. null se não for composto ou se algum item não tiver custo (nunca inventa).
 */
function custoPelaComposicao(produto) {
  const itens = produto.composicao || [];
  if (itens.length === 0) return null;
  let total = 0;
  for (const item of itens) {
    const custo = mapaCustos.has(item.produtoId) ? mapaCustos.get(item.produtoId) : null;
    if (custo === null) return null;
    total += custo * item.quantidade;
  }
  return total;
}

/**
 * Preenche o <select> de filtro por categoria: lista fixa (CATEGORIAS_PADRAO, utils.js) + categorias
 * personalizadas (por nome — produto.categoria já é o nome delas). Preserva o filtro escolhido.
 */
function preencherFiltroCategorias() {
  const select = document.getElementById('filtro-categoria');
  const valorAtual = select.value;
  const personalizadas = obterCategoriasPersonalizadas()
    .map((c) => c.nome)
    .filter((nome) => !CATEGORIAS_PADRAO.includes(nome))
    .sort((a, b) => a.localeCompare(b));
  // "Outro" deixou de ser oferecida: só entra no filtro se ainda houver produto nela.
  const padrao = CATEGORIAS_PADRAO.filter((c) => c !== 'Outro' || obterProdutos().some((p) => p.categoria === 'Outro'));
  select.innerHTML =
    '<option value="">Todas</option>' +
    padrao.concat(personalizadas).map((c) => `<option value="${escaparHtml(c)}">${escaparHtml(c)}</option>`).join('');
  if (Array.from(select.options).some((o) => o.value === valorAtual)) select.value = valorAtual;
}

// ---------------------------------------------------------------------------
// Categorias personalizadas no formulário
//
// Valores do <select id="campo-categoria">: as 5 categorias fixas (texto de sempre, no HTML),
// 'custom:<uuid>' para cada categoria personalizada e VALOR_NOVA_CATEGORIA para "+ Criar nova
// categoria" (só aparece para admin — a barreira real é a RPC admin_create_product_category, que
// exige is_admin() no banco).
// ---------------------------------------------------------------------------

const VALOR_NOVA_CATEGORIA = '__nova_categoria__';
const PREFIXO_CATEGORIA_PERSONALIZADA = 'custom:';
const TAMANHO_MAXIMO_NOME_CATEGORIA = 40;
// Mesma lista reservada da RPC (nomes normalizados das categorias padrão, em pt e no rótulo em inglês do cardápio).
const NOMES_CATEGORIA_RESERVADOS = ['combos', 'combo', 'espetinhos', 'espetinho', 'espetos', 'espeto', 'acompanhamentos', 'acompanhamento', 'bebidas', 'bebida', 'outro', 'outros', 'skewers', 'sides', 'drinks', 'other', 'others'];
let _valorCategoriaAnterior = 'Combos';

/** Mesma regra do banco: trim, espaços repetidos viram 1, minúsculas, sem acentos comuns. */
function normalizarNomeCategoria(nome) {
  return String(nome || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[áàãâäéèêëíìîïóòõôöúùûüçñ]/g, (c) => 'aaaaaeeeeiiiiooooouuuucn'['áàãâäéèêëíìîïóòõôöúùûüçñ'.indexOf(c)]);
}

/** Valor do select para um produto: 'custom:<id>' se tiver categoria personalizada, senão a categoria fixa. */
function valorCategoriaDoProduto(produto) {
  return produto.categoriaPersonalizadaId ? PREFIXO_CATEGORIA_PERSONALIZADA + produto.categoriaPersonalizadaId : produto.categoria;
}

/**
 * Recria só as opções dinâmicas do select (as fixas do HTML ficam): categorias personalizadas ativas,
 * mais a do produto em edição se ela não estiver na lista (inativa ou não carregada — nunca some nem
 * vira "Outro" ao salvar), mais "+ Criar nova categoria" para admin com a tabela disponível.
 */
function preencherOpcoesCategoriaFormulario(produtoAtual) {
  const select = document.getElementById('campo-categoria');
  select.querySelectorAll('[data-categoria-dinamica]').forEach((el) => el.remove());

  // "Outro" não é mais oferecida para produto novo; editando um produto que ainda está nela, a opção
  // volta só para ele (senão o select ficaria vazio e o produto não poderia ser salvo).
  if (produtoAtual && !produtoAtual.categoriaPersonalizadaId && produtoAtual.categoria === 'Outro') {
    const outro = document.createElement('option');
    outro.value = 'Outro';
    outro.textContent = 'Outro';
    outro.setAttribute('data-categoria-dinamica', '');
    select.appendChild(outro);
  }

  const opcoes = obterCategoriasPersonalizadas()
    .filter((c) => c.ativa)
    .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome))
    .map((c) => ({ valor: PREFIXO_CATEGORIA_PERSONALIZADA + c.id, rotulo: c.nome }));

  if (produtoAtual && produtoAtual.categoriaPersonalizadaId) {
    const valor = PREFIXO_CATEGORIA_PERSONALIZADA + produtoAtual.categoriaPersonalizadaId;
    if (!opcoes.some((o) => o.valor === valor)) {
      const conhecida = obterCategoriasPersonalizadas().find((c) => c.id === produtoAtual.categoriaPersonalizadaId);
      opcoes.push({ valor, rotulo: conhecida ? conhecida.nome + ' (inativa)' : 'Categoria personalizada (não carregada)' });
    }
  }

  if (opcoes.length > 0) {
    const grupo = document.createElement('optgroup');
    grupo.label = 'Categorias personalizadas';
    grupo.setAttribute('data-categoria-dinamica', '');
    opcoes.forEach((o) => {
      const opcao = document.createElement('option');
      opcao.value = o.valor;
      opcao.textContent = o.rotulo;
      grupo.appendChild(opcao);
    });
    select.appendChild(grupo);
  }

  if (souAdmin && categoriasPersonalizadasCarregadas()) {
    const criar = document.createElement('option');
    criar.value = VALOR_NOVA_CATEGORIA;
    criar.textContent = '+ Criar nova categoria';
    criar.setAttribute('data-categoria-dinamica', '');
    select.appendChild(criar);
  }
}

function mostrarGrupoNovaCategoria(visivel) {
  document.getElementById('grupo-nova-categoria').style.display = visivel ? '' : 'none';
  document.getElementById('erro-nova-categoria').style.display = 'none';
  if (visivel) {
    const campo = document.getElementById('campo-nova-categoria');
    campo.value = '';
    campo.focus();
  }
}

function mostrarErroNovaCategoria(mensagem) {
  const erro = document.getElementById('erro-nova-categoria');
  erro.textContent = mensagem;
  erro.style.display = '';
}

/** Validação local (a definitiva é a do banco) — devolve a mensagem de erro, ou '' se ok. */
function validarNomeNovaCategoria(nome) {
  const limpo = String(nome || '').trim().replace(/\s+/g, ' ');
  if (!limpo) return 'Informe o nome da categoria.';
  if (limpo.length > TAMANHO_MAXIMO_NOME_CATEGORIA) return 'O nome da categoria pode ter no máximo ' + TAMANHO_MAXIMO_NOME_CATEGORIA + ' caracteres.';
  const normalizado = normalizarNomeCategoria(limpo);
  if (NOMES_CATEGORIA_RESERVADOS.includes(normalizado)) return 'Esse nome já é uma categoria padrão.';
  const existente = obterCategoriasPersonalizadas().find((c) => normalizarNomeCategoria(c.nome) === normalizado);
  if (existente) return 'Já existe a categoria "' + existente.nome + '".';
  return '';
}

let _criandoCategoria = false;

async function criarCategoriaPeloFormulario() {
  if (_criandoCategoria) return;
  const campo = document.getElementById('campo-nova-categoria');
  const nome = campo.value.trim().replace(/\s+/g, ' ');
  const erroLocal = validarNomeNovaCategoria(nome);
  if (erroLocal) {
    mostrarErroNovaCategoria(erroLocal);
    return;
  }

  const botao = document.getElementById('botao-criar-categoria');
  const botaoCancelar = document.getElementById('botao-cancelar-nova-categoria');
  const textoBotao = botao.textContent;
  _criandoCategoria = true;
  botao.disabled = true;
  botaoCancelar.disabled = true;
  campo.disabled = true;
  botao.textContent = 'Criando…';
  botao.setAttribute('aria-busy', 'true');
  try {
    const criada = await criarCategoriaPersonalizadaNoSupabase(nome);
    const idEmEdicao = document.getElementById('campo-id').value;
    preencherOpcoesCategoriaFormulario(idEmEdicao ? obterProdutoPorId(idEmEdicao) : null);
    const select = document.getElementById('campo-categoria');
    select.value = PREFIXO_CATEGORIA_PERSONALIZADA + criada.id;
    _valorCategoriaAnterior = select.value;
    atualizarVisibilidadeCamposPorCategoria();
    preencherFiltroCategorias();
    mostrarGrupoNovaCategoria(false);
    mostrarToast('Categoria "' + criada.nome + '" criada.', 'sucesso');
  } catch (erro) {
    mostrarErroNovaCategoria(erro.message || 'Não foi possível criar a categoria.');
  } finally {
    _criandoCategoria = false;
    botao.disabled = false;
    botaoCancelar.disabled = false;
    campo.disabled = false;
    botao.textContent = textoBotao;
    botao.removeAttribute('aria-busy');
  }
}

/** Lê os filtros/ordenação atuais da tela e redesenha a tabela */
function renderizarLista() {
  const termo = document.getElementById('campo-pesquisa').value.trim();
  const categoria = document.getElementById('filtro-categoria').value;
  const status = document.getElementById('filtro-status').value;
  const ordenacao = document.getElementById('campo-ordenar').value;

  let produtos = pesquisarProdutos({ termo, categoria, status });
  produtos = ordenarProdutos(produtos, ordenacao);
  atualizarResumoFiltrosProdutos(produtos.length, { termo, categoria, status, ordenacao });

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
  // Produto sem custo (ou combo, custo variável) ou sem data vai sempre para o fim, nunca vira 0.
  const custoOuNull = (p) => (p.categoria === 'Combos' ? null : custoUnitarioDoProduto(p));
  const dataOuNull = (p) => {
    const t = p.criadoEm ? new Date(p.criadoEm).getTime() : NaN;
    return isNaN(t) ? null : t;
  };
  const compararComAusentes = (va, vb) => {
    if (va === null && vb === null) return 0;
    if (va === null) return Infinity;
    if (vb === null) return -Infinity;
    return direcao === 'desc' ? vb - va : va - vb;
  };
  copia.sort((a, b) => {
    if (campo === 'custo' || campo === 'cadastro') {
      const r = campo === 'custo' ? compararComAusentes(custoOuNull(a), custoOuNull(b)) : compararComAusentes(dataOuNull(a), dataOuNull(b));
      return r === Infinity ? 1 : r === -Infinity ? -1 : r || a.nome.localeCompare(b.nome);
    }
    let comparacao = 0;
    if (campo === 'nome') comparacao = a.nome.localeCompare(b.nome);
    else if (campo === 'preco') comparacao = a.preco - b.preco;
    else if (campo === 'estoque') comparacao = a.quantidadeEstoque - b.quantidadeEstoque;
    return direcao === 'desc' ? -comparacao : comparacao;
  });
  return copia;
}

// ---------------------------------------------------------------------------
// Painel de pesquisa (lupa)
// ---------------------------------------------------------------------------

function abrirPainelPesquisaProdutos(abrir) {
  const painel = document.getElementById('painel-pesquisa-produtos');
  const botao = document.getElementById('botao-pesquisa-produtos');
  const deveAbrir = typeof abrir === 'boolean' ? abrir : painel.hidden;
  painel.hidden = !deveAbrir;
  botao.setAttribute('aria-expanded', String(deveAbrir));
  if (deveAbrir) document.getElementById('campo-pesquisa').focus();
}

function limparFiltrosProdutos() {
  document.getElementById('campo-pesquisa').value = '';
  document.getElementById('filtro-categoria').value = '';
  document.getElementById('filtro-status').value = '';
  document.getElementById('campo-ordenar').value = 'nome-asc';
  renderizarLista();
}

/** Contador de filtros na lupa e uma linha discreta com o que está aplicado (só quando há filtro). */
function atualizarResumoFiltrosProdutos(qtd, { termo, categoria, status, ordenacao }) {
  const ativos = [termo, categoria, status].filter(Boolean).length + (ordenacao && ordenacao !== 'nome-asc' ? 1 : 0);
  const badge = document.getElementById('badge-filtros-ativos');
  const resumo = document.getElementById('resumo-filtros-produtos');
  if (badge) {
    badge.textContent = ativos;
    badge.style.display = ativos ? '' : 'none';
  }
  if (!resumo) return;
  if (!ativos) {
    resumo.innerHTML = '';
    return;
  }
  const partes = [];
  if (termo) partes.push(`“${escaparHtml(termo)}”`);
  if (categoria) partes.push(escaparHtml(categoria));
  if (status) partes.push(status === 'ativo' ? 'Ativos' : 'Inativos');
  const ordem = document.querySelector(`#campo-ordenar option[value="${ordenacao}"]`);
  if (ordenacao && ordenacao !== 'nome-asc' && ordem) partes.push('Ordem: ' + escaparHtml(ordem.textContent));
  resumo.innerHTML = `<span>${qtd} ${qtd === 1 ? 'produto' : 'produtos'} · ${partes.join(' · ')}</span>
    <button type="button" class="link-limpar-filtros" id="link-limpar-filtros-produtos">Limpar</button>`;
  document.getElementById('link-limpar-filtros-produtos').addEventListener('click', limparFiltrosProdutos);
}

/** Célula "Custo" da tabela — Variável pra combo; "Sem custo de produção" pra Espetinho sem custo aplicado ainda (nunca €0,00); "Não cadastrado" pras demais categorias sem custo; senão o valor formatado. */
function celulaCustoHtml(produto) {
  if (produto.categoria === 'Combos') return '<span class="texto-custo-indisponivel">Variável</span>';

  const custo = custoUnitarioDoProduto(produto);
  if (custo === null) {
    const texto = produto.categoria === 'Espetinhos' ? 'Sem custo de produção' : 'Não cadastrado';
    return `<span class="texto-custo-indisponivel">${texto}</span>`;
  }
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
    ? `<img class="miniatura-produto" src="${produto.foto}" alt="${escaparHtml(produto.nome)}" loading="lazy" />`
    : `<div class="miniatura-produto-vazia">🍢</div>`;

  const status = calcularStatusEstoque(produto.quantidadeEstoque);
  // Combos não têm estoque próprio (ver comboConfig) — não faz sentido mostrar o badge de estoque pra eles.
  // Produto composto (sanduíche): mostra quantos dá para montar com o estoque dos itens.
  const ehComposto = (produto.composicao || []).length > 0;
  const colunaEstoque = produto.comboConfig
    ? '—'
    : ehComposto
      ? `<span class="badge badge-${status}" title="Quantos dá para montar com o estoque dos itens">${produto.quantidadeEstoque}</span> <span class="texto-custo-indisponivel">pelos itens</span>`
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
  document.getElementById('botao-pesquisa-produtos').addEventListener('click', () => abrirPainelPesquisaProdutos());
  document.getElementById('botao-fechar-pesquisa-produtos').addEventListener('click', () => abrirPainelPesquisaProdutos(false));
  document.getElementById('botao-limpar-filtros-produtos').addEventListener('click', limparFiltrosProdutos);
  document.getElementById('painel-pesquisa-produtos').addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape') {
      abrirPainelPesquisaProdutos(false);
      document.getElementById('botao-pesquisa-produtos').focus();
    }
  });
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
  document.getElementById('campo-origem-estoque').addEventListener('change', atualizarDicaOrigemEstoque);
  document.getElementById('lista-composicao').addEventListener('input', atualizarCamposPorComposicao);
  ligarEventosAdicionais();
  ligarEventoCategoria();

  document.getElementById('botao-criar-categoria').addEventListener('click', criarCategoriaPeloFormulario);
  document.getElementById('botao-cancelar-nova-categoria').addEventListener('click', () => mostrarGrupoNovaCategoria(false));
  document.getElementById('campo-nova-categoria').addEventListener('keydown', (evento) => {
    if (evento.key !== 'Enter') return;
    evento.preventDefault(); // Enter aqui cria a categoria — nunca envia o formulário do produto
    criarCategoriaPeloFormulario();
  });
}

function abrirModalCriacao() {
  document.getElementById('modal-titulo').textContent = 'Novo Produto';
  preencherOpcoesCategoriaFormulario(null);
  mostrarGrupoNovaCategoria(false);
  document.getElementById('form-produto').reset();
  _valorCategoriaAnterior = document.getElementById('campo-categoria').value;
  document.getElementById('campo-id').value = '';
  document.getElementById('campo-estoque').value = 0;
  document.getElementById('campo-estoque').readOnly = false;
  document.getElementById('dica-estoque-pelo-estoque').style.display = 'none';
  document.getElementById('campo-status').value = 'ativo';
  document.getElementById('campo-origem-estoque').value = 'untracked';
  document.getElementById('campo-porcao').value = '';
  document.getElementById('campo-ordem').value = 0;
  document.getElementById('campo-qtd-espetos').value = 1;
  document.getElementById('campo-qtd-acompanhamentos').value = 1;
  document.getElementById('campo-custo').placeholder = 'Não cadastrado';
  resetarEstadoFoto('');
  renderizarListaComposicao(null);
  renderizarListaAdicionaisProduto(null);
  atualizarVisibilidadeCamposPorCategoria();
  atualizarDicaOrigemEstoque();
  abrirModal();
}

function abrirModalEdicao(id) {
  const produto = obterProdutoPorId(id);
  if (!produto) return;

  document.getElementById('modal-titulo').textContent = 'Editar Produto';
  document.getElementById('campo-id').value = produto.id;
  document.getElementById('campo-nome').value = produto.nome;
  preencherOpcoesCategoriaFormulario(produto);
  mostrarGrupoNovaCategoria(false);
  document.getElementById('campo-categoria').value = valorCategoriaDoProduto(produto);
  _valorCategoriaAnterior = document.getElementById('campo-categoria').value;
  document.getElementById('campo-preco').value = produto.preco;
  document.getElementById('campo-estoque').value = produto.quantidadeEstoque;
  // Fase D: saldo só muda pelo Estoque (movimento registrado), nunca pela edição do produto.
  document.getElementById('campo-estoque').readOnly = true;
  document.getElementById('dica-estoque-pelo-estoque').style.display = '';
  document.getElementById('campo-descricao').value = produto.descricao || '';
  document.getElementById('campo-status').value = produto.status;
  document.getElementById('campo-origem-estoque').value = produto.stockMode || 'untracked';
  document.getElementById('campo-porcao').value = produto.porcaoGramas === null || produto.porcaoGramas === undefined ? '' : produto.porcaoGramas;
  // Custo (Etapa 2): combo nunca mostra valor aqui (ver custoUnitarioDoProduto) —
  // atualizarVisibilidadeCamposPorCategoria(), chamada mais abaixo, cuida de
  // desabilitar/limpar o campo pra combo e pra quem não é admin.
  // Só o custo PRÓPRIO entra no campo (o calculado pelos itens aparece como dica) — senão salvar o
  // formulário congelaria a soma dos itens como custo fixo do produto composto.
  const custoAtual = custoProprioDoProduto(produto);
  document.getElementById('campo-custo').value = custoAtual === null ? '' : custoAtual;
  const custoItens = custoPelaComposicao(produto);
  document.getElementById('campo-custo').placeholder =
    custoItens === null ? 'Não cadastrado' : 'Pelos itens: ' + formatarMoeda(custoItens, obterConfiguracoes().moeda);
  resetarEstadoFoto(produto.foto || '');

  const combo = produto.comboConfig;
  document.getElementById('campo-ordem').value = combo ? combo.ordem || 0 : 0;
  document.getElementById('campo-qtd-espetos').value = combo ? combo.allowedSkewers : 1;
  document.getElementById('campo-qtd-acompanhamentos').value = combo ? combo.allowedSides : 1;

  renderizarListaComposicao(produto);
  renderizarListaAdicionaisProduto(produto);
  atualizarVisibilidadeCamposPorCategoria();
  atualizarDicaOrigemEstoque();
  renderizarListaItensInclusos(combo ? combo.includedItems : []);
  renderizarListasAcrescimosCombo(combo);

  abrirModal();
}

/** Mostra só a dica correspondente à origem de estoque selecionada — Etapa K2, mesmo padrão de atualizarEstadoCampoCusto(). */
function atualizarDicaOrigemEstoque() {
  const campo = document.getElementById('campo-origem-estoque');
  const origem = campo.value;
  // Travado = produto montado (composição): quem explica é a dica-origem-composicao.
  document.getElementById('dica-origem-purchased').style.display = origem === 'purchased' ? '' : 'none';
  document.getElementById('dica-origem-produced').style.display = origem === 'produced' ? '' : 'none';
  document.getElementById('dica-origem-untracked').style.display = origem === 'untracked' && !campo.disabled ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Campos que só aparecem quando a categoria é "Combos"
// ---------------------------------------------------------------------------

/** Mostra/esconde os campos de combo reagindo à troca de categoria (select fixo) */
function ligarEventoCategoria() {
  document.getElementById('campo-categoria').addEventListener('change', (evento) => {
    // "+ Criar nova categoria" não é uma categoria: abre o campo de nome e volta o select pro valor anterior.
    if (evento.target.value === VALOR_NOVA_CATEGORIA) {
      evento.target.value = _valorCategoriaAnterior;
      mostrarGrupoNovaCategoria(true);
      return;
    }
    _valorCategoriaAnterior = evento.target.value;
    const secao = document.getElementById('secao-campos-combo');
    const estavaVisivel = secao.style.display !== 'none';
    atualizarVisibilidadeCamposPorCategoria();
    const agoraVisivel = secao.style.display !== 'none';
    // Só reseta os checklists na primeira vez que a seção aparece — evita apagar
    // marcações já feitas se o admin continuar digitando/corrigindo a categoria.
    if (agoraVisivel && !estavaVisivel) {
      renderizarListaItensInclusos([]);
      renderizarListasAcrescimosCombo(null);
    }
  });
}

function atualizarVisibilidadeCamposPorCategoria() {
  const categoria = document.getElementById('campo-categoria').value.trim();
  const ehCombo = categoria === 'Combos';
  const ehEspetinho = categoria === 'Espetinhos';
  document.getElementById('secao-campos-combo').style.display = ehCombo ? '' : 'none';
  document.getElementById('grupo-estoque').style.display = ehCombo ? 'none' : '';
  document.getElementById('grupo-porcao').style.display = categoria === 'Acompanhamentos' ? '' : 'none';
  document.getElementById('campo-estoque').required = !ehCombo;
  document.getElementById('campo-qtd-espetos').required = ehCombo;
  document.getElementById('campo-qtd-acompanhamentos').required = ehCombo;
  atualizarEstadoCampoCusto(ehCombo, ehEspetinho);
  // Combos já baixam pelos itens escolhidos — não usam composição. Sem a migration, a seção não aparece.
  document.getElementById('grupo-composicao').style.display = !ehCombo && composicaoProdutosDisponivel() ? '' : 'none';
  // Adicionais (ex.: + Batata + Refri): idem — combos não usam; sem a migration, escondido.
  document.getElementById('grupo-adicionais-produto').style.display = !ehCombo && adicionaisProdutosDisponivel() ? '' : 'none';
  atualizarCamposPorComposicao();
}

// ---------------------------------------------------------------------------
// Adicionais — oferecidos por produto (formulário) e cadastro (modal "Adicionais")
// ---------------------------------------------------------------------------

/** Checklist dos adicionais cadastrados, marcando os que o produto oferece. */
function renderizarListaAdicionaisProduto(produtoAtual) {
  const lista = document.getElementById('lista-adicionais-produto');
  if (!adicionaisProdutosDisponivel()) {
    lista.innerHTML = '';
    return;
  }
  const marcados = new Set((produtoAtual && produtoAtual.adicionaisIds) || []);
  const adicionais = obterAdicionais();
  if (adicionais.length === 0) {
    lista.innerHTML = '<p class="dica-campo">Nenhum adicional cadastrado ainda.</p>';
    return;
  }
  const moeda = obterConfiguracoes().moeda;
  lista.innerHTML = adicionais
    .map(
      (a) => `
        <label class="linha-item-incluso ${a.ativo ? '' : 'linha-item-incluso-indisponivel'}">
          <input type="checkbox" class="campo-adicional-produto" value="${a.id}" ${marcados.has(a.id) ? 'checked' : ''} />
          <span>${escaparHtml(a.nome)} (+${formatarMoeda(a.preco, moeda)})${a.ativo ? '' : ' <em>(inativo)</em>'}</span>
        </label>`
    )
    .join('');
}

function lerAdicionaisDoProdutoNoFormulario() {
  return Array.from(document.querySelectorAll('.campo-adicional-produto:checked')).map((c) => c.value);
}

/** Produtos que podem ser item/bebida de adicional: não combo, sem composição; ativos (ou já usados). */
function candidatosItemAdicional(idsJaUsados) {
  const usados = new Set(idsJaUsados || []);
  return obterProdutos().filter(
    (p) => p.categoria !== 'Combos' && (p.composicao || []).length === 0 && (p.status === 'ativo' || usados.has(p.id))
  );
}

function abrirModalAdicionais() {
  mostrarListaAdicionais();
  document.getElementById('modal-overlay-adicionais').classList.add('modal-visivel');
}

function fecharModalAdicionais() {
  document.getElementById('modal-overlay-adicionais').classList.remove('modal-visivel');
}

function mostrarListaAdicionais() {
  document.getElementById('adicionais-titulo').textContent = 'Adicionais';
  document.getElementById('adicionais-visao-lista').style.display = '';
  document.getElementById('form-adicional').style.display = 'none';
  renderizarListaAdicionais();
}

function renderizarListaAdicionais() {
  const container = document.getElementById('lista-adicionais');
  const adicionais = obterAdicionais();
  if (adicionais.length === 0) {
    container.innerHTML = '<p class="dica-campo">Nenhum adicional cadastrado ainda.</p>';
    return;
  }
  const moeda = obterConfiguracoes().moeda;
  const nomeDe = (id) => (obterProdutoPorId(id) || {}).nome || 'produto removido';
  container.innerHTML = adicionais
    .map((a) => {
      const itens = a.itens.map((i) => `${nomeDe(i.produtoId)} × ${i.quantidade}`).join(', ');
      const bebidas = a.escolhas.length ? `${a.escolhas.length} bebida(s) à escolha` : 'sem escolha de bebida';
      const produtos = a.produtosIds.length ? `oferecido em ${a.produtosIds.length} produto(s)` : 'não oferecido em nenhum produto';
      return `
        <div class="linha-adicional ${a.ativo ? '' : 'linha-adicional-inativo'}">
          <div class="linha-adicional-info">
            <strong>${escaparHtml(a.nome)}</strong> · +${formatarMoeda(a.preco, moeda)}${a.ativo ? '' : ' · <em>inativo</em>'}
            <small>${escaparHtml([itens, bebidas, produtos].filter(Boolean).join(' · '))}</small>
          </div>
          <div class="acoes-linha">
            <button type="button" class="btn-icone" data-acao="editar-adicional" data-id="${a.id}" title="Editar">✏️</button>
            <button type="button" class="btn-icone" data-acao="excluir-adicional" data-id="${a.id}" title="Excluir">🗑️</button>
          </div>
        </div>`;
    })
    .join('');
}

function abrirFormularioAdicional(id) {
  const adicional = id ? obterAdicionais().find((a) => a.id === id) : null;
  document.getElementById('adicionais-titulo').textContent = adicional ? 'Editar adicional' : 'Novo adicional';
  document.getElementById('adicionais-visao-lista').style.display = 'none';
  document.getElementById('form-adicional').style.display = '';
  document.getElementById('adicional-erro').style.display = 'none';
  document.getElementById('adicional-id').value = adicional ? adicional.id : '';
  document.getElementById('adicional-nome').value = adicional ? adicional.nome : '';
  document.getElementById('adicional-preco').value = adicional ? adicional.preco : '';
  document.getElementById('adicional-ativo').checked = adicional ? adicional.ativo : true;

  const qtdItem = new Map(((adicional && adicional.itens) || []).map((i) => [i.produtoId, i.quantidade]));
  const acrescimo = new Map(((adicional && adicional.escolhas) || []).map((e) => [e.produtoId, e.acrescimo]));
  const ordenar = (marcados, primeiroCategoria) => (a, b) =>
    (marcados.has(b.id) ? 1 : 0) - (marcados.has(a.id) ? 1 : 0) ||
    (b.categoria === primeiroCategoria ? 1 : 0) - (a.categoria === primeiroCategoria ? 1 : 0) ||
    a.nome.localeCompare(b.nome);
  const inativo = (p) => (p.status !== 'ativo' ? ' <em>(inativo)</em>' : '');

  document.getElementById('adicional-lista-itens').innerHTML = candidatosItemAdicional([...qtdItem.keys()])
    .sort(ordenar(qtdItem, 'Acompanhamentos'))
    .map(
      (p) => `
        <div class="linha-acrescimo-espeto">
          <span>${escaparHtml(p.nome)}${inativo(p)}</span>
          <div class="campo-acrescimo">
            <span>×</span>
            <input type="number" class="input campo-acrescimo-espeto campo-item-adicional" data-produto-id="${p.id}" min="0" max="99" step="1" inputmode="numeric" value="${qtdItem.get(p.id) || 0}" aria-label="Quantidade de ${escaparHtml(p.nome)}" />
          </div>
        </div>`
    )
    .join('');

  document.getElementById('adicional-lista-bebidas').innerHTML = candidatosItemAdicional([...acrescimo.keys()])
    .sort(ordenar(acrescimo, 'Bebidas'))
    .map(
      (p) => `
        <div class="linha-acrescimo-espeto">
          <label class="linha-checkbox-adicional">
            <input type="checkbox" class="campo-bebida-adicional" value="${p.id}" ${acrescimo.has(p.id) ? 'checked' : ''} />
            <span>${escaparHtml(p.nome)}${inativo(p)}</span>
          </label>
          <div class="campo-acrescimo">
            <span>+ €</span>
            <input type="number" class="input campo-acrescimo-espeto campo-acrescimo-bebida" data-produto-id="${p.id}" min="0" step="0.5" value="${acrescimo.get(p.id) || 0}" aria-label="Acréscimo de ${escaparHtml(p.nome)}" />
          </div>
        </div>`
    )
    .join('');
  document.getElementById('adicional-nome').focus();
}

/** Lê o formulário do adicional; devolve { adicional } ou { erro }. */
function lerFormularioAdicional() {
  const nome = document.getElementById('adicional-nome').value.trim().replace(/\s+/g, ' ');
  const precoBruto = document.getElementById('adicional-preco').value;
  const preco = Number(precoBruto);
  if (!nome) return { erro: 'Informe o nome do adicional.' };
  if (precoBruto === '' || !Number.isFinite(preco) || preco < 0 || preco > 999) return { erro: 'Informe um preço válido (0 a 999).' };

  const itens = [];
  for (const campo of document.querySelectorAll('.campo-item-adicional')) {
    const q = Number(campo.value || 0);
    if (!Number.isInteger(q) || q < 0 || q > 99) return { erro: 'Quantidade inválida em "Itens que saem do estoque" (0 a 99).' };
    if (q > 0) itens.push({ produtoId: campo.dataset.produtoId, quantidade: q });
  }
  const escolhas = [];
  for (const caixa of document.querySelectorAll('.campo-bebida-adicional:checked')) {
    const campo = document.querySelector(`.campo-acrescimo-bebida[data-produto-id="${caixa.value}"]`);
    const x = Number(campo ? campo.value || 0 : 0);
    if (!Number.isFinite(x) || x < 0 || x > 999) return { erro: 'Acréscimo de bebida inválido.' };
    escolhas.push({ produtoId: caixa.value, acrescimo: Math.round(x * 100) / 100 });
  }
  if (itens.length === 0 && escolhas.length === 0) return { erro: 'Marque ao menos um item que sai do estoque ou uma bebida.' };

  return {
    adicional: {
      id: document.getElementById('adicional-id').value || null,
      nome,
      preco: Math.round(preco * 100) / 100,
      ativo: document.getElementById('adicional-ativo').checked,
      itens,
      escolhas,
    },
  };
}

let _salvandoAdicional = false;

async function salvarFormularioAdicional(evento) {
  evento.preventDefault();
  if (_salvandoAdicional) return;
  const erro = document.getElementById('adicional-erro');
  const { adicional, erro: mensagem } = lerFormularioAdicional();
  if (mensagem) {
    erro.textContent = mensagem;
    erro.style.display = '';
    return;
  }
  const botao = document.getElementById('botao-salvar-adicional');
  const texto = botao.textContent;
  _salvandoAdicional = true;
  botao.disabled = true;
  botao.textContent = 'Salvando…';
  try {
    await salvarAdicionalNoSupabase(adicional);
    await carregarProdutosCache();
    mostrarToast(`Adicional "${adicional.nome}" salvo.`, 'sucesso');
    mostrarListaAdicionais();
  } catch (e) {
    erro.textContent = e.message || 'Não foi possível salvar o adicional.';
    erro.style.display = '';
  } finally {
    _salvandoAdicional = false;
    botao.disabled = false;
    botao.textContent = texto;
  }
}

async function excluirAdicionalComConfirmacao(id) {
  const adicional = obterAdicionais().find((a) => a.id === id);
  if (!adicional) return;
  const aviso = adicional.produtosIds.length ? ` Ele deixa de ser oferecido em ${adicional.produtosIds.length} produto(s).` : '';
  if (!confirm(`Excluir o adicional "${adicional.nome}"?${aviso} Pedidos já feitos não mudam.`)) return;
  try {
    await excluirAdicionalNoSupabase(id);
    await carregarProdutosCache();
    mostrarToast('Adicional excluído.', 'sucesso');
  } catch (e) {
    mostrarToast('Não foi possível excluir o adicional. ' + e.message, 'erro');
  }
  renderizarListaAdicionais();
}

function ligarEventosAdicionais() {
  document.getElementById('botao-adicionais').addEventListener('click', abrirModalAdicionais);
  document.getElementById('botao-fechar-adicionais').addEventListener('click', fecharModalAdicionais);
  document.getElementById('modal-overlay-adicionais').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-adicionais') fecharModalAdicionais();
  });
  document.getElementById('botao-novo-adicional').addEventListener('click', () => abrirFormularioAdicional(null));
  document.getElementById('botao-voltar-adicionais').addEventListener('click', mostrarListaAdicionais);
  document.getElementById('form-adicional').addEventListener('submit', salvarFormularioAdicional);
  document.getElementById('lista-adicionais').addEventListener('click', (evento) => {
    const botao = evento.target.closest('[data-acao]');
    if (!botao) return;
    if (botao.dataset.acao === 'editar-adicional') abrirFormularioAdicional(botao.dataset.id);
    if (botao.dataset.acao === 'excluir-adicional') excluirAdicionalComConfirmacao(botao.dataset.id);
  });
}

// ---------------------------------------------------------------------------
// Composição fixa ("Consome do estoque") — ex.: sanduíche = 1 espeto + 1 pão
// ---------------------------------------------------------------------------

/**
 * Uma linha por produto que pode ser item (ativo, não combo, sem composição própria, não o próprio
 * produto), com a quantidade por venda (0 = não entra). Itens já gravados aparecem primeiro, mesmo
 * inativos. Produto que é item de outro não pode ter composição (o banco também recusa).
 */
function renderizarListaComposicao(produtoAtual) {
  const lista = document.getElementById('lista-composicao');
  const aviso = document.getElementById('aviso-composicao');
  aviso.style.display = 'none';
  lista.innerHTML = '';
  if (!composicaoProdutosDisponivel()) return;

  const idAtual = produtoAtual ? produtoAtual.id : '';
  const atual = new Map(((produtoAtual && produtoAtual.composicao) || []).map((c) => [c.produtoId, c.quantidade]));

  const usadoEm = idAtual ? obterProdutos().filter((p) => (p.composicao || []).some((c) => c.produtoId === idAtual)) : [];
  if (usadoEm.length > 0) {
    aviso.textContent = `Este produto é item de ${usadoEm.map((p) => p.nome).join(', ')}, por isso não pode consumir outros itens.`;
    aviso.style.display = '';
    return;
  }

  const candidatos = obterProdutos()
    .filter((p) => p.id !== idAtual && p.categoria !== 'Combos' && (p.composicao || []).length === 0 && (p.status === 'ativo' || atual.has(p.id)))
    .sort((a, b) => (atual.has(b.id) ? 1 : 0) - (atual.has(a.id) ? 1 : 0) || a.nome.localeCompare(b.nome));

  if (candidatos.length === 0) {
    lista.innerHTML = '<p class="dica-campo">Nenhum produto ativo para usar como item.</p>';
    return;
  }
  lista.innerHTML = candidatos
    .map(
      (p) => `
        <div class="linha-acrescimo-espeto">
          <span>${escaparHtml(p.nome)}${p.status !== 'ativo' ? ' <em>(inativo)</em>' : ''}</span>
          <div class="campo-acrescimo">
            <span>×</span>
            <input type="number" class="input campo-acrescimo-espeto campo-qtd-composicao" data-produto-id="${p.id}" min="0" max="99" step="1" inputmode="numeric" value="${atual.get(p.id) || 0}" aria-label="Quantidade de ${escaparHtml(p.nome)} por venda" />
          </div>
        </div>`
    )
    .join('');
}

/** [{ produtoId, quantidade }] das linhas com quantidade > 0; null se alguma quantidade for inválida. */
function lerComposicaoDoFormulario() {
  const itens = [];
  for (const campo of document.querySelectorAll('.campo-qtd-composicao')) {
    const bruto = String(campo.value).trim();
    if (bruto === '' || bruto === '0') continue;
    const quantidade = Number(bruto);
    if (!Number.isInteger(quantidade) || quantidade < 0 || quantidade > 99) return null;
    if (quantidade > 0) itens.push({ produtoId: campo.dataset.produtoId, quantidade });
  }
  return itens;
}

function mesmaComposicao(a, b) {
  const chave = (lista) => (lista || []).map((i) => i.produtoId + ':' + i.quantidade).sort().join('|');
  return chave(a) === chave(b);
}

/** Com itens marcados: some o estoque próprio e a origem fica "sem controle" (o estoque é o dos itens). */
function atualizarCamposPorComposicao() {
  const ehCombo = document.getElementById('campo-categoria').value.trim() === 'Combos';
  const itens = lerComposicaoDoFormulario();
  const composto = !ehCombo && composicaoProdutosDisponivel() && (itens === null || itens.length > 0);
  const origem = document.getElementById('campo-origem-estoque');
  document.getElementById('grupo-estoque').style.display = ehCombo || composto ? 'none' : '';
  document.getElementById('campo-estoque').required = !ehCombo && !composto;
  if (composto) origem.value = 'untracked';
  origem.disabled = composto;
  atualizarDicaOrigemEstoque();
  document.getElementById('dica-origem-composicao').style.display = composto ? '' : 'none';
}

/**
 * Custo unitário: desabilitado + campo limpo quando é combo (custo real vem dos
 * componentes, nunca de um valor fixo aqui). Desabilitado, mas SEM limpar o valor,
 * quando é Espetinho — decisão de negócio: custo de espeto só pode vir da Produção de
 * Espetos ("Aplicar custo ao produto", js/producao.js), nunca digitado aqui; o valor
 * mostrado continua sendo o real (lido de product_costs), só não é editável nesta
 * tela. Desabilitado também para quem não é admin, nas demais categorias
 * (visualização continua liberada pra staff, só a edição é restrita — a barreira real
 * é o RLS de product_costs, isto é só UX). Os avisos são mutuamente exclusivos:
 * combo > espetinho > "somente admin", do motivo mais específico pro mais genérico.
 */
function atualizarEstadoCampoCusto(ehCombo, ehEspetinho) {
  const campo = document.getElementById('campo-custo');
  const rotulo = document.querySelector('label[for="campo-custo"]');
  const dicaCombo = document.getElementById('dica-custo-combo');
  const dicaEspetinho = document.getElementById('dica-custo-espetinho');
  const dicaSomenteAdmin = document.getElementById('dica-custo-somente-admin');

  if (ehCombo) {
    campo.value = '';
    campo.disabled = true;
    rotulo.textContent = 'Custo unitário (€)';
    dicaCombo.style.display = '';
    dicaEspetinho.style.display = 'none';
    dicaSomenteAdmin.style.display = 'none';
  } else if (ehEspetinho) {
    campo.disabled = true;
    rotulo.textContent = 'Custo de produção (€)';
    dicaCombo.style.display = 'none';
    dicaEspetinho.style.display = '';
    dicaSomenteAdmin.style.display = 'none';
  } else {
    campo.disabled = !souAdmin;
    rotulo.textContent = 'Custo unitário (€)';
    dicaCombo.style.display = 'none';
    dicaEspetinho.style.display = 'none';
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

// Grupos de opção de combo com acréscimo por opção — mesma tela/leitura pra todos. A lista de
// opções vem sempre dos produtos ATIVOS cadastrados na categoria do grupo (nunca nomes fixos).
const GRUPOS_ACRESCIMO_COMBO = {
  espetos: {
    categoria: 'Espetinhos',
    containerId: 'lista-acrescimos-espetos',
    textoVazio: 'Nenhum espeto ativo cadastrado (categoria Espetinhos) ainda.',
  },
  acompanhamentos: {
    categoria: 'Acompanhamentos',
    containerId: 'lista-acrescimos-acompanhamentos',
    textoVazio: 'Nenhum acompanhamento ativo cadastrado (categoria Acompanhamentos) ainda.',
  },
};

/** Lista das opções ativas de um grupo com um campo de acréscimo (€) cada, pré-preenchido se vier de um combo existente */
function renderizarListaAcrescimosOpcoes(grupo, acrescimosExistentes) {
  const config = GRUPOS_ACRESCIMO_COMBO[grupo];
  const opcoes = pesquisarProdutos({ categoria: config.categoria, status: 'ativo' });
  const container = document.getElementById(config.containerId);

  if (opcoes.length === 0) {
    container.innerHTML = `<p class="dica-campo">${escaparHtml(config.textoVazio)}</p>`;
    return;
  }

  container.innerHTML = opcoes
    .map((opcao) => {
      const valorAtual = (acrescimosExistentes && acrescimosExistentes[opcao.id]) || 0;
      return `
        <div class="linha-acrescimo-espeto">
          <span>${escaparHtml(opcao.nome)}</span>
          <div class="campo-acrescimo">
            <span>+ €</span>
            <input type="number" class="input campo-acrescimo-espeto" data-grupo="${grupo}" data-produto-id="${opcao.id}" min="0" step="0.5" value="${valorAtual}" />
          </div>
        </div>`;
    })
    .join('');
}

/** Renderiza os dois grupos (espetos e acompanhamentos) a partir do comboConfig (ou vazios num combo novo). */
function renderizarListasAcrescimosCombo(combo) {
  renderizarListaAcrescimosOpcoes('espetos', combo ? combo.skewerExtraPrices : {});
  renderizarListaAcrescimosOpcoes('acompanhamentos', combo ? combo.sideExtraPrices : {});
}

/**
 * Lê todos os campos de acréscimo renderizados de um grupo (um por opção ativa) e monta
 * { produtoId: valor } — inclui os que ficaram em 0. Pra espetos essa lista também define
 * quais são selecionáveis nesse combo (ver products-service.js); pra acompanhamentos, só o valor.
 */
function lerAcrescimosOpcoesPreenchidos(grupo) {
  const resultado = {};
  document.querySelectorAll(`.campo-acrescimo-espeto[data-grupo="${grupo}"]`).forEach((campo) => {
    resultado[campo.dataset.produtoId] = Math.max(0, Number(campo.value) || 0);
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
  // Cancelar o modal (X, "Cancelar" ou clique no overlay) nunca deve deixar upload
  // pendente nem intenção de remoção presa — nenhum arquivo foi enviado até aqui
  // (o upload só acontece dentro de salvarFormularioProduto, ao Salvar).
  revogarPreviewObjectUrl();
  fotoNovoArquivo = null;
  fotoRemovida = false;
}

const FOTO_PRODUTO_MIMES_ACEITOS = ['image/jpeg', 'image/png', 'image/webp'];
const FOTO_PRODUTO_TAMANHO_MAXIMO_BYTES = 5 * 1024 * 1024; // 5 MB — mesmo limite validado de novo em uploadFotoProduto()

function tratarSelecaoFoto(evento) {
  const arquivo = evento.target.files[0];
  if (!arquivo) return;

  if (!FOTO_PRODUTO_MIMES_ACEITOS.includes(arquivo.type)) {
    mostrarToast('Formato inválido. Envie JPG, PNG ou WEBP.', 'erro');
    evento.target.value = '';
    return;
  }
  if (arquivo.size > FOTO_PRODUTO_TAMANHO_MAXIMO_BYTES) {
    mostrarToast('A imagem precisa ter no máximo 5 MB.', 'erro');
    evento.target.value = '';
    return;
  }

  // Só guarda o arquivo em memória + preview local — nenhum upload acontece aqui.
  revogarPreviewObjectUrl();
  fotoNovoArquivo = arquivo;
  fotoRemovida = false; // uma nova seleção cancela uma remoção pendente
  fotoPreviewObjectUrl = URL.createObjectURL(arquivo);
  atualizarPreviewFoto();
}

function removerFotoSelecionada() {
  revogarPreviewObjectUrl();
  fotoNovoArquivo = null;
  fotoRemovida = true; // só efetivado (image_url='' + exclusão da antiga) ao Salvar
  document.getElementById('campo-foto').value = '';
  atualizarPreviewFoto();
}

function revogarPreviewObjectUrl() {
  if (fotoPreviewObjectUrl) {
    URL.revokeObjectURL(fotoPreviewObjectUrl);
    fotoPreviewObjectUrl = null;
  }
}

/** Reseta todo o estado de foto do formulário — chamado ao abrir criação/edição. */
function resetarEstadoFoto(urlAtual) {
  revogarPreviewObjectUrl();
  fotoAtualUrl = urlAtual || '';
  fotoNovoArquivo = null;
  fotoRemovida = false;
  document.getElementById('campo-foto').value = '';
  atualizarPreviewFoto();
}

/** Redesenha o preview a partir do estado atual — novo arquivo > removida > foto salva > vazio. */
function atualizarPreviewFoto() {
  const texto = document.getElementById('preview-foto-texto');
  const img = document.getElementById('preview-foto-img');
  const botaoRemover = document.getElementById('botao-remover-foto');

  const urlExibida = fotoNovoArquivo ? fotoPreviewObjectUrl : fotoRemovida ? '' : fotoAtualUrl;

  if (urlExibida) {
    img.src = urlExibida;
    img.style.display = 'block';
    texto.style.display = 'none';
    botaoRemover.style.display = 'inline-flex';
  } else {
    img.src = '';
    img.style.display = 'none';
    texto.style.display = 'block';
    botaoRemover.style.display = 'none';
  }
}

async function salvarFormularioProduto(evento) {
  evento.preventDefault();

  const id = document.getElementById('campo-id').value;
  const valorCategoria = document.getElementById('campo-categoria').value;
  // Categoria personalizada: produto.categoria = nome dela (o que o app exibe/agrupa) e
  // categoriaPersonalizadaId = id (o que o banco grava; category vira 'other' em products-service.js).
  let categoria = valorCategoria === VALOR_NOVA_CATEGORIA ? '' : valorCategoria;
  let categoriaPersonalizadaId = null;
  if (valorCategoria.startsWith(PREFIXO_CATEGORIA_PERSONALIZADA)) {
    categoriaPersonalizadaId = valorCategoria.slice(PREFIXO_CATEGORIA_PERSONALIZADA.length);
    const personalizada = obterCategoriasPersonalizadas().find((c) => c.id === categoriaPersonalizadaId);
    categoria = personalizada ? personalizada.nome : 'Outro';
  }
  const ehCombo = categoria === 'Combos';
  const ehEspetinho = categoria === 'Espetinhos';

  const nome = document.getElementById('campo-nome').value.trim();
  if (!nome || !categoria) {
    mostrarToast('Preencha nome e categoria.', 'erro');
    return;
  }

  // Composição ("Consome do estoque"): lida e validada antes de qualquer gravação. Combo nunca tem.
  const usaComposicao = composicaoProdutosDisponivel();
  const composicao = !usaComposicao || ehCombo ? [] : lerComposicaoDoFormulario();
  if (composicao === null) {
    mostrarToast('Quantidade inválida em "Consome do estoque" (use números inteiros de 0 a 99).', 'erro');
    return;
  }
  const composicaoAnterior = id ? ((obterProdutoPorId(id) || {}).composicao || []) : [];
  const ehComposto = composicao.length > 0;
  // Adicionais oferecidos (ex.: + Batata + Refri). Combo nunca oferece.
  const usaAdicionais = adicionaisProdutosDisponivel();
  const adicionaisIds = !usaAdicionais || ehCombo ? [] : lerAdicionaisDoProdutoNoFormulario();
  const adicionaisAnteriores = id ? ((obterProdutoPorId(id) || {}).adicionaisIds || []) : [];

  // Foto: decide o valor final de image_url ANTES de tocar no produto. Se houver arquivo
  // novo, faz o upload primeiro (produto/foto antiga continuam intactos se isso falhar);
  // só avança pro salvarProduto() depois do upload confirmado.
  let fotoParaSalvar = fotoAtualUrl;
  let novoUploadPath = null; // preenchido só se um upload novo rodar aqui — usado pro rollback se o save falhar

  if (fotoNovoArquivo) {
    try {
      const resultado = await uploadFotoProduto(fotoNovoArquivo);
      fotoParaSalvar = resultado.url;
      novoUploadPath = resultado.path;
    } catch (erroUpload) {
      mostrarToast('Não foi possível enviar a foto. ' + erroUpload.message, 'erro');
      return; // produto e foto antiga permanecem intocados
    }
  } else if (fotoRemovida) {
    fotoParaSalvar = '';
  }

  const produto = {
    nome,
    categoria,
    categoriaPersonalizadaId,
    preco: Number(document.getElementById('campo-preco').value) || 0,
    // Produto composto não tem estoque próprio (a venda baixa os itens): nasce com 0.
    quantidadeEstoque: ehCombo || ehComposto ? 0 : Math.max(0, Number(document.getElementById('campo-estoque').value) || 0),
    descricao: document.getElementById('campo-descricao').value.trim(),
    foto: fotoParaSalvar,
    status: document.getElementById('campo-status').value,
    stockMode: ehComposto ? 'untracked' : document.getElementById('campo-origem-estoque').value,
    comboConfig: ehCombo
      ? {
          ordem: Math.max(0, Number(document.getElementById('campo-ordem').value) || 0),
          allowedSkewers: Math.max(1, Number(document.getElementById('campo-qtd-espetos').value) || 1),
          allowedSides: Math.max(0, Number(document.getElementById('campo-qtd-acompanhamentos').value) || 0),
          includedItems: lerItensInclusosMarcados(),
          skewerExtraPrices: lerAcrescimosOpcoesPreenchidos('espetos'),
          sideExtraPrices: lerAcrescimosOpcoesPreenchidos('acompanhamentos'),
        }
      : null,
  };

  if (id) produto.id = id;

  let salvo;
  try {
    salvo = await salvarProduto(produto);
  } catch (erro) {
    // Produto NÃO foi salvo. Se um upload novo rodou acima, ele ficou órfão — remove só
    // ele (pelo path exato que o upload retornou, nunca por adivinhação) e nunca mexe na
    // foto antiga, que continua sendo a verdade no banco.
    if (novoUploadPath) {
      try {
        await excluirFotoProdutoPorPath(novoUploadPath);
      } catch (erroLimpeza) {
        console.warn('Falha ao limpar foto órfã após erro ao salvar produto:', erroLimpeza);
      }
    }
    mostrarToast('Não foi possível salvar o produto. ' + erro.message, 'erro');
    return;
  }

  // Produto salvo com sucesso — só agora é seguro excluir a foto antiga (se ela existia e
  // foi de fato trocada/removida agora). Falha aqui NUNCA desfaz o produto nem apaga a
  // foto nova: o produto já está correto, o único risco é um arquivo antigo órfão.
  if ((novoUploadPath || fotoRemovida) && fotoAtualUrl && fotoAtualUrl !== fotoParaSalvar) {
    try {
      await excluirFotoProdutoSeForStorage(fotoAtualUrl);
    } catch (erroLimpezaAntiga) {
      console.warn('Produto salvo, mas não foi possível excluir a foto antiga (pode ter ficado órfã):', erroLimpezaAntiga);
    }
  }

  // Fase C — porção (g) dos acompanhamentos: RPC própria (set_product_portion). Falha aqui
  // não desfaz o produto já salvo; só avisa.
  if (categoria === 'Acompanhamentos' && salvo && salvo.id) {
    const porcaoDigitada = document.getElementById('campo-porcao').value;
    const anterior = id ? (obterProdutoPorId(id) || {}).porcaoGramas : null;
    if (String(porcaoDigitada || '') !== String(anterior ?? '')) {
      try {
        await definirPorcaoProdutoNoSupabase(salvo.id, porcaoDigitada || null);
        await carregarProdutosCache();
      } catch (erroPorcao) {
        mostrarToast('Produto salvo, mas a porção não foi gravada. ' + erroPorcao.message, 'erro');
      }
    }
  }

  // Custo: gravado à parte em product_costs, nunca dentro do payload de products (ver
  // product-costs-service.js). Combo nunca grava custo fixo aqui — o campo já vem
  // sempre limpo/desabilitado nesse caso (atualizarEstadoCampoCusto()). Espetinho
  // TAMBÉM nunca grava custo por aqui — decisão de negócio: custo de espeto só entra
  // em product_costs pelo botão "Aplicar custo ao produto" da Produção de Espetos
  // (js/producao.js). Esta guarda é defesa extra além do campo desabilitado na tela —
  // mesmo que #campo-custo seja reabilitado via DevTools e um valor digitado, este
  // handler nunca envia esse valor pra Espetinho. Não fecha sozinha o caminho de
  // alguém chamar salvarCustoProdutoNoSupabase()/product_costs direto pelo console —
  // isso exigiria mudança de RLS/RPC no banco, fora de escopo desta rodada (documentado
  // no diagnóstico, não implementado automaticamente). Produto novo com o campo vazio
  // não precisa criar linha nenhuma; editando um produto existente, sempre grava —
  // inclusive vazio, pra realmente limpar um custo que já estava cadastrado (senão o
  // valor antigo ficaria "preso" no banco enquanto a tela mostraria "Não cadastrado").
  // Composição: RPC própria (set_product_components), só quando mudou. Falha aqui não desfaz o
  // produto já salvo; avisa (o produto fica com a composição anterior, que é a verdade no banco).
  let avisoComposicao = '';
  if (usaComposicao && salvo && salvo.id && !mesmaComposicao(composicaoAnterior, composicao)) {
    try {
      await salvarComposicaoProdutoNoSupabase(salvo.id, composicao);
    } catch (erroComposicao) {
      avisoComposicao = 'Produto salvo, mas "Consome do estoque" não foi gravado. ' + erroComposicao.message;
    }
    try {
      await carregarProdutosCache();
    } catch (erroRecarregar) {
      console.error('Erro ao recarregar produtos após gravar a composição:', erroRecarregar);
    }
  }

  // Adicionais oferecidos: RPC própria (set_product_addon_links), só quando mudou.
  let avisoAdicionais = '';
  if (usaAdicionais && salvo && salvo.id && adicionaisIds.slice().sort().join('|') !== adicionaisAnteriores.slice().sort().join('|')) {
    try {
      await salvarAdicionaisDoProdutoNoSupabase(salvo.id, adicionaisIds);
    } catch (erroAdicionais) {
      avisoAdicionais = 'Produto salvo, mas os adicionais não foram gravados. ' + erroAdicionais.message;
    }
    try {
      await carregarProdutosCache();
    } catch (erroRecarregar) {
      console.error('Erro ao recarregar produtos após gravar os adicionais:', erroRecarregar);
    }
  }

  let avisoCusto = '';
  if (!ehCombo && !ehEspetinho && souAdmin) {
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

  const aviso = avisoComposicao || avisoAdicionais || avisoCusto;
  mostrarToast(aviso || (id ? 'Produto atualizado.' : 'Produto cadastrado.'), aviso ? 'erro' : 'sucesso');
  fecharModal();
  preencherFiltroCategorias(); // ex.: o último produto saiu de "Outro" -> some do filtro
  renderizarLista();
}
