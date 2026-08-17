-- Meta de Preparo / SLA (Tempo de Preparo, Etapa 3) — adiciona
-- business_settings.preparation_target_minutes. Não altera nenhuma outra
-- coluna, RPC, trigger ou regra existente. Nunca concede acesso a anon —
-- essa configuração é administrativa (usada em Pedidos/Relatório Diário),
-- o checkout público (pedido.html) nunca precisa conhecê-la.

-- =============================================================
-- 1. Coluna nova (aditiva, default seguro — pedidos existentes não são
-- afetados, a meta só se aplica à leitura/exibição, nunca a create_
-- customer_order/update_order_status/cancel_order, que continuam
-- intocados).
-- =============================================================

ALTER TABLE public.business_settings
  ADD COLUMN preparation_target_minutes integer NOT NULL DEFAULT 20;

ALTER TABLE public.business_settings
  ADD CONSTRAINT business_settings_preparation_target_minutes_check
  CHECK (preparation_target_minutes >= 1 AND preparation_target_minutes <= 240);

-- =============================================================
-- 2. GRANTs — mesmo padrão por coluna já confirmado no projeto pra
-- business_settings (ver migration 20260817130000, seção 2: authenticated
-- tem SELECT/INSERT/UPDATE por coluna; anon nunca recebe INSERT/UPDATE, e
-- nunca é concedido SELECT da tabela inteira). Aqui, diferente das colunas
-- anteriores, anon não recebe GRANT NENHUM nesta coluna — não há caso de
-- uso público pra meta de preparo nesta V1.
--
-- RLS confirmada nas policies reais do Supabase (revisão pós-implementação):
-- "Public can view business settings" (SELECT, anon+authenticated) e as
-- policies de INSERT/UPDATE (authenticated + is_staff()) não distinguem
-- admin de employee nesta tabela — qualquer staff autenticado pode editar
-- qualquer coluna liberada por GRANT, incluindo esta. A UI (configuracoes.js)
-- não impõe uma restrição de admin que o banco não tem.
-- =============================================================

GRANT SELECT (preparation_target_minutes)
  ON public.business_settings TO authenticated;

GRANT INSERT (preparation_target_minutes)
  ON public.business_settings TO authenticated;

GRANT UPDATE (preparation_target_minutes)
  ON public.business_settings TO authenticated;

-- Confirmado propositalmente: NENHUM GRANT concedido a anon nesta coluna.
