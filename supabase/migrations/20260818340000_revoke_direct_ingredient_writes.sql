-- Etapa J6: fecha a escrita direta em public.ingredients para authenticated.
--
-- Desde J3/J4, toda criação/vínculo/categorização legítima de ingredient
-- acontece dentro de _resolve_ingredient_link/save_purchase_item/
-- finalize_purchase_item (SECURITY DEFINER, migrations 20260818320000/
-- 20260818330000) — nenhuma UI faz mais INSERT/UPDATE/DELETE direto em
-- ingredients (o CRUD independente em Produção foi removido na J5).
-- Auditoria repo-wide confirmou zero caller ativo de
-- criarIngredienteNoSupabase/atualizarIngredienteNoSupabase/
-- alternarStatusIngredienteNoSupabase/excluirIngredienteNoSupabase
-- (js/services/ingredients-service.js) — só permanecem definidas como
-- legado sem UI.
--
-- SECURITY DEFINER checa privilégio contra o DONO da função, não contra
-- o chamador (authenticated) — por isso este REVOKE não quebra nenhuma
-- das 3 RPCs acima, que continuam escrevendo em ingredients normalmente.

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.ingredients
  FROM authenticated;

-- Resultado esperado: authenticated fica só com SELECT (necessário para
-- ingredientesCache em Produção/Fichas Técnicas/Espetos/Acompanhamentos/
-- Compras). postgres/service_role mantêm privilégios administrativos —
-- REVOKE nunca atinge o dono/superuser. As policies de RLS
-- ingredients_insert_admin/ingredients_update_admin/ingredients_delete_admin
-- (migration 20260817160000) permanecem no catálogo, agora inócuas (sem
-- GRANT de tabela por trás, nunca chegam a ser avaliadas) — não removidas
-- nesta etapa, servem apenas de defesa redundante caso um GRANT futuro
-- seja reintroduzido por engano.
