-- Compras + Lotes + Estoque por Lote — ETAPA C (lots + lot_movements +
-- primeira RPC de escrita, sem consumo/baixa ainda). Transforma uma
-- purchase_line já registrada (Etapa B) num LOTE com saldo e gera o
-- movimento inicial de entrada — nada de Produção/Pedidos/
-- products.stock_quantity/stock_movements/product_costs é tocado aqui.
--
-- Diferente das Etapas A/B (GRANT direto pra authenticated): aqui a
-- escrita já nasce FECHADA desde o início — lots/lot_movements recebem só
-- GRANT SELECT pra authenticated, toda criação passa pela RPC
-- create_lot_from_purchase_line (SECURITY DEFINER, valida is_admin()) —
-- aplicando proativamente a mesma lição de segurança já usada em
-- side_batch_components/skewer_batch_components, desde a primeira versão,
-- sem precisar de uma rodada de correção depois.
--
-- NÃO altera: purchase_items, suppliers, purchases, purchase_lines
-- (migrations das Etapas A/B não editadas), products, ingredients,
-- production_supplies, stock_movements, create_customer_order,
-- product_costs, Produção de Espetos/Acompanhamentos, Pedidos, Estoque.
-- Sem consumo de lote nesta etapa — só criação segura + movimento inicial.

-- =============================================================
-- 1. Tabela lots.
-- Status ARMAZENADO (não derivado), com CHECK impedindo a inconsistência
-- óbvia entre status e saldo (available exige saldo > 0; depleted exige
-- saldo exatamente 0; archived é só arquivamento visual/histórico e pode
-- ter qualquer saldo). purchase_line_id SEM ON DELETE CASCADE — ver bloco
-- de impacto no fim do arquivo; UNIQUE garante no máximo 1 lote por linha
-- de compra. purchase_item_id persistido no lote (consulta rápida/filtro
-- sem join) — a RPC é responsável por garantir que bate com
-- purchase_line.purchase_item_id (única porta de escrita). Sem código de
-- lote amigável — UUID é a identidade real, UI futura monta a descrição
-- a partir dos outros campos (ex. "Batata • 20/08/2026 • 200g restantes").
-- =============================================================

CREATE TABLE public.lots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_line_id    uuid NOT NULL REFERENCES public.purchase_lines(id),
  purchase_item_id    uuid NOT NULL REFERENCES public.purchase_items(id),
  received_at         date NOT NULL,
  expiration_date     date NULL,
  initial_quantity    numeric(14,3) NOT NULL,
  remaining_quantity  numeric(14,3) NOT NULL,
  base_unit           text NOT NULL,
  unit_cost_base      numeric(16,8) NOT NULL,
  status              text NOT NULL DEFAULT 'available',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NULL,
  updated_by          uuid NULL,

  CONSTRAINT lots_base_unit_valida             CHECK (base_unit IN ('g','ml','un')),
  CONSTRAINT lots_status_valido                CHECK (status IN ('available','depleted','archived')),
  CONSTRAINT lots_initial_quantity_positiva    CHECK (initial_quantity > 0),
  CONSTRAINT lots_remaining_nao_negativo       CHECK (remaining_quantity >= 0),
  CONSTRAINT lots_remaining_nao_excede_inicial CHECK (remaining_quantity <= initial_quantity),
  CONSTRAINT lots_unit_cost_nao_negativo       CHECK (unit_cost_base >= 0),
  CONSTRAINT lots_expiration_coerente          CHECK (expiration_date IS NULL OR expiration_date >= received_at),
  CONSTRAINT lots_status_saldo_coerente CHECK (
  (status = 'available' AND remaining_quantity > 0) OR
  (status = 'depleted'  AND remaining_quantity = 0) OR
  (status = 'archived'  AND remaining_quantity = 0)
  )
);

CREATE UNIQUE INDEX idx_lots_purchase_line_unico ON public.lots (purchase_line_id);
CREATE INDEX idx_lots_purchase_item_id           ON public.lots (purchase_item_id);
CREATE INDEX idx_lots_received_at                ON public.lots (received_at);
CREATE INDEX idx_lots_status                     ON public.lots (status);
CREATE INDEX idx_lots_expiration_date            ON public.lots (expiration_date);

-- =============================================================
-- 2. Tabela lot_movements — histórico imutável de toda alteração de saldo
-- de um lote. quantity sempre POSITIVA — o sinal é implícito no
-- movement_type (purchase/adjustment_in somam; production_use/sale/waste/
-- adjustment_out subtraem; reversal pode ir em qualquer direção conforme
-- o que está revertendo), nunca um número negativo ambíguo.
-- balance_before/balance_after sempre persistidos (nunca derivados de
-- "saldo atual menos os movimentos depois") — auditoria correta mesmo se
-- o lote continuar mudando depois. source_type/source_id sem FK real
-- (referenciam tabelas diferentes conforme o tipo — mesmo trade-off já
-- aceito em skewer_batch_components/side_batch_components); source_id
-- opcional.
-- =============================================================

