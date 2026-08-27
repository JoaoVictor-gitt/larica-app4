-- L2.5G — RPC somente-leitura de cardápio pro motor conversacional do
-- WhatsApp (get_whatsapp_menu), projetada no W4.1 (seção 5) e
-- implementada como primeira fatia do W4.2.
--
-- Fonte de verdade única: products + combo_configs + combo_skewer_options
-- + combo_included_products — as mesmas 4 tabelas que o cardápio público
-- do site já usa (buscarProdutosDoSupabase(), js/services/products-service.js).
-- Não duplica regra nenhuma — só espelha o que já existe, formatado como
-- um jsonb único pro Worker consumir numa chamada.
--
-- Produtos com active=false são omitidos por completo (mesmo critério do
-- cardápio público). Produtos com is_available=false SÃO retornados, com
-- is_available:false explícito — decisão deliberada: permite o motor/IA
-- responder honestamente "esse item está indisponível agora" em vez de
-- inventar uma resposta.
--
-- Nunca expõe: product_costs (custo/margem — tabela nem é referenciada
-- aqui), fornecedores ou qualquer dado administrativo — só as colunas de
-- products necessárias pra montar/validar um pedido, mais a configuração
-- de combo (allowed_skewers/allowed_sides/included_items/skewer_options
-- com extra_price, nunca custo).
--
-- SECURITY DEFINER + search_path vazio: mesmo padrão de 100% das RPCs já
-- existentes no projeto. Não é estritamente necessário aqui — só
-- service_role vai chamar, que já tem privilégio administrativo
-- independente de SECURITY DEFINER/INVOKER (mesma evidência de
-- 20260824160000) — mas mantém consistência sem custo real.
--
-- NÃO altera products, combo_configs, combo_skewer_options,
-- combo_included_products, whatsapp_sessions, whatsapp_messages,
-- create_customer_order. NÃO cria pedido, carrinho, delivery, cupom,
-- pagamento, nem integra Meta/OpenAI.

CREATE OR REPLACE FUNCTION public.get_whatsapp_menu()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', p.id,
        'name', p.name,
        'category', p.category,
        'price', p.price,
        'active', p.active,
        'is_available', p.is_available,
        'stock_mode', p.stock_mode,
        'is_combo', (p.category = 'combos'),
        'combo', case when p.category = 'combos' then (
          select jsonb_build_object(
            'allowed_skewers', cc.allowed_skewers,
            'allowed_sides', cc.allowed_sides,
            'included_items', coalesce((
              select jsonb_agg(cip.included_product_id)
              from public.combo_included_products cip
              where cip.combo_id = p.id
            ), '[]'::jsonb),
            'skewer_options', coalesce((
              select jsonb_agg(jsonb_build_object(
                'product_id', cso.skewer_product_id,
                'extra_price', cso.extra_price
              ))
              from public.combo_skewer_options cso
              where cso.combo_id = p.id
            ), '[]'::jsonb)
          )
          from public.combo_configs cc
          where cc.product_id = p.id
        ) else null end
      )
      order by p.category, p.name
    ),
    '[]'::jsonb
  )
  from public.products p
  where p.active = true;
$function$;

REVOKE ALL ON FUNCTION public.get_whatsapp_menu() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_whatsapp_menu() FROM anon;
REVOKE ALL ON FUNCTION public.get_whatsapp_menu() FROM authenticated;

-- Nenhum GRANT EXECUTE a service_role — mesma justificativa/evidência já
-- documentada em 20260824160000_add_record_whatsapp_inbound_message_rpc.sql.
