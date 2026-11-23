-- =====================================================================================
-- FASE E — Financeiro: lançamentos (despesas, receitas, aportes, retiradas), recorrências,
-- contas a pagar/receber e relatório gerencial (DRE, fluxo de caixa, CMV, rentabilidade).
-- -------------------------------------------------------------------------------------
-- Regras que evitam dupla contagem:
--   * Compra de ESTOQUE não é despesa no resultado: vira CMV quando o produto é vendido.
--     Só as linhas de DESPESA das compras entram nas despesas (pelo custo: líquido + VAT
--     não recuperável). VAT recuperável fica fora do resultado.
--   * No caixa, a compra inteira (total pago) é saída na data da compra.
--   * Aporte/retirada de sócio não entram no resultado (DRE), só no caixa.
--   * Pedido cancelado não é faturamento.
-- CMV por consumo: custo gravado na venda (calculado) > custo atual do produto (estimado) >
-- sem dados (fica de fora e a cobertura é informada). Combo = soma dos componentes.
-- Datas no fuso do negócio (business_settings.timezone).
-- Rollback: supabase/rollback/20261124120000_finance_module_down.sql
-- =====================================================================================

begin;

-- ------------------------------------------------------------------ 1. recorrências
create table public.finance_recurrences (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  category_id uuid not null references public.finance_categories(id),
  description text not null,
  amount numeric(14,2) not null,
  frequency text not null,
  start_date date not null,
  end_date date,
  due_offset_days integer not null default 0,
  expense_type text,
  cost_nature text,
  payment_method text,
  notes text,
  active boolean not null default true,
  client_request_id uuid unique,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  constraint finance_recurrences_kind_valido check (kind in ('expense', 'revenue', 'owner_contribution', 'owner_withdrawal')),
  constraint finance_recurrences_valor_positivo check (amount > 0),
  constraint finance_recurrences_frequencia_valida check (frequency in ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  constraint finance_recurrences_periodo_coerente check (end_date is null or end_date >= start_date),
  constraint finance_recurrences_prazo_valido check (due_offset_days between 0 and 120),
  constraint finance_recurrences_descricao check (length(btrim(description)) > 0)
);

-- ------------------------------------------------------------------ 2. lançamentos
create table public.finance_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  category_id uuid not null references public.finance_categories(id),
  description text not null,
  amount numeric(14,2) not null,
  competence_date date not null,
  due_date date not null,
  paid_at date,
  status text not null default 'pending',
  payment_method text,
  expense_type text,
  cost_nature text,
  notes text,
  document_id uuid references public.purchase_documents(id),
  recurrence_id uuid references public.finance_recurrences(id),
  client_request_id uuid unique,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint finance_entries_kind_valido check (kind in ('expense', 'revenue', 'owner_contribution', 'owner_withdrawal')),
  constraint finance_entries_valor_positivo check (amount > 0),
  constraint finance_entries_status_valido check (status in ('pending', 'paid', 'cancelled')),
  constraint finance_entries_pago_coerente check ((status = 'paid') = (paid_at is not null)),
  constraint finance_entries_cancelado_coerente check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint finance_entries_metodo_valido check (payment_method is null or payment_method in ('cash', 'card', 'bank_transfer', 'revolut', 'direct_debit', 'other')),
  constraint finance_entries_tipo_despesa check (expense_type is null or (kind = 'expense' and expense_type in ('fixed', 'variable'))),
  constraint finance_entries_natureza check (cost_nature is null or (kind = 'expense' and cost_nature in ('direct', 'indirect'))),
  constraint finance_entries_descricao check (length(btrim(description)) > 0)
);
create index idx_finance_entries_competence on public.finance_entries (competence_date);
create index idx_finance_entries_due on public.finance_entries (due_date) where status = 'pending';
create index idx_finance_entries_paid on public.finance_entries (paid_at) where status = 'paid';
-- A mesma recorrência nunca gera dois lançamentos para a mesma competência.
create unique index ux_finance_entries_recorrencia on public.finance_entries (recurrence_id, competence_date) where recurrence_id is not null;

create table public.finance_entry_events (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.finance_entries(id) on delete cascade,
  action text not null,
  details jsonb,
  actor uuid default auth.uid(),
  acted_at timestamptz not null default now(),
  constraint finance_entry_events_action check (action in ('created', 'updated', 'paid', 'payment_undone', 'cancelled'))
);
create index idx_finance_entry_events_entry on public.finance_entry_events (entry_id, acted_at);
create trigger finance_entry_events_immutable before update or delete on public.finance_entry_events
  for each row execute function public._ledger_immutable();

