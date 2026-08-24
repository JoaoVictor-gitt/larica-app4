-- Unificar Item de Compra <-> Ingredient — ETAPA J3 (auto-criar/vincular
-- public.ingredients a partir de Item de Compra category='ingredient').
--
-- J2 (normalized_name + UNIQUE INDEX em ingredients) executada e validada:
-- nenhuma duplicata existente, índice único confirmado. Esta migration usa
-- exatamente essa identidade para resolver o mesmo nome sempre pro mesmo
-- Ingredient, evitando duplicar cadastro.
--
-- Três objetos novos/alterados, mesmo desenho de _resolve_production_
-- supply_link (Etapa I2), agora com um segundo helper irmão:
--   1. public._resolve_ingredient_link(...) — helper interno (não é
--      trigger), chamado por save_purchase_item E finalize_purchase_item.
--      Só age para category='ingredient' (NUNCA 'meat' — carne principal
--      continua usando product_id, sem relação nenhuma com ingredients).
--      Sem EXECUTE pra ninguém (nem authenticated) — mesma razão de
--      _resolve_production_supply_link: SECURITY DEFINER chamando
--      SECURITY DEFINER checa privilégio contra o dono da função chamadora,
--      não contra authenticated, então isso não impede save_purchase_item/
--      finalize_purchase_item de usá-lo.
--   2. public.save_purchase_item — CREATE OR REPLACE, mesma assinatura de
--      9 parâmetros. Ganha uma segunda resolução (_resolve_ingredient_link)
--      ao lado da já existente (_resolve_production_supply_link), nos
--      mesmos dois pontos (CREATE sem lock; UPDATE com lock primeiro,
--      coalesce com o estado já travado antes de resolver qualquer
--      helper — mesma disciplina já corrigida na revisão de segurança da
--      I2).
--   3. public.finalize_purchase_item — CREATE OR REPLACE, mesma
--      assinatura. Ganha a mesma segunda resolução, sem necessidade de
--      coalesce (só roda sobre item needs_review=true, cujo ingredient_id
--      já é sempre NULL nesse ponto — mesmo raciocínio já documentado pra
--      production_supply_id nessa função).
--
-- NÃO altera schema (ingredients, purchase_items — nenhuma coluna/CHECK
-- novo). NÃO altera save_purchase (continua criando purchase_item
-- provisório com category='other' fixo — nunca 'ingredient' diretamente,
-- então nunca aciona o helper; o auto-link só acontece quando o item
-- pendente for finalizado como 'ingredient' via finalize_purchase_item).
-- NÃO altera create_lot_from_purchase_line, delete_purchase, suppliers,
-- purchases, purchase_lines, lots, lot_movements. NÃO altera Produção
-- (save_skewer_production_batch, save_side_production_batch,
-- skewer_batch_components, side_batch_components, delete_*, producao.html/
-- producao.js/ingredients-service.js) nem product_costs, Pedidos,
-- create_customer_order, stock_movements. NÃO revoga a escrita direta de
-- ingredients (RLS/GRANTs de ingredients ficam exatamente como estão —
-- Produção -> Ingredientes continua funcionando normalmente durante a
-- transição, fechar isso é uma etapa futura separada, só depois do CRUD
-- ser removido). Migrations já executadas (incluindo J2, 20260818310000)
-- não são editadas.

