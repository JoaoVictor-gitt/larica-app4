-- Corrige confirm_order_payment: Transferência Bancária (bank_transfer) também
-- recebe payment_status='pending' (ver create_customer_order,
-- 20260817130000_add_bank_transfer_payment_method.sql em diante), exatamente
-- como Revolut, e o frontend (js/pedidos.js:392-398, pedidoAguardandoPagamento)
-- já mostra "Confirmar pagamento" pros dois métodos. Mas esta RPC nunca foi
-- atualizada quando bank_transfer foi introduzida, travada só em 'revolut' —
-- causa raiz confirmada em auditoria. Única mudança funcional: a allowlist de
-- payment_method na linha equivalente a "if v_order.payment_method <> 'revolut'".
-- Todo o resto do corpo é idêntico, byte a byte, à definição vigente em
-- 20260824110000_baseline_current_admin_rpcs.sql:199-242 (não editada — só
-- fotografa o estado anterior, nunca deve ser alterada por convenção do
-- projeto). Cash/Card nunca chegam com payment_status='pending', então
-- continuam fora desta allowlist sem precisar de exceção explícita. Grants
-- existentes (20260822090000_revoke_anon_admin_rpcs.sql: REVOKE ALL FROM
-- PUBLIC, REVOKE EXECUTE FROM anon, GRANT EXECUTE TO authenticated) não
-- precisam ser repetidos — CREATE OR REPLACE FUNCTION preserva os privilégios
-- já concedidos numa função com a mesma assinatura/dono.

CREATE OR REPLACE FUNCTION public.confirm_order_payment(p_order_id uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_order public.orders;
begin

  if not public.is_staff() then
    raise exception 'Apenas a equipe pode confirmar pagamentos.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;

  if not found then
    raise exception 'Pedido não encontrado.';
  end if;

  if v_order.payment_method not in ('revolut', 'bank_transfer') then
    raise exception 'Este pedido não usa confirmação manual de pagamento.';
  end if;

  if v_order.payment_status <> 'pending' then
    raise exception 'Pagamento deste pedido já foi processado.';
  end if;

  if v_order.status <> 'requested' then
    raise exception 'Pedido não está mais aguardando confirmação.';
  end if;

  update public.orders
  set payment_status = 'paid',
      payment_confirmed_at = now(),
      payment_confirmed_by = auth.uid()
  where id = p_order_id;

  select * into v_order from public.orders where id = p_order_id;

  return v_order;

end;
$function$;