-- ------------------------------------------------------------------ 3. validação comum
create or replace function public._finance_validate(
  p_kind text, p_category_id uuid, p_description text, p_amount numeric, p_payment_method text, p_expense_type text, p_cost_nature text)
returns void
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_cat_kind text;
begin
  if p_kind not in ('expense', 'revenue', 'owner_contribution', 'owner_withdrawal') then
    raise exception 'Tipo de lançamento inválido.';
  end if;
  select kind into v_cat_kind from public.finance_categories where id = p_category_id and active;
  if v_cat_kind is null then
    raise exception 'Escolha uma categoria válida.';
  end if;
  if v_cat_kind <> p_kind then
    raise exception 'A categoria escolhida não é deste tipo de lançamento.';
  end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null then
    raise exception 'Informe a descrição.';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Informe um valor maior que zero.';
  end if;
  if p_payment_method is not null and p_payment_method not in ('cash', 'card', 'bank_transfer', 'revolut', 'direct_debit', 'other') then
    raise exception 'Forma de pagamento inválida.';
  end if;
  if p_kind <> 'expense' and (p_expense_type is not null or p_cost_nature is not null) then
    raise exception 'Classificação fixa/variável e direta/indireta vale só para despesas.';
  end if;
  if p_expense_type is not null and p_expense_type not in ('fixed', 'variable') then
    raise exception 'Classificação inválida.';
  end if;
  if p_cost_nature is not null and p_cost_nature not in ('direct', 'indirect') then
    raise exception 'Classificação inválida.';
  end if;
end;
$function$;

-- ------------------------------------------------------------------ 4. criar/editar lançamento
-- p_payload: { id?, client_request_id (criação), kind, category_id, description, amount,
--   competence_date, due_date, paid_at?, payment_method?, expense_type?, cost_nature?, notes?, document_id? }
-- Criar com paid_at = já pago. Editar só enquanto pendente (pago: desfazer pagamento antes).
create or replace function public.save_finance_entry(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_req uuid;
  v_entry public.finance_entries%rowtype;
  v_kind text := p_payload->>'kind';
  v_cat uuid := nullif(p_payload->>'category_id', '')::uuid;
  v_desc text := left(btrim(regexp_replace(coalesce(p_payload->>'description', ''), '\s+', ' ', 'g')), 200);
  v_amount numeric := round((p_payload->>'amount')::numeric, 2);
  v_comp date;
  v_due date;
  v_paid date;
  v_method text := nullif(p_payload->>'payment_method', '');
  v_exp text := nullif(p_payload->>'expense_type', '');
  v_nat text := nullif(p_payload->>'cost_nature', '');
  v_doc uuid := nullif(p_payload->>'document_id', '')::uuid;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem lançar no Financeiro.';
  end if;
  perform public._finance_validate(v_kind, v_cat, v_desc, v_amount, v_method, v_exp, v_nat);
  begin
    v_comp := (p_payload->>'competence_date')::date;
    v_due := coalesce(nullif(p_payload->>'due_date', '')::date, v_comp);
    v_paid := nullif(p_payload->>'paid_at', '')::date;
  exception when others then
    raise exception 'Data inválida.';
  end;
  if v_comp is null then
    raise exception 'Informe a data de competência.';
  end if;
  if v_comp < date '2020-01-01' or v_due < date '2020-01-01' or v_comp > current_date + 800 or v_due > current_date + 800 then
    raise exception 'Data fora do intervalo permitido.';
  end if;
  if v_paid is not null and v_paid > current_date + 1 then
    raise exception 'A data de pagamento não pode ser no futuro.';
  end if;
  if v_doc is not null and not exists (select 1 from public.purchase_documents where id = v_doc) then
    raise exception 'Documento não encontrado.';
  end if;

  if v_id is null then
    begin
      v_req := (p_payload->>'client_request_id')::uuid;
    exception when others then
      raise exception 'Identificador da operação inválido.';
    end;
    if v_req is null then
      raise exception 'Identificador da operação ausente.';
    end if;
    select * into v_entry from public.finance_entries where client_request_id = v_req;
    if found then
      return jsonb_build_object('duplicate', true, 'entry', to_jsonb(v_entry));
    end if;
    insert into public.finance_entries (
      kind, category_id, description, amount, competence_date, due_date, paid_at, status, payment_method,
      expense_type, cost_nature, notes, document_id, client_request_id, created_by, updated_by
    ) values (
      v_kind, v_cat, v_desc, v_amount, v_comp, v_due, v_paid, case when v_paid is null then 'pending' else 'paid' end, v_method,
      v_exp, v_nat, nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), ''), v_doc, v_req, auth.uid(), auth.uid()
    )
    returning * into v_entry;
    insert into public.finance_entry_events (entry_id, action, details) values (v_entry.id, 'created', to_jsonb(v_entry));
    if v_paid is not null then
      insert into public.finance_entry_events (entry_id, action, details) values (v_entry.id, 'paid', jsonb_build_object('paid_at', v_paid, 'payment_method', v_method));
    end if;
    return jsonb_build_object('duplicate', false, 'entry', to_jsonb(v_entry));
  end if;

  select * into v_entry from public.finance_entries where id = v_id for update;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  if v_entry.status <> 'pending' then
    raise exception 'Só é possível editar lançamentos pendentes. %', case when v_entry.status = 'paid' then 'Desfaça o pagamento antes.' else 'Este lançamento foi cancelado.' end;
  end if;
  if v_paid is not null then
    raise exception 'Use "Marcar como pago" para registrar o pagamento.';
  end if;
  update public.finance_entries
     set kind = v_kind, category_id = v_cat, description = v_desc, amount = v_amount, competence_date = v_comp,
         due_date = v_due, payment_method = v_method, expense_type = v_exp, cost_nature = v_nat,
         notes = nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), ''), document_id = v_doc,
         updated_at = now(), updated_by = auth.uid()
   where id = v_id
  returning * into v_entry;
  insert into public.finance_entry_events (entry_id, action, details) values (v_entry.id, 'updated', to_jsonb(v_entry));
  return jsonb_build_object('duplicate', false, 'entry', to_jsonb(v_entry));
