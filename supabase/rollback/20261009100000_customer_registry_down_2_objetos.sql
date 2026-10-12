-- =====================================================================================
-- ROLLBACK MANUAL — PARTE 2 de 2: remove tabelas, triggers e funções do cadastro.
-- Desfaz os passos 1 e 3 (20261009100000 e 20261009100100). Pré-requisito: parte 1
-- (..._down_1_fk.sql) aplicada — sem a FK, nada aqui pega lock em public.orders.
--
-- NÃO é migration (fica fora de supabase/migrations/) e NUNCA roda sozinho. Só executar
-- com autorização explícita: SQL Editor, `begin;` + este arquivo + `commit;`.
--
-- O que remove: customers, order_customer_links, customer_link_audit (com seus triggers,
-- índices, sequência e constraints) e as 12 funções criadas no passo 1.
-- O que NÃO toca: orders, order_items, order_item_selections e todas as RPCs existentes
-- (criação de pedidos, status, pagamentos, impressão, WhatsApp). Nenhum dado de pedido se
-- perde.
--
-- ATENÇÃO: cadastros, vínculos e auditoria SÃO perdidos. Antes, exporte (SQL Editor ->
-- resultado -> Export CSV) as três consultas abaixo:
--
--   select * from public.customers order by created_at;
--   select * from public.order_customer_links order by linked_at;
--   select * from public.customer_link_audit order by id;
-- =====================================================================================

-- Guarda: objetos existem, a FK para orders já foi removida (parte 1) e nada fora do
-- cadastro depende das tabelas (views/regras) — senão aborta sem remover nada.
DO $guard$
declare
  v_faltando text;
  v_dependentes text;
begin
  select string_agg(nome, ', ')
    into v_faltando
  from unnest(array['public.customers', 'public.order_customer_links', 'public.customer_link_audit']) as nome
  where to_regclass(nome) is null;

  if v_faltando is not null then
    raise exception 'Rollback parte 2 interrompido: objetos não encontrados: %. Nada foi removido.', v_faltando;
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_customer_links'::regclass
      and confrelid = 'public.orders'::regclass
  ) then
    raise exception 'Rollback parte 2 interrompido: ainda existe FK de order_customer_links para orders. Aplique a parte 1 antes. Nada foi removido.';
  end if;

  select string_agg(distinct format('%s (%s)', d.classid::regclass, d.objid), ', ')
    into v_dependentes
  from pg_depend d
  where d.refobjid in ('public.customers'::regclass, 'public.order_customer_links'::regclass, 'public.customer_link_audit'::regclass)
    and d.deptype = 'n'
    and d.classid = 'pg_rewrite'::regclass;

  if v_dependentes is not null then
    raise exception 'Rollback parte 2 interrompido: existem views/regras dependentes do cadastro: %. Nada foi removido.', v_dependentes;
  end if;
end;
$guard$;

-- Nenhum comando abaixo envolve orders; o limite só evita espera indefinida (ex.: uma
-- sincronização da página em andamento segurando locks nas tabelas do cadastro).
SET lock_timeout = '5s';

-- RPCs administrativas
DROP FUNCTION public.get_customer_detail(uuid, uuid, integer, integer);
DROP FUNCTION public.list_customers(text, text, text, integer, integer);
DROP FUNCTION public.get_customers_overview();
DROP FUNCTION public.sync_phone_customer_links(integer);

-- Auxiliares internas
DROP FUNCTION public._customer_top_products_json(uuid[]);
DROP FUNCTION public._customer_orders_json(uuid[]);
DROP FUNCTION public._customer_registry_reconcile_deleted_orders(integer);
DROP FUNCTION public._customer_registry_link_by_phone(text, integer);

-- Tabelas (DROP TABLE remove triggers, índices, sequência e constraints; não dispara
-- triggers de linha, então o trigger de imutabilidade da auditoria não impede o rollback).
-- order_customer_links referencia customers, então customers sai por último.
DROP TABLE public.customer_link_audit;
DROP TABLE public.order_customer_links;
DROP TABLE public.customers;

-- Funções de trigger e normalização (já sem objetos que as usem)
DROP FUNCTION public._customer_links_audit_on_delete();
DROP FUNCTION public._customer_link_audit_immutable();
DROP FUNCTION public.normalize_customer_phone(text);
DROP FUNCTION public.normalize_customer_name(text);

RESET lock_timeout;
