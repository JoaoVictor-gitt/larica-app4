-- ROLLBACK de 20261124130000_dashboard_overview.sql (só leitura; seguro a qualquer momento)
begin;
drop function if exists public.get_dashboard(date, date);
commit;
