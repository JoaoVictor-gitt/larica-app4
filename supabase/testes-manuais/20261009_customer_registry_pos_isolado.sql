-- =====================================================================================
-- TESTES PÓS-MIGRATION — DESTRUTIVOS: SOMENTE EM AMBIENTE ISOLADO
-- (branch/projeto de teste do Supabase ou cópia restaurada do banco). NUNCA EM PRODUÇÃO.
-- Cadastro de clientes: passos 1, 2 e 3 (20261009100000, 20261009100050, 20261009100100).
--
-- Estes testes executam DELETE em orders (testes 4 e 8), DELETE/INSERT em
-- order_customer_links (teste 5), UPDATE/DELETE na auditoria (teste 6), INSERT na
-- auditoria e ALTER TABLE (teste 8). Mesmo terminando em RAISE (que desfaz a transação),
-- eles pegam locks em orders, disparam triggers de orders/order_items (que podem ter
-- efeitos externos não transacionais — ver P5a) e alteram estado durante a execução. Por
-- isso ficam fora de produção.
--
-- Trava de segurança: cada bloco só roda se a sessão tiver
--     set larica.ambiente_teste = 'isolado';
-- Sem ele, o bloco aborta sem executar nada.
--
-- ATENÇÃO: essa trava NÃO COMPROVA que o banco é isolado. É só uma configuração da
-- sessão: qualquer pessoa pode executar o SET por engano conectada à produção, e o bloco
-- rodaria. Ela protege contra execução acidental do arquivo, não contra conexão errada.
-- Antes de executar o SET, faça uma SEGUNDA VALIDAÇÃO, independente desta sessão, de que
-- você está no projeto/ambiente de teste:
--   1. No painel do Supabase, confirme que o projeto aberto (nome e project ref na URL
--      https://supabase.com/dashboard/project/<project-ref>/...) é o de teste/branch, e
--      NÃO o project ref de produção do Larica.
--   2. Rode a consulta V0 abaixo e compare host/banco com os dados de conexão do ambiente
--      de teste (Project Settings -> Database). Se coincidirem com os de produção, PARE.
--   3. Preferencialmente, peça a uma segunda pessoa para confirmar 1 e 2.
-- Só depois disso execute o SET e os testes.

-- V0 — Identificação da conexão atual (somente leitura; comparar com o ambiente de teste)
select current_database() as banco, inet_server_addr() as host, inet_server_port() as porta,
       current_user, current_setting('server_version') as versao,
       (select count(*) from public.orders) as pedidos_neste_banco;
--
-- Os blocos DO terminam com "RESULTADO: ..." como erro (proposital: desfaz tudo). A
-- mensagem precisa começar com "RESULTADO: OK".
--
-- Placeholders:
--   <UUID_ADMIN>   id de um admin ativo (no ambiente isolado)
--   <UUID_PEDIDO>  id de um pedido FINALIZADO e VINCULADO, por exemplo:
--     select l.order_id, l.order_number from public.order_customer_links l where l.state = 'linked' limit 5;
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- TESTE 4 — Exclusão de pedido (caminho do Histórico) gera auditoria order_deleted com
-- autor e snapshot; o vínculo é removido em cascata.
-- -------------------------------------------------------------------------------------
DO $teste4$
declare
  v_pedido uuid := '<UUID_PEDIDO>';
  v_admin uuid := '<UUID_ADMIN>';
  v_numero bigint;
  v_cliente uuid;
  v_apagados integer;
  v_aud record;
begin
  if coalesce(current_setting('larica.ambiente_teste', true), '') <> 'isolado' then
    raise exception 'BLOQUEADO: teste destrutivo — só em ambiente isolado (set larica.ambiente_teste = ''isolado''). Nada foi executado.';
  end if;

  select l.order_number, l.customer_id into v_numero, v_cliente
  from public.order_customer_links l where l.order_id = v_pedido and l.state = 'linked';
  if not found then
    raise exception 'RESULTADO: FALHA — escolha um pedido vinculado (state linked)';
  end if;

  -- Mesmo caminho do Histórico: DELETE em orders como authenticated (sob a RLS de orders)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  delete from public.orders where id = v_pedido;
  get diagnostics v_apagados = row_count;
  execute 'reset role';

  if v_apagados <> 1 then
    raise exception 'RESULTADO: FALHA — DELETE como authenticated não removeu o pedido (RLS de orders?)';
  end if;

  if exists (select 1 from public.order_customer_links where order_id = v_pedido) then
    raise exception 'RESULTADO: FALHA — vínculo não foi removido em cascata';
  end if;

  select * into v_aud from public.customer_link_audit
  where order_id = v_pedido and action = 'order_deleted'
  order by id desc limit 1;
  if not found then
    raise exception 'RESULTADO: FALHA — auditoria order_deleted não foi gravada';
  end if;
  if v_aud.actor is distinct from v_admin or v_aud.order_number is distinct from v_numero
     or v_aud.previous_customer_id is distinct from v_cliente then
    raise exception 'RESULTADO: FALHA — auditoria incompleta: actor=%, order_number=%, previous_customer_id=%',
      v_aud.actor, v_aud.order_number, v_aud.previous_customer_id;
  end if;

  raise exception 'RESULTADO: OK — pedido #% excluído, vínculo removido em cascata, auditoria order_deleted com actor e snapshot (tudo desfeito)', v_numero;
end;
$teste4$;


-- -------------------------------------------------------------------------------------
-- TESTE 5 — Sincronização: idempotente, revincula pendente e respeita 'excluded'.
--
-- Regras de avaliação aplicadas a TODAS as chamadas de sync_phone_customer_links()
-- (5a, 5a', 5b, 5b' e 5c):
--   (R1) skipped = true (sincronização ocupada por outra sessão ou lock_timeout) ->
--        RESULTADO: INCONCLUSIVO (não é falha da função; repetir sem outras sessões).
--   (R2) resposta sem as chaves esperadas (linked/customers_created/remaining) -> FALHA.
--   (R3) "remaining" é conferido contra a contagem DIRETA no banco, com a MESMA definição
--        usada no corpo de _customer_registry_link_by_phone(): pedidos (qualquer status)
--        SEM NENHUMA linha em order_customer_links (logo, 'excluded' não conta), com
--        normalize_customer_name e normalize_customer_phone não nulos. Inclui pedidos
--        pulados pelo SKIP LOCKED. Como a definição é idêntica e a contagem roda logo após
--        a chamada, na mesma transação, divergência só ocorre se outra sessão criar/excluir
--        pedidos ou vínculos entre as duas leituras -> RESULTADO: INCONCLUSIVO (repetir sem
--        atividade; se a divergência persistir num ambiente parado, tratar como falha).
-- -------------------------------------------------------------------------------------
DO $teste5$
declare
  v_pedido uuid := '<UUID_PEDIDO>';
  v_admin uuid := '<UUID_ADMIN>';
  v_numero bigint;
  v_r jsonb;
  v_i integer;
  v_pendentes bigint;
  v_etapa text;
begin
  if coalesce(current_setting('larica.ambiente_teste', true), '') <> 'isolado' then
    raise exception 'BLOQUEADO: teste destrutivo — só em ambiente isolado (set larica.ambiente_teste = ''isolado''). Nada foi executado.';
  end if;

  select order_number into v_numero from public.order_customer_links where order_id = v_pedido and state = 'linked';
  if not found then raise exception 'RESULTADO: FALHA — pedido não está vinculado'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ---------------------------------------------------------------------------------
  -- 5a) Drena TODAS as pendências (determinístico): repete até remaining = 0, com teto
  --     de 50 iterações; não presume que 1 ou 2 chamadas bastem.
  -- ---------------------------------------------------------------------------------
  for v_i in 1..50 loop
    v_etapa := '5a (drenagem, iteração ' || v_i || ')';
    execute 'set local role authenticated';
    v_r := public.sync_phone_customer_links(500);
    execute 'reset role';
    -- R1
    if coalesce((v_r->>'skipped')::boolean, false) then
      raise exception 'RESULTADO: INCONCLUSIVO — % — sincronização ocupada (%). Repita sem outras sessões ativas.', v_etapa, v_r;
    end if;
    -- R2
    if v_r->>'linked' is null or v_r->>'customers_created' is null or v_r->>'remaining' is null then
      raise exception 'RESULTADO: FALHA — % — resposta inesperada: %', v_etapa, v_r;
    end if;
    -- R3
    select count(*) into v_pendentes
    from public.orders o
    where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
      and public.normalize_customer_name(o.customer_name) is not null
      and public.normalize_customer_phone(o.customer_phone) is not null;
    if v_pendentes <> (v_r->>'remaining')::bigint then
      raise exception 'RESULTADO: INCONCLUSIVO — % — remaining=% diverge da contagem direta=% (atividade concorrente?). Retorno: %',
        v_etapa, v_r->>'remaining', v_pendentes, v_r;
    end if;
    exit when v_pendentes = 0;
  end loop;

  if v_pendentes <> 0 then
    raise exception 'RESULTADO: INCONCLUSIVO — ainda há % pendência(s) após 50 sincronizações (pedidos travados por outra sessão?). Último retorno: %',
      v_pendentes, v_r;
  end if;

  -- ---------------------------------------------------------------------------------
  -- 5a') Idempotência com zero pendências: não vincula, não cria cadastro, remaining = 0
  -- ---------------------------------------------------------------------------------
  v_etapa := '5a'' (idempotência sem pendências)';
  execute 'set local role authenticated';
  v_r := public.sync_phone_customer_links(500);
  execute 'reset role';
  if coalesce((v_r->>'skipped')::boolean, false) then
    raise exception 'RESULTADO: INCONCLUSIVO — % — sincronização ocupada (%). Repita sem outras sessões ativas.', v_etapa, v_r;
  end if;
  if v_r->>'linked' is null or v_r->>'customers_created' is null or v_r->>'remaining' is null then
    raise exception 'RESULTADO: FALHA — % — resposta inesperada: %', v_etapa, v_r;
  end if;
  select count(*) into v_pendentes
  from public.orders o
  where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
    and public.normalize_customer_name(o.customer_name) is not null
    and public.normalize_customer_phone(o.customer_phone) is not null;
  if v_pendentes <> (v_r->>'remaining')::bigint then
    raise exception 'RESULTADO: INCONCLUSIVO — % — remaining=% diverge da contagem direta=% (atividade concorrente?). Retorno: %',
      v_etapa, v_r->>'remaining', v_pendentes, v_r;
  end if;
  if (v_r->>'linked')::int <> 0 or (v_r->>'customers_created')::int <> 0 or v_pendentes <> 0 then
    raise exception 'RESULTADO: FALHA — % — sync sem pendências não foi idempotente: %', v_etapa, v_r;
  end if;

  -- ---------------------------------------------------------------------------------
  -- 5b) Vínculo único: com exatamente 1 pendência conhecida (o pedido de teste, cujo
  --     vínculo é removido), a sincronização vincula exatamente 1 e zera as pendências.
  -- ---------------------------------------------------------------------------------
  delete from public.order_customer_links where order_id = v_pedido;   -- (gera auditoria link_deleted)

  v_etapa := '5b (única pendência)';
  execute 'set local role authenticated';
  v_r := public.sync_phone_customer_links(500);
  execute 'reset role';
  if coalesce((v_r->>'skipped')::boolean, false) then
    raise exception 'RESULTADO: INCONCLUSIVO — % — sincronização ocupada (%). Repita sem outras sessões ativas.', v_etapa, v_r;
  end if;
  if v_r->>'linked' is null or v_r->>'customers_created' is null or v_r->>'remaining' is null then
    raise exception 'RESULTADO: FALHA — % — resposta inesperada: %', v_etapa, v_r;
  end if;
  select count(*) into v_pendentes
  from public.orders o
  where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
    and public.normalize_customer_name(o.customer_name) is not null
    and public.normalize_customer_phone(o.customer_phone) is not null;
  if v_pendentes <> (v_r->>'remaining')::bigint then
    raise exception 'RESULTADO: INCONCLUSIVO — % — remaining=% diverge da contagem direta=% (atividade concorrente?). Retorno: %',
      v_etapa, v_r->>'remaining', v_pendentes, v_r;
  end if;
  if (v_r->>'linked')::int <> 1 or v_pendentes <> 0
     or (select count(*) from public.order_customer_links where order_id = v_pedido and state = 'linked') <> 1 then
    raise exception 'RESULTADO: FALHA — % — a única pendência (pedido de teste) não foi vinculada exatamente uma vez: %', v_etapa, v_r;
  end if;

  -- 5b') Idempotência logo após vincular: a próxima chamada não vincula nem cria nada
  v_etapa := '5b'' (idempotência após vincular)';
  execute 'set local role authenticated';
  v_r := public.sync_phone_customer_links(500);
  execute 'reset role';
  if coalesce((v_r->>'skipped')::boolean, false) then
    raise exception 'RESULTADO: INCONCLUSIVO — % — sincronização ocupada (%). Repita sem outras sessões ativas.', v_etapa, v_r;
  end if;
  if v_r->>'linked' is null or v_r->>'customers_created' is null or v_r->>'remaining' is null then
    raise exception 'RESULTADO: FALHA — % — resposta inesperada: %', v_etapa, v_r;
  end if;
  select count(*) into v_pendentes
  from public.orders o
  where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
    and public.normalize_customer_name(o.customer_name) is not null
    and public.normalize_customer_phone(o.customer_phone) is not null;
  if v_pendentes <> (v_r->>'remaining')::bigint then
    raise exception 'RESULTADO: INCONCLUSIVO — % — remaining=% diverge da contagem direta=% (atividade concorrente?). Retorno: %',
      v_etapa, v_r->>'remaining', v_pendentes, v_r;
  end if;
  if (v_r->>'linked')::int <> 0 or (v_r->>'customers_created')::int <> 0 or v_pendentes <> 0 then
    raise exception 'RESULTADO: FALHA — % — sync não é idempotente: %', v_etapa, v_r;
  end if;

  -- ---------------------------------------------------------------------------------
  -- 5c) Respeito ao 'excluded': pedido desvinculado por admin NÃO é revinculado e NÃO
  --     conta como pendência (tem linha em order_customer_links).
  -- ---------------------------------------------------------------------------------
  delete from public.order_customer_links where order_id = v_pedido;
  insert into public.order_customer_links (order_id, order_number, state, customer_id, link_source)
  values (v_pedido, v_numero, 'excluded', null, 'admin');

  v_etapa := '5c (excluded)';
  execute 'set local role authenticated';
  v_r := public.sync_phone_customer_links(500);
  execute 'reset role';
  if coalesce((v_r->>'skipped')::boolean, false) then
    raise exception 'RESULTADO: INCONCLUSIVO — % — sincronização ocupada (%). Repita sem outras sessões ativas.', v_etapa, v_r;
  end if;
  if v_r->>'linked' is null or v_r->>'customers_created' is null or v_r->>'remaining' is null then
    raise exception 'RESULTADO: FALHA — % — resposta inesperada: %', v_etapa, v_r;
  end if;
  select count(*) into v_pendentes
  from public.orders o
  where not exists (select 1 from public.order_customer_links l where l.order_id = o.id)
    and public.normalize_customer_name(o.customer_name) is not null
    and public.normalize_customer_phone(o.customer_phone) is not null;
  if v_pendentes <> (v_r->>'remaining')::bigint then
    raise exception 'RESULTADO: INCONCLUSIVO — % — remaining=% diverge da contagem direta=% (atividade concorrente?). Retorno: %',
      v_etapa, v_r->>'remaining', v_pendentes, v_r;
  end if;
  if (v_r->>'linked')::int <> 0 or v_pendentes <> 0
     or not exists (select 1 from public.order_customer_links where order_id = v_pedido and state = 'excluded' and customer_id is null) then
    raise exception 'RESULTADO: FALHA — % — sync revinculou ou contou como pendente um pedido excluded: %', v_etapa, v_r;
  end if;

  raise exception 'RESULTADO: OK — drenagem determinística, remaining = contagem direta em todas as chamadas, idempotente, vínculo único e excluded respeitado (tudo desfeito)';