end;
$function$;

-- ------------------------------------------------------------------ 5. pagar / desfazer pagamento / cancelar
create or replace function public.pay_finance_entry(p_id uuid, p_paid_at date, p_payment_method text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_entry public.finance_entries%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem registrar pagamentos.';
  end if;
  if p_paid_at is null or p_paid_at > current_date + 1 or p_paid_at < date '2020-01-01' then
    raise exception 'Data de pagamento inválida.';
  end if;
  if p_payment_method is not null and p_payment_method not in ('cash', 'card', 'bank_transfer', 'revolut', 'direct_debit', 'other') then
    raise exception 'Forma de pagamento inválida.';
  end if;
  select * into v_entry from public.finance_entries where id = p_id for update;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  if v_entry.status = 'paid' then
    return jsonb_build_object('already', true, 'entry', to_jsonb(v_entry));
  end if;
  if v_entry.status = 'cancelled' then
    raise exception 'Lançamento cancelado não pode ser pago.';
  end if;
  update public.finance_entries
     set status = 'paid', paid_at = p_paid_at, payment_method = coalesce(p_payment_method, payment_method), updated_at = now(), updated_by = auth.uid()
   where id = p_id
  returning * into v_entry;
  insert into public.finance_entry_events (entry_id, action, details) values (p_id, 'paid', jsonb_build_object('paid_at', p_paid_at, 'payment_method', v_entry.payment_method));
  return jsonb_build_object('already', false, 'entry', to_jsonb(v_entry));
end;
$function$;

create or replace function public.undo_finance_payment(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_entry public.finance_entries%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar pagamentos.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo.';
  end if;
  select * into v_entry from public.finance_entries where id = p_id for update;
  if not found or v_entry.status <> 'paid' then
    raise exception 'Este lançamento não está pago.';
  end if;
  update public.finance_entries set status = 'pending', paid_at = null, updated_at = now(), updated_by = auth.uid()
   where id = p_id returning * into v_entry;
  insert into public.finance_entry_events (entry_id, action, details) values (p_id, 'payment_undone', jsonb_build_object('reason', left(v_reason, 500)));
  return to_jsonb(v_entry);
end;
$function$;

create or replace function public.cancel_finance_entry(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_entry public.finance_entries%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem cancelar lançamentos.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo do cancelamento.';
  end if;
  select * into v_entry from public.finance_entries where id = p_id for update;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  if v_entry.status = 'cancelled' then
    return to_jsonb(v_entry);
  end if;
  if v_entry.status = 'paid' then
    raise exception 'Lançamento pago: desfaça o pagamento antes de cancelar.';
  end if;
  update public.finance_entries set status = 'cancelled', cancelled_at = now(), cancel_reason = left(v_reason, 500), updated_at = now(), updated_by = auth.uid()
   where id = p_id returning * into v_entry;
  insert into public.finance_entry_events (entry_id, action, details) values (p_id, 'cancelled', jsonb_build_object('reason', left(v_reason, 500)));
  return to_jsonb(v_entry);
end;
$function$;

-- ------------------------------------------------------------------ 6. recorrências
create or replace function public.save_finance_recurrence(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_rec public.finance_recurrences%rowtype;
  v_kind text := p_payload->>'kind';
  v_cat uuid := nullif(p_payload->>'category_id', '')::uuid;
  v_desc text := left(btrim(regexp_replace(coalesce(p_payload->>'description', ''), '\s+', ' ', 'g')), 200);
  v_amount numeric := round((p_payload->>'amount')::numeric, 2);
  v_freq text := p_payload->>'frequency';
  v_start date;
  v_end date;
  v_offset integer := coalesce((p_payload->>'due_offset_days')::integer, 0);
  v_method text := nullif(p_payload->>'payment_method', '');
  v_exp text := nullif(p_payload->>'expense_type', '');
  v_nat text := nullif(p_payload->>'cost_nature', '');
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem configurar recorrências.';
  end if;
  perform public._finance_validate(v_kind, v_cat, v_desc, v_amount, v_method, v_exp, v_nat);
  if v_freq not in ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly') then
    raise exception 'Frequência inválida.';
  end if;
  begin
    v_start := (p_payload->>'start_date')::date;
    v_end := nullif(p_payload->>'end_date', '')::date;
  exception when others then
    raise exception 'Data inválida.';
  end;
  if v_start is null then
    raise exception 'Informe a data da primeira ocorrência.';
  end if;
  if v_end is not null and v_end < v_start then
    raise exception 'A data final é anterior à primeira ocorrência.';
  end if;
  if v_offset < 0 or v_offset > 120 then
    raise exception 'Prazo de vencimento inválido (0 a 120 dias).';
  end if;

  if v_id is null then
    -- Criação idempotente: o mesmo client_request_id devolve a recorrência já criada.
    if nullif(p_payload->>'client_request_id', '') is not null then
      select * into v_rec from public.finance_recurrences where client_request_id = (p_payload->>'client_request_id')::uuid;
      if found then
        return to_jsonb(v_rec);
      end if;
    end if;
    insert into public.finance_recurrences (kind, category_id, description, amount, frequency, start_date, end_date, due_offset_days,
      expense_type, cost_nature, payment_method, notes, client_request_id, created_by)
    values (v_kind, v_cat, v_desc, v_amount, v_freq, v_start, v_end, v_offset, v_exp, v_nat, v_method,
      nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), ''), nullif(p_payload->>'client_request_id', '')::uuid, auth.uid())
    returning * into v_rec;
  else
    -- Mudanças valem para os próximos lançamentos gerados; os já gerados não são reescritos.
    update public.finance_recurrences
       set kind = v_kind, category_id = v_cat, description = v_desc, amount = v_amount, frequency = v_freq, start_date = v_start,
           end_date = v_end, due_offset_days = v_offset, expense_type = v_exp, cost_nature = v_nat, payment_method = v_method,
           notes = nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), ''),
           active = coalesce((p_payload->>'active')::boolean, active), updated_at = now()
     where id = v_id
    returning * into v_rec;
    if not found then
      raise exception 'Recorrência não encontrada.';
    end if;
  end if;
  return to_jsonb(v_rec);
