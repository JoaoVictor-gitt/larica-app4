-- Defesa em profundidade pro W5.2: garante estruturalmente que dois
-- whatsapp_sessions nunca apontem pro mesmo orders.id. Postgres trata
-- múltiplos NULL como não-conflitantes num UNIQUE simples, então não
-- atrapalha nenhuma sessão sem pedido (a imensa maioria).
--
-- create_order_from_whatsapp_session (20260825110000) já garante isso
-- pelo caminho normal — é a única RPC que escreve em order_id, sempre
-- sob SELECT...FOR UPDATE da própria sessão — esta constraint é
-- redundante com esse comportamento, não uma correção de bug; mesmo
-- estilo de defesa barata já usado nos CHECKs de
-- needs_change/cash_amount (20260824210000), que também são
-- redundantes com a validação da RPC mas mantidos por segurança
-- estrutural contra um hipotético bypass futuro (ex.: um UPDATE manual
-- de staff apontando duas sessões pro mesmo pedido).
--
-- Migration separada por instrução explícita — não misturada na
-- migration da RPC.
--
-- NÃO altera create_order_from_whatsapp_session, create_customer_order,
-- orders, nenhuma outra coluna/constraint de whatsapp_sessions.

ALTER TABLE public.whatsapp_sessions
  ADD CONSTRAINT whatsapp_sessions_order_id_unico UNIQUE (order_id);
