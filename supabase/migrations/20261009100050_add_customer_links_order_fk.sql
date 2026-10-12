-- =====================================================================================
-- Cadastro persistente de clientes — FASE 1, PASSO 2 de 3: SÓ a FK
-- order_customer_links.order_id -> orders.id (ON DELETE CASCADE).
-- Pré-requisito: passo 1 (20261009100000_add_customer_registry.sql) aplicado.
-- Próximo: passo 3 (20261009100100_backfill_customer_registry.sql).
--
-- Por que sozinha: ADD FOREIGN KEY pega SHARE ROW EXCLUSIVE em public.orders, que
-- BLOQUEIA INSERT/UPDATE/DELETE de pedidos (novos pedidos, status, pagamento, impressão,
-- exclusão no Histórico) — leituras continuam. Esse lock fica retido até o COMMIT.
-- Nesta transação o ALTER TABLE é o ÚNICO comando que toca orders: depois dele só vêm
-- RESETs (instantâneos) e o COMMIT. Nada demorado fica entre o lock e o COMMIT.
--
-- Limites:
--   lock_timeout = 2s  -> limita a ESPERA para obter o lock (enquanto o pedido de lock
--                         espera, novas escritas em orders ficam na fila atrás dele). Se
--                         estourar, a transação falha limpa e nada é aplicado: tentar de
--                         novo em outro momento.
--   statement_timeout = 5s -> limita a duração do próprio ALTER TABLE (validação). A
--                         tabela de vínculos está VAZIA (guarda abaixo), então a validação
--                         é instantânea.
-- Não limita: o tempo entre o fim do ALTER e o COMMIT — por isso aplique o arquivo inteiro
-- de uma vez (SQL Editor: `begin;` + este arquivo + `commit;` numa única execução).
--
-- ON DELETE CASCADE: excluir o pedido no Histórico (comportamento atual) continua
-- funcionando e remove o vínculo; o trigger do passo 1 audita a remoção sem nunca impedir
-- a exclusão. Nenhum dado de orders é alterado.
-- =====================================================================================

DO $guard$
begin
  if to_regclass('public.order_customer_links') is null then
    raise exception 'FK interrompida: o passo 1 (20261009100000_add_customer_registry.sql) não foi aplicado. Nada foi alterado.';
  end if;

  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_customer_links'::regclass
      and conname = 'order_customer_links_order_fk'
  ) then
    raise exception 'FK interrompida: order_customer_links_order_fk já existe. Nada foi alterado.';
  end if;

  -- Tabela vazia = validação instantânea (o lock forte não fica retido por uma varredura).
  -- Sem a FK, a sincronização/backfill se recusam a criar vínculos, então ela deve estar vazia.
  if exists (select 1 from public.order_customer_links) then
    raise exception 'FK interrompida: order_customer_links não está vazia (inesperado antes do passo 2). Nada foi alterado — investigar antes de prosseguir.';
  end if;
end;
$guard$;

SET lock_timeout = '2s';
SET statement_timeout = '5s';

ALTER TABLE public.order_customer_links
  ADD CONSTRAINT order_customer_links_order_fk
  FOREIGN KEY (order_id) REFERENCES public.orders (id) ON DELETE CASCADE;

RESET statement_timeout;
RESET lock_timeout;
-- COMMIT imediatamente.
