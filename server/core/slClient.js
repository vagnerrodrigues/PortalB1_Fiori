'use strict';
/**
 * Cliente mínimo do SAP Business One Service Layer (OData v4 - /b1s/v1).
 * - Usa https nativo para permitir certificados autoassinados (comum em ambientes B1 on-premise).
 * - Não guarda senha: guarda apenas os cookies de sessão (B1SESSION / ROUTEID).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

class SLError extends Error {
  constructor(status, code, message, raw) {
    super(message);
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

function parseSetCookies(headers) {
  const list = headers['set-cookie'] || [];
  return list
    .map((c) => c.split(';')[0])
    .filter((c) => /^(B1SESSION|ROUTEID)=/.test(c))
    .join('; ');
}

function rawRequest(tenant, method, path, { body, cookie, headers = {}, binary = false } = {}) {
  const base = tenant.serviceLayerUrl.replace(/\/$/, '');
  const url = new URL(base + path);
  const lib = url.protocol === 'http:' ? http : https;
  const isRaw = Buffer.isBuffer(body); // multipart (anexos): corpo já montado, Content-Type vem em headers
  const payload = body === undefined ? undefined : (isRaw ? body : JSON.stringify(body));

  const opts = {
    method,
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    rejectUnauthorized: tenant.rejectUnauthorized !== false,
    headers: {
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': isRaw ? payload.length : Buffer.byteLength(payload) } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    timeout: Number(process.env.SL_TIMEOUT_MS || 30000)
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary && res.statusCode < 400) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        const data = buf.toString('utf8');
        let json = null;
        if (data) {
          try { json = JSON.parse(data); } catch (_) { json = null; }
        }
        if (res.statusCode >= 400) {
          const err = json && json.error ? json.error : {};
          const msg = (err.message && (err.message.value || err.message)) || data || `HTTP ${res.statusCode}`;
          return reject(new SLError(res.statusCode, err.code, String(msg), json));
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('timeout', () => req.destroy(new SLError(504, 'TIMEOUT', 'Service Layer não respondeu a tempo')));
    req.on('error', (e) => reject(e instanceof SLError ? e : new SLError(502, 'NETWORK', `Falha de conexão com o Service Layer: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(tenant, userName, password) {
  const res = await rawRequest(tenant, 'POST', '/Login', {
    body: { CompanyDB: tenant.companyDB, UserName: userName, Password: password }
  });
  const cookie = parseSetCookies(res.headers);
  if (!cookie) throw new SLError(502, 'NO_SESSION', 'Service Layer não retornou cookie de sessão');
  return { cookie, timeoutMin: res.body && res.body.SessionTimeout };
}

async function logout(tenant, cookie) {
  try { await rawRequest(tenant, 'POST', '/Logout', { cookie }); } catch (_) { /* sessão já expirada */ }
}

/** Requisição autenticada. `cookie` vem da sessão do portal. */
async function request(tenant, cookie, method, path, body, headers) {
  const res = await rawRequest(tenant, method, path, { body, cookie, headers });
  return res.body;
}

/** Pagina automaticamente via odata.nextLink até `max` registros. */
async function getAll(tenant, cookie, path, max = 500) {
  let out = [];
  let next = path;
  while (next && out.length < max) {
    const body = await request(tenant, cookie, 'GET', next, undefined, { Prefer: 'odata.maxpagesize=100' });
    out = out.concat(body.value || []);
    const link = body['odata.nextLink'] || body['@odata.nextLink'];
    next = link ? '/' + link.replace(/^\/?(b1s\/v\d\/)?/, '') : null;
  }
  return out.slice(0, max);
}

/** Requisição com corpo/resposta binários (upload multipart e download de anexos). */
async function requestRaw(tenant, cookie, method, path, { body, contentType, binary } = {}) {
  const res = await rawRequest(tenant, method, path, {
    body, cookie, binary, headers: contentType ? { 'Content-Type': contentType } : {}
  });
  return res.body;
}

module.exports = { login, logout, request, requestRaw, getAll, SLError };
