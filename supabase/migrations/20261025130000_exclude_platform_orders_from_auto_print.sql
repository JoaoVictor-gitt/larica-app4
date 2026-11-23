-- =====================================================================================
-- D7 — pedidos Deliveroo/Just Eat NUNCA entram na impressão automática (só impressão manual).
--
-- Requer a fase A (20261025120000_add_orders_sales_channel.sql) aplicada.
--
-- Única mudança funcional: o UPDATE atômico de public.claim_order_auto_print passa a exigir
-- sales_channel = 'larica'. Para pedido Larica o resultado é idêntico ao de hoje (a condição é
-- sempre verdadeira); para pedido de plataforma o claim nunca é concedido ({"claimed": false},
-- o resultado normal que o painel já trata como "outro dispositivo/regra do banco"). É a barreira
-- do SERVIDOR: vale também para um iPad/navegador que ainda esteja com o JavaScript antigo em
-- cache. O painel (js/pedidos.js) já deixa de candidatar esses pedidos antes de chegar aqui.
--
-- O corpo novo é cópia EXATA do corpo vigente versionado em
-- 20260923090000_allow_reclaim_abandoned_auto_print.sql + 2 linhas (o comentário e a condição).
-- Assinatura, SECURITY DEFINER, search_path, formato de retorno, regra dos 2 minutos, validação
-- de auto_print_enabled/auto_print_enabled_at: inalterados. CREATE OR REPLACE preserva dono e ACL.
--
-- Guarda: só substitui se o corpo VIVO for idêntico ao versionado (md5 do corpo com CRLF -> LF =
-- 146d816f31fc05511ba993aae1cb5382, calculado do arquivo do repositório). Se diferir (alguém alterou
-- a função pelo SQL Editor), nada é feito: envie o X02 de 20261025_pedidos_plataforma_extracao.sql.
--
-- NÃO altera: resolve_order_auto_print, register_order_print, impressão manual, RLS, policies.
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). SQL Editor:
--   supabase/sql-editor/20261025130000_exclude_platform_orders_from_auto_print.sql
-- Rollback (manual): supabase/rollback/20261025130000_exclude_platform_orders_from_auto_print_down.sql
-- Arquivo sem nenhuma barra invertida.
-- =====================================================================================

SET LOCAL lock_timeout = '5s';

DO $guard$
declare
  v_falhas text := '';
  v_funcao oid := to_regprocedure('public.claim_order_auto_print(uuid,text)');
begin
  if not exists (select 1 from pg_attribute where attrelid = 'public.orders'::regclass
                 and attname = 'sales_channel' and not attisdropped) then
    v_falhas := v_falhas || ' [orders.sales_channel não existe: aplique a fase A antes]';
  end if;

  if v_funcao is null then
    v_falhas := v_falhas || ' [claim_order_auto_print(uuid,text) não existe]';
  elsif (select md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) from pg_proc p where p.oid = v_funcao)
        <> '146d816f31fc05511ba993aae1cb5382' then
    v_falhas := v_falhas || ' [claim_order_auto_print vivo difere da versão versionada em 20260923090000]';
  elsif not (select p.prosecdef from pg_proc p where p.oid = v_funcao) then
    v_falhas := v_falhas || ' [claim_order_auto_print não é SECURITY DEFINER]';
  end if;

  if v_falhas <> '' then
    raise exception 'Migration interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;

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
    -- D7: pedidos Deliveroo/Just Eat são só de impressão manual.
    and sales_channel = 'larica'
    and created_at >= v_settings.auto_print_enabled_at
  returning * into v_order;

  if v_order.id is null then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object('claimed', true, 'order', to_jsonb(v_order));
end;
$function$;

DO $verificacao$
declare
  v_falhas text := '';
  r record;
begin
  select p.oid, p.prosecdef, p.provolatile, p.proconfig,
         md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) as md5_lf
    into r
  from pg_proc p
  where p.oid = to_regprocedure('public.claim_order_auto_print(uuid,text)');

  if r.oid is null then
    raise exception 'Migration desfeita (verificação final): função não existe';
  end if;
  if r.md5_lf <> '607e4f4ec441c2d47849a75b940c4e2e' then
    v_falhas := v_falhas || format(' [corpo instalado inesperado: %s]', r.md5_lf);
  end if;
  if not r.prosecdef then
    v_falhas := v_falhas || ' [não é SECURITY DEFINER]';
  end if;
  if r.provolatile::text <> 'v' then
    v_falhas := v_falhas || format(' [volatilidade %s]', r.provolatile::text);
  end if;
  if r.proconfig is distinct from array['search_path=""'] then
    v_falhas := v_falhas || format(' [search_path %s]', r.proconfig);
  end if;

  if v_falhas <> '' then
    raise exception 'Migration desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
