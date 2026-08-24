-- Compras + Lotes + Estoque por Lote — MELHORIA DE UX: REGISTRAR COMPRA SEM
-- EXIGIR ITEM PRÉ-CADASTRADO — ETAPA F1 (schema).
--
-- Prepara purchase_items/purchase_lines para permitir itens de compra
-- criados automaticamente ("provisórios") durante o registro de uma
-- compra, quando o usuário digita um nome que ainda não existe no
-- catálogo — sem precisar sair de "Registrar Compra" para cadastrar o
-- item antes.
--
-- Só schema nesta etapa. NÃO altera save_purchase, NÃO cria
-- finalize_purchase_item, NÃO altera create_lot_from_purchase_line, NÃO
-- altera RLS, NÃO altera GRANTs, NÃO altera UI
-- (compras.html/js/compras.js/css/compras.css/purchases-service.js), NÃO
-- integra Produção/Pedidos/create_customer_order/product_costs/
-- stock_movements/products.stock_quantity. Migrations já executadas
-- (20260818150000 a 20260818180000) não são editadas — esta é uma
-- migration incremental nova.

-- =============================================================
-- 1. purchase_items.needs_review
--
-- Flag solto (nunca inferido de category/tracks_stock/vínculo) — só será
-- setado true pela futura criação automática dentro de save_purchase
-- (Etapa F2), e false pela futura finalize_purchase_item (Etapa F2) ou
-- por edição manual normal. Itens já cadastrados recebem o DEFAULT
-- automaticamente (false) — sem backfill separado, o Postgres preenche
-- toda linha existente no momento do ADD COLUMN.
-- =============================================================

ALTER TABLE public.purchase_items
  ADD COLUMN needs_review boolean NOT NULL DEFAULT false;


-- =============================================================
-- 2. purchase_items.normalized_name
--
-- Coluna GERADA (nunca escrita diretamente) — trim + colapso de espaços
-- repetidos + lowercase + remoção de acentos comuns via translate(), sem
-- depender da extensão unaccent (não confirmada como habilitada neste
-- projeto). lower/trim/regexp_replace/translate são todas IMMUTABLE no
-- Postgres, permitindo STORED (mesma técnica já usada em
-- cost_per_base_unit/unit_cost_base/cost_per_unit). Recalculada
-- automaticamente em todo INSERT/UPDATE de name — inclusive quando um
-- admin renomeia um item pela tela normal já existente. name continua
-- text NOT NULL, inalterada — normalized_name é só chave técnica de
-- comparação, nunca exibida/editada diretamente.
--
-- "  BATATA " -> trim -> "BATATA" -> lower -> "batata" (sem acento a
-- remover). "Batáta" -> "batata". Espaços repetidos colapsados antes do
-- resto da normalização.
-- =============================================================

ALTER TABLE public.purchase_items
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
-- 3. UNIQUE INDEX global em normalized_name
--
-- Consulta prévia de duplicados (rodada pelo usuário no Supabase) não
-- retornou nenhuma linha — seguro criar o índice único agora. Será usado
-- pela futura save_purchase (Etapa F2) para reaproveitar um item
-- existente por nome normalizado antes de criar um provisório (INSERT
-- ... ON CONFLICT (normalized_name) DO NOTHING), e passa a impedir dois
-- purchase_items com o mesmo nome normalizado também por edição manual
-- futura.
-- =============================================================

CREATE UNIQUE INDEX idx_purchase_items_normalized_name_unico
  ON public.purchase_items (normalized_name);


-- =============================================================
-- 4. purchase_lines.base_quantity — nullable
--
-- Necessário para representar uma linha cujo purchase_item ainda é
-- provisório (tracks_stock=false, base_unit=NULL): quantity/unit
-- continuam obrigatórios (o que o usuário digitou), mas não há como
-- converter para uma unidade-base que ainda não existe — base_quantity
-- fica NULL até o item ser finalizado (finalize_purchase_item, Etapa F2)
-- e a linha ser corrigida retroativamente.
-- =============================================================

ALTER TABLE public.purchase_lines
  ALTER COLUMN base_quantity DROP NOT NULL;


-- =============================================================
-- 5-6. CHECK relaxado — base_quantity IS NULL OR base_quantity > 0
--
-- Mesmo nome de constraint reaproveitado
-- (purchase_lines_base_quantity_positiva) — só a definição muda, pra
-- continuar rejeitando 0/negativo quando um valor estiver presente, mas
-- agora aceitando NULL também.
-- =============================================================

ALTER TABLE public.purchase_lines
  DROP CONSTRAINT purchase_lines_base_quantity_positiva;

ALTER TABLE public.purchase_lines
  ADD CONSTRAINT purchase_lines_base_quantity_positiva
  CHECK (
    base_quantity IS NULL
    OR base_quantity > 0
  );


-- =============================================================
-- 7. unit_cost_base GENERATED — nenhuma alteração
--
-- Continua exatamente como já executado: numeric(16,8) GENERATED ALWAYS
-- AS (total_price / base_quantity) STORED. Aritmética do Postgres com
-- operando NULL sempre resulta em NULL (nunca erro, nunca divisão por
-- zero disfarçada) — quando base_quantity é NULL, unit_cost_base fica
-- NULL automaticamente, sem precisar (e sem poder) redefinir a coluna.
-- =============================================================


-- =============================================================
-- FIM — ETAPA F1
-- =============================================================
--
-- Permanecem inalterados nesta migration:
--
-- purchase_lines.quantity           (NOT NULL)
-- purchase_lines.unit               (NOT NULL)
-- purchase_lines.total_price        (NOT NULL)
-- purchase_lines.item_name_snapshot (NOT NULL)
-- purchase_lines.purchase_item_id   (NOT NULL — nunca vira NULL; o fluxo
--   futuro cria o purchase_item PRIMEIRO, dentro da mesma transação de
--   save_purchase, e só então insere a purchase_line já apontando pra
--   ele)
-- purchase_lines_quantity_positiva
-- purchase_lines_unit_valida
-- purchase_lines_preco_nao_negativo
-- purchase_lines_nome_snapshot_nao_vazio
-- purchase_items_name_nao_vazio
-- purchase_items_category_valida
-- purchase_items_base_unit_coerente (já permite tracks_stock=false +
--   base_unit=NULL — representa corretamente o item provisório sem
--   nenhuma mudança)
-- purchase_items_no_maximo_um_vinculo
--
-- RLS de purchase_items/purchase_lines: inalterada.
-- GRANTs de purchase_items (SELECT/INSERT/UPDATE/DELETE pra authenticated
--   sob RLS) e de purchase_lines (só SELECT pra authenticated):
--   inalterados.
--
-- save_purchase, create_lot_from_purchase_line: inalteradas (schema e
-- corpo idênticos aos já executados) — a extensão delas e a nova RPC
-- finalize_purchase_item ficam para a Etapa F2.
--
-- Nenhuma UI alterada (compras.html/js/compras.js/css/compras.css/
-- js/services/purchases-service.js) — Etapa F3.
--
-- Nenhuma integração com Produção, Pedidos, create_customer_order,
-- product_costs, stock_movements, products.stock_quantity.
