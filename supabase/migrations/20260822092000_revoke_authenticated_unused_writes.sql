-- ============================================================
-- L2.1C
-- Revoga escritas diretas de authenticated em tabelas que
-- não possuem callers ativos no frontend.
--
-- NÃO altera RLS.
-- NÃO altera RPCs.
-- NÃO altera tabelas ainda utilizadas diretamente pela UI.
-- ============================================================


-- ------------------------------------------------------------
-- STOCK MOVEMENTS
--
-- Escrita ocorre exclusivamente por RPCs SECURITY DEFINER:
-- adjust_stock, pedidos, compras e produção.
-- Frontend apenas consulta.
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.stock_movements
FROM authenticated;


-- ------------------------------------------------------------
-- PURCHASE ITEMS
--
-- Criação e edição acontecem por:
-- save_purchase_item()
-- finalize_purchase_item()
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.purchase_items
FROM authenticated;


-- ------------------------------------------------------------
-- RECIPE ITEMS
--
-- INSERT/UPDATE já possuem RPC save_recipe_item().
--
-- DELETE continua permitido porque existe caller ativo:
-- excluirItemReceitaNoSupabase()
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE
ON TABLE public.recipe_items
FROM authenticated;


-- ------------------------------------------------------------
-- USER PERMISSIONS
--
-- Não existe nenhuma tela utilizando escrita direta atualmente.
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.user_permissions
FROM authenticated;


-- ------------------------------------------------------------
-- PROFILES
--
-- Nenhuma escrita client-side existe.
-- Perfis são geridos por fluxo administrativo server-side.
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.profiles
FROM authenticated;