-- ============================================================
-- L2.1B — Hardening de privilégios das tabelas public
--
-- 1. O cliente anônimo nunca escreve diretamente nas tabelas.
--    Pedidos públicos entram por create_customer_order().
--    Cotações de entrega entram pela Edge Function/service_role.
--
-- 2. anon/authenticated não precisam de privilégios de DDL/estrutura:
--    TRUNCATE, TRIGGER ou REFERENCES.
--
-- Não altera SELECT.
-- Não altera RLS/policies.
-- Não remove escrita de authenticated nesta etapa.
-- ============================================================


-- ============================================================
-- ANON — nenhuma escrita direta nas tabelas public
-- ============================================================

REVOKE INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA public
FROM anon;


-- ============================================================
-- PRIVILÉGIOS ESTRUTURAIS
-- Nenhum cliente web precisa truncar tabela, criar trigger
-- ou criar foreign key.
-- ============================================================

REVOKE TRUNCATE, TRIGGER, REFERENCES
ON ALL TABLES IN SCHEMA public
FROM anon, authenticated;