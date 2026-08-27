-- Campos de troco pro motor conversacional do WhatsApp, parte do W4.5
-- (pagamento + cupom). whatsapp_sessions já tinha payment_method e
-- coupon_code (W2.2) — faltavam needs_change/cash_amount, confirmados
-- ausentes por leitura direta da migration original. Mesmos nomes e
-- mesma semântica de orders.needs_change/orders.cash_amount
-- (create_customer_order, 20260817140000) — nunca duplica
-- subtotal/total/desconto/troco calculado: cash_amount aqui é só o
-- valor que o cliente informou que vai pagar em dinheiro, igual ao
-- payload que create_customer_order já aceita e recalcula o troco
-- (v_change) por conta própria — esta sessão nunca armazena troco.
--
-- needs_change=true exige payment_method='cash' (CHECK) — mas NÃO
-- exige cash_amount preenchido a nível de tabela (isso é
-- responsabilidade da RPC apply_whatsapp_payment_intent, que só
-- avança o fluxo quando cash_amount está presente; a nível de coluna
-- só se garante que cash_amount nunca é <= 0 quando preenchido).
--
-- Nenhum GRANT novo necessário: whatsapp_sessions usa GRANT de tabela
-- inteira (não por coluna, diferente de business_settings) —
-- REVOKE ALL de anon/PUBLIC e GRANT SELECT pra authenticated já
-- cobrem as colunas novas automaticamente (20260824120000).
--
-- NÃO altera nenhuma RPC, orders, create_customer_order,
-- business_settings, worker/index.ts.

ALTER TABLE public.whatsapp_sessions
  ADD COLUMN needs_change boolean NOT NULL DEFAULT false,
  ADD COLUMN cash_amount  numeric NULL;

ALTER TABLE public.whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_needs_change_requer_cash
    CHECK (needs_change = false OR payment_method = 'cash');

ALTER TABLE public.whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_cash_amount_positivo
    CHECK (cash_amount IS NULL OR cash_amount > 0);
