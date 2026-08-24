-- ============================================================
-- L2.1D — production_supplies
--
-- As funções de escrita direta continuam no service apenas por
-- compatibilidade histórica, mas não possuem callers ativos na UI.
--
-- O fluxo atual cria/vincula insumos de produção pelas RPCs
-- seguras de Compras.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.production_supplies
FROM authenticated;