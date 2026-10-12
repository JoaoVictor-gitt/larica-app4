-- =====================================================================================
-- Correção: clientes ativos SEM telefone (customers.phone_e164 IS NULL)
--
-- 1) public.list_customers: cadastro ativo sem telefone sumia da lista, porque o JOIN com
--    telefones_ativos era INNER (NULL nunca casa). Agora:
--      - telefones_ativos ignora telefone nulo;
--      - LEFT JOIN em telefones_ativos (só quando o cadastro tem telefone);
--      - shared_phone_count = coalesce(ta.n - 1, 0) -> 0 para cadastro sem telefone.
-- 2) public.get_customers_overview: 'shared_phones' agrupava também o NULL (vários
--    cadastros sem telefone contavam como 1 "telefone compartilhado"). Agora só conta
--    telefones preenchidos.
--
-- Mais nada muda: busca, filtros, ordenação, paginação, demais indicadores e o formato JSON
-- retornado são idênticos. As duas definições abaixo são CÓPIA INTEGRAL das versões em
-- produção (= 20261009100000_add_customer_registry.sql, ver "Base" abaixo) com SÓ estes
-- trechos trocados:
--   list_customers:          3 trechos (CTE telefones_ativos, shared_phone_count, JOIN)
--   get_customers_overview:  1 trecho  ('shared_phones')
--
-- Segurança preservada: CREATE OR REPLACE mantém dono e ACL (grants) da função; os atributos
-- SECURITY DEFINER, STABLE, LANGUAGE plpgsql e SET search_path TO '' são repetidos
-- exatamente como estão. A checagem public.is_admin() no início de cada função não muda.
-- Nenhum GRANT/REVOKE nesta migration.
--
-- Base: as versões REAIS de produção (verificação C1 de 2026-10-12):
--   list_customers          md5(prosrc) em produção = b16705e5dd0a6ec1067baa4466db7ba4
--   get_customers_overview  md5(prosrc) em produção = 5568fa9012e443faf10cbaee9097bc35
-- Diferença em relação ao repositório: SOMENTE o final de linha. Produção guarda o corpo com
-- CRLF (colado pelo SQL Editor a partir de arquivo com quebras do Windows); o repositório usa
-- LF. Convertendo o corpo do repositório para CRLF, o md5 é exatamente o medido em produção
-- nas duas funções; normalizando o de produção para LF, é exatamente o do repositório
-- (536e3d10... e 1d3b1f9a...). Nenhuma diferença de lógica, texto ou comentário.
-- Final de linha do corpo NOVO: depende de como o script chega ao banco — o SQL Editor
-- envia CRLF (foi o que fez a 1ª execução, em 2026-10-12, ser desfeita: a verificação final
-- comparava o md5 bruto); a CLI envia LF. Sem impacto em execução (quebra de linha dentro de
-- PL/pgSQL é só espaço em branco). Por isso TODAS as comparações de corpo NOVO usam o texto
-- normalizado: md5(replace(prosrc, CR||LF, LF)). A guarda de ENTRADA (a) continua usando o
-- md5 BRUTO de produção, que é um valor medido.
--
-- Guarda contra "recriar às cegas" (seção 0), por função — tudo precisa bater, senão a
-- migration aborta sem alterar nada:
--   (a) md5(prosrc) atual = md5 medido em produção (nada mudou desde a C1);
--   (b) md5 do corpo atual com CRLF -> LF = md5 do corpo do repositório (a única diferença é
--       o final de linha);
--   (c) cada trecho a corrigir aparece EXATAMENTE 1 vez no corpo atual;
--   (d) aplicando ao corpo ATUAL de produção só as trocas desta migration, o resultado tem
--       exatamente o md5 do corpo instalado abaixo — prova, no próprio banco, de que nada
--       além dos trechos corrigidos muda em relação à produção;
--   (e) atributos: SECURITY DEFINER, STABLE, plpgsql, retorno jsonb, search_path '';
--   (f) o papel que executa é dono (ou membro do papel dono) da função — exigido por
--       CREATE OR REPLACE; sem isso a migration aborta antes de qualquer troca.
-- Depois de substituir, confere que dono, ACL, SECURITY DEFINER, volatilidade, linguagem e
-- search_path ficaram idênticos aos de antes e que o corpo gravado é o revisado; se não,
-- aborta (tudo é desfeito).
--
-- Transação: este arquivo NÃO tem BEGIN/COMMIT porque a CLI do Supabase já executa cada
-- migration dentro de uma transação (um COMMIT aqui encerraria a transação da CLI antes da
-- hora). Para o SQL Editor, use a cópia idêntica com BEGIN/COMMIT:
--   supabase/sql-editor/20261012100000_fix_customer_list_null_phone.sql
-- SET LOCAL lock_timeout vale só dentro da transação e expira sozinho no COMMIT/ROLLBACK
-- (não há RESET). Fora de transação, SET LOCAL não tem efeito — por isso nunca execute
-- este conteúdo comando a comando.
--
-- Não toca em tabelas, dados, pedidos, sincronização nem nas RPCs admin_*.
-- Pré-checagem (só leitura): supabase/testes-manuais/20261012_customer_null_phone_pre.sql
-- =====================================================================================

