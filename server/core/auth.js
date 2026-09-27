'use strict';
/**
 * Autenticação do núcleo: login no Service Layer com o usuário B1 da pessoa
 * (ou no conjunto de usuários demo, no modo MOCK).
 */
const sl = require('./slClient');
const MOCK_USERS = require('./mockUsers');

const q = (s) => String(s || '').replace(/'/g, "''");

async function login(tenant, userName, password, mock) {
  if (mock) {
    const u = MOCK_USERS[String(userName).toLowerCase()];
    if (!u || password !== '1234') throw new sl.SLError(401, -304, 'Falha no login: usuário ou senha inválidos');
    return { ctx: { userCode: u.userCode }, user: { ...u } };
  }
  let cookie;
  try {
    ({ cookie } = await sl.login(tenant, userName, password));
  } catch (e) {
    throw friendlyLoginError(e, userName);
  }
  const r = await sl.request(tenant, cookie, 'GET',
    `/Users?$select=InternalKey,UserCode,UserName,eMail,Department,Superuser&$filter=UserCode eq '${encodeURIComponent(q(userName))}'`);
  const u = (r.value || [])[0];
  if (!u) throw new sl.SLError(403, 'USER', 'Usuário não encontrado no SAP B1');
  return {
    ctx: { cookie },
    user: {
      userCode: u.UserCode,
      userName: u.UserName,
      internalKey: u.InternalKey,
      email: u.eMail || '',
      department: u.Department ?? null,
      superuser: u.Superuser === 'tYES'
    }
  };
}

/** Traduz a recusa do Service Layer no login para algo que o usuário (ou o suporte) resolva sozinho. */
function friendlyLoginError(e, userName) {
  const raw = String(e.message || '');
  console.error(`[login] ${userName}: SL recusou (${e.code ?? e.status}) ${raw}`);
  if (e.status >= 500 && !/licen|password|senha|user|usu/i.test(raw)) return e; // SL fora do ar: mantém o erro técnico
  let msg;
  if (/licen/i.test(raw)) msg = 'Usuário sem licença no SAP B1. Atribua uma licença em Administração > Licença > Administração de licenças.';
  else if (/expir|change.*password|password.*change|alterar.*senha|trocar.*senha/i.test(raw)) msg = 'A senha precisa ser trocada no SAP B1. Entre uma vez no client do B1, troque a senha e tente de novo.';
  else if (/lock|bloque/i.test(raw)) msg = 'Usuário bloqueado no SAP B1.';
  else msg = 'Usuário ou senha inválidos.';
  return new sl.SLError(401, e.code, `${msg} (SAP: ${raw.slice(0, 160)})`);
}

async function logout(tenant, ctx, mock) {
  if (!mock) await sl.logout(tenant, ctx.cookie);
}

module.exports = { login, logout };
