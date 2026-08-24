-- Etapa J8: evolui public.delete_purchase para permitir excluir uma compra
-- cujos lotes tiveram consumo em Produção, DESDE QUE esse consumo tenha
-- sido completamente revertido (Regra B, aprovada no diagnóstico J7).
--
-- Regra anterior (20260818240000_add_safe_purchase_delete.sql): bloqueava
-- se QUALQUER lot_movement diferente de 'purchase' existisse — mesmo
-- quando o consumo foi 100% revertido por edição/exclusão de Produção
-- (ex.: Palito/Batata/Contra Filé de teste, remaining_quantity já de
-- volta a initial_quantity, mas bloqueados só por causa do histórico
-- production_use+reversal no ledger).
--
-- Regra nova: permite excluir quando, para TODOS os lotes da compra:
--   1. nenhuma referência atual existe em skewer_batch_components/
--      side_batch_components/skewer_production_batches (checado
--      explicitamente, nunca deixado para a FK NO ACTION estourar cru);
--   2. nenhum lot_movement fora de purchase/production_use/reversal
--      existe (sale/waste/adjustment_in/adjustment_out bloqueiam mesmo
--      que o saldo matematicamente bata — são eventos reais distintos);
--   3. net de produção (production_use - reversal) = 0;
--   4. remaining_quantity = initial_quantity (segunda garantia,
--      independente do ledger).
-- Multi-lote: qualquer lote que falhe bloqueia a compra inteira, nunca
-- exclusão parcial. Mesma assinatura (uuid) — CREATE OR REPLACE preserva
-- o OID da função, grants reafirmados no final.

CREATE OR REPLACE FUNCTION public.delete_purchase(
  p_purchase_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_purchase public.purchases%rowtype;
  v_lot_ids uuid[];
  v_referenciado boolean;
  v_movimento_proibido boolean;
  v_nao_revertido boolean;
  v_lotes_removidos jsonb := '[]'::jsonb;
  v_lot public.lots%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir compras.';
  end if;

  -- Idempotência natural: uma segunda chamada, com a compra já excluída,
  -- simplesmente não encontra a linha e cai aqui.
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'Compra não encontrada.';
  end if;

  -- Descobre os lotes desta compra sempre pelo caminho purchase ->
  -- purchase_lines -> lots — nunca por dado enviado pelo client.
  select coalesce(array_agg(l.id), array[]::uuid[]) into v_lot_ids
    from public.lots l
    join public.purchase_lines pl on pl.id = l.purchase_line_id
   where pl.purchase_id = p_purchase_id;

  -- Trava todos os lotes envolvidos numa única passada, em ordem
  -- determinística (por id) — mesma disciplina de lock já usada em
  -- save_skewer_production_batch/save_side_production_batch/delete_*,
  -- evita deadlock com qualquer fluxo concorrente de Produção tentando
  -- travar os mesmos lotes em ordem diferente. Todas as leituras de
  -- saldo/movimentos/referências abaixo só acontecem depois deste lock.
  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  -- 1) Nenhuma referência atual em Produção pode sobrar para qualquer
  -- lote desta compra — checado explicitamente, nunca deixado para a FK
  -- (lots -> skewer_batch_components/side_batch_components/
  -- skewer_production_batches, todas NO ACTION) estourar cru.
  select exists (
    select 1 from public.skewer_batch_components where lot_id = any(v_lot_ids)
    union all
    select 1 from public.side_batch_components where lot_id = any(v_lot_ids)
    union all
    select 1 from public.skewer_production_batches where lot_id = any(v_lot_ids)
  ) into v_referenciado;

  if v_referenciado then
    raise exception 'Um dos lotes desta compra ainda está vinculado a uma produção.';
  end if;

  -- 2) Só production_use/reversal são tolerados além de purchase.
  -- sale/waste/adjustment_in/adjustment_out bloqueiam mesmo que o saldo
  -- matematicamente bata — representariam eventos reais distintos que
  -- não devem ser apagados silenciosamente.
  select exists (
    select 1 from public.lot_movements
     where lot_id = any(v_lot_ids)
       and movement_type not in ('purchase', 'production_use', 'reversal')
  ) into v_movimento_proibido;

  if v_movimento_proibido then
    raise exception 'Esta compra possui movimentações que não podem ser apagadas.';
  end if;

  -- 3) Net de produção (production_use - reversal) precisa ser
  -- exatamente zero em TODOS os lotes — multi-lote bloqueia inteiro se
  -- qualquer um falhar (nunca exclusão parcial).
  select exists (
    select 1
      from public.lot_movements
     where lot_id = any(v_lot_ids)
     group by lot_id
    having sum(case when movement_type = 'production_use' then quantity
                    when movement_type = 'reversal' then -quantity
                    else 0 end) <> 0
  ) into v_nao_revertido;

  if v_nao_revertido then
    raise exception 'Esta compra ainda possui consumo de estoque não revertido.';
  end if;

  -- 4) Segunda garantia, independente do ledger — o saldo físico precisa
  -- ter voltado exatamente à quantidade inicial.
  if exists (
    select 1 from public.lots
     where id = any(v_lot_ids)
       and remaining_quantity <> initial_quantity
  ) then
    raise exception 'O saldo de um dos lotes desta compra não foi totalmente restaurado.';
  end if;

  -- Exceção deliberada e estreita ao ledger append-only: só chega aqui
  -- quando a compra inteira está operacionalmente equivalente a "nunca
  -- aconteceu" (net=0, saldo=inicial, sem referência atual, sem
  -- movement_type fora de purchase/production_use/reversal). Nunca
  -- generalizar para exclusão de Produção (que corretamente usa
  -- 'reversal', preservando histórico) nem para consumo parcial.
  if array_length(v_lot_ids, 1) > 0 then
    for v_lot in select * from public.lots where id = any(v_lot_ids) order by id loop
      delete from public.lot_movements where lot_id = v_lot.id;
      v_lotes_removidos := v_lotes_removidos || jsonb_build_array(to_jsonb(v_lot));
    end loop;

    delete from public.lots where id = any(v_lot_ids);
  end if;

  delete from public.purchases where id = p_purchase_id;

  return jsonb_build_object(
    'deleted_purchase_id', p_purchase_id,
    'deleted_lots', v_lotes_removidos
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_purchase(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_purchase(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_purchase(uuid) TO authenticated;
