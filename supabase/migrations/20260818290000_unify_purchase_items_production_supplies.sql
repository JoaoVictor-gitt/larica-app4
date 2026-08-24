-- Compras — ETAPA I2: unificar Item de Compra <-> Insumo de Produção.
--
-- Elimina o cadastro duplicado entre purchase_items e production_supplies.
-- A partir desta migration, Itens de Compra é a porta de cadastro real —
-- para category IN ('supply','packaging') sem nenhum vínculo já
-- preenchido, o backend cria/vincula automaticamente um production_supply
-- (nome = purchase_item.name, valores técnicos de compatibilidade
-- purchase_quantity=1/purchase_price=0/unit_type='un' — NÃO representam
-- custo/quantidade operacional real; quando a Etapa I3 existir, o custo
-- real de um insumo com lote vem de lots.unit_cost_base, nunca daqui).
-- category='cleaning' fica DELIBERADAMENTE FORA da auto-criação (item 1/2
-- do pedido) — cleaning pode controlar estoque e gerar lotes normalmente,
-- mas nunca aparece como componente operacional de Produção.
--
-- Três objetos novos/alterados:
--   1. public._resolve_production_supply_link(...) — helper interno
--      reutilizável (não é trigger), chamado por save_purchase_item E
--      finalize_purchase_item, evita duplicar a mesma regra duas vezes.
--      Sem EXECUTE pra ninguém além do dono da função — SECURITY DEFINER
--      chamando SECURITY DEFINER checa privilégio contra o dono, não
--      contra authenticated, então isso não impede as duas RPCs de usá-la.
--   2. public.save_purchase_item(...) — RPC nova, única porta de escrita
--      de purchase_items a partir de agora (cria E edita).
--   3. public.finalize_purchase_item — CREATE OR REPLACE, mesma
--      assinatura, ganha a mesma chamada ao helper (cobre itens
--      provisórios do fluxo de Registrar Compra sendo finalizados
--      diretamente como Insumo/Embalagem).
--
-- Fecha o GRANT direto de INSERT/UPDATE em purchase_items (authenticated)
-- — a partir de agora toda escrita passa por save_purchase_item. DELETE
-- auditado e mantido como está: nenhum código cliente hoje chama
-- .delete() em purchase_items (confirmado por grep em compras.js/
-- purchases-service.js), então o GRANT DELETE existente fica sem uso real
-- — não revogado nesta migration por não ter sido pedido, documentado
-- aqui como pendência opcional de uma etapa de limpeza futura. SELECT
-- inalterado.
--
-- NÃO altera schema (nenhuma tabela/coluna nova, nenhum CHECK novo/
-- alterado). NÃO altera save_purchase (continua criando purchase_item
-- provisório com category='other' fixo — nunca uma categoria elegível
-- diretamente, então nunca precisa do auto-link; auditado abaixo). NÃO
-- altera create_lot_from_purchase_line, delete_purchase, suppliers,
-- purchases, purchase_lines, lots, lot_movements. NÃO altera Produção
-- (save_skewer_production_batch, skewer_batch_components, delete_skewer_
-- production_batch, producao.html, producao.js) — supply com lot_id é a
-- Etapa I3, fora de escopo aqui. NÃO altera product_costs, Pedidos,
-- create_customer_order, stock_movements. Migrations já executadas não
-- são editadas.

-- =============================================================
-- 1. Helper interno — _resolve_production_supply_link
--
-- Regra: só category IN ('supply','packaging') participa do auto-link.
-- Se QUALQUER um dos três vínculos (product_id/ingredient_id/
-- production_supply_id) já vier preenchido, nunca auto-cria — respeita o
-- que já está lá (cobre tanto "já auto-criado antes" quanto "vínculo
-- manual a um production_supply legado" quanto "combinação atípica
-- categoria×vínculo digitada por engano", evitando criar um segundo
-- vínculo em cima de um já existente e violar
-- purchase_items_no_maximo_um_vinculo). Só cria um production_supply novo
-- quando os três vierem NULL — nesse caso não há ambiguidade nenhuma.
-- =============================================================

