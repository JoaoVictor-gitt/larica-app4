-- L2.5F — RPC atômica de entrada do WhatsApp
-- (record_whatsapp_inbound_message), projetada em W3.4A (veredito GO).
--
-- Porta única de persistência de uma mensagem inbound recebida pelo
-- futuro webhook (W3.2B já implementou só o handshake GET; o POST real
-- ainda não chama esta RPC — isso é escopo de uma etapa futura). Combina,
-- numa única transação: (1) dedup por provider_message_id, (2) acha/cria
-- a sessão aberta do telefone, (3) grava a mensagem, (4) bump de
-- last_message_at/updated_at só quando a mensagem é de fato nova.
--
-- NÃO altera whatsapp_sessions, whatsapp_messages (colunas/CHECKs/
-- índices/RLS/grants de tabela — tudo já existe desde 20260824120000/
-- 130000/140000/150000, intocado aqui), orders, delivery_quotes,
-- create_customer_order, worker/index.ts, wrangler.jsonc, frontend. NÃO
-- cria pedido, não altera cart, não calcula entrega, não valida cupom,
-- não integra Meta/OpenAI — só grava a mensagem e devolve estado básico
-- da sessão pro chamador decidir o próximo passo numa etapa futura.
--
-- SECURITY DEFINER + search_path vazio: mesmo padrão de 100% das RPCs de
-- escrita já existentes no projeto (is_staff/is_admin,
-- create_customer_order, create_lot_from_purchase_line) — toda referência
-- a tabela abaixo é qualificada com public.*.
--
-- service_role (único chamador pretendido, quando o webhook POST for
-- implementado) NÃO recebe GRANT EXECUTE explícito aqui: confirmado por
-- grep no projeto inteiro que nenhuma migration jamais precisou disso
-- (zero ocorrência de "GRANT ... TO service_role"), e
-- 20260818340000_revoke_direct_ingredient_writes.sql:24 documenta
-- explicitamente que "postgres/service_role mantêm privilégios
-- administrativos — REVOKE nunca atinge o dono/superuser". Adicionar um
-- GRANT aqui seria especulativo e sem precedente.

CREATE OR REPLACE FUNCTION public.record_whatsapp_inbound_message(
  p_phone               text,
  p_provider_message_id text,
  p_message_type        text,
  p_body                text DEFAULT NULL,
  p_raw_payload         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_session_id    uuid;
  v_message_id    uuid;
  v_state         text;
  v_human_handoff boolean;
  v_duplicate     boolean := false;
begin
  if coalesce(trim(p_phone), '') = '' then
    raise exception 'phone é obrigatório';
  end if;

  if coalesce(trim(p_provider_message_id), '') = '' then
    raise exception 'provider_message_id é obrigatório';
  end if;

  if coalesce(trim(p_message_type), '') = '' then
    raise exception 'message_type é obrigatório';
  end if;

  -- Fast path: mensagem já registrada? Se sim, não toca em
  -- whatsapp_sessions (nem leitura de resolve-or-create, nem INSERT, nem
  -- UPDATE de timestamps) — só recupera message_id/session_id.
  select m.id, m.session_id
    into v_message_id, v_session_id
    from public.whatsapp_messages m
   where m.provider_message_id = p_provider_message_id;

  if found then
    v_duplicate := true;
  else
    -- Resolve ou cria a sessão aberta pro telefone. Índice único parcial
    -- idx_whatsapp_sessions_phone_open (WHERE state <> 'closed') garante
    -- no máximo uma sessão aberta por telefone — não recriado aqui.
    select s.id
      into v_session_id
      from public.whatsapp_sessions s
     where s.phone = p_phone
       and s.state <> 'closed';

    if v_session_id is null then
      insert into public.whatsapp_sessions (phone)
      values (p_phone)
      on conflict (phone) where state <> 'closed' do nothing
      returning id into v_session_id;

      if v_session_id is null then
        -- Perdeu a corrida de criação: outra transação inseriu entre o
        -- SELECT acima e este INSERT — re-seleciona quem venceu. Sem
        -- advisory lock: o próprio índice único serializa isso.
        select s.id
          into v_session_id
          from public.whatsapp_sessions s
         where s.phone = p_phone
           and s.state <> 'closed';
      end if;
    end if;

    -- Guard atômico REAL de idempotência de mensagem — o WHERE aqui
    -- precisa repetir exatamente o predicado do índice parcial
    -- idx_whatsapp_messages_provider_message_id, senão o Postgres não
    -- infere a constraint.
    insert into public.whatsapp_messages (
      session_id, phone, direction, provider_message_id,
      message_type, body, raw_payload
    ) values (
      v_session_id, p_phone, 'inbound', p_provider_message_id,
      p_message_type, p_body, p_raw_payload
    )
    on conflict (provider_message_id) where provider_message_id is not null
    do nothing
    returning id into v_message_id;

    if v_message_id is null then
      -- Corrida real: outra transação inseriu a mesma
      -- provider_message_id entre o fast path e este INSERT. Duplicata
      -- "tardia" — não é erro, e não roda o UPDATE de timestamps abaixo.
      v_duplicate := true;

      select m.id, m.session_id
        into v_message_id, v_session_id
        from public.whatsapp_messages m
       where m.provider_message_id = p_provider_message_id;
    else
      -- Mensagem de fato nova: único ponto que altera
      -- last_message_at/updated_at. Duplicata nunca chega aqui.
      update public.whatsapp_sessions
         set last_message_at = now(),
             updated_at = now()
       where id = v_session_id;
    end if;
  end if;

  select s.state, s.human_handoff
    into v_state, v_human_handoff
    from public.whatsapp_sessions s
   where s.id = v_session_id;

  return jsonb_build_object(
    'duplicate', v_duplicate,
    'session_id', v_session_id,
    'message_id', v_message_id,
    'state', v_state,
    'human_handoff', v_human_handoff
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — ver justificativa/evidência no
-- cabeçalho desta migration. Nenhuma outra alteração: whatsapp_sessions,
-- whatsapp_messages, orders, delivery_quotes, create_customer_order,
-- worker/index.ts, wrangler.jsonc, frontend permanecem exatamente como
-- estavam.
