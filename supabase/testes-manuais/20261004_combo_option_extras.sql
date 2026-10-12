-- =====================================================================================
-- TESTES MANUAIS — rodar no SQL Editor LOGO APÓS aplicar
-- supabase/migrations/20261004100000_add_combo_option_extras_for_sides.sql
--
-- NÃO é migration e NÃO entra no deploy. Rode um bloco por vez (selecione o bloco e execute).
--
-- Os blocos DO (testes 3 e 4) terminam SEMPRE com um erro "RESULTADO: ..." — é proposital:
-- o erro desfaz tudo o que o teste fez (nenhum pedido, estoque, acréscimo ou evento Realtime
-- fica gravado). Leia a mensagem: precisa começar com "RESULTADO: OK".
-- =====================================================================================


-- -------------------------------------------------------------------------------------
-- TESTE 1 — Estrutura: RLS ligada + policies e grants iguais aos de combo_skewer_options
-- -------------------------------------------------------------------------------------

-- 1a) RLS: esperado relrowsecurity = true nas duas
select relname, relrowsecurity
from pg_class
where oid in ('public.combo_option_extras'::regclass, 'public.combo_skewer_options'::regclass);

-- 1b) Policies lado a lado: esperado o mesmo cmd/roles/qual/with_check nas duas tabelas
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename in ('combo_option_extras', 'combo_skewer_options')
order by cmd, tablename;

-- 1c) Grants de anon/authenticated lado a lado: esperado o mesmo conjunto nas duas
--     (anon: só SELECT; authenticated: SELECT, INSERT, UPDATE, DELETE)
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privilegios
from information_schema.role_table_grants
where table_name in ('combo_option_extras', 'combo_skewer_options')
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by grantee, table_name;


-- -------------------------------------------------------------------------------------
-- TESTE 2 — Pedidos antigos intactos: nenhum acompanhamento com acréscimo gravado ainda
-- Esperado: 0 (rodar ANTES de fazer qualquer pedido com acompanhamento pago)
-- -------------------------------------------------------------------------------------

select count(*) as acompanhamentos_com_extra_gravado
from public.order_item_selections
where selection_type = 'side'
  and extra_price <> 0;


-- -------------------------------------------------------------------------------------
-- TESTE 3 — Segurança: anon só lê; authenticated comum lê mas não gerencia; staff gerencia
-- Opcional: para testar staff, cole o UUID de um usuário staff seu em v_staff
-- (Authentication > Users). Deixe null para pular essa parte.
-- -------------------------------------------------------------------------------------

do $$
declare
  v_staff uuid := null; -- <<< opcional: '00000000-0000-0000-0000-000000000000'
  v_combo uuid;
  v_opcao uuid;
  v_id uuid;
  n integer;
  r text := '';
  falhas integer := 0;
