-- ROLLBACK de 20261124120000_finance_module.sql
-- Seguro apenas ANTES de lançar no Financeiro (trava abaixo). As categorias financeiras
-- (criadas na Fase B) permanecem.
begin;

do $$
begin
  if exists (select 1 from public.finance_entries) or exists (select 1 from public.finance_recurrences) then
    raise exception 'Rollback recusado: há lançamentos/recorrências no Financeiro. Reverter apagaria esses dados.';
  end if;
end $$;

drop function if exists public.get_finance_report(date, date);
drop function if exists public.save_finance_category(uuid, text, text, boolean);
drop function if exists public.generate_finance_recurrences(date);
drop function if exists public.save_finance_recurrence(jsonb);
drop function if exists public.cancel_finance_entry(uuid, text);
drop function if exists public.undo_finance_payment(uuid, text);
drop function if exists public.pay_finance_entry(uuid, date, text);
drop function if exists public.save_finance_entry(jsonb);
drop function if exists public._finance_validate(text, uuid, text, numeric, text, text, text);
drop table if exists public.finance_entry_events;
drop table if exists public.finance_entries;
drop table if exists public.finance_recurrences;

commit;
