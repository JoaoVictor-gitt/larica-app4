/*
 * producao.js
 * Lógica da área Produção — Etapa 1: só a aba Ingredientes é funcional
 * (Fichas Técnicas é um placeholder "Em breve", sem CRUD, sem Supabase).
 * Depende de utils.js e js/services/ingredients-service.js.
 *
 * souAdminProducao decide só a edição (criar/editar/ativar/desativar) —
 * visualização já é liberada pra qualquer staff que acesse esta página; a
 * barreira real de escrita é o RLS de ingredients (admin-only). Diferente
 * do caso de Meta de Preparo (onde a RLS real não distinguia admin de
 * employee e a UI teve que ser corrigida pra não fingir uma restrição que
 * o banco não tinha): aqui a RLS realmente distingue, então a UI pode e
 * deve espelhar essa restrição.
 */

const FATORES_CONVERSAO_UNIDADE_INGREDIENTE = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 };
const UNIDADES_COMPRA_POR_TIPO_INGREDIENTE = { peso: ['kg', 'g'], volume: ['L', 'ml'], contagem: ['un'] };
const UNIDADE_BASE_POR_TIPO_INGREDIENTE = { peso: 'g', volume: 'ml', contagem: 'un' };

let ingredientesCache = [];
let souAdminProducao = false;

document.addEventListener('DOMContentLoaded', async () => {
  ligarEventosNavegacaoProducao();

  const carregando = document.getElementById('estado-carregando-ingredientes');
  const erro = document.getElementById('estado-erro-ingredientes');

  try {
    const [ingredientes, ehAdmin] = await Promise.all([buscarIngredientesDoSupabase(), usuarioEhAdminNoSupabase()]);
    ingredientesCache = ingredientes;
    souAdminProducao = ehAdmin;
  } catch (erroCarregamento) {
    console.error('Erro ao carregar ingredientes:', erroCarregamento);
    carregando.style.display = 'none';
    erro.textContent = 'Não foi possível carregar os ingredientes. ' + erroCarregamento.message;
    erro.style.display = 'block';
    return;
  }
  carregando.style.display = 'none';

  atualizarEstadoEdicaoIngredientes();
  renderizarTabelaIngredientes();
  ligarEventosModalIngrediente();
});

// ---------------------------------------------------------------------------
// Navegação (central de Produção <-> seções, mesmo padrão de configuracoes.js)
// ---------------------------------------------------------------------------

function ligarEventosNavegacaoProducao() {
  document.querySelectorAll('[data-producao-abrir]').forEach((botao) => {
    botao.addEventListener('click', () => abrirSecaoProducao(botao.dataset.producaoAbrir));
  });
  document.querySelectorAll('[data-producao-voltar]').forEach((botao) => {
    botao.addEventListener('click', fecharSecaoProducao);
  });
}

function abrirSecaoProducao(chave) {
  document.getElementById('producao-central').style.display = 'none';
  document.querySelectorAll('.producao-secao').forEach((secao) => {
    secao.classList.toggle('producao-secao-ativa', secao.dataset.producaoSecao === chave);
  });
}

function fecharSecaoProducao() {
  document.querySelectorAll('.producao-secao').forEach((secao) => secao.classList.remove('producao-secao-ativa'));
  document.getElementById('producao-central').style.display = '';
}

// ---------------------------------------------------------------------------
// Admin x staff — reflete a RLS real (só admin escreve)
// ---------------------------------------------------------------------------