end;
$teste5$;

-- 5d) Concorrência (manual, duas sessões NO AMBIENTE ISOLADO):
--     Sessão A: select pg_advisory_xact_lock(hashtext('larica.customer_registry')), pg_sleep(20);
--     Sessão B (em até 20s), como admin: abrir a página Clientes do ambiente isolado e clicar
--     "Atualizar" — deve indicar sincronização ocupada (skipped/busy) e carregar normalmente.
--     Reconciliação concorrente: duas sessões chamando
--     public._customer_registry_reconcile_deleted_orders(500) ao mesmo tempo — a segunda
--     espera a primeira (advisory lock próprio) e não grava nada duplicado (índice único).


-- -------------------------------------------------------------------------------------
-- TESTE 6 — Auditoria somente inclusão: UPDATE e DELETE recusados.
-- -------------------------------------------------------------------------------------
DO $teste6$
declare
  v_id bigint;
  v_msgs text := '';
begin
  if coalesce(current_setting('larica.ambiente_teste', true), '') <> 'isolado' then
    raise exception 'BLOQUEADO: teste destrutivo — só em ambiente isolado (set larica.ambiente_teste = ''isolado''). Nada foi executado.';
  end if;

  select id into v_id from public.customer_link_audit order by id limit 1;
  if v_id is null then raise exception 'RESULTADO: FALHA — auditoria vazia (backfill não gravou?)'; end if;

  begin
    update public.customer_link_audit set reason = 'teste' where id = v_id;
    v_msgs := v_msgs || ' [FALHA UPDATE permitido]';
  exception when raise_exception then null;
  end;
  begin
    delete from public.customer_link_audit where id = v_id;
    v_msgs := v_msgs || ' [FALHA DELETE permitido]';
  exception when raise_exception then null;
  end;

  if v_msgs = '' then
    raise exception 'RESULTADO: OK — UPDATE e DELETE na auditoria bloqueados';
  else
    raise exception 'RESULTADO: FALHA —%', v_msgs;
  end if;