CREATE TABLE public.lot_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           uuid NOT NULL REFERENCES public.lots(id),
  purchase_item_id uuid NOT NULL REFERENCES public.purchase_items(id),
  movement_type    text NOT NULL,
  quantity         numeric(14,3) NOT NULL,
  balance_before   numeric(14,3) NOT NULL,
  balance_after    numeric(14,3) NOT NULL,
  source_type      text NOT NULL,
  source_id        uuid NULL,
  notes            text NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NULL,

  CONSTRAINT lot_movements_tipo_valido CHECK (
    movement_type IN ('purchase','production_use','sale','waste','adjustment_in','adjustment_out','reversal')
  ),
  CONSTRAINT lot_movements_source_valido CHECK (
    source_type IN ('purchase_line','skewer_production','side_production','order','waste','manual_adjustment','reversal','other')
  ),
  CONSTRAINT lot_movements_quantity_positiva    CHECK (quantity > 0),
  CONSTRAINT lot_movements_balance_nao_negativo CHECK (balance_before >= 0 AND balance_after >= 0)
);

CREATE INDEX idx_lot_movements_lot_id           ON public.lot_movements (lot_id);
CREATE INDEX idx_lot_movements_occurred_at      ON public.lot_movements (occurred_at);
CREATE INDEX idx_lot_movements_purchase_item_id ON public.lot_movements (purchase_item_id);

-- =============================================================
-- 3. RLS — policies existem em ambas as tabelas como defesa/documentação,
-- mas SEM GRANT de escrita pra authenticated (nem admin escreve direto —
-- lote e movimento são histórico, nunca editáveis fora da RPC): toda
-- criação passa obrigatoriamente por create_lot_from_purchase_line
-- (SECURITY DEFINER), nunca por INSERT/UPDATE/DELETE direto.
-- =============================================================

ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY lots_select_staff ON public.lots
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY lots_insert_admin ON public.lots
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY lots_update_admin ON public.lots
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY lots_delete_admin ON public.lots
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL PRIVILEGES ON TABLE public.lots FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.lots FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.lots FROM authenticated;
GRANT SELECT ON TABLE public.lots TO authenticated;

ALTER TABLE public.lot_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY lot_movements_select_staff ON public.lot_movements
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY lot_movements_insert_admin ON public.lot_movements
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY lot_movements_update_admin ON public.lot_movements
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY lot_movements_delete_admin ON public.lot_movements
  FOR DELETE TO authenticated USING (public.is_admin());

REVOKE ALL PRIVILEGES ON TABLE public.lot_movements FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.lot_movements FROM PUBLIC;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE public.lot_movements FROM authenticated;
GRANT SELECT ON TABLE public.lot_movements TO authenticated;

-- =============================================================
-- 4. RPC create_lot_from_purchase_line — única porta de escrita pra criar
-- lote+movimento inicial, numa única transação (a própria invocação da
-- função). SELECT ... FOR UPDATE na purchase_line: uma segunda chamada
-- concorrente pra mesma linha bloqueia até a primeira transação terminar;
-- ao prosseguir, seu próprio "exists" já encontra o lote recém-criado e
-- lança exceção antes de tentar inserir — o UNIQUE em lots.purchase_line_id
-- é a segunda barreira (mesmo se algo escapasse do lock, o INSERT
-- duplicado falharia na constraint). tracks_stock validado direto de
-- purchase_items.tracks_stock (nunca confiado do client). Conversão de
-- unidade: NÃO recalculada aqui — confia em purchase_lines.base_quantity
-- (já persistida, responsabilidade da Etapa B/futura save_purchase) e usa
-- purchase_items.base_unit diretamente como lots.base_unit (não há coluna
-- de unidade em purchase_lines pra comparar contra). Custo: snapshot puro
-- de purchase_lines.unit_cost_base, nunca recalculado depois.
-- purchase_item_id do movimento sempre resolvido do banco (via
-- v_line.purchase_item_id), nunca de parâmetro do client.
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

  return jsonb_build_object('lot', to_jsonb(v_lot), 'movement', to_jsonb(v_movement));
end;
$function$;

REVOKE ALL ON FUNCTION public.create_lot_from_purchase_line(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_lot_from_purchase_line(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_lot_from_purchase_line(uuid, date) TO authenticated;

-- =============================================================
-- 5. Impacto na FK antiga purchase_lines.purchase_id ON DELETE CASCADE
-- (documentado, NÃO alterado nesta migration).
--
-- Hoje purchase_lines.purchase_id tem ON DELETE CASCADE a partir de
-- purchases (migration 20260818160000). Como lots.purchase_line_id NÃO
-- tem cascade (acima), uma tentativa de DELETE FROM purchases WHERE
-- id=... cuja compra tenha alguma linha já convertida em lote vai:
-- tentar cascatear a exclusão de purchase_lines -> a exclusão dessa linha
-- é bloqueada pela FK de lots (violação de chave estrangeira) -> o DELETE
-- inteiro falha atomicamente (Postgres valida todas as FKs antes de
-- confirmar a operação) -> a compra NÃO é apagada. Esse é exatamente o
-- comportamento protetivo desejado — nenhuma mudança de schema necessária
-- em purchase_lines agora.
-- =============================================================

-- Nenhuma outra alteração: purchase_items, suppliers, purchases,
-- purchase_lines (migrations das Etapas A/B não editadas — purchases/
-- purchase_lines continuam com GRANT direto pra authenticated, sem
-- alteração; a futura save_purchase é quem vai fechar isso), products,
-- ingredients, production_supplies, stock_movements,
-- create_customer_order, product_costs, Produção de Espetos/
-- Acompanhamentos, Pedidos, Estoque permanecem exatamente como estavam.
