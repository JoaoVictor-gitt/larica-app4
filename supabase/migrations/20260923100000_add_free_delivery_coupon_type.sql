-- Adiciona o tipo de cupom "Free Delivery" (discount_type = 'free_delivery'), que zera SÓ a taxa
-- de entrega — nunca o subtotal/desconto de produto. Reaproveita a mesma coluna discount_type já
-- usada por 'percentage'/implícito-'fixed' (auditoria: nenhuma tabela/coluna nova de cupom é
-- necessária — toda a máquina existente, validade/mínimo/ativo/inativo, já opera genericamente por
-- discount_type). Este migration só mexe em validate_coupon e nas 2 CHECK constraints reais de
-- coupons (discount_type/discount_value, nomes confirmados ao vivo) — a lógica de ZERAR a taxa de
-- entrega em si (autoritativa, nunca confiando
-- no client) fica em create_customer_order, migration separada
-- (20260923110000_simplify_customer_details_and_apply_free_delivery.sql).
--
-- Compatibilidade: cupons 'percentage' e o "else = fixed" existentes continuam com o MESMO
-- comportamento de hoje — o branch novo é adicionado, nenhum dos dois branches existentes é tocado.
-- Welcome10/Parceiro10/Irlanda10 (ou qualquer cupom já cadastrado) não mudam de comportamento.

-- 1) CHECK constraints de coupons.discount_type/discount_value — nomes e definições confirmados
--    AO VIVO no Supabase antes desta correção (não adivinhados, não descobertos por texto):
--
--      coupons_discount_type_check
--        CHECK (discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text]))
--
--      coupons_discount_value_check
--        CHECK (
--          (discount_type = 'percentage' AND discount_value > 0 AND discount_value <= 100)
--          OR (discount_type = 'fixed' AND discount_value > 0)
--        )
--
--    Confirmado também: discount_type é text NOT NULL (sem enum nativo por trás — query em
--    pg_enum não retornou linha nenhuma); os 5 cupons cadastrados hoje são todos 'percentage';
--    nenhum cupom 'fixed' existe ainda, mas o valor continua legítimo pra coluna.
--
--    Versão anterior deste arquivo (nunca executada) descobria a constraint de discount_type por
--    "ILIKE '%discount_type%'" em pg_get_constraintdef — isso podia colidir com
--    coupons_discount_value_check, que também menciona discount_type dentro da sua expressão
--    condicional. Substituído por DROP/ADD explícitos pelos 2 nomes reais — determinístico, sem
--    risco de pegar a constraint errada.
--
--    discount_value permanece NOT NULL, sem alteração de coluna — free_delivery grava sempre 0
--    (nunca NULL). O admin já envia esse valor hoje sem nenhuma mudança adicional:
--    js/configuracoes.js:cupomDoFormulario() força valorDesconto=0 pra qualquer tipo que não seja
--    'percentage', e js/services/coupons-service.js:_cupomParaLinhaSupabase() manda isso como
--    discount_value: Number(0) = 0 pro Supabase.
ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_discount_type_check;

ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_discount_type_check
  CHECK (discount_type IN ('percentage', 'fixed', 'free_delivery'));

ALTER TABLE public.coupons
  DROP CONSTRAINT IF EXISTS coupons_discount_value_check;

ALTER TABLE public.coupons
  ADD CONSTRAINT coupons_discount_value_check
  CHECK (
    (discount_type = 'percentage' AND discount_value > 0 AND discount_value <= 100)
    OR (discount_type = 'fixed' AND discount_value > 0)
    OR (discount_type = 'free_delivery' AND discount_value = 0)
  );

-- 2) validate_coupon: corpo idêntico, byte a byte, à definição vigente em
--    20260824110000_baseline_current_admin_rpcs.sql:88-149 (nunca redefinida desde então), com um
--    único delta — um 3º branch para discount_type = 'free_delivery', inserido ANTES do "else"
--    original (que continua sendo o fallback de 'fixed', intocado). Para free_delivery,
--    discount_amount é sempre 0: este cupom nunca desconta produto, só a entrega (zerada depois,
--    em create_customer_order, nunca aqui). discount_value do cupom não é usado pra calcular esse
--    0 — a coluna é NOT NULL (confirmado ao vivo), então o cadastro sempre grava exatamente 0 pra
--    free_delivery (nunca NULL), já exigido pela nova coupons_discount_value_check acima; a UI de
--    admin esconde o campo de valor pra Free Delivery e envia 0 automaticamente.
CREATE OR REPLACE FUNCTION public.validate_coupon(p_code text, p_subtotal numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_code text := nullif(upper(trim(p_code)), '');
  v_coupon record;
  v_discount_amount numeric;
begin

  if v_code is null then
    raise exception 'Informe um código de cupom.';
  end if;

  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'Subtotal inválido.';
  end if;

  select *
  into v_coupon
  from public.coupons
  where code = v_code;

  if v_coupon.id is null then
    raise exception 'Cupom não encontrado.';
  end if;

  if not v_coupon.active then
    raise exception 'Este cupom está inativo.';
  end if;

  if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
    raise exception 'Este cupom ainda não é válido.';
  end if;

  if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
    raise exception 'Este cupom expirou.';
  end if;

  if v_coupon.minimum_order_value is not null and p_subtotal < v_coupon.minimum_order_value then
    raise exception 'Pedido mínimo de €% para este cupom.', v_coupon.minimum_order_value;
  end if;

  if v_coupon.discount_type = 'percentage' then
    v_discount_amount := least(round(p_subtotal * v_coupon.discount_value / 100, 2), p_subtotal);
  elsif v_coupon.discount_type = 'free_delivery' then
    v_discount_amount := 0;
  else
    v_discount_amount := least(v_coupon.discount_value, p_subtotal);
  end if;

  return jsonb_build_object(
    'valid', true,
    'coupon_id', v_coupon.id,
    'code', v_coupon.code,
    'discount_type', v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'discount_amount', v_discount_amount
  );

end;
$function$;
