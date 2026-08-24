-- Compras + Lotes + Estoque por Lote — MELHORIA: EXCLUIR COMPRA PELO
-- HISTÓRICO DE COMPRAS.
--
-- Cria delete_purchase(p_purchase_id) — única porta de exclusão de uma
-- compra a partir de agora. Uma compra só pode ser excluída se NENHUM lote
-- gerado por suas linhas já teve qualquer movimentação além do movimento
-- inicial 'purchase' (ou seja: nunca houve production_use/sale/waste/
-- adjustment_in/adjustment_out/reversal em nenhum lote da compra). Se
-- permitido, a exclusão é uma reversão completa do lançamento: apaga os
-- lot_movements (só existirão o(s) movimento(s) 'purchase' inicial(is)),
-- depois os lots, depois a própria purchase — purchase_lines desaparece
-- sozinha via ON DELETE CASCADE já existente (migration 20260818160000).
--
-- Diferente de excluir uma PRODUÇÃO (Etapa G3, delete_skewer_production_
-- batch/delete_side_production_batch, que REVERTE saldo com um movimento
-- 'reversal' porque o consumo já aconteceu de verdade e o ledger precisa
-- registrar isso): aqui a compra inteira nunca teve uso real — apagar o(s)
-- movimento(s) 'purchase' junto com o lote é seguro porque não existe
-- nenhum evento histórico real a preservar. Ledger append-only continua
-- valendo para todo o resto do sistema (Produção); esta é uma exceção
-- deliberada e restrita ao caso "compra lançada por engano/teste, nunca
-- consumida".
--
-- NÃO altera schema (lots/lot_movements/purchases/purchase_lines já
-- existem desde as Etapas B/C). NÃO altera save_purchase,
-- create_lot_from_purchase_line, finalize_purchase_item (já executadas e
-- validadas). NÃO altera Produção (save_skewer_production_batch,
-- save_side_production_batch, delete_skewer_production_batch,
-- delete_side_production_batch, apply_*_production_cost). NÃO altera
-- Pedidos (create_customer_order, products.stock_quantity,
-- stock_movements) nem product_costs. Migrations já executadas não são
-- editadas.

-- =============================================================
-- 1. delete_purchase
-- =============================================================

CREATE OR REPLACE FUNCTION public.delete_purchase(
  p_purchase_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_purchase public.purchases%rowtype;
  v_lot_ids uuid[];
  v_movimentado boolean;
  v_lotes_removidos jsonb := '[]'::jsonb;
  v_lot public.lots%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem excluir compras.';
  end if;

  -- Idempotência natural: uma segunda chamada, com a compra já excluída,
  -- simplesmente não encontra a linha e cai aqui — nenhum marcador de
  -- exclusão foi adicionado (mesmo padrão já usado em delete_skewer_
  -- production_batch/delete_side_production_batch).
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
  -- save_skewer_production_batch/save_side_production_batch/delete_*, evita
  -- deadlock com qualquer fluxo concorrente (edição de compra, consumo em
  -- produção) tentando travar os mesmos lotes em ordem diferente.
  perform 1 from public.lots where id = any(v_lot_ids) order by id for update;

  -- Verifica ANTES de apagar qualquer coisa: existe algum movimento além do
  -- 'purchase' inicial em qualquer lote desta compra? Se sim, bloqueia a
  -- exclusão inteira (nunca parcial) — rollback integral, nada é alterado.
  select exists (
    select 1 from public.lot_movements
     where lot_id = any(v_lot_ids)
       and movement_type <> 'purchase'
  ) into v_movimentado;

  if v_movimentado then
    raise exception 'Esta compra já possui itens movimentados e não pode ser excluída.';
  end if;

  -- Só chega aqui se nenhum lote da compra teve uso real — apaga os
  -- movimentos 'purchase' iniciais, depois os lotes, depois a compra.
  -- purchase_lines desaparece sozinha via ON DELETE CASCADE já existente.
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
-- 2. Auditoria de GRANT DELETE em purchases — confirmado, não alterado.
--
-- A migration 20260818180000 (save_purchase) já revogou INSERT, UPDATE E
-- DELETE de authenticated em public.purchases (linha "REVOKE INSERT,
-- UPDATE, DELETE ON TABLE public.purchases FROM authenticated;") — DELETE
-- direto já estava fechado antes desta migration, confirmado por leitura
-- direta do arquivo, não presumido. Nada a revogar aqui. Mesma migration
-- também já revogou INSERT/UPDATE/DELETE de purchase_lines — igualmente
-- intocado.
-- =============================================================

-- =============================================================
-- FIM
-- =============================================================
--
-- Nenhuma mudança de schema. save_purchase, create_lot_from_purchase_line,
-- finalize_purchase_item permanecem exatamente como estavam. Produção
-- (save_skewer_production_batch, save_side_production_batch,
-- delete_skewer_production_batch, delete_side_production_batch,
-- apply_skewer_production_cost, apply_side_production_cost) não tocada.
-- Pedidos (create_customer_order, products.stock_quantity,
-- stock_movements), product_costs não tocados. Nenhuma UI alterada nesta
-- migration — só js/services/purchases-service.js (nova
-- excluirCompraNoSupabase) e js/compras.js/compras.html (botão no
-- Histórico de Compras) fora deste arquivo.
