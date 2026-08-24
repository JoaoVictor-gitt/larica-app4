-- Unificar Item de Compra <-> Ingredient — ETAPA J4 (gerir
-- ingredients.category a partir de Compras).
--
-- J3 (auto-criar/vincular public.ingredients a partir de Item de Compra
-- category='ingredient', migration 20260818320000, com a correção que
-- bloqueia criação sem base_unit válida) está executada e validada. O
-- Ingredient auto-criado nascia com category=NULL — mas ingredients.
-- category não é cosmético: ehIngredienteTempero() (js/producao.js) usa
-- category='Temperos' para decidir quais ingredientes aparecem no
-- seletor de Temperos da Produção de Espetos. Esta migration adiciona um
-- novo parâmetro p_ingredient_category às 3 funções da J3, tornando a
-- categoria do Ingredient obrigatória (e editável a partir de Compras)
-- sempre que purchase_items.category='ingredient' — tanto na criação
-- quanto num vínculo legado já existente (ex. "Cebola Teste J3", cujo
-- Ingredient está hoje com category=NULL).
--
-- Nenhuma mudança de schema/tabela — só recriação de função. Como o
-- parâmetro novo muda o TAMANHO da lista de parâmetros (não dá pra usar
-- só CREATE OR REPLACE), cada uma das 3 funções é removida com DROP
-- FUNCTION (assinatura antiga exata, já confirmada como a instalada de
-- fato pela J3) e recriada com CREATE FUNCTION (assinatura nova) — nunca
-- DROP ... CASCADE, nunca duas assinaturas convivendo.
--
-- Taxonomia de ingredients.category reaproveitada EXATAMENTE do datalist
-- já existente no CRUD antigo (producao.html, #lista-categorias-
-- ingrediente): Hortifruti, Carnes, Laticínios, Secos, Temperos, Molhos,
-- Bebidas, Outros. Nenhuma taxonomia nova inventada.
--
-- NÃO altera schema (ingredients, purchase_items — nenhuma coluna/CHECK
-- novo; ingredients.category continua text livre, sem CHECK no banco — a
-- validação do conjunto de 8 valores é só nestas RPCs). NÃO altera
-- save_purchase (continua criando purchase_item provisório com
-- category='other' fixo). NÃO altera create_lot_from_purchase_line,
-- delete_purchase, suppliers, purchases, purchase_lines, lots,
-- lot_movements, _resolve_production_supply_link, production_supplies.
-- NÃO altera Produção (save_skewer_production_batch,
-- save_side_production_batch, skewer_batch_components,
-- side_batch_components, delete_*, producao.html/producao.js/
-- ingredients-service.js, recipes/recipe_items) nem product_costs,
-- Pedidos, create_customer_order, stock_movements. NÃO revoga a escrita
-- direta de ingredients — continua exatamente como está, Produção ->
-- Ingredientes continua funcionando sem nenhuma mudança durante a
-- transição. Migrations já executadas (J1-J3) não são editadas.

-- =============================================================
-- 1. _resolve_ingredient_link — DROP da assinatura antiga (7 parâmetros,
-- já instalada pela J3) + CREATE da nova (8 parâmetros, ganha
-- p_ingredient_category logo após p_base_unit).
--
-- Único comportamento novo: no INSERT de criação, category passa a ser
-- p_ingredient_category (em vez de NULL fixo). Os dois returns de
-- passthrough (category != 'ingredient'; qualquer vínculo já preenchido),
-- a exigência de base_unit válida (correção J3, RAISE EXCEPTION, mantida
-- sem alteração), a resolução por normalized_name e o idioma INSERT ...
-- ON CONFLICT (normalized_name) DO NOTHING RETURNING id + fallback SELECT
-- (concorrência, Etapa J2/J3) continuam idênticos.
-- =============================================================

DROP FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, boolean);

