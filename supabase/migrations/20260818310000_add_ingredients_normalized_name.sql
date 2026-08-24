-- Unificar Item de Compra <-> Ingredient — ETAPA J2 (schema de identidade).
--
-- Prepara public.ingredients para permitir, numa etapa futura (J3), auto-
-- criação/vínculo automático a partir de Compras -> Item de Compra
-- category='ingredient' (mesmo padrão já usado para production_supplies
-- via _resolve_production_supply_link, Etapa I2) — sem duplicar
-- ingredients silenciosamente por causa de "Batata"/" batata "/"BATATA"
-- serem tratados como itens diferentes.
--
-- Reaproveita EXATAMENTE a mesma expressão de normalização já validada em
-- purchase_items.normalized_name (migration 20260818190000_add_purchase_
-- item_pending_support.sql, lida por completo antes de escrever este
-- arquivo) — nenhuma regra de normalização nova foi inventada.
--
-- SOMENTE schema de identidade nesta etapa. NÃO cria _resolve_ingredient_
-- link, NÃO cria save_ingredient, NÃO cria trigger, NÃO cria nenhuma RPC.
-- NÃO altera save_purchase_item, finalize_purchase_item, save_purchase,
-- purchase_items (nenhuma coluna/CHECK). NÃO altera compras.html/
-- js/compras.js/js/services/purchases-service.js. NÃO altera producao.html/
-- js/producao.js/js/services/ingredients-service.js, Fichas Técnicas,
-- Produção de Espetos, Produção de Acompanhamentos. NÃO altera RLS nem
-- GRANTs de ingredients — a escrita direta atual (authenticated com
-- SELECT/INSERT/UPDATE/DELETE sob RLS admin-only) permanece exatamente
-- como está; fechar isso fica para a futura Etapa J3, junto da RPC, mesmo
-- padrão já usado em I2. Migrations já executadas não são editadas — esta
-- é incremental, posterior a 20260818300000 (Etapa I3).
--
-- Nenhum UPDATE em ingredients. Nenhum DELETE. Nenhum merge de linhas.
-- Nenhuma tabela recriada. Nenhum id muda. Nenhuma FK é tocada —
-- recipe_items.ingredient_id, purchase_items.ingredient_id,
-- skewer_batch_components.ingredient_id, side_batch_components.
-- ingredient_id continuam apontando exatamente para os mesmos UUIDs de
-- antes (ADD COLUMN não reescreve nenhuma linha existente além de
-- preencher a coluna gerada nova).
--
-- ==========================================================================
-- PENDÊNCIA QUE BLOQUEIA A EXECUÇÃO — leia antes de rodar esta migration
-- ==========================================================================
--
-- Diferente da rodada equivalente em purchase_items (onde a consulta de
-- duplicados já tinha sido rodada pelo usuário e confirmada vazia ANTES da
-- migration ser escrita), este ambiente não tem acesso de consulta direta
-- ao Supabase — a auditoria de duplicatas não foi executada ainda.
--
-- ANTES de rodar esta migration, execute esta consulta só-leitura:
--
--   SELECT
--     translate(
--       lower(
--         trim(
--           regexp_replace(name, '\s+', ' ', 'g')
--         )
--       ),
--       'áàãâäéèêëíìîïóòõôöúùûüçñ',
--       'aaaaaeeeeiiiiooooouuuucn'
--     ) AS normalizado,
--     count(*) AS quantidade,
--     array_agg(name ORDER BY name) AS nomes,
--     array_agg(id ORDER BY name) AS ids
--   FROM public.ingredients
--   GROUP BY 1
--   HAVING count(*) > 1;
--
-- Se vier vazia: pode executar esta migration sem risco (nenhuma colisão
-- possível no CREATE UNIQUE INDEX abaixo).
--
-- Se vier alguma linha: NÃO execute esta migration ainda. Cada grupo
-- retornado precisa de uma decisão manual sua (qual linha manter, se
-- alguma precisa ser desativada/renomeada) antes de a constraint poder ser
-- criada — o CREATE UNIQUE INDEX falharia com erro de violação de unicidade
-- se houver qualquer duplicata real. Nenhuma fusão/exclusão automática será
-- feita por este arquivo em hipótese nenhuma.

-- =============================================================
-- 1. ingredients.normalized_name
--
-- Coluna GERADA (nunca escrita diretamente) — mesma expressão exata já
-- usada em purchase_items.normalized_name: trim + colapso de espaços
-- repetidos + lowercase + remoção de acentos comuns via translate(), sem
-- depender da extensão unaccent. Todas IMMUTABLE, permitindo STORED.
-- ingredients.name (NOT NULL) não é alterada — normalized_name é só chave
-- técnica de comparação, nunca exibida/editada diretamente na UI.
--
-- "Batata" / " batata " / "BATATA" / "Batata   " -> todas normalizam para
-- "batata" (trim + colapso de espaço + lowercase; sem acento a remover
-- neste exemplo específico).
-- =============================================================

ALTER TABLE public.ingredients
  ADD COLUMN normalized_name text GENERATED ALWAYS AS (
    translate(
      lower(
        trim(
          regexp_replace(name, '\s+', ' ', 'g')
        )
      ),
      'áàãâäéèêëíìîïóòõôöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'
    )
  ) STORED;

-- =============================================================
-- 2. UNIQUE INDEX global em normalized_name
--
-- Mesmo padrão de nome já usado em purchase_items
-- (idx_purchase_items_normalized_name_unico). Será usada por uma futura
-- RPC (Etapa J3, não criada aqui) para reaproveitar um ingredient já
-- existente por nome normalizado antes de auto-criar um novo (mesmo
-- idioma INSERT ... ON CONFLICT (normalized_name) DO NOTHING já usado em
-- save_purchase para purchase_items) — e passa a impedir dois ingredients
-- com o mesmo nome normalizado também por qualquer edição manual futura
-- (incluindo a tela atual de Produção -> Ingredientes, que continua
-- fazendo UPDATE/INSERT direto sob RLS, inalterada nesta migration).
-- =============================================================

CREATE UNIQUE INDEX idx_ingredients_normalized_name_unico
  ON public.ingredients (normalized_name);

-- =============================================================
-- FIM — ETAPA J2
-- =============================================================
--
-- Permanecem inalterados nesta migration:
--
-- ingredients.id, name, unit_type, base_unit, purchase_quantity_display,
-- purchase_display_unit, purchase_quantity_base, purchase_price,
-- cost_per_base_unit, category, active, created_at, updated_at, updated_by
-- ingredients_name_nao_vazio
-- ingredients_unit_type_valido
-- ingredients_base_unit_coerente
-- ingredients_unidade_compra_coerente
-- ingredients_purchase_quantity_display_positiva
-- ingredients_purchase_quantity_base_positiva
-- ingredients_purchase_price_nao_negativo
-- ingredients_quantidade_base_conversao_valida
-- idx_ingredients_active
--
-- RLS (ingredients_select_staff/insert_admin/update_admin/delete_admin):
-- inalterada. GRANTs (authenticated: SELECT/INSERT/UPDATE/DELETE direto
-- sob RLS; anon/PUBLIC: nenhum privilégio): inalterados.
--
-- purchase_items, save_purchase_item, finalize_purchase_item,
-- save_purchase, compras.html/js/compras.js/purchases-service.js: não
-- tocados. producao.html/js/producao.js/ingredients-service.js, Fichas
-- Técnicas, Produção de Espetos, Produção de Acompanhamentos: não
-- tocados. Nenhuma RPC criada (_resolve_ingredient_link/save_ingredient
-- ficam para a Etapa J3). Nenhum FK/UUID alterado.
