-- Infraestrutura para impressão automática de novos pedidos na Epson
-- TM-m30III (caminho direto HTTPS já validado em etapas anteriores:
-- gerarComandaEposPrintXml -> EpsonPrinterService.imprimir()). Migration
-- puramente aditiva — nenhuma coluna/RPC existente é alterada.
--
-- 1) orders ganha 3 colunas novas de "claim" (reivindicação de impressão
--    automática), independentes de printed_at/print_count/last_printed_at
--    (que continuam existindo só para o registro humano via
--    register_order_print, NUNCA tocado por esta migration):
--      auto_print_status      text — NULL | 'claimed' | 'succeeded' | 'failed' | 'ambiguous'
--      auto_print_claimed_at  timestamptz — quando o claim foi tomado (diagnóstico
--                             + permite a UI tratar um claim 'claimed' muito antigo
--                             como equivalente a ambíguo, sem inventar outro estado)
--      auto_print_claimed_by  text — device id persistente (localStorage) de quem reivindicou
--
-- 2) business_settings ganha o toggle + o carimbo de ativação:
--      auto_print_enabled     boolean not null default false
--      auto_print_enabled_at  timestamptz — atualizado pra now() toda vez que o
--                             toggle liga (inclusive religar depois de desligar);
--                             nunca alterado ao desligar
--
-- 3) claim_order_auto_print(p_order_id, p_claimed_by): UPDATE...WHERE...RETURNING
--    atômico — só concede o claim se TODAS as condições valerem NO MOMENTO do
--    UPDATE (auto_print_enabled=true, order.created_at >= auto_print_enabled_at,
--    auto_print_status IS NULL, printed_at IS NULL, status <> 'cancelled').
--    Concorrência entre dois dispositivos: a 2ª transação que tentar atualizar a
--    mesma linha espera a 1ª commitar e então reavalia o WHERE contra o valor já
--    commitado — encontra 0 linhas e retorna {"claimed": false} (não é erro, é o
--    resultado NORMAL de "alguém chegou primeiro"). Validação de
--    auto_print_enabled/created_at é feita AQUI, no servidor — nunca confia em
--    nenhuma checagem equivalente feita no JavaScript.
--
-- 4) resolve_order_auto_print(p_order_id, p_claimed_by, p_status): só resolve um
--    claim que o MESMO device id ainda detém e que ainda está 'claimed' — grava
--    o resultado terminal ('succeeded'/'failed'/'ambiguous'). Nunca reabre nem
--    reenvia; um claim resolvido (ou até um 'claimed' nunca resolvido) nunca é
--    reconsiderado automaticamente por nenhum dispositivo.
--
-- NÃO altera: register_order_print, create_customer_order, whatsapp_sessions,
-- nenhuma RPC do WhatsApp. Nenhum backfill necessário — pedidos existentes ficam
-- com auto_print_status NULL, que já é a condição neutra (nunca reivindicado).

alter table public.orders
  add column if not exists auto_print_status text,
  add column if not exists auto_print_claimed_at timestamptz,
  add column if not exists auto_print_claimed_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_auto_print_status_check'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_auto_print_status_check
      CHECK (auto_print_status IS NULL OR auto_print_status IN ('claimed', 'succeeded', 'failed', 'ambiguous'));
  END IF;
END $$;

alter table public.business_settings
  add column if not exists auto_print_enabled boolean not null default false,
  add column if not exists auto_print_enabled_at timestamptz;

create or replace function public.claim_order_auto_print(p_order_id uuid, p_claimed_by text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
    and auto_print_status is null
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

create or replace function public.resolve_order_auto_print(p_order_id uuid, p_claimed_by text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_order public.orders;
begin
  if not public.is_staff() then
    raise exception 'Usuário sem permissão';
  end if;

  if p_status not in ('succeeded', 'failed', 'ambiguous') then
    raise exception 'Status de resolução inválido: %', p_status;
  end if;

  update public.orders
  set auto_print_status = p_status
  where id = p_order_id
    and auto_print_claimed_by = p_claimed_by
    and auto_print_status = 'claimed'
  returning * into v_order;

  if v_order.id is null then
    return jsonb_build_object('resolved', false);
  end if;

  return jsonb_build_object('resolved', true, 'order', to_jsonb(v_order));
end;
$function$;
