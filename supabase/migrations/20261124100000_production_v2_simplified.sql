-- =====================================================================================
-- FASE C — Produção simplificada, sem dependência de lotes/compras específicas
-- -------------------------------------------------------------------------------------
-- Espetos:   espeto + matéria-prima + peso BRUTO (g) + quantidade produzida.
--            A matéria-prima sai do estoque do item pelo custo médio; os espetos entram
--            no estoque do produto; o custo do espeto = custo da matéria-prima / espetos.
-- Acompanhamentos: produto + peso final (g) + porção (g, configurada no produto) e,
--            opcionalmente, a ficha técnica usada e quantas vezes foi feita. Porções =
--            piso(peso final / porção). Com ficha técnica, os ingredientes (inclusive
--            sub-receitas) saem do estoque e formam o custo; sem ela, o custo fica
--            "sem dados" e nada é inventado.
-- Estoque insuficiente de matéria-prima: a produção é recusada com aviso; só passa com
--            autorização explícita (allow_negative), que fica registrada no lote.
-- Correção: cancelar com estorno (produtos e insumos voltam; nada é apagado).
-- Idempotente por client_request_id. As tabelas antigas (skewer_/side_production_*,
-- lots) ficam intactas (vazias) e as RPCs antigas são desativadas para o app.
-- Rollback: supabase/rollback/20261124100000_production_v2_simplified_down.sql
-- =====================================================================================

begin;

do $$
begin
  if exists (select 1 from public.skewer_production_batches) or exists (select 1 from public.side_production_batches) then
    raise exception 'Abortado: existem lotes de produção no modelo antigo. Revise antes de aplicar.';
  end if;
end $$;

-- ------------------------------------------------------------------ 1. produto: porção e padrões de produção
alter table public.products
  add column portion_grams numeric(10,2),
  add column production_raw_item_id uuid references public.purchase_items(id),
  add column production_recipe_id uuid references public.recipes(id);
alter table public.products
  add constraint products_portion_grams_positiva check (portion_grams is null or portion_grams > 0);
comment on column public.products.portion_grams is 'Tamanho da porção (g) de um acompanhamento — usado para calcular porções na Produção.';
comment on column public.products.production_raw_item_id is 'Última matéria-prima usada na produção deste espeto (sugestão padrão).';
comment on column public.products.production_recipe_id is 'Última ficha técnica usada na produção deste acompanhamento (sugestão padrão).';

-- ------------------------------------------------------------------ 2. lotes de produção
create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  product_id uuid not null references public.products(id),
  produced_at date not null,
  raw_item_id uuid references public.purchase_items(id),
  raw_quantity_g numeric(14,3),
  recipe_id uuid references public.recipes(id),
  recipe_multiplier numeric(10,3),
  output_weight_g numeric(14,3),
  portion_g numeric(10,2),
  units_produced integer not null,
  total_cost numeric(14,4),
  unit_cost numeric(16,6),
  cost_status text not null,
  product_cost_applied boolean not null default false,
  stock_negative_authorized boolean not null default false,
  status text not null default 'confirmed',
  notes text,
  client_request_id uuid not null unique,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  constraint production_batches_kind_valido check (kind in ('skewer', 'side')),
  constraint production_batches_espeto_coerente check (kind <> 'skewer' or (raw_item_id is not null and raw_quantity_g > 0)),
  constraint production_batches_acomp_coerente check (kind <> 'side' or (output_weight_g > 0 and portion_g > 0)),
  constraint production_batches_receita_coerente check ((recipe_id is null) = (recipe_multiplier is null) and (recipe_multiplier is null or recipe_multiplier > 0)),
  constraint production_batches_unidades_positivas check (units_produced > 0),
  constraint production_batches_cost_status_valido check (cost_status in ('complete', 'partial', 'missing')),
  constraint production_batches_status_valido check (status in ('confirmed', 'cancelled')),
  constraint production_batches_cancelamento_coerente check ((status = 'cancelled') = (cancelled_at is not null))
);
create index idx_production_batches_produced_at on public.production_batches (produced_at desc);
create index idx_production_batches_product on public.production_batches (product_id);