end;
$teste6$;


-- -------------------------------------------------------------------------------------
-- TESTE 8 — Falha na auditoria NÃO impede a exclusão do pedido; a reconciliação grava o
-- registro faltante, é idempotente, e o índice único recusa duplicidade.
-- Simula a falha com uma CHECK temporária (criada e removida no bloco; o RAISE final
-- desfaz tudo). Durante o bloco, customer_link_audit fica com lock exclusivo.
-- -------------------------------------------------------------------------------------
DO $teste8$
declare
  v_pedido uuid := '<UUID_PEDIDO>';
  v_admin uuid := '<UUID_ADMIN>';
  v_apagados integer;
  v_reconciliados integer;
begin
  if coalesce(current_setting('larica.ambiente_teste', true), '') <> 'isolado' then
    raise exception 'BLOQUEADO: teste destrutivo — só em ambiente isolado (set larica.ambiente_teste = ''isolado''). Nada foi executado.';
  end if;

  if not exists (select 1 from public.order_customer_links where order_id = v_pedido and state = 'linked') then
    raise exception 'RESULTADO: FALHA — escolha um pedido vinculado (state linked)';
  end if;

  alter table public.customer_link_audit
    add constraint teste8_falha_simulada check (action <> 'order_deleted') not valid;

  -- Exclusão pelo mesmo caminho do Histórico: precisa funcionar mesmo com a auditoria falhando
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  delete from public.orders where id = v_pedido;
  get diagnostics v_apagados = row_count;
  execute 'reset role';

  if v_apagados <> 1 then
    raise exception 'RESULTADO: FALHA — a falha da auditoria impediu a exclusão do pedido';
  end if;
  if exists (select 1 from public.customer_link_audit where order_id = v_pedido and action = 'order_deleted') then
    raise exception 'RESULTADO: FALHA — a simulação não funcionou (auditoria foi gravada)';
  end if;

  -- Falha resolvida -> a reconciliação (chamada pela sincronização) grava o registro faltante
  alter table public.customer_link_audit drop constraint teste8_falha_simulada;
  v_reconciliados := public._customer_registry_reconcile_deleted_orders(500);

  if not exists (
    select 1 from public.customer_link_audit
    where order_id = v_pedido and action = 'order_deleted' and (details->>'reconciled')::boolean
  ) then
    raise exception 'RESULTADO: FALHA — reconciliação não gravou o order_deleted (reconciliados: %)', v_reconciliados;
  end if;

  -- Idempotência: segunda reconciliação não grava de novo para esse pedido
  perform public._customer_registry_reconcile_deleted_orders(500);
  if (select count(*) from public.customer_link_audit where order_id = v_pedido and action = 'order_deleted') <> 1 then
    raise exception 'RESULTADO: FALHA — reconciliação duplicou o registro';
  end if;

  -- Barreira no banco: um segundo 'order_deleted' para o mesmo pedido é recusado
  begin
    insert into public.customer_link_audit (batch_id, action, order_id, details)
    values (gen_random_uuid(), 'order_deleted', v_pedido, '{"teste": 8}'::jsonb);
    raise exception 'RESULTADO: FALHA — índice único permitiu order_deleted duplicado';
  exception when unique_violation then null;
  end;

  raise exception 'RESULTADO: OK — exclusão concluída apesar da falha da auditoria (WARNING no log), reconciliação gravou 1 order_deleted, é idempotente e o índice único recusa duplicidade (tudo desfeito)';
end;
$teste8$;
