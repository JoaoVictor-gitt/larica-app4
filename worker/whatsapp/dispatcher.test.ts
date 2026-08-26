// Casos de teste estáticos de resolveProductReference (W6.7). Mesmo
// padrão autocontido de parser.test.ts/replies.test.ts —
// runDispatcherTests() disponível pra execução manual futura, não
// plugada a nenhum runner/CI.

import { resolveProductReference } from './dispatcher';

const MENU_TESTE: Record<string, unknown>[] = [
  { product_id: 'id-frango', name: 'Frango', category: 'skewers', price: 5, is_available: true },
  { product_id: 'id-frango-2', name: 'frango', category: 'skewers', price: 5, is_available: true }, // duplicado deliberado p/ testar ambiguidade
  { product_id: 'id-coca', name: 'Coca-Cola', category: 'drinks', price: 2, is_available: false },
  { product_id: 'id-combo', name: 'Larica Individual', category: 'combos', price: 12, is_available: true },
];

interface CasoResolucao {
  descricao: string;
  itemName: string;
  menu: Record<string, unknown>[];
  esperadoOk: boolean;
  esperadoReason?: 'product_not_found' | 'product_ambiguous' | 'product_unavailable' | 'combo_not_supported';
}

const CASOS: CasoResolucao[] = [
  {
    descricao: 'match exato normalizado (acento/caixa)',
    itemName: 'CÔCA-cola',
    menu: [{ product_id: 'x', name: 'Coca-Cola', category: 'drinks', price: 2, is_available: true }],
    esperadoOk: true,
  },
  {
    descricao: 'produto inexistente',
    itemName: 'Pizza',
    menu: MENU_TESTE,
    esperadoOk: false,
    esperadoReason: 'product_not_found',
  },
  {
    descricao: 'produto ambíguo (2 candidatos normalizam igual)',
    itemName: 'frango',
    menu: MENU_TESTE,
    esperadoOk: false,
    esperadoReason: 'product_ambiguous',
  },
  {
    descricao: 'produto indisponível',
    itemName: 'Coca-Cola',
    menu: MENU_TESTE,
    esperadoOk: false,
    esperadoReason: 'product_unavailable',
  },
  {
    descricao: 'combo não suportado',
    itemName: 'Larica Individual',
    menu: MENU_TESTE,
    esperadoOk: false,
    esperadoReason: 'combo_not_supported',
  },
];

export function runDispatcherTests(): { total: number; falhas: string[] } {
  const falhas: string[] = [];

  for (const caso of CASOS) {
    const resultado = resolveProductReference(caso.itemName, caso.menu);

    if (resultado.ok !== caso.esperadoOk) {
      falhas.push(`${caso.descricao}: esperado ok=${caso.esperadoOk}, obtido ok=${resultado.ok}`);
      continue;
    }

    if (!resultado.ok && caso.esperadoReason && resultado.reason !== caso.esperadoReason) {
      falhas.push(`${caso.descricao}: esperado reason="${caso.esperadoReason}", obtido "${resultado.reason}"`);
    }
  }

  // Nunca fuzzy-match: "frang" (incompleto) não deve casar com "Frango".
  {
    const resultado = resolveProductReference('frang', MENU_TESTE);
    if (resultado.ok) {
      falhas.push(`match parcial indevido: "frang" não deveria casar com "Frango" (fuzzy-match proibido)`);
    }
  }

  return { total: CASOS.length + 1, falhas };
}