create table public.production_batch_inputs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.production_batches(id) on delete cascade,
  purchase_item_id uuid references public.purchase_items(id),
  ingredient_id uuid references public.ingredients(id),
  name_snapshot text not null,
  quantity numeric(14,3) not null,
  base_unit text not null,
  unit_cost numeric(20,10),
  total_cost numeric(14,4),
  stock_moved boolean not null default false,
  constraint production_batch_inputs_quantidade_positiva check (quantity > 0),
  constraint production_batch_inputs_origem check (purchase_item_id is not null or ingredient_id is not null)
);
create index idx_production_batch_inputs_batch on public.production_batch_inputs (batch_id);

create unique index ux_stock_movements_production_source on public.stock_movements (source_type, source_id, movement_type)
  where source_type = 'production_batch' and source_id is not null;

-- ------------------------------------------------------------------ 3. estorno de produção recompõe o custo médio
-- (mesma função da Fase B; única mudança: production_reversal com valor informado entra
--  como uma entrada ponderada, devolvendo o material pelo custo com que saiu.)
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

  if p_movement_type = 'purchase_in' or (p_movement_type = 'production_reversal' and p_value is not null) then
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

-- ------------------------------------------------------------------ 4. estoque/custo de produto por produção
-- Entrada (production_in) com valor: custo médio ponderado do produto. Sem valor (custo
-- desconhecido): só a quantidade entra, o custo do produto não muda. Estorno recusa
-- se o saldo do produto não cobre (já foi vendido).
create or replace function public._product_production_apply(
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
  if p_movement_type not in ('production_in', 'production_reversal') then
    raise exception 'Tipo de movimento inválido.';
  end if;
  if p_quantity is null or p_quantity = 0 then
    raise exception 'Quantidade do movimento inválida.';
  end if;

  select * into v_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Produto não encontrado.';
  end if;
  select unit_cost into v_a from public.product_costs where product_id = p_product_id;

  v_q := v_product.stock_quantity;
  v_new_q := v_q + p_quantity;
  if v_new_q < 0 then
    raise exception 'Estoque insuficiente de "%": saldo atual % un, estorno de % un. Os itens desta produção já foram vendidos ou baixados; ajuste o estoque antes de cancelar.',
      v_product.name, v_q, abs(p_quantity)
      using hint = 'larica:insufficient_stock';
  end if;

  v_new_a := v_a;
  if p_value is not null then
    if p_movement_type = 'production_in' then
      if v_q <= 0 or v_a is null then
        v_new_a := p_value / p_quantity;
      else
        v_new_a := (v_q * v_a + p_value) / v_new_q;
      end if;
    elsif v_new_q > 0 and v_a is not null then
      v_new_a := (v_q * v_a + p_value) / v_new_q;
      if v_new_a < 0 then
        v_new_a := v_a;
      end if;
    end if;
    v_new_a := round(v_new_a, 4);
  end if;

  update public.products set stock_quantity = v_new_q, updated_at = now() where id = p_product_id;

  insert into public.stock_movements (
    product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity,
    reason, source_type, source_id, created_by
  ) values (
    p_product_id, null, p_movement_type, p_quantity, v_q, v_new_q,
    p_reason, 'production_batch', p_source_id, auth.uid()
  )
  returning * into v_mov;

  if v_new_a is distinct from v_a then
    insert into public.product_costs (product_id, unit_cost, updated_at, updated_by)
    values (p_product_id, v_new_a, now(), auth.uid())
    on conflict (product_id) do update
      set unit_cost = excluded.unit_cost, updated_at = now(), updated_by = auth.uid();
  end if;
  if p_value is not null then
    insert into public.product_cost_history (
      product_id, unit_cost_before, unit_cost_after, stock_before, stock_after, source_type, source_id, reason, created_by
    ) values (
      p_product_id, v_a, v_new_a, v_q, v_new_q, 'production_batch', p_source_id, p_reason, auth.uid()
    );
  end if;

  return jsonb_build_object('movement', to_jsonb(v_mov), 'unit_cost_before', v_a, 'unit_cost_after', v_new_a);
end;
$function$;

-- ------------------------------------------------------------------ 5. ficha técnica -> ingredientes (recursivo)
-- Quantidade de cada ingrediente para fazer a receita p_factor vezes. Sub-receita usa
-- quantidade / rendimento da sub-receita (rendimento = soma dos itens, mesma unidade —
-- a mesma regra da tela de Fichas Técnicas).
create or replace function public._recipe_ingredient_quantities(p_recipe_id uuid, p_factor numeric, p_depth integer default 0)
returns table (ingredient_id uuid, quantity numeric)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_item record;
  v_yield numeric;
  v_units integer;
begin
  if p_depth > 10 then
    raise exception 'Ficha técnica com sub-receitas demais (possível ciclo).';
  end if;
  for v_item in
    select ri.item_type, ri.ingredient_id, ri.subrecipe_id, ri.quantity
      from public.recipe_items ri where ri.recipe_id = p_recipe_id
  loop
    if v_item.item_type = 'ingredient' then
      ingredient_id := v_item.ingredient_id;
      quantity := v_item.quantity * p_factor;
      return next;
    else
      select sum(x.quantity), count(distinct x.unit) into v_yield, v_units
        from public.recipe_items x where x.recipe_id = v_item.subrecipe_id;
      if v_units is distinct from 1 or v_yield is null or v_yield <= 0 then
        raise exception 'A sub-receita "%" não tem rendimento calculável (itens em unidades diferentes ou vazia).',
          (select name from public.recipes where id = v_item.subrecipe_id);
      end if;
      return query
        select s.ingredient_id, s.quantity
          from public._recipe_ingredient_quantities(v_item.subrecipe_id, p_factor * v_item.quantity / v_yield, p_depth + 1) s;
    end if;
  end loop;
end;
$function$;

-- ------------------------------------------------------------------ 6. plano de produção (usado pela prévia e pela confirmação)
create or replace function public._production_plan(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_kind text := p_payload->>'kind';
  v_product public.products%rowtype;
  v_item public.purchase_items%rowtype;
  v_product_mode text;
  v_raw_g numeric;
  v_units integer;
  v_out_g numeric;
  v_portion numeric;
  v_recipe_id uuid;
  v_mult numeric;
  v_inputs jsonb := '[]'::jsonb;
  v_ing record;
  v_cost numeric;
  v_unit_cost numeric;
  v_total numeric := 0;
  v_known integer := 0;
  v_count integer := 0;
  v_shortages jsonb := '[]'::jsonb;
  v_status text;
begin
  if v_kind not in ('skewer', 'side') then
    raise exception 'Tipo de produção inválido.';
  end if;
  begin
    select * into v_product from public.products where id = (p_payload->>'product_id')::uuid;
  exception when others then
    raise exception 'Produto inválido.';
  end;
  if v_product.id is null then
    raise exception 'Escolha o produto.';
  end if;
  if v_kind = 'skewer' and v_product.category <> 'skewers' then
    raise exception '"%" não é um espeto.', v_product.name;
  end if;
  if v_kind = 'side' and v_product.category <> 'sides' then
    raise exception '"%" não é um acompanhamento.', v_product.name;
  end if;

  if v_kind = 'skewer' then
    v_raw_g := (p_payload->>'raw_quantity_g')::numeric;
    v_units := (p_payload->>'units_produced')::numeric::integer;
    if v_raw_g is null or v_raw_g <= 0 then
      raise exception 'Informe o peso bruto da matéria-prima.';
    end if;
    if v_units is null or v_units <= 0 or (p_payload->>'units_produced')::numeric <> v_units then
      raise exception 'Informe quantos espetos foram produzidos (número inteiro).';
    end if;
    if nullif(p_payload->>'raw_item_id', '') is null then
      raise exception 'Escolha a matéria-prima usada.';
    end if;
    select * into v_item from public.purchase_items where id = (p_payload->>'raw_item_id')::uuid;
    if not found then
      raise exception 'Matéria-prima não encontrada.';
    end if;
    if not v_item.tracks_stock or v_item.base_unit <> 'g' then
      raise exception '"%" não é uma matéria-prima controlada por peso.', v_item.name;
    end if;
    if v_item.product_id is not null then
      select stock_mode into v_product_mode from public.products where id = v_item.product_id;
      if v_product_mode = 'purchased' then
        raise exception '"%" é um produto de revenda, não matéria-prima.', v_item.name;
      end if;
    end if;
    v_cost := case when v_item.avg_cost is null then null else round(v_raw_g * v_item.avg_cost, 4) end;
    v_inputs := jsonb_build_array(jsonb_build_object(
      'purchase_item_id', v_item.id, 'ingredient_id', v_item.ingredient_id, 'name', v_item.name,
      'quantity', v_raw_g, 'base_unit', 'g', 'unit_cost', v_item.avg_cost, 'total_cost', v_cost,
      'stock_moved', true, 'stock_before', v_item.stock_quantity));
    if v_item.stock_quantity < v_raw_g then
      v_shortages := v_shortages || jsonb_build_object('name', v_item.name, 'available', v_item.stock_quantity, 'required', v_raw_g, 'base_unit', 'g');
    end if;
    v_count := 1;
    if v_cost is not null then
      v_known := 1;
      v_total := v_cost;
    end if;
  else
    v_out_g := (p_payload->>'output_weight_g')::numeric;
    v_portion := coalesce((p_payload->>'portion_g')::numeric, v_product.portion_grams);
    if v_out_g is null or v_out_g <= 0 then
      raise exception 'Informe o peso final produzido.';
    end if;
    if v_portion is null or v_portion <= 0 then
      raise exception 'Informe o tamanho da porção (g) de "%".', v_product.name;
    end if;
    v_units := floor(v_out_g / v_portion);
    if v_units < 1 then
      raise exception 'O peso produzido (% g) não chega a uma porção de % g.', v_out_g, v_portion;
    end if;

    v_recipe_id := nullif(p_payload->>'recipe_id', '')::uuid;
    if v_recipe_id is not null then
      v_mult := coalesce((p_payload->>'recipe_multiplier')::numeric, 1);
      if v_mult <= 0 or v_mult > 1000 then
        raise exception 'Quantidade de vezes da ficha técnica inválida.';
      end if;
      if not exists (select 1 from public.recipes where id = v_recipe_id) then
        raise exception 'Ficha técnica não encontrada.';
      end if;
      for v_ing in
        select q.ingredient_id, sum(q.quantity) as quantity, i.name, i.base_unit,
               nullif(i.cost_per_base_unit, 0) as ing_cost,
               pi.id as item_id, pi.avg_cost, pi.stock_quantity, pi.tracks_stock, pi.base_unit as item_unit,
               (pi.product_id is not null and exists (select 1 from public.products pp where pp.id = pi.product_id and pp.stock_mode = 'purchased')) as item_no_produto
          from public._recipe_ingredient_quantities(v_recipe_id, v_mult) q
          join public.ingredients i on i.id = q.ingredient_id
          left join public.purchase_items pi on pi.ingredient_id = q.ingredient_id
         group by q.ingredient_id, i.name, i.base_unit, i.cost_per_base_unit, pi.id, pi.avg_cost, pi.stock_quantity, pi.tracks_stock, pi.base_unit, pi.product_id
         order by i.name
      loop
        v_unit_cost := coalesce(v_ing.avg_cost, v_ing.ing_cost);
        v_cost := case when v_unit_cost is null then null else round(v_ing.quantity * v_unit_cost, 4) end;
        v_inputs := v_inputs || jsonb_build_object(
          'purchase_item_id', v_ing.item_id, 'ingredient_id', v_ing.ingredient_id, 'name', v_ing.name,
          'quantity', round(v_ing.quantity, 3), 'base_unit', v_ing.base_unit, 'unit_cost', v_unit_cost, 'total_cost', v_cost,
          'stock_moved', (v_ing.item_id is not null and v_ing.tracks_stock and v_ing.item_unit = v_ing.base_unit and not v_ing.item_no_produto),
          'stock_before', v_ing.stock_quantity);
        if v_ing.item_id is not null and v_ing.tracks_stock and v_ing.item_unit = v_ing.base_unit and not v_ing.item_no_produto
           and v_ing.stock_quantity < round(v_ing.quantity, 3) then
          v_shortages := v_shortages || jsonb_build_object('name', v_ing.name, 'available', v_ing.stock_quantity, 'required', round(v_ing.quantity, 3), 'base_unit', v_ing.base_unit);
        end if;
        v_count := v_count + 1;
        if v_cost is not null then
          v_known := v_known + 1;
          v_total := v_total + v_cost;
        end if;
      end loop;
      if v_count = 0 then
        raise exception 'A ficha técnica escolhida não tem ingredientes.';
      end if;
    end if;
  end if;

  v_status := case when v_count = 0 or v_known = 0 then 'missing' when v_known < v_count then 'partial' else 'complete' end;

  return jsonb_build_object(
    'kind', v_kind,
    'product_id', v_product.id,
    'product_name', v_product.name,
    'product_stock', v_product.stock_quantity,
    'units_produced', v_units,
    'raw_item_id', v_item.id,
    'raw_quantity_g', v_raw_g,
    'grams_per_unit', case when v_kind = 'skewer' then round(v_raw_g / v_units, 1) end,
    'recipe_id', v_recipe_id,
    'recipe_multiplier', v_mult,
    'output_weight_g', v_out_g,
    'portion_g', v_portion,
    'leftover_g', case when v_kind = 'side' then round(v_out_g - v_units * v_portion, 1) end,
    'inputs', v_inputs,
    'total_cost', case when v_status = 'missing' then null else round(v_total, 4) end,
    'unit_cost', case when v_status = 'missing' then null else round(v_total / v_units, 6) end,
    'cost_status', v_status,
    'shortages', v_shortages
  );
end;
$function$;

create or replace function public.preview_production(p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not public.is_staff() then
    raise exception 'Acesso negado';
  end if;
  return public._production_plan(p_payload);
end;
$function$;

-- ------------------------------------------------------------------ 7. confirmar produção
create or replace function public.confirm_production(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_req uuid;
  v_existing uuid;
  v_plan jsonb;
  v_allow boolean := coalesce((p_payload->>'allow_negative')::boolean, false);
  v_date date;
  v_batch public.production_batches%rowtype;
  v_in jsonb;
  v_source text;
  v_apply_cost boolean;
  v_msg text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem registrar produções.';
  end if;
  begin
    v_req := (p_payload->>'client_request_id')::uuid;
  exception when others then
    raise exception 'Identificador da operação inválido.';
  end;
  if v_req is null then
    raise exception 'Identificador da operação ausente.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select id into v_existing from public.production_batches where client_request_id = v_req;
  if found then
    return jsonb_build_object('duplicate', true, 'batch_id', v_existing);
  end if;

  begin
    v_date := coalesce((p_payload->>'produced_at')::date, current_date);
  exception when others then
    raise exception 'Data da produção inválida.';
  end;
  if v_date > current_date + 1 or v_date < date '2020-01-01' then
    raise exception 'Data da produção fora do intervalo permitido.';
  end if;

  v_plan := public._production_plan(p_payload);

  if jsonb_array_length(v_plan->'shortages') > 0 and not v_allow then
    select string_agg(format('%s: disponível %s %s, necessário %s %s', s->>'name',
             trim(to_char((s->>'available')::numeric, 'FM999999990.###')), s->>'base_unit',
             trim(to_char((s->>'required')::numeric, 'FM999999990.###')), s->>'base_unit'), '; ')
      into v_msg from jsonb_array_elements(v_plan->'shortages') s;
    raise exception 'Estoque insuficiente — %. Confirme para registrar mesmo assim (o estoque ficará negativo).', v_msg
      using hint = 'larica:insufficient_stock';
  end if;

  v_apply_cost := v_plan->>'cost_status' = 'complete';

  insert into public.production_batches (
    kind, product_id, produced_at, raw_item_id, raw_quantity_g, recipe_id, recipe_multiplier,
    output_weight_g, portion_g, units_produced, total_cost, unit_cost, cost_status,
    product_cost_applied, stock_negative_authorized, notes, client_request_id, created_by
  ) values (
    v_plan->>'kind', (v_plan->>'product_id')::uuid, v_date,
    nullif(v_plan->>'raw_item_id', '')::uuid, (v_plan->>'raw_quantity_g')::numeric,
    nullif(v_plan->>'recipe_id', '')::uuid, (v_plan->>'recipe_multiplier')::numeric,
    (v_plan->>'output_weight_g')::numeric, (v_plan->>'portion_g')::numeric,
    (v_plan->>'units_produced')::integer, (v_plan->>'total_cost')::numeric, (v_plan->>'unit_cost')::numeric,
    v_plan->>'cost_status', v_apply_cost, jsonb_array_length(v_plan->'shortages') > 0,
    nullif(left(btrim(coalesce(p_payload->>'notes', '')), 500), ''), v_req, auth.uid()
  )
  returning * into v_batch;

  v_source := case when v_batch.kind = 'skewer' then 'skewer_production' else 'side_production' end;

  for v_in in select * from jsonb_array_elements(v_plan->'inputs') loop
    insert into public.production_batch_inputs (
      batch_id, purchase_item_id, ingredient_id, name_snapshot, quantity, base_unit, unit_cost, total_cost, stock_moved
    ) values (
      v_batch.id, nullif(v_in->>'purchase_item_id', '')::uuid, nullif(v_in->>'ingredient_id', '')::uuid,
      v_in->>'name', (v_in->>'quantity')::numeric, v_in->>'base_unit',
      (v_in->>'unit_cost')::numeric, (v_in->>'total_cost')::numeric, (v_in->>'stock_moved')::boolean
    );
    if (v_in->>'stock_moved')::boolean then
      perform public._inventory_apply(
        (v_in->>'purchase_item_id')::uuid, -(v_in->>'quantity')::numeric, null, 'production_out',
        v_source, v_batch.id,
        format('Produção de %s %s de %s', v_batch.units_produced, case when v_batch.kind = 'skewer' then 'espeto(s)' else 'porção(ões)' end, v_plan->>'product_name'),
        v_allow);
    end if;
  end loop;

  perform public._product_production_apply(
    v_batch.product_id, v_batch.units_produced,
    case when v_apply_cost then v_batch.total_cost else null end,
    'production_in', v_batch.id, 'Entrada por produção');

  -- Padrões para a próxima produção (menos cliques) e classificação do produto.
  update public.products
     set stock_mode = 'produced',
         production_raw_item_id = coalesce(v_batch.raw_item_id, production_raw_item_id),
         production_recipe_id = case when v_batch.kind = 'side' then v_batch.recipe_id else production_recipe_id end,
         portion_grams = case when v_batch.kind = 'side' then v_batch.portion_g else portion_grams end,
         updated_at = now()
   where id = v_batch.product_id;

  return jsonb_build_object('duplicate', false, 'batch_id', v_batch.id, 'batch', to_jsonb(v_batch), 'plan', v_plan);
end;
$function$;

-- ------------------------------------------------------------------ 8. cancelar produção (estorno)
create or replace function public.cancel_production(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_batch public.production_batches%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_mov record;
  v_source text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem cancelar produções.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  perform pg_advisory_xact_lock(hashtext('larica.inventory'));

  select * into v_batch from public.production_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Produção não encontrada.';
  end if;
  if v_batch.status = 'cancelled' then
    return jsonb_build_object('already_cancelled', true, 'batch', to_jsonb(v_batch));
  end if;

  -- 1) produto sai (recusa se já foi vendido)
  perform public._product_production_apply(
    v_batch.product_id, -v_batch.units_produced,
    case when v_batch.product_cost_applied then -v_batch.total_cost else null end,
    'production_reversal', v_batch.id, 'Estorno de produção: ' || v_reason);

  -- 2) insumos voltam pelo mesmo valor com que saíram
  v_source := case when v_batch.kind = 'skewer' then 'skewer_production' else 'side_production' end;
  for v_mov in
    select m.purchase_item_id, m.quantity, m.total_value
      from public.inventory_movements m
     where m.source_type = v_source and m.source_id = v_batch.id and m.movement_type = 'production_out'
  loop
    perform public._inventory_apply(
      v_mov.purchase_item_id, -v_mov.quantity, abs(v_mov.total_value), 'production_reversal',
      v_source, v_batch.id, 'Estorno de produção: ' || v_reason, true);
  end loop;

  update public.production_batches
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = left(v_reason, 500)
   where id = v_batch.id
  returning * into v_batch;

  return jsonb_build_object('already_cancelled', false, 'batch', to_jsonb(v_batch));
end;
$function$;

-- ------------------------------------------------------------------ 9. porção configurável no cadastro do produto
create or replace function public.set_product_portion(p_product_id uuid, p_portion_grams numeric)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_product public.products%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar a porção.';
  end if;
  if p_portion_grams is not null and (p_portion_grams <= 0 or p_portion_grams > 100000) then
    raise exception 'Tamanho de porção inválido.';
  end if;
  update public.products set portion_grams = p_portion_grams, updated_at = now()
   where id = p_product_id
  returning * into v_product;
  if not found then
    raise exception 'Produto não encontrado.';
  end if;
  return jsonb_build_object('id', v_product.id, 'portion_grams', v_product.portion_grams);
end;
$function$;

-- ------------------------------------------------------------------ 10. RLS e permissões
alter table public.production_batches enable row level security;
alter table public.production_batch_inputs enable row level security;
create policy production_batches_select_staff on public.production_batches for select to authenticated using (public.is_staff());
create policy production_batch_inputs_select_staff on public.production_batch_inputs for select to authenticated using (public.is_staff());
revoke all on public.production_batches, public.production_batch_inputs from anon, authenticated;
grant select on public.production_batches, public.production_batch_inputs to authenticated;
grant all on public.production_batches, public.production_batch_inputs to service_role;

revoke all on function public._product_production_apply(uuid, integer, numeric, text, uuid, text) from public, anon, authenticated;
revoke all on function public._recipe_ingredient_quantities(uuid, numeric, integer) from public, anon, authenticated;
revoke all on function public._production_plan(jsonb) from public, anon, authenticated;
revoke all on function public._inventory_apply(uuid, numeric, numeric, text, text, uuid, text, boolean) from public, anon, authenticated;

revoke all on function public.preview_production(jsonb) from public, anon;
revoke all on function public.confirm_production(jsonb) from public, anon;
revoke all on function public.cancel_production(uuid, text) from public, anon;
revoke all on function public.set_product_portion(uuid, numeric) from public, anon;
grant execute on function public.preview_production(jsonb) to authenticated;
grant execute on function public.confirm_production(jsonb) to authenticated;
grant execute on function public.cancel_production(uuid, text) to authenticated;
grant execute on function public.set_product_portion(uuid, numeric) to authenticated;

-- Fluxo antigo de produção por lote: desativado para o app (funções mantidas para o rollback).
revoke execute on function public.save_skewer_production_batch(uuid, uuid, uuid, uuid, date, numeric, numeric, numeric, numeric, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.save_side_production_batch(uuid, uuid, date, numeric, text, numeric, text, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.delete_skewer_production_batch(uuid) from public, anon, authenticated;
revoke execute on function public.delete_side_production_batch(uuid) from public, anon, authenticated;
revoke execute on function public.apply_skewer_production_cost(uuid) from public, anon, authenticated;
revoke execute on function public.apply_side_production_cost(uuid) from public, anon, authenticated;

commit;
