-- Compras + Lotes + Estoque por Lote — ETAPA B (suppliers + purchases +
-- purchase_lines, sem lots/lot_movements ainda). Registra o CABEÇALHO de
-- uma compra real (fornecedor opcional, data, referência) e suas LINHAS
-- (cada linha é um purchase_item comprado, com quantidade/unidade/preço).
-- Ainda NÃO gera lote nem altera estoque — isso é a Etapa C/D.
--
-- Sem RPC nesta etapa: as 3 tabelas recebem GRANT direto pra authenticated
-- sob RLS (mesmo padrão já usado em purchase_items/ingredients/
-- production_supplies — cadastros simples, sem validação estrutural
-- cruzada que hoje exigiria uma RPC). Uma futura RPC save_purchase(...)
-- (Etapa D) deverá centralizar a escrita: calcular base_quantity
-- server-side a partir de quantity+unit+purchase_items.base_unit
-- (conversões g→g / kg→g×1000 / ml→ml / l→ml×1000 / un→un — nunca
-- peso<->volume<->unidade), popular item_name_snapshot automaticamente a
-- partir de purchase_items.name, e (já com lots existindo) gerar os lotes
-- correspondentes numa única transação. Até essa RPC existir, quem
-- inserir direto (só admin, via RLS) é responsável por preencher
-- base_quantity/item_name_snapshot corretamente.
--
-- NÃO altera: purchase_items (migration da Etapa A não editada), products,
-- ingredients, production_supplies, stock_movements, create_customer_order,
-- pedidos, produção, estoque atual. Sem lots, sem lot_movements, sem RPC,
-- sem UI.

-- =============================================================
-- 1. Tabela suppliers.
-- Sem UNIQUE de nome — "Tesco"/"Tesco Wholesale"/"Tesco - outra unidade"
-- são fornecedores distintos válidos.
-- =============================================================

CREATE TABLE public.suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  contact_name  text NULL,
  phone         text NULL,
  email         text NULL,
  notes         text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NULL,
  updated_by    uuid NULL,

  CONSTRAINT suppliers_name_nao_vazio CHECK (length(trim(name)) > 0)
);

CREATE INDEX idx_suppliers_active ON public.suppliers (active);

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY suppliers_select_staff ON public.suppliers
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY suppliers_insert_admin ON public.suppliers
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY suppliers_update_admin ON public.suppliers
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY suppliers_delete_admin ON public.suppliers
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL PRIVILEGES ON TABLE public.suppliers FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.suppliers FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.suppliers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.suppliers TO authenticated;

-- =============================================================
-- 2. Tabela purchases — cabeçalho da compra.
-- supplier_id nullable (compra sem fornecedor cadastrado é válida), sem
-- ON DELETE CASCADE (excluir fornecedor referenciado falha por FK; fluxo
-- normal é active=false). purchased_at é date, não timestamptz — mesma
-- razão já usada em todos os lotes de produção: a compra pertence a um
-- dia, sem necessidade da camada de conversão de fuso horário usada em
-- pedidos/relatórios. reference é texto livre (nota/invoice/recibo), sem
-- formato imposto.
-- =============================================================

CREATE TABLE public.purchases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NULL REFERENCES public.suppliers(id),
  purchased_at date NOT NULL,
  reference    text NULL,
  notes        text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NULL,
  updated_by   uuid NULL
);

CREATE INDEX idx_purchases_purchased_at ON public.purchases (purchased_at);
CREATE INDEX idx_purchases_supplier_id  ON public.purchases (supplier_id);

ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchases_select_staff ON public.purchases
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY purchases_insert_admin ON public.purchases
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY purchases_update_admin ON public.purchases
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY purchases_delete_admin ON public.purchases
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL PRIVILEGES ON TABLE public.purchases FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.purchases FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.purchases FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.purchases TO authenticated;

-- =============================================================
-- 3. Tabela purchase_lines — cada linha é um purchase_item comprado numa
-- purchase específica. purchase_id ... ON DELETE CASCADE (enquanto não há
-- lots, excluir a compra some com suas linhas; a restrição histórica só
-- entra quando lots existir e alguma linha já tiver gerado consumo).
-- purchase_item_id SEM cascade (excluir item referenciado falha por FK;
-- fluxo normal é active=false). Sem UNIQUE(purchase_id, purchase_item_id)
-- — o mesmo item pode aparecer duas vezes na mesma compra (embalagens/
-- preços diferentes na mesma nota), cada linha podendo futuramente gerar
-- seu próprio lote. unit_cost_base é GERADA (total_price / base_quantity)
-- — nunca digitada, nunca divide por zero (base_quantity > 0 já garantido
-- pelo CHECK); total_price = 0 produz unit_cost_base = 0, válido (amostra/
-- brinde). Sem price_per_kg/price_per_liter/price_per_unit — unit_cost_base
-- já resolve tudo, formatação fica pra UI futura. Sem coluna category —
-- vem de purchase_items, nunca duplicada.
--
-- item_name_snapshot congela o nome do purchase_item no momento da compra
-- (mesma disciplina já usada em skewer_batch_components.name_snapshot/
-- side_batch_components.name_snapshot) — se o nome do item mestre mudar
-- depois, a compra histórica continua mostrando o nome usado na hora.
-- =============================================================

CREATE TABLE public.purchase_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id        uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  purchase_item_id   uuid NOT NULL REFERENCES public.purchase_items(id),
  item_name_snapshot text NOT NULL,
  quantity           numeric(14,3) NOT NULL,
  unit               text NOT NULL,
  base_quantity      numeric(14,3) NOT NULL,
  total_price        numeric(14,4) NOT NULL,
  unit_cost_base     numeric(16,8) GENERATED ALWAYS AS (total_price / base_quantity) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT purchase_lines_quantity_positiva      CHECK (quantity > 0),
  CONSTRAINT purchase_lines_unit_valida             CHECK (unit IN ('g','kg','ml','l','un')),
  CONSTRAINT purchase_lines_base_quantity_positiva CHECK (base_quantity > 0),
  CONSTRAINT purchase_lines_preco_nao_negativo      CHECK (total_price >= 0),
  CONSTRAINT purchase_lines_nome_snapshot_nao_vazio CHECK (length(trim(item_name_snapshot)) > 0)
);

CREATE INDEX idx_purchase_lines_purchase_id      ON public.purchase_lines (purchase_id);
CREATE INDEX idx_purchase_lines_purchase_item_id ON public.purchase_lines (purchase_item_id);

ALTER TABLE public.purchase_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY purchase_lines_select_staff ON public.purchase_lines
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY purchase_lines_insert_admin ON public.purchase_lines
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY purchase_lines_update_admin ON public.purchase_lines
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY purchase_lines_delete_admin ON public.purchase_lines
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL PRIVILEGES ON TABLE public.purchase_lines FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.purchase_lines FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.purchase_lines FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.purchase_lines TO authenticated;

-- Nenhuma outra alteração: purchase_items, products, ingredients,
-- production_supplies, stock_movements, create_customer_order, lots
-- (Etapa futura), lot_movements (Etapa futura), estoque, pedidos e
-- Produção permanecem exatamente como estavam. Nenhum backfill, nenhuma
-- migration anterior editada.
