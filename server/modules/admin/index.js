'use strict';
/**
 * Módulo Configurações (administração do portal por empresa). Acesso: superusuário do B1
 * ou usuários listados em tenants.json -> moduleAccess.admin.users.
 */
const express = require('express');
const settings = require('../../core/settings');
const mailer = require('../../core/mailer');
const branding = require('../../core/branding');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = {
  id: 'admin',
  title: 'Administração',
  description: 'Configurações do portal',
  adminOnly: true,
  tiles: [
    { id: 'settings', title: 'Configurações do portal', subtitle: 'Nome, e-mail e notificações', icon: 'sap-icon://action-settings', route: 'admin.settings' }
  ],

  createRouter({ mock, wrap, audit }) {
    const r = express.Router();

    r.get('/settings', (req, res) => {
      res.json({ ...settings.publicView(req.tenant.id), defaultProductName: branding.loadGlobal().productName });
    });

    r.put('/settings', wrap(async (req, res) => {
      const out = settings.save(req.tenant.id, req.body || {});
      audit(req, 'SETTINGS_SAVE', { email: out.email.enabled, host: out.email.host, productName: out.general.productName });
      res.json({ ...out, branding: branding.forTenant(req.tenant), defaultProductName: branding.loadGlobal().productName });
    }));

    // E-mail de teste com a configuração GRAVADA (salve antes de testar)
    r.post('/settings/test-email', wrap(async (req, res) => {
      const to = String((req.body && req.body.to) || req.session.user.email || '').trim();
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Informe um e-mail de destino válido' });
      const s = settings.load(req.tenant.id).email;
      if (!s.host) return res.status(400).json({ error: 'Configure e salve o servidor SMTP antes de testar' });
      const b = branding.forTenant(req.tenant);
      const out = await mailer.send(req.tenant, {
        to,
        subject: `Teste de e-mail — ${b.productName}`,
        html: mailer.render(req.tenant, {
          title: 'E-mail configurado com sucesso',
          intro: `Este é um teste enviado por ${req.session.user.userName}. Se chegou, as notificações do portal vão funcionar.`,
          rows: [['Servidor', `${s.host}:${s.port} (${s.security})`], ['Remetente', s.fromAddress]]
        })
      }, { mock, force: true });
      audit(req, 'SETTINGS_TEST_EMAIL', { to, ok: out.ok, error: out.error });
      if (!out.ok) return res.status(502).json({ error: `Falha no envio: ${out.error || out.skipped}` });
      res.json({ ok: true, to, mock: !!out.mock });
    }));

    return r;
  }
};
