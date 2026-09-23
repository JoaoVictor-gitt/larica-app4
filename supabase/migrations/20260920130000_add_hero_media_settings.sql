-- Etapa 2.1 do redesign Larica — infraestrutura de configuração do Hero (home
-- pública). Só schema + permissões: nenhum bucket, nenhum upload, nenhuma
-- mudança em Configurações/Home nesta etapa. hero_media_type/hero_media_path/
-- hero_poster_path guardam só o tipo e o path no Storage (bucket a ser criado
-- numa etapa futura) — nunca a URL pública, que será sempre derivada do path
-- via getPublicUrl() no momento do uso (mesmo padrão de revolut_qr_path).

-- =============================================================
-- 1. Novas colunas em business_settings (aditivo, tudo aceita NULL)
-- =============================================================

ALTER TABLE public.business_settings
  ADD COLUMN IF NOT EXISTS hero_media_type text,
  ADD COLUMN IF NOT EXISTS hero_media_path text,
  ADD COLUMN IF NOT EXISTS hero_poster_path text;

-- =============================================================
-- 2. CHECK constraint — hero_media_type só aceita 'image'/'video'/NULL.
-- Idempotente, mesmo padrão de orders_auto_print_status_check (migration
-- 20260920110000): verifica pg_constraint antes de criar.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_settings_hero_media_type_check'
  ) THEN
    ALTER TABLE public.business_settings
      ADD CONSTRAINT business_settings_hero_media_type_check
      CHECK (hero_media_type IS NULL OR hero_media_type IN ('image', 'video'));
  END IF;
END $$;

-- =============================================================
-- 3. GRANTs por coluna — mesmo padrão já usado por revolut_qr_path/
-- bank_transfer_*/auto_print_* (migrations 20260817130000/20260920120000):
-- SELECT das 3 colunas novas pra anon + authenticated (a home pública vai
-- precisar ler); INSERT/UPDATE só pra authenticated (nunca anon). Nenhum
-- GRANT existente é tocado; nenhuma outra coluna/tabela é mencionada aqui.
-- =============================================================

GRANT SELECT (hero_media_type, hero_media_path, hero_poster_path)
  ON public.business_settings TO anon, authenticated;

GRANT INSERT (hero_media_type, hero_media_path, hero_poster_path)
  ON public.business_settings TO authenticated;

GRANT UPDATE (hero_media_type, hero_media_path, hero_poster_path)
  ON public.business_settings TO authenticated;
