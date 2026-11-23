-- =====================================================================================
-- Cadastro de clientes — M3: vinculação MÚLTIPLA de pedidos a um cliente (uma operação).
-- Requer M2 (20261013100100_add_manual_customer_rpcs) aplicada.
--
-- Cria SOMENTE a função nova public.admin_link_orders_to_customer(p_customer_id,
-- p_items, p_reason). Nenhuma tabela, coluna, trigger, dado ou função existente é criado,
-- alterado ou substituído.
--
-- Reutilização: para CADA pedido a função chama a RPC individual já existente
-- public.admin_link_order_to_customer — mesmas regras, travas, avisos, confirmações e
-- auditoria ('link' com pedido, número, cliente, admin, data e motivo). Nenhuma regra de
-- vinculação é reimplementada aqui. A guarda confere que a função individual instalada é
-- exatamente a da M2 (md5 do corpo normalizado).
--
-- Tudo ou nada: tudo roda na transação da chamada. Cada pedido é processado num bloco
-- com EXCEPTION (subtransação) só para COLETAR as falhas; se QUALQUER pedido falhar, a
-- função levanta um erro único (HINT 'larica:batch_failed', DETAIL JSON com a lista de
-- falhas: pedido, número, código, mensagem) e TODA a transação é desfeita — inclusive os
-- pedidos que tinham dado certo. Nunca há vinculação parcial.
-- Só entram na lista de falhas os erros que pertencem a um pedido (lista PERMITIDA de HINT:
-- confirmation_required, reactivation_required, linked_to_other, order_not_found, conflict).
-- Qualquer outro erro (sem permissão, cadastro ocupado, cliente arquivado/inexistente,
-- entrada inválida, deadlock, erro interno ou do banco) interrompe a operação na hora, com
-- o erro original intacto (RAISE), e a transação inteira é desfeita.
--
-- p_items: array JSON (1 a 50 itens, sem pedido repetido), cada item:
--   { "order_id": "<uuid>",
--     "acknowledged_warnings": ["name_mismatch" | "phone_mismatch" | "order_cancelled"]
--                              (opcional; só texto, só esses 3 códigos, no máximo 3 itens),
--     "confirm_reactivation": true | false }
-- Toda a entrada é validada ANTES de qualquer trava ou escrita.
-- p_reason: motivo opcional, gravado na auditoria de cada pedido.
-- Retorno: { success, total, linked, reactivated, already_linked, results: [{order_id,
-- order_number, result: linked|reactivated|already_linked}] }.
-- "already_linked" = pedido já vinculado a ESTE cliente: nada é gravado (sem duplicar).
--
-- Concorrência: advisory lock 'larica.customer_registry' ANTES de tudo (mesma ordem da
-- função individual e da sincronização); pedidos processados em ordem crescente de
-- order_id (ordem de locks determinística). lock_timeout de 5s (definido pela função
-- individual) -> 'larica:busy', nada gravado.
--
-- Permissões: SECURITY DEFINER, is_admin() na 1ª instrução, search_path ''. EXECUTE só
-- para authenticated (PUBLIC, anon e service_role revogados, inclusive os concedidos
-- pelos privilégios padrão do Supabase). Verificação final confere SECURITY DEFINER,
-- volatilidade, search_path, ACL e privilégios efetivos; se divergir, tudo é desfeito.
-- O bloqueio de quem não é admin é comprovado por comportamento DEPOIS da instalação
-- (M3-POS-2, transação somente leitura + ROLLBACK), sem troca de papel nesta migration.
--
-- Transação: SEM BEGIN/COMMIT (a CLI já usa transação). SQL Editor:
--   supabase/sql-editor/20261014100000_add_link_orders_batch_rpc.sql
-- Rollback (manual, não destrutivo por padrão): supabase/rollback/20261014100000_link_orders_batch_down.sql
-- Arquivo sem nenhuma barra invertida.
-- =====================================================================================

