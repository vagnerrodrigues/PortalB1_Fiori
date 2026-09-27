'use strict';
/**
 * Tokens pessoais para assistentes de IA (MCP): cada usuário gera o seu na tela "Assistente de IA".
 *
 * Por que guardamos a senha do B1 (criptografada): o assistente age COM O USUÁRIO DO B1 da pessoa,
 * para valer as mesmas permissões e alçadas (ex.: só o próprio aprovador consegue aprovar no SL).
 * A senha fica cifrada (AES-256-GCM, chave config/secret.key), só é usada para abrir a sessão no
 * Service Layer e some quando o token é revogado. Token em si: só o hash é gravado.
 *
 * Formato do token: pb1_<empresa em hex>_<id>_<segredo>
 */
const crypto = require('crypto');
const store = require('./store');
const settings = require('./settings');

const COLL = 'ai-tokens';
const hex = (s) => Buffer.from(String(s)).toString('hex');
const unhex = (s) => Buffer.from(String(s), 'hex').toString('utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function create(tenantId, user, password, { scope = 'read', days = 90, label = '' } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  const token = `pb1_${hex(tenantId)}_${id}_${secret}`;
  const now = Date.now();
  const rec = {
    id, userCode: user.userCode, userName: user.userName, scope: scope === 'write' ? 'write' : 'read',
    label: String(label || '').slice(0, 40), createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(Math.max(Number(days) || 90, 1), 365) * 864e5).toISOString(),
    lastUsedAt: null, uses: 0, revoked: false,
    tokenHash: sha(secret), passwordEnc: settings.encrypt(password)
  };
  store.put(COLL, tenantId, id, rec);
  return { token, info: publicInfo(rec) };
}

const publicInfo = ({ tokenHash, passwordEnc, ...r }) => ({ ...r, expired: Date.parse(r.expiresAt) < Date.now() });

function listFor(tenantId, userCode) {
  return store.list(COLL, tenantId).filter((r) => r.userCode === userCode && !r.revoked)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicInfo);
}

function revoke(tenantId, userCode, id) {
  const r = store.get(COLL, tenantId, id);
  if (!r || r.userCode !== userCode) return false;
  r.revoked = true;
  r.passwordEnc = null; // a senha some junto
  store.put(COLL, tenantId, id, r);
  return true;
}

/** Valida o token. Retorna { tenantId, rec, password } ou null. */
function verify(token) {
  const m = /^pb1_([0-9a-f]+)_([0-9a-f]{12})_([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  if (!m) return null;
  let tenantId;
  try { tenantId = unhex(m[1]); } catch (_) { return null; }
  const rec = store.get(COLL, tenantId, m[2]);
  if (!rec || rec.revoked || Date.parse(rec.expiresAt) < Date.now()) return null;
  const a = Buffer.from(rec.tokenHash, 'hex');
  const b = Buffer.from(sha(m[3]), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { tenantId, rec, password: () => settings.decrypt(rec.passwordEnc) };
}

/** Marca uso (no máximo 1 gravação por minuto por token). */
function touch(tenantId, rec) {
  if (rec.lastUsedAt && Date.now() - Date.parse(rec.lastUsedAt) < 60000) return;
  rec.lastUsedAt = new Date().toISOString();
  rec.uses = (rec.uses || 0) + 1;
  store.put(COLL, tenantId, rec.id, rec);
}

module.exports = { create, listFor, revoke, verify, touch };
