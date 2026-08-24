-- Compras + Lotes + Estoque por Lote — ETAPA A
-- Cria o catálogo mestre public.purchase_items.
--
-- Esta tabela representa qualquer coisa que pode ser comprada:
-- Batata, Contra Filé, Coca-Cola Zero, Palito de Espeto,
-- Embalagem, Detergente etc.
--
-- NÃO cria ainda:
-- suppliers
-- purchases
-- purchase_lines
-- lots
-- lot_movements
-- UI de Compras
-- RPCs de Compras
--
-- NÃO altera:
-- products
-- ingredients
-- production_supplies
-- stock_movements
-- create_customer_order
-- pedidos
-- produção
-- estoque atual
--
-- Migration 100% aditiva e sem backfill.


-- =============================================================
-- 1. TABELA purchase_items
-- =============================================================

CREATE TABLE public.purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,

  -- Categoria da área de Compras.
  -- Não confundir com products.category.
  category text NOT NULL,

  -- Define se futuras compras deste item gerarão estoque/lotes.
  tracks_stock boolean NOT NULL DEFAULT true,

  -- Unidade-base usada para estoque e lotes.
  -- Para itens com estoque controlado é obrigatória.
  base_unit text NULL,

  active boolean NOT NULL DEFAULT true,

  -- Um purchase_item pode opcionalmente representar algo que
  -- já existe no sistema.
  --
  -- No máximo UM destes vínculos pode estar preenchido.
  product_id uuid NULL REFERENCES public.products(id),
  ingredient_id uuid NULL REFERENCES public.ingredients(id),
  production_supply_id uuid NULL REFERENCES public.production_supplies(id),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  created_by uuid NULL,
  updated_by uuid NULL,


  -- -----------------------------------------------------------
  -- Nome obrigatório e não vazio.
  -- -----------------------------------------------------------

  CONSTRAINT purchase_items_name_nao_vazio
    CHECK (
      length(trim(name)) > 0
    ),


  -- -----------------------------------------------------------
  -- Categorias válidas da área de Compras.
  -- -----------------------------------------------------------

  CONSTRAINT purchase_items_category_valida
    CHECK (
      category IN (
        'ingredient',
        'meat',
        'beverage',
        'supply',
        'packaging',
        'cleaning',
        'other'
      )
    ),


  -- -----------------------------------------------------------
  -- Unidade-base.
  --
  -- tracks_stock = true:
  --   base_unit é OBRIGATÓRIA e deve ser g/ml/un.
  --
  -- tracks_stock = false:
  --   base_unit pode ser NULL ou g/ml/un.
  --
  -- O IS NOT NULL explícito é importante porque CHECKs do
  -- PostgreSQL também aceitam expressões cujo resultado seja NULL.
  -- -----------------------------------------------------------

  CONSTRAINT purchase_items_base_unit_coerente
    CHECK (
      (
        tracks_stock = true
        AND base_unit IS NOT NULL
        AND base_unit IN ('g', 'ml', 'un')
      )
      OR
      (
        tracks_stock = false
        AND (
          base_unit IS NULL
          OR base_unit IN ('g', 'ml', 'un')
        )
      )
    ),


  -- -----------------------------------------------------------
  -- No máximo um vínculo com as tabelas antigas.
  --
  -- Permitido:
  -- nenhum vínculo
  -- OU
  -- somente product_id
  -- OU
  -- somente ingredient_id
  -- OU
  -- somente production_supply_id
  --
  -- Nunca dois ou três simultaneamente.
  -- -----------------------------------------------------------

  CONSTRAINT purchase_items_no_maximo_um_vinculo
    CHECK (
      (CASE
        WHEN product_id IS NOT NULL THEN 1
        ELSE 0
      END)
      +
      (CASE
        WHEN ingredient_id IS NOT NULL THEN 1
        ELSE 0
      END)
      +
      (CASE
        WHEN production_supply_id IS NOT NULL THEN 1
        ELSE 0
      END)
      <= 1
    )
);


-- =============================================================
-- 2. ÍNDICES DE CONSULTA
-- =============================================================

-- Usado para filtrar itens ativos/inativos.
CREATE INDEX idx_purchase_items_active
  ON public.purchase_items (active);


-- Usado para filtrar/agrupar pelas categorias de Compras.
CREATE INDEX idx_purchase_items_category
  ON public.purchase_items (category);


-- =============================================================
-- 3. UNIQUE PARCIAL DOS VÍNCULOS
--
-- Impede dois purchase_items diferentes de apontarem para o
-- mesmo registro das tabelas antigas.
--
-- Exemplos:
--
-- Só pode existir um purchase_item ligado ao ingredients.id
-- correspondente à Batata.
--
-- Só pode existir um purchase_item ligado ao products.id
-- correspondente à Coca-Cola.
--
-- Itens sem vínculo continuam podendo existir normalmente.
-- =============================================================

CREATE UNIQUE INDEX idx_purchase_items_product_unico
  ON public.purchase_items (product_id)
  WHERE product_id IS NOT NULL;


CREATE UNIQUE INDEX idx_purchase_items_ingredient_unico
  ON public.purchase_items (ingredient_id)
  WHERE ingredient_id IS NOT NULL;


CREATE UNIQUE INDEX idx_purchase_items_supply_unico
  ON public.purchase_items (production_supply_id)
  WHERE production_supply_id IS NOT NULL;


-- =============================================================
-- 4. ROW LEVEL SECURITY
-- =============================================================

ALTER TABLE public.purchase_items
  ENABLE ROW LEVEL SECURITY;


-- Staff pode visualizar.
CREATE POLICY purchase_items_select_staff
  ON public.purchase_items
  FOR SELECT
  TO authenticated
  USING (
    public.is_staff()
  );


-- Somente admin pode criar.
CREATE POLICY purchase_items_insert_admin
  ON public.purchase_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin()
  );


-- Somente admin pode editar.
CREATE POLICY purchase_items_update_admin
  ON public.purchase_items
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
  )
  WITH CHECK (
    public.is_admin()
  );


-- Somente admin pode excluir.
CREATE POLICY purchase_items_delete_admin
  ON public.purchase_items
  FOR DELETE
  TO authenticated
  USING (
    public.is_admin()
  );


-- =============================================================
-- 5. PRIVILÉGIOS
--
-- Nenhum acesso para anon/PUBLIC.
--
-- authenticated recebe SELECT/INSERT/UPDATE/DELETE,
-- mas as operações continuam protegidas pelas policies RLS.
-- =============================================================

REVOKE ALL PRIVILEGES
  ON TABLE public.purchase_items
  FROM anon;


REVOKE ALL PRIVILEGES
  ON TABLE public.purchase_items
  FROM PUBLIC;


REVOKE REFERENCES, TRIGGER, TRUNCATE
  ON TABLE public.purchase_items
  FROM authenticated;


GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.purchase_items
  TO authenticated;


-- =============================================================
-- FIM — ETAPA A
-- =============================================================
--
-- Nenhum purchase_item é criado automaticamente.
--
-- Nenhum dado existente é modificado.
--
-- Permanecem intactos:
--
-- products
-- ingredients
-- production_supplies
-- product_costs
-- stock_movements
-- create_customer_order
-- skewer_production_batches
-- skewer_batch_components
-- side_production_batches
-- side_batch_components
-- pedidos
-- produção
-- estoque atual
--
-- As próximas estruturas serão criadas em migrations futuras:
--
-- suppliers
-- purchases
-- purchase_lines
-- lots
-- lot_movements
--
-- NÃO adicionar essas estruturas nesta migration.