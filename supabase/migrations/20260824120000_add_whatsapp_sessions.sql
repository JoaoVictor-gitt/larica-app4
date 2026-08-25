-- Fundação WhatsApp + IA — ETAPA 1 (só whatsapp_sessions).
-- Cria public.whatsapp_sessions: estado de uma conversa de WhatsApp por
-- telefone (estágio do fluxo, carrinho em progresso, dados de
-- fulfilment/pagamento coletados durante a conversa, vínculo opcional com
-- o pedido gerado e flag de atendimento humano). Não cria
-- whatsapp_messages (idempotência de mensagem, etapa própria), customers,
-- RPC de escrita, webhook, normalização de telefone, limpeza automática de
-- sessão ou qualquer integração com Meta/OpenAI — tudo isso fica pra
-- etapas seguintes, ainda não aprovadas pra implementação.
--
-- Não altera public.orders, public.delivery_quotes nem
-- create_customer_order — a RPC de criação de pedido continua sendo a
-- única fonte de verdade pra preço/desconto/taxa de entrega/
-- disponibilidade/total; esta tabela nunca armazena nenhum desses valores
-- (ver comentário na coluna cart abaixo).
--
-- FK delivery_quote_id -> delivery_quotes(id): confirmado nas migrations
-- 20260817120000/20260817140000 e na Edge Function calculate-delivery que
-- essa tabela só recebe INSERT em todo o projeto — não existe nenhum
-- DELETE/limpeza/cron tocando delivery_quotes, só expiração lógica via
-- expires_at (checada dentro de create_customer_order). Como a tabela
-- nunca é apagada fisicamente, a FK é segura: nunca vai bloquear uma
-- exclusão que de fato acontece na prática.
--
-- Escrita: nenhum GRANT de INSERT/UPDATE/DELETE é concedido aqui, nem pra
-- anon nem pra authenticated — toda escrita futura (handler do webhook,
-- etapa própria) deve usar a chave service_role, mesmo padrão já usado
-- pela Edge Function calculate-delivery (nunca exposta ao navegador).
-- authenticated recebe só SELECT, gated por is_staff(), pra uma futura
-- tela de conversas no Admin. Só a policy de SELECT é criada nesta etapa —
-- sem policies de INSERT/UPDATE/DELETE "de documentação" ainda, porque
-- nenhuma RPC de escrita existe pra elas servirem de referência (diferente
-- de lots/lot_movements, que já sabiam a forma da RPC futura).

-- =============================================================
-- 1. Tabela whatsapp_sessions.
-- Uma linha = um episódio de conversa. state e human_handoff são
-- ortogonais: human_handoff pausa a IA independente de em que estágio do
-- fluxo a conversa está. cart é jsonb no mesmo formato de payload.items já
-- aceito por create_customer_order — nunca contém price/subtotal/
-- discount/delivery_fee/total, só a escolha do cliente (item_type,
-- product_id, quantity, selections). eircode/address_line_*/area/
-- delivery_instructions espelham os mesmos nomes usados no payload da RPC,
-- sem tradução extra no checkout. order_id é FK opcional e unidirecional —
-- orders não ganha nenhuma coluna/FK/trigger novo, continua funcionando
-- de forma idêntica a hoje. human_handoff_by fica sem FK nesta etapa,
-- mesmo padrão já usado em ingredients.updated_by/lots.created_by: não há
-- CREATE TABLE de public.profiles neste repositório pra confirmar com
-- segurança a relação com auth.users.
-- =============================================================