SET LOCAL lock_timeout = '5s';


-- =====================================================================================
-- 0) Guardas
-- =====================================================================================

DO $guard$
declare
  v_falhas text := '';
  v_texto text;
  v_individual oid := to_regprocedure('public.admin_link_order_to_customer(uuid,uuid,boolean,text[],text)');
begin
  -- (a) nome livre
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_texto
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'admin_link_orders_to_customer';
  if v_texto is not null then
    v_falhas := v_falhas || format(' [já existe: %s]', v_texto);
  end if;

  -- (b) função individual da M2 presente e idêntica (md5 do corpo normalizado CRLF -> LF).
  --     ddecbd95582376d161564a0a988d161e = corpo de admin_link_order_to_customer em
  --     20261013100100_add_manual_customer_rpcs.sql (texto entre os delimitadores do
  --     corpo), confirmado em produção em 2026-10-14 (comparação: normalizado, bruto
  --     com CRLF e sem espaços idênticos; 6368 caracteres, 141 linhas).
  if v_individual is null then
    v_falhas := v_falhas || ' [admin_link_order_to_customer não existe: aplique a M2 antes]';
  elsif (select md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) from pg_proc p where p.oid = v_individual)
        <> 'ddecbd95582376d161564a0a988d161e' then
    v_falhas := v_falhas || ' [admin_link_order_to_customer difere da versão da M2]';
  elsif not (select p.prosecdef from pg_proc p where p.oid = v_individual) then
    v_falhas := v_falhas || ' [admin_link_order_to_customer não é SECURITY DEFINER]';
  end if;

  -- (c) papéis usados nos REVOKE/GRANT e na verificação final
  select string_agg(x.papel, ', ')
    into v_texto
  from unnest(array['anon', 'authenticated', 'service_role']) as x(papel)
  where not exists (select 1 from pg_roles r where r.rolname = x.papel);
  if v_texto is not null then
    v_falhas := v_falhas || format(' [papéis inexistentes: %s]', v_texto);
  end if;

  -- (d) o papel que aplica (= dono da função nova) pode executar a individual e is_admin()
  if v_individual is not null and not has_function_privilege(current_user, v_individual, 'EXECUTE') then
    v_falhas := v_falhas || format(' [o papel %s não executa admin_link_order_to_customer]', current_user);
  end if;
  if not has_function_privilege(current_user, 'public.is_admin()', 'EXECUTE') then
    v_falhas := v_falhas || ' [sem EXECUTE em is_admin()]';
  end if;

  if v_falhas <> '' then
    raise exception 'M3 interrompida, nada foi alterado:%', v_falhas;
  end if;
end;
$guard$;


-- =====================================================================================
-- 1) Função
-- =====================================================================================