-- =============================================================
-- 1. Helper interno — _resolve_ingredient_link
--
-- Regra: só category='ingredient' participa do auto-link — nunca 'meat'
-- (carne principal usa purchase_item.product_id, sem relação com
-- ingredients) nem beverage/supply/packaging/cleaning/other. Se QUALQUER
-- um dos três vínculos (product_id/ingredient_id/production_supply_id) já
-- vier preenchido, nunca auto-cria — respeita o que já está lá (cobre
-- tanto "já auto-criado antes" quanto "vínculo manual a um Ingredient
-- legado" quanto qualquer combinação atípica categoria×vínculo). Só cria
-- um ingredient novo quando os três vierem NULL.
--
-- base_unit precisa estar em ('g','ml','un') para a criação acontecer —
-- ingredients.base_unit é NOT NULL, então sem uma unidade-base válida não
-- há como montar uma linha coerente. CORREÇÃO J3: quando os três vínculos
-- já vieram NULL (ou seja, este item VAI ser auto-vinculado) e p_base_unit
-- não é válido (ex. item category='ingredient' com tracks_stock=false, sem
-- unidade-base definida), o helper LEVANTA EXCEÇÃO — nunca deixa o
-- purchase_item ser salvo sem vínculo silenciosamente. Isso vale
-- independente de tracks_stock: a exigência de base_unit aqui é sobre ser
-- possível montar a linha em ingredients (schema), não sobre a regra
-- (separada) de tracks_stock exigir base_unit em purchase_items.
--
-- unit_type é sempre derivado de base_unit (g->peso, ml->volume,
-- un->contagem) — nunca perguntado separadamente, coerente com o CHECK
-- ingredients_base_unit_coerente já existente.
--
-- Valores técnicos de compatibilidade (fallback legado, mesmo espírito já
-- usado em production_supplies): purchase_quantity_display=1,
-- purchase_quantity_base=1, purchase_price=0, purchase_display_unit =
-- exatamente base_unit (nunca kg/L nesta criação técnica — só valores
-- iguais à própria unidade-base: 'g','ml' ou 'un'). cost_per_base_unit
-- (coluna GERADA) resulta em 0 até existir custo real via lote — igual ao
-- fallback já documentado para production_supplies.cost_per_unit.
-- category do ingredient criado fica NULL (taxonomia de ingredients é
-- própria e funcional — ex. filtro de "Temperos" em Espetos — e não tem
-- mapeamento automático possível a partir de purchase_items.category;
-- usuário pode categorizar depois, manualmente, em Produção ->
-- Ingredientes, enquanto esse CRUD ainda existir).
--
-- Concorrência: identidade por normalized_name (UNIQUE, Etapa J2) +
-- INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id, com
-- fallback SELECT se a inserção perder a corrida — mesmo idioma já usado
-- em save_purchase para resolver purchase_items por nome. Nunca cria
-- duplicata: duas criações simultâneas do mesmo nome normalizado sempre
-- convergem pro mesmo id.
-- =============================================================

CREATE OR REPLACE FUNCTION public._resolve_ingredient_link(
  p_category text,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_production_supply_id uuid,
  p_name text,
  p_base_unit text,
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
    -- CORREÇÃO J3: category='ingredient' sem nenhum vínculo (os dois
    -- returns acima já cobriram category diferente / vínculo já existente)
    -- significa que este item VAI ser auto-vinculado a um Ingredient — sem
    -- base_unit válida não há como montar essa linha (ingredients.
    -- base_unit é NOT NULL), então isso precisa bloquear a transação
    -- inteira (CREATE/UPDATE/finalize), nunca salvar o purchase_item sem
    -- vínculo silenciosamente.
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

  insert into public.ingredients (
    name, unit_type, base_unit,
    purchase_quantity_display, purchase_display_unit, purchase_quantity_base, purchase_price,
    category, active, updated_by
  ) values (
    v_clean_name, v_unit_type, p_base_unit,
    1, p_base_unit, 1, 0,
    null, coalesce(p_active, true), auth.uid()
  )
  on conflict (normalized_name) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    select id into v_new_id from public.ingredients where normalized_name = v_normalized;
  end if;

  return v_new_id;
end;
$function$;

REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._resolve_ingredient_link(text, uuid, uuid, uuid, text, text, boolean) FROM authenticated;

-- =============================================================
-- 2. save_purchase_item — CREATE OR REPLACE, mesma assinatura de 9
-- parâmetros já executada (I2). Ganha a segunda resolução
-- (_resolve_ingredient_link) ao lado de _resolve_production_supply_link,
-- nos mesmos dois pontos (CREATE/UPDATE).
--
-- UPDATE: mesma disciplina já corrigida na revisão de segurança da I2 —
-- SELECT ... FOR UPDATE primeiro, só então v_effective_ingredient_id :=
-- coalesce(p_ingredient_id, v_item.ingredient_id) (novo, espelha
-- v_effective_production_supply_id já existente), validação de máximo-1-
-- vínculo e as DUAS chamadas de helper usam os valores EFETIVOS
-- (travados), nunca o parâmetro cru isolado — necessário porque, a partir
-- desta etapa, a UI de Compras passa a esconder o seletor de Ingrediente
-- quando o item já está vinculado (mesmo padrão já usado pra Insumo desde
-- a I2), então um payload de edição que não toca nesse campo chega com
-- p_ingredient_id NULL mesmo quando o item já tem um vínculo real — sem o
-- coalesce, isso apagaria o vínculo silenciosamente.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_purchase_item(
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
      v_clean_name, p_base_unit, coalesce(p_active, true)
    );

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
    -- I2 pra production_supply_id, agora estendida a ingredient_id. O
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
      v_clean_name, p_base_unit, coalesce(p_active, true)
    );

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

REVOKE ALL ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) TO authenticated;

-- =============================================================
-- 3. finalize_purchase_item — CREATE OR REPLACE, mesma assinatura.
-- Ganha a mesma segunda resolução (_resolve_ingredient_link), sem
-- coalesce: esta função só roda sobre um item needs_review=true, cujo
-- ingredient_id (assim como production_supply_id) é sempre NULL nesse
-- ponto por construção — mesmo raciocínio já documentado/confirmado pra
-- production_supply_id nesta mesma função desde a I2. Resto do corpo
-- (validação/conversão retroativa de purchase_lines/geração de lote)
-- idêntico ao já executado.
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

  -- Etapa J3: mesma regra/mesmo helper de save_purchase_item — cobre um
  -- item provisório (needs_review=true, category='other' herdado de
  -- save_purchase) sendo finalizado diretamente como Ingrediente.
  v_final_ingredient_id := public._resolve_ingredient_link(
    p_category, p_product_id, p_ingredient_id, p_production_supply_id,
    v_clean_name, p_base_unit, coalesce(p_active, true)
  );

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

REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.finalize_purchase_item(uuid, text, text, boolean, text, uuid, uuid, uuid, boolean) TO authenticated;

-- =============================================================
-- FIM — ETAPA J3
-- =============================================================
--
-- Nenhuma mudança de schema (ingredients, purchase_items). save_purchase,
-- create_lot_from_purchase_line, delete_purchase, suppliers, purchases,
-- purchase_lines, lots, lot_movements: inalterados. Produção
-- (save_skewer_production_batch, save_side_production_batch,
-- skewer_batch_components, side_batch_components, delete_*,
-- producao.html/producao.js/ingredients-service.js), product_costs,
-- Pedidos, create_customer_order, stock_movements: não tocados.
--
-- Escrita direta de ingredients (GRANT SELECT/INSERT/UPDATE/DELETE pra
-- authenticated sob RLS admin-only) permanece EXATAMENTE como está —
-- Produção -> Ingredientes continua funcionando sem nenhuma mudança
-- durante a transição. Fechar essa escrita direta (REVOKE INSERT/UPDATE,
-- mesmo padrão já aplicado a purchase_items na I2) fica para uma etapa
-- futura, só depois do CRUD de Ingredientes ser removido.