-- Limita a ESPERA por locks (ex.: alguém alterando estas funções ao mesmo tempo). Não limita
-- a duração da transação; CREATE OR REPLACE FUNCTION não bloqueia quem está executando as
-- funções nem pedidos.
SET LOCAL lock_timeout = '5s';

DO $guard$
declare
  c_lf constant text := chr(10);
  c_crlf constant text := chr(13) || chr(10);
  v_falhas text := '';
  v_norm text;
  v_trocas text[][];
  v_i integer;
  v_ocorrencias integer;
  r record;
begin
  for r in
    select f.assinatura, f.md5_producao, f.md5_repo_lf, f.md5_novo,
           p.oid, p.prosrc, p.prosecdef, p.provolatile, p.proconfig, p.proowner, l.lanname,
           pg_get_function_result(p.oid) as retorno
    from (values
      ('public.list_customers(text,text,text,integer,integer)',
       'b16705e5dd0a6ec1067baa4466db7ba4', '536e3d10c2f2fb8026b63df23320a6a5', 'd1acb7a1330ee5143e82dd09a1532658'),
      ('public.get_customers_overview()',
       '5568fa9012e443faf10cbaee9097bc35', '1d3b1f9a2110ea792c4369affafc0431', '085c14d1b3bd460e15abd1fdf7735fe8')
    ) as f(assinatura, md5_producao, md5_repo_lf, md5_novo)
    left join pg_proc p on p.oid = to_regprocedure(f.assinatura)
    left join pg_language l on l.oid = p.prolang
  loop
    if r.oid is null then
      v_falhas := v_falhas || format(' [%s não existe]', r.assinatura);
      continue;
    end if;

    -- (a) nada mudou em produção desde a verificação C1
    if md5(r.prosrc) <> r.md5_producao then
      v_falhas := v_falhas || format(' [%s: corpo em produção mudou desde a C1 (md5 %s, esperado %s)]',
                                     r.assinatura, md5(r.prosrc), r.md5_producao);
      continue;
    end if;

    -- (b) a única diferença em relação ao repositório é o final de linha
    v_norm := replace(r.prosrc, c_crlf, c_lf);
    if md5(v_norm) <> r.md5_repo_lf then
      v_falhas := v_falhas || format(' [%s: conteúdo difere do repositório além do final de linha (md5 normalizado %s)]',
                                     r.assinatura, md5(v_norm));
      continue;
    end if;

    -- trocas desta migration (de -> para), aplicadas sobre o corpo REAL de produção
    if r.assinatura like 'public.list_customers(%' then
      v_trocas := array[
        array['select phone_e164, count(*) as n from ativos group by phone_e164',
              'select phone_e164, count(*) as n from ativos where phone_e164 is not null group by phone_e164'],
        array['(ta.n - 1)::bigint as shared_phone_count',
              'coalesce(ta.n - 1, 0)::bigint as shared_phone_count'],
        array['join telefones_ativos ta on ta.phone_e164 = a.phone_e164',
              'left join telefones_ativos ta' || c_lf || '      on ta.phone_e164 = a.phone_e164' || c_lf || '      and a.phone_e164 is not null']
      ];
    else
      v_trocas := array[
        array['select phone_e164 from ativos group by phone_e164 having count(*) > 1',
              'select phone_e164 from ativos where phone_e164 is not null group by phone_e164 having count(*) > 1']
      ];
    end if;

    for v_i in 1 .. array_length(v_trocas, 1) loop
      -- (c) cada trecho aparece exatamente 1 vez
      v_ocorrencias := (length(v_norm) - length(replace(v_norm, v_trocas[v_i][1], ''))) / length(v_trocas[v_i][1]);
      if v_ocorrencias <> 1 then
        v_falhas := v_falhas || format(' [%s: trecho "%s" aparece %s vez(es), esperado 1]',
                                       r.assinatura, v_trocas[v_i][1], v_ocorrencias);
      end if;
      v_norm := replace(v_norm, v_trocas[v_i][1], v_trocas[v_i][2]);
    end loop;

    -- (d) produção + só estas trocas = exatamente o corpo instalado abaixo
    if md5(v_norm) <> r.md5_novo then
      v_falhas := v_falhas || format(' [%s: produção + trocas não reproduz o corpo instalado (md5 %s, esperado %s)]',
                                     r.assinatura, md5(v_norm), r.md5_novo);
    end if;

    -- (e) atributos de segurança
    if not r.prosecdef or r.provolatile <> 's' or r.lanname <> 'plpgsql' or r.retorno <> 'jsonb'
       or r.proconfig is distinct from array['search_path=""'] then
      v_falhas := v_falhas || format(' [%s: atributos inesperados (secdef=%s, volatilidade=%s, linguagem=%s, retorno=%s, config=%s)]',
                                     r.assinatura, r.prosecdef, r.provolatile, r.lanname, r.retorno, r.proconfig);
    end if;

    -- (f) permissão para CREATE OR REPLACE: dono da função (ou membro do papel dono)
    if not pg_has_role(current_user, r.proowner, 'MEMBER') then
      v_falhas := v_falhas || format(' [%s: o papel %s não é dono da função (dono: %s)]',
                                     r.assinatura, current_user, pg_get_userbyid(r.proowner));
    end if;
  end loop;

  if v_falhas <> '' then
    raise exception 'Correção interrompida — nada foi alterado:%. Envie select pg_get_functiondef(...) da(s) função(ões) para revisar a diferença.', v_falhas;
  end if;
