-- Etapa K3: Compras alimentam automaticamente o estoque de Produtos com
-- stock_mode='purchased' (ex.: Coca-Cola). Produtos 'produced'/'untracked'
-- nunca são tocados por esta migration. Nenhum backfill/cutoff: saldo
-- atual de cada produto (ex.: Coca=20) é tratado como saldo de abertura —
-- só compras novas/editadas/excluídas a partir de agora reconciliam.
--
-- Auditoria ao vivo (K3A) confirmou: stock_movements.movement_type CHECK
-- hoje só permite sale/manual_addition/manual_removal/cancellation, sem
-- source_type/source_id/purchase_id; products.stock_quantity é integer
-- NOT NULL DEFAULT 0 sem CHECK de não-negatividade (protegido só pelos
-- UPDATEs atômicos já usados em create_customer_order/adjust_stock).
--
-- =============================================================
-- 1. stock_movements ganha source_type/source_id (rastreia a origem de
--    movimentos que não são Pedido — nesta etapa só 'purchase_line').
-- =============================================================

alter table public.stock_movements
  add column source_type text null,
  add column source_id uuid null;

create index idx_stock_movements_source on public.stock_movements (source_type, source_id);

-- =============================================================
-- 2. CHECK de movement_type ganha purchase_in/purchase_reversal.
--
-- O nome real da constraint não foi trazido pela auditoria K3A (só os
-- valores permitidos) — em vez de supor um nome, localiza dinamicamente o
-- CHECK que menciona movement_type e o remove antes de recriar. Aborta
-- com erro claro se não encontrar exatamente um, nunca adivinha.
-- =============================================================

do $$
declare
  v_check_name text;
begin
  select conname into v_check_name
    from pg_constraint
   where conrelid = 'public.stock_movements'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%movement_type%';

  if v_check_name is null then
    raise exception 'Não foi possível localizar o CHECK de movement_type em stock_movements — abortando.';
  end if;

  execute format('alter table public.stock_movements drop constraint %I', v_check_name);
end $$;

alter table public.stock_movements
  add constraint stock_movements_movement_type_valido
  check (movement_type in ('sale', 'manual_addition', 'manual_removal', 'cancellation', 'purchase_in', 'purchase_reversal'));

-- =============================================================
-- 3. Helper interno: _reconcile_purchase_line_product_stock.
--
-- Resolve purchase_line -> purchase_item -> product sempre a partir do
-- banco (nunca confia em product_id/quantity/stock_mode vindos do
-- client). Só age quando purchase_item.product_id IS NOT NULL e
-- product.stock_mode='purchased' — caso contrário retorna noop sem tocar
-- stock_quantity (produced/untracked/sem vínculo ficam intocados).
--
-- p_desired_net_override: quando NULL (chamadas normais), desired_net lê
-- purchase_lines.base_quantity ao vivo. Quando 0 (linha sendo removida de
-- uma compra que continua existindo, ou compra inteira sendo excluída),
-- força desired_net=0 -- precisa ser chamado ANTES da linha ser apagada,
-- enquanto ainda é possível resolver o vínculo produto/item.
--
-- Idempotência: reconciliação por NET (old_net = soma de purchase_in -
-- purchase_reversal já registrados para esta linha), nunca por flag
-- client-side -- chamar de novo sem mudança real produz delta=0, noop.
--
-- Sem EXECUTE para PUBLIC/anon/authenticated -- só chamado internamente
-- por create_lot_from_purchase_line/save_purchase (SECURITY DEFINER
-- chamando SECURITY DEFINER valida contra o dono, não contra o chamador).
-- =============================================================

