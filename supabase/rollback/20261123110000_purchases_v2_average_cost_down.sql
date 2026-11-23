-- ROLLBACK de 20261123110000_purchases_v2_average_cost.sql
-- Seguro apenas ANTES de registrar compras no fluxo novo (a trava abaixo impede perda de dados).
-- Não restaura os dados de teste apagados (decisão do usuário). O bucket 'purchase-documents'
-- e a extensão pg_trgm ficam (inofensivos; o Supabase não permite apagar bucket por SQL).

begin;

do $$
begin
  if exists (select 1 from public.purchases) then
    raise exception 'Rollback recusado: há compras registradas no fluxo novo. Reverter apagaria VAT, custos e estornos.';
  end if;
end $$;

-- RPCs antigas de volta ao app
grant execute on function public.save_purchase(uuid, uuid, date, text, text, jsonb) to authenticated;
grant execute on function public.delete_purchase(uuid) to authenticated;
grant execute on function public.create_lot_from_purchase_line(uuid, date) to authenticated;
grant execute on function public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) to authenticated;

drop function if exists public.confirm_purchase(jsonb);
drop function if exists public.cancel_purchase(uuid, text);
drop function if exists public.suggest_purchase_item_matches(text[]);
drop function if exists public.save_purchase_item_alias(uuid, text);
drop function if exists public.delete_purchase_item_alias(uuid);
drop function if exists public.set_purchase_item_finance_category(uuid, uuid);
drop function if exists public.mark_purchase_item_reviewed(uuid);
drop function if exists public.register_purchase_document(text, text, text, integer);
drop function if exists public.record_purchase_document_ocr(uuid, text, jsonb, text, text);
drop function if exists public._inventory_apply(uuid, numeric, numeric, text, text, uuid, text, boolean);
drop function if exists public._product_purchase_apply(uuid, integer, numeric, text, uuid, text);

drop policy if exists purchase_documents_admin_select on storage.objects;
drop policy if exists purchase_documents_admin_insert on storage.objects;
drop policy if exists purchase_documents_admin_delete on storage.objects;

drop trigger if exists purchase_items_guard_stock_changes on public.purchase_items;
drop function if exists public._purchase_items_guard_stock_changes();

drop table if exists public.inventory_movements;
drop table if exists public.product_cost_history;
drop function if exists public._ledger_immutable();
drop table if exists public.purchase_documents;
drop table if exists public.purchase_item_aliases;
drop index if exists public.ux_stock_movements_purchase_source;

-- Linhas: volta ao formato antigo
alter table public.purchase_lines
  drop constraint if exists purchase_lines_line_type_valido,
  drop constraint if exists purchase_lines_estoque_coerente,
  drop constraint if exists purchase_lines_despesa_coerente,
  drop constraint if exists purchase_lines_vat_rate_valido,
  drop constraint if exists purchase_lines_valores_nao_negativos,
  drop constraint if exists purchase_lines_desconto_ate_bruto;
alter table public.purchase_lines drop column if exists unit_cost_base;
alter table public.purchase_lines
  drop column if exists line_order,
  drop column if exists line_type,
  drop column if exists raw_description,
  drop column if exists unit_price,
  drop column if exists gross_amount,
  drop column if exists discount_amount,
  drop column if exists header_discount_share,
  drop column if exists net_amount,
  drop column if exists vat_rate,
  drop column if exists vat_amount,
  drop column if exists cost_value,
  drop column if exists finance_category_id;
alter table public.purchase_lines add column unit_cost_base numeric(16,8) generated always as (total_price / base_quantity) stored;
alter table public.purchase_lines alter column purchase_item_id set not null;

-- Compras
alter table public.purchases
  drop constraint if exists purchases_status_valido,
  drop constraint if exists purchases_source_valido,
  drop constraint if exists purchases_totais_nao_negativos,
  drop constraint if exists purchases_arredondamento_limite,
  drop constraint if exists purchases_cancelamento_coerente,
  drop constraint if exists purchases_client_request_unico;
drop index if exists public.idx_purchases_status;
alter table public.purchases
  drop column if exists status,
  drop column if exists source,
  drop column if exists vat_recoverable,
  drop column if exists gross_total,
  drop column if exists discount_total,
  drop column if exists header_discount,
  drop column if exists net_total,
  drop column if exists vat_total,
  drop column if exists total_paid,
  drop column if exists rounding_adjustment,
  drop column if exists client_request_id,
  drop column if exists cancelled_at,
  drop column if exists cancelled_by,
  drop column if exists cancel_reason;

-- Itens de compra
alter table public.purchase_items drop constraint if exists purchase_items_avg_cost_nao_negativo;
alter table public.purchase_items
  drop column if exists stock_quantity,
  drop column if exists avg_cost,
  drop column if exists avg_cost_updated_at,
  drop column if exists finance_category_id;

drop table if exists public.finance_categories;
drop function if exists public.normalize_purchase_text(text);

-- Contra Filé volta a apontar para o produto "Carne" (como estava)
update public.purchase_items
   set product_id = (select id from public.products where name = 'Carne' limit 1), updated_at = now()
 where normalized_name = 'contra file' and product_id is null;

commit;
