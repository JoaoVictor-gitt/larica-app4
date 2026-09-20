-- Corrige "permission denied for table business_settings" ao ler/gravar o
-- toggle de impressão automática (Configurações). business_settings usa
-- GRANT por coluna (não table-level) — confirmado em
-- 20260817130000_add_bank_transfer_payment_method.sql e
-- 20260817150000_add_preparation_target_minutes.sql — e a migration anterior
-- (20260920110000_add_auto_print_infrastructure.sql) adicionou
-- auto_print_enabled/auto_print_enabled_at sem o GRANT correspondente.
--
-- Mesmo padrão de preparation_target_minutes: coluna administrativa, usada só
-- por /pedidos e /configuracoes — NENHUM acesso concedido a anon.
--
-- Não toca RLS, RPCs, nem a migration anterior. claim_order_auto_print/
-- resolve_order_auto_print são SECURITY DEFINER e nunca dependeram destes
-- GRANTs (rodam com o privilégio do dono da função).

GRANT SELECT (auto_print_enabled, auto_print_enabled_at)
  ON public.business_settings TO authenticated;

GRANT INSERT (auto_print_enabled, auto_print_enabled_at)
  ON public.business_settings TO authenticated;

GRANT UPDATE (auto_print_enabled, auto_print_enabled_at)
  ON public.business_settings TO authenticated;

-- Confirmado propositalmente: NENHUM GRANT concedido a anon nestas colunas,
-- e nenhum GRANT na tabela inteira (só nas 2 colunas acima).
