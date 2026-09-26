'use strict';
/**
 * Consultas SQL via objeto nativo SQLQueries do Service Layer (somente SELECT).
 * O portal registra cada consulta no B1 com prefixo "PB_" na primeira execução e depois
 * só chama /List. Parâmetros no SQL: :nomeParametro
 *
 * SQL portável HANA/SQL Server: usar identificadores entre aspas duplas ("OINV", T0."DocNum").
 */
const sl = require('./slClient');

const ensured = new Map(); // tenantId:code -> hash do SQL já registrado

const hash = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);

async function ensure(tenant, ctx, code, name, sqlText) {
  const key = `${tenant.id}:${code}`;
  const h = hash(sqlText);
  if (ensured.get(key) === h) return;
  try {
    await sl.request(tenant, ctx.cookie, 'POST', '/SQLQueries', { SqlCode: code, SqlName: name.slice(0, 100), SqlText: sqlText });
  } catch (e) {
    if (e.status !== 400 && e.status !== 409) throw e;
    // já existe: atualiza o texto para refletir a versão do portal
    await sl.request(tenant, ctx.cookie, 'PATCH', `/SQLQueries('${code}')`, { SqlName: name.slice(0, 100), SqlText: sqlText });
  }
  ensured.set(key, h);
}

function paramList(params) {
  return Object.entries(params || {})
    .map(([k, v]) => {
      if (typeof v === 'number') return `${k}=${v}`;
      return `${k}='${String(v ?? '').replace(/'/g, "''")}'`;
    })
    .join('&');
}

/** Executa e pagina até `max` linhas. */
async function run(tenant, ctx, { code, name, sql }, params, max = 5000) {
  await ensure(tenant, ctx, code, name, sql);
  const body = Object.keys(params || {}).length ? { ParamList: paramList(params) } : undefined;
  let rows = [];
  let res = await sl.request(tenant, ctx.cookie, 'POST', `/SQLQueries('${code}')/List`, body, { Prefer: 'odata.maxpagesize=500' });
  rows = rows.concat(res.value || []);
  let next = res['odata.nextLink'] || res['@odata.nextLink'];
  while (next && rows.length < max) {
    const path = '/' + next.replace(/^\/?(b1s\/v\d\/)?/, '');
    res = await sl.request(tenant, ctx.cookie, 'POST', path, body, { Prefer: 'odata.maxpagesize=500' });
    rows = rows.concat(res.value || []);
    next = res['odata.nextLink'] || res['@odata.nextLink'];
  }
  return { rows: rows.slice(0, max), truncated: rows.length > max || !!next };
}

module.exports = { run, paramList };