end;
$function$;

-- Gera os lançamentos previstos de todas as recorrências ativas até p_until (no máximo
-- 1 ano à frente). Idempotente: nunca duplica uma competência já gerada.
create or replace function public.generate_finance_recurrences(p_until date)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_until date := least(coalesce(p_until, current_date), current_date + 366);
  v_rec record;
  v_n integer;
  v_date date;
  v_step interval;
  v_criados integer := 0;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem gerar lançamentos.';
  end if;
  perform pg_advisory_xact_lock(hashtext('larica.finance_recurrences'));
  for v_rec in select * from public.finance_recurrences where active loop
    v_step := case v_rec.frequency when 'weekly' then interval '7 days' when 'biweekly' then interval '14 days'
      when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months' else interval '1 year' end;
    v_n := 0;
    loop
      v_date := (v_rec.start_date + v_n * v_step)::date;
      exit when v_date > v_until or (v_rec.end_date is not null and v_date > v_rec.end_date) or v_n > 600;
      insert into public.finance_entries (kind, category_id, description, amount, competence_date, due_date, status,
        payment_method, expense_type, cost_nature, notes, recurrence_id, created_by, updated_by)
      values (v_rec.kind, v_rec.category_id, v_rec.description, v_rec.amount, v_date, v_date + v_rec.due_offset_days, 'pending',
        v_rec.payment_method, v_rec.expense_type, v_rec.cost_nature, v_rec.notes, v_rec.id, auth.uid(), auth.uid())
      on conflict (recurrence_id, competence_date) where recurrence_id is not null do nothing
      returning id into v_id;
      if v_id is not null then
        v_criados := v_criados + 1;
        insert into public.finance_entry_events (entry_id, action, details) values (v_id, 'created', jsonb_build_object('recurrence_id', v_rec.id));
        v_id := null;
      end if;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_criados;
