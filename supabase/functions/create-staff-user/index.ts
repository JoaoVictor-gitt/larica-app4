// supabase/functions/create-staff-user/index.ts
//
// Cria um funcionário/admin novo: usuário Auth (email técnico interno,
// nunca exposto) + public.profiles + public.user_permissions (se employee).
// service_role só é instanciado depois de confirmar, via is_admin(), que
// quem chamou é um admin ativo — nunca antes disso. Function focada só em
// CRIAR (Fase 10C/Etapa C) — list/update/delete de usuários não vivem aqui.
//
// Nada nesta function foi deployado. Secrets (ALLOWED_ORIGIN e as chaves de
// runtime) não foram configurados remotamente — isso é uma etapa separada.

import { createClient } from 'npm:@supabase/supabase-js@2';

const LARICA_AUTH_EMAIL_DOMAIN = 'larica.internal';

const PERMISSOES_VALIDAS = new Set([
  'dashboard.view',
  'orders.view',
  'orders.manage',
  'products.view',
  'products.manage',
  'stock.view',
  'stock.manage',
  'history.view',
  'settings.manage',
  'users.manage',
]);

// SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY vêm injetadas automaticamente pelo
// runtime de Edge Functions do Supabase (confirmado pelo usuário contra a documentação atual) —
// nunca hardcoded aqui. ALLOWED_ORIGIN é o único secret que este projeto precisa configurar.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN');