CREATE FUNCTION public._reconcile_purchase_line_product_stock(
  p_purchase_line_id uuid,
  p_desired_net_override numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_line           public.purchase_lines%rowtype;
  v_item           public.purchase_items%rowtype;
  v_product        public.products%rowtype;
  v_desired_net    numeric;
  v_old_net        numeric;
  v_delta          numeric;
  v_movement_type  text;
  v_balance_after  integer;
  v_balance_before integer;
  v_movement       public.stock_movements%rowtype;
begin
  select * into v_line from public.purchase_lines where id = p_purchase_line_id;
  if not found then
    raise exception 'Linha de compra não encontrada.';
  end if;

  select * into v_item from public.purchase_items where id = v_line.purchase_item_id;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;

  if v_item.product_id is null then
    return jsonb_build_object('noop', true, 'reason', 'sem_vinculo_produto');
  end if;

  select * into v_product from public.products where id = v_item.product_id for update;
  if not found then
    raise exception 'Produto vinculado não encontrado.';
  end if;

  if v_product.stock_mode <> 'purchased' then
    return jsonb_build_object('noop', true, 'reason', 'stock_mode_nao_purchased');
  end if;

  if not v_item.tracks_stock then
    raise exception 'Produto comprado para revenda deve controlar estoque.';
  end if;
  if v_item.base_unit is distinct from 'un' then
    raise exception 'Produto comprado para revenda deve usar unidade-base un.';
  end if;

  v_desired_net := coalesce(p_desired_net_override, v_line.base_quantity, 0);
  if v_desired_net <> floor(v_desired_net) then
    raise exception 'Quantidade da compra para produto de revenda deve ser uma quantidade inteira.';
  end if;

  select coalesce(sum(quantity_change), 0) into v_old_net
    from public.stock_movements
   where source_type = 'purchase_line'
     and source_id = p_purchase_line_id
     and movement_type in ('purchase_in', 'purchase_reversal');

  v_delta := v_desired_net - v_old_net;
  if v_delta = 0 then
    return jsonb_build_object('noop', true, 'reason', 'delta_zero', 'net', v_old_net);
  end if;

  v_movement_type := case when v_delta > 0 then 'purchase_in' else 'purchase_reversal' end;

  update public.products
     set stock_quantity = stock_quantity + v_delta,
         updated_at = now()
   where id = v_product.id
     and stock_quantity + v_delta >= 0
  returning stock_quantity into v_balance_after;

  if not found then
    raise exception 'Estoque atual não permite reduzir esta compra para a quantidade informada.';
  end if;
  v_balance_before := v_balance_after - v_delta;

  insert into public.stock_movements (
    product_id, order_id, movement_type, quantity_change, previous_quantity, new_quantity,
    reason, source_type, source_id, created_by
  ) values (
    v_product.id, null, v_movement_type, v_delta, v_balance_before, v_balance_after,
    case when v_delta > 0 then 'Entrada automática por compra' else 'Reversão automática por edição de compra' end,
    'purchase_line', p_purchase_line_id, auth.uid()
  )
  returning * into v_movement;

  return jsonb_build_object('noop', false, 'movement', to_jsonb(v_movement));
end;
$function$;

REVOKE ALL ON FUNCTION public._reconcile_purchase_line_product_stock(uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._reconcile_purchase_line_product_stock(uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public._reconcile_purchase_line_product_stock(uuid, numeric) FROM authenticated;

-- =============================================================
-- 4. create_lot_from_purchase_line — CREATE OR REPLACE, mesma assinatura
--    já executada. Única mudança: chama o helper acima depois que lote e
--    lot_movement 'purchase' inicial são criados com sucesso. Cobre os
--    dois únicos call-sites existentes (linha nova em save_purchase, e
--    conversão retroativa em finalize_purchase_item) num só lugar --
--    finalize_purchase_item não precisa de nenhuma mudança própria.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_lot_from_purchase_line(
  p_purchase_line_id uuid,
  p_expiration_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_line     public.purchase_lines%rowtype;
  v_purchase public.purchases%rowtype;
  v_item     public.purchase_items%rowtype;
  v_lot      public.lots%rowtype;
  v_movement public.lot_movements%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem gerar lotes.';
  end if;

  select * into v_line from public.purchase_lines where id = p_purchase_line_id for update;
  if not found then
    raise exception 'Linha de compra não encontrada.';
  end if;

  select * into v_purchase from public.purchases where id = v_line.purchase_id;
  if not found then
    raise exception 'Compra não encontrada.';
  end if;

  select * into v_item from public.purchase_items where id = v_line.purchase_item_id;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;

  if not v_item.tracks_stock then
    raise exception 'Este item não controla estoque.';
  end if;

  if exists (select 1 from public.lots where purchase_line_id = p_purchase_line_id) then
    raise exception 'Esta linha de compra já gerou um lote.';
  end if;

  if p_expiration_date is not null and p_expiration_date < v_purchase.purchased_at then
    raise exception 'Data de validade não pode ser anterior à data da compra.';
  end if;

  insert into public.lots (
    purchase_line_id, purchase_item_id, received_at, expiration_date,
    initial_quantity, remaining_quantity, base_unit, unit_cost_base,
    status, created_by, updated_by
  ) values (
    v_line.id, v_item.id, v_purchase.purchased_at, p_expiration_date,
    v_line.base_quantity, v_line.base_quantity, v_item.base_unit, v_line.unit_cost_base,
    'available', auth.uid(), auth.uid()
  )
  returning * into v_lot;

  insert into public.lot_movements (
    lot_id, purchase_item_id, movement_type, quantity, balance_before, balance_after,
    source_type, source_id, created_by
  ) values (
    v_lot.id, v_item.id, 'purchase', v_line.base_quantity, 0, v_line.base_quantity,
    'purchase_line', v_line.id, auth.uid()
  )
  returning * into v_movement;

  -- Etapa K3: credita automaticamente o estoque de Produto quando esta
  -- linha for de um produto stock_mode='purchased' -- noop em qualquer
  -- outro caso (produced/untracked/sem vínculo).
  perform public._reconcile_purchase_line_product_stock(v_line.id);

  return jsonb_build_object('lot', to_jsonb(v_lot), 'movement', to_jsonb(v_movement));
end;
$function$;

REVOKE ALL ON FUNCTION public.create_lot_from_purchase_line(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_lot_from_purchase_line(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_lot_from_purchase_line(uuid, date) TO authenticated;

-- =============================================================
-- 5. save_purchase — CREATE OR REPLACE, mesma assinatura já executada.
--    Duas mudanças cirúrgicas: (a) ramo "linha existente, lote já
--    existe" (atualiza lots/lot_movements diretamente, sem passar por
--    create_lot_from_purchase_line) ganha uma chamada explícita ao
--    helper logo depois; (b) loop de linhas removidas ganha uma chamada
--    ao helper com override=0 ANTES de apagar a purchase_line (só assim
--    ainda é possível resolver item/produto). O ramo "linha nova" e o
--    ramo "lote ainda não existe" já ficam cobertos de graça, porque
--    ambos chamam create_lot_from_purchase_line (item 4 acima).
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_purchase(
  p_purchase_id uuid,
  p_supplier_id uuid,
  p_purchased_at date,
  p_reference text,
  p_notes text,
  p_lines jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_user_id           uuid := auth.uid();
  v_purchase          public.purchases%rowtype;
  v_has_consumo       boolean;
  v_line              jsonb;
  v_line_id           uuid;
  v_purchase_item_id  uuid;
  v_item_name         text;
  v_normalized        text;
  v_quantity          numeric;
  v_unit              text;
  v_total_price       numeric;
  v_expiration        date;
  v_item              public.purchase_items%rowtype;
  v_base_quantity     numeric;
  v_existing_line     public.purchase_lines%rowtype;
  v_new_line          public.purchase_lines%rowtype;
  v_lot               public.lots%rowtype;
  v_incoming_line_ids uuid[] := '{}';
  v_removed_line      record;
  v_product_stock_mode text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar compras.';
  end if;

  if p_purchased_at is null then
    raise exception 'Data da compra obrigatória.';
  end if;

  if p_supplier_id is not null and not exists (select 1 from public.suppliers where id = p_supplier_id) then
    raise exception 'Fornecedor não encontrado.';
  end if;

  -- Compra deve ter pelo menos 1 linha — diferente das RPCs de Produção,
  -- aqui NULL/[] nunca são válidos.
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Itens da compra devem ser enviados como uma lista.';
  end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'Adicione pelo menos um item à compra.';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Item da compra inválido.';
    end if;
  end loop;

  -- Cria ou edita o cabeçalho.
  if p_purchase_id is null then
    insert into public.purchases (supplier_id, purchased_at, reference, notes, created_by, updated_by)
    values (p_supplier_id, p_purchased_at, p_reference, p_notes, v_user_id, v_user_id)
    returning * into v_purchase;
    v_has_consumo := false;
  else
    select * into v_purchase from public.purchases where id = p_purchase_id for update;
    if not found then
      raise exception 'Compra não encontrada.';
    end if;

    -- Detecta consumo real: qualquer lote desta compra com movimento
    -- diferente do 'purchase' inicial.
    select exists (
      select 1
        from public.lot_movements lm
        join public.lots l on l.id = lm.lot_id
       where l.purchase_line_id in (select id from public.purchase_lines where purchase_id = p_purchase_id)
         and lm.movement_type <> 'purchase'
    ) into v_has_consumo;

    if v_has_consumo and p_purchased_at is distinct from v_purchase.purchased_at then
      raise exception 'Esta compra já possui lotes com movimentação e não pode ter a data alterada.';
    end if;

    update public.purchases set
      supplier_id  = p_supplier_id,
      purchased_at = p_purchased_at,
      reference    = p_reference,
      notes        = p_notes,
      updated_at   = now(),
      updated_by   = v_user_id
    where id = p_purchase_id
    returning * into v_purchase;
  end if;

  -- Compra com consumo real: só metadados foram alterados acima — linhas/
  -- lotes/movimentos permanecem intocados, p_lines é ignorado por
  -- completo (mesmo já validado estruturalmente acima).
  if v_has_consumo then
    return jsonb_build_object(
      'purchase', to_jsonb(v_purchase),
      'lines', coalesce((select jsonb_agg(to_jsonb(pl)) from public.purchase_lines pl where pl.purchase_id = v_purchase.id), '[]'::jsonb),
      'lots', coalesce((select jsonb_agg(to_jsonb(l)) from public.lots l where l.purchase_line_id in (select id from public.purchase_lines where purchase_id = v_purchase.id)), '[]'::jsonb),
      'movements', '[]'::jsonb
    );
  end if;

  -- Sem consumo: reconcilia as linhas por completo.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    begin
      v_line_id := (v_line->>'line_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Identificador de linha inválido.';
    end;
    begin
      v_purchase_item_id := (v_line->>'purchase_item_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Item de compra inválido.';
    end;
    begin
      v_quantity := (v_line->>'quantity')::numeric;
    exception when invalid_text_representation then
      raise exception 'Quantidade inválida.';
    end;
    begin
      v_total_price := (v_line->>'total_price')::numeric;
    exception when invalid_text_representation then
      raise exception 'Preço inválido.';
    end;
    begin
      v_expiration := (v_line->>'expiration_date')::date;
    exception when invalid_text_representation then
      raise exception 'Data de validade inválida.';
    end;
    v_unit := v_line->>'unit';

    if v_quantity is null or v_quantity <= 0 then raise exception 'Quantidade deve ser maior que zero.'; end if;
    if v_total_price is null or v_total_price < 0 then raise exception 'Preço inválido.'; end if;
    if v_unit is null or v_unit not in ('g','kg','ml','l','un') then raise exception 'Unidade inválida.'; end if;
    if v_line_id is not null and p_purchase_id is null then
      raise exception 'Linha inválida para uma nova compra.';
    end if;

    if v_line_id is not null then
      -- Linha existente: item_name é sempre ignorado (item imutável).
      -- purchase_item_id continua obrigatório e não pode divergir do já
      -- salvo — trocar o item de uma linha existente exige remover e
      -- adicionar de novo.
      if v_purchase_item_id is null then
        raise exception 'Selecione o item de compra.';
      end if;

      select *
        into v_existing_line
        from public.purchase_lines
       where id = v_line_id
         and purchase_id = v_purchase.id
       for update;
      if not found then raise exception 'Linha de compra não encontrada nesta compra.'; end if;
      if v_existing_line.purchase_item_id <> v_purchase_item_id then
        raise exception 'Não é permitido alterar o item de uma linha existente — remova e adicione novamente.';
      end if;

      select * into v_item from public.purchase_items where id = v_purchase_item_id;
      if v_item.id is null then raise exception 'Item de compra não encontrado.'; end if;

    else
      -- Linha nova: item vem por purchase_item_id (fluxo já existente) OU
      -- por item_name digitado (resolve item existente por nome
      -- normalizado, ou cria um provisório: needs_review=true,
      -- tracks_stock=false, base_unit=NULL, sem vínculos).
      if v_purchase_item_id is not null then
        select * into v_item from public.purchase_items where id = v_purchase_item_id;
        if v_item.id is null then raise exception 'Item de compra não encontrado.'; end if;
        if not v_item.active then raise exception 'Item de compra inativo não pode ser usado em uma nova linha.'; end if;
      else
        v_item_name := trim(regexp_replace(coalesce(v_line->>'item_name', ''), '\s+', ' ', 'g'));
        if v_item_name = '' then
          raise exception 'Selecione ou digite um item de compra.';
        end if;

        -- Mesma expressão lógica da coluna gerada
        -- purchase_items.normalized_name (sem depender de unaccent) —
        -- v_item_name já está trim+colapsado, só falta lower+translate.
        v_normalized := translate(
          lower(v_item_name),
          'áàãâäéèêëíìîïóòõôöúùûüçñ',
          'aaaaaeeeeiiiiooooouuuucn'
        );

        select * into v_item from public.purchase_items where normalized_name = v_normalized;

        if v_item.id is null then
          -- Criação atômica — ON CONFLICT protege contra duas transações
          -- concorrentes criando o mesmo nome ao mesmo tempo
          -- (idx_purchase_items_normalized_name_unico, Etapa F1).
          insert into public.purchase_items (
            name, category, tracks_stock, base_unit, active, needs_review, created_by, updated_by
          ) values (
            v_item_name, 'other', false, null, true, true, v_user_id, v_user_id
          )
          on conflict (normalized_name) do nothing
          returning * into v_item;

          if v_item.id is null then
            select * into v_item from public.purchase_items where normalized_name = v_normalized;
          end if;
        end if;

        if not v_item.active then
          raise exception 'Item de compra inativo não pode ser usado em uma nova linha.';
        end if;

        v_purchase_item_id := v_item.id;
      end if;
    end if;

    -- Correção K3: barreira forte, independente de já existir lote ou de
    -- tracks_stock -- nunca deixar o fluxo pular silenciosamente o
    -- helper de reconciliação de estoque por causa de uma configuração
    -- incoerente do Item de Compra. Roda pra TODA linha (existente ou
    -- nova), antes de qualquer decisão de criar/editar lote.
    if v_item.product_id is not null then
      select stock_mode into v_product_stock_mode from public.products where id = v_item.product_id;
      if v_product_stock_mode = 'purchased' then
        if not v_item.tracks_stock then
          raise exception 'Produto comprado para revenda deve controlar estoque.';
        end if;
        if v_item.base_unit is distinct from 'un' then
          raise exception 'Produto comprado para revenda deve usar unidade-base un.';
        end if;
      end if;
    end if;

    if not v_item.tracks_stock and v_expiration is not null then
      raise exception 'Item sem controle de estoque não pode ter validade.';
    end if;

    -- Conversão server-side, nunca peso<->volume<->unidade. base_unit NULL
    -- só é possível quando tracks_stock=false (CHECK purchase_items_
    -- base_unit_coerente já garante isso na tabela) — nesse caso aceita
    -- qualquer unit digitada e nunca converte (base_quantity fica NULL),
    -- cobrindo tanto item provisório recém-criado quanto item já
    -- finalizado como "só financeiro" (tracks_stock=false, base_unit=NULL
    -- de propósito) — a condição é sempre tracks_stock, nunca needs_review.
    if v_item.base_unit = 'g' then
      if v_unit = 'g' then v_base_quantity := v_quantity;
      elsif v_unit = 'kg' then v_base_quantity := v_quantity * 1000;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
    elsif v_item.base_unit = 'ml' then
      if v_unit = 'ml' then v_base_quantity := v_quantity;
      elsif v_unit = 'l' then v_base_quantity := v_quantity * 1000;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
    elsif v_item.base_unit = 'un' then
      if v_unit = 'un' then v_base_quantity := v_quantity;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
    elsif v_item.base_unit is null then
      if v_item.tracks_stock then
        raise exception 'Item de compra sem unidade-base não pode controlar estoque.';
      end if;
      v_base_quantity := null;
    else
      raise exception 'Unidade-base do item de compra é inválida.';
    end if;

    if v_line_id is not null then
      v_incoming_line_ids := v_incoming_line_ids || v_line_id;

      update public.purchase_lines set
        item_name_snapshot = v_item.name,
        quantity           = v_quantity,
        unit               = v_unit,
        base_quantity      = v_base_quantity,
        total_price        = v_total_price
      where id = v_line_id
      returning * into v_new_line;

      if v_item.tracks_stock and v_base_quantity is not null then
        select * into v_lot from public.lots where purchase_line_id = v_line_id for update;
        if found then
          -- Lote já existe e nunca foi consumido (garantido pelo ramo
          -- v_has_consumo=false) — corrige em vez de recriar.
          if v_expiration is not null and v_expiration < v_purchase.purchased_at then
            raise exception 'Data de validade não pode ser anterior à data da compra.';
          end if;
          update public.lots set
            received_at        = v_purchase.purchased_at,
            expiration_date     = v_expiration,
            initial_quantity    = v_base_quantity,
            remaining_quantity  = v_base_quantity,
            unit_cost_base      = v_new_line.unit_cost_base,
            updated_at          = now(),
            updated_by          = v_user_id
          where id = v_lot.id;

          update public.lot_movements set
            quantity      = v_base_quantity,
            balance_after = v_base_quantity
          where lot_id = v_lot.id and movement_type = 'purchase';

          -- Etapa K3: este ramo atualiza lots/lot_movements direto (nunca
          -- passa por create_lot_from_purchase_line), então precisa
          -- chamar o reconciliador de estoque de Produto explicitamente.
          perform public._reconcile_purchase_line_product_stock(v_line_id);
        else
          perform public.create_lot_from_purchase_line(v_line_id, v_expiration);
        end if;
      end if;
    else
      insert into public.purchase_lines (
        purchase_id, purchase_item_id, item_name_snapshot, quantity, unit, base_quantity, total_price
      ) values (
        v_purchase.id, v_item.id, v_item.name, v_quantity, v_unit, v_base_quantity, v_total_price
      )
      returning * into v_new_line;

      -- Mantém a linha recém-criada na reconciliação final.
      v_incoming_line_ids := v_incoming_line_ids || v_new_line.id;

      if v_item.tracks_stock and v_base_quantity is not null then
        perform public.create_lot_from_purchase_line(v_new_line.id, v_expiration);
      end if;
    end if;
  end loop;

  -- Remove linhas que não vieram no payload — seguro aqui porque já
  -- confirmamos (v_has_consumo=false) que nenhum lote desta compra teve
  -- consumo além da entrada inicial.
  for v_removed_line in
    select * from public.purchase_lines
     where purchase_id = v_purchase.id
       and not (id = any(v_incoming_line_ids))
  loop
    -- Etapa K3: zera o crédito de estoque de Produto desta linha (se
    -- houver) ANTES de apagar a purchase_line -- só assim ainda é
    -- possível resolver item/produto pelo id da linha. Override=0 força
    -- desired_net=0 independente do último base_quantity salvo. A compra
    -- continua existindo (só este item saiu dela), então o reconciliador
    -- normal (com rastro em stock_movements) é o correto aqui -- diferente
    -- de excluir a compra inteira (delete_purchase, que apaga sem rastro).
    perform public._reconcile_purchase_line_product_stock(v_removed_line.id, 0);

    delete from public.lot_movements where lot_id in (select id from public.lots where purchase_line_id = v_removed_line.id);
    delete from public.lots where purchase_line_id = v_removed_line.id;
    delete from public.purchase_lines where id = v_removed_line.id;
  end loop;

  return jsonb_build_object(
    'purchase', to_jsonb(v_purchase),
    'lines', coalesce((select jsonb_agg(to_jsonb(pl)) from public.purchase_lines pl where pl.purchase_id = v_purchase.id), '[]'::jsonb),
    'lots', coalesce((select jsonb_agg(to_jsonb(l)) from public.lots l where l.purchase_line_id in (select id from public.purchase_lines where purchase_id = v_purchase.id)), '[]'::jsonb),
    'movements', coalesce((select jsonb_agg(to_jsonb(lm)) from public.lot_movements lm where lm.lot_id in (select id from public.lots where purchase_line_id in (select id from public.purchase_lines where purchase_id = v_purchase.id))), '[]'::jsonb)
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) TO authenticated;

-- =============================================================
-- 6. delete_purchase — CREATE OR REPLACE, mesma assinatura já executada
--    (Regra B da J8 intacta). Único bloco novo: depois de TODAS as
--    validações existentes (referências/movement_types/net/saldo) e ANTES
--    dos DELETEs físicos, reverte o crédito de estoque de Produto de
--    cada purchase_line vinculada a um produto stock_mode='purchased' e
--    apaga esses stock_movements por completo -- diferente da reversão
--    normal de edição (helper, que sempre deixa um purchase_reversal
--    rastreável): aqui a compra inteira deixa de existir, então suas
--    entradas de estoque também desaparecem por completo (mesma
--    filosofia já usada para lot_movements/lots na própria J8). Por isso
--    este bloco NÃO chama o helper -- reverte e apaga direto.
-- =============================================================

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
  v_purchase_line record;
  v_product public.products%rowtype;
  v_credited_net integer;
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

  -- 5) Etapa K3: reverte e apaga (sem deixar purchase_reversal rastreável
  -- -- a compra inteira está sumindo) o crédito de estoque de Produto de
  -- cada purchase_line vinculada a um produto stock_mode='purchased'.
  -- order by product_id trava produtos em ordem determinística, mesma
  -- disciplina anti-deadlock usada acima para lots.
  for v_purchase_line in
    select pl.id, pi.product_id
      from public.purchase_lines pl
      join public.purchase_items pi on pi.id = pl.purchase_item_id
     where pl.purchase_id = p_purchase_id
       and pi.product_id is not null
     order by pi.product_id
  loop
    select p.* into v_product from public.products p where p.id = v_purchase_line.product_id for update;
    if not found or v_product.stock_mode <> 'purchased' then
      continue;
    end if;

    select coalesce(sum(quantity_change), 0) into v_credited_net
      from public.stock_movements
     where source_type = 'purchase_line'
       and source_id = v_purchase_line.id
       and movement_type in ('purchase_in', 'purchase_reversal');

    if v_credited_net <> 0 then
      update public.products
         set stock_quantity = stock_quantity - v_credited_net,
             updated_at = now()
       where id = v_product.id
         and stock_quantity - v_credited_net >= 0;

      if not found then
        raise exception 'Estoque atual não permite excluir esta compra porque parte dos itens já foi vendida ou consumida.';
      end if;
    end if;

    delete from public.stock_movements
     where source_type = 'purchase_line' and source_id = v_purchase_line.id;
  end loop;

  -- Só chega aqui se nenhum lote da compra teve uso não revertido e o
  -- estoque de Produto (se houver) comportou a reversão — apaga os
  -- movimentos de lote, depois os lotes, depois a compra. purchase_lines
  -- desaparece sozinha via ON DELETE CASCADE já existente.
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

-- =============================================================
-- CORREÇÃO K3: barreira forte contra configuração incoerente de Item de
-- Compra vinculado a Produto stock_mode='purchased'.
--
-- Problema encontrado: a implementação original só chamava
-- _reconcile_purchase_line_product_stock nos ramos condicionados por
-- tracks_stock/existência de lote -- um purchase_item com product_id
-- apontando pra um Produto purchased mas tracks_stock=false nunca
-- disparava o helper (nem creditava, nem barrava), deixando essa
-- inconsistência silenciosa. save_purchase (seção 5 acima) já ganhou uma
-- checagem forte no loop principal, rodando pra TODA linha antes de
-- qualquer decisão de lote. Esta seção fecha a mesma barreira nos outros
-- dois pontos onde o vínculo produto/tracks_stock/base_unit é gravado:
-- save_purchase_item (cadastro do Item de Compra em si) e
-- finalize_purchase_item (finalização de um item provisório). Mesma
-- assinatura de 10 parâmetros já executada desde a J4 (20260818330000) --
-- CREATE OR REPLACE, sem DROP (tamanho da lista de parâmetros não muda).
-- O helper (seção 3) continua validando defensivamente por baixo --
-- estas duas funções são a primeira barreira, antes mesmo de uma compra
-- ser registrada.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_purchase_item(
  p_purchase_item_id uuid,
  p_name text,
  p_category text,
  p_tracks_stock boolean,
  p_base_unit text,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_ingredient_category text,
  p_production_supply_id uuid,
  p_active boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_clean_name text;
  v_final_supply_id uuid;
  v_final_ingredient_id uuid;
  v_effective_production_supply_id uuid;
  v_effective_ingredient_id uuid;
  v_item public.purchase_items%rowtype;
  v_supply public.production_supplies%rowtype;
  v_product_stock_mode text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem salvar itens de compra.';
  end if;

  v_clean_name := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v_clean_name = '' then
    raise exception 'Informe um nome válido para o item.';
  end if;

  if p_category is null or p_category not in ('ingredient','meat','beverage','supply','packaging','cleaning','other') then
    raise exception 'Categoria inválida.';
  end if;

  if p_tracks_stock then
    if p_base_unit is null or p_base_unit not in ('g','ml','un') then
      raise exception 'Selecione a unidade-base (g, ml ou un) para um item que controla estoque.';
    end if;
  else
    if p_base_unit is not null and p_base_unit not in ('g','ml','un') then
      raise exception 'Unidade-base inválida.';
    end if;
  end if;

  -- Correção K3: barreira forte, independente de já existir lote --
  -- roda pra CREATE e UPDATE, antes de qualquer resolução de vínculo.
  if p_product_id is not null then
    select stock_mode into v_product_stock_mode from public.products where id = p_product_id;
    if v_product_stock_mode = 'purchased' then
      if not p_tracks_stock then
        raise exception 'Produto comprado para revenda deve controlar estoque.';
      end if;
      if p_base_unit is distinct from 'un' then
        raise exception 'Produto comprado para revenda deve usar unidade-base un.';
      end if;
    end if;
  end if;

  -- Etapa J4: category='ingredient' sempre exige uma categoria de
  -- ingredient válida — vale tanto pra criar quanto pra editar um item já
  -- vinculado a um Ingredient legado (cobre o caso de category=NULL
  -- herdado de antes da J4). Fail-fast: nenhuma resolução de vínculo é
  -- tentada antes desta checagem.
  if p_category = 'ingredient' then
    if p_ingredient_category is null or p_ingredient_category not in (
      'Hortifruti','Carnes','Laticínios','Secos','Temperos','Molhos','Bebidas','Outros'
    ) then
      raise exception 'Selecione a categoria do ingrediente.';
    end if;
  end if;

  if p_purchase_item_id is null then
    -- CREATE: nada a travar ainda (a linha não existe) — toda a função já
    -- é uma transação implícita só, então qualquer falha posterior
    -- (inclusive unique_violation do nome) desfaz também o
    -- ingredients/production_supplies que os helpers tiverem criado.
    if (
      (case when p_product_id is not null then 1 else 0 end) +
      (case when p_ingredient_id is not null then 1 else 0 end) +
      (case when p_production_supply_id is not null then 1 else 0 end)
    ) > 1 then
      raise exception 'Só é permitido um vínculo (produto, ingrediente ou insumo de produção).';
    end if;

    v_final_ingredient_id := public._resolve_ingredient_link(
      p_category, p_product_id, p_ingredient_id, p_production_supply_id,
      v_clean_name, p_base_unit, p_ingredient_category, coalesce(p_active, true)
    );

    if p_category = 'ingredient' and v_final_ingredient_id is not null then
      update public.ingredients set
        category = p_ingredient_category,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_final_ingredient_id;
    end if;

    v_final_supply_id := public._resolve_production_supply_link(
      p_category, p_product_id, p_ingredient_id, p_production_supply_id,
      v_clean_name, coalesce(p_active, true)
    );

    begin
      insert into public.purchase_items (
        name, category, tracks_stock, base_unit, active,
        product_id, ingredient_id, production_supply_id,
        created_by, updated_by
      ) values (
        v_clean_name, p_category, p_tracks_stock, p_base_unit, coalesce(p_active, true),
        p_product_id, v_final_ingredient_id, v_final_supply_id,
        v_user_id, v_user_id
      )
      returning * into v_item;
    exception when unique_violation then
      raise exception 'Já existe outro item de compra com esse nome.';
    end;
  else
    -- UPDATE: trava a linha ANTES de decidir se cria um ingredient/
    -- production_supply novo — mesma correção de corrida já aplicada em
    -- I2 pra production_supply_id, estendida a ingredient_id na J3. O
    -- vínculo final de cada tipo é sempre o que o client enviou
    -- explicitamente OU, se o client não enviou nada, o que já está
    -- travado no banco — nunca decide só com o payload.
    select * into v_item from public.purchase_items where id = p_purchase_item_id for update;
    if not found then
      raise exception 'Item de compra não encontrado.';
    end if;

    v_effective_ingredient_id := coalesce(p_ingredient_id, v_item.ingredient_id);
    v_effective_production_supply_id := coalesce(p_production_supply_id, v_item.production_supply_id);

    if (
      (case when p_product_id is not null then 1 else 0 end) +
      (case when v_effective_ingredient_id is not null then 1 else 0 end) +
      (case when v_effective_production_supply_id is not null then 1 else 0 end)
    ) > 1 then
      raise exception 'Só é permitido um vínculo (produto, ingrediente ou insumo de produção).';
    end if;

    v_final_ingredient_id := public._resolve_ingredient_link(
      p_category, p_product_id, v_effective_ingredient_id, v_effective_production_supply_id,
      v_clean_name, p_base_unit, p_ingredient_category, coalesce(p_active, true)
    );

    if p_category = 'ingredient' and v_final_ingredient_id is not null then
      update public.ingredients set
        category = p_ingredient_category,
        updated_at = now(),
        updated_by = v_user_id
      where id = v_final_ingredient_id;
    end if;

    v_final_supply_id := public._resolve_production_supply_link(
      p_category, p_product_id, v_effective_ingredient_id, v_effective_production_supply_id,
      v_clean_name, coalesce(p_active, true)
    );

    begin
      update public.purchase_items set
        name = v_clean_name,
        category = p_category,
        tracks_stock = p_tracks_stock,
        base_unit = p_base_unit,
        active = coalesce(p_active, true),
        product_id = p_product_id,
        ingredient_id = v_final_ingredient_id,
        production_supply_id = v_final_supply_id,
        updated_at = now(),
        updated_by = v_user_id
        -- created_by nunca é tocado numa edição.
      where id = p_purchase_item_id
      returning * into v_item;
    exception when unique_violation then
      raise exception 'Já existe outro item de compra com esse nome.';
    end;
  end if;

  if v_item.production_supply_id is not null then
    select * into v_supply from public.production_supplies where id = v_item.production_supply_id;
  end if;

  return jsonb_build_object(
    'item', to_jsonb(v_item),
    'production_supply', case when v_supply.id is not null then to_jsonb(v_supply) else null end
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.finalize_purchase_item(
  p_purchase_item_id uuid,
  p_name text,
  p_category text,
  p_tracks_stock boolean,
  p_base_unit text,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_ingredient_category text,
  p_production_supply_id uuid,
  p_active boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_user_id       uuid := auth.uid();
  v_item          public.purchase_items%rowtype;
  v_updated_item  public.purchase_items%rowtype;
  v_clean_name    text;
  v_final_supply_id uuid;
  v_final_ingredient_id uuid;
  v_supply        public.production_supplies%rowtype;
  v_line          record;
  v_base_quantity numeric;
  v_lot_result    jsonb;
  v_lots          jsonb := '[]'::jsonb;
  v_movements     jsonb := '[]'::jsonb;
  v_line_ids      uuid[] := array[]::uuid[];
  v_product_stock_mode text;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem finalizar itens de compra.';
  end if;

  select * into v_item from public.purchase_items where id = p_purchase_item_id for update;
  if not found then
    raise exception 'Item de compra não encontrado.';
  end if;

  if not v_item.needs_review then
    raise exception 'Este item de compra não está pendente de revisão.';
  end if;

  v_clean_name := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v_clean_name = '' then
    raise exception 'Informe um nome válido para o item.';
  end if;

  if p_category is null or p_category not in ('ingredient','meat','beverage','supply','packaging','cleaning','other') then
    raise exception 'Categoria inválida.';
  end if;

  if (
    (case when p_product_id is not null then 1 else 0 end) +
    (case when p_ingredient_id is not null then 1 else 0 end) +
    (case when p_production_supply_id is not null then 1 else 0 end)
  ) > 1 then
    raise exception 'Só é permitido um vínculo (produto, ingrediente ou insumo de produção).';
  end if;

  if p_tracks_stock then
    if p_base_unit is null or p_base_unit not in ('g','ml','un') then
      raise exception 'Selecione a unidade-base (g, ml ou un) para um item que controla estoque.';
    end if;
  else
    if p_base_unit is not null and p_base_unit not in ('g','ml','un') then
      raise exception 'Unidade-base inválida.';
    end if;
  end if;

  -- Correção K3: mesma barreira forte de save_purchase_item, agora
  -- também na finalização de um item provisório vinculado a um Produto
  -- purchased.
  if p_product_id is not null then
    select stock_mode into v_product_stock_mode from public.products where id = p_product_id;
    if v_product_stock_mode = 'purchased' then
      if not p_tracks_stock then
        raise exception 'Produto comprado para revenda deve controlar estoque.';
      end if;
      if p_base_unit is distinct from 'un' then
        raise exception 'Produto comprado para revenda deve usar unidade-base un.';
      end if;
    end if;
  end if;

  -- Etapa J4: mesma regra de save_purchase_item.
  if p_category = 'ingredient' then
    if p_ingredient_category is null or p_ingredient_category not in (
      'Hortifruti','Carnes','Laticínios','Secos','Temperos','Molhos','Bebidas','Outros'
    ) then
      raise exception 'Selecione a categoria do ingrediente.';
    end if;
  end if;

  -- Etapa J3: mesma regra/mesmo helper de save_purchase_item — cobre um
  -- item provisório (needs_review=true, category='other' herdado de
  -- save_purchase) sendo finalizado diretamente como Ingrediente.
  v_final_ingredient_id := public._resolve_ingredient_link(
    p_category, p_product_id, p_ingredient_id, p_production_supply_id,
    v_clean_name, p_base_unit, p_ingredient_category, coalesce(p_active, true)
  );

  if p_category = 'ingredient' and v_final_ingredient_id is not null then
    update public.ingredients set
      category = p_ingredient_category,
      updated_at = now(),
      updated_by = v_user_id
    where id = v_final_ingredient_id;
  end if;

  v_final_supply_id := public._resolve_production_supply_link(
    p_category, p_product_id, p_ingredient_id, p_production_supply_id,
    v_clean_name, coalesce(p_active, true)
  );

  begin
    update public.purchase_items set
      name                  = v_clean_name,
      category              = p_category,
      tracks_stock          = p_tracks_stock,
      base_unit             = p_base_unit,
      product_id            = p_product_id,
      ingredient_id         = v_final_ingredient_id,
      production_supply_id  = v_final_supply_id,
      active                = coalesce(p_active, true),
      needs_review          = false,
      updated_at            = now(),
      updated_by            = v_user_id
    where id = p_purchase_item_id
    returning * into v_updated_item;
  exception when unique_violation then
    raise exception 'Já existe outro item de compra com esse nome.';
  end;

  if p_tracks_stock then
    for v_line in
      select * from public.purchase_lines
       where purchase_item_id = p_purchase_item_id
         and base_quantity is null
       for update
    loop
      if p_base_unit = 'g' then
        if v_line.unit = 'g' then v_base_quantity := v_line.quantity;
        elsif v_line.unit = 'kg' then v_base_quantity := v_line.quantity * 1000;
        else v_base_quantity := null; end if;
      elsif p_base_unit = 'ml' then
        if v_line.unit = 'ml' then v_base_quantity := v_line.quantity;
        elsif v_line.unit = 'l' then v_base_quantity := v_line.quantity * 1000;
        else v_base_quantity := null; end if;
      else -- 'un'
        if v_line.unit = 'un' then v_base_quantity := v_line.quantity;
        else v_base_quantity := null; end if;
      end if;

      if v_base_quantity is null then
        raise exception 'Não foi possível finalizar o item porque uma compra anterior usa uma unidade incompatível: % %.', v_line.quantity, v_line.unit;
      end if;

      update public.purchase_lines set base_quantity = v_base_quantity where id = v_line.id;

      if not exists (select 1 from public.lots where purchase_line_id = v_line.id) then
        v_lot_result := public.create_lot_from_purchase_line(v_line.id, null);
        v_lots := v_lots || jsonb_build_array(v_lot_result->'lot');
        v_movements := v_movements || jsonb_build_array(v_lot_result->'movement');
      else
        -- Correção K3.1: esta linha já tinha lote antes da finalização
        -- (needs_review=true não impede um lote de já existir para ela) --
        -- create_lot_from_purchase_line não é chamado neste ramo, então
        -- nunca reconciliaria estoque de Product sozinho. Chama o
        -- reconciliador diretamente aqui -- idempotente por natureza
        -- (delta=0/noop se já estiver em dia), nunca chamado duas vezes
        -- pra mesma linha nesta mesma passada (ramos mutuamente exclusivos).
        perform public._reconcile_purchase_line_product_stock(v_line.id);
      end if;

      v_line_ids := v_line_ids || v_line.id;
    end loop;
  end if;

  if v_updated_item.production_supply_id is not null then
    select * into v_supply from public.production_supplies where id = v_updated_item.production_supply_id;
  end if;

  return jsonb_build_object(
    'item', to_jsonb(v_updated_item),
    'lines', coalesce((select jsonb_agg(to_jsonb(pl)) from public.purchase_lines pl where pl.id = any(v_line_ids)), '[]'::jsonb),
    'lots', v_lots,
    'movements', v_movements,
    'production_supply', case when v_supply.id is not null then to_jsonb(v_supply) else null end
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, text, uuid, boolean) TO authenticated;

-- =============================================================
-- Nenhuma outra alteração: _resolve_ingredient_link, create_customer_order,
-- cancel_order, update_order_status, adjust_stock, schema de
-- lots/lot_movements/purchase_items, UI de Compras/Produtos/Estoque.
-- Produtos produced/untracked: nenhuma exigência nova (Contra Filé,
-- stock_mode='produced', tracks_stock=true, base_unit='g', continua
-- válido -- a barreira só dispara quando stock_mode='purchased'). Helper
-- (_reconcile_purchase_line_product_stock) continua retornando noop pra
-- produced/untracked, sem tocar stock_quantity. Nenhum backfill/cutoff.
-- =============================================================
