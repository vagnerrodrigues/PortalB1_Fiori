'use strict';
/**
 * Envio de e-mails do portal (SMTP configurado na tela Configurações).
 *  - Em modo demonstração (MOCK) os e-mails não saem: vão para logs/outbox/*.html (e ficam em memória p/ testes)
 *  - Envio de notificações é "fire and forget": falha de e-mail nunca derruba a operação no B1
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const settings = require('./settings');
const branding = require('./branding');

const OUTBOX = path.join(__dirname, '..', '..', 'logs', 'outbox');
const sent = []; // últimos e-mails (modo demonstração / testes)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** HTML simples e compatível com Outlook/Gmail, nas cores da marca. */
function render(tenant, { title, intro, rows = [], buttonText, buttonUrl, footer }) {
  const b = branding.forTenant(tenant);
  const c = b.colors;
  const rowsHtml = rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#556;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
    `<td style="padding:6px 0;color:#111;font-size:14px">${esc(v)}</td></tr>`).join('');
  const btn = buttonUrl
    ? `<p style="margin:24px 0 8px"><a href="${esc(buttonUrl)}" style="background:${c.primary};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${esc(buttonText || 'Abrir no portal')}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:${c.header};color:${c.headerText};padding:16px 24px;font-size:18px;font-weight:bold;border-bottom:4px solid ${c.accent}">${esc(b.productName)}</td></tr>
<tr><td style="padding:24px">
<h2 style="margin:0 0 12px;color:${c.header};font-size:20px">${esc(title)}</h2>
<p style="margin:0 0 16px;color:#333;font-size:14px;line-height:1.5">${esc(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0">${rowsHtml}</table>
${btn}
</td></tr>
<tr><td style="padding:14px 24px;background:#f7f8fb;color:#889;font-size:12px">${esc(footer || `Mensagem automática do ${b.productName}. Não responda este e-mail.`)}</td></tr>
</table></td></tr></table></body></html>`;
}

function transportFor(tenant) {
  const s = settings.load(tenant.id).email;
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port),
    secure: s.security === 'ssl',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: settings.smtpPassword(tenant.id) } : undefined,
    tls: { rejectUnauthorized: s.rejectUnauthorized !== false },
    connectionTimeout: 15000,
    greetingTimeout: 15000
  });
}

/**
 * Envia um e-mail. Retorna { ok, skipped?, error? }.
 * force=true ignora o "habilitado" (usado pelo e-mail de teste).
 */
async function send(tenant, { to, subject, html, text }, { mock = false, force = false } = {}) {
  const s = settings.load(tenant.id).email;
  const list = [].concat(to || []).filter(Boolean);
  if (!list.length) return { ok: false, skipped: 'sem destinatário' };
  if (!s.enabled && !force) return { ok: false, skipped: 'e-mail desabilitado' };

  const b = branding.forTenant(tenant);
  const from = { name: s.fromName || b.productName, address: s.fromAddress || 'portal@localhost' };
  const msg = { from, to: list, subject, html, text, replyTo: s.replyTo || undefined };

  if (mock || s.host === 'outbox') {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = path.join(OUTBOX, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}.html`);
    fs.writeFileSync(file, `<!-- Para: ${list.join(', ')} | Assunto: ${subject} -->\n${html}`);
    sent.push({ to: list, subject, file });
    if (sent.length > 50) sent.shift();
    return { ok: true, mock: true, file };
  }
  try {
    const info = await transportFor(tenant).sendMail(msg);
    return { ok: true, id: info.messageId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { send, render, sent };
