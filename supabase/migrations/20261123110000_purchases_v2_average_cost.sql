-- =====================================================================================
-- FASE B — Compras v2: documentos, OCR, VAT, apelidos, despesas e CUSTO MÉDIO PONDERADO
-- -------------------------------------------------------------------------------------
-- Decisões (usuário, 2026-11-23):
--   * valorização de estoque por custo médio ponderado (abandona o modelo por lote);
--   * dados de teste de Compras são apagados;
--   * VAT por linha com as taxas irlandesas 0 / 9 / 13,5 / 23 %.
--
-- Onde fica o estoque de cada item de compra (regra única, aplicada pelas RPCs):
--   * item ligado a produto com stock_mode='purchased' (ex.: Coca Cola) -> estoque do
--     PRODUTO (products.stock_quantity + stock_movements); custo médio em product_costs,
--     com histórico em product_cost_history;
--   * demais itens com tracks_stock=true (matéria-prima, ingredientes, insumos) -> estoque
--     do próprio ITEM (purchase_items.stock_quantity/avg_cost) com ledger imutável em
--     inventory_movements; ingrediente/insumo vinculado recebe o custo médio (ficha técnica);
--   * itens sem controle de estoque -> linha de DESPESA com categoria financeira.
--
-- Custo de entrada de uma linha = valor líquido (após descontos da linha e rateio do
-- desconto geral) + VAT apenas quando a compra tem VAT NÃO recuperável.
-- Correção de compra = cancelamento com estorno (nada confirmado é apagado).
--
-- Fora do escopo desta fase (Fase C): as RPCs de produção ainda usam lotes. A Produção
-- não tem nenhum lote registrado (0 produções) e será reescrita na Fase C.
-- Rollback: supabase/rollback/20261123110000_purchases_v2_average_cost_down.sql
-- =====================================================================================

begin;

-- ------------------------------------------------------------------ 0. trava de segurança
do $$
begin
  if exists (select 1 from public.purchases where id <> '0454a2e3-1e97-4ab9-b119-ff853a6e9c1a') then
    raise exception 'Abortado: existem compras além da compra de teste. Revise antes de aplicar.';
  end if;
  if exists (select 1 from public.skewer_production_batches) or exists (select 1 from public.side_production_batches) then
    raise exception 'Abortado: existem produções registradas que dependem de lotes. Revise antes de aplicar.';
  end if;
end $$;

create extension if not exists pg_trgm with schema extensions;

-- ------------------------------------------------------------------ 1. limpeza dos dados de teste
delete from public.lot_movements where lot_id = '1d230353-1ae9-42e5-8b73-b36c61d59ac4';
delete from public.lots where id = '1d230353-1ae9-42e5-8b73-b36c61d59ac4';
delete from public.purchases where id = '0454a2e3-1e97-4ab9-b119-ff853a6e9c1a';  -- linhas caem por CASCADE

delete from public.purchase_items pi
where pi.name in ('Item Teste', 'Palito Teste', 'Detergente Teste', 'Cebola Teste J3')
  and not exists (select 1 from public.purchase_lines pl where pl.purchase_item_id = pi.id)
  and not exists (select 1 from public.lots l where l.purchase_item_id = pi.id);

delete from public.ingredients i
where i.id in ('854486e0-4b68-4772-a40b-9d08b156bd90', 'e8b38b2a-4ff9-405e-9fea-4516d79d2642')  -- Cebola Teste J3, Item Teste
  and not exists (select 1 from public.purchase_items pi where pi.ingredient_id = i.id)
  and not exists (select 1 from public.recipe_items ri where ri.ingredient_id = i.id);

delete from public.production_supplies s
where s.id = '4c3ac46a-d8ab-456f-8d3f-453755979436'  -- Palito Teste
  and not exists (select 1 from public.purchase_items pi where pi.production_supply_id = s.id);

-- Contra Filé (carne crua, em gramas) estava ligado ao produto "Carne" (espeto vendido por
-- unidade). No modelo novo é matéria-prima: o espeto sai da Produção (Fase C).
update public.purchase_items
   set product_id = null, updated_at = now()
 where normalized_name = 'contra file'
   and product_id in (select id from public.products where name = 'Carne');

-- ------------------------------------------------------------------ 2. normalização de texto
create or replace function public.normalize_purchase_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path to ''
as $function$
  select nullif(btrim(regexp_replace(
           translate(lower(coalesce(p_text, '')), 'áàãâäéèêëíìîïóòõôöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
           '[^a-z0-9]+', ' ', 'g')), '');
$function$;

-- ------------------------------------------------------------------ 3. categorias financeiras
create table public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null,
  system_key text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_by uuid,
  constraint finance_categories_name_nao_vazio check (length(btrim(name)) > 0),
  constraint finance_categories_kind_valido check (kind in ('expense', 'revenue', 'owner_contribution', 'owner_withdrawal'))
);
create unique index ux_finance_categories_kind_name on public.finance_categories (kind, public.normalize_purchase_text(name));

insert into public.finance_categories (name, kind, system_key) values
  ('Aluguel', 'expense', 'rent'),
  ('Salários e funcionários', 'expense', 'payroll'),
  ('Energia', 'expense', 'energy'),
  ('Água', 'expense', 'water'),
  ('Internet e telefone', 'expense', 'internet'),
  ('Transporte', 'expense', 'transport'),
  ('Manutenção', 'expense', 'maintenance'),
  ('Embalagens', 'expense', 'packaging'),
  ('Material de limpeza', 'expense', 'cleaning'),
  ('Material administrativo', 'expense', 'office'),
  ('Serviços', 'expense', 'services'),
  ('Marketing', 'expense', 'marketing'),
  ('Contabilidade', 'expense', 'accounting'),
  ('Taxas e impostos', 'expense', 'fees_taxes'),
  ('Outras despesas', 'expense', 'other_expense'),
  ('Vendas', 'revenue', 'sales'),
  ('Outras receitas', 'revenue', 'other_revenue'),
  ('Aporte dos sócios', 'owner_contribution', 'owner_contribution'),
  ('Retirada dos sócios', 'owner_withdrawal', 'owner_withdrawal');

-- ------------------------------------------------------------------ 4. itens de compra: estoque + custo médio
alter table public.purchase_items
  add column stock_quantity numeric(14,3) not null default 0,
  add column avg_cost numeric(20,10),
  add column avg_cost_updated_at timestamptz,
  add column finance_category_id uuid references public.finance_categories(id);

alter table public.purchase_items
  add constraint purchase_items_avg_cost_nao_negativo check (avg_cost is null or avg_cost >= 0);

