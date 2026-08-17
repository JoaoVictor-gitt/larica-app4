-- Ingredientes + Fichas Técnicas + Sub-receitas — ETAPA 1 (só ingredients).
-- Cria public.ingredients: matéria-prima comprada, com custo por unidade
-- base (g/ml/un) derivado de quantidade comprada + preço pago. Não cria
-- recipes/recipe_items/recipe_products (Etapas 2-4, ainda não aprovadas
-- pra implementação). Não altera product_costs, products, orders,
-- create_customer_order, business_settings ou qualquer outra tabela.
--
-- Permissão de UI "production.view" já foi adicionada manualmente ao CHECK
-- de public.user_permissions.permission fora desta migration (conforme
-- combinado) — nada relacionado a user_permissions é tocado aqui.

-- =============================================================
-- 1. Tabela ingredients.
-- Unidade base sempre g (peso), ml (volume) ou un (contagem) — nunca
-- convertida entre tipos. purchase_quantity_display/purchase_display_unit
-- preservam o que foi digitado (ex.: "5" + "kg", fiel à nota fiscal);
-- purchase_quantity_base é o mesmo valor já convertido pra unidade base,
-- usado em todo cálculo de custo. Sem colunas de "embalagem/pack" — "2
-- embalagens de 5 kg" é só aritmética de formulário (embalagens × tamanho)
-- que preenche purchase_quantity_display antes de salvar; o banco nunca
-- sabe que existiu uma embalagem, só recebe o total já consolidado.
-- =============================================================

CREATE TABLE public.ingredients (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL,
  unit_type                   text NOT NULL,
  base_unit                   text NOT NULL,
  purchase_quantity_display   numeric(12,3) NOT NULL,
  purchase_display_unit       text NOT NULL,
  purchase_quantity_base      numeric(12,3) NOT NULL,
  purchase_price               numeric(12,4) NOT NULL,
  cost_per_base_unit          numeric(14,6) GENERATED ALWAYS AS (purchase_price / purchase_quantity_base) STORED,
  category                    text,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid,

  CONSTRAINT ingredients_name_nao_vazio
    CHECK (length(trim(name)) > 0),

  CONSTRAINT ingredients_unit_type_valido
    CHECK (unit_type IN ('peso', 'volume', 'contagem')),

  CONSTRAINT ingredients_base_unit_coerente
    CHECK (
      (unit_type = 'peso'     AND base_unit = 'g')  OR
      (unit_type = 'volume'   AND base_unit = 'ml') OR
      (unit_type = 'contagem' AND base_unit = 'un')
    ),

  CONSTRAINT ingredients_unidade_compra_coerente
    CHECK (
      (unit_type = 'peso'     AND purchase_display_unit IN ('kg', 'g'))  OR
      (unit_type = 'volume'   AND purchase_display_unit IN ('L', 'ml')) OR
      (unit_type = 'contagem' AND purchase_display_unit = 'un')
    ),

  CONSTRAINT ingredients_purchase_quantity_display_positiva
    CHECK (purchase_quantity_display > 0),

  CONSTRAINT ingredients_purchase_quantity_base_positiva
    CHECK (purchase_quantity_base > 0),

  CONSTRAINT ingredients_purchase_price_nao_negativo
    CHECK (purchase_price >= 0),

  CONSTRAINT ingredients_quantidade_base_conversao_valida
    CHECK (
      (purchase_display_unit = 'kg' AND purchase_quantity_base = purchase_quantity_display * 1000) OR
      (purchase_display_unit = 'g'  AND purchase_quantity_base = purchase_quantity_display)        OR
      (purchase_display_unit = 'L'  AND purchase_quantity_base = purchase_quantity_display * 1000) OR
      (purchase_display_unit = 'ml' AND purchase_quantity_base = purchase_quantity_display)        OR
      (purchase_display_unit = 'un' AND purchase_quantity_base = purchase_quantity_display)
    )
);

-- purchase_price sem DEFAULT — sempre informado no cadastro. Preço 0 é
-- permitido de propósito (ingrediente doado/de custo real zero é um caso
-- válido); só valores negativos são rejeitados. cost_per_base_unit nunca é
-- escrita diretamente (coluna GENERATED) e nunca divide por zero — a
-- própria definição da coluna já exige purchase_quantity_base > 0.

-- ingredients_quantidade_base_conversao_valida é complementar aos CHECKs
-- ingredients_base_unit_coerente/ingredients_unidade_compra_coerente acima
-- (que só validam COMPATIBILIDADE de tipo/unidade) — este aqui valida a
-- CONVERSÃO em si, replicando a mesma tabela de fatores usada no JS (kg/L
-- ×1000, g/ml/un ×1) diretamente no banco. Impede uma linha fisicamente
-- impossível como "5 kg" gravado com purchase_quantity_base = 4000 — seja
-- por bug futuro no client, seja por qualquer caminho de escrita que não
-- passe pela tela atual.

-- updated_by fica sem FK nesta etapa, mesmo padrão já usado em
-- product_costs.updated_by (migration 20260817140000): não há CREATE
-- TABLE de public.profiles neste repositório pra confirmar com segurança
-- a relação com auth.users — uma FK incorreta quebraria silenciosamente
-- todo INSERT/UPDATE. Sem impacto na feature; pode ganhar FK depois.

CREATE INDEX idx_ingredients_active ON public.ingredients (active);

-- =============================================================
-- 2. RLS — mesmo padrão já confirmado em product_costs: anon sem acesso
-- algum; authenticated + is_staff() só visualiza; authenticated +
-- is_admin() cria/edita/exclui. Reaproveita is_staff()/is_admin() já
-- existentes — nenhuma função de autorização nova.
-- =============================================================

ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;

CREATE POLICY ingredients_select_staff
  ON public.ingredients
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

CREATE POLICY ingredients_insert_admin
  ON public.ingredients
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY ingredients_update_admin
  ON public.ingredients
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY ingredients_delete_admin
  ON public.ingredients
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =============================================================
-- 3. GRANTs — REVOKE explícito antes do GRANT. Já houve um caso real neste
-- projeto (product_costs) de uma tabela nova herdar privilégio de anon via
-- ALTER DEFAULT PRIVILEGES configurado no projeto — "nenhum GRANT concedido
-- a anon" não é garantia de que a tabela não tenha herdado privilégio
-- nenhum por padrão. Por isso este bloco revoga tudo de anon/PUBLIC e
-- qualquer privilégio supérfluo de authenticated antes de conceder
-- exatamente os 4 que as policies da seção 2 realmente usam.
-- =============================================================

REVOKE ALL PRIVILEGES
  ON TABLE public.ingredients
  FROM anon;

REVOKE ALL PRIVILEGES
  ON TABLE public.ingredients
  FROM PUBLIC;

REVOKE REFERENCES, TRIGGER, TRUNCATE
  ON TABLE public.ingredients
  FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.ingredients
  TO authenticated;

-- Confirmado propositalmente: anon e PUBLIC sem privilégio algum nesta
-- tabela; authenticated só com os 4 privilégios que ingredients_select_
-- staff/insert_admin/update_admin/delete_admin realmente usam. RLS
-- (seção 2 acima) continua sendo a barreira por linha/operação por cima
-- destes GRANTs — REVOKE/GRANT sozinhos não substituem a policy.
