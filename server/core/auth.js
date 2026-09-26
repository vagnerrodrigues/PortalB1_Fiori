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
  const { cookie } = await sl.login(tenant, userName, password);
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

async function logout(tenant, ctx, mock) {
  if (!mock) await sl.logout(tenant, ctx.cookie);
}

module.exports = { login, logout };
