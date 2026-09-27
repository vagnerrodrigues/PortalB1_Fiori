'use strict';
/**
 * Consultas SQL via objeto nativo SQLQueries do Service Layer (somente SELECT).
 * O portal registra cada consulta no B1 com prefixo "PB_" na primeira execução e depois
 * só chama /List. Parâmetros no SQL: :nomeParametro
 *
 * SQL portável HANA/SQL Server: usar identificadores entre aspas duplas ("OINV", T0."DocNum").
 */
const sl = require('./slClient');

const ensured = new Map(); // tenantId:code -> hash do SQL já conferido
const pending = new Map(); // tenantId:code -> Promise (evita registrar a mesma consulta 2x em paralelo)

const hash = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * Garante a consulta registrada no B1 com o texto atual. Custo: 1 GET leve por consulta por reinício do serviço.
 * Só grava (POST/PATCH) quando a consulta não existe ou o texto mudou numa nova versão do portal.
 * Obs.: o Service Layer atende as chamadas de uma mesma sessão em fila, então cada chamada evitada conta.
 */
async function ensure(tenant, ctx, code, name, sqlText) {
  const key = `${tenant.id}:${code}`;
  const h = hash(sqlText);
  if (ensured.get(key) === h) return;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    let current = null;
    try {
      current = await sl.request(tenant, ctx.cookie, 'GET', `/SQLQueries('${code}')?$select=SqlCode,SqlText`);
    } catch (e) {
      if (e.status === 401) throw e;
      current = null; // não existe
    }
    if (!current) {
      await sl.request(tenant, ctx.cookie, 'POST', '/SQLQueries', { SqlCode: code, SqlName: name.slice(0, 100), SqlText: sqlText });
    } else if (String(current.SqlText || '').trim() !== sqlText.trim()) {
      await sl.request(tenant, ctx.cookie, 'PATCH', `/SQLQueries('${code}')`, { SqlName: name.slice(0, 100), SqlText: sqlText });
    }
    ensured.set(key, h);
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
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
  const page = Math.min(Math.max(max, 1), 500);
  let rows = [];
  let res = await sl.request(tenant, ctx.cookie, 'POST', `/SQLQueries('${code}')/List`, body, { Prefer: `odata.maxpagesize=${page}` });
  rows = rows.concat(res.value || []);
  let next = res['odata.nextLink'] || res['@odata.nextLink'];
  while (next && rows.length < max) {
    const path = '/' + next.replace(/^\/?(b1s\/v\d\/)?/, '');
    res = await sl.request(tenant, ctx.cookie, 'POST', path, body, { Prefer: `odata.maxpagesize=${page}` });
    rows = rows.concat(res.value || []);
    next = res['odata.nextLink'] || res['@odata.nextLink'];
  }
  return { rows: rows.slice(0, max), truncated: rows.length > max || !!next };
}

module.exports = { run, paramList };