comment on column public.purchase_items.stock_quantity is 'Saldo em unidade-base (g/ml/un). Só para itens cujo estoque NÃO fica num produto de revenda. Alterado apenas pelas RPCs de estoque.';
comment on column public.purchase_items.avg_cost is 'Custo médio ponderado por unidade-base, sem VAT recuperável. Histórico em inventory_movements.';

-- ------------------------------------------------------------------ 5. apelidos (nomes alternativos)
create table public.purchase_item_aliases (
  id uuid primary key default gen_random_uuid(),
  purchase_item_id uuid not null references public.purchase_items(id) on delete cascade,
  alias text not null,
  normalized_alias text generated always as (public.normalize_purchase_text(alias)) stored,
  source text not null default 'manual',
  times_used integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint purchase_item_aliases_alias_nao_vazio check (public.normalize_purchase_text(alias) is not null),
  constraint purchase_item_aliases_source_valido check (source in ('manual', 'purchase_confirmed'))
);
create unique index ux_purchase_item_aliases_normalized on public.purchase_item_aliases (normalized_alias);
create index idx_purchase_item_aliases_item on public.purchase_item_aliases (purchase_item_id);

-- ------------------------------------------------------------------ 6. compras: totais, VAT, status
alter table public.purchases
  add column status text not null default 'confirmed',
  add column source text not null default 'manual',
  add column vat_recoverable boolean not null default true,
  add column gross_total numeric(14,2) not null default 0,
  add column discount_total numeric(14,2) not null default 0,
  add column header_discount numeric(14,2) not null default 0,
  add column net_total numeric(14,2) not null default 0,
  add column vat_total numeric(14,2) not null default 0,
  add column total_paid numeric(14,2) not null default 0,
  add column rounding_adjustment numeric(14,2) not null default 0,
  add column client_request_id uuid,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid,
  add column cancel_reason text;

alter table public.purchases
  add constraint purchases_status_valido check (status in ('confirmed', 'cancelled')),
  add constraint purchases_source_valido check (source in ('manual', 'ocr')),
  add constraint purchases_totais_nao_negativos check (gross_total >= 0 and discount_total >= 0 and header_discount >= 0 and net_total >= 0 and vat_total >= 0 and total_paid >= 0),
  add constraint purchases_arredondamento_limite check (abs(rounding_adjustment) <= 1.00),
  add constraint purchases_cancelamento_coerente check ((status = 'cancelled') = (cancelled_at is not null)),
  add constraint purchases_client_request_unico unique (client_request_id);
create index idx_purchases_status on public.purchases (status);

-- ------------------------------------------------------------------ 7. linhas: tipo, descrição da nota, VAT, custo
alter table public.purchase_lines drop column unit_cost_base;  -- era total_price/base_quantity (incluiria VAT recuperável)
alter table public.purchase_lines alter column purchase_item_id drop not null;

alter table public.purchase_lines
  add column line_order integer not null default 0,
  add column line_type text not null default 'stock',
  add column raw_description text,
  add column unit_price numeric(14,4),
  add column gross_amount numeric(14,4) not null default 0,
  add column discount_amount numeric(14,4) not null default 0,
  add column header_discount_share numeric(14,4) not null default 0,
  add column net_amount numeric(14,4) not null default 0,
  add column vat_rate numeric(4,1) not null default 0,
  add column vat_amount numeric(14,4) not null default 0,
  add column cost_value numeric(14,4) not null default 0,
  add column finance_category_id uuid references public.finance_categories(id);

alter table public.purchase_lines
  add column unit_cost_base numeric(20,10) generated always as (cost_value / base_quantity) stored;

alter table public.purchase_lines
  add constraint purchase_lines_line_type_valido check (line_type in ('stock', 'expense')),
  add constraint purchase_lines_estoque_coerente check (line_type <> 'stock' or (purchase_item_id is not null and base_quantity is not null)),
  add constraint purchase_lines_despesa_coerente check (line_type <> 'expense' or finance_category_id is not null),
  add constraint purchase_lines_vat_rate_valido check (vat_rate in (0, 9, 13.5, 23)),
  add constraint purchase_lines_valores_nao_negativos check (gross_amount >= 0 and discount_amount >= 0 and header_discount_share >= 0 and net_amount >= 0 and vat_amount >= 0 and cost_value >= 0 and (unit_price is null or unit_price >= 0)),
  add constraint purchase_lines_desconto_ate_bruto check (discount_amount + header_discount_share <= gross_amount + 0.0001);

-- ------------------------------------------------------------------ 8. documentos (fotos/PDF) + OCR
create table public.purchase_documents (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references public.purchases(id) on delete set null,
  storage_path text not null unique,
  file_name text,
  mime_type text not null,
  size_bytes integer not null,
  ocr_status text not null default 'pending',
  ocr_result jsonb,
  ocr_error text,
  ocr_model text,
  ocr_processed_at timestamptz,
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint purchase_documents_mime_valido check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  constraint purchase_documents_tamanho_valido check (size_bytes > 0 and size_bytes <= 10485760),
  constraint purchase_documents_ocr_status_valido check (ocr_status in ('pending', 'processing', 'done', 'failed'))
);
create index idx_purchase_documents_purchase on public.purchase_documents (purchase_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-documents', 'purchase-documents', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy purchase_documents_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'purchase-documents' and public.is_admin());
create policy purchase_documents_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'purchase-documents' and (storage.foldername(name))[1] = 'uploads' and public.is_admin());
-- Excluir arquivo só enquanto não estiver ligado a uma compra (documento fiscal fica guardado).
create policy purchase_documents_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'purchase-documents' and public.is_admin()
         and not exists (select 1 from public.purchase_documents d where d.storage_path = name and d.purchase_id is not null));

-- ------------------------------------------------------------------ 9. ledger de estoque dos itens + histórico de custo dos produtos
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  purchase_item_id uuid not null references public.purchase_items(id),
  movement_type text not null,
  quantity numeric(14,3) not null,
  unit_cost numeric(20,10),
  total_value numeric(14,4) not null,
  balance_before numeric(14,3) not null,
  balance_after numeric(14,3) not null,
  avg_cost_before numeric(20,10),
  avg_cost_after numeric(20,10),
  source_type text not null,
  source_id uuid,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint inventory_movements_quantity_nao_zero check (quantity <> 0),
  constraint inventory_movements_tipo_valido check (movement_type in ('purchase_in', 'purchase_reversal', 'production_out', 'production_reversal', 'adjustment_in', 'adjustment_out', 'waste')),
  constraint inventory_movements_sinal_coerente check (
    (movement_type in ('purchase_in', 'production_reversal', 'adjustment_in') and quantity > 0) or
    (movement_type in ('purchase_reversal', 'production_out', 'adjustment_out', 'waste') and quantity < 0)),
  constraint inventory_movements_saldo_coerente check (balance_after = balance_before + quantity),
  constraint inventory_movements_source_valido check (source_type in ('purchase_line', 'skewer_production', 'side_production', 'manual'))
);
create index idx_inventory_movements_item on public.inventory_movements (purchase_item_id, created_at desc);
-- Evita movimento duplicado da mesma origem (ex.: confirmar/cancelar a mesma compra duas vezes).
create unique index ux_inventory_movements_source on public.inventory_movements (source_type, source_id, movement_type, purchase_item_id) where source_id is not null;

