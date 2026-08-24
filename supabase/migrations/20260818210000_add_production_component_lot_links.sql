-- Integração de Lotes de Compra com Produção — ETAPA G1 (schema).
--
-- Adiciona lot_id nullable em skewer_batch_components/side_batch_components
-- — vínculo histórico real para lots(id), preparando o consumo de saldo por
-- lote específico numa compra (Etapas G2/G3/G4, futuras). Só item_type=
-- 'ingredient' pode ter lot_id (CHECK) — 'recipe' nunca (decisão 3, V1: uma
-- ficha técnica não representa matéria-prima comprada, continua sempre
-- derivada on-read); 'supply' (só existe em skewer_batch_components) também
-- nunca tem lot_id nesta V1 (decisão 1: lot_id só em 'ingredient').
--
-- NÃO altera RPCs (save_skewer_production_batch, save_side_production_batch,
-- apply_skewer_production_cost, apply_side_production_cost) — assinatura e
-- corpo idênticos aos já executados. NÃO altera UI/services
-- (producao.html/producao.js/producao.css, skewer-production-service.js,
-- side-production-service.js). NÃO altera Compras (save_purchase,
-- finalize_purchase_item, create_lot_from_purchase_line,
-- compras.html/js/css) nem Pedidos (create_customer_order,
-- products.stock_quantity, stock_movements, checkout). NÃO altera lots nem
-- lot_movements — enums já suficientes (production_use/reversal,
-- skewer_production/side_production), confirmados na rodada de diagnóstico.
-- Nenhum saldo é consumido, nenhum lot_movement é inserido nesta etapa.
-- Migrations já executadas não são editadas.

-- =============================================================
-- 1. skewer_batch_components.lot_id
--
-- Sem ON DELETE CASCADE nem SET NULL — NO ACTION (default): excluir um lote
-- referenciado por um componente de produção deve falhar por violação de
-- FK, nunca desvincular silenciosamente. Na prática isso nunca chega a ser
-- testado por um DELETE real, porque lots já não tem GRANT DELETE pra
-- authenticated em nenhuma hipótese (confirmado na rodada de diagnóstico) —
-- a FK é uma segunda camada de proteção, puramente defensiva.
--
-- name_snapshot/quantity/unit/unit_cost_snapshot (colunas já existentes)
-- não são alteradas — o custo histórico continua inteiramente congelado em
-- unit_cost_snapshot, nunca duplicado em colunas novas (lot_id não é
-- snapshot, é só o vínculo).
-- =============================================================

ALTER TABLE public.skewer_batch_components
  ADD COLUMN lot_id uuid NULL REFERENCES public.lots(id);

-- Só item_type='ingredient' pode ter lot_id — recipe/supply nunca, mesmo
-- por um caminho de escrita futuro que não passe pela UI/RPC atual.
ALTER TABLE public.skewer_batch_components
  ADD CONSTRAINT skewer_components_lot_id_somente_ingredient
  CHECK (
    lot_id IS NULL
    OR item_type = 'ingredient'
  );

-- Reconciliação/auditoria futura (Etapas G2/G3) vai buscar componentes por
-- lote — índice justificado desde já.
CREATE INDEX idx_skewer_batch_components_lot_id
  ON public.skewer_batch_components (lot_id);

-- =============================================================
-- 2. side_batch_components.lot_id — mesmo tratamento exato.
-- =============================================================

ALTER TABLE public.side_batch_components
  ADD COLUMN lot_id uuid NULL REFERENCES public.lots(id);

ALTER TABLE public.side_batch_components
  ADD CONSTRAINT side_components_lot_id_somente_ingredient
  CHECK (
    lot_id IS NULL
    OR item_type = 'ingredient'
  );

CREATE INDEX idx_side_batch_components_lot_id
  ON public.side_batch_components (lot_id);

-- =============================================================
-- FIM — ETAPA G1
-- =============================================================
--
-- Sem UNIQUE de ingredient_id nem de lot_id em nenhuma das duas tabelas —
-- multi-lote (mesmo ingredient_id em componentes diferentes, cada um com
-- lot_id distinto) precisa continuar permitido; dois componentes podem até
-- referenciar o mesmo lot_id, o schema não impede (decisão 4/8, confirmado
-- no diagnóstico: a mudança de regra de duplicidade — que hoje bloqueia
-- item_type+reference_id repetidos, sem considerar lot_id — é escopo da
-- Etapa G2, nas RPCs, não desta migration).
--
-- Todas as linhas já existentes em skewer_batch_components/
-- side_batch_components ficam com lot_id=NULL automaticamente (ADD COLUMN
-- sem DEFAULT não-nulo) — nenhum backfill, produções históricas continuam
-- válidas e inalteradas.
--
-- RLS: policies de skewer_batch_components/side_batch_components não são
-- tocadas (continuam: staff SELECT via is_staff(), admin INSERT/UPDATE/
-- DELETE via policy — mas sem GRANT de escrita pra authenticated, mesmo
-- estado desde a criação das tabelas).
--
-- GRANTs: não tocados. Confirmado por leitura das migrations 20260818110000/
-- 20260818140000 (rodada de diagnóstico anterior): as duas tabelas de
-- componente têm hoje só GRANT SELECT pra authenticated — nenhuma escrita
-- direta, toda criação/edição passa por save_skewer_production_batch/
-- save_side_production_batch (SECURITY DEFINER). Isso permanece
-- exatamente assim depois desta migration; a coluna nova simplesmente não
-- é gravável por ninguém ainda, porque nenhuma RPC a preenche até a G2.
--
-- lots/lot_movements: schema, RLS e GRANTs inalterados. save_purchase,
-- finalize_purchase_item, create_lot_from_purchase_line inalteradas.
-- save_skewer_production_batch, save_side_production_batch,
-- apply_skewer_production_cost, apply_side_production_cost inalteradas —
-- lot_id existe na tabela mas nenhuma RPC ainda sabe que ele existe.