begin
  select id into v_combo from public.products where category = 'combos' order by name limit 1;
  select id into v_opcao from public.products where category = 'sides' order by name limit 1;
  if v_combo is null or v_opcao is null then
    raise exception 'RESULTADO: não foi possível testar — precisa de 1 combo e 1 acompanhamento cadastrados';
  end if;

  -- Linha de teste (desfeita no final, junto com todo o resto)
  insert into public.combo_option_extras (combo_id, option_product_id, option_type, extra_price)
  values (v_combo, v_opcao, 'side', 1.5)
  on conflict (combo_id, option_product_id, option_type) do update set extra_price = 1.5
  returning id into v_id;

  -- ===== ANON =====
  set local role anon;

  begin
    perform count(*) from public.combo_option_extras;
    r := r || 'anon SELECT ok; ';
  exception when others then
    falhas := falhas + 1; r := r || 'anon SELECT FALHOU (' || sqlerrm || '); ';
  end;

  begin
    insert into public.combo_option_extras (combo_id, option_product_id, option_type, extra_price)
    values (v_combo, v_opcao, 'skewer', 0);
    falhas := falhas + 1; r := r || 'anon INSERT FALHOU (conseguiu inserir); ';
  exception
    when insufficient_privilege then r := r || 'anon INSERT bloqueado; ';
    when others then falhas := falhas + 1; r := r || 'anon INSERT erro inesperado (' || sqlerrm || '); ';
  end;

  begin
    update public.combo_option_extras set extra_price = 99 where id = v_id;
    falhas := falhas + 1; r := r || 'anon UPDATE FALHOU (conseguiu atualizar); ';
  exception
    when insufficient_privilege then r := r || 'anon UPDATE bloqueado; ';
    when others then falhas := falhas + 1; r := r || 'anon UPDATE erro inesperado (' || sqlerrm || '); ';
  end;

  begin
    delete from public.combo_option_extras where id = v_id;
    falhas := falhas + 1; r := r || 'anon DELETE FALHOU (conseguiu excluir); ';
  exception
    when insufficient_privilege then r := r || 'anon DELETE bloqueado; ';
    when others then falhas := falhas + 1; r := r || 'anon DELETE erro inesperado (' || sqlerrm || '); ';
  end;

  reset role;

  -- ===== AUTHENTICATED COMUM (usuário aleatório, não-staff) =====
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role authenticated;

  begin
    if public.is_staff() then
      falhas := falhas + 1; r := r || 'is_staff() do usuário aleatório = true (inesperado); ';
    else
      r := r || 'is_staff()=false; ';
    end if;
  exception when others then
    falhas := falhas + 1; r := r || 'is_staff() erro (' || sqlerrm || '); ';
  end;

  begin
    perform count(*) from public.combo_option_extras;
    r := r || 'authenticated SELECT ok; ';
  exception when others then
    falhas := falhas + 1; r := r || 'authenticated SELECT FALHOU (' || sqlerrm || '); ';
  end;

  begin
    insert into public.combo_option_extras (combo_id, option_product_id, option_type, extra_price)
    values (v_combo, v_opcao, 'skewer', 0);
    falhas := falhas + 1; r := r || 'authenticated INSERT FALHOU (conseguiu inserir); ';
  exception
    when insufficient_privilege then r := r || 'authenticated INSERT bloqueado (RLS); ';
    when others then falhas := falhas + 1; r := r || 'authenticated INSERT erro inesperado (' || sqlerrm || '); ';
  end;

  begin
    update public.combo_option_extras set extra_price = 99 where id = v_id;
    get diagnostics n = row_count;
    if n = 0 then r := r || 'authenticated UPDATE afetou 0 linhas; ';
    else falhas := falhas + 1; r := r || 'authenticated UPDATE FALHOU (' || n || ' linha); ';
    end if;
  exception when others then
    r := r || 'authenticated UPDATE bloqueado (' || sqlerrm || '); ';
  end;

  begin
    delete from public.combo_option_extras where id = v_id;
    get diagnostics n = row_count;
    if n = 0 then r := r || 'authenticated DELETE afetou 0 linhas; ';
    else falhas := falhas + 1; r := r || 'authenticated DELETE FALHOU (' || n || ' linha); ';
    end if;
  exception when others then
    r := r || 'authenticated DELETE bloqueado (' || sqlerrm || '); ';
  end;

  reset role;

  -- ===== STAFF (opcional) =====
  if v_staff is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_staff::text, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      update public.combo_option_extras set extra_price = 2 where id = v_id;
      get diagnostics n = row_count;
      if n = 1 then r := r || 'staff UPDATE ok; ';
      else falhas := falhas + 1; r := r || 'staff UPDATE FALHOU (' || n || ' linhas — o UUID é mesmo de staff?); ';
      end if;
    exception when others then
      falhas := falhas + 1; r := r || 'staff UPDATE erro (' || sqlerrm || '); ';
    end;
    reset role;
  else
    r := r || 'staff: pulado (v_staff vazio); ';
  end if;

  raise exception 'RESULTADO: % — %', case when falhas = 0 then 'OK' else 'FALHOU (' || falhas || ')' end, r;
end $$;


-- -------------------------------------------------------------------------------------
-- TESTE 4 — Cobrança real via create_customer_order (precisa do restaurante ABERTO e
-- aceitando RETIRADA; a função recusa fora do horário). Tudo é desfeito no final.
-- Consome 2 números de pedido (a numeração pula 2), pois sequências não voltam no rollback.
--
-- Usa automaticamente: o 1º combo ativo com acompanhamentos, o espeto de MAIOR acréscimo
-- desse combo (ex.: Picanha) e um acompanhamento elegível. Envia extra_price FALSOS no payload
-- (0 no espeto e -999 no acompanhamento) — eles precisam ser ignorados.
-- -------------------------------------------------------------------------------------

do $$
declare
  v_combo record;
  v_esp record;
  v_lado record;
  v_res jsonb;
  v_oi record;
  v_ext_lado numeric;
  v_ext_esp numeric;
  v_esperado numeric;
  r text := '';
  falhas integer := 0;
