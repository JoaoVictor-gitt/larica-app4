-- Compras + Lotes + Estoque por Lote — MELHORIA DE UX: REGISTRAR COMPRA SEM
-- EXIGIR ITEM PRÉ-CADASTRADO — ETAPA F2 (RPCs).
--
-- Evolui save_purchase para resolver/criar purchase_items por nome quando
-- purchase_item_id não vier no payload de uma linha nova (reaproveita item
-- existente por nome normalizado, ou cria um provisório —
-- needs_review=true, tracks_stock=false, base_unit=NULL, sem vínculos), e
-- cria finalize_purchase_item (RPC nova) para completar o cadastro de um
-- item pendente e converter retroativamente suas purchase_lines/gerar
-- lotes. Depende do schema já executado na Etapa F1
-- (purchase_items.needs_review/normalized_name/unique index,
-- purchase_lines.base_quantity nullable).
--
-- NÃO altera schema (isso já foi feito na F1). NÃO altera UI
-- (compras.html/js/compras.js/css/compras.css). NÃO integra Produção/
-- Pedidos/create_customer_order/product_costs/stock_movements/
-- products.stock_quantity. Migrations já executadas não são editadas —
-- esta é uma migration incremental nova.

-- =============================================================
-- 1. save_purchase — CREATE OR REPLACE, mesma assinatura já executada.
--
-- Novidade: p_lines aceita, por linha, item_name (novo, nullable) além de
-- purchase_item_id (agora nullable pra linha nova). Linha existente
-- (line_id preenchido) continua exigindo purchase_item_id e ignora
-- item_name por completo — item de linha existente continua imutável.
-- Linha nova sem purchase_item_id resolve o item por normalized_name
-- (reaproveita se já existir, cria provisório se não) antes de continuar
-- com o mesmo código de conversão/lote já existente. O ramo novo de
-- conversão (base_unit IS NULL) é condicionado só a tracks_stock=false —
-- nunca a needs_review — porque também cobre um item já finalizado como
-- "só financeiro" de propósito (tracks_stock=false, base_unit=NULL).
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

-- GRANT/REVOKE de save_purchase já existentes (Etapa D) — CREATE OR
-- REPLACE não altera privilégios, nada repetido aqui.


-- =============================================================
-- 2. finalize_purchase_item — nova RPC.
--
-- Completa o cadastro de um purchase_item pendente (needs_review=true) e,
-- se p_tracks_stock=true, converte retroativamente toda purchase_line
-- desse item com base_quantity IS NULL (sinal confiável de "ainda não
-- convertida") e gera lote+movimento inicial via create_lot_from_
-- purchase_line já existente (reaproveitada, sem duplicar lógica).
-- Rollback integral se qualquer linha antiga tiver unidade incompatível
-- com a base_unit escolhida — needs_review continua true nesse caso.
-- Se p_tracks_stock=false, só atualiza o item; linhas antigas continuam
-- com base_quantity/unit_cost_base NULL, nenhum lote gerado.
--
-- SELECT ... FOR UPDATE no item (impede duas finalizações simultâneas do
-- mesmo item) + FOR UPDATE em cada purchase_line pendente dentro do loop
-- (bloqueia contra edição concorrente pela mesma linha via save_purchase)
-- + UNIQUE(purchase_line_id) em lots como segunda barreira (Etapa C) —
-- mesma disciplina de concorrência já usada no resto da feature.
-- =============================================================

CREATE OR REPLACE FUNCTION public.finalize_purchase_item(
  p_purchase_item_id uuid,
  p_name text,
  p_category text,
  p_tracks_stock boolean,
  p_base_unit text,
  p_product_id uuid,
  p_ingredient_id uuid,
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
  v_line          record;
  v_base_quantity numeric;
  v_lot_result    jsonb;
  v_lots          jsonb := '[]'::jsonb;
  v_movements     jsonb := '[]'::jsonb;
  v_line_ids      uuid[] := array[]::uuid[];
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

  begin
    update public.purchase_items set
      name                  = v_clean_name,
      category              = p_category,
      tracks_stock          = p_tracks_stock,
      base_unit             = p_base_unit,
      product_id            = p_product_id,
      ingredient_id         = p_ingredient_id,
      production_supply_id  = p_production_supply_id,
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
      end if;

      v_line_ids := v_line_ids || v_line.id;
    end loop;
  end if;

  return jsonb_build_object(
    'item', to_jsonb(v_updated_item),
    'lines', coalesce((select jsonb_agg(to_jsonb(pl)) from public.purchase_lines pl where pl.id = any(v_line_ids)), '[]'::jsonb),
    'lots', v_lots,
    'movements', v_movements
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) TO authenticated;

-- =============================================================
-- FIM — ETAPA F2
-- =============================================================
--
-- Nenhuma mudança de schema (já feita na Etapa F1). create_lot_from_
-- purchase_line reaproveitada sem alteração. RLS/GRANTs de
-- purchase_items/purchase_lines inalterados — a lacuna de trava de
-- base_unit pós-lote na edição normal de item continua documentada e
-- fora de escopo. Nenhuma UI alterada
-- (compras.html/js/compras.js/css/compras.css) — Etapa F3. Nenhuma
-- integração com Produção, Pedidos, create_customer_order, product_costs,
-- stock_movements, products.stock_quantity.
