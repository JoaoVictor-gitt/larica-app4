-- Acompanhamento público de pedido (Parte A) — a Edge Function
-- calculate-delivery já calcula a duração da rota (route.duration da
-- Google Routes API) mas nunca a persistia em delivery_quotes, só
-- devolvia na resposta HTTP. Sem persistir, a página de acompanhamento
-- não teria como calcular uma previsão de entrega real sem inventar um
-- número — esta coluna fecha esse gap. Aditiva, nullable — zero efeito
-- em cotações já existentes (ficam com duration_seconds = null).
--
-- supabase/functions/calculate-delivery/index.ts precisa ser atualizada
-- (feito nesta mesma etapa) e reimplantada (`supabase functions deploy
-- calculate-delivery`) pra esta coluna começar a ser preenchida.

alter table public.delivery_quotes
  add column if not exists duration_seconds integer;
