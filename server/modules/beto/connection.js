'use strict';
/**
 * BETO — conexão com o SAP B1 para leitura (decisão D2: usuário "manager", definido pelo administrador do Beto).
 * A senha fica cifrada (AES-256-GCM, mesma chave do portal) no repositório da empresa e nunca volta para a tela.
 * Só abre/fecha sessão e testa leitura (GET e SQLQueries). Nenhuma gravação de documento ou cadastro.
 */
const sl = require('../../core/slClient');
const sqlQuery = require('../../core/sqlQuery');
const settings = require('../../core/settings');
const repoOf = require('./repo').forTenant;
const MOCK_USERS = require('../../core/mockUsers');

const KEY = 'connection';

function get(tenantId) {
  const c = repoOf(tenantId).getConfig(KEY, null);
  return c ? { userName: c.userName, configured: !!c.passwordEnc, updatedBy: c.updatedBy, updatedAt: c.updatedAt, lastTest: c.lastTest || null } : { configured: false };
}

function save(tenantId, { userName, password }, actor) {
  const repo = repoOf(tenantId);
  const cur = repo.getConfig(KEY, null) || {};
  repo.setConfig(KEY, {
    ...cur, userName: String(userName).trim(), passwordEnc: settings.encrypt(String(password)),
    updatedBy: actor, updatedAt: new Date().toISOString(), lastTest: null
  }, actor, { userName: String(userName).trim(), password: '***' }); // auditoria nunca recebe a senha
  return get(tenantId);
}

function setLastTest(tenantId, result) {
  const repo = repoOf(tenantId);
  const cur = repo.getConfig(KEY, null);
  if (!cur) return;
  repo.db.prepare('UPDATE config SET value = ? WHERE tenant_id = ? AND key = ?').run(JSON.stringify({ ...cur, lastTest: result }), tenantId, KEY);
}

/** Conector usado pelo warehouse: abre e fecha a sessão de leitura. */
function connector(mock) {
  return {
    async open(tenant) {
      if (mock) return { mock: true };
      const c = repoOf(tenant.id).getConfig(KEY, null);
      if (!c || !c.passwordEnc) { const e = new Error('Conexão do Beto com o SAP não configurada (Beto > Conexão)'); e.status = 412; throw e; }
      try {
        const { cookie } = await sl.login(tenant, c.userName, settings.decrypt(c.passwordEnc));
        return { cookie };
      } catch (e) {
        const err = new Error(`Login do Beto no SAP recusado (${c.userName}): ${String(e.message).slice(0, 160)}`);
        err.status = 401;
        throw err;
      }
    },
    async close(tenant, ctx) { if (!mock && ctx && ctx.cookie) await sl.logout(tenant, ctx.cookie); }
  };
}

/** Testa login e o acesso de leitura a cada tabela (SQL liberado? senão OData). */
async function test(tenant, { mock, userName, password } = {}) {
  if (mock) {
    const ok = !userName || (MOCK_USERS[String(userName).toLowerCase()] && password === '1234');
    return { ok: !!ok, at: new Date().toISOString(), user: userName || '(demonstração)', tables: [
      { entity: 'po', tables: 'OPOR/POR1', sql: true, odata: true }, { entity: 'vendor', tables: 'OCRD', sql: true, odata: true }, { entity: 'item', tables: 'OITM', sql: true, odata: true }
    ], error: ok ? null : 'Usuário ou senha inválidos (demonstração: senha 1234)' };
  }
  const c = repoOf(tenant.id).getConfig(KEY, null) || {};
  const user = userName || c.userName;
  const pass = password || (c.passwordEnc ? settings.decrypt(c.passwordEnc) : '');
  if (!user || !pass) return { ok: false, at: new Date().toISOString(), error: 'Informe usuário e senha' };
  let cookie;
  try {
    ({ cookie } = await sl.login(tenant, user, pass));
  } catch (e) {
    return { ok: false, at: new Date().toISOString(), user, error: `Login recusado: ${String(e.message).slice(0, 200)}` };
  }
  const ctx = { cookie };
  const probes = [
    { entity: 'po', tables: 'OPOR/POR1', sql: { code: 'PB_BETO_T_PO', name: 'Beto - teste OPOR/POR1', sql: 'SELECT T0."DocEntry" FROM "OPOR" T0 INNER JOIN "POR1" T1 ON T0."DocEntry" = T1."DocEntry" WHERE T0."DocEntry" = 0' }, odata: '/PurchaseOrders?$select=DocEntry&$top=1' },
    { entity: 'vendor', tables: 'OCRD', sql: { code: 'PB_BETO_T_VEN', name: 'Beto - teste OCRD', sql: 'SELECT T0."CardCode" FROM "OCRD" T0 WHERE T0."CardCode" = \'\'' }, odata: '/BusinessPartners?$select=CardCode&$top=1' },
    { entity: 'item', tables: 'OITM', sql: { code: 'PB_BETO_T_ITM', name: 'Beto - teste OITM', sql: 'SELECT T0."ItemCode" FROM "OITM" T0 WHERE T0."ItemCode" = \'\'' }, odata: '/Items?$select=ItemCode&$top=1' }
  ];
  const tables = [];
  try {
    for (const p of probes) {
      const r = { entity: p.entity, tables: p.tables, sql: false, odata: false };
      try { await sqlQuery.run(tenant, ctx, p.sql, {}, 1); r.sql = true; } catch (e) { r.sqlError = String(e.message).slice(0, 160); }
      try { await sl.request(tenant, cookie, 'GET', p.odata); r.odata = true; } catch (e) { r.odataError = String(e.message).slice(0, 160); }
      tables.push(r);
    }
  } finally {
    await sl.logout(tenant, cookie);
  }
  return { ok: tables.every((t) => t.sql || t.odata), at: new Date().toISOString(), user, tables };
}

module.exports = { get, save, test, setLastTest, connector };