CREATE TABLE public.whatsapp_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  phone                  text NOT NULL,
  customer_name          text NULL,
  language               text NOT NULL DEFAULT 'pt',

  state                  text NOT NULL DEFAULT 'greeting',

  cart                   jsonb NOT NULL DEFAULT '[]'::jsonb,

  fulfilment_type        text NULL,
  eircode                text NULL,
  address_line_1         text NULL,
  address_line_2         text NULL,
  area                   text NULL,
  delivery_instructions  text NULL,
  delivery_quote_id      uuid NULL REFERENCES public.delivery_quotes(id),

  payment_method         text NULL,
  coupon_code            text NULL,

  order_id               uuid NULL REFERENCES public.orders(id),

  human_handoff          boolean NOT NULL DEFAULT false,
  human_handoff_at       timestamptz NULL,
  human_handoff_by       uuid NULL,

  last_message_at        timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_sessions_phone_formato_valido
    CHECK (phone ~ '^[1-9][0-9]{6,14}$'),

  CONSTRAINT whatsapp_sessions_language_valido
    CHECK (language IN ('pt', 'en')),

  CONSTRAINT whatsapp_sessions_state_valido
    CHECK (state IN (
      'greeting',
      'browsing_menu',
      'building_cart',
      'collecting_fulfilment',
      'collecting_address',
      'collecting_payment',
      'reviewing_order',
      'awaiting_confirmation',
      'order_created',
      'closed'
    )),

  CONSTRAINT whatsapp_sessions_cart_e_array
    CHECK (jsonb_typeof(cart) = 'array'),

  CONSTRAINT whatsapp_sessions_fulfilment_type_valido
    CHECK (fulfilment_type IS NULL OR fulfilment_type IN ('collection', 'delivery')),

  CONSTRAINT whatsapp_sessions_payment_method_valido
    CHECK (payment_method IS NULL OR payment_method IN ('card', 'cash', 'revolut', 'bank_transfer'))
);

-- =============================================================
-- 2. Índices. No máximo uma sessão ABERTA por telefone (índice único
-- parcial) — sessões fechadas não contam, permitindo múltiplos episódios
-- históricos por telefone sem sobrescrever o anterior.
-- =============================================================

CREATE UNIQUE INDEX idx_whatsapp_sessions_phone_open
  ON public.whatsapp_sessions (phone)
  WHERE state <> 'closed';

CREATE INDEX idx_whatsapp_sessions_phone
  ON public.whatsapp_sessions (phone);

CREATE INDEX idx_whatsapp_sessions_state
  ON public.whatsapp_sessions (state);

CREATE INDEX idx_whatsapp_sessions_last_message_at
  ON public.whatsapp_sessions (last_message_at);

CREATE INDEX idx_whatsapp_sessions_order_id
  ON public.whatsapp_sessions (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX idx_whatsapp_sessions_human_handoff
  ON public.whatsapp_sessions (human_handoff)
  WHERE human_handoff = true;

-- =============================================================
-- 3. RLS — anon e PUBLIC sem acesso algum (cliente de WhatsApp nunca é um
-- usuário Supabase). authenticated só enxerga (SELECT) quando is_staff(),
-- pra uma futura tela de conversas no Admin. Sem policy de INSERT/UPDATE/
-- DELETE: nenhuma escrita direta é permitida nesta etapa, nem pelo
-- frontend nem por staff — toda escrita fica pra service_role (webhook,
-- etapa futura) ou pra uma RPC SECURITY DEFINER dedicada (também futura).
-- =============================================================

ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_sessions_select_staff
  ON public.whatsapp_sessions
  FOR SELECT
  TO authenticated
  USING (public.is_staff());

-- =============================================================
-- 4. GRANTs — REVOKE explícito antes do GRANT (mesma cautela já usada em
-- ingredients: uma tabela nova pode herdar privilégio de anon via ALTER
-- DEFAULT PRIVILEGES do projeto, "nenhum GRANT concedido" não é garantia
-- por si só). authenticated recebe só SELECT — coerente com não haver
-- nenhuma policy de escrita na seção 3.
-- =============================================================

REVOKE ALL PRIVILEGES
  ON TABLE public.whatsapp_sessions
  FROM anon;

REVOKE ALL PRIVILEGES
  ON TABLE public.whatsapp_sessions
  FROM PUBLIC;

REVOKE REFERENCES, TRIGGER, TRUNCATE
  ON TABLE public.whatsapp_sessions
  FROM authenticated;

GRANT SELECT
  ON TABLE public.whatsapp_sessions
  TO authenticated;

-- Confirmado propositalmente: anon e PUBLIC sem privilégio algum;
-- authenticated só com SELECT. Nenhuma escrita é possível por RLS/GRANT
-- nesta etapa — só service_role (fora do alcance de RLS) poderá escrever,
-- quando o handler do webhook for implementado numa etapa futura.

-- Nenhuma outra alteração: whatsapp_messages, customers, orders,
-- delivery_quotes, create_customer_order, worker/index.ts, frontend e
-- qualquer RPC de WhatsApp permanecem exatamente como estavam.
