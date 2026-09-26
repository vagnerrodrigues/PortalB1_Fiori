'use strict';
/** Log de auditoria do portal (JSON lines). O B1 já audita os documentos; aqui registramos o "quem/quando/de onde" do portal. */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '..', 'logs');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'audit.log');

function audit(req, action, details) {
  const s = req.session || {};
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tenant: s.tenantId,
    user: s.user && s.user.userCode,
    ip: req.ip,
    action,
    ...details
  });
  fs.appendFile(file, line + '\n', () => {});
}

module.exports = { audit };
