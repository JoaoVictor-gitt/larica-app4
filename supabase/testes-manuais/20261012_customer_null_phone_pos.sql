-- =====================================================================================
-- TESTES PÓS-CORREÇÃO — supabase/migrations/20261012100000_fix_customer_list_null_phone.sql
--
-- Parte A (SOMENTE LEITURA, pode rodar em produção com autorização): cada bloco entre
--     begin transaction read only;  <bloco>  rollback;
-- Parte B (DADOS SINTÉTICOS — SOMENTE AMBIENTE ISOLADO, nunca em produção): insere cadastros
-- de teste e desfaz tudo no final; exige `set larica.ambiente_teste = 'isolado';` e a
-- validação independente do ambiente descrita em 20261009_customer_registry_pos_isolado.sql
-- (a trava de sessão sozinha NÃO comprova que o banco é isolado).
--
-- Blocos DO terminam com "RESULTADO: ..." como erro (proposital). Precisa começar com
-- "RESULTADO: OK". Placeholder: <UUID_ADMIN> = id de um admin ativo.
-- =====================================================================================


-- =====================================================================================
-- PARTE A — leitura
-- =====================================================================================

-- A1 — Corpos novos e segurança preservada. Esperado: md5_ok = true; secdef/volatilidade/
--      config iguais aos de C1; dono e proacl IGUAIS aos anotados em C1 (pré-checagem).
--      md5 comparado com o corpo normalizado para LF (o SQL Editor grava CRLF).
select f.assinatura, md5(replace(p.prosrc, chr(13) || chr(10), chr(10))) = f.md5_esperado as md5_ok,
       position(chr(13) in p.prosrc) > 0 as gravado_com_crlf,
       p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) as dono, p.proacl
from (values
  ('public.list_customers(text,text,text,integer,integer)', 'd1acb7a1330ee5143e82dd09a1532658'),
  ('public.get_customers_overview()',                       '085c14d1b3bd460e15abd1fdf7735fe8')
) as f(assinatura, md5_esperado)
join pg_proc p on p.oid = to_regprocedure(f.assinatura);

-- A2 — Permissões efetivas: devem ser idênticas às de C3 (anon = false, authenticated = true)
select f, has_function_privilege('anon', f, 'execute') as anon,
          has_function_privilege('authenticated', f, 'execute') as authenticated,
          has_function_privilege('service_role', f, 'execute') as service_role
from unnest(array['public.list_customers(text,text,text,integer,integer)', 'public.get_customers_overview()']) as f;