end;
$guard$;

-- Estado de segurança antes da troca (comparado na verificação final, que a remove). Se
-- qualquer passo falhar, o ROLLBACK da transação também a descarta.
CREATE TEMP TABLE _larica_estado_funcoes_clientes AS
SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, p.provolatile, p.proconfig, p.prolang
FROM pg_proc p
WHERE p.oid IN ('public.list_customers(text,text,text,integer,integer)'::regprocedure,
                'public.get_customers_overview()'::regprocedure);


-- =====================================================================================
-- 1) get_customers_overview — só 'shared_phones' alterado
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.get_customers_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  with ativos as (
    select c.id, c.name_key, c.phone_e164
    from public.customers c
    where c.status = 'active'
  ),
  vinculados as (
    select l.customer_id, o.total::numeric as total
    from public.order_customer_links l
    join public.orders o on o.id = l.order_id
    join ativos a on a.id = l.customer_id
    where l.state = 'linked'
      and o.status = 'completed'
  ),
  por_cliente as (
    select customer_id, count(*) as n
    from vinculados
    group by customer_id
  ),
  sem_vinculo as (
    select o.status, o.total::numeric as total, l.state,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where l.order_id is null or l.state = 'excluded'
  ),
  pendentes as (
    select * from sem_vinculo
    where state is null and nk is not null and pk is not null
  ),
  nao_cadastrados as (
    select * from sem_vinculo
    where status = 'completed'
      and not (state is null and nk is not null and pk is not null)
  )
  select jsonb_build_object(
    'registered_customers',      (select count(*) from ativos),
    'buying_customers',          (select count(*) from por_cliente),
    'recurring_customers',       (select count(*) from por_cliente where n >= 2),
    'orders_count',              (select count(*) from vinculados),
    'total_spent',               (select coalesce(sum(total), 0) from vinculados),
    'avg_ticket',                (select case when count(*) > 0 then round(coalesce(sum(total), 0) / count(*), 2) else 0 end from vinculados),
    'unregistered_orders',       (select count(*) from nao_cadastrados),
    'unregistered_total',        (select coalesce(sum(total), 0) from nao_cadastrados),
    'unregistered_names',        (select count(distinct nk) from nao_cadastrados),
    'unregistered_name_matches', (select count(distinct n.nk) from nao_cadastrados n where exists (select 1 from ativos a where a.name_key = n.nk)),
    'pending_sync_orders',       (select count(*) from pendentes),
    'repeated_names',            (select count(*) from (select name_key from ativos group by name_key having count(*) > 1) x),
    'shared_phones',             (select count(*) from (select phone_e164 from ativos where phone_e164 is not null group by phone_e164 having count(*) > 1) y)
  )
  into v_result;

  return v_result;
end;
$function$;