CREATE FUNCTION public.admin_link_orders_to_customer(
  p_customer_id uuid,
  p_items jsonb,
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c_maximo constant integer := 50;
  v_item jsonb;
  v_order_id uuid;
  v_ids uuid[] := '{}';
  v_ack text[];
  v_reativar boolean;
  v_resposta jsonb;
  v_resultado text;
  v_resultados jsonb := '[]'::jsonb;
  v_falhas jsonb := '[]'::jsonb;
  v_vinculados integer := 0;
  v_reativados integer := 0;
  v_ja_vinculados integer := 0;
  v_msg text;
  v_hint text;
  v_detalhe text;
  v_numero bigint;
begin
  if not public.is_admin() then
    raise exception using message = 'Acesso negado', hint = 'larica:forbidden';
  end if;

  -- Validação da entrada (nada é travado nem gravado até aqui)
  if p_customer_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using message = 'Selecione ao menos um pedido.', hint = 'larica:invalid';
  end if;
  if jsonb_array_length(p_items) > c_maximo then
    raise exception using message = format('Selecione no máximo %s pedidos por operação.', c_maximo), hint = 'larica:invalid',
                          detail = jsonb_build_object('items', 'too_many', 'max', c_maximo)::text;
  end if;

  for v_item in select x.value from jsonb_array_elements(p_items) as x(value) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'order_id') is distinct from 'string' then
      raise exception using message = 'Pedido inválido na seleção.', hint = 'larica:invalid';
    end if;
    begin
      v_order_id := (v_item ->> 'order_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception using message = 'Pedido inválido na seleção.', hint = 'larica:invalid';
    end;
    if v_order_id = any (v_ids) then
      raise exception using message = 'O mesmo pedido aparece mais de uma vez na seleção.', hint = 'larica:invalid',
                            detail = jsonb_build_object('order_id', v_order_id)::text;
    end if;
    if (v_item ? 'acknowledged_warnings') and jsonb_typeof(v_item -> 'acknowledged_warnings') <> 'array' then
      raise exception using message = 'Confirmações inválidas na seleção.', hint = 'larica:invalid';
    end if;
    -- Só texto, só os 3 códigos de aviso da vinculação individual (M2) e no máximo 3 itens
    if (v_item ? 'acknowledged_warnings')
       and (jsonb_array_length(v_item -> 'acknowledged_warnings') > 3
            or exists (select 1
                       from jsonb_array_elements(v_item -> 'acknowledged_warnings') as w(valor)
                       where jsonb_typeof(w.valor) <> 'string'
                          or (w.valor #>> '{}') not in ('name_mismatch', 'phone_mismatch', 'order_cancelled'))) then
      raise exception using message = 'Confirmações inválidas na seleção.', hint = 'larica:invalid',
                            detail = jsonb_build_object('order_id', v_order_id)::text;
    end if;
    if (v_item ? 'confirm_reactivation') and jsonb_typeof(v_item -> 'confirm_reactivation') <> 'boolean' then
      raise exception using message = 'Confirmação de reativação inválida na seleção.', hint = 'larica:invalid';
    end if;
    v_ids := array_append(v_ids, v_order_id);
  end loop;

  -- Mesma trava da função individual e da sincronização, ANTES de qualquer pedido
  perform set_config('lock_timeout', '5s', true);
  begin
    perform pg_advisory_xact_lock(hashtext('larica.customer_registry'));
  exception
    when lock_not_available then
      raise exception using message = 'O cadastro de clientes está ocupado (sincronização ou outra operação). Nenhum pedido foi vinculado; tente novamente em alguns segundos.',
                            hint = 'larica:busy';
  end;

  -- Cada pedido pela RPC individual (mesmas regras e auditoria), em ordem estável
  for v_item in
    select x.value from jsonb_array_elements(p_items) as x(value)
    order by (x.value ->> 'order_id')::uuid
  loop
    v_order_id := (v_item ->> 'order_id')::uuid;
    select coalesce(array_agg(t.w), '{}')
      into v_ack
    from jsonb_array_elements_text(coalesce(v_item -> 'acknowledged_warnings', '[]'::jsonb)) as t(w);
    v_reativar := coalesce((v_item ->> 'confirm_reactivation')::boolean, false);

    begin
      v_resposta := public.admin_link_order_to_customer(p_customer_id, v_order_id, v_reativar, v_ack, p_reason);

      if coalesce((v_resposta ->> 'already_linked')::boolean, false) then
        v_ja_vinculados := v_ja_vinculados + 1;
        v_resultado := 'already_linked';
      elsif coalesce((v_resposta ->> 'reactivated')::boolean, false) then
        v_reativados := v_reativados + 1;
        v_resultado := 'reactivated';
      else
        v_vinculados := v_vinculados + 1;
        v_resultado := 'linked';
      end if;

      v_resultados := v_resultados || jsonb_build_array(jsonb_build_object(
        'order_id', v_order_id, 'order_number', v_resposta -> 'order_number', 'result', v_resultado));
    exception
      when others then
        get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint, v_detalhe = pg_exception_detail;
        -- Lista PERMITIDA: só estes erros são "deste pedido" e entram na lista de falhas.
        -- Qualquer outro (sem permissão, cadastro ocupado, cliente arquivado/inexistente,
        -- entrada inválida, deadlock, erro interno ou do banco) interrompe a operação inteira
        -- AGORA com o erro original intacto (RAISE sem parâmetros preserva SQLSTATE, mensagem,
        -- DETAIL e HINT); a transação toda é desfeita.
        if v_hint is null or v_hint not in ('larica:confirmation_required', 'larica:reactivation_required',
                                            'larica:linked_to_other', 'larica:order_not_found', 'larica:conflict') then
          raise;
        end if;
        select o.order_number::bigint into v_numero from public.orders o where o.id = v_order_id;
        v_falhas := v_falhas || jsonb_build_array(jsonb_build_object(
          'order_id', v_order_id,
          'order_number', v_numero,
          'code', coalesce(nullif(replace(coalesce(v_hint, ''), 'larica:', ''), ''), 'error'),
          'message', v_msg,
          'detail', nullif(v_detalhe, '')));
        v_numero := null;
    end;
  end loop;

  -- Qualquer falha: nada fica gravado (o erro desfaz também os pedidos que deram certo)
  if jsonb_array_length(v_falhas) > 0 then
    raise exception using
      message = format('Nenhum pedido foi vinculado: %s de %s pedido(s) não puderam ser vinculados. Revise a lista e tente novamente.',
                       jsonb_array_length(v_falhas), jsonb_array_length(p_items)),
      hint = 'larica:batch_failed',
      detail = jsonb_build_object('failures', v_falhas)::text;
  end if;

  return jsonb_build_object('success', true,
                            'total', jsonb_array_length(p_items),
                            'linked', v_vinculados,
                            'reactivated', v_reativados,
                            'already_linked', v_ja_vinculados,
                            'results', v_resultados);
end;
$function$;


-- =====================================================================================
-- 2) Privilégios + verificação final
-- =====================================================================================
-- Remove inclusive o EXECUTE que os privilégios padrão do Supabase concedem a anon e
-- service_role (PRE-9) e o EXECUTE padrão de PUBLIC.

REVOKE ALL ON FUNCTION public.admin_link_orders_to_customer(uuid, jsonb, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_link_orders_to_customer(uuid, jsonb, text) TO authenticated;

DO $verificacao$
declare
  v_falhas text := '';
  v_authenticated oid := (select oid from pg_roles where rolname = 'authenticated');
  r record;
begin
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner, p.prosrc
    into r
  from pg_proc p
  where p.oid = to_regprocedure('public.admin_link_orders_to_customer(uuid,jsonb,text)');

  if r.oid is null then
    raise exception 'M3 desfeita (verificação final): função não foi criada';
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

  -- ACL declarada: EXECUTE só para o dono e authenticated
  if r.proacl is null then
    v_falhas := v_falhas || ' [ACL padrão (PUBLIC executa)]';
  elsif exists (select 1 from aclexplode(r.proacl) x
                where x.privilege_type = 'EXECUTE' and x.grantee <> r.proowner
                  and x.grantee is distinct from v_authenticated) then
    v_falhas := v_falhas || ' [EXECUTE concedido a papel não previsto]';
  end if;

  -- Privilégio efetivo (com herança)
  if has_function_privilege('anon', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [executável por anon]';
  end if;
  if has_function_privilege('service_role', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [executável por service_role]';
  end if;
  if not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
    v_falhas := v_falhas || ' [sem EXECUTE para authenticated]';
  end if;

  -- O bloqueio de não-admin (is_admin()) é comprovado por comportamento DEPOIS da
  -- instalação, em supabase/testes-manuais/20261014_link_orders_batch_pos_leitura.sql
  -- (M3-POS-2), sem troca de papel dentro desta migration.

  if v_falhas <> '' then
    raise exception 'M3 desfeita (verificação final):%', v_falhas;
  end if;
end;
$verificacao$;
