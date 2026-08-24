-- Compras + Lotes + Estoque por Lote — ETAPA D (RPC save_purchase +
-- fechamento de escrita direta de purchases/purchase_lines). Única porta
-- de escrita pra cabeçalho+linhas de uma compra: cria/edita purchase,
-- reconcilia purchase_lines, calcula base_quantity/item_name_snapshot
-- 100% server-side, e gera lote+movimento inicial automaticamente pra
-- cada linha nova cujo item controla estoque (reaproveitando
-- create_lot_from_purchase_line via PERFORM, dentro da mesma transação —
-- evita duplicar a lógica de criação de lote já validada na Etapa C).
--
-- Regra de edição: uma compra é livremente editável (linhas, quantidades,
-- preços, validade, data) ENQUANTO nenhum lote seu tiver movimento além
-- do 'purchase' inicial. Se já houve consumo real (qualquer movimento
-- diferente de 'purchase'), a RPC só atualiza supplier_id/reference/notes
-- e ignora p_lines por completo — nunca toca linha/lote/movimento nessa
-- situação, e rejeita explicitamente qualquer tentativa de mudar
-- purchased_at.
--
-- NÃO integra com Produção de Espetos/Acompanhamentos, Pedidos,
-- create_customer_order, product_costs, stock_movements ou
-- products.stock_quantity. Sem UI. Não altera purchase_items/suppliers
-- (continuam cadastro simples com GRANT direto) nem lots/lot_movements
-- (schema/grants da Etapa C intocados — só a RPC nova passa a escrever
-- neles, além da já existente create_lot_from_purchase_line).

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

    if v_purchase_item_id is null then raise exception 'Selecione o item de compra.'; end if;
    if v_quantity is null or v_quantity <= 0 then raise exception 'Quantidade deve ser maior que zero.'; end if;
    if v_total_price is null or v_total_price < 0 then raise exception 'Preço inválido.'; end if;
    if v_unit is null or v_unit not in ('g','kg','ml','l','un') then raise exception 'Unidade inválida.'; end if;
    if v_line_id is not null and p_purchase_id is null then
      raise exception 'Linha inválida para uma nova compra.';
    end if;

    if v_line_id is not null then
      -- Linha existente: item_id é imutável — remove/adiciona de novo
      -- se precisar trocar o item.
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
    else
      -- Linha nova: item precisa existir e estar ativo.
      select * into v_item from public.purchase_items where id = v_purchase_item_id;
      if v_item.id is null then raise exception 'Item de compra não encontrado.'; end if;
      if not v_item.active then raise exception 'Item de compra inativo não pode ser usado em uma nova linha.'; end if;
    end if;
    if v_item.id is null then raise exception 'Item de compra não encontrado.'; end if;

    if not v_item.tracks_stock and v_expiration is not null then
      raise exception 'Item sem controle de estoque não pode ter validade.';
    end if;

    -- Conversão server-side, nunca peso<->volume<->unidade.
    if v_item.base_unit = 'g' then
      if v_unit = 'g' then v_base_quantity := v_quantity;
      elsif v_unit = 'kg' then v_base_quantity := v_quantity * 1000;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
    elsif v_item.base_unit = 'ml' then
      if v_unit = 'ml' then v_base_quantity := v_quantity;
      elsif v_unit = 'l' then v_base_quantity := v_quantity * 1000;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
    else
      if v_unit = 'un' then v_base_quantity := v_quantity;
      else raise exception 'Unidade incompatível com o item de compra.'; end if;
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

      if v_item.tracks_stock then
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

      if v_item.tracks_stock then
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

REVOKE ALL ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_purchase(uuid, uuid, date, text, text, jsonb) TO authenticated;

-- Fecha a escrita direta de purchases/purchase_lines (concedida na
-- Etapa B) — toda criação/edição passa a exigir save_purchase. SELECT
-- continua liberado (leitura sob RLS/is_staff() já bastava). REVOKE
-- também de DELETE, por disciplina/consistência: nenhuma tela hoje ou
-- planejada exclui purchase/line fora da própria RPC.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.purchases FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.purchase_lines FROM authenticated;

-- Nenhuma outra alteração: purchase_items, suppliers (continuam cadastro
-- simples, GRANT direto intocado), lots, lot_movements,
-- create_lot_from_purchase_line (schema/grants da Etapa C intocados),
-- products, ingredients, production_supplies, stock_movements,
-- create_customer_order, product_costs, Produção de Espetos/
-- Acompanhamentos, Pedidos, Estoque permanecem exatamente como estavam.
