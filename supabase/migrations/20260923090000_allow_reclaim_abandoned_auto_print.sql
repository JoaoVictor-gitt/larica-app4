-- Corrige claim_order_auto_print: um claim 'claimed' nunca resolvido (aba fechou/rede
-- caiu entre o claim e o resolve — risco já documentado na auditoria de auto-print)
-- ficava preso para sempre, porque a condição original só aceitava
-- auto_print_status IS NULL. Única mudança funcional: o WHERE do UPDATE atômico passa
-- a aceitar também um 'claimed' com mais de 2 minutos (auto_print_claimed_at), tratado
-- como abandonado. Continua sendo uma única instrução UPDATE...WHERE...RETURNING —
-- a atomicidade não muda: duas abas disputando o mesmo claim expirado continuam
-- resultando em só uma ganhando, porque o lock de linha do Postgres serializa as duas
-- tentativas de UPDATE na mesma linha (a segunda só reavalia o WHERE depois que a
-- primeira já commitou um auto_print_claimed_at novo, que já não é mais "abandonado").
--
-- Resto da função (is_staff, validação de p_claimed_by, leitura de business_settings,
-- guarda de auto_print_enabled/auto_print_enabled_at, formato de retorno) idêntico à
-- definição vigente em 20260920110000_add_auto_print_infrastructure.sql (não editada).
--
-- resolve_order_auto_print não muda: se o dispositivo B reclamar um claim abandonado
-- do dispositivo A, auto_print_claimed_by passa a ser B; se A tentar resolver depois
-- (reconectando tarde), a checagem "auto_print_claimed_by = p_claimed_by" falha pra A
-- e ele recebe {resolved:false} — já tratado sem lançar pelo chamador
-- (_resolverImpressaoAutomaticaSemLancar só loga e segue, js/pedidos.js).
--
-- Risco aceito conscientemente: se a Epson já tiver impresso fisicamente antes da
-- queda, e o resolve nunca chegou ao banco, o reclaim após 2 minutos gera uma segunda
-- impressão física. Não há confirmação transacional da própria impressora disponível
-- neste hardware/protocolo — a arquitetura prefere esse risco ocasional a deixar
-- pedidos presos para sempre. Documentado também no relatório de auditoria.
--
-- NÃO altera: create_customer_order, confirm_order_payment, resolve_order_auto_print,
-- register_order_print, RLS, policies, Storage, Epson, delivery.

CREATE OR REPLACE FUNCTION public.claim_order_auto_print(p_order_id uuid, p_claimed_by text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_settings record;
  v_order public.orders;
begin
  if not public.is_staff() then
    raise exception 'Usuário sem permissão';
  end if;

  if coalesce(trim(p_claimed_by), '') = '' then
    raise exception 'Identificador do dispositivo é obrigatório';
  end if;

  select auto_print_enabled, auto_print_enabled_at
  into v_settings
  from public.business_settings
  where id = 1;

  -- Impressão automática desativada (ou nunca ativada) -> nunca concede claim,
  -- não importa o que o chamador pense que está configurado.
  if not found or v_settings.auto_print_enabled is not true or v_settings.auto_print_enabled_at is null then
    return jsonb_build_object('claimed', false);
  end if;

  update public.orders
  set auto_print_status = 'claimed',
      auto_print_claimed_at = now(),
      auto_print_claimed_by = p_claimed_by
  where id = p_order_id
    and (
      auto_print_status is null
      or (auto_print_status = 'claimed' and auto_print_claimed_at < now() - interval '2 minutes')
    )
    and printed_at is null
    and status <> 'cancelled'
    and created_at >= v_settings.auto_print_enabled_at
  returning * into v_order;

  if v_order.id is null then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object('claimed', true, 'order', to_jsonb(v_order));
end;
$function$;
