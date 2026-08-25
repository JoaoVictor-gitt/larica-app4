-- ============================================================
-- L2.5D — Hardening corretivo dos GRANTs de whatsapp_sessions/
-- whatsapp_messages.
--
-- Achado no banco vivo: authenticated recebeu INSERT/UPDATE/DELETE nas
-- duas tabelas, além do SELECT esperado — não bate com o GRANT SELECT
-- único que as migrations 20260824120000/20260824130000 emitem. Causa
-- provável: privilégio herdado via ALTER DEFAULT PRIVILEGES do projeto
-- pra authenticated em tabelas novas (mesmo risco já documentado no
-- comentário de GRANTs dessas duas migrations, mas coberto lá só pra
-- anon/PUBLIC, não pra authenticated).
--
-- Corrige revogando INSERT/UPDATE/DELETE de authenticated nas duas
-- tabelas e reafirmando SELECT, sem alterar nada além disso.
--
-- NÃO altera RLS/policies.
-- NÃO altera as tabelas/schema (colunas, constraints, índices).
-- NÃO altera as migrations 20260824120000/20260824130000.
-- NÃO altera anon/PUBLIC — já sem nenhum privilégio nas duas tabelas
-- (confirmado nas migrations originais); nenhum GRANT novo é criado pra
-- eles aqui, nenhuma linha desta migration os menciona.
-- NÃO altera service_role — continua operando normalmente (bypass de
-- RLS, papel do Supabase, fora do alcance de REVOKE/GRANT de tabela).
-- ============================================================


-- ------------------------------------------------------------
-- WHATSAPP_SESSIONS
--
-- Escrita continua reservada a service_role (handler do webhook, etapa
-- futura) ou a uma futura RPC SECURITY DEFINER — authenticated nunca
-- deveria ter tido INSERT/UPDATE/DELETE aqui.
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.whatsapp_sessions
FROM authenticated;

GRANT SELECT
ON TABLE public.whatsapp_sessions
TO authenticated;


-- ------------------------------------------------------------
-- WHATSAPP_MESSAGES
--
-- Tabela append-only por design (ver 20260824130000) — authenticated
-- nunca deveria ter tido INSERT/UPDATE/DELETE aqui.
-- ------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.whatsapp_messages
FROM authenticated;

GRANT SELECT
ON TABLE public.whatsapp_messages
TO authenticated;
