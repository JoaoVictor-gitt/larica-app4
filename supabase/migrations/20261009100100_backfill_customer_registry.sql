-- =====================================================================================
-- Cadastro persistente de clientes — FASE 1, PASSO 3 de 3: BACKFILL.
-- Pré-requisitos: passo 1 (20261009100000_add_customer_registry.sql) e passo 2
-- (20261009100050_add_customer_links_order_fk.sql) aplicados.
--
-- Vincula os pedidos existentes que têm nome + telefone irlandês válido (todos os status)
-- a cadastros (nome normalizado + telefone normalizado), criando os cadastros que faltam.
-- Pedidos sem telefone continuam sem vínculo ("não cadastrados") — nunca são vinculados
-- pelo nome. Usa a MESMA função da sincronização automática (regra única). Nunca escreve
-- em orders (nenhum valor, nome, telefone ou status muda).
--
-- Locks (retidos até o COMMIT — lock_timeout NÃO limita essa duração):
--   - orders: ROW SHARE (tabela) + FOR KEY SHARE nas linhas candidatas, com SKIP LOCKED.
--     Compatível com INSERT de pedidos novos e com UPDATE de status/pagamento/impressão
--     (FOR NO KEY UPDATE). Só uma EXCLUSÃO no Histórico de um pedido candidato espera até
--     o COMMIT; pedidos já em exclusão são pulados (SKIP LOCKED) e ficam para depois.
--   - FK: o INSERT de cada vínculo checa a FK com FOR KEY SHARE na mesma linha (já travada).
--   - Advisory lock 'larica.customer_registry': serializa com a sincronização da página.
-- Duração: ~1 SELECT + 2 INSERTs em lote sobre algumas centenas de linhas (milissegundos).
-- O que cada limite cobre — e o que NÃO cobre:
--   statement_timeout = 30s -> limita a duração do comando SELECT do backfill (cada
--       comando, separadamente). Se estourar, o comando falha, a transação é desfeita e os
--       locks são liberados (nada fica parcial). NÃO é um limite absoluto para a transação:
--       não cobre o tempo antes do comando nem o tempo entre o fim dele e o COMMIT.
--   lock_timeout = 5s -> limita só a ESPERA para obter cada lock (ex.: DDL pesado em orders
--       ou sincronização em andamento). Não limita quanto tempo os locks obtidos ficam
--       retidos — eles ficam até o COMMIT/ROLLBACK.
-- Portanto o tempo total de retenção dos locks de linha (FOR KEY SHARE nos pedidos com
-- telefone) depende de o COMMIT vir imediatamente: execute `begin;` + este arquivo +
-- `commit;` numa ÚNICA execução, sem pausa e sem deixar a transação aberta no editor.
-- Se a sessão travar no meio, a transação fica aberta segurando esses locks até ser
-- encerrada — confira com a P5f e, se preciso, encerre a sessão (o backfill é desfeito
-- por inteiro e pode ser repetido).
--
-- Idempotente: pode ser executado de novo sem efeito (só considera pedidos sem nenhuma
-- linha em order_customer_links). Pedidos que chegarem depois são vinculados pela
-- sincronização da página Clientes.
--
-- Aplicação manual no SQL Editor: `begin;` + este arquivo + `commit;` numa única execução.
-- =====================================================================================

DO $guard$
begin
  if to_regclass('public.order_customer_links') is null
     or to_regprocedure('public._customer_registry_link_by_phone(text,integer)') is null then
    raise exception 'Backfill interrompido: o passo 1 (20261009100000_add_customer_registry.sql) não foi aplicado. Nada foi alterado.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_customer_links'::regclass
      and conname = 'order_customer_links_order_fk'
  ) then
    raise exception 'Backfill interrompido: a FK order_customer_links_order_fk não existe (aplique o passo 2). Nada foi alterado.';
  end if;
end;
$guard$;

SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Resultado: {"linked": N, "customers_created": M, "remaining": R, "batch_id": ...}
-- Esperado: linked = vinculos_previstos_todos_status e customers_created =
-- cadastros_previstos (pré-validação P3); remaining = 0 (ou o número de pedidos pulados por
-- estarem sendo excluídos naquele instante).
SELECT public._customer_registry_link_by_phone('backfill', NULL);

RESET statement_timeout;
RESET lock_timeout;
-- COMMIT imediatamente.
