-- Correção pontual do W6.7A (achado IMPORTANTE): record_whatsapp_inbound_message
-- nunca devolvia language, forçando o Worker a usar um fallback 'pt'
-- hardcoded mesmo quando a sessão real era 'en'. Migration nova (não
-- edita 20260824160000, já aplicada remotamente) — CREATE OR REPLACE
-- aditivo, só 2 mudanças cirúrgicas: variável v_language declarada, e
-- language incluído no SELECT final e no jsonb_build_object de
-- retorno. Nenhuma outra regra tocada: dedup por provider_message_id,
-- resolve-or-create de sessão, INSERT de mensagem, bump de
-- last_message_at/updated_at, SECURITY DEFINER, search_path vazio,
-- qualificação public.*, os 3 REVOKE — tudo preservado byte a byte.
--
-- A coluna whatsapp_sessions.language já existe desde 20260824120000
-- (W2.2) — nenhuma coluna nova, nenhuma migration de schema.

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
  v_language      text;
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

  select s.state, s.human_handoff, s.language
    into v_state, v_human_handoff, v_language
    from public.whatsapp_sessions s
   where s.id = v_session_id;

  return jsonb_build_object(
    'duplicate', v_duplicate,
    'session_id', v_session_id,
    'message_id', v_message_id,
    'state', v_state,
    'language', v_language,
    'human_handoff', v_human_handoff
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_whatsapp_inbound_message(text, text, text, text, jsonb) FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
