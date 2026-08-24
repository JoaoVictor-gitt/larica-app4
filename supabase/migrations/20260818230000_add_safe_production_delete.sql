-- Integração de Lotes de Compra com Produção — ETAPA G3 (exclusão segura
-- de produção com reversal).
--
-- Cria delete_skewer_production_batch(p_batch_id)/
-- delete_side_production_batch(p_batch_id) — única porta de exclusão de um
-- lote de produção a partir de agora. Antes de excluir, cada RPC calcula o
-- consumo líquido ATUAL de cada lote envolvido exclusivamente a partir do
-- ledger (public.lot_movements — nunca dos componentes atuais), restaura
-- esse saldo lote a lote (movement_type='reversal', sempre positivo) e só
-- então exclui o batch (cascade remove os componentes; lot_movements
-- nunca é tocado, pois lot_movements.source_id não tem FK — o ledger de
-- auditoria fica preservado mesmo depois do batch deixar de existir).
-- Idempotente por natureza: uma segunda chamada, com o batch já excluído,
-- simplesmente não encontra a linha e falha com mensagem clara — nenhum
-- marcador de exclusão foi adicionado.
--
-- Fecha o GRANT DELETE que authenticated ainda tinha nas duas tabelas de
-- batch desde a criação inicial (Etapas 1/A — só INSERT/UPDATE haviam
-- sido revogados até agora, nas Etapas 3B/B) — confirmado por auditoria,
-- não uma suposição.
--
-- NÃO altera schema (lot_id/lots/lot_movements já existem desde G1).
-- NÃO altera save_skewer_production_batch/save_side_production_batch (G2,
-- já executadas e validadas) nem apply_skewer_production_cost/
-- apply_side_production_cost (excluir batch não desfaz custo já aplicado
-- em product_costs, decisão já confirmada no diagnóstico). NÃO altera
-- Compras (save_purchase, finalize_purchase_item,
-- create_lot_from_purchase_line, compras.html/js/css) nem Pedidos
-- (create_customer_order, products.stock_quantity, stock_movements,
-- checkout). NÃO altera UI (producao.html/producao.js/producao.css) — os
-- handlers existentes continuam chamando os mesmos nomes de função do
-- service, só a implementação interna dela muda. Migrations já executadas
-- não são editadas.

