-- Fundação WhatsApp + IA — ETAPA 2 (whatsapp_messages).
-- Cria public.whatsapp_messages: log append-only de cada mensagem
-- trocada (entrada ou saída) numa conversa de WhatsApp, e a guarda de
-- idempotência contra reentrega de webhook da Meta. Depende de
-- public.whatsapp_sessions (criada em 20260824120000_add_whatsapp_sessions.sql)
-- — não a altera. Não cria customers, webhook, RPC de WhatsApp,
-- Cloudflare Queue, normalização de telefone, admin de conversas,
-- notificações, nem qualquer integração com Meta/OpenAI — fica pra etapas
-- seguintes, ainda não aprovadas.
--
-- Não altera public.orders, public.delivery_quotes, create_customer_order,
-- worker/index.ts nem o frontend.
--
-- IMPORTANTE sobre idempotência: provider_message_id (id atribuído pela
-- Meta a cada mensagem) é a chave de deduplicação DE MENSAGEM — o índice
-- único parcial abaixo é a guarda atômica que um futuro handler de webhook
-- deve usar via `INSERT ... ON CONFLICT (provider_message_id) DO NOTHING`.
-- Essa lógica de INSERT/webhook NÃO é implementada nesta migration, só a
-- estrutura de banco que a viabiliza. Esta tabela, sozinha, NÃO resolve
-- idempotência de CRIAÇÃO DE PEDIDO — isso é um problema distinto (evitar
-- que o mesmo checkout gere dois pedidos em create_customer_order) e terá
-- mecanismo próprio na W5, fora do escopo desta etapa.
--
-- session_id -> whatsapp_sessions(id) ON DELETE CASCADE: única relação de
-- posse real do par de tabelas — uma mensagem não tem utilidade fora do
-- contexto da sessão a que pertence, mesmo critério já usado no projeto
-- para recipe_items -> recipes e purchase_lines -> purchases. Não altera
-- whatsapp_sessions em nenhum aspecto.

-- =============================================================
-- 1. Tabela whatsapp_messages.
-- Append-only por design: sem updated_at (nada aqui é editado depois de
-- criado), sem RPC de edição/exclusão nesta etapa. processed_at começa
-- NULL (mensagem registrada, ainda não processada pelo pipeline) e só
-- deve ser preenchido futuramente por um caminho confiável (service_role
-- ou RPC dedicada) — nenhum desses caminhos é criado aqui. phone usa o
-- MESMO CHECK de formato de whatsapp_sessions.phone (constraint própria,
-- nomeada, sem depender de trigger ou de alterar a outra tabela).
-- raw_payload é só pra auditoria/debug do evento bruto recebido — por
-- design, nunca deve conter segredos (tokens, assinaturas de webhook),
-- ainda que nenhuma validação de conteúdo sensível seja imposta aqui.
-- =============================================================

CREATE TABLE public.whatsapp_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE CASCADE,
  phone                 text NOT NULL,
  direction             text NOT NULL,
  provider_message_id   text NULL,
  message_type          text NOT NULL DEFAULT 'text',
  body                  text NULL,
  raw_payload           jsonb NULL,
  processed_at          timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_messages_phone_formato_valido
    CHECK (phone ~ '^[1-9][0-9]{6,14}$'),

  CONSTRAINT whatsapp_messages_direction_valido
    CHECK (direction IN ('inbound', 'outbound')),

  CONSTRAINT whatsapp_messages_type_valido
    CHECK (message_type IN (
      'text',
      'interactive',
      'image',
      'document',
      'audio',
      'location',
      'system'
    )),

  CONSTRAINT whatsapp_messages_raw_payload_e_objeto
    CHECK (raw_payload IS NULL OR jsonb_typeof(raw_payload) = 'object')
);

-- =============================================================
-- 2. Índices. O único parcial em provider_message_id é a guarda de
-- idempotência (seção de idempotência acima) — NULL é permitido (não
-- entra na constraint) pra cobrir a rara linha de sistema sem
-- correspondência a uma mensagem real da API. session_id/phone/created_at
-- cobrem as consultas óbvias (mensagens de uma sessão, de um telefone, em
-- ordem cronológica). Sem índice em processed_at nesta etapa: não existe
-- hoje nenhuma consulta concreta que filtre por ele (o pipeline de
-- processamento ainda não existe) — evitando índice especulativo.
-- =============================================================

CREATE UNIQUE INDEX idx_whatsapp_messages_provider_message_id
  ON public.whatsapp_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX idx_whatsapp_messages_session_id
  ON public.whatsapp_messages (session_id);

CREATE INDEX idx_whatsapp_messages_phone
  ON public.whatsapp_messages (phone);

CREATE INDEX idx_whatsapp_messages_created_at
  ON public.whatsapp_messages (created_at);

-- =============================================================
-- 3. RLS — mesmo padrão de whatsapp_sessions (20260824120000): anon e
-- PUBLIC sem acesso algum; authenticated só enxerga (SELECT) quando
-- is_staff(), pra uma futura tela de conversas no Admin. Sem policy de
-- INSERT/UPDATE/DELETE: tabela append-only, sem edição/exclusão via RLS
-- nesta etapa — escrita fica pra service_role (webhook, etapa futura).
-- =============================================================

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_messages_select_staff
  ON public.whatsapp_messages
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- =============================================================
-- 4. GRANTs — mesmo padrão exato de whatsapp_sessions (20260824120000):
-- REVOKE explícito antes do GRANT; authenticated só com SELECT, coerente
-- com não haver nenhuma policy de escrita na seção 3.
-- =============================================================

REVOKE ALL PRIVILEGES
  ON TABLE public.whatsapp_messages
  FROM anon;

REVOKE ALL PRIVILEGES
  ON TABLE public.whatsapp_messages
  FROM PUBLIC;

REVOKE REFERENCES, TRIGGER, TRUNCATE
  ON TABLE public.whatsapp_messages
  FROM authenticated;

GRANT SELECT
  ON TABLE public.whatsapp_messages
  TO authenticated;

-- Confirmado propositalmente: anon e PUBLIC sem privilégio algum;
-- authenticated só com SELECT. Nenhuma escrita é possível por RLS/GRANT
-- nesta etapa — só service_role (fora do alcance de RLS) poderá inserir,
-- quando o handler do webhook for implementado numa etapa futura.

-- Nenhuma outra alteração: whatsapp_sessions, customers, orders,
-- delivery_quotes, create_customer_order, worker/index.ts, frontend e
-- qualquer RPC de WhatsApp permanecem exatamente como estavam. Idempotência
-- de criação de pedido continua sem mecanismo — fica pra W5.