-- A3 — Verificação completa sobre os dados reais (como admin, read only):
--   1. todos os cadastros ativos aparecem na lista (inclusive sem telefone);
--   2. cadastro sem telefone tem shared_phone_count = 0;
--   3. cadastro com telefone tem shared_phone_count = (outros ativos com o mesmo telefone);
--   4. overview.shared_phones = nº de telefones PREENCHIDOS usados por 2+ cadastros ativos;
--   5. funcionário continua recebendo "Acesso negado".
DO $a3$
declare
  v_total bigint;
  v_offset integer := 0;
  v_pagina jsonb;
  v_linha jsonb;
  v_vistos bigint := 0;
  v_sem_tel bigint := 0;
  v_ativos bigint;
  v_ativos_sem_tel bigint;
  v_esperado bigint;
  v_ov jsonb;
  v_shared_manual bigint;
  v_falhas text := '';
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'RESULTADO: NÃO EXECUTADO — rode entre "begin transaction read only;" e "rollback;".';
  end if;

  select count(*), count(*) filter (where phone_e164 is null) into v_ativos, v_ativos_sem_tel
  from public.customers where status = 'active';
  select count(*) into v_shared_manual
  from (select phone_e164 from public.customers where status = 'active' and phone_e164 is not null
        group by phone_e164 having count(*) > 1) x;

  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_ADMIN>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- percorre TODAS as páginas do filtro 'registered' (paginação do próprio servidor)
  loop
    v_pagina := public.list_customers(null, 'name_asc', 'registered', 100, v_offset);
    v_total := (v_pagina->>'total')::bigint;
    exit when jsonb_array_length(v_pagina->'rows') = 0;
    for v_linha in select * from jsonb_array_elements(v_pagina->'rows') loop
      v_vistos := v_vistos + 1;
      if v_linha->>'phone' is null then
        v_sem_tel := v_sem_tel + 1;
        if (v_linha->>'shared_phone_count')::bigint <> 0 then
          v_falhas := v_falhas || format(' [sem telefone com shared_phone_count=%s: %s]', v_linha->>'shared_phone_count', v_linha->>'customer_id');
        end if;
      else
        select count(*) - 1 into v_esperado from public.customers
        where status = 'active' and phone_e164 = v_linha->>'phone';
        if (v_linha->>'shared_phone_count')::bigint <> v_esperado then
          v_falhas := v_falhas || format(' [shared_phone_count %s, esperado %s: %s]', v_linha->>'shared_phone_count', v_esperado, v_linha->>'customer_id');
        end if;
      end if;
    end loop;
    v_offset := v_offset + 100;
    exit when v_offset >= v_total;
  end loop;

  v_ov := public.get_customers_overview();
  execute 'reset role';

  if v_total <> v_ativos or v_vistos <> v_ativos then
    v_falhas := v_falhas || format(' [lista: total=%s, linhas=%s, ativos=%s]', v_total, v_vistos, v_ativos);
  end if;
  if v_sem_tel <> v_ativos_sem_tel then
    v_falhas := v_falhas || format(' [sem telefone na lista=%s, ativos sem telefone=%s]', v_sem_tel, v_ativos_sem_tel);
  end if;
  if (v_ov->>'shared_phones')::bigint <> v_shared_manual then
    v_falhas := v_falhas || format(' [overview.shared_phones=%s, manual=%s]', v_ov->>'shared_phones', v_shared_manual);
  end if;
  if (v_ov->>'registered_customers')::bigint <> v_ativos then
    v_falhas := v_falhas || format(' [overview.registered_customers=%s, ativos=%s]', v_ov->>'registered_customers', v_ativos);
  end if;

  -- funcionário: recusa exata
  perform set_config('request.jwt.claims', json_build_object('sub', '<UUID_EMPLOYEE>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.list_customers();
    v_falhas := v_falhas || ' [employee executou list_customers]';
  exception when others then
    if sqlstate <> 'P0001' or sqlerrm <> 'Acesso negado' then
      v_falhas := v_falhas || format(' [employee: esperado P0001 "Acesso negado", recebido %s "%s"]', sqlstate, sqlerrm);
    end if;
  end;
  execute 'reset role';

  if v_falhas = '' then
    raise exception 'RESULTADO: OK — % ativos listados (% sem telefone), shared_phone_count correto em todos, overview.shared_phones=% (manual %), employee bloqueado. Overview: %',
      v_vistos, v_sem_tel, v_ov->>'shared_phones', v_shared_manual, v_ov;
  else
    raise exception 'RESULTADO: FALHA —%', v_falhas;
  end if;
end;
$a3$;
-- Placeholder adicional neste bloco: <UUID_EMPLOYEE> = id de um funcionário ativo.

-- A4 — Compare com C5/C6 da pré-checagem: rode C5 e C6 de novo (mesmo arquivo _pre) e
--      confira: overview igual em todas as chaves exceto 'shared_phones'; totais por filtro
--      variando só como descrito em C6.


-- =====================================================================================
-- PARTE B — dados sintéticos: SOMENTE AMBIENTE ISOLADO
-- Cria 2 cadastros ativos SEM telefone e 2 cadastros com o MESMO telefone e nomes
-- diferentes; verifica lista e overview; desfaz tudo (RAISE final).
-- Pré-requisito: o ambiente isolado espelha produção (customers.phone_e164 aceita NULL).
-- =====================================================================================
DO $b1$
declare
  v_admin uuid := '<UUID_ADMIN>';
  v_ov_antes jsonb;
  v_ov_depois jsonb;
  v_lista jsonb;
  v_linha jsonb;
  v_falhas text := '';
  v_encontrados integer := 0;
  v_tel text := '353800000001';   -- telefone fictício válido pelo CHECK (353 + 9 dígitos)
begin
  if coalesce(current_setting('larica.ambiente_teste', true), '') <> 'isolado' then
    raise exception 'BLOQUEADO: teste com dados sintéticos — só em ambiente isolado (set larica.ambiente_teste = ''isolado''). Nada foi executado.';
  end if;
  if exists (select 1 from public.customers where phone_e164 = v_tel) then
    raise exception 'RESULTADO: INCONCLUSIVO — o telefone fictício % já existe neste banco; troque v_tel.', v_tel;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ov_antes := public.get_customers_overview();
  execute 'reset role';

  insert into public.customers (display_name, phone_e164, source) values
    ('ZZ Teste Sem Telefone A', null, 'admin'),
    ('ZZ Teste Sem Telefone B', null, 'admin'),
    ('ZZ Teste Compartilhado X', v_tel, 'admin'),
    ('ZZ Teste Compartilhado Y', v_tel, 'admin');

  execute 'set local role authenticated';
  v_lista := public.list_customers('zz teste', 'name_asc', 'all', 100, 0);
  v_ov_depois := public.get_customers_overview();
  execute 'reset role';

  for v_linha in select * from jsonb_array_elements(v_lista->'rows') loop
    if v_linha->>'display_name' like 'ZZ Teste %' then
      v_encontrados := v_encontrados + 1;
      if v_linha->>'display_name' like 'ZZ Teste Sem Telefone%' and (v_linha->>'shared_phone_count')::int <> 0 then
        v_falhas := v_falhas || format(' [%s: shared_phone_count=%s, esperado 0]', v_linha->>'display_name', v_linha->>'shared_phone_count');
      end if;
      if v_linha->>'display_name' like 'ZZ Teste Compartilhado%' and (v_linha->>'shared_phone_count')::int <> 1 then
        v_falhas := v_falhas || format(' [%s: shared_phone_count=%s, esperado 1]', v_linha->>'display_name', v_linha->>'shared_phone_count');
      end if;
    end if;
  end loop;

  -- 1. os 4 aparecem (inclusive os 2 sem telefone)
  if v_encontrados <> 4 then
    v_falhas := v_falhas || format(' [lista mostrou %s de 4 cadastros de teste]', v_encontrados);
  end if;
  -- 3/4. dois sem telefone NÃO somam; o par com mesmo telefone soma exatamente 1
  if (v_ov_depois->>'shared_phones')::int - (v_ov_antes->>'shared_phones')::int <> 1 then
    v_falhas := v_falhas || format(' [shared_phones antes=%s depois=%s, esperado +1]', v_ov_antes->>'shared_phones', v_ov_depois->>'shared_phones');
  end if;
  -- 6. indicadores de pedidos/faturamento não mudam com cadastros sem pedidos
  if (v_ov_depois - 'shared_phones' - 'registered_customers' - 'repeated_names')
     is distinct from (v_ov_antes - 'shared_phones' - 'registered_customers' - 'repeated_names') then
    v_falhas := v_falhas || format(' [outros indicadores mudaram: antes %s, depois %s]', v_ov_antes, v_ov_depois);
  end if;
  if (v_ov_depois->>'registered_customers')::int - (v_ov_antes->>'registered_customers')::int <> 4 then
    v_falhas := v_falhas || ' [registered_customers não subiu exatamente 4]';
  end if;
  -- filtro de duplicidades continua sinalizando o telefone compartilhado
  execute 'set local role authenticated';
  v_lista := public.list_customers('zz teste compartilhado', 'name_asc', 'duplicates', 100, 0);
  execute 'reset role';
  if (v_lista->>'total')::int <> 2 then
    v_falhas := v_falhas || format(' [filtro duplicates mostrou %s de 2 com telefone compartilhado]', v_lista->>'total');
  end if;

  if v_falhas = '' then
    raise exception 'RESULTADO: OK — sem telefone aparecem com shared_phone_count 0, compartilhados com 1 e no filtro de duplicidades, shared_phones +1, demais indicadores intactos (tudo desfeito)';
  else
    raise exception 'RESULTADO: FALHA —%', v_falhas;
  end if;
end;
$b1$;
