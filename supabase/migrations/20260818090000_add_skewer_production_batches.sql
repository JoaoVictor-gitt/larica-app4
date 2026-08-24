-- Produção de Espetos — ETAPA 1 (só schema + segurança, sem UI/service).
-- Cria public.skewer_production_batches: registra lotes reais de produção a
-- partir de peças de carne que perdem peso na limpeza (ex.: 5kg comprados,
-- 4,2kg úteis, 29 espetos realmente produzidos de uma teórica de 30). Só os
-- valores digitados são persistidos (produto, ingrediente opcional, data,
-- peso bruto, peso útil, custo total, peso por espeto, quantidade real) —
-- perda, rendimento, custo bruto/útil, quantidade teórica, custo teórico e
-- custo real por espeto são SEMPRE calculados on-read em js/producao.js na
-- Etapa 2, nunca armazenados aqui (mesma disciplina já usada em
-- ingredients.cost_per_base_unit e no rendimento derivado de recipes). Não
-- cria service nem altera producao.html/producao.js/producao.css (Etapa 2,
-- ainda não aprovada pra implementação). Não altera product_costs, products,
-- ingredients, recipes, recipe_items, orders, create_customer_order,
-- business_settings, estoque ou qualquer outra tabela.

-- =============================================================
-- 1. Tabela skewer_production_batches.
-- product_id/ingredient_id sem ON DELETE CASCADE de propósito — excluir um
-- produto ou ingrediente referenciado por algum lote falha com violação de
-- FK, nunca apaga histórico de produção silenciosamente (mesma decisão já
-- usada em recipe_items.ingredient_id). ingredient_id é opcional: o lote
-- nunca depende de um ingrediente cadastrado pra existir, é só um atalho de
-- preenchimento (Etapa 2). produced_at é date, não timestamptz — o lote é
-- sempre "de um dia", sem necessidade da camada de conversão de fuso
-- horário (business_settings.timezone) usada em pedidos/relatórios.
-- created_by/updated_by sem FK pra auth.users, mesmo padrão já usado em
-- product_costs.updated_by/ingredients.updated_by.
-- =============================================================

CREATE TABLE public.skewer_production_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES public.products(id),
  ingredient_id   uuid NULL REFERENCES public.ingredients(id),
  produced_at     date NOT NULL,
  gross_weight_g  numeric(12,3) NOT NULL,
  usable_weight_g numeric(12,3) NOT NULL,
  total_cost      numeric(12,4) NOT NULL,
  skewer_weight_g numeric(12,3) NOT NULL,
  actual_quantity integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NULL,
  updated_by      uuid NULL,

  -- usable_weight_g <= gross_weight_g implementa "não permitir rendimento
  -- >100%" diretamente no CHECK (comparação entre duas colunas da própria
  -- linha, sem precisar de trigger).
  CONSTRAINT skewer_batches_gross_weight_positiva    CHECK (gross_weight_g > 0),
  CONSTRAINT skewer_batches_usable_weight_positiva    CHECK (usable_weight_g > 0),
  CONSTRAINT skewer_batches_usable_nao_excede_bruto   CHECK (usable_weight_g <= gross_weight_g),
  CONSTRAINT skewer_batches_total_cost_nao_negativo   CHECK (total_cost >= 0),
  CONSTRAINT skewer_batches_skewer_weight_positivo    CHECK (skewer_weight_g > 0),
  CONSTRAINT skewer_batches_actual_quantity_positiva  CHECK (actual_quantity > 0)
);

-- product_id: listagem/filtro por produto na Etapa 2.
-- produced_at: ordenação/agrupamento por data na Etapa 2 e num futuro
-- relatório de produção.
CREATE INDEX idx_skewer_batches_product_id  ON public.skewer_production_batches (product_id);
CREATE INDEX idx_skewer_batches_produced_at ON public.skewer_production_batches (produced_at);

-- =============================================================
-- 2. RLS — mesmo padrão de ingredients/recipes/recipe_items: staff só
-- visualiza (is_staff), admin cria/edita/exclui (is_admin).
-- =============================================================

ALTER TABLE public.skewer_production_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY skewer_batches_select_staff ON public.skewer_production_batches
  FOR SELECT TO authenticated USING (public.is_staff());

CREATE POLICY skewer_batches_insert_admin ON public.skewer_production_batches
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY skewer_batches_update_admin ON public.skewer_production_batches
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY skewer_batches_delete_admin ON public.skewer_production_batches
  FOR DELETE TO authenticated USING (public.is_admin());

-- =============================================================
-- 3. GRANTs. REVOKE explícito antes do GRANT — mesmo cuidado já aplicado em
-- ingredients/recipes/recipe_items desde o caso real de uma tabela nova
-- herdando privilégio de anon via ALTER DEFAULT PRIVILEGES neste projeto;
-- comentário "nenhum GRANT a anon" sozinho não é garantia suficiente.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.skewer_production_batches FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.skewer_production_batches FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.skewer_production_batches FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.skewer_production_batches TO authenticated;

-- Nenhuma outra alteração: product_costs, products, ingredients, recipes,
-- recipe_items, orders, create_customer_order, business_settings, estoque e
-- Relatórios permanecem exatamente como estavam. Nenhum service (.js) ou
-- arquivo de UI (producao.html/producao.js/producao.css) foi criado ou
-- alterado nesta etapa — só esta migration, ainda não executada.
