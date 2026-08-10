/*
 * estoque.js
 * Lógica da tela de Estoque: cartões-resumo, listagem com filtro por
 * alerta e modal de ajuste (entrada/saída/definir total).
 * Depende de storage.js e utils.js.
 */

let tipoAjusteSelecionado = 'entrada';
let produtoEmAjuste = null;

document.addEventListener('DOMContentLoaded', async () => {
  const carregando = document.getElementById('estado-carregando-estoque');
  const erro = document.getElementById('estado-erro-estoque');
  try {
    await carregarProdutosCache();
  } catch (erroCarregamento) {
    console.error('Erro ao carregar produtos:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os produtos. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  renderizarResumoEstoque();
  renderizarTabelaEstoque();
  ligarEventosFiltrosEstoque();
  ligarEventosModalEstoque();
});

function renderizarResumoEstoque() {
  const moeda = obterConfiguracoes().moeda;
  document.getElementById('resumo-valor-total').textContent = formatarMoeda(obterValorTotalEstoque(), moeda);
  document.getElementById('resumo-estoque-baixo').textContent = obterProdutosEstoqueBaixo().length;
  document.getElementById('resumo-sem-estoque').textContent = obterProdutosSemEstoque().length;
}

function renderizarTabelaEstoque() {
  const termo = document.getElementById('campo-pesquisa-estoque').value.trim();
  const alerta = document.getElementById('filtro-alerta-estoque').value;
  const moeda = obterConfiguracoes().moeda;

  let produtos = pesquisarProdutos({ termo });
  if (alerta) produtos = produtos.filter((p) => calcularStatusEstoque(p.quantidadeEstoque) === alerta);
  produtos = produtos.sort((a, b) => a.nome.localeCompare(b.nome));

  const corpo = document.getElementById('corpo-tabela-estoque');
  const estadoVazio = document.getElementById('estado-vazio-estoque');

  if (produtos.length === 0) {
    corpo.innerHTML = '';
    estadoVazio.style.display = 'block';
    return;
  }
  estadoVazio.style.display = 'none';

  corpo.innerHTML = produtos.map((p) => linhaEstoqueHtml(p, moeda)).join('');

  corpo.querySelectorAll('[data-acao]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalEstoque(botao.dataset.id, botao.dataset.acao));
  });
}

function linhaEstoqueHtml(produto, moeda) {
  const foto = produto.foto
    ? `<img class="miniatura-estoque" src="${produto.foto}" alt="${escaparHtml(produto.nome)}" />`
    : `<div class="miniatura-estoque-vazia">🍢</div>`;

  const status = calcularStatusEstoque(produto.quantidadeEstoque);
  const valorEmEstoque = produto.quantidadeEstoque * produto.preco;

  return `
    <tr>
      <td>${foto}</td>
      <td>${escaparHtml(produto.nome)}</td>
      <td>${escaparHtml(produto.categoria)}</td>
      <td>${formatarMoeda(produto.preco, moeda)}</td>
      <td><strong>${produto.quantidadeEstoque}</strong></td>
      <td><span class="badge badge-${status}" title="${rotuloStatusEstoque(status)}">${rotuloStatusEstoque(status)}</span></td>
      <td>${formatarMoeda(valorEmEstoque, moeda)}</td>
      <td>
        <div class="acoes-linha-estoque">
          <button class="btn-icone" data-acao="entrada" data-id="${produto.id}" title="Adicionar estoque">➕</button>
          <button class="btn-icone" data-acao="saida" data-id="${produto.id}" title="Retirar estoque">➖</button>
          <button class="btn-icone" data-acao="ajuste" data-id="${produto.id}" title="Definir quantidade total">✏️</button>
        </div>
      </td>
    </tr>`;
}

function ligarEventosFiltrosEstoque() {
  document.getElementById('campo-pesquisa-estoque').addEventListener('input', debounce(renderizarTabelaEstoque, 250));
  document.getElementById('filtro-alerta-estoque').addEventListener('change', renderizarTabelaEstoque);
}

// ---------------------------------------------------------------------------
// Modal de ajuste
// ---------------------------------------------------------------------------

function ligarEventosModalEstoque() {
  document.querySelectorAll('.opcao-tipo-ajuste').forEach((botao) => {
    botao.addEventListener('click', () => selecionarTipoAjuste(botao.dataset.tipo));
  });

  document.getElementById('campo-quantidade-ajuste').addEventListener('input', atualizarPreviewNovoEstoque);
  document.getElementById('botao-fechar-modal-estoque').addEventListener('click', fecharModalEstoque);
  document.getElementById('botao-cancelar-ajuste-estoque').addEventListener('click', fecharModalEstoque);
  document.getElementById('modal-overlay-estoque').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-estoque') fecharModalEstoque();
  });
  document.getElementById('form-ajuste-estoque').addEventListener('submit', salvarAjusteEstoque);
}

