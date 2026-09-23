-- Etapa 2.2 do redesign Larica — bucket de Storage site-media, dedicado às
-- mídias públicas do site (Hero agora; Galeria/institucional no futuro).
-- Separado de business-assets (QR Revolut) e do image_url em base64 de
-- produtos — nenhum dos dois é tocado aqui. Só cria/configura o bucket e as
-- policies de storage.objects; nenhum upload, nenhuma mudança de código.

-- =============================================================
-- 1. Bucket — público para leitura (a home busca as mídias por URL pública,
-- sem autenticação), com MIME e tamanho restritos no próprio bucket como
-- primeira camada de defesa (o frontend, numa etapa futura, vai validar de
-- novo e com limites mais restritos: 5 MB imagem / 30 MB vídeo).
-- ON CONFLICT torna a criação idempotente — rodar de novo não falha nem
-- duplica; se o bucket já existir, reafirma name/public/file_size_limit/
-- allowed_mime_types com os valores desta migration, em vez de simplesmente
-- ignorar (id é a chave primária de storage.buckets, então ON CONFLICT (id)
-- DO UPDATE é um upsert padrão do Postgres, sem nenhuma particularidade do
-- Storage).
-- =============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'site-media',
  'site-media',
  true,
  31457280, -- 30 MB em bytes (30 * 1024 * 1024) — teto do bucket; ver nota acima sobre limites do frontend
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4']
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- =============================================================
-- 2. Policies de storage.objects — escopadas somente a bucket_id='site-media'
-- (nunca mexem em business-assets nem em nenhum outro bucket). Sem policy de
-- SELECT para anon: leitura pública já é resolvida pelo bucket public=true
-- (endpoint /storage/v1/object/public/..., fora da RLS) — ver explicação no
-- relatório desta etapa. anon não tem EXECUTE em is_staff() (revogado em
-- 20260822090000), então nenhuma policy aqui pode ser TO anon usando essa
-- função; todas são TO authenticated. DROP POLICY IF EXISTS antes de cada
-- CREATE torna a migration segura de rodar mais de uma vez (Postgres não tem
-- "CREATE POLICY IF NOT EXISTS").
-- =============================================================

DROP POLICY IF EXISTS "site_media_staff_select" ON storage.objects;
CREATE POLICY "site_media_staff_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'site-media' AND public.is_staff());

DROP POLICY IF EXISTS "site_media_staff_insert" ON storage.objects;
CREATE POLICY "site_media_staff_insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'site-media' AND public.is_staff());

DROP POLICY IF EXISTS "site_media_staff_update" ON storage.objects;
CREATE POLICY "site_media_staff_update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'site-media' AND public.is_staff())
  WITH CHECK (bucket_id = 'site-media' AND public.is_staff());

DROP POLICY IF EXISTS "site_media_staff_delete" ON storage.objects;
CREATE POLICY "site_media_staff_delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'site-media' AND public.is_staff());
