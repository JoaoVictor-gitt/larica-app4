-- Produção de Espetos — ETAPA 3A (cadastro de insumos de produção, standalone).
-- Cria public.production_supplies: cadastro reutilizável de insumos contados
-- por unidade (palito de espeto hoje; embalagem/bandeja no futuro, sem
-- migration nova — só uma linha nova nesta tabela). Custo por unidade
-- (cost_per_unit) é GENERATED STORED, nunca digitado manualmente, mesmo
-- padrão de ingredients.cost_per_base_unit. NENHUMA integração com
-- skewer_production_batches ainda — nem o service nem a UI de Produção de
-- Espetos leem esta tabela nesta etapa; isso só entra na Etapa 3B
-- (skewer_batch_components + RPC save_skewer_production_batch). Não altera
-- ingredients, recipes, recipe_items, skewer_production_batches,
-- product_costs, products, orders, estoque ou qualquer outra tabela.

-- =============================================================
-- 1. Tabela production_supplies.
-- unit_type fixo em 'un' via CHECK nesta V1 (insumos contados, sem peso/
-- volume) — se um insumo por peso/volume for necessário no futuro, o CHECK
-- é ampliado numa migration incremental própria, sem quebrar nada
-- existente. cost_per_unit GENERATED STORED nunca divide por zero
-- (purchase_quantity já tem CHECK > 0). created_by/updated_by sem FK pra
-- auth.users, mesmo padrão já usado em product_costs.updated_by/
-- skewer_production_batches.created_by.
-- =============================================================

CREATE TABLE public.production_supplies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  purchase_quantity  numeric(12,3) NOT NULL,
  purchase_price     numeric(12,4) NOT NULL,
  unit_type          text NOT NULL DEFAULT 'un',
  cost_per_unit      numeric(14,6) GENERATED ALWAYS AS (purchase_price / purchase_quantity) STORED,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NULL,
  updated_by         uuid NULL,

  CONSTRAINT production_supplies_name_nao_vazio      CHECK (length(trim(name)) > 0),
  CONSTRAINT production_supplies_quantidade_positiva CHECK (purchase_quantity > 0),
  CONSTRAINT production_supplies_preco_nao_negativo  CHECK (purchase_price >= 0),
  CONSTRAINT production_supplies_unit_type_valido    CHECK (unit_type = 'un')
);

-- Filtro de exibição (ativo/inativo) na listagem.
CREATE INDEX idx_production_supplies_active ON public.production_supplies (active);

-- =============================================================
-- 2. RLS — mesmo padrão de ingredients/recipes/skewer_production_batches:
-- staff só visualiza (is_staff), admin cria/edita/exclui (is_admin).
-- =============================================================

ALTER TABLE public.production_supplies ENABLE ROW LEVEL SECURITY;

CREATE POLICY production_supplies_select_staff ON public.production_supplies
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY production_supplies_insert_admin ON public.production_supplies
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY production_supplies_update_admin ON public.production_supplies
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY production_supplies_delete_admin ON public.production_supplies
  FOR DELETE TO authenticated USING (public.is_admin());

-- =============================================================
-- 3. GRANTs. REVOKE explícito antes do GRANT — mesmo cuidado já aplicado em
-- toda tabela nova neste projeto desde o caso real de uma tabela herdando
-- privilégio de anon via ALTER DEFAULT PRIVILEGES; comentário sozinho não é
-- garantia suficiente.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.production_supplies FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.production_supplies FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.production_supplies FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.production_supplies TO authenticated;

-- Nenhuma outra alteração: skewer_production_batches, ingredients, recipes,
-- recipe_items, product_costs, products, orders, estoque e Relatórios
-- permanecem exatamente como estavam. Nenhum service ou arquivo de UI de
-- Produção de Espetos lê esta tabela ainda — isso é a Etapa 3B.
