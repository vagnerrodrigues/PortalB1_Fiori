'use strict';
/**
 * Runner do Beto: executa as skills habilitadas da empresa, deduplica achados e gera recomendações.
 * Etapa 1: sem LLM (textos determinísticos de cada skill) e sem acesso ao SAP.
 * Uma execução por empresa por vez; cada skill com tempo máximo.
 */
const repoOf = require('./repo').forTenant;
const skills = require('./skills');

const SKILL_TIMEOUT_MS = Number(process.env.BETO_SKILL_TIMEOUT_MS || 120000);
const REC_TTL_DAYS = Number(process.env.BETO_REC_TTL_DAYS || 14);
const running = new Set();

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: tempo esgotado (${ms} ms)`)), ms).unref())]);

/** Skills com a configuração efetiva da empresa (padrão do manifest + ajuste gravado). */
function skillsFor(tenant, mock) {
  const repo = repoOf(tenant.id);
  return skills.available(mock).map((s) => {
    const cfg = repo.skillConfig(s.id);
    return { ...s, enabled: cfg ? cfg.enabled : !!s.defaultEnabled, effectiveParams: { ...s.params, ...((cfg && cfg.params) || {}) }, config: cfg };
  });
}

async function run(tenant, { trigger = 'manual', actor = null, only = null, mock = false } = {}) {
  if (running.has(tenant.id)) { const e = new Error('Já existe uma execução do Beto em andamento para esta empresa'); e.status = 409; throw e; }
  running.add(tenant.id);
  const repo = repoOf(tenant.id);
  const runId = repo.startRun(trigger, actor);
  let findings = 0;
  let newRecs = 0;
  const errors = [];
  try {
    repo.housekeeping();
    const list = skillsFor(tenant, mock).filter((s) => s.enabled && (!only || only.includes(s.id)));
    for (const skill of list) {
      const started = Date.now();
      try {
        const out = await withTimeout(Promise.resolve(skill.detect({ tenant, params: skill.effectiveParams, today: new Date() })), SKILL_TIMEOUT_MS, skill.id);
        const seen = new Set();
        repo.tx(() => {
          for (const f of out || []) {
            if (!f || !f.naturalKey || !f.severity) throw new Error(`${skill.id}: achado sem naturalKey/severity`);
            seen.add(f.naturalKey);
            findings++;
            const cur = repo.openFinding(skill.id, f.naturalKey);
            if (cur) { repo.touchFinding(cur.id, runId, f); continue; }
            const fid = repo.insertFinding(runId, skill, f);
            const d = skill.describe(f);
            repo.insertRecommendation(fid, skill, {
              title: d.title, explanation: d.explanation, action: d.action, impactBRL: f.impactBRL,
              severity: f.severity, audience: skill.audience,
              expiresAt: new Date(Date.now() + REC_TTL_DAYS * 864e5).toISOString()
            });
            newRecs++;
          }
          // Achados abertos que sumiram dos dados: resolvidos (e recomendações pendentes encerradas)
          if (!only || only.includes(skill.id)) repo.openFindingsOf(skill.id).filter((f) => !seen.has(f.natural_key)).forEach((f) => repo.resolveFinding(f.id));
        });
        repo.addStep(runId, skill.id, { rows: (out || []).length, ms: Date.now() - started });
      } catch (e) {
        errors.push(`${skill.id}: ${e.message}`);
        repo.addStep(runId, skill.id, { ms: Date.now() - started, status: 'ERRO', error: e.message });
        console.error('[beto] skill falhou:', skill.id, e.message);
      }
    }
    const status = errors.length ? 'CONCLUIDO_COM_ERROS' : 'CONCLUIDO';
    repo.endRun(runId, { status, findings, newRecs, error: errors.join('; ') || null });
    return { id: runId, status, findings, newRecs, errors };
  } catch (e) {
    repo.endRun(runId, { status: 'FALHOU', findings, newRecs, error: e.message });
    throw e;
  } finally {
    running.delete(tenant.id);
  }
}

const isRunning = (tenantId) => running.has(tenantId);

module.exports = { run, skillsFor, isRunning };
