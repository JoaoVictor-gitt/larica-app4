-- Produção de Acompanhamentos — ETAPA A (só schema do lote, sem
-- componentes/RPC/UI). Cria public.side_production_batches: registra lotes
-- reais de produção de acompanhamentos (Salada de Maionese, Vinagrete,
-- Arroz, Farofa, Molho de Alho), cada um com um rendimento final informado
-- manualmente (nunca derivado da soma de componentes — captura perda real
-- de cocção/evaporação/absorção) e uma porção de venda na mesma unidade do
-- rendimento. actual_portions é opcional: se NULL, o sistema usará a
-- quantidade teórica (floor(rendimento/porção)) numa etapa futura. Nenhum
-- campo de custo é persistido aqui — todo custo virá de
-- side_batch_components (Etapa B), somado on-read. Não cria
-- side_batch_components, RPCs, service nem altera
-- producao.html/producao.js/producao.css nesta etapa. Não altera
-- product_costs, products, ingredients, recipes, recipe_items,
-- skewer_production_batches, skewer_batch_components, orders,
-- create_customer_order, business_settings, estoque ou qualquer outra
-- tabela.

-- =============================================================
-- 1. Tabela side_production_batches.
-- product_id sem ON DELETE CASCADE de propósito — excluir um produto
-- referenciado por algum lote falha com violação de FK, nunca apaga
-- histórico de produção silenciosamente (mesma decisão já usada em
-- skewer_production_batches.product_id). produced_at é date, não
-- timestamptz — mesmo raciocínio já usado em skewer_production_batches (o
-- lote é sempre "de um dia", sem necessidade da camada de conversão de
-- fuso horário usada em pedidos/relatórios). Categoria do produto
-- (products.category = 'sides') não é validada por CHECK cross-table
-- aqui — fica pra validação nas RPCs da Etapa B, mesmo padrão já usado em
-- skewer_production_batches (categoria 'skewers' também não é um CHECK).
-- created_by/updated_by sem FK pra auth.users, mesmo padrão já usado em
-- product_costs.updated_by/ingredients.updated_by/skewer_production_batches.
-- =============================================================

CREATE TABLE public.side_production_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            uuid NOT NULL REFERENCES public.products(id),
  produced_at           date NOT NULL,
  final_yield_quantity  numeric(12,3) NOT NULL,
  final_yield_unit      text NOT NULL,
  portion_quantity      numeric(12,3) NOT NULL,
  portion_unit          text NOT NULL,
  actual_portions       integer NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NULL,
  updated_by            uuid NULL,

  CONSTRAINT side_batches_yield_positiva        CHECK (final_yield_quantity > 0),
  CONSTRAINT side_batches_yield_unit_valida     CHECK (final_yield_unit IN ('g','ml','un')),
  CONSTRAINT side_batches_portion_positiva      CHECK (portion_quantity > 0),
  CONSTRAINT side_batches_portion_unit_valida   CHECK (portion_unit IN ('g','ml','un')),
  -- Porção precisa estar na mesma unidade do rendimento — nunca conversão
  -- peso<->volume (mesma regra já aplicada em toda a feature de Produção).
  CONSTRAINT side_batches_portion_mesma_unidade CHECK (portion_unit = final_yield_unit),
  CONSTRAINT side_batches_actual_portions_positiva CHECK (actual_portions IS NULL OR actual_portions > 0)
);

-- product_id: listagem/filtro por produto na Etapa C.
-- produced_at: ordenação/agrupamento por data na Etapa C.
CREATE INDEX idx_side_production_batches_product_id  ON public.side_production_batches (product_id);
CREATE INDEX idx_side_production_batches_produced_at ON public.side_production_batches (produced_at);

-- =============================================================
-- 2. RLS — mesmo padrão inicial já usado na Etapa 1 de Produção de Espetos:
-- staff só visualiza (is_staff), admin cria/edita/exclui (is_admin) via
-- policy. Na Etapa B, quando save_side_production_batch existir, o GRANT
-- direto de INSERT/UPDATE será revogado de authenticated (mesma correção
-- já aplicada a skewer_production_batches) — nesta Etapa A ainda segue o
-- padrão original, como pedido.
-- =============================================================

ALTER TABLE public.side_production_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY side_batches_select_staff ON public.side_production_batches
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY side_batches_insert_admin ON public.side_production_batches
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY side_batches_update_admin ON public.side_production_batches
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY side_batches_delete_admin ON public.side_production_batches
  FOR DELETE TO authenticated USING (public.is_admin());

-- =============================================================
-- 3. GRANTs. REVOKE explícito antes do GRANT — mesmo cuidado já aplicado a
-- toda tabela nova nesta sessão desde o caso real de uma tabela herdando
-- privilégio de anon via ALTER DEFAULT PRIVILEGES neste projeto.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.side_production_batches FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.side_production_batches FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.side_production_batches FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.side_production_batches TO authenticated;

-- Nenhuma outra alteração: side_batch_components (Etapa B), product_costs,
-- products, ingredients, recipes, recipe_items, skewer_production_batches,
-- skewer_batch_components, orders, create_customer_order,
-- business_settings, estoque e Relatórios permanecem exatamente como
-- estavam. Nenhum service (.js) ou arquivo de UI
-- (producao.html/producao.js/producao.css) foi criado ou alterado nesta
-- etapa — só esta migration, ainda não executada.