function abrirModalEstoque(produtoId, tipoInicial) {
  produtoEmAjuste = obterProdutoPorId(produtoId);
  if (!produtoEmAjuste) return;

  document.getElementById('campo-produto-id-estoque').value = produtoEmAjuste.id;
  document.getElementById('produto-selecionado-nome').textContent = produtoEmAjuste.nome;
  document.getElementById('produto-selecionado-atual').textContent = `Estoque atual: ${produtoEmAjuste.quantidadeEstoque} unidades`;
  document.getElementById('campo-quantidade-ajuste').value = '';
  document.getElementById('campo-observacao-ajuste').value = '';

  selecionarTipoAjuste(tipoInicial || 'entrada');
  document.getElementById('modal-overlay-estoque').classList.add('modal-visivel');
}

function fecharModalEstoque() {
  document.getElementById('modal-overlay-estoque').classList.remove('modal-visivel');
  produtoEmAjuste = null;
}

function selecionarTipoAjuste(tipo) {
  tipoAjusteSelecionado = tipo;
  document.querySelectorAll('.opcao-tipo-ajuste').forEach((b) => b.classList.toggle('selecionada', b.dataset.tipo === tipo));

  const rotulos = { entrada: 'Quantidade a adicionar', saida: 'Quantidade a retirar', ajuste: 'Nova quantidade total' };
  document.getElementById('rotulo-quantidade-ajuste').textContent = rotulos[tipo];
  document.getElementById('titulo-modal-estoque').textContent =
    tipo === 'entrada' ? 'Adicionar Estoque' : tipo === 'saida' ? 'Retirar Estoque' : 'Definir Quantidade Total';

  atualizarPreviewNovoEstoque();
}

function atualizarPreviewNovoEstoque() {
  const preview = document.getElementById('preview-novo-estoque');
  if (!produtoEmAjuste) {
    preview.textContent = '';
    return;
  }
  const valor = Math.max(0, Math.floor(Number(document.getElementById('campo-quantidade-ajuste').value)) || 0);
  const atual = produtoEmAjuste.quantidadeEstoque;

  let novoEstoque = atual;
  if (tipoAjusteSelecionado === 'entrada') novoEstoque = atual + valor;
  else if (tipoAjusteSelecionado === 'saida') novoEstoque = Math.max(0, atual - valor);
  else novoEstoque = valor;

  preview.textContent = `Estoque após o ajuste: ${novoEstoque} unidades`;
}

async function salvarAjusteEstoque(evento) {
  evento.preventDefault();
  if (!produtoEmAjuste) return;

  const quantidade = Math.floor(Number(document.getElementById('campo-quantidade-ajuste').value));
  if (isNaN(quantidade) || quantidade < 0) {
    mostrarToast('Informe uma quantidade válida.', 'erro');
    return;
  }

  const observacao = document.getElementById('campo-observacao-ajuste').value.trim();

  try {
    await ajustarEstoque(produtoEmAjuste.id, { tipo: tipoAjusteSelecionado, quantidade, observacao });
  } catch (erro) {
    mostrarToast('Não foi possível atualizar o estoque. ' + erro.message, 'erro');
    return;
  }

  mostrarToast('Estoque atualizado.', 'sucesso');
  fecharModalEstoque();
  renderizarResumoEstoque();
  renderizarTabelaEstoque();
}