create table public.product_cost_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  unit_cost_before numeric(12,4),
  unit_cost_after numeric(12,4),
  stock_before integer,
  stock_after integer,
  source_type text not null,
  source_id uuid,
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index idx_product_cost_history_product on public.product_cost_history (product_id, created_at desc);

create unique index ux_stock_movements_purchase_source on public.stock_movements (source_type, source_id, movement_type)
  where source_type = 'purchase_line' and source_id is not null
    and source_id not in ('62dbafce-4bc0-4dca-b4cf-eca15b495369', '8809db1a-a163-4f03-8476-6c52d22babd8');  -- pares de teste antigos (saldo zero)

create or replace function public._ledger_immutable()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  raise exception 'Registros de histórico não podem ser alterados nem apagados. Use um estorno.';
end;
$function$;

create trigger inventory_movements_immutable before update or delete on public.inventory_movements
  for each row execute function public._ledger_immutable();
create trigger product_cost_history_immutable before update or delete on public.product_cost_history
  for each row execute function public._ledger_immutable();

-- Unidade/controle de estoque/vínculo não podem mudar com saldo ou histórico (evita misturar g com un).
create or replace function public._purchase_items_guard_stock_changes()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_has_history boolean;
begin
  v_has_history := old.stock_quantity <> 0
    or exists (select 1 from public.inventory_movements m where m.purchase_item_id = old.id);
  if v_has_history and new.base_unit is distinct from old.base_unit then
    raise exception 'O item "%" já tem movimentações de estoque: a unidade-base não pode ser trocada.', old.name;
  end if;
  if old.stock_quantity <> 0 and (new.tracks_stock is distinct from old.tracks_stock or new.product_id is distinct from old.product_id) then
    raise exception 'O item "%" tem saldo em estoque (% %). Zere o saldo antes de mudar o controle de estoque ou o vínculo.', old.name, old.stock_quantity, old.base_unit;
  end if;
  return new;
end;
$function$;

create trigger purchase_items_guard_stock_changes before update on public.purchase_items
  for each row execute function public._purchase_items_guard_stock_changes();

-- ------------------------------------------------------------------ 10. motores de estoque/custo
-- Movimenta o estoque de um ITEM de compra com custo médio ponderado.
--   Entradas com valor (purchase_in): novo médio = (Q*A + valor) / (Q + q).
--   Estorno de compra (purchase_reversal, valor negativo): retira quantidade E valor;
--     se o saldo zerar ou o médio ficar inválido, mantém o último médio conhecido.
--   Demais saídas (produção, ajuste, perda): saem pelo custo médio; o médio não muda.
create or replace function public._inventory_apply(
  p_item_id uuid,
  p_quantity numeric,
  p_value numeric,
  p_movement_type text,
  p_source_type text,
  p_source_id uuid,
  p_reason text,
  p_allow_negative boolean default false
)
returns public.inventory_movements
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.purchase_items%rowtype;
  v_q numeric;
  v_a numeric;
  v_new_q numeric;
  v_new_a numeric;
  v_value numeric;
  v_mov public.inventory_movements%rowtype;
begin
  select * into v_item from public.purchase_items where id = p_item_id for update;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;
  if not v_item.tracks_stock then
    raise exception 'O item "%" não controla estoque.', v_item.name;
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade do movimento inválida.';
  end if;

  v_q := v_item.stock_quantity;
  v_a := v_item.avg_cost;
  v_new_q := v_q + p_quantity;

  if v_new_q < 0 and not coalesce(p_allow_negative, false) then
    raise exception 'Estoque insuficiente de "%": saldo atual % %, movimento de % %.',
      v_item.name, trim(to_char(v_q, 'FM999999990.###')), v_item.base_unit,
      trim(to_char(p_quantity, 'FM999999990.###')), v_item.base_unit
      using hint = 'larica:insufficient_stock';
  end if;

  if p_movement_type = 'purchase_in' then
    if p_value is null or p_value < 0 then
      raise exception 'Valor de entrada inválido.';
    end if;
    v_value := p_value;
    if v_q <= 0 or v_a is null then
      v_new_a := p_value / p_quantity;
    else
      v_new_a := (v_q * v_a + p_value) / v_new_q;
    end if;
  elsif p_movement_type = 'purchase_reversal' then
    v_value := coalesce(p_value, p_quantity * coalesce(v_a, 0));
    if v_new_q > 0 and v_a is not null then
      v_new_a := (v_q * v_a + v_value) / v_new_q;
      if v_new_a < 0 then
        v_new_a := v_a;
      end if;
    else
      v_new_a := v_a;
    end if;
  else
    v_value := p_quantity * coalesce(v_a, 0);
    v_new_a := v_a;
  end if;

  insert into public.inventory_movements (
    purchase_item_id, movement_type, quantity, unit_cost, total_value,
    balance_before, balance_after, avg_cost_before, avg_cost_after,
    source_type, source_id, reason, created_by
  ) values (
    v_item.id, p_movement_type, p_quantity, abs(v_value / p_quantity), round(v_value, 4),
    v_q, v_new_q, v_a, v_new_a,
    p_source_type, p_source_id, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()
  )
  returning * into v_mov;

  update public.purchase_items
     set stock_quantity = v_new_q,
         avg_cost = v_new_a,
         avg_cost_updated_at = case when v_new_a is distinct from v_a then now() else avg_cost_updated_at end,
         updated_at = now()
   where id = v_item.id;

  -- Ficha técnica: ingrediente/insumo vinculado passa a usar o custo médio real.
  -- (cost_per_base_unit / cost_per_unit são colunas geradas a partir do preço de compra.)
  if v_new_a is not null and v_new_a is distinct from v_a then
    if v_item.ingredient_id is not null then
      update public.ingredients i
         set purchase_price = round(v_new_a * i.purchase_quantity_base, 4),
             updated_at = now(),
             updated_by = auth.uid()
       where i.id = v_item.ingredient_id
         and i.base_unit = v_item.base_unit;
    elsif v_item.production_supply_id is not null and v_item.base_unit = 'un' then
      update public.production_supplies s
         set purchase_price = round(v_new_a * s.purchase_quantity, 4),
             updated_at = now(),
             updated_by = auth.uid()
       where s.id = v_item.production_supply_id;
    end if;
  end if;

  return v_mov;
