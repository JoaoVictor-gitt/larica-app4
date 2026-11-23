-- Excluir item de compra (área Compras → Itens e Estoque).
--
-- Regra (sem perda de histórico):
--   * item SEM nenhum histórico (nenhuma linha de compra, movimento de estoque, lote,
--     produção ou entrada de produção) e com saldo zero → é APAGADO de verdade
--     (os nomes alternativos caem junto, por cascata; produtos que o usavam como
--     matéria-prima de produção ficam sem essa ligação);
--   * item COM histórico ou saldo ≠ 0 → NÃO é apagado: fica INATIVO (some das
--     sugestões e do lançamento de compras, mas o histórico e o custo continuam).
-- O ingrediente / insumo / produto ligado ao item nunca é apagado.
-- Só administradores. Usa a mesma trava de estoque das compras/produções.

create or replace function public.delete_purchase_item(p_purchase_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.purchase_items%rowtype;
  v_tem_historico boolean;
  v_produtos integer;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir itens de compra.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select * into v_item from public.purchase_items where id = p_purchase_item_id for update;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;

  v_tem_historico :=
       exists (select 1 from public.purchase_lines where purchase_item_id = p_purchase_item_id)
    or exists (select 1 from public.inventory_movements where purchase_item_id = p_purchase_item_id)
    or exists (select 1 from public.lots where purchase_item_id = p_purchase_item_id)
    or exists (select 1 from public.lot_movements where purchase_item_id = p_purchase_item_id)
    or exists (select 1 from public.production_batches where raw_item_id = p_purchase_item_id)
    or exists (select 1 from public.production_batch_inputs where purchase_item_id = p_purchase_item_id);

  if v_tem_historico or coalesce(v_item.stock_quantity, 0) <> 0 then
    update public.purchase_items
       set active = false, updated_at = now(), updated_by = auth.uid()
     where id = p_purchase_item_id;
    return jsonb_build_object('deleted', false, 'deactivated', true, 'name', v_item.name);
  end if;

  update public.products set production_raw_item_id = null where production_raw_item_id = p_purchase_item_id;
  get diagnostics v_produtos = row_count;

  delete from public.purchase_items where id = p_purchase_item_id;
  return jsonb_build_object('deleted', true, 'deactivated', false, 'name', v_item.name, 'products_unlinked', v_produtos);
end;
$function$;

revoke all on function public.delete_purchase_item(uuid) from public, anon;
grant execute on function public.delete_purchase_item(uuid) to authenticated, service_role;
