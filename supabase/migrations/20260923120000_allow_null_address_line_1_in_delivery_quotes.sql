-- Corrige o HTTP 500 "Não foi possível registrar a cotação de entrega" ao calcular entrega com
-- Address Line 1 vazio: calculate-delivery (já publicada) envia address_line_1=null desde a
-- simplificação de endereço (20260923110000_simplify_customer_details_and_apply_free_delivery.sql),
-- mas public.delivery_quotes.address_line_1 continuava `text NOT NULL` — nunca havia sido testado
-- com null porque, antes dessa mudança, a Edge Function sempre exigia address_line_1 preenchido.
-- Causa confirmada ao vivo no schema real do Supabase (information_schema.columns): address_line_1
-- é `text`, `is_nullable = 'NO'`; as únicas constraints existentes na tabela são
-- delivery_fee >= 0, distance_km >= 0, travel_mode = 'BICYCLE' e a primary key — nenhuma
-- relacionada a endereço, então basta relaxar a nullability da coluna.
--
-- Único delta: DROP NOT NULL em address_line_1. Não altera eircode (continua NOT NULL, obrigatório
-- para Delivery), address_line_2, area, distance_km, delivery_fee, travel_mode, expires_at, nenhuma
-- constraint existente, calculate-delivery nem create_customer_order — nenhum desses precisa mudar.

ALTER TABLE public.delivery_quotes
  ALTER COLUMN address_line_1 DROP NOT NULL;