-- =====================================================================================
-- 2) list_customers — só telefones_ativos, shared_phone_count e o JOIN alterados
-- =====================================================================================
CREATE OR REPLACE FUNCTION public.list_customers(
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'name_asc',
  p_filter text DEFAULT 'all',
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sort text := case when p_sort in ('name_asc', 'orders_desc', 'spent_desc', 'last_desc') then p_sort else 'name_asc' end;
  v_filter text := case when p_filter in ('all', 'registered', 'buyers', 'unregistered', 'duplicates') then p_filter else 'all' end;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_name_like text;
  v_digits text;
  v_digits_sem_zero text;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Acesso negado';
  end if;

  -- Padrões LIKE: o termo digitado é tratado como texto literal. Caractere de escape '#'
  -- (usado com "like ... escape '#'"): '#' -> '##', '%' -> '#%', '_' -> '#_'.
  if v_search is not null then
    if v_search ~ '[[:alpha:]]' then
      v_name_like := '%' || replace(replace(replace(public.normalize_customer_name(v_search), '#', '##'), '%', '#%'), '_', '#_') || '%';
    else
      v_digits := nullif(regexp_replace(v_search, '[^0-9]', '', 'g'), '');
      if v_digits is not null and v_digits like '0%' and length(v_digits) > 1 then
        v_digits_sem_zero := substr(v_digits, 2);
      end if;
      if v_digits is null then
        v_name_like := '%' || replace(replace(replace(lower(v_search), '#', '##'), '%', '#%'), '_', '#_') || '%';
      end if;
    end if;
  end if;

  with ativos as (
    select c.id, c.display_name, c.name_key, c.phone_e164
    from public.customers c
    where c.status = 'active'
  ),
  metricas as (
    select l.customer_id,
           count(*) filter (where o.status = 'completed') as n,
           coalesce(sum(o.total::numeric) filter (where o.status = 'completed'), 0) as soma,
           min(o.created_at) filter (where o.status = 'completed') as primeira,
           max(o.created_at) filter (where o.status = 'completed') as ultima
    from public.order_customer_links l
    join public.orders o on o.id = l.order_id
    where l.state = 'linked'
    group by l.customer_id
  ),
  sem as (
    select o.id, o.created_at, o.total::numeric as total, o.customer_name, o.customer_phone,
           public.normalize_customer_name(o.customer_name) as nk,
           public.normalize_customer_phone(o.customer_phone) as pk,
           case when l.order_id is null
                     and public.normalize_customer_name(o.customer_name) is not null
                     and public.normalize_customer_phone(o.customer_phone) is not null
                then 'pending' else 'unregistered' end as kind
    from public.orders o
    left join public.order_customer_links l on l.order_id = o.id
    where o.status = 'completed'
      and (l.order_id is null or l.state = 'excluded')
  ),
  nomes_ativos as (
    select name_key, count(*) as n from ativos group by name_key
  ),
  telefones_ativos as (
    select phone_e164, count(*) as n from ativos where phone_e164 is not null group by phone_e164
  ),
  nomes_sem as (
    select nk, count(*) as n from sem where kind = 'unregistered' and nk is not null group by nk
  ),
  linhas as (
    select 'registered'::text as kind,
           a.id as customer_id,
           null::uuid as order_id,
           a.display_name,
           a.phone_e164 as phone,
           a.name_key as nk,
           coalesce(m.n, 0)::bigint as orders_count,
           coalesce(m.soma, 0)::numeric as total_spent,
           (case when coalesce(m.n, 0) > 0 then round(m.soma / m.n, 2) else 0 end)::numeric as avg_ticket,
           m.primeira as first_order_at,
           m.ultima as last_order_at,
           (na.n - 1)::bigint as same_name_count,
           coalesce(ta.n - 1, 0)::bigint as shared_phone_count,
           coalesce(ns.n, 0)::bigint as possible_matches,
           false as phone_unrecognized
    from ativos a
    join nomes_ativos na on na.name_key = a.name_key
    left join telefones_ativos ta
      on ta.phone_e164 = a.phone_e164
      and a.phone_e164 is not null
    left join metricas m on m.customer_id = a.id
    left join nomes_sem ns on ns.nk = a.name_key
    union all
    select s.kind,
           null::uuid,
           s.id,
           btrim(s.customer_name),
           s.customer_phone,
           s.nk,
           1::bigint,
           coalesce(s.total, 0)::numeric,
           round(coalesce(s.total, 0), 2)::numeric,
           s.created_at,
           s.created_at,
           0::bigint,
           0::bigint,
           (case when s.kind = 'unregistered'
                 then coalesce(na.n, 0) + coalesce(ns.n, 1) - 1
                 else coalesce(na.n, 0) end)::bigint,
           (s.pk is null and coalesce(btrim(s.customer_phone), '') <> '')
    from sem s
    left join nomes_ativos na on na.name_key = s.nk
    left join nomes_sem ns on ns.nk = s.nk
  ),
  filtrado as (
    select *
    from linhas l
    where (v_filter = 'all'
           or (v_filter = 'registered' and l.kind = 'registered')
           or (v_filter = 'buyers' and l.kind = 'registered' and l.orders_count > 0)
           or (v_filter = 'unregistered' and l.kind = 'unregistered')
           or (v_filter = 'duplicates' and (l.same_name_count > 0 or l.shared_phone_count > 0 or l.possible_matches > 0)))
      and (v_search is null
           or (v_name_like is not null and l.nk like v_name_like escape '#')
           or (v_digits is not null and (
                 regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'
                 or (v_digits_sem_zero is not null
                     and regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits_sem_zero || '%'))))
  ),
  pagina as (
    select f.*,
           row_number() over (
             order by
               case when v_sort = 'orders_desc' then f.orders_count end desc nulls last,
               case when v_sort = 'spent_desc' then f.total_spent end desc nulls last,
               case when v_sort = 'last_desc' then f.last_order_at end desc nulls last,
               f.nk asc nulls last,
               f.last_order_at desc nulls last,
               coalesce(f.customer_id, f.order_id)
           ) as ordem
    from filtrado f
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrado),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', p.kind,
               'customer_id', p.customer_id,
               'order_id', p.order_id,
               'display_name', p.display_name,
               'phone', p.phone,
               'orders_count', p.orders_count,
               'total_spent', p.total_spent,
               'avg_ticket', p.avg_ticket,
               'first_order_at', p.first_order_at,
               'last_order_at', p.last_order_at,
               'same_name_count', p.same_name_count,
               'shared_phone_count', p.shared_phone_count,
               'possible_matches', p.possible_matches,
               'phone_unrecognized', p.phone_unrecognized
             ) order by p.ordem)
      from pagina p
      where p.ordem > v_offset and p.ordem <= v_offset + v_limit
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$function$;

