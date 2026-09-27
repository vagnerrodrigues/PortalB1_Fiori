'use strict';
/**
 * Módulo "Assistente de IA": cada usuário conecta o seu assistente (Claude, Copilot, ChatGPT, Joule)
 * ao portal via MCP, com um token pessoal. O administrador liga/desliga em Configurações.
 * Rotas em /api/m/ia ; o servidor MCP fica em /mcp.
 */
const express = require('express');
const aiTokens = require('../../core/aiTokens');
const settings = require('../../core/settings');
const auth = require('../../core/auth');

function mcpUrl(req) {
  const base = settings.load(req.tenant.id).general.portalUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/mcp`;
}

module.exports = {
  id: 'ia',
  title: 'Inteligência artificial',
  description: 'Assistentes de IA conectados ao SAP',
  // Só aparece quando o administrador liga "Assistentes de IA" em Configurações
  enabledWhen: (tenant) => settings.load(tenant.id).general.aiEnabled,
  tiles: [
    { id: 'connect', title: 'Assistente de IA', subtitle: 'Conectar Claude, Copilot ou Joule', icon: 'sap-icon://ai', route: 'ia.connect' }
  ],

  createRouter({ mock, wrap, audit }) {
    const r = express.Router();

    r.get('/info', wrap(async (req, res) => {
      res.json({
        enabled: settings.load(req.tenant.id).general.aiEnabled,
        url: mcpUrl(req),
        superuser: !!req.session.user.superuser,
        tokens: aiTokens.listFor(req.tenant.id, req.session.user.userCode)
      });
    }));

    // Gera token: confirma a senha do B1 (é ela que o assistente usa para abrir a sessão do usuário)
    r.post('/tokens', wrap(async (req, res) => {
      if (!settings.load(req.tenant.id).general.aiEnabled) return res.status(403).json({ error: 'Assistentes de IA estão desligados nas Configurações do portal' });
      const { password, scope, days, label } = req.body || {};
      if (!password) return res.status(400).json({ error: 'Confirme sua senha do SAP B1' });
      if (aiTokens.listFor(req.tenant.id, req.session.user.userCode).length >= 5) return res.status(400).json({ error: 'Máximo de 5 tokens ativos. Revogue um antes de gerar outro.' });
      try {
        const { ctx } = await auth.login(req.tenant, req.session.user.userCode, String(password), mock);
        await auth.logout(req.tenant, ctx, mock);
      } catch (e) {
        return res.status(400).json({ error: 'Senha do SAP B1 incorreta' });
      }
      const out = aiTokens.create(req.tenant.id, req.session.user, String(password), { scope, days, label });
      audit(req, 'AI_TOKEN_CREATE', { id: out.info.id, scope: out.info.scope, expiresAt: out.info.expiresAt });
      res.status(201).json({ ...out, url: mcpUrl(req) });
    }));

    r.post('/tokens/:id/revoke', wrap(async (req, res) => {
      if (!/^[0-9a-f]{12}$/.test(req.params.id)) return res.status(400).json({ error: 'Parâmetro inválido' });
      if (!aiTokens.revoke(req.tenant.id, req.session.user.userCode, req.params.id)) return res.status(404).json({ error: 'Token não encontrado' });
      audit(req, 'AI_TOKEN_REVOKE', { id: req.params.id });
      res.json({ ok: true, tokens: aiTokens.listFor(req.tenant.id, req.session.user.userCode) });
    }));

    return r;
  }
};