end;
$function$;

-- ------------------------------------------------------------------ 7. categorias
create or replace function public.save_finance_category(p_id uuid, p_name text, p_kind text, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_cat public.finance_categories%rowtype;
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 80);
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem gerenciar categorias.';
  end if;
  if v_name = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  if p_kind not in ('expense', 'revenue', 'owner_contribution', 'owner_withdrawal') then
    raise exception 'Tipo de categoria inválido.';
  end if;
  begin
    if p_id is null then
      insert into public.finance_categories (name, kind, active, created_by, updated_by)
      values (v_name, p_kind, coalesce(p_active, true), auth.uid(), auth.uid()) returning * into v_cat;
    else
      select * into v_cat from public.finance_categories where id = p_id;
      if not found then
        raise exception 'Categoria não encontrada.';
      end if;
      if v_cat.kind <> p_kind and (exists (select 1 from public.finance_entries where category_id = p_id)
          or exists (select 1 from public.purchase_lines where finance_category_id = p_id)) then
        raise exception 'Categoria já usada: o tipo não pode mudar.';
      end if;
      update public.finance_categories set name = v_name, kind = p_kind, active = coalesce(p_active, active), updated_at = now(), updated_by = auth.uid()
       where id = p_id returning * into v_cat;
    end if;
  exception when unique_violation then
    raise exception 'Já existe uma categoria com esse nome.';
  end;
  return to_jsonb(v_cat);
end;
$function$;