function atualizarEstadoEdicaoIngredientes() {
  const botaoNovo = document.getElementById('botao-novo-ingrediente');
  const dica = document.getElementById('dica-ingredientes-somente-admin');
  botaoNovo.disabled = !souAdminProducao;
  dica.style.display = souAdminProducao ? 'none' : '';
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

/** "€0,001600/g" — mais casas decimais do que formatarMoeda (2) permite, então é um formatador próprio. */
function formatarCustoBaseIngrediente(valor, unidadeBase) {
  if (valor === null || !Number.isFinite(valor)) return '—';
  return '€' + valor.toFixed(6).replace('.', ',') + '/' + unidadeBase;
}

/** "5 kg" / "24 un" — quantidade comprada como foi digitada, sem casas decimais desnecessárias. */
function formatarQuantidadeCompraIngrediente(ingrediente) {
  const quantidade = ingrediente.quantidadeCompraExibicao;
  const texto = Number.isInteger(quantidade) ? String(quantidade) : String(quantidade).replace('.', ',');
  return `${texto} ${ingrediente.unidadeCompraExibicao}`;
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

function renderizarTabelaIngredientes() {
  const corpo = document.getElementById('corpo-tabela-ingredientes');
  const vazio = document.getElementById('estado-vazio-ingredientes');

  if (ingredientesCache.length === 0) {
    corpo.innerHTML = '';
    vazio.style.display = 'block';
    return;
  }
  vazio.style.display = 'none';

  corpo.innerHTML = ingredientesCache.map(linhaIngredienteHtml).join('');

  corpo.querySelectorAll('[data-acao-editar]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalIngrediente(botao.dataset.acaoEditar));
  });
}

function linhaIngredienteHtml(ingrediente) {
  return `
    <tr>
      <td>${escaparHtml(ingrediente.nome)}</td>
      <td>${escaparHtml(formatarQuantidadeCompraIngrediente(ingrediente))}</td>
      <td>${formatarMoeda(ingrediente.precoCompra)}</td>
      <td>${formatarCustoBaseIngrediente(ingrediente.custoPorUnidadeBase, ingrediente.unidadeBase)}</td>
      <td>${ingrediente.categoria ? escaparHtml(ingrediente.categoria) : '—'}</td>
      <td>${formatarData(ingrediente.atualizadoEm)}</td>
      <td><span class="badge badge-${ingrediente.ativo ? 'ativo' : 'inativo'}">${ingrediente.ativo ? 'Ativo' : 'Inativo'}</span></td>
      <td>
        <button class="btn-icone" data-acao-editar="${ingrediente.id}" title="Editar" ${souAdminProducao ? '' : 'disabled'}>✏️</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// Unidades — dropdown de unidade filtrado pelo tipo selecionado
// ---------------------------------------------------------------------------

function atualizarOpcoesUnidadeIngrediente() {
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const selectUnidade = document.getElementById('campo-unidade-ingrediente');
  const unidadeAtual = selectUnidade.value;
  const opcoes = UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[tipo] || [];

  selectUnidade.innerHTML = opcoes.map((u) => `<option value="${u}">${u}</option>`).join('');
  selectUnidade.value = opcoes.includes(unidadeAtual) ? unidadeAtual : opcoes[0];
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function ligarEventosModalIngrediente() {
  document.getElementById('botao-novo-ingrediente').addEventListener('click', abrirModalNovoIngrediente);
  document.getElementById('botao-fechar-modal-ingrediente').addEventListener('click', fecharModalIngrediente);
  document.getElementById('botao-cancelar-ingrediente').addEventListener('click', fecharModalIngrediente);
  document.getElementById('modal-overlay-ingrediente').addEventListener('click', (evento) => {
    if (evento.target.id === 'modal-overlay-ingrediente') fecharModalIngrediente();
  });

  document.getElementById('campo-tipo-ingrediente').addEventListener('change', () => {
    atualizarOpcoesUnidadeIngrediente();
    atualizarPreviewCustoIngrediente();
  });
  document.getElementById('campo-quantidade-ingrediente').addEventListener('input', atualizarPreviewCustoIngrediente);
  document.getElementById('campo-unidade-ingrediente').addEventListener('change', atualizarPreviewCustoIngrediente);
  document.getElementById('campo-preco-ingrediente').addEventListener('input', atualizarPreviewCustoIngrediente);

  document.getElementById('campo-embalagens-qtd').addEventListener('input', aplicarConvenienciaEmbalagem);
  document.getElementById('campo-embalagens-tamanho').addEventListener('input', aplicarConvenienciaEmbalagem);

  document.getElementById('form-ingrediente').addEventListener('submit', salvarFormularioIngrediente);
}

/** Multiplica embalagens × tamanho e preenche a Quantidade comprada — puramente uma conveniência de formulário, nada disso é enviado ao banco. */
function aplicarConvenienciaEmbalagem() {
  const qtdEmbalagens = Number(document.getElementById('campo-embalagens-qtd').value);
  const tamanhoEmbalagem = Number(document.getElementById('campo-embalagens-tamanho').value);

  if (Number.isFinite(qtdEmbalagens) && qtdEmbalagens > 0 && Number.isFinite(tamanhoEmbalagem) && tamanhoEmbalagem > 0) {
    document.getElementById('campo-quantidade-ingrediente').value = qtdEmbalagens * tamanhoEmbalagem;
    atualizarPreviewCustoIngrediente();
  }
}

function atualizarPreviewCustoIngrediente() {
  const preview = document.getElementById('preview-custo-ingrediente');
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const quantidade = Number(document.getElementById('campo-quantidade-ingrediente').value);
  const unidade = document.getElementById('campo-unidade-ingrediente').value;
  const preco = Number(document.getElementById('campo-preco-ingrediente').value);

  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
  const unidadeBase = UNIDADE_BASE_POR_TIPO_INGREDIENTE[tipo];

  if (!Number.isFinite(quantidade) || quantidade <= 0 || !fator || !Number.isFinite(preco) || preco < 0) {
    preview.textContent = '';
    return;
  }

  const quantidadeBase = quantidade * fator;
  const custoBase = preco / quantidadeBase;
  const quantidadeTexto = Number.isInteger(quantidade) ? quantidade : quantidade.toString().replace('.', ',');
  const quantidadeBaseTexto = Number.isInteger(quantidadeBase) ? quantidadeBase : quantidadeBase.toFixed(3).replace('.', ',');

  preview.textContent = `${quantidadeTexto} ${unidade} = ${quantidadeBaseTexto} ${unidadeBase} · Custo: ${formatarCustoBaseIngrediente(custoBase, unidadeBase)}`;
}

function abrirModalNovoIngrediente() {
  if (!souAdminProducao) return;

  document.getElementById('titulo-modal-ingrediente').textContent = 'Novo Ingrediente';
  document.getElementById('campo-id-ingrediente').value = '';
  document.getElementById('campo-nome-ingrediente').value = '';
  document.getElementById('campo-tipo-ingrediente').value = 'peso';
  document.getElementById('campo-quantidade-ingrediente').value = '';
  document.getElementById('campo-embalagens-qtd').value = '';
  document.getElementById('campo-embalagens-tamanho').value = '';
  document.getElementById('campo-preco-ingrediente').value = '';
  document.getElementById('campo-categoria-ingrediente').value = '';
  document.getElementById('campo-status-ingrediente').value = 'ativo';
  document.getElementById('dica-ingrediente-erro').style.display = 'none';

  atualizarOpcoesUnidadeIngrediente();
  atualizarPreviewCustoIngrediente();
  abrirModal('modal-overlay-ingrediente');
}

function abrirModalIngrediente(id) {
  if (!souAdminProducao) return;
  const ingrediente = ingredientesCache.find((i) => i.id === id);
  if (!ingrediente) return;

  document.getElementById('titulo-modal-ingrediente').textContent = 'Editar Ingrediente';
  document.getElementById('campo-id-ingrediente').value = ingrediente.id;
  document.getElementById('campo-nome-ingrediente').value = ingrediente.nome;
  document.getElementById('campo-tipo-ingrediente').value = ingrediente.tipoUnidade;
  atualizarOpcoesUnidadeIngrediente();
  document.getElementById('campo-unidade-ingrediente').value = ingrediente.unidadeCompraExibicao;
  document.getElementById('campo-quantidade-ingrediente').value = ingrediente.quantidadeCompraExibicao;
  document.getElementById('campo-embalagens-qtd').value = '';
  document.getElementById('campo-embalagens-tamanho').value = '';
  document.getElementById('campo-preco-ingrediente').value = ingrediente.precoCompra;
  document.getElementById('campo-categoria-ingrediente').value = ingrediente.categoria || '';
  document.getElementById('campo-status-ingrediente').value = ingrediente.ativo ? 'ativo' : 'inativo';
  document.getElementById('dica-ingrediente-erro').style.display = 'none';

  atualizarPreviewCustoIngrediente();
  abrirModal('modal-overlay-ingrediente');
}

function fecharModalIngrediente() {
  fecharModal('modal-overlay-ingrediente');
}

function abrirModal(idOverlay) {
  document.getElementById(idOverlay).classList.add('modal-visivel');
}

function fecharModal(idOverlay) {
  document.getElementById(idOverlay).classList.remove('modal-visivel');
}

// ---------------------------------------------------------------------------
// Validação e salvamento
// ---------------------------------------------------------------------------

/** Espelha no cliente os CHECKs do banco, só pra feedback mais rápido — o banco continua a fonte real. */
function validarFormularioIngrediente({ nome, tipo, quantidade, unidade, preco }) {
  if (!nome) return 'Informe o nome do ingrediente.';
  if (!['peso', 'volume', 'contagem'].includes(tipo)) return 'Tipo inválido.';
  if (!Number.isFinite(quantidade) || quantidade <= 0) return 'Informe uma quantidade comprada maior que zero.';
  if (!UNIDADES_COMPRA_POR_TIPO_INGREDIENTE[tipo].includes(unidade)) return 'Unidade incompatível com o tipo selecionado.';
  if (!Number.isFinite(preco) || preco < 0) return 'Informe um preço pago válido (não pode ser negativo).';
  return null;
}

async function salvarFormularioIngrediente(evento) {
  evento.preventDefault();
  if (!souAdminProducao) return;

  const id = document.getElementById('campo-id-ingrediente').value;
  const nome = document.getElementById('campo-nome-ingrediente').value.trim();
  const tipo = document.getElementById('campo-tipo-ingrediente').value;
  const quantidade = Number(document.getElementById('campo-quantidade-ingrediente').value);
  const unidade = document.getElementById('campo-unidade-ingrediente').value;
  const preco = Number(document.getElementById('campo-preco-ingrediente').value);
  const categoria = document.getElementById('campo-categoria-ingrediente').value.trim();
  const ativo = document.getElementById('campo-status-ingrediente').value === 'ativo';

  const erroValidacao = validarFormularioIngrediente({ nome, tipo, quantidade, unidade, preco });
  const dicaErro = document.getElementById('dica-ingrediente-erro');
  if (erroValidacao) {
    dicaErro.textContent = erroValidacao;
    dicaErro.style.display = '';
    return;
  }
  dicaErro.style.display = 'none';

  const fator = FATORES_CONVERSAO_UNIDADE_INGREDIENTE[unidade];
  const dados = {
    nome,
    tipoUnidade: tipo,
    unidadeBase: UNIDADE_BASE_POR_TIPO_INGREDIENTE[tipo],
    quantidadeCompraExibicao: quantidade,
    unidadeCompraExibicao: unidade,
    quantidadeBaseCompra: quantidade * fator,
    precoCompra: preco,
    categoria,
    ativo,
  };

  try {
    if (id) {
      await atualizarIngredienteNoSupabase(id, dados);
    } else {
      await criarIngredienteNoSupabase(dados);
    }
  } catch (erro) {
    mostrarToast('Não foi possível salvar o ingrediente. ' + erro.message, 'erro');
    return;
  }

  mostrarToast('Ingrediente salvo.', 'sucesso');
  fecharModalIngrediente();

  try {
    ingredientesCache = await buscarIngredientesDoSupabase();
  } catch (erroRecarregar) {
    console.error('Erro ao recarregar ingredientes:', erroRecarregar);
  }
  renderizarTabelaIngredientes();
}
