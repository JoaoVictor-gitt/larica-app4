-- Ingredientes + Fichas Técnicas + Sub-receitas — ETAPA 2 (recipes +
-- recipe_items, só item_type='ingredient' usado nesta etapa). Custo é
-- sempre calculado on-read em JS a partir de ingredients.cost_per_base_unit
-- — nenhuma coluna de custo aqui. subrecipe_id existe só por preparação de
-- schema pra Etapa 3 (sub-receitas); a UI desta etapa nunca grava
-- item_type='recipe'. Não cria recipe_products, não altera product_costs,
-- products, orders, create_customer_order, business_settings, estoque ou
-- qualquer outra tabela.

-- =============================================================
-- 1. Tabela recipes — ficha técnica/preparo. Rendimento em porções ou em
-- g/ml/un (modelo aprovado na fase de diagnóstico) — nunca os dois ao
-- mesmo tempo, um único par yield_quantity/yield_unit por receita.
--
-- HISTÓRICO (registrado aqui pra este arquivo continuar representando
-- fielmente o que foi de fato executado no Supabase — nunca editar esta
-- seção retroativamente de novo): yield_quantity/yield_unit foram
-- removidos do rendimento automático do produto numa correção posterior,
-- feita como migration incremental separada
-- (20260817171000_make_recipe_yield_derived.sql), não reescrevendo este
-- arquivo — porque esta migration já tinha rodado em produção quando a
-- correção foi decidida. Rendimento passou a ser sempre derivado on-read
-- em JS a partir de recipe_items (ver a migration incremental pro
-- detalhe). Este bloco abaixo permanece como estava no momento da
-- execução real, de propósito.
-- =============================================================

CREATE TABLE public.recipes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  yield_quantity  numeric(12,3) NOT NULL,
  yield_unit      text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,

  CONSTRAINT recipes_name_nao_vazio
    CHECK (length(trim(name)) > 0),

  CONSTRAINT recipes_yield_unit_valido
    CHECK (yield_unit IN ('porcao', 'g', 'ml', 'un')),

  CONSTRAINT recipes_yield_quantity_positiva
    CHECK (yield_quantity > 0)
);

-- updated_by sem FK, mesmo padrão já usado em ingredients.updated_by/
-- product_costs.updated_by (migrations 20260817140000/160000).

CREATE INDEX idx_recipes_active ON public.recipes (active);

-- =============================================================
-- 2. Tabela recipe_items — itens de uma receita. Nesta etapa o BANCO só
-- aceita item_type='ingredient' (ingredient_id preenchido, subrecipe_id
-- NULL) — não é só uma convenção da UI: recipe_items_item_type_valido e
-- recipe_items_estrutura_valida (abaixo) recusam qualquer INSERT/UPDATE
-- com item_type='recipe', de qualquer origem (UI atual, um admin via
-- SQL direto, uma futura API). A proteção server-side contra ciclos
-- (sub-receita usando sub-receita) só existe a partir da Etapa 3 (RPC
-- administrativa dedicada — ver diagnóstico, "Ajuste 1"); até lá,
-- sub-receita fica impossível no banco, não só "não oferecida" na tela.
--
-- subrecipe_id e sua FK para recipes(id) permanecem no schema (preparação
-- de coluna pra Etapa 3), mas ficam inatingíveis: o CHECK abaixo exige
-- subrecipe_id IS NULL sempre nesta etapa. A Etapa 3 terá sua própria
-- migration pra ampliar essas duas constraints, junto com a RPC de ciclo.
--
-- PENDÊNCIA para a Etapa 3 (não implementada agora): a RPC de escrita que
-- vier a liberar sub-receita também deve validar recipe_items.unit contra
-- o base_unit do que está sendo referenciado (ingredients.base_unit hoje;
-- o base_unit efetivo da sub-receita quando isso existir) — hoje essa
-- checagem é só client-side (js/producao.js), então uma escrita externa à
-- UI atual poderia gravar, por exemplo, Batata (unit_type='peso') com
-- unit='ml'. Nenhum CHECK cross-table faz isso hoje (não é expressável em
-- CHECK simples), fica registrado aqui pra não ser esquecido.
--
-- unit sempre grava a unidade BASE do ingrediente (g/ml/un) — a conversão
-- kg->g / L->ml acontece na tela antes de montar o payload (mesmo
-- princípio já usado em ingredients.purchase_quantity_base).
--
-- ingredient_id SEM ON DELETE CASCADE (preferência explícita): excluir
-- fisicamente um ingrediente referenciado por uma ficha técnica falha com
-- erro de FK em vez de apagar a linha da receita silenciosamente. Exclusão
-- física de ingrediente já não é a ação recomendada na tela de Ingredientes
-- (ativar/desativar é o padrão) — este é um limite raro na prática.
-- =============================================================

CREATE TABLE public.recipe_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id      uuid NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  item_type      text NOT NULL,
  ingredient_id  uuid REFERENCES public.ingredients(id),
  subrecipe_id   uuid REFERENCES public.recipes(id),
  quantity       numeric(12,3) NOT NULL,
  unit           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recipe_items_item_type_valido
    CHECK (item_type = 'ingredient'),

  CONSTRAINT recipe_items_estrutura_valida
    CHECK (
      item_type = 'ingredient' AND ingredient_id IS NOT NULL AND subrecipe_id IS NULL
    ),

  CONSTRAINT recipe_items_sem_autoreferencia
    CHECK (subrecipe_id IS NULL OR subrecipe_id <> recipe_id),

  CONSTRAINT recipe_items_unit_valida
    CHECK (unit IN ('g', 'ml', 'un')),

  CONSTRAINT recipe_items_quantity_positiva
    CHECK (quantity > 0)
);

CREATE INDEX idx_recipe_items_recipe_id ON public.recipe_items (recipe_id);

-- =============================================================
-- 3. RLS — mesmo padrão já corrigido em ingredients (Etapa 1): anon sem
-- acesso algum; authenticated + is_staff() só visualiza; authenticated +
-- is_admin() cria/edita/exclui. Reaproveita is_staff()/is_admin() já
-- existentes.
-- =============================================================

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY recipes_select_staff
  ON public.recipes
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

CREATE POLICY recipes_insert_admin
  ON public.recipes
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY recipes_update_admin
  ON public.recipes
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY recipes_delete_admin
  ON public.recipes
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

CREATE POLICY recipe_items_select_staff
  ON public.recipe_items
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

CREATE POLICY recipe_items_insert_admin
  ON public.recipe_items
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY recipe_items_update_admin
  ON public.recipe_items
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY recipe_items_delete_admin
  ON public.recipe_items
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =============================================================
-- 4. GRANTs — mesmo bloco explícito de REVOKE+GRANT já corrigido em
-- ingredients (Etapa 1), aplicado às duas tabelas novas. REVOKE explícito
-- antes do GRANT porque já houve um caso real neste projeto (product_costs)
-- de uma tabela nova herdar privilégio de anon via ALTER DEFAULT
-- PRIVILEGES configurado no projeto.
-- =============================================================

REVOKE ALL PRIVILEGES ON TABLE public.recipes FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.recipes FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.recipes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recipes TO authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.recipe_items FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.recipe_items FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.recipe_items FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recipe_items TO authenticated;

-- Confirmado propositalmente: anon e PUBLIC sem privilégio algum nas duas
-- tabelas; authenticated só com os 4 privilégios que as policies acima
-- realmente usam. RLS continua sendo a barreira por linha/operação por
-- cima destes GRANTs.
