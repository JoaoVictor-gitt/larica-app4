-- Acompanhamento público de pedido (Parte A) — snapshot da duração da
-- rota no momento da criação do pedido, mesmo padrão já usado por
-- delivery_distance_km/delivery_fee (copiados de delivery_quotes pra
-- orders em create_customer_order, nunca relidos de uma cotação que
-- pode expirar/ser substituída depois). Aditiva, nullable.
--
-- create_customer_order é atualizada em
-- 20260826160000_restrict_card_delivery_and_persist_duration.sql pra
-- popular esta coluna.

alter table public.orders
  add column if not exists delivery_duration_seconds integer;
