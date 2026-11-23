-- Desfaz 20261124140000_delete_purchase_item.sql (itens já apagados não voltam).
drop function if exists public.delete_purchase_item(uuid);
