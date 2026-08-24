-- ============================================================
-- L2.1A — Remove acesso anônimo a RPCs administrativas
--
-- Essas funções já possuem validação interna is_staff(), mas
-- não existe motivo para o papel anon conseguir executá-las.
--
-- Permanecem públicas intencionalmente:
--   create_customer_order(jsonb)
--   validate_coupon(text, numeric)
-- ============================================================

-- Ajuste manual de estoque
REVOKE ALL ON FUNCTION public.adjust_stock(uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.adjust_stock(uuid, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, integer, text) TO authenticated;

-- Cancelamento administrativo de pedido
REVOKE ALL ON FUNCTION public.cancel_order(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, text) TO authenticated;

-- Confirmação manual de pagamento
REVOKE ALL ON FUNCTION public.confirm_order_payment(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_order_payment(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.confirm_order_payment(uuid) TO authenticated;

-- Mudança administrativa de status do pedido
REVOKE ALL ON FUNCTION public.update_order_status(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_order_status(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_order_status(uuid, text) TO authenticated;

-- Helper de autorização.
-- O frontend público não precisa perguntar diretamente se um visitante é staff.
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_staff() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;