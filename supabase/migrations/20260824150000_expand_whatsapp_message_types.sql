-- L2.5E — Amplia whatsapp_messages_type_valido pros tipos reais de
-- mensagem da Meta Cloud API. A lista original (20260824130000) cobria só
-- 7 valores; o W2.4/W3.1 confirmaram que isso deixa de fora tipos comuns
-- (video, sticker, contacts, button, reaction) e o tipo de pedido via
-- catálogo (order), além de um valor de escape (unknown) — sem esses,
-- o primeiro vídeo/figurinha recebido pelo futuro webhook quebraria o
-- INSERT em whatsapp_messages por violação de CHECK.
--
-- Só a constraint muda (DROP + ADD do mesmo nome, mesma tabela). Nenhuma
-- coluna é alterada, nenhum dado é tocado, nenhuma outra constraint é
-- tocada. message_type continua NOT NULL DEFAULT 'text' — inalterado.
--
-- NÃO altera whatsapp_sessions, orders, delivery_quotes,
-- create_customer_order, worker/index.ts, frontend. NÃO cria webhook, RPC
-- de WhatsApp nem integra Meta/OpenAI.
--
-- Fallback futuro (documentado aqui, não implementado): tipos
-- reconhecidos pela Meta são persistidos com o tipo real (agora incluindo
-- video/sticker/contacts/button/reaction/order). 'unknown' existe como
-- valor de escape controlado para o handler do webhook usar quando a Meta
-- enviar, no futuro, um tipo de mensagem que nem esta lista ampliada
-- cobre — o handler deve mapear explicitamente pra 'unknown' (ou
-- 'system', se for um evento sem conteúdo de usuário) antes do INSERT,
-- nunca deixar um tipo desconhecido violar o CHECK e derrubar o
-- processamento do webhook inteiro.

ALTER TABLE public.whatsapp_messages
  DROP CONSTRAINT whatsapp_messages_type_valido;

ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_type_valido
    CHECK (message_type IN (
      'text',
      'interactive',
      'image',
      'document',
      'audio',
      'location',
      'video',
      'sticker',
      'contacts',
      'button',
      'reaction',
      'order',
      'unknown',
      'system'
    ));