-- Verificação pós-troca: segurança idêntica à de antes e corpos exatamente os revisados.
DO $verificacao$
declare
  v_falhas text := '';
  r record;
begin
  for r in
    select a.proname,
           (d.proowner = a.proowner) as dono_ok,
           (d.proacl is not distinct from a.proacl) as acl_ok,
           (d.prosecdef = a.prosecdef and d.provolatile = a.provolatile and d.prolang = a.prolang
            and d.proconfig is not distinct from a.proconfig) as atributos_ok,
           -- normalizado para LF: o SQL Editor grava CRLF, a CLI grava LF (ver cabeçalho)
           md5(replace(d.prosrc, chr(13) || chr(10), chr(10))) as md5_novo,
           case a.proname when 'list_customers' then 'd1acb7a1330ee5143e82dd09a1532658'
                          when 'get_customers_overview' then '085c14d1b3bd460e15abd1fdf7735fe8' end as md5_esperado
    from _larica_estado_funcoes_clientes a
    join pg_proc d on d.oid = a.oid
  loop
    if not r.dono_ok then v_falhas := v_falhas || format(' [%s: dono mudou]', r.proname); end if;
    if not r.acl_ok then v_falhas := v_falhas || format(' [%s: permissões mudaram]', r.proname); end if;
    if not r.atributos_ok then v_falhas := v_falhas || format(' [%s: atributos mudaram]', r.proname); end if;
    if r.md5_novo <> r.md5_esperado then
      v_falhas := v_falhas || format(' [%s: corpo final difere do revisado (md5 normalizado LF %s)]', r.proname, r.md5_novo);
    end if;
  end loop;

  if (select count(*) from _larica_estado_funcoes_clientes) <> 2 then
    v_falhas := v_falhas || ' [estado anterior incompleto]';
  end if;

  if has_function_privilege('anon', 'public.list_customers(text,text,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_customers_overview()', 'EXECUTE') then
    v_falhas := v_falhas || ' [anon tem EXECUTE]';
  end if;

  if v_falhas <> '' then
    raise exception 'Correção desfeita — verificação pós-troca falhou:%', v_falhas;
  end if;

  drop table _larica_estado_funcoes_clientes;  -- tabela temporária desta sessão
end;
$verificacao$;
