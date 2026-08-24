-- Ingredientes + Fichas Técnicas + Sub-receitas — ETAPA 3 (sub-receitas /
-- preparos dentro de preparos). Migration incremental — 20260817170000
-- (que criou recipes/recipe_items) e 20260817171000 (rendimento derivado)
-- já foram executadas em produção, não são reeditadas.
--
-- Libera item_type='recipe' em recipe_items (hoje travado de propósito
-- desde a correção de ciclo da Etapa 2) e cria a RPC administrativa
-- save_recipe_item, que passa a ser a ÚNICA porta de escrita (INSERT/
-- UPDATE) de recipe_items — tanto pra item_type='ingredient' quanto
-- 'recipe' — centralizando validação de unidade e detecção de ciclo
-- indireto server-side. Fecha também o INSERT/UPDATE direto que
-- authenticated ainda tinha na tabela desde a Etapa 2 (correção de
-- integridade — ver seção 3 abaixo), pra essa porta única de escrita não
-- poder ser contornada. Não cria recipe_products, não altera product_costs,
-- products, orders, create_customer_order, business_settings, estoque,
-- RLS geral ou qualquer outra tabela/regra.

-- =============================================================
-- 1. Constraints de recipe_items — libera item_type='recipe'. Substitui
-- recipe_items_item_type_valido/recipe_items_estrutura_valida (que hoje só
-- aceitam 'ingredient') pela forma original com os dois ramos.
-- recipe_items_sem_autoreferencia permanece intocada.
-- =============================================================

ALTER TABLE public.recipe_items
  DROP CONSTRAINT recipe_items_item_type_valido;

ALTER TABLE public.recipe_items
  DROP CONSTRAINT recipe_items_estrutura_valida;

ALTER TABLE public.recipe_items
  ADD CONSTRAINT recipe_items_item_type_valido
  CHECK (item_type IN ('ingredient', 'recipe'));

ALTER TABLE public.recipe_items
  ADD CONSTRAINT recipe_items_estrutura_valida
  CHECK (
    (item_type = 'ingredient' AND ingredient_id IS NOT NULL AND subrecipe_id IS NULL) OR
    (item_type = 'recipe'     AND subrecipe_id  IS NOT NULL AND ingredient_id IS NULL)
  );

