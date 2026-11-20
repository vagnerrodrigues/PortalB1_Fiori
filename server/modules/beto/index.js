'use strict';
/**
 * BETO — Blue Ocean Procurement Intelligence (etapas 1–2: fundação + espelho analítico).
 * Módulo do portal em /api/m/beto. Somente leitura no SAP: copia pedidos, fornecedores e itens para o espelho local.
 * O Beto RECOMENDA; uma pessoa DECIDE; as telas existentes do portal EXECUTAM pelos fluxos e alçadas do B1.
 * Arquitetura: BETO-ARCHITECTURE.md (documentos do projeto).
 */
const express = require('express');
const repoOf = require('./repo').forTenant;
const runner = require('./runner');
const scheduler = require('./scheduler');
const { rolesOf, canSee } = require('./roles');
const connection = require('./connection');

const STATUSES = ['PENDENTE', 'ACEITA', 'REJEITADA', 'ADIADA', 'RESOLVIDA', 'EXPIRADA'];
const DECISIONS = ['ACEITA', 'REJEITADA', 'ADIADA'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);

function publicSkill(s) {
  return {
    id: s.id, name: s.name, version: s.version, category: s.category, description: s.description,
    financialImpact: s.financialImpact, audience: s.audience, mockOnly: !!s.mockOnly,
    enabled: s.enabled, params: s.effectiveParams, updatedBy: s.config ? s.config.updatedBy : null, updatedAt: s.config ? s.config.updatedAt : null
  };
}

