-- Etapa K2: classificação explícita da origem do estoque vendável de cada
-- produto. Não automatiza nada ainda (isso é K3/K4) — só schema + UI de
-- classificação manual, preparando o terreno.
--
-- Diagnóstico K1 confirmou que public.products não tem CREATE TABLE em
-- nenhuma migration deste repo (tabela predata o histórico rastreado) e que
-- purchase_items.product_id é usado identicamente hoje para produtos de
-- revenda (ex.: Coca-Cola) e para matéria-prima de produção (ex.: Contra
-- Filé) — sem nenhuma flag distinguindo os dois casos. stock_mode fecha
-- essa lacuna:
--   'purchased'  -> estoque nasce de Compras (produto comprado pronto)
--   'produced'   -> estoque nasce de Produção (produto feito internamente)
--   'untracked'  -> produto não possui estoque próprio (ex.: Combos)
--
-- Default 'untracked' é proposital: nenhum produto existente pode nascer
-- classificado automaticamente por categoria — a classificação é sempre
-- manual, feita produto a produto pela UI depois do deploy. Sem backfill
-- em massa nesta migration.

ALTER TABLE public.products
  ADD COLUMN stock_mode text NOT NULL DEFAULT 'untracked';

ALTER TABLE public.products
  ADD CONSTRAINT products_stock_mode_valido
  CHECK (stock_mode IN ('purchased', 'produced', 'untracked'));

-- Nenhuma mudança de RLS/GRANT: public.products não tem nenhuma RLS/GRANT
-- própria neste repo (confirmado no diagnóstico K1) — a coluna nova herda
-- o mesmo acesso de INSERT/UPDATE que authenticated já tinha, nada novo a
-- conceder aqui. stock_quantity, RPCs de Compras/Produção/Pedidos e
-- is_available continuam inteiramente intocados por esta migration.