end;
$function$;

-- Movimenta o estoque de um PRODUTO de revenda por compra/estorno e atualiza o custo médio.
create or replace function public._product_purchase_apply(
  p_product_id uuid,
  p_quantity integer,
  p_value numeric,
  p_movement_type text,
  p_source_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_product public.products%rowtype;
  v_q integer;
  v_a numeric;
  v_new_q integer;
  v_new_a numeric;
  v_mov public.stock_movements%rowtype;
begin
  if p_movement_type not in ('purchase_in', 'purchase_reversal') then
    raise exception 'Tipo de movimento inválido.';
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade do movimento inválida.';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto vinculado não encontrado.';
  end if;
  select unit_cost into v_a from public.product_costs where product_id = p_product_id;

  v_q := v_product.stock_quantity;
  v_new_q := v_q + p_quantity;
  if v_new_q < 0 then
    raise exception 'Estoque insuficiente de "%": saldo atual % un, estorno de % un. Ajuste o estoque antes de cancelar a compra.',
      v_product.name, v_q, abs(p_quantity)
      using hint = 'larica:insufficient_stock';
  end if;

  if p_movement_type = 'purchase_in' then
    if v_q <= 0 or v_a is null then
      v_new_a := p_value / p_quantity;
    else
      v_new_a := (v_q * v_a + p_value) / v_new_q;
    end if;
  else
    if v_new_q > 0 and v_a is not null then
      v_new_a := (v_q * v_a + p_value) / v_new_q;
      if v_new_a < 0 then
        v_new_a := v_a;
      end if;
    else
      v_new_a := v_a;
    end if;
  end if;
  v_new_a := round(v_new_a, 4);

  update public.products
     set stock_quantity = v_new_q, updated_at = now()
   where id = p_product_id;

  insert into public.stock_movements (
    product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity,
    reason, source_type, source_id, created_by
  ) values (
    p_product_id, null, p_movement_type, p_quantity, v_q, v_new_q,
    p_reason, 'purchase_line', p_source_id, auth.uid()
  )
  returning * into v_mov;

  if v_new_a is distinct from v_a then
    insert into public.product_costs (product_id, unit_cost, updated_at, updated_by)
    values (p_product_id, v_new_a, now(), auth.uid())
    on conflict (product_id) do update
      set unit_cost = excluded.unit_cost, updated_at = now(), updated_by = auth.uid();
  end if;

  insert into public.product_cost_history (
    product_id, unit_cost_before, unit_cost_after, stock_before, stock_after, source_type, source_id, reason, created_by
  ) values (
    p_product_id, v_a, v_new_a, v_q, v_new_q, 'purchase_line', p_source_id, p_reason, auth.uid()
  );

  return jsonb_build_object('movement', to_jsonb(v_mov), 'unit_cost_before', v_a, 'unit_cost_after', v_new_a);
end;
$function$;

-- ------------------------------------------------------------------ 11. confirmar compra (única escrita de compra)
-- p_payload:
-- { client_request_id: uuid (obrigatório; repetir o envio NÃO duplica),
--   supplier_id | supplier_name, purchased_at: 'YYYY-MM-DD', reference, notes,
--   vat_recoverable: bool, header_discount: num, total_paid: num|null, source: 'manual'|'ocr',
--   document_ids: [uuid],
--   lines: [{ raw_description, purchase_item_id, line_type: 'stock'|'expense', finance_category_id,
--             quantity, unit, unit_price, gross_amount, discount_amount, vat_rate, vat_amount,
--             remember_alias: bool }] }
create or replace function public.confirm_purchase(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_req uuid;
  v_existing uuid;
  v_purchase public.purchases%rowtype;
  v_supplier_id uuid;
  v_supplier_name text;
  v_date date;
  v_vat_recoverable boolean;
  v_header_discount numeric;
  v_total_paid numeric;
  v_source text;
  v_lines jsonb;
  v_line jsonb;
  v_n integer;
  v_i integer;
  v_item public.purchase_items%rowtype;
  v_product_mode text;
  v_line_type text;
  v_qty numeric;
  v_unit text;
  v_base numeric;
  v_unit_price numeric;
  v_gross numeric;
  v_line_disc numeric;
  v_rate numeric;
  v_vat numeric;
  v_vat_in numeric;
  v_fin uuid;
  v_raw text;
  v_snapshot text;
  v_target text;
  v_prepared jsonb := '[]'::jsonb;
  v_p jsonb;
  v_sum_pre numeric := 0;
  v_alloc numeric := 0;
  v_share numeric;
  v_last_idx integer := -1;
  v_net numeric;
  v_cost numeric;
  v_gross_total numeric := 0;
  v_line_disc_total numeric := 0;
  v_net_total numeric := 0;
  v_vat_total numeric := 0;
  v_computed numeric;
  v_line_id uuid;
  v_doc_ids uuid[];
  v_doc_count integer;
  v_norm_raw text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem registrar compras.';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Dados da compra inválidos.';
  end if;

  -- Idempotência
  begin
    v_req := (p_payload->>'client_request_id')::uuid;
  exception when others then
    raise exception 'Identificador da operação inválido.';
  end;
  if v_req is null then
    raise exception 'Identificador da operação ausente.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select id into v_existing from public.purchases where client_request_id = v_req;
  if found then
    return jsonb_build_object('duplicate', true, 'purchase_id', v_existing);
  end if;

  -- Cabeçalho
  begin
    v_date := (p_payload->>'purchased_at')::date;
  exception when others then
    raise exception 'Data da compra inválida.';
  end;
  if v_date is null then
    raise exception 'Informe a data da compra.';
  end if;
  if v_date > current_date + 1 or v_date < date '2020-01-01' then
    raise exception 'Data da compra fora do intervalo permitido.';
  end if;

  v_vat_recoverable := coalesce((p_payload->>'vat_recoverable')::boolean, true);
  v_header_discount := round(coalesce((p_payload->>'header_discount')::numeric, 0), 2);
  if v_header_discount < 0 then
    raise exception 'Desconto geral não pode ser negativo.';
  end if;
  v_total_paid := (p_payload->>'total_paid')::numeric;
  v_source := coalesce(p_payload->>'source', 'manual');
  if v_source not in ('manual', 'ocr') then
    raise exception 'Origem da compra inválida.';
  end if;

  if nullif(p_payload->>'supplier_id', '') is not null then
    select id into v_supplier_id from public.suppliers where id = (p_payload->>'supplier_id')::uuid;
    if not found then
      raise exception 'Fornecedor não encontrado.';
    end if;
  else
    v_supplier_name := btrim(regexp_replace(coalesce(p_payload->>'supplier_name', ''), '\s+', ' ', 'g'));
    if v_supplier_name <> '' then
      select id into v_supplier_id
        from public.suppliers
       where public.normalize_purchase_text(name) = public.normalize_purchase_text(v_supplier_name)
       order by active desc, created_at
       limit 1;
      if v_supplier_id is null then
        insert into public.suppliers (name, active, created_by, updated_by)
        values (left(v_supplier_name, 120), true, auth.uid(), auth.uid())
        returning id into v_supplier_id;
      end if;
    end if;
  end if;

  v_lines := p_payload->'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'A compra precisa de pelo menos uma linha.';
  end if;
  v_n := jsonb_array_length(v_lines);
  if v_n > 200 then
    raise exception 'Compra com linhas demais (máximo 200).';
  end if;

  -- Passo 1: validar e calcular cada linha (antes do rateio do desconto geral)
  for v_i in 0 .. v_n - 1 loop
    v_line := v_lines->v_i;
    v_item := null;
    v_product_mode := null;
    v_target := 'none';
    v_raw := nullif(btrim(regexp_replace(coalesce(v_line->>'raw_description', ''), '\s+', ' ', 'g')), '');
    if v_raw is not null and length(v_raw) > 300 then
      v_raw := left(v_raw, 300);
    end if;

    if nullif(v_line->>'purchase_item_id', '') is not null then
      select * into v_item from public.purchase_items where id = (v_line->>'purchase_item_id')::uuid;
      if not found then
        raise exception 'Linha %: item de compra não encontrado.', v_i + 1;
      end if;
      if not v_item.active then
        raise exception 'Linha %: o item "%" está inativo.', v_i + 1, v_item.name;
      end if;
      v_line_type := case when v_item.tracks_stock then 'stock' else 'expense' end;
      if v_item.product_id is not null then
        select stock_mode into v_product_mode from public.products where id = v_item.product_id;
      end if;
      v_target := case
        when not v_item.tracks_stock then 'none'
        when v_item.product_id is not null and v_product_mode = 'purchased' then 'product'
        else 'item' end;
      v_snapshot := v_item.name;
    else
      v_line_type := coalesce(v_line->>'line_type', 'expense');
      if v_line_type = 'stock' then
        raise exception 'Linha % ("%"): associe a linha a um item de estoque.', v_i + 1, coalesce(v_raw, 'sem descrição');
      end if;
      if v_line_type <> 'expense' then
        raise exception 'Linha %: tipo de linha inválido.', v_i + 1;
      end if;
      if v_raw is null then
        raise exception 'Linha %: informe a descrição da despesa.', v_i + 1;
      end if;
      v_snapshot := v_raw;
    end if;

    v_fin := null;
    if v_line_type = 'expense' then
      v_fin := coalesce(nullif(v_line->>'finance_category_id', '')::uuid, v_item.finance_category_id);
      if v_fin is null then
        raise exception 'Linha % ("%"): escolha a categoria financeira da despesa.', v_i + 1, v_snapshot;
      end if;
      if not exists (select 1 from public.finance_categories where id = v_fin and kind = 'expense' and active) then
        raise exception 'Linha %: categoria financeira inválida.', v_i + 1;
      end if;
    end if;

    v_qty := (v_line->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 1000000000 then
      raise exception 'Linha % ("%"): quantidade inválida.', v_i + 1, v_snapshot;
    end if;
    v_qty := round(v_qty, 3);
    v_unit := lower(coalesce(v_line->>'unit', ''));
    if v_unit not in ('g', 'kg', 'ml', 'l', 'un') then
      raise exception 'Linha % ("%"): unidade inválida (use g, kg, ml, l ou un).', v_i + 1, v_snapshot;
    end if;

    v_base := null;
    if v_line_type = 'stock' then
      v_base := case
        when v_item.base_unit = 'g' and v_unit = 'g' then v_qty
        when v_item.base_unit = 'g' and v_unit = 'kg' then v_qty * 1000
        when v_item.base_unit = 'ml' and v_unit = 'ml' then v_qty
        when v_item.base_unit = 'ml' and v_unit = 'l' then v_qty * 1000
        when v_item.base_unit = 'un' and v_unit = 'un' then v_qty
        else null end;
      if v_base is null then
        raise exception 'Linha % ("%"): a unidade "%" não combina com a unidade do item (%).', v_i + 1, v_snapshot, v_unit, v_item.base_unit;
      end if;
      if v_target = 'product' and v_base <> floor(v_base) then
        raise exception 'Linha % ("%"): produto de revenda exige quantidade inteira.', v_i + 1, v_snapshot;
      end if;
    end if;

    v_unit_price := (v_line->>'unit_price')::numeric;
    if v_unit_price is not null and v_unit_price < 0 then
      raise exception 'Linha % ("%"): preço unitário negativo.', v_i + 1, v_snapshot;
    end if;
    v_gross := coalesce((v_line->>'gross_amount')::numeric, round(v_qty * v_unit_price, 4));
    if v_gross is null or v_gross < 0 then
      raise exception 'Linha % ("%"): informe o preço unitário ou o valor da linha.', v_i + 1, v_snapshot;
    end if;
    v_gross := round(v_gross, 4);
    v_line_disc := round(coalesce((v_line->>'discount_amount')::numeric, 0), 4);
    if v_line_disc < 0 or v_line_disc > v_gross then
      raise exception 'Linha % ("%"): desconto inválido.', v_i + 1, v_snapshot;
    end if;

    v_rate := (v_line->>'vat_rate')::numeric;
    if v_rate is null or v_rate not in (0, 9, 13.5, 23) then
      raise exception 'Linha % ("%"): taxa de VAT inválida (0, 9, 13,5 ou 23%%).', v_i + 1, v_snapshot;
    end if;
    v_vat_in := (v_line->>'vat_amount')::numeric;

    v_prepared := v_prepared || jsonb_build_object(
      'idx', v_i, 'item_id', v_item.id, 'target', v_target, 'line_type', v_line_type,
      'product_id', v_item.product_id, 'snapshot', v_snapshot, 'raw', v_raw,
      'qty', v_qty, 'unit', v_unit, 'base', v_base, 'unit_price', v_unit_price,
      'gross', v_gross, 'line_disc', v_line_disc, 'pre', v_gross - v_line_disc,
      'rate', v_rate, 'vat_in', v_vat_in, 'fin', v_fin,
      'remember_alias', coalesce((v_line->>'remember_alias')::boolean, true),
      'item_name', v_item.name, 'item_fin_missing', (v_item.id is not null and v_line_type = 'expense' and v_item.finance_category_id is null)
    );
    v_sum_pre := v_sum_pre + (v_gross - v_line_disc);
    if (v_gross - v_line_disc) > 0 then
      v_last_idx := v_i;
    end if;
  end loop;

  if v_header_discount > 0 and v_header_discount > v_sum_pre then
    raise exception 'O desconto geral (€%) é maior que o valor das linhas (€%).', v_header_discount, round(v_sum_pre, 2);
  end if;

  -- Cabeçalho (totais preenchidos no fim)
  begin
    insert into public.purchases (
      supplier_id, purchased_at, reference, notes, status, source, vat_recoverable,
      header_discount, client_request_id, created_by, updated_by
    ) values (
      v_supplier_id, v_date,
      nullif(left(btrim(coalesce(p_payload->>'reference', '')), 80), ''),
      nullif(left(btrim(coalesce(p_payload->>'notes', '')), 1000), ''),
      'confirmed', v_source, v_vat_recoverable, v_header_discount, v_req, auth.uid(), auth.uid()
    )
    returning * into v_purchase;
  exception when unique_violation then
    select id into v_existing from public.purchases where client_request_id = v_req;
    return jsonb_build_object('duplicate', true, 'purchase_id', v_existing);
  end;

  -- Passo 2: rateio do desconto geral, VAT, custo, gravação e estoque
  for v_i in 0 .. v_n - 1 loop
    v_p := v_prepared->v_i;

    if v_header_discount > 0 and (v_p->>'pre')::numeric > 0 then
      if v_i = v_last_idx then
        v_share := v_header_discount - v_alloc;
      else
        v_share := round(v_header_discount * (v_p->>'pre')::numeric / v_sum_pre, 4);
      end if;
      v_alloc := v_alloc + v_share;
    else
      v_share := 0;
    end if;

    v_net := (v_p->>'pre')::numeric - v_share;
    v_vat := round(v_net * (v_p->>'rate')::numeric / 100, 2);
    if v_p->>'vat_in' is not null then
      if abs((v_p->>'vat_in')::numeric - v_vat) > 0.05 then
        raise exception 'Linha % ("%"): VAT informado (€%) não confere com % %% de €% (€%).',
          v_i + 1, v_p->>'snapshot', (v_p->>'vat_in')::numeric, v_p->>'rate', round(v_net, 2), v_vat;
      end if;
      v_vat := round((v_p->>'vat_in')::numeric, 2);
    end if;
    v_cost := v_net + case when v_vat_recoverable then 0 else v_vat end;

    insert into public.purchase_lines (
      purchase_id, purchase_item_id, item_name_snapshot, quantity, unit, base_quantity, total_price,
      line_order, line_type, raw_description, unit_price, gross_amount, discount_amount,
      header_discount_share, net_amount, vat_rate, vat_amount, cost_value, finance_category_id
    ) values (
      v_purchase.id, nullif(v_p->>'item_id', '')::uuid, v_p->>'snapshot', (v_p->>'qty')::numeric, v_p->>'unit',
      (v_p->>'base')::numeric, v_net + v_vat,
      v_i + 1, v_p->>'line_type', v_p->>'raw', (v_p->>'unit_price')::numeric, (v_p->>'gross')::numeric,
      (v_p->>'line_disc')::numeric, v_share, v_net, (v_p->>'rate')::numeric, v_vat, v_cost,
      nullif(v_p->>'fin', '')::uuid
    )
    returning id into v_line_id;

    if v_p->>'target' = 'product' then
      perform public._product_purchase_apply(
        (v_p->>'product_id')::uuid, (v_p->>'base')::numeric::integer, v_cost, 'purchase_in', v_line_id,
        'Entrada por compra');
    elsif v_p->>'target' = 'item' then
      perform public._inventory_apply(
        (v_p->>'item_id')::uuid, (v_p->>'base')::numeric, v_cost, 'purchase_in', 'purchase_line', v_line_id,
        'Entrada por compra');
    end if;

    -- Despesa ligada a item sem categoria padrão: memoriza a categoria escolhida.
    if (v_p->>'item_fin_missing')::boolean then
      update public.purchase_items set finance_category_id = (v_p->>'fin')::uuid, updated_at = now()
       where id = (v_p->>'item_id')::uuid and finance_category_id is null;
    end if;

    -- Associação confirmada: guarda a descrição da nota como nome alternativo do item.
    if nullif(v_p->>'item_id', '') is not null and v_p->>'raw' is not null and (v_p->>'remember_alias')::boolean then
      v_norm_raw := public.normalize_purchase_text(v_p->>'raw');
      if v_norm_raw is not null and v_norm_raw <> public.normalize_purchase_text(v_p->>'item_name') then
        insert into public.purchase_item_aliases (purchase_item_id, alias, source, times_used, last_used_at, created_by)
        values ((v_p->>'item_id')::uuid, v_p->>'raw', 'purchase_confirmed', 1, now(), auth.uid())
        on conflict (normalized_alias) do update
          set purchase_item_id = excluded.purchase_item_id,
              times_used = case when public.purchase_item_aliases.purchase_item_id = excluded.purchase_item_id
                                then public.purchase_item_aliases.times_used + 1 else 1 end,
              source = 'purchase_confirmed',
              last_used_at = now();
      end if;
    end if;

    v_gross_total := v_gross_total + (v_p->>'gross')::numeric;
    v_line_disc_total := v_line_disc_total + (v_p->>'line_disc')::numeric;
    v_net_total := v_net_total + v_net;
    v_vat_total := v_vat_total + v_vat;
  end loop;

  v_computed := round(v_net_total, 2) + round(v_vat_total, 2);
  v_total_paid := round(coalesce(v_total_paid, v_computed), 2);
  if v_total_paid < 0 then
    raise exception 'Total pago inválido.';
  end if;
  if abs(v_total_paid - v_computed) > 1.00 then
    raise exception 'O total pago (€%) difere do total calculado pelas linhas (€%) em mais de €1,00. Confira os valores, descontos e VAT.',
      v_total_paid, v_computed;
  end if;

  update public.purchases
     set gross_total = round(v_gross_total, 2),
         discount_total = round(v_line_disc_total + v_header_discount, 2),
         net_total = round(v_net_total, 2),
         vat_total = round(v_vat_total, 2),
         total_paid = v_total_paid,
         rounding_adjustment = v_total_paid - v_computed
   where id = v_purchase.id
  returning * into v_purchase;

  -- Documentos anexados
  if p_payload ? 'document_ids' and jsonb_typeof(p_payload->'document_ids') = 'array' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_doc_ids
      from jsonb_array_elements_text(p_payload->'document_ids') x;
    if cardinality(v_doc_ids) > 0 then
      update public.purchase_documents set purchase_id = v_purchase.id
       where id = any (v_doc_ids) and purchase_id is null;
      get diagnostics v_doc_count = row_count;
      if v_doc_count <> cardinality(v_doc_ids) then
        raise exception 'Um dos documentos anexados não existe ou já pertence a outra compra.';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'purchase_id', v_purchase.id,
    'purchase', to_jsonb(v_purchase),
    'lines', (select coalesce(jsonb_agg(to_jsonb(pl) order by pl.line_order), '[]'::jsonb)
                from public.purchase_lines pl where pl.purchase_id = v_purchase.id)
  );
end;
$function$;

-- ------------------------------------------------------------------ 12. cancelar compra (estorno)
create or replace function public.cancel_purchase(p_purchase_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_purchase public.purchases%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_line record;
  v_product_id uuid;
  v_product_qty integer;
  v_has_item_mov boolean;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem cancelar compras.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'Compra não encontrada.';
  end if;
  if v_purchase.status = 'cancelled' then
    return jsonb_build_object('already_cancelled', true, 'purchase', to_jsonb(v_purchase));
  end if;

  for v_line in
    select pl.* from public.purchase_lines pl
     where pl.purchase_id = p_purchase_id and pl.line_type = 'stock'
     order by pl.line_order desc
  loop
    -- Estorna exatamente o que a confirmação moveu (pelo histórico, não pelo vínculo atual).
    select sm.product_id, sum(sm.quantity_change)::integer
      into v_product_id, v_product_qty
      from public.stock_movements sm
     where sm.source_type = 'purchase_line' and sm.source_id = v_line.id
     group by sm.product_id;

    if v_product_id is not null and v_product_qty > 0 then
      perform public._product_purchase_apply(
        v_product_id, -v_product_qty, -v_line.cost_value, 'purchase_reversal', v_line.id,
        'Estorno por cancelamento de compra: ' || v_reason);
    else
      select exists (
        select 1 from public.inventory_movements m
         where m.source_type = 'purchase_line' and m.source_id = v_line.id and m.movement_type = 'purchase_in'
      ) into v_has_item_mov;
      if v_has_item_mov then
        perform public._inventory_apply(
          v_line.purchase_item_id, -v_line.base_quantity, -v_line.cost_value, 'purchase_reversal',
          'purchase_line', v_line.id, 'Estorno por cancelamento de compra: ' || v_reason);
      end if;
    end if;
    v_product_id := null;
    v_product_qty := null;
  end loop;

  update public.purchases
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = left(v_reason, 500), updated_at = now(), updated_by = auth.uid()
   where id = p_purchase_id
  returning * into v_purchase;

  return jsonb_build_object('already_cancelled', false, 'purchase', to_jsonb(v_purchase));
end;
$function$;

-- ------------------------------------------------------------------ 13. sugestão de associação (similaridade)
-- Para cada descrição da nota: associação já confirmada (apelido) ou nome idêntico -> "exact";
-- senão até 3 candidatos por similaridade de trigramas. Nada é associado sem confirmação.
create or replace function public.suggest_purchase_item_matches(p_descriptions text[])
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_result jsonb := '[]'::jsonb;
  v_i integer;
  v_desc text;
  v_norm text;
  v_exact jsonb;
  v_candidates jsonb;
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  if p_descriptions is null then
    return v_result;
  end if;
  if cardinality(p_descriptions) > 200 then
    raise exception 'Descrições demais (máximo 200).';
  end if;

  for v_i in 1 .. coalesce(cardinality(p_descriptions), 0) loop
    v_desc := p_descriptions[v_i];
    v_norm := public.normalize_purchase_text(v_desc);
    v_exact := null;
    v_candidates := '[]'::jsonb;

    if v_norm is not null then
      select jsonb_build_object('purchase_item_id', pi.id, 'name', pi.name, 'via', 'alias', 'times_used', a.times_used)
        into v_exact
        from public.purchase_item_aliases a
        join public.purchase_items pi on pi.id = a.purchase_item_id
       where a.normalized_alias = v_norm and pi.active
       limit 1;

      if v_exact is null then
        select jsonb_build_object('purchase_item_id', pi.id, 'name', pi.name, 'via', 'name')
          into v_exact
          from public.purchase_items pi
         where pi.active and public.normalize_purchase_text(pi.name) = v_norm
         limit 1;
      end if;

      if v_exact is null then
        select coalesce(jsonb_agg(c order by c.score desc), '[]'::jsonb) into v_candidates
          from (
            select pi.id as purchase_item_id, pi.name,
                   round(greatest(
                     extensions.similarity(v_norm, coalesce(public.normalize_purchase_text(pi.name), '')),
                     coalesce((select max(extensions.similarity(v_norm, a.normalized_alias))
                                 from public.purchase_item_aliases a where a.purchase_item_id = pi.id), 0)
                   )::numeric, 3) as score
              from public.purchase_items pi
             where pi.active
             order by 3 desc
             limit 3
          ) c
         where c.score >= 0.25;
      end if;
    end if;

    v_result := v_result || jsonb_build_object(
      'index', v_i - 1, 'description', v_desc, 'normalized', v_norm,
      'exact', v_exact, 'candidates', v_candidates);
  end loop;

  return v_result;
end;
$function$;

-- ------------------------------------------------------------------ 14. apelidos, revisão e categoria de itens
create or replace function public.save_purchase_item_alias(p_purchase_item_id uuid, p_alias text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_norm text := public.normalize_purchase_text(p_alias);
  v_item public.purchase_items%rowtype;
  v_other record;
  v_alias public.purchase_item_aliases%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem gerenciar nomes alternativos.';
  end if;
  if v_norm is null then
    raise exception 'Informe o nome alternativo.';
  end if;
  select * into v_item from public.purchase_items where id = p_purchase_item_id;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;
  if public.normalize_purchase_text(v_item.name) = v_norm then
    raise exception 'Esse já é o nome principal do item.';
  end if;
  select pi.name into v_other from public.purchase_items pi
   where pi.id <> p_purchase_item_id and public.normalize_purchase_text(pi.name) = v_norm;
  if found then
    raise exception 'Esse nome é o nome principal de outro item ("%").', v_other.name;
  end if;
  select pi.name into v_other from public.purchase_item_aliases a join public.purchase_items pi on pi.id = a.purchase_item_id
   where a.normalized_alias = v_norm and a.purchase_item_id <> p_purchase_item_id;
  if found then
    raise exception 'Esse nome alternativo já está associado a "%". Remova-o de lá primeiro.', v_other.name;
  end if;

  insert into public.purchase_item_aliases (purchase_item_id, alias, source, created_by)
  values (p_purchase_item_id, left(btrim(p_alias), 300), 'manual', auth.uid())
  on conflict (normalized_alias) do update set alias = excluded.alias
  returning * into v_alias;

  return to_jsonb(v_alias);
end;
$function$;

create or replace function public.delete_purchase_item_alias(p_alias_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem gerenciar nomes alternativos.';
  end if;
  delete from public.purchase_item_aliases where id = p_alias_id;
end;
$function$;

create or replace function public.set_purchase_item_finance_category(p_purchase_item_id uuid, p_finance_category_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.purchase_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar itens de compra.';
  end if;
  if p_finance_category_id is not null
     and not exists (select 1 from public.finance_categories where id = p_finance_category_id and kind = 'expense') then
    raise exception 'Categoria financeira inválida.';
  end if;
  update public.purchase_items
     set finance_category_id = p_finance_category_id, needs_review = false, updated_at = now(), updated_by = auth.uid()
   where id = p_purchase_item_id
  returning * into v_item;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;
  return to_jsonb(v_item);
end;
$function$;

create or replace function public.mark_purchase_item_reviewed(p_purchase_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.purchase_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar itens de compra.';
  end if;
  update public.purchase_items set needs_review = false, updated_at = now(), updated_by = auth.uid()
   where id = p_purchase_item_id
  returning * into v_item;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;
  return to_jsonb(v_item);
end;
$function$;

-- ------------------------------------------------------------------ 15. documentos: registro e resultado do OCR
create or replace function public.register_purchase_document(
  p_storage_path text, p_file_name text, p_mime_type text, p_size_bytes integer)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_doc public.purchase_documents%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem anexar documentos de compra.';
  end if;
  if p_storage_path is null or p_storage_path !~ '^uploads/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$' then
    raise exception 'Caminho de documento inválido.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'purchase-documents' and o.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento. Envie o arquivo novamente.';
  end if;

  insert into public.purchase_documents (storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p_storage_path, left(nullif(btrim(coalesce(p_file_name, '')), ''), 200), p_mime_type, p_size_bytes, auth.uid())
  on conflict (storage_path) do nothing
  returning * into v_doc;

  if v_doc.id is null then
    select * into v_doc from public.purchase_documents where storage_path = p_storage_path;
  end if;
  return to_jsonb(v_doc);
end;
$function$;

-- Chamada só pelo Worker (service_role) depois de ler o documento com a IA.
create or replace function public.record_purchase_document_ocr(
  p_document_id uuid, p_status text, p_result jsonb, p_model text, p_error text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_status not in ('processing', 'done', 'failed') then
    raise exception 'Status de OCR inválido.';
  end if;
  update public.purchase_documents
     set ocr_status = p_status,
         ocr_result = case when p_status = 'done' then p_result else ocr_result end,
         ocr_model = coalesce(p_model, ocr_model),
         ocr_error = case when p_status = 'failed' then left(p_error, 500) else null end,
         ocr_processed_at = case when p_status = 'processing' then ocr_processed_at else now() end
   where id = p_document_id;
  if not found then
    raise exception 'Documento não encontrado.';
  end if;
end;
$function$;

-- ------------------------------------------------------------------ 16. RLS e permissões
alter table public.finance_categories enable row level security;
alter table public.purchase_item_aliases enable row level security;
alter table public.purchase_documents enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.product_cost_history enable row level security;

create policy finance_categories_select_staff on public.finance_categories for select to authenticated using (public.is_staff());
create policy purchase_item_aliases_select_staff on public.purchase_item_aliases for select to authenticated using (public.is_staff());
create policy purchase_documents_select_admin on public.purchase_documents for select to authenticated using (public.is_admin());
create policy inventory_movements_select_staff on public.inventory_movements for select to authenticated using (public.is_staff());
create policy product_cost_history_select_staff on public.product_cost_history for select to authenticated using (public.is_staff());

revoke all on public.finance_categories, public.purchase_item_aliases, public.purchase_documents,
              public.inventory_movements, public.product_cost_history from anon, authenticated;
grant select on public.finance_categories, public.purchase_item_aliases, public.purchase_documents,
                public.inventory_movements, public.product_cost_history to authenticated;
grant all on public.finance_categories, public.purchase_item_aliases, public.purchase_documents,
             public.inventory_movements, public.product_cost_history to service_role;

-- Funções internas: ninguém chama diretamente.
revoke all on function public._inventory_apply(uuid, numeric, numeric, text, text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public._product_purchase_apply(uuid, integer, numeric, text, uuid, text) from public, anon, authenticated;
revoke all on function public._ledger_immutable() from public, anon, authenticated;
revoke all on function public._purchase_items_guard_stock_changes() from public, anon, authenticated;

-- RPCs do app (admin/staff validado dentro de cada uma).
revoke all on function public.confirm_purchase(jsonb) from public, anon;
revoke all on function public.cancel_purchase(uuid, text) from public, anon;
revoke all on function public.suggest_purchase_item_matches(text[]) from public, anon;
revoke all on function public.save_purchase_item_alias(uuid, text) from public, anon;
revoke all on function public.delete_purchase_item_alias(uuid) from public, anon;
revoke all on function public.set_purchase_item_finance_category(uuid, uuid) from public, anon;
revoke all on function public.mark_purchase_item_reviewed(uuid) from public, anon;
revoke all on function public.register_purchase_document(text, text, text, integer) from public, anon;
grant execute on function public.confirm_purchase(jsonb) to authenticated;
grant execute on function public.cancel_purchase(uuid, text) to authenticated;
grant execute on function public.suggest_purchase_item_matches(text[]) to authenticated;
grant execute on function public.save_purchase_item_alias(uuid, text) to authenticated;
grant execute on function public.delete_purchase_item_alias(uuid) to authenticated;
grant execute on function public.set_purchase_item_finance_category(uuid, uuid) to authenticated;
grant execute on function public.mark_purchase_item_reviewed(uuid) to authenticated;
grant execute on function public.register_purchase_document(text, text, text, integer) to authenticated;

revoke all on function public.record_purchase_document_ocr(uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.record_purchase_document_ocr(uuid, text, jsonb, text, text) to service_role;

-- Fluxo antigo por lote: desativado para o app (funções mantidas para o rollback).
revoke execute on function public.save_purchase(uuid, uuid, date, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.delete_purchase(uuid) from public, anon, authenticated;
revoke execute on function public.create_lot_from_purchase_line(uuid, date) from public, anon, authenticated;
revoke execute on function public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) from public, anon, authenticated;

commit;