-- =============================================================
-- 1. delete_skewer_production_batch
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_skewer_production_batch(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_batch public.skewer_production_batches%rowtype;
  v_lot_ids uuid[];
  v_rec record;
  v_lot public.lots%rowtype;
  v_movement public.lot_movements%rowtype;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_reversed_lots jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir lotes de produção.';
  end if;

  -- Idempotência natural: uma segunda chamada depois do DELETE já
  -- concluído simplesmente não encontra a linha e cai aqui.
  select * into v_batch from public.skewer_production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote de produção não encontrado.';
  end if;

  -- Consumo líquido ATUAL, exclusivamente do ledger — nunca dos
  -- componentes atuais (mesma disciplina já validada na G2).
  select coalesce(array_agg(lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id
        from public.lot_movements
       where source_type = 'skewer_production'
         and source_id = p_batch_id
         and lot_id is not null
         and movement_type in ('production_use', 'reversal')
       group by lot_id
      having sum(case when movement_type = 'production_use' then quantity
                       when movement_type = 'reversal' then -quantity
                       else 0 end) > 0
    ) x;

  -- Trava todos os lotes com saldo líquido a devolver, em ordem
  -- determinística — mesma ordem batch-primeiro/lots-depois já usada na
  -- G2, evita deadlock com save/edição concorrente do mesmo batch.
  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  for v_rec in
    select lot_id,
           sum(case when movement_type = 'production_use' then quantity
                    when movement_type = 'reversal' then -quantity
                    else 0 end) as net
      from public.lot_movements
     where source_type = 'skewer_production'
       and source_id = p_batch_id
       and lot_id is not null
       and movement_type in ('production_use', 'reversal')
     group by lot_id
    having sum(case when movement_type = 'production_use' then quantity
                     when movement_type = 'reversal' then -quantity
                     else 0 end) > 0
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    v_balance_before := v_lot.remaining_quantity;
    v_balance_after := v_lot.remaining_quantity + v_rec.net;

    -- Defesa: ledger/saldo nunca deveriam permitir isso, mas se
    -- permitissem, bloqueia a exclusão inteira em vez de corromper o lote.
    if v_balance_after > v_lot.initial_quantity then
      raise exception 'A reversão ultrapassaria a quantidade inicial do lote.';
    end if;

    v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

    update public.lots set
      remaining_quantity = v_balance_after,
      status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
    where id = v_lot.id
    returning * into v_lot;

    insert into public.lot_movements (
      lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
      source_type, source_id, created_by
    ) values (
      v_lot.id, v_lot.purchase_item_id, 'reversal', v_rec.net, v_balance_before, v_balance_after,
      'skewer_production', p_batch_id, auth.uid()
    )
    returning * into v_movement;

    v_reversed_lots := v_reversed_lots || jsonb_build_array(to_jsonb(v_lot));
    v_movements := v_movements || jsonb_build_array(to_jsonb(v_movement));
  end loop;

  -- Só agora exclui o batch — cascade remove os componentes; lot_movements
  -- nunca é tocado (sem FK, confirmado no diagnóstico), ledger preservado.
  delete from public.skewer_production_batches where id = p_batch_id;

  return jsonb_build_object(
    'deleted_batch_id', p_batch_id,
    'reversed_lots', v_reversed_lots,
    'movements', v_movements
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_skewer_production_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_skewer_production_batch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_skewer_production_batch(uuid) TO authenticated;

-- =============================================================
-- 2. delete_side_production_batch — mesmo tratamento exato.
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_side_production_batch(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_batch public.side_production_batches%rowtype;
  v_lot_ids uuid[];
  v_rec record;
  v_lot public.lots%rowtype;
  v_movement public.lot_movements%rowtype;
  v_balance_before numeric;
  v_balance_after numeric;
  v_new_status text;
  v_reversed_lots jsonb := '[]'::jsonb;
  v_movements jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir lotes de acompanhamento.';
  end if;

  select * into v_batch from public.side_production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Lote de acompanhamento não encontrado.';
  end if;

  select coalesce(array_agg(lot_id), array[]::uuid[]) into v_lot_ids
    from (
      select lot_id
        from public.lot_movements
       where source_type = 'side_production'
         and source_id = p_batch_id
         and lot_id is not null
         and movement_type in ('production_use', 'reversal')
       group by lot_id
      having sum(case when movement_type = 'production_use' then quantity
                       when movement_type = 'reversal' then -quantity
                       else 0 end) > 0
    ) x;

  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  for v_rec in
    select lot_id,
           sum(case when movement_type = 'production_use' then quantity
                    when movement_type = 'reversal' then -quantity
                    else 0 end) as net
      from public.lot_movements
     where source_type = 'side_production'
       and source_id = p_batch_id
       and lot_id is not null
       and movement_type in ('production_use', 'reversal')
     group by lot_id
    having sum(case when movement_type = 'production_use' then quantity
                     when movement_type = 'reversal' then -quantity
                     else 0 end) > 0
  loop
    select * into v_lot from public.lots where id = v_rec.lot_id;

    v_balance_before := v_lot.remaining_quantity;
    v_balance_after := v_lot.remaining_quantity + v_rec.net;

    if v_balance_after > v_lot.initial_quantity then
      raise exception 'A reversão ultrapassaria a quantidade inicial do lote.';
    end if;

    v_new_status := case when v_balance_after > 0 then 'available' else 'depleted' end;

    update public.lots set
      remaining_quantity = v_balance_after,
      status = v_new_status,
      updated_at = now(),
      updated_by = auth.uid()
    where id = v_lot.id
    returning * into v_lot;

    insert into public.lot_movements (
      lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
      source_type, source_id, created_by
    ) values (
      v_lot.id, v_lot.purchase_item_id, 'reversal', v_rec.net, v_balance_before, v_balance_after,
      'side_production', p_batch_id, auth.uid()
    )
    returning * into v_movement;

    v_reversed_lots := v_reversed_lots || jsonb_build_array(to_jsonb(v_lot));
    v_movements := v_movements || jsonb_build_array(to_jsonb(v_movement));
  end loop;

  delete from public.side_production_batches where id = p_batch_id;

  return jsonb_build_object(
    'deleted_batch_id', p_batch_id,
    'reversed_lots', v_reversed_lots,
    'movements', v_movements
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.delete_side_production_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_side_production_batch(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_side_production_batch(uuid) TO authenticated;

-- =============================================================
-- 3. Fecha o DELETE direto — authenticated ainda tinha esse GRANT nas
-- duas tabelas de batch desde a criação inicial (Etapas 1/A); só
-- INSERT/UPDATE haviam sido revogados até agora (Etapas 3B/B). A partir
-- daqui, excluir um batch exige as RPCs acima. Cascade de
-- ..._batch_components continua funcionando normalmente porque roda
-- dentro da própria RPC SECURITY DEFINER. Policies de DELETE (is_admin())
-- permanecem como defesa/documentação, sem efeito prático pós-REVOKE.
-- =============================================================

REVOKE DELETE ON TABLE public.skewer_production_batches FROM authenticated;
REVOKE DELETE ON TABLE public.side_production_batches FROM authenticated;

-- =============================================================
-- FIM — ETAPA G3
-- =============================================================
--
-- Nenhuma mudança de schema. save_skewer_production_batch/
-- save_side_production_batch (G2), apply_skewer_production_cost/
-- apply_side_production_cost, save_purchase, finalize_purchase_item,
-- create_lot_from_purchase_line permanecem exatamente como estavam.
-- Nenhuma UI alterada — só js/services/skewer-production-service.js/
-- side-production-service.js trocam a implementação interna de
-- excluirLoteEspetosNoSupabase/excluirLoteAcompanhamentoNoSupabase (mesma
-- assinatura/retorno), sem exigir nenhuma mudança em producao.js.