-- =============================================================
-- 2. RPC save_recipe_item — cria OU atualiza (p_item_id NULL = cria) um
-- item de receita, ingrediente OU sub-receita. SECURITY DEFINER: roda com
-- os privilégios do dono da função, por isso valida is_admin() explicitamente
-- logo no início — RLS de recipe_items não protege quem chama através
-- desta função (SECURITY DEFINER contorna RLS por definição). Nunca recebe
-- custo/rendimento/cost_per_base_unit do client — só IDs, quantity, unit,
-- tipo; todo cálculo/validação de negócio acontece aqui dentro.
--
-- Validações, nesta ordem: admin; tipo válido; quantity > 0; unit válida;
-- receita principal existe (trava a linha — serializa edições concorrentes
-- da MESMA receita); se for edição, item existe e pertence à receita, e
-- tipo/referência não podem ter mudado (Etapa 3 item 15 — trocar tipo
-- exige remover e recriar, nunca um "swap" silencioso); então, por tipo:
--   ingredient: ingrediente existe; unit == ingredients.base_unit;
--   recipe: não referencia a si mesma; sub-receita existe; sub-receita tem
--     rendimento calculável (exatamente 1 unit distinta entre os itens
--     dela, nunca 0 nem >1); unit == essa unidade calculada; e, só então,
--     detecção de ciclo indireto via CTE recursiva partindo do preparo que
--     está sendo referenciado (p_reference_id) — se for possível alcançar
--     p_recipe_id percorrendo só vínculos item_type='recipe', usar esse
--     preparo aqui fecharia um ciclo, então é rejeitado.
--
-- Risco aceito, documentado (mesma classe já aceita em create_customer_
-- order): o FOR UPDATE trava só a receita principal (p_recipe_id) durante
-- a checagem de ciclo — duas edições concorrentes em receitas DIFERENTES
-- da mesma árvore poderiam, em teoria, passar cada uma no próprio check
-- antes de qualquer uma comitar. Cenário de baixíssima probabilidade numa
-- feature admin-only, de baixo tráfego, em fase de testes — lock de
-- tabela inteira seria desproporcional ao risco real.
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_recipe_item(
  p_item_id uuid,
  p_recipe_id uuid,
  p_item_type text,
  p_reference_id uuid,
  p_quantity numeric,
  p_unit text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare

  v_recipe_encontrada boolean;
  v_subreceita_encontrada boolean;
  v_existing record;
  v_ingredient_base_unit text;
  v_sub_unidades int;
  v_sub_unit text;
  v_ciclo boolean;
  v_ingredient_id uuid;
  v_subrecipe_id uuid;
  v_result record;

begin

  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar a composição de fichas técnicas.';
  end if;

  if p_item_type not in ('ingredient', 'recipe') then
    raise exception 'Tipo de item inválido.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade deve ser maior que zero.';
  end if;

  if p_unit is null or p_unit not in ('g', 'ml', 'un') then
    raise exception 'Unidade inválida.';
  end if;

  select exists(select 1 from public.recipes where id = p_recipe_id)
    into v_recipe_encontrada;

  if not v_recipe_encontrada then
    raise exception 'Ficha técnica não encontrada.';
  end if;

  -- Trava a receita principal até o fim da transação — serializa edições
  -- concorrentes de composição desta mesma receita.
  perform 1 from public.recipes where id = p_recipe_id for update;

  -- Edição: item precisa existir e pertencer à mesma receita; tipo/
  -- referência são imutáveis numa linha existente.
  if p_item_id is not null then

    select * into v_existing
    from public.recipe_items
    where id = p_item_id
    for update;

    if v_existing.id is null or v_existing.recipe_id <> p_recipe_id then
      raise exception 'Item não encontrado nesta ficha técnica.';
    end if;

    if v_existing.item_type <> p_item_type
       or coalesce(v_existing.ingredient_id, v_existing.subrecipe_id) <> p_reference_id then
      raise exception 'Não é permitido alterar o tipo ou o item referenciado de uma linha existente — remova e adicione novamente.';
    end if;

  end if;

  if p_item_type = 'ingredient' then

    select base_unit into v_ingredient_base_unit
    from public.ingredients
    where id = p_reference_id;

    if v_ingredient_base_unit is null then
      raise exception 'Ingrediente não encontrado.';
    end if;

    if p_unit <> v_ingredient_base_unit then
      raise exception 'Unidade incompatível com o ingrediente selecionado.';
    end if;

    v_ingredient_id := p_reference_id;
    v_subrecipe_id := null;

  else

    if p_reference_id = p_recipe_id then
      raise exception 'Uma ficha técnica não pode usar a si mesma como preparo.';
    end if;

    select exists(select 1 from public.recipes where id = p_reference_id)
      into v_subreceita_encontrada;

    if not v_subreceita_encontrada then
      raise exception 'Ficha técnica (preparo) não encontrada.';
    end if;

    select count(distinct unit) into v_sub_unidades
    from public.recipe_items
    where recipe_id = p_reference_id;

    if v_sub_unidades is null or v_sub_unidades = 0 then
      raise exception 'Este preparo ainda não tem ingredientes suficientes para ser usado em outra ficha.';
    end if;

    if v_sub_unidades > 1 then
      raise exception 'Este preparo tem unidades mistas e não pode ser usado como componente.';
    end if;

    select unit into v_sub_unit
    from public.recipe_items
    where recipe_id = p_reference_id
    limit 1;

    if p_unit <> v_sub_unit then
      raise exception 'Unidade incompatível com o rendimento do preparo selecionado.';
    end if;

    -- Ciclo indireto: partindo do preparo prestes a ser usado
    -- (p_reference_id), percorre só vínculos item_type='recipe' pra ver se
    -- p_recipe_id é alcançável — se for, o novo vínculo fecharia um ciclo.
    with recursive dependentes as (

      select p_reference_id as recipe_id

      union

      select ri.subrecipe_id
      from public.recipe_items ri
      join dependentes d on ri.recipe_id = d.recipe_id
      where ri.item_type = 'recipe'

    )
    select exists(select 1 from dependentes where recipe_id = p_recipe_id)
      into v_ciclo;

    if v_ciclo then
      raise exception 'Esta sub-receita criaria uma dependência circular.';
    end if;

    v_ingredient_id := null;
    v_subrecipe_id := p_reference_id;

  end if;

  if p_item_id is null then

    insert into public.recipe_items (
      recipe_id, item_type, ingredient_id, subrecipe_id, quantity, unit
    )
    values (
      p_recipe_id, p_item_type, v_ingredient_id, v_subrecipe_id, p_quantity, p_unit
    )
    returning * into v_result;

  else

    update public.recipe_items
       set quantity = p_quantity,
           updated_at = now()
     where id = p_item_id
    returning * into v_result;

  end if;

  return jsonb_build_object(
    'id', v_result.id,
    'recipe_id', v_result.recipe_id,
    'item_type', v_result.item_type,
    'ingredient_id', v_result.ingredient_id,
    'subrecipe_id', v_result.subrecipe_id,
    'quantity', v_result.quantity,
    'unit', v_result.unit,
    'created_at', v_result.created_at,
    'updated_at', v_result.updated_at
  );

end;
$function$;

-- =============================================================
-- 3. Fecha o INSERT/UPDATE direto que authenticated ainda tinha em
-- recipe_items desde a Etapa 2 (GRANT SELECT, INSERT, UPDATE, DELETE,
-- migration 20260817170000). Com save_recipe_item existindo, esse INSERT/
-- UPDATE direto contornaria justamente as validações que a RPC agora
-- centraliza (compatibilidade recipe_items.unit x ingredients.base_unit
-- ou x rendimento da sub-receita, detecção de ciclo indireto) — um
-- authenticated que passasse pelas policies recipe_items_insert_admin/
-- update_admin ainda conseguiria gravar uma linha sem essas checagens.
--
-- SELECT direto permanece permitido — continua protegido pela RLS/
-- is_staff() (recipe_items_select_staff), sem mudança nenhuma.
--
-- DELETE direto permanece permitido — continua protegido pela RLS/
-- is_admin() (recipe_items_delete_admin); a UI precisa conseguir remover
-- itens e remover nunca tem risco de ciclo/incompatibilidade de unidade,
-- por isso não precisa passar por RPC nenhuma.
--
-- INSERT e UPDATE diretos deixam de ser permitidos para authenticated a
-- partir daqui — criação e edição de item de receita passam
-- obrigatoriamente por public.save_recipe_item(). Como essa RPC é
-- SECURITY DEFINER, ela continua conseguindo fazer o INSERT/UPDATE mesmo
-- depois deste REVOKE (roda com os privilégios do dono da função, não do
-- caller) — e ela mesma continua validando public.is_admin() logo no
-- início, então a barreira de "só admin" não se perde, só passa a ser
-- garantida por dentro da função em vez de por GRANT+RLS na tabela.
--
-- As policies recipe_items_insert_admin/recipe_items_update_admin NÃO são
-- removidas — ficam como defesa redundante e documentação da política da
-- tabela, mas sem efeito prático depois deste REVOKE (RLS só é avaliada
-- depois que o GRANT já autorizou a operação; sem o GRANT, a operação
-- nunca chega a ser avaliada pela policy).
-- =============================================================

REVOKE INSERT, UPDATE
  ON TABLE public.recipe_items
  FROM authenticated;

-- =============================================================
-- 4. GRANTs da função. Postgres concede EXECUTE a PUBLIC automaticamente em
-- toda CREATE FUNCTION — precisa REVOKE explícito, mesmo cuidado já
-- aplicado às tabelas desde o caso real de default privileges em
-- product_costs.
-- =============================================================

REVOKE ALL ON FUNCTION public.save_recipe_item(uuid, uuid, text, uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_recipe_item(uuid, uuid, text, uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_recipe_item(uuid, uuid, text, uuid, numeric, text) TO authenticated;

-- Nenhuma outra alteração: RLS geral de recipes/recipe_items continua
-- exatamente como estava (policies insert_admin/update_admin permanecem
-- ativas como camada redundante; a RPC é quem passa a validar unidade e
-- ciclo, coisa que RLS não consegue expressar).
