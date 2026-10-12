-- =====================================================================================
-- ROLLBACK MANUAL — PARTE 1 de 2: SÓ remove a FK order_customer_links -> orders.
-- Desfaz o passo 2 (20261009100050). Depois: ..._down_2_objetos.sql (parte 2).
--
-- NÃO é migration (fica fora de supabase/migrations/) e NUNCA roda sozinho. Só executar
-- com autorização explícita: SQL Editor, `begin;` + este arquivo + `commit;` numa única
-- execução, fora do horário de pedidos.
--
-- Por que sozinha: remover a FK remove os triggers internos de integridade que ela criou
-- em public.orders, o que exige lock forte em orders. Trate como o PIOR CASO, ACCESS
-- EXCLUSIVE (bloqueia inclusive leituras: Kanban, impressão, relatórios) até o COMMIT —
-- o nível exato deve ser confirmado em ambiente isolado (pg_locks durante a execução).
-- Por isso o ALTER TABLE é o ÚNICO comando desta transação que toca orders; depois dele
-- só RESETs (instantâneos) e o COMMIT.
--   lock_timeout = 2s      -> limita só a ESPERA para obter o lock (se estourar, falha
--                             limpa, nada removido; tentar de novo depois).
--   statement_timeout = 5s -> limita a duração do próprio ALTER TABLE.
-- Nenhum dado é removido nesta parte: cadastros, vínculos e auditoria continuam.
-- =====================================================================================

DO $guard$
begin
  if to_regclass('public.order_customer_links') is null then
    raise exception 'Rollback parte 1 interrompido: public.order_customer_links não existe. Nada foi alterado.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_customer_links'::regclass
      and conname = 'order_customer_links_order_fk'
  ) then
    raise exception 'Rollback parte 1: a FK order_customer_links_order_fk não existe (já removida ou passo 2 nunca aplicado). Nada foi alterado — siga para a parte 2.';
  end if;
end;
$guard$;

SET lock_timeout = '2s';
SET statement_timeout = '5s';

ALTER TABLE public.order_customer_links DROP CONSTRAINT order_customer_links_order_fk;

RESET statement_timeout;
RESET lock_timeout;
-- COMMIT imediatamente.
