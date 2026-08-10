/*
 * configuracoes.js
 * Tela de Configurações: nome do food truck, moeda e taxa de entrega.
 * Depende de storage.js e utils.js.
 */

document.addEventListener('DOMContentLoaded', () => {
  preencherFormulario();
  document.getElementById('form-configuracoes').addEventListener('submit', salvarFormularioConfiguracoes);
  document.getElementById('campo-modo-escuro').addEventListener('change', alternarModoEscuro);
});

function preencherFormulario() {
  const config = obterConfiguracoes();
  document.getElementById('campo-nome-foodtruck').value = config.nomeFoodTruck;
  document.getElementById('campo-moeda').value = config.moeda;
  document.getElementById('campo-taxa-entrega').value = config.taxaEntrega;
  document.getElementById('campo-modo-escuro').checked = config.tema === 'escuro';
}

/** Aplica e salva o tema imediatamente ao ligar/desligar o toggle (não espera o Salvar) */
function alternarModoEscuro(evento) {
  const tema = evento.target.checked ? 'escuro' : 'claro';
  aplicarTema(tema);
  salvarConfiguracoes({ tema });
}

function salvarFormularioConfiguracoes(evento) {
  evento.preventDefault();

  const nomeFoodTruck = document.getElementById('campo-nome-foodtruck').value.trim();
  if (!nomeFoodTruck) {
    mostrarToast('Informe o nome do food truck.', 'erro');
    return;
  }

  salvarConfiguracoes({
    nomeFoodTruck,
    moeda: document.getElementById('campo-moeda').value,
    taxaEntrega: Math.max(0, Number(document.getElementById('campo-taxa-entrega').value) || 0),
  });

  mostrarToast('Configurações salvas.', 'sucesso');
}