-- ------------------------------------------------------------------ 8. relatório gerencial
create or replace function public.get_finance_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_tz text;
  v_ini timestamptz;
  v_fim timestamptz;
  v_vendas jsonb;
  v_cmv jsonb;
  v_despesas jsonb;
  v_outras jsonb;
  v_caixa jsonb;
  v_contas jsonb;
  v_produtos jsonb;
  v_diario jsonb;
  v_perdas numeric;
  v_receita numeric;
  v_cmv_total numeric;
  v_desp_total numeric;
  v_outras_total numeric;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem ver o Financeiro.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Período inválido.';
  end if;
  if p_to - p_from > 1100 then
    raise exception 'Período longo demais (máximo 3 anos).';
  end if;
  select coalesce(nullif(timezone, ''), 'Europe/Dublin') into v_tz from public.business_settings limit 1;
  v_tz := coalesce(v_tz, 'Europe/Dublin');
  v_ini := (p_from::timestamp at time zone v_tz);
  v_fim := ((p_to + 1)::timestamp at time zone v_tz);

  -- ---- vendas (faturamento = pedidos não cancelados, pela data do pedido)
  select jsonb_build_object(
    'orders', count(*) filter (where o.status <> 'cancelled'),
    'subtotal', coalesce(sum(o.subtotal) filter (where o.status <> 'cancelled'), 0),
    'discounts', coalesce(sum(o.discount_amount) filter (where o.status <> 'cancelled'), 0),
    'delivery_fees', coalesce(sum(o.delivery_fee) filter (where o.status <> 'cancelled'), 0),
    'revenue', coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0),
    'cancelled_orders', count(*) filter (where o.status = 'cancelled'),
    'cancelled_total', coalesce(sum(o.total) filter (where o.status = 'cancelled'), 0),
    'received', coalesce(sum(o.total) filter (where o.status <> 'cancelled' and o.payment_status in ('paid', 'pay_on_delivery', 'legacy')), 0),
    'receivable', coalesce(sum(o.total) filter (where o.status <> 'cancelled' and o.payment_status = 'pending'), 0),
    'receivable_orders', count(*) filter (where o.status <> 'cancelled' and o.payment_status = 'pending'),
    'by_payment', coalesce((select jsonb_object_agg(x.payment_method, x.total) from (
        select o2.payment_method, sum(o2.total) total from public.orders o2
         where o2.created_at >= v_ini and o2.created_at < v_fim and o2.status <> 'cancelled' group by 1) x), '{}'::jsonb)
  ) into v_vendas
  from public.orders o where o.created_at >= v_ini and o.created_at < v_fim;
  v_receita := (v_vendas->>'revenue')::numeric;

  -- ---- CMV por item vendido
  with itens as (
    select oi.id, oi.product_id, oi.product_name, oi.item_type, oi.quantity, oi.total_price,
      case
        when oi.item_type = 'product' and oi.unit_cost_snapshot is not null then 'calculated'
        when oi.item_type = 'product' and pc.unit_cost is not null then 'estimated'
        when oi.item_type = 'combo' and cs.n > 0 and cs.sem_custo = 0 and cs.sem_snapshot = 0 then 'calculated'
        when oi.item_type = 'combo' and cs.n > 0 and cs.sem_custo = 0 then 'estimated'
        else 'unknown' end as origem,
      case
        when oi.item_type = 'product' then oi.quantity * coalesce(oi.unit_cost_snapshot, pc.unit_cost)
        when oi.item_type = 'combo' and cs.n > 0 and cs.sem_custo = 0 then oi.quantity * cs.custo
        else null end as custo
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    left join public.product_costs pc on pc.product_id = oi.product_id
    left join lateral (
      select count(*) n,
             count(*) filter (where s.unit_cost_snapshot is null and spc.unit_cost is null) sem_custo,
             count(*) filter (where s.unit_cost_snapshot is null) sem_snapshot,
             sum(s.quantity * coalesce(s.unit_cost_snapshot, spc.unit_cost)) custo
        from public.order_item_selections s
        left join public.product_costs spc on spc.product_id = s.selected_product_id
       where s.order_item_id = oi.id
    ) cs on oi.item_type = 'combo'
    where o.created_at >= v_ini and o.created_at < v_fim and o.status <> 'cancelled'
  )
  select jsonb_build_object(
    'total', coalesce(sum(custo), 0),
    'calculated', coalesce(sum(custo) filter (where origem = 'calculated'), 0),
    'estimated', coalesce(sum(custo) filter (where origem = 'estimated'), 0),
    'items_revenue', coalesce(sum(total_price), 0),
    'revenue_calculated', coalesce(sum(total_price) filter (where origem = 'calculated'), 0),
    'revenue_estimated', coalesce(sum(total_price) filter (where origem = 'estimated'), 0),
    'revenue_unknown', coalesce(sum(total_price) filter (where origem = 'unknown'), 0),
    'unknown_products', coalesce((select jsonb_agg(distinct i2.product_name) from itens i2 where i2.origem = 'unknown'), '[]'::jsonb)
  ) into v_cmv from itens;
  v_cmv_total := (v_cmv->>'total')::numeric;

  -- perdas no período (insumos pelo valor do ledger; produtos pelo custo atual)
  select coalesce((select -sum(m.total_value) from public.inventory_movements m
                    where m.movement_type = 'waste' and m.created_at >= v_ini and m.created_at < v_fim), 0)
       + coalesce((select sum(-sm.quantity_change * coalesce(pc.unit_cost, 0)) from public.stock_movements sm
                    left join public.product_costs pc on pc.product_id = sm.product_id
                    where sm.movement_type = 'waste' and sm.created_at >= v_ini and sm.created_at < v_fim), 0)
    into v_perdas;

  -- ---- despesas por competência: lançamentos + linhas de despesa das compras
  with d as (
    select fc.id, fc.name, e.amount valor, e.expense_type, e.cost_nature
      from public.finance_entries e join public.finance_categories fc on fc.id = e.category_id
     where e.kind = 'expense' and e.status <> 'cancelled' and e.competence_date between p_from and p_to
    union all
    select fc.id, fc.name, pl.cost_value, null, null
      from public.purchase_lines pl
      join public.purchases pu on pu.id = pl.purchase_id
      join public.finance_categories fc on fc.id = pl.finance_category_id
     where pl.line_type = 'expense' and pu.status = 'confirmed' and pu.purchased_at between p_from and p_to
  )
  select jsonb_build_object(
    'total', coalesce(sum(valor), 0),
    'fixed', coalesce(sum(valor) filter (where expense_type = 'fixed'), 0),
    'variable', coalesce(sum(valor) filter (where expense_type = 'variable'), 0),
    'direct', coalesce(sum(valor) filter (where cost_nature = 'direct'), 0),
    'indirect', coalesce(sum(valor) filter (where cost_nature = 'indirect'), 0),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', x.name, 'amount', x.v) order by x.v desc)
                               from (select name, sum(valor) v from d group by id, name) x), '[]'::jsonb)
  ) into v_despesas from d;
  v_desp_total := (v_despesas->>'total')::numeric;

  select jsonb_build_object(
    'other_revenue', coalesce(sum(e.amount) filter (where e.kind = 'revenue'), 0),
    'contributions', coalesce(sum(e.amount) filter (where e.kind = 'owner_contribution'), 0),
    'withdrawals', coalesce(sum(e.amount) filter (where e.kind = 'owner_withdrawal'), 0)
  ) into v_outras
  from public.finance_entries e where e.status <> 'cancelled' and e.competence_date between p_from and p_to;
  v_outras_total := (v_outras->>'other_revenue')::numeric;

  -- ---- caixa (dinheiro efetivamente recebido/pago no período)
  select jsonb_build_object(
    'sales_received', (v_vendas->>'received')::numeric,
    'other_received', coalesce((select sum(amount) from public.finance_entries where status = 'paid' and kind = 'revenue' and paid_at between p_from and p_to), 0),
    'contributions', coalesce((select sum(amount) from public.finance_entries where status = 'paid' and kind = 'owner_contribution' and paid_at between p_from and p_to), 0),
    'purchases_paid', coalesce((select sum(total_paid) from public.purchases where status = 'confirmed' and purchased_at between p_from and p_to), 0),
    'expenses_paid', coalesce((select sum(amount) from public.finance_entries where status = 'paid' and kind = 'expense' and paid_at between p_from and p_to), 0),
    'withdrawals', coalesce((select sum(amount) from public.finance_entries where status = 'paid' and kind = 'owner_withdrawal' and paid_at between p_from and p_to), 0)
  ) into v_caixa;

  -- ---- contas a pagar e a receber (pendentes, independem do período; vencidas = antes de hoje)
  select jsonb_build_object(
    'payable_total', coalesce(sum(amount) filter (where kind in ('expense', 'owner_withdrawal')), 0),
    'payable_overdue', coalesce(sum(amount) filter (where kind in ('expense', 'owner_withdrawal') and due_date < current_date), 0),
    'payable_next7', coalesce(sum(amount) filter (where kind in ('expense', 'owner_withdrawal') and due_date between current_date and current_date + 7), 0),
    'receivable_total', coalesce(sum(amount) filter (where kind in ('revenue', 'owner_contribution')), 0),
    'receivable_overdue', coalesce(sum(amount) filter (where kind in ('revenue', 'owner_contribution') and due_date < current_date), 0),
    'orders_pending_payment', coalesce((select sum(total) from public.orders where status <> 'cancelled' and payment_status = 'pending'), 0),
    'orders_pending_count', coalesce((select count(*) from public.orders where status <> 'cancelled' and payment_status = 'pending'), 0)
  ) into v_contas
  from public.finance_entries where status = 'pending';

  -- ---- rentabilidade por produto (vendas do período + preço/custo atuais)
  with vend as (
    select oi.product_id,
           sum(oi.quantity) qtd,
           sum(oi.total_price) receita,
           sum(case when oi.item_type = 'product' then oi.quantity * coalesce(oi.unit_cost_snapshot, pc.unit_cost)
                    else oi.quantity * (select case when count(*) filter (where s.unit_cost_snapshot is null and spc.unit_cost is null) = 0
                                                     then sum(s.quantity * coalesce(s.unit_cost_snapshot, spc.unit_cost)) end
                                          from public.order_item_selections s
                                          left join public.product_costs spc on spc.product_id = s.selected_product_id
                                         where s.order_item_id = oi.id) end) custo,
           count(*) filter (where (oi.item_type = 'product' and oi.unit_cost_snapshot is null and pc.unit_cost is null)) sem_custo
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      left join public.product_costs pc on pc.product_id = oi.product_id
     where o.created_at >= v_ini and o.created_at < v_fim and o.status <> 'cancelled'
     group by oi.product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'category', p.category, 'price', p.price, 'active', p.active,
           'unit_cost', pc.unit_cost, 'cost_updated_at', pc.updated_at,
           'cost_source', (select h.source_type from public.product_cost_history h where h.product_id = p.id order by h.created_at desc limit 1),
           'qty_sold', coalesce(v.qtd, 0), 'revenue', coalesce(v.receita, 0), 'cogs', v.custo, 'items_without_cost', coalesce(v.sem_custo, 0)
         ) order by coalesce(v.receita, 0) desc, p.name), '[]'::jsonb)
    into v_produtos
    from public.products p
    left join vend v on v.product_id = p.id
    left join public.product_costs pc on pc.product_id = p.id
   where p.active or v.qtd > 0;

  -- ---- série diária (faturamento, entradas e saídas de caixa)
  select coalesce(jsonb_agg(jsonb_build_object('date', d.dia, 'revenue', coalesce(r.v, 0), 'cash_in', coalesce(r.rec, 0) + coalesce(ei.v, 0), 'cash_out', coalesce(pu.v, 0) + coalesce(eo.v, 0)) order by d.dia), '[]'::jsonb)
    into v_diario
    from generate_series(p_from, p_to, interval '1 day') as d(dia)
    left join (select (o.created_at at time zone v_tz)::date dia, sum(o.total) v,
                      sum(o.total) filter (where o.payment_status in ('paid', 'pay_on_delivery', 'legacy')) rec
                 from public.orders o where o.created_at >= v_ini and o.created_at < v_fim and o.status <> 'cancelled' group by 1) r on r.dia = d.dia::date
    left join (select paid_at dia, sum(amount) v from public.finance_entries where status = 'paid' and kind in ('revenue', 'owner_contribution') group by 1) ei on ei.dia = d.dia::date
    left join (select paid_at dia, sum(amount) v from public.finance_entries where status = 'paid' and kind in ('expense', 'owner_withdrawal') group by 1) eo on eo.dia = d.dia::date
    left join (select purchased_at dia, sum(total_paid) v from public.purchases where status = 'confirmed' group by 1) pu on pu.dia = d.dia::date
   where p_to - p_from <= 400;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),
    'sales', v_vendas,
    'cogs', v_cmv || jsonb_build_object('waste', v_perdas),
    'expenses', v_despesas,
    'other', v_outras,
    'dre', jsonb_build_object(
      'revenue', v_receita,
      'cogs', v_cmv_total,
      'gross_profit', v_receita - v_cmv_total,
      'waste', v_perdas,
      'operating_expenses', v_desp_total,
      'operating_result', v_receita - v_cmv_total - v_perdas - v_desp_total,
      'other_revenue', v_outras_total,
      'net_result', v_receita - v_cmv_total - v_perdas - v_desp_total + v_outras_total
    ),
    'cash', v_caixa || jsonb_build_object(
      'total_in', (v_caixa->>'sales_received')::numeric + (v_caixa->>'other_received')::numeric + (v_caixa->>'contributions')::numeric,
      'total_out', (v_caixa->>'purchases_paid')::numeric + (v_caixa->>'expenses_paid')::numeric + (v_caixa->>'withdrawals')::numeric),
    'accounts', v_contas,
    'products', v_produtos,
    'daily', v_diario
  );