CREATE FUNCTION public._resolve_ingredient_link(
  p_category text,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_production_supply_id uuid,
  p_name text,
  p_base_unit text,
  p_ingredient_category text,
  p_active boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_unit_type text;
  v_clean_name text;
  v_normalized text;
  v_new_id uuid;
begin
  if p_category <> 'ingredient' then
    return p_ingredient_id;
  end if;

  if p_product_id is not null or p_ingredient_id is not null or p_production_supply_id is not null then
    return p_ingredient_id;
  end if;

  if p_base_unit is null or p_base_unit not in ('g', 'ml', 'un') then
    -- Correção J3, inalterada: category='ingredient' sem nenhum vínculo
    -- (os dois returns acima já cobriram category diferente / vínculo já
    -- existente) significa que este item VAI ser auto-vinculado a um
    -- Ingredient — sem base_unit válida não há como montar essa linha
    -- (ingredients.base_unit é NOT NULL), então isso precisa bloquear a
    -- transação inteira, nunca salvar o purchase_item sem vínculo
    -- silenciosamente.
    raise exception 'Selecione a unidade-base (g, ml ou un) para criar o ingrediente vinculado.';
  end if;

  v_unit_type := case p_base_unit
    when 'g' then 'peso'
    when 'ml' then 'volume'
    else 'contagem'
  end;

  v_clean_name := trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if v_clean_name = '' then
    raise exception 'Informe um nome válido para criar o ingrediente vinculado.';
  end if;

  v_normalized := translate(
    lower(v_clean_name),
    'áàãâäéèêëíìîïóòõôöúùûüçñ',
    'aaaaaeeeeiiiiooooouuuucn'
  );

  select id into v_new_id from public.ingredients where normalized_name = v_normalized;
  if v_new_id is not null then
    return v_new_id;
  end if;

  -- Etapa J4: category passa a ser p_ingredient_category (nunca mais NULL
  -- fixo nesta criação técnica) — validado pelos callers (save_purchase_item/
  -- finalize_purchase_item) antes de chegar aqui.
  insert into public.ingredients (
    name, unit_type, base_unit,
    purchase_quantity_display, purchase_display_unit, purchase_quantity_base, purchase_price,
    category, active, updated_by
  ) values (
    v_clean_name, v_unit_type, p_base_unit,
    1, p_base_unit, 1, 0,
    p_ingredient_category, coalesce(p_active, true), auth.uid()
  )
  on conflict (normalized_name) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    select id into v_new_id from public.ingredients where normalized_name = v_normalized;
  end if;

  return v_new_id;
end;
$function$;

REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, text, boolean) FROM authenticated;

-- =============================================================
-- 2. save_purchase_item — DROP da assinatura antiga (9 parâmetros, já
-- instalada pela I2/mantida pela J3) + CREATE da nova (10 parâmetros,
-- ganha p_ingredient_category logo após p_ingredient_id).
--
-- Três mudanças reais no corpo, todo o resto idêntico ao já executado:
--   a) nova validação incondicional (roda pra CREATE e UPDATE, antes de
--      qualquer resolução de vínculo): category='ingredient' exige
--      p_ingredient_category num conjunto fechado de 8 valores — cobre
--      tanto a criação quanto a edição de um item já vinculado a um
--      Ingredient legado (ex. "Cebola Teste J3", category atual NULL).
--   b) as duas chamadas já existentes a _resolve_ingredient_link (ramo
--      CREATE, ramo UPDATE) ganham p_ingredient_category no meio da lista
--      de argumentos.
--   c) logo depois de cada uma dessas chamadas, uma atualização nova:
--      UPDATE ingredients SET category=p_ingredient_category,
--      updated_at=now(), updated_by=v_user_id WHERE id=v_final_ingredient_id
--      — só quando category='ingredient' e há um ingredient resolvido.
--      Isto é o único lugar que de fato atualiza a categoria de um
--      Ingredient legado já vinculado (o INSERT do helper só grava
--      category na criação nova, ver seção 1 acima) — nunca sincroniza
--      name/active/base_unit/unit_type/campos de compra.
-- =============================================================

DROP FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean);

CREATE FUNCTION public.save_purchase_item(
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

-- =============================================================
-- 3. finalize_purchase_item — DROP da assinatura antiga (9 parâmetros) +
-- CREATE da nova (10 parâmetros). Mesmas 3 mudanças de save_purchase_item
-- (validação incondicional + p_ingredient_category no helper + UPDATE de
-- category), sem coalesce (só roda sobre item needs_review=true, cujo
-- ingredient_id já é sempre NULL nesse ponto por construção — mesmo
-- raciocínio já documentado desde a I2/J3). Resto do corpo (conversão
-- retroativa de purchase_lines/geração de lote) idêntico ao já executado.
-- =============================================================

DROP FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean);

CREATE FUNCTION public.finalize_purchase_item(
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
-- FIM — ETAPA J4
-- =============================================================
--
-- Nenhuma mudança de schema (ingredients, purchase_items). save_purchase,
-- create_lot_from_purchase_line, delete_purchase, suppliers, purchases,
-- purchase_lines, lots, lot_movements, _resolve_production_supply_link,
-- production_supplies: inalterados. Produção (save_skewer_production_batch,
-- save_side_production_batch, skewer_batch_components,
-- side_batch_components, delete_*, producao.html/producao.js/
-- ingredients-service.js, recipes/recipe_items), product_costs, Pedidos,
-- create_customer_order, stock_movements: não tocados.
--
-- Escrita direta de ingredients (GRANT SELECT/INSERT/UPDATE/DELETE pra
-- authenticated sob RLS admin-only) permanece EXATAMENTE como está —
-- Produção -> Ingredientes continua funcionando sem nenhuma mudança
-- durante a transição.
