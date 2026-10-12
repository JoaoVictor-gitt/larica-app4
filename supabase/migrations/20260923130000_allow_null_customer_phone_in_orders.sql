-- Telefone do cliente já é opcional em create_customer_order desde
-- 20260923110000_simplify_customer_details_and_apply_free_delivery.sql (nos 3 fulfilments:
-- Collection, Dine In, Delivery), mas public.orders.customer_phone continuava `text NOT NULL` —
-- nunca havia sido testado com null porque, antes dessa mudança, a RPC sempre exigia telefone
-- preenchido. Mesma classe de bug já corrigida em delivery_quotes.address_line_1
-- (20260923120000_allow_null_address_line_1_in_delivery_quotes.sql).
--
-- Causa confirmada ao vivo no schema real do Supabase (information_schema.columns):
-- customer_phone é `text`, `is_nullable = 'NO'`; consulta às constraints de orders envolvendo
-- customer_phone não retornou nenhuma linha — não há CHECK/constraint própria pra esse campo,
-- só a nullability da coluna precisa mudar.
--
-- Único delta: DROP NOT NULL em customer_phone. customer_name continua obrigatório (checagem
-- intocada em create_customer_order); nenhuma outra coluna/constraint de orders, frontend,
-- Epson, auto-print ou pagamentos é alterada.

ALTER TABLE public.orders
  ALTER COLUMN customer_phone DROP NOT NULL;