CREATE OR REPLACE FUNCTION public._resolve_production_supply_link(
  p_category text,
  p_product_id uuid,
  p_ingredient_id uuid,
  p_production_supply_id uuid,
  p_name text,
  p_active boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_new_id uuid;
begin
  if p_category not in ('supply', 'packaging') then
    return p_production_supply_id;
  end if;

  if p_product_id is not null or p_ingredient_id is not null or p_production_supply_id is not null then
    return p_production_supply_id;
  end if;

  -- Valores técnicos de compatibilidade com o schema legado de
  -- production_supplies (purchase_quantity/purchase_price/unit_type são
  -- NOT NULL lá) — nunca representam custo/quantidade real de compra.
  insert into public.production_supplies (
    name, purchase_quantity, purchase_price, unit_type, active, created_by, updated_by
  ) values (
    p_name, 1, 0, 'un', coalesce(p_active, true), auth.uid(), auth.uid()
  )
  returning id into v_new_id;

  return v_new_id;
end;
$function$;

REVOKE ALL ON FUNCTION public._resolve_production_supply_link(text, uuid, uuid, uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._resolve_production_supply_link(text, uuid, uuid, uuid, text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._resolve_production_supply_link(text, uuid, uuid, uuid, text, boolean) FROM authenticated;

-- =============================================================
-- 2. save_purchase_item — nova RPC, única porta de escrita de
-- purchase_items a partir de agora (cria E edita).
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
  v_effective_production_supply_id uuid;
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
    -- production_supplies que o helper tiver criado logo abaixo.
    if (
      (case when p_product_id is not null then 1 else 0 end) +
      (case when p_ingredient_id is not null then 1 else 0 end) +
      (case when p_production_supply_id is not null then 1 else 0 end)
    ) > 1 then
      raise exception 'Só é permitido um vínculo (produto, ingrediente ou insumo de produção).';
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
        p_product_id, p_ingredient_id, v_final_supply_id,
        v_user_id, v_user_id
      )
      returning * into v_item;
    exception when unique_violation then
      raise exception 'Já existe outro item de compra com esse nome.';
    end;
  else
    -- UPDATE: trava a linha ANTES de decidir se cria um production_supply
    -- novo — corrige a corrida de duas edições simultâneas observando
    -- production_supply_id=NULL e criando dois supplies (achado de
    -- revisão). O vínculo final de supply é sempre o que o client enviou
    -- explicitamente OU, se o client não enviou nada, o que já está
    -- travado no banco — nunca decide só com o payload.
    select * into v_item from public.purchase_items where id = p_purchase_item_id for update;
    if not found then
      raise exception 'Item de compra não encontrado.';
    end if;

    v_effective_production_supply_id := coalesce(p_production_supply_id, v_item.production_supply_id);

    if (
      (case when p_product_id is not null then 1 else 0 end) +
      (case when p_ingredient_id is not null then 1 else 0 end) +
      (case when v_effective_production_supply_id is not null then 1 else 0 end)
    ) > 1 then
      raise exception 'Só é permitido um vínculo (produto, ingrediente ou insumo de produção).';
    end if;

    v_final_supply_id := public._resolve_production_supply_link(
      p_category, p_product_id, p_ingredient_id, v_effective_production_supply_id,
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
        ingredient_id = p_ingredient_id,
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
-- Única mudança real: chama o mesmo helper de auto-link antes do UPDATE
-- (cobre itens provisórios finalizados diretamente como Insumo/
-- Embalagem), e o retorno ganha 'production_supply'. Resto do corpo
-- (validação/conversão retroativa de purchase_lines/geração de lote) é
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

  -- Etapa I2: mesma regra/mesmo helper de save_purchase_item — cobre um
  -- item provisório (needs_review=true, category='other' herdado de
  -- save_purchase) sendo finalizado diretamente como Insumo/Embalagem.
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
      ingredient_id         = p_ingredient_id,
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
-- 4. Fecha a escrita direta de purchase_items — toda criação/edição
-- passa a exigir save_purchase_item (ou finalize_purchase_item, pro
-- fluxo de item pendente). SELECT continua liberado. DELETE não tocado
-- nesta migration (auditado no cabeçalho — sem uso real hoje, decisão de
-- fechar ou não fica pra uma etapa de limpeza futura).
--
-- save_purchase continua funcionando sem nenhuma mudança: é SECURITY
-- DEFINER, então o INSERT que ela já faz em purchase_items (pra criar um
-- item provisório, category='other' sempre) roda com os privilégios do
-- dono da função, nunca com os privilégios do caller (authenticated) —
-- o REVOKE abaixo não afeta esse caminho de forma nenhuma.
-- =============================================================

REVOKE INSERT, UPDATE ON TABLE public.purchase_items FROM authenticated;

-- =============================================================
-- FIM — ETAPA I2
-- =============================================================
--
-- Nenhuma mudança de schema. save_purchase, create_lot_from_purchase_line,
-- delete_purchase, suppliers, purchases, purchase_lines, lots,
-- lot_movements: inalterados. Produção (save_skewer_production_batch,
-- skewer_batch_components, delete_skewer_production_batch,
-- producao.html/producao.js): não tocada — supply com lot_id é a Etapa
-- I3, fora de escopo aqui. product_costs, Pedidos, create_customer_order,
-- stock_movements: não tocados.
