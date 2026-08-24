-- Ingredientes + Fichas Técnicas + Sub-receitas — correção de modelo:
-- rendimento passa a ser SEMPRE calculado on-read em JS a partir de
-- recipe_items (soma de quantity quando todos os itens estão na mesma
-- unit; indisponível — nunca uma soma inventada — quando a receita não
-- tem itens ou tem itens em units diferentes, ex. g + ml, grandezas
-- incompatíveis). Mesma disciplina já usada pro custo total: nunca
-- persistido, nunca pode ficar desatualizado em relação a recipe_items.
--
-- Migration incremental (não reescreve 20260817170000_add_recipes.sql,
-- que já foi executada em produção) — remove só as duas colunas de
-- rendimento MANUAL de recipes e suas constraints. Nomes de constraint
-- confirmados como os realmente aplicados: recipes_yield_quantity_positiva,
-- recipes_yield_unit_valido.
--
-- Não altera recipe_items, RLS, policies ou GRANTs em nenhuma tabela. Não
-- apaga nenhuma linha: fichas técnicas e itens já cadastrados (inclusive a
-- receita já existente, ex. "Salada de Maionese") continuam intactos —
-- só as duas colunas deixam de existir; o rendimento dela passa a ser
-- calculado a partir dos recipe_items que já tem, na próxima leitura.

-- =============================================================
-- 1. Remove as constraints primeiro (explícito, embora DROP COLUMN sozinho
-- já derrubasse essas duas CHECK de coluna única via cascade automático do
-- Postgres) — deixa a intenção inequívoca numa migration que mexe em
-- produção, sem depender de comportamento implícito.
-- =============================================================

ALTER TABLE public.recipes
  DROP CONSTRAINT recipes_yield_quantity_positiva;

ALTER TABLE public.recipes
  DROP CONSTRAINT recipes_yield_unit_valido;

-- =============================================================
-- 2. Remove as colunas.
-- =============================================================

ALTER TABLE public.recipes
  DROP COLUMN yield_quantity;

ALTER TABLE public.recipes
  DROP COLUMN yield_unit;