end;
$function$;

-- ------------------------------------------------------------------ 9. RLS e permissões
alter table public.finance_entries enable row level security;
alter table public.finance_recurrences enable row level security;
alter table public.finance_entry_events enable row level security;
create policy finance_entries_select_admin on public.finance_entries for select to authenticated using (public.is_admin());
create policy finance_recurrences_select_admin on public.finance_recurrences for select to authenticated using (public.is_admin());
create policy finance_entry_events_select_admin on public.finance_entry_events for select to authenticated using (public.is_admin());
revoke all on public.finance_entries, public.finance_recurrences, public.finance_entry_events from anon, authenticated;
grant select on public.finance_entries, public.finance_recurrences, public.finance_entry_events to authenticated;
grant all on public.finance_entries, public.finance_recurrences, public.finance_entry_events to service_role;

revoke all on function public._finance_validate(text, uuid, text, numeric, text, text, text) from public, anon, authenticated;
revoke all on function public.save_finance_entry(jsonb) from public, anon;
revoke all on function public.pay_finance_entry(uuid, date, text) from public, anon;
revoke all on function public.undo_finance_payment(uuid, text) from public, anon;
revoke all on function public.cancel_finance_entry(uuid, text) from public, anon;
revoke all on function public.save_finance_recurrence(jsonb) from public, anon;
revoke all on function public.generate_finance_recurrences(date) from public, anon;
revoke all on function public.save_finance_category(uuid, text, text, boolean) from public, anon;
revoke all on function public.get_finance_report(date, date) from public, anon;
grant execute on function public.save_finance_entry(jsonb) to authenticated;
grant execute on function public.pay_finance_entry(uuid, date, text) to authenticated;
grant execute on function public.undo_finance_payment(uuid, text) to authenticated;
grant execute on function public.cancel_finance_entry(uuid, text) to authenticated;
grant execute on function public.save_finance_recurrence(jsonb) to authenticated;
grant execute on function public.generate_finance_recurrences(date) to authenticated;
grant execute on function public.save_finance_category(uuid, text, text, boolean) to authenticated;
grant execute on function public.get_finance_report(date, date) to authenticated;

commit;
