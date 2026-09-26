'use strict';
/**
 * Sessões do portal em memória (Fase 1). Para produção com mais de uma instância,
 * trocar por Redis mantendo a mesma interface.
 */
const crypto = require('crypto');

const IDLE_MS = Number(process.env.SESSION_IDLE_MIN || 25) * 60 * 1000; // < timeout padrão do SL (30 min)
const COOKIE = 'pcb1_sid';
const store = new Map();

function create(data) {
  const sid = crypto.randomBytes(32).toString('hex');
  store.set(sid, { ...data, lastSeen: Date.now() });
  return sid;
}

function get(sid) {
  const s = sid && store.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > IDLE_MS) { store.delete(sid); return null; }
  s.lastSeen = Date.now();
  return s;
}

const destroy = (sid) => store.delete(sid);

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}

function cookieHeader(sid, clear) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return clear
    ? `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
    : `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict${secure}`;
}

// limpeza periódica
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.lastSeen > IDLE_MS) store.delete(k);
}, 60 * 1000).unref();

module.exports = { create, get, destroy, readCookie, cookieHeader };
