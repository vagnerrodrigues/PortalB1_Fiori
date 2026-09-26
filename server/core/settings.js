'use strict';
/**
 * Configurações do portal por empresa (tela Configurações). São dados do PORTAL, não do negócio:
 * nome do portal, URL pública e servidor de e-mail. Ficam em config/settings/<empresa>.json.
 * A senha do SMTP é gravada criptografada (AES-256-GCM) com a chave em config/secret.key
 * (gerada na primeira execução; ou variável PORTAL_SECRET) e nunca é devolvida para a tela.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const dir = () => process.env.SETTINGS_DIR || path.join(CONFIG_DIR, 'settings');

const DEFAULTS = {
  general: { productName: '', portalUrl: '' },
  email: {
    enabled: false, host: '', port: 587, security: 'starttls', // starttls | ssl | none
    user: '', passwordEnc: null, fromName: '', fromAddress: '', replyTo: '', rejectUnauthorized: true
  },
  notify: { approvalRequested: true, approved: true, rejected: true, generated: true, rfqAnswered: true }
};
const EVENTS = Object.keys(DEFAULTS.notify);

// ---------- chave e criptografia ----------
let keyCache = null;
function key() {
  if (keyCache) return keyCache;
  if (process.env.PORTAL_SECRET) {
    keyCache = crypto.createHash('sha256').update(process.env.PORTAL_SECRET).digest();
    return keyCache;
  }
  const file = path.join(CONFIG_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  keyCache = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  return keyCache;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------- leitura/gravação ----------
const fileFor = (tenantId) => path.join(dir(), `${String(tenantId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

function load(tenantId) {
  let saved = {};
  try {
    const f = fileFor(tenantId);
    if (fs.existsSync(f)) saved = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  } catch (e) { console.error(`[config] configurações de ${tenantId} ilegíveis: ${e.message}`); }
  return {
    general: { ...DEFAULTS.general, ...(saved.general || {}) },
    email: { ...DEFAULTS.email, ...(saved.email || {}) },
    notify: { ...DEFAULTS.notify, ...(saved.notify || {}) }
  };
}

/** Versão segura para a tela: sem a senha, só o indicador de que existe. */
function publicView(tenantId) {
  const s = load(tenantId);
  const { passwordEnc, ...email } = s.email;
  return { general: s.general, email: { ...email, hasPassword: !!passwordEnc }, notify: s.notify, events: EVENTS };
}

/** Senha em claro, só para o serviço de e-mail. */
function smtpPassword(tenantId) {
  try { return decrypt(load(tenantId).email.passwordEnc); } catch (_) { return ''; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input) {
  const e = [];
  const g = input.general || {};
  const m = input.email || {};
  if (g.productName !== undefined && String(g.productName).length > 40) e.push('Nome do portal: máximo 40 caracteres');
  if (g.portalUrl && !/^https?:\/\/[^\s]+$/i.test(g.portalUrl)) e.push('Endereço do portal deve começar com http:// ou https://');
  if (m.enabled) {
    if (!m.host) e.push('Informe o servidor SMTP');
    if (!(Number(m.port) > 0 && Number(m.port) < 65536)) e.push('Porta SMTP inválida');
    if (!['starttls', 'ssl', 'none'].includes(m.security)) e.push('Segurança SMTP inválida');
    if (!EMAIL_RE.test(m.fromAddress || '')) e.push('E-mail do remetente inválido');
  }
  if (m.replyTo && !EMAIL_RE.test(m.replyTo)) e.push('E-mail de resposta inválido');
  return e;
}

/** Grava. password: '' ou ausente = mantém a atual; clearPassword: true = remove. */
function save(tenantId, input) {
  const errors = validate(input || {});
  if (errors.length) { const err = new Error(errors.join('; ')); err.status = 400; throw err; }
  const cur = load(tenantId);
  const g = input.general || {};
  const m = input.email || {};
  const n = input.notify || {};
  const next = {
    general: {
      productName: String(g.productName ?? cur.general.productName).trim().slice(0, 40),
      portalUrl: String(g.portalUrl ?? cur.general.portalUrl).trim().replace(/\/+$/, '')
    },
    email: {
      enabled: !!(m.enabled ?? cur.email.enabled),
      host: String(m.host ?? cur.email.host).trim(),
      port: Number(m.port ?? cur.email.port),
      security: m.security || cur.email.security,
      user: String(m.user ?? cur.email.user).trim(),
      passwordEnc: m.clearPassword ? null : (m.password ? encrypt(m.password) : cur.email.passwordEnc),
      fromName: String(m.fromName ?? cur.email.fromName).trim().slice(0, 60),
      fromAddress: String(m.fromAddress ?? cur.email.fromAddress).trim(),
      replyTo: String(m.replyTo ?? cur.email.replyTo).trim(),
      rejectUnauthorized: m.rejectUnauthorized ?? cur.email.rejectUnauthorized
    },
    notify: Object.fromEntries(EVENTS.map((k) => [k, n[k] !== undefined ? !!n[k] : cur.notify[k]]))
  };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileFor(tenantId), JSON.stringify(next, null, 2), { mode: 0o600 });
  return publicView(tenantId);
}

module.exports = { load, publicView, save, smtpPassword, EVENTS };