module.exports = {
  id: 'beto',
  title: 'Beto',
  description: 'Inteligência de suprimentos: achados e recomendações com decisão humana',
  // Opt-in: só aparece quando a empresa lista "beto" em tenants.json -> modules (sempre no modo demonstração)
  enabledWhen: (tenant) => tenant.serviceLayerUrl === 'mock://' || (Array.isArray(tenant.modules) && tenant.modules.includes('beto')),
  tiles: [
    { id: 'inbox', title: 'Beto', subtitle: 'Recomendações de suprimentos', icon: 'sap-icon://lightbulb', route: 'beto.inbox', counter: true }
  ],

  createRouter({ mock, wrap, audit, tenants = [] }) {
    const r = express.Router();
    // Agenda: só empresas com o módulo Beto habilitado
    scheduler.start({ tenants, mock, isEnabled: (t) => module.exports.enabledWhen(t) });

    const background = (tenant, opts) => {
      if (runner.isRunning(tenant.id)) { const e = new Error('Já existe uma execução do Beto em andamento para esta empresa'); e.status = 409; throw e; }
      runner.run(tenant, opts).catch((e) => console.error('[beto] execução falhou:', tenant.id, e.message));
    };
    const roles = (req) => rolesOf(req.tenant, req.session.user);
    const need = (role) => (req, res, next) => (roles(req)[role] ? next() : res.status(403).json({ error: role === 'admin' ? 'Função exclusiva de administradores do Beto' : 'Seu perfil não pode decidir recomendações do Beto' }));
    const actorOf = (req) => req.session.user.userCode;

    // Contador do tile e do menu: pendentes visíveis para o usuário
    r.get('/counters', wrap(async (req, res) => {
      const rl = roles(req);
      const repo = repoOf(req.tenant.id);
      repo.housekeeping();
      res.json({ inbox: repo.listRecommendations({ status: 'PENDENTE', limit: 500 }).filter((x) => canSee(rl, x.audience)).length });
    }));

    r.get('/me', (req, res) => res.json({ roles: roles(req) }));

    r.get('/health', wrap(async (req, res) => {
      const repo = repoOf(req.tenant.id);
      const last = repo.listRuns(1)[0] || null;
      res.json({
        stage: 2, mock,
        running: runner.isRunning(req.tenant.id),
        lastRun: last && { id: last.id, status: last.status, startedAt: last.startedAt, endedAt: last.endedAt, findings: last.findings, newRecs: last.newRecs },
        schedule: scheduler.scheduleOf(req.tenant.id),
        recommendations: repo.counts(),
        audit: repo.verifyAudit(),
        llm: { enabled: false, note: 'Camada de linguagem entra na etapa 4 (decisão D4)' },
        sap: { access: 'somente leitura', connection: connection.get(req.tenant.id), warehouse: repo.listSync() }
      });
    }));

    // ---------- recomendações ----------
    r.get('/recommendations', wrap(async (req, res) => {
      const status = req.query.status ? String(req.query.status) : undefined;
      if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Status inválido' });
      const repo = repoOf(req.tenant.id);
      repo.housekeeping();
      const rl = roles(req);
      const items = repo.listRecommendations({ status, skill: req.query.skill ? String(req.query.skill) : undefined, limit: req.query.limit })
        .filter((x) => canSee(rl, x.audience));
      res.json({ items, roles: rl });
    }));

    r.get('/recommendations/:id', wrap(async (req, res) => {
      if (!/^rec_[a-z0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Parâmetro inválido' });
      const rec = repoOf(req.tenant.id).getRecommendation(req.params.id);
      if (!rec || !canSee(roles(req), rec.audience)) return res.status(404).json({ error: 'Recomendação não encontrada' });
      res.json(rec);
    }));

    r.post('/recommendations/:id/decision', need('decider'), wrap(async (req, res) => {
      if (!/^rec_[a-z0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Parâmetro inválido' });
      const { decision, reason, snoozeUntil } = req.body || {};
      if (!DECISIONS.includes(decision)) return res.status(400).json({ error: 'Decisão inválida (ACEITA, REJEITADA ou ADIADA)' });
      const why = String(reason || '').trim().slice(0, 500);
      if (decision !== 'ACEITA' && why.length < 3) return res.status(400).json({ error: 'Informe o motivo para rejeitar ou adiar' });
      if (decision === 'ADIADA' && (!isDate(snoozeUntil) || snoozeUntil <= today())) return res.status(400).json({ error: 'Informe até quando adiar (data futura)' });
      const repo = repoOf(req.tenant.id);
      const cur = repo.getRecommendation(req.params.id, { evidenceLimit: 1 });
      if (!cur || !canSee(roles(req), cur.audience)) return res.status(404).json({ error: 'Recomendação não encontrada' });
      const out = repo.decide(req.params.id, actorOf(req), decision, why, decision === 'ADIADA' ? snoozeUntil : null);
      if (out.error === 409) return res.status(409).json({ error: `Recomendação já está ${out.status}` });
      audit(req, 'BETO_DECISION', { recommendation: req.params.id, decision });
      // O Beto não executa nada: devolve o atalho para a tela existente
      res.json({ status: out.status, action: decision === 'ACEITA' ? cur.action : null });
    }));

    // ---------- execuções ----------
    r.get('/runs', wrap(async (req, res) => res.json(repoOf(req.tenant.id).listRuns(Math.min(Number(req.query.limit) || 20, 100)))));

    r.post('/runs', need('admin'), wrap(async (req, res) => {
      const only = Array.isArray((req.body || {}).skills) ? req.body.skills.map(String).slice(0, 50) : null;
      audit(req, 'BETO_RUN', { only });
      // No SAP real a leitura pode levar minutos: roda em segundo plano e a tela acompanha pelo /health
      if (!mock) { background(req.tenant, { trigger: 'manual', actor: actorOf(req), only, mock }); return res.status(202).json({ status: 'EXECUTANDO' }); }
      const out = await runner.run(req.tenant, { trigger: 'manual', actor: actorOf(req), only, mock });
      res.status(201).json(out);
    }));

    // ---------- skills e configuração ----------
    r.get('/skills', wrap(async (req, res) => res.json(runner.skillsFor(req.tenant, mock).map(publicSkill))));

    r.put('/skills/:id', need('admin'), wrap(async (req, res) => {
      const s = runner.skillsFor(req.tenant, mock).find((x) => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'Skill não encontrada' });
      const { enabled, params } = req.body || {};
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Informe enabled (true/false)' });
      const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
      const unknown = Object.keys(p).filter((k) => !(k in s.params));
      if (unknown.length) return res.status(400).json({ error: `Parâmetro(s) desconhecido(s): ${unknown.join(', ')}` });
      if (JSON.stringify(p).length > 4000) return res.status(400).json({ error: 'Parâmetros grandes demais' });
      repoOf(req.tenant.id).setSkillConfig(s.id, { enabled, params: p }, actorOf(req));
      audit(req, 'BETO_SKILL_CONFIG', { skill: s.id, enabled });
      res.json(publicSkill(runner.skillsFor(req.tenant, mock).find((x) => x.id === s.id)));
    }));

    r.put('/schedule', need('admin'), wrap(async (req, res) => {
      const { enabled, time } = req.body || {};
      if (typeof enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ''))) return res.status(400).json({ error: 'Informe enabled e time (HH:MM)' });
      repoOf(req.tenant.id).setConfig('schedule', { enabled, time }, actorOf(req));
      audit(req, 'BETO_SCHEDULE', { enabled, time });
      res.json(scheduler.scheduleOf(req.tenant.id));
    }));

    // ---------- conexão com o SAP (leitura) e espelho analítico ----------
    r.get('/connection', need('admin'), (req, res) => res.json(connection.get(req.tenant.id)));

    r.put('/connection', need('admin'), wrap(async (req, res) => {
      const { userName, password } = req.body || {};
      if (!String(userName || '').trim() || !password) return res.status(400).json({ error: 'Informe usuário e senha do SAP B1' });
      if (String(userName).length > 50 || String(password).length > 200) return res.status(400).json({ error: 'Usuário ou senha longos demais' });
      const test = await connection.test(req.tenant, { mock, userName: String(userName).trim(), password: String(password) });
      if (!test.ok && /Login|inválid/i.test(String(test.error))) return res.status(400).json({ error: test.error, test });
      connection.save(req.tenant.id, { userName, password }, actorOf(req));
      connection.setLastTest(req.tenant.id, test);
      audit(req, 'BETO_CONNECTION', { userName: String(userName).trim(), ok: test.ok });
      res.json({ ...connection.get(req.tenant.id), test });
    }));

    r.post('/connection/test', need('admin'), wrap(async (req, res) => {
      const test = await connection.test(req.tenant, { mock });
      connection.setLastTest(req.tenant.id, test);
      res.json(test);
    }));

    r.get('/warehouse', wrap(async (req, res) => res.json({ entities: repoOf(req.tenant.id).listSync() })));

    r.post('/sync', need('admin'), wrap(async (req, res) => {
      audit(req, 'BETO_SYNC', {});
      if (!mock) { background(req.tenant, { trigger: 'sincronizacao', actor: actorOf(req), mock, syncOnly: true }); return res.status(202).json({ status: 'EXECUTANDO' }); }
      const out = await runner.run(req.tenant, { trigger: 'sincronizacao', actor: actorOf(req), mock, syncOnly: true });
      res.status(201).json({ ...out, entities: repoOf(req.tenant.id).listSync() });
    }));

    r.get('/audit', need('admin'), wrap(async (req, res) => {
      const repo = repoOf(req.tenant.id);
      res.json({ integrity: repo.verifyAudit(), events: repo.listAudit({ limit: Math.min(Number(req.query.limit) || 100, 1000) }) });
    }));

    return r;
  }
};