begin
  select p.id, p.name, p.price, cc.allowed_skewers, cc.allowed_sides
    into v_combo
  from public.products p
  join public.combo_configs cc on cc.product_id = p.id
  where p.category = 'combos' and p.active and p.is_available and cc.allowed_sides >= 1
  order by p.name
  limit 1;
  if not found then
    raise exception 'RESULTADO: não foi possível testar — nenhum combo ativo com acompanhamentos';
  end if;

  select p.id, p.name, o.extra_price
    into v_esp
  from public.combo_skewer_options o
  join public.products p on p.id = o.skewer_product_id
  where o.combo_id = v_combo.id and p.active and p.is_available
  order by o.extra_price desc, p.name
  limit 1;
  if not found then
    raise exception 'RESULTADO: não foi possível testar — combo % sem espeto elegível', v_combo.name;
  end if;

  select p.id, p.name
    into v_lado
  from public.products p
  where p.category = 'sides' and p.active and p.is_available
    and not exists (
      select 1 from public.combo_included_products cip
      where cip.combo_id = v_combo.id and cip.included_product_id = p.id
    )
  order by p.name
  limit 1;
  if not found then
    raise exception 'RESULTADO: não foi possível testar — nenhum acompanhamento elegível para %', v_combo.name;
  end if;

  r := r || format('combo=%s, espeto=%s (+%s), acompanhamento=%s; ', v_combo.name, v_esp.name, v_esp.extra_price, v_lado.name);

  -- (a) acompanhamento configurado em +2 (só dentro do teste), 2 combos
  insert into public.combo_option_extras (combo_id, option_product_id, option_type, extra_price)
  values (v_combo.id, v_lado.id, 'side', 2)
  on conflict (combo_id, option_product_id, option_type) do update set extra_price = 2;

  v_res := public.create_customer_order(jsonb_build_object(
    'customer_name', 'TESTE MIGRATION (desfeito)',
    'fulfilment_type', 'collection',
    'payment_method', 'cash',
    'needs_change', false,
    'items', jsonb_build_array(jsonb_build_object(
      'item_type', 'combo',
      'product_id', v_combo.id,
      'quantity', 2,
      'unit_price', 0,
      'extra_price', 0,
      'selections', jsonb_build_object(
        'skewers', jsonb_build_array(jsonb_build_object('product_id', v_esp.id, 'quantity', v_combo.allowed_skewers, 'extra_price', 0)),
        'sides', jsonb_build_array(jsonb_build_object('product_id', v_lado.id, 'quantity', v_combo.allowed_sides, 'extra_price', -999))
      )
    ))
  ));

  select oi.id, oi.unit_price, oi.extras_total, oi.total_price into v_oi
  from public.order_items oi where oi.order_id = (v_res->>'id')::uuid;
  select s.extra_price into v_ext_lado from public.order_item_selections s where s.order_item_id = v_oi.id and s.selection_type = 'side';
  select s.extra_price into v_ext_esp from public.order_item_selections s where s.order_item_id = v_oi.id and s.selection_type = 'skewer';

  v_esperado := (v_esp.extra_price * v_combo.allowed_skewers + 2 * v_combo.allowed_sides) * 2;

  if v_oi.extras_total = v_esperado then r := r || format('(a) extras_total=%s ok; ', v_oi.extras_total);
  else falhas := falhas + 1; r := r || format('(a) extras_total=%s, esperado %s FALHOU; ', v_oi.extras_total, v_esperado); end if;

  if v_ext_lado = 2 then r := r || '(a) extra_price acompanhamento=2 ok (−999 do payload ignorado); ';
  else falhas := falhas + 1; r := r || format('(a) extra_price acompanhamento=%s FALHOU; ', v_ext_lado); end if;

  if v_ext_esp = v_esp.extra_price then r := r || format('(a) extra_price espeto=%s ok (igual combo_skewer_options; 0 do payload ignorado); ', v_ext_esp);
  else falhas := falhas + 1; r := r || format('(a) extra_price espeto=%s, esperado %s FALHOU; ', v_ext_esp, v_esp.extra_price); end if;

  if v_oi.unit_price = v_combo.price and v_oi.total_price = v_combo.price * 2 + v_oi.extras_total then
    r := r || format('(a) total_price=%s ok; ', v_oi.total_price);
  else
    falhas := falhas + 1; r := r || format('(a) unit_price=%s total_price=%s FALHOU; ', v_oi.unit_price, v_oi.total_price);
  end if;

  -- (b) sem configuração: acompanhamento volta a €0, só o acréscimo do espeto conta, 1 combo
  delete from public.combo_option_extras
  where combo_id = v_combo.id and option_product_id = v_lado.id and option_type = 'side';

  v_res := public.create_customer_order(jsonb_build_object(
    'customer_name', 'TESTE MIGRATION (desfeito)',
    'fulfilment_type', 'collection',
    'payment_method', 'cash',
    'needs_change', false,
    'items', jsonb_build_array(jsonb_build_object(
      'item_type', 'combo',
      'product_id', v_combo.id,
      'quantity', 1,
      'selections', jsonb_build_object(
        'skewers', jsonb_build_array(jsonb_build_object('product_id', v_esp.id, 'quantity', v_combo.allowed_skewers)),
        'sides', jsonb_build_array(jsonb_build_object('product_id', v_lado.id, 'quantity', v_combo.allowed_sides))
      )
    ))
  ));

  select oi.id, oi.extras_total into v_oi
  from public.order_items oi where oi.order_id = (v_res->>'id')::uuid;
  select s.extra_price into v_ext_lado from public.order_item_selections s where s.order_item_id = v_oi.id and s.selection_type = 'side';

  if v_ext_lado = 0 and v_oi.extras_total = v_esp.extra_price * v_combo.allowed_skewers then
    r := r || format('(b) sem configuração: acompanhamento=0, extras_total=%s ok; ', v_oi.extras_total);
  else
    falhas := falhas + 1; r := r || format('(b) acompanhamento=%s extras_total=%s FALHOU; ', v_ext_lado, v_oi.extras_total);
  end if;

  raise exception 'RESULTADO: % — %', case when falhas = 0 then 'OK' else 'FALHOU (' || falhas || ')' end, r;
end $$;