/** null quando ALLOWED_ORIGIN não está configurado — quem chama decide falhar (nunca libera '*'). */
function construirCorsHeaders(): Record<string, string> | null {
  if (!ALLOWED_ORIGIN) return null;
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respostaJson(corpo: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function normalizarUsername(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

/** Valida o payload inteiro (inclusive a whitelist de permissions) antes de qualquer chamada ao Auth. */
function validarPayload(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return 'Payload inválido.';

  const username = normalizarUsername(payload.username);
  if (typeof payload.username !== 'string' || !username || !/^[a-z0-9._-]+$/.test(username)) {
    return 'Nome de usuário inválido. Use apenas letras minúsculas, números, ponto, underline ou hífen.';
  }
  if (username.length < 3 || username.length > 50) {
    return 'Nome de usuário deve ter entre 3 e 50 caracteres.';
  }

  if (typeof payload.password !== 'string' || payload.password.length < 12 || payload.password.length > 128) {
    return 'A senha precisa ter entre 12 e 128 caracteres.';
  }

  if (payload.fullName !== undefined && payload.fullName !== null) {
    if (typeof payload.fullName !== 'string') {
      return 'Nome inválido.';
    }
    if (payload.fullName.trim().length > 100) {
      return 'Nome não pode exceder 100 caracteres.';
    }
  }

  if (payload.role !== 'admin' && payload.role !== 'employee') {
    return "Perfil inválido. Use 'admin' ou 'employee'.";
  }

  if (typeof payload.active !== 'boolean') {
    return "O campo 'active' precisa ser verdadeiro ou falso.";
  }

  if (!Array.isArray(payload.permissions)) {
    return "O campo 'permissions' precisa ser uma lista.";
  }

  if (payload.permissions.length > PERMISSOES_VALIDAS.size) {
    return 'Lista de permissões inválida.';
  }

  if (payload.role === 'admin' && payload.permissions.length > 0) {
    return 'Administradores não podem receber permissions — deixe a lista vazia.';
  }

  for (const permissao of payload.permissions) {
    if (!PERMISSOES_VALIDAS.has(permissao)) {
      return `Permissão inválida: ${permissao}.`;
    }
  }

  return null;
}

/**
 * O SDK atual não expõe um código estruturado e estável pra "email já existe" em createUser() —
 * mapeado defensivamente pelo status HTTP combinado com o texto que a API do GoTrue retorna hoje.
 * Se o formato mudar, o pior caso é cair no 500 genérico abaixo (nunca um erro escondido/mascarado).
 * NÃO confirmado contra o SDK real ainda — validar isso antes do deploy (ver plano da Etapa C).
 */
function ehConflitoDeEmailExistente(erro: any): boolean {
  if (!erro) return false;
  const mensagem = String(erro.message || '').toLowerCase();
  const status = erro.status;
  return (status === 422 || status === 400) && mensagem.includes('already') && mensagem.includes('registered');
}

/**
 * Uma única chamada desfaz Auth user + profile + user_permissions (cascatas já existentes,
 * Etapas 0/1/A). Retorna se o rollback realmente funcionou — quem chama decide o que fazer com
 * isso (aqui: só logar com segurança; a resposta externa continua um 500 genérico de qualquer forma).
 */
async function tentarRollback(supabaseAdmin: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('[create-staff-user] ROLLBACK FALHOU — possível Auth user órfão, remoção manual pode ser necessária. userId:', userId);
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  // 1. ALLOWED_ORIGIN configurado?
  const cors = construirCorsHeaders();

  // Sem ALLOWED_ORIGIN configurado: falha segura, sem processar nada — nem headers CORS pra devolver.
  if (!cors) {
    return new Response(JSON.stringify({ error: 'Configuração de CORS ausente no servidor.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. headers já montados acima (cors).

  // 3. Origin da request, quando presente, precisa bater com ALLOWED_ORIGIN — nunca reflete outro
  //    valor, nunca '*'. Requests sem header Origin (server-to-server: curl, outro backend, etc.)
  //    NÃO são rejeitadas por isso — Origin é um header de browser, ausência dele não é suspeita por
  //    si só. CORS continua não sendo o mecanismo de autorização (isso é JWT + is_admin(), mais abaixo).
  const requestOrigin = req.headers.get('Origin');
  if (requestOrigin && requestOrigin !== ALLOWED_ORIGIN) {
    return respostaJson({ error: 'Origem não permitida.' }, 403, cors);
  }

  // 4. OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 5. Restante do fluxo
  if (req.method !== 'POST') {
    return respostaJson({ error: 'Método não permitido.' }, 405, cors);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return respostaJson({ error: 'Configuração do servidor incompleta.' }, 500, cors);
  }

  // --------------------------------------------------------------------
  // 1. Payload — validado por completo antes de tocar em qualquer coisa de Auth
  // --------------------------------------------------------------------
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return respostaJson({ error: 'Corpo da requisição inválido (JSON esperado).' }, 400, cors);
  }

  const erroValidacao = validarPayload(payload);
  if (erroValidacao) {
    return respostaJson({ error: erroValidacao }, 400, cors);
  }

  const username = normalizarUsername(payload.username);
  const password: string = payload.password;
  const fullName: string | null = typeof payload.fullName === 'string' ? payload.fullName.trim() || null : null;
  const role: 'admin' | 'employee' = payload.role;
  const active: boolean = payload.active;
  const permissions: string[] = Array.from(new Set(payload.permissions as string[]));

  // --------------------------------------------------------------------
  // 2. Autenticação/autorização do caller — client "scoped" à sessão dele,
  //    NUNCA service_role pra decidir isso. callerUserId vem do JWT validado
  //    pelo próprio Supabase Auth, nunca de nada enviado no payload.
  // --------------------------------------------------------------------
  const authorization = req.headers.get('Authorization');
  if (!authorization) {
    return respostaJson({ error: 'Sessão não autenticada.' }, 401, cors);
  }

  const supabaseComoCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });

  const { data: userData, error: erroUser } = await supabaseComoCaller.auth.getUser();
  if (erroUser || !userData?.user) {
    return respostaJson({ error: 'Sessão não autenticada.' }, 401, cors);
  }
  const callerUserId = userData.user.id;

  const { data: ehAdmin, error: erroIsAdmin } = await supabaseComoCaller.rpc('is_admin');
  if (erroIsAdmin) {
    console.error('[create-staff-user] falha ao chamar is_admin():', erroIsAdmin.message);
    return respostaJson({ error: 'Não foi possível validar permissões.' }, 500, cors);
  }
  if (!ehAdmin) {
    return respostaJson({ error: 'Apenas administradores podem criar usuários.' }, 403, cors);
  }

  // --------------------------------------------------------------------
  // 3. Client administrativo — só a partir daqui, só pro que é necessário
  // --------------------------------------------------------------------
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const emailTecnico = `${username}@${LARICA_AUTH_EMAIL_DOMAIN}`;

  const { data: novoUsuario, error: erroCreateUser } = await supabaseAdmin.auth.admin.createUser({
    email: emailTecnico,
    password,
    email_confirm: true,
    user_metadata: { username }, // só conveniência operacional — nunca fonte de autorização
  });

  if (erroCreateUser || !novoUsuario?.user) {
    if (ehConflitoDeEmailExistente(erroCreateUser)) {
      return respostaJson({ error: 'Nome de usuário já existe.' }, 409, cors);
    }
    console.error('[create-staff-user] falha ao criar Auth user:', erroCreateUser?.message);
    return respostaJson({ error: 'Não foi possível criar o usuário.' }, 500, cors);
  }

  const novoUserId = novoUsuario.user.id;

  // --------------------------------------------------------------------
  // 4. Profile + permissions — qualquer falha daqui em diante aciona rollback
  // --------------------------------------------------------------------
  const { error: erroProfile } = await supabaseAdmin.from('profiles').insert({
    id: novoUserId,
    username,
    full_name: fullName,
    role,
    active,
  });

  if (erroProfile) {
    const rollbackOk = await tentarRollback(supabaseAdmin, novoUserId);
    if (!rollbackOk) {
      console.error('[create-staff-user] rollback não confirmado após falha ao criar profile. userId:', novoUserId);
    }
    if (erroProfile.code === '23505') {
      return respostaJson({ error: 'Nome de usuário já existe.' }, 409, cors);
    }
    console.error('[create-staff-user] falha ao criar profile:', erroProfile.message, 'userId:', novoUserId);
    return respostaJson({ error: 'Não foi possível criar o usuário.' }, 500, cors);
  }

  if (role === 'employee' && permissions.length > 0) {
    const linhas = permissions.map((permission) => ({ user_id: novoUserId, permission, granted_by: callerUserId }));
    const { error: erroPermissions } = await supabaseAdmin.from('user_permissions').insert(linhas);

    if (erroPermissions) {
      const rollbackOk = await tentarRollback(supabaseAdmin, novoUserId);
      if (!rollbackOk) {
        console.error('[create-staff-user] rollback não confirmado após falha ao conceder permissões. userId:', novoUserId);
      }
      console.error('[create-staff-user] falha ao conceder permissões:', erroPermissions.message, 'userId:', novoUserId);
      return respostaJson({ error: 'Não foi possível criar o usuário.' }, 500, cors);
    }
  }
  // role === 'admin': nenhuma linha em user_permissions, de propósito — admin não depende delas.

  // --------------------------------------------------------------------
  // 5. Sucesso — nunca email técnico/senha/JWT/secret na resposta
  // --------------------------------------------------------------------
  return respostaJson({ success: true, user: { id: novoUserId, username, fullName, role, active } }, 201, cors);
});
