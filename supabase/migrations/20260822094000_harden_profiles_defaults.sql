-- ============================================================
-- L2.2A — Hardening de profiles
--
-- Novos profiles não devem nascer ativos por padrão.
-- Usuários existentes não são alterados.
-- ============================================================

ALTER TABLE public.profiles
  ALTER COLUMN active SET DEFAULT false;