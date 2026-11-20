'use strict';
/**
 * BETO — repositório local por empresa (SQLite nativo do Node, arquivo data/beto/<empresa>.db).
 * Guarda só o que é do Beto: execuções, achados, evidências, recomendações, decisões, configuração
 * e a trilha de auditoria encadeada por hash. Documentos de negócio continuam no SAP B1.
 *
 * Isolamento multiempresa: um arquivo por empresa E tenant_id em todas as tabelas/consultas.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// node:sqlite ainda emite ExperimentalWarning no Node 22: silencia só esse aviso
function loadSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    if (String(w && w.message || w).includes('SQLite')) return;
    return orig.call(process, w, ...rest);
  };
  try { return require('node:sqlite'); } finally { process.emitWarning = orig; }
}
const { DatabaseSync } = loadSqlite();

const root = () => path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data'), 'beto');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const j = (v) => (v === undefined ? null : JSON.stringify(v));
const pj = (s) => { try { return s == null ? null : JSON.parse(s); } catch (_) { return null; } };

const MIGRATIONS = [
  // v1 — fundação (etapa 1)
  `CREATE TABLE run (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, trig TEXT NOT NULL, actor TEXT, status TEXT NOT NULL,
     started_at TEXT NOT NULL, ended_at TEXT, findings INTEGER DEFAULT 0, new_recs INTEGER DEFAULT 0, error TEXT);
   CREATE TABLE run_step (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES run(id), step TEXT NOT NULL,
     rows INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, status TEXT NOT NULL, error TEXT);
   CREATE TABLE skill_config (
     tenant_id TEXT NOT NULL, skill_id TEXT NOT NULL, enabled INTEGER NOT NULL, params TEXT,
     updated_by TEXT, updated_at TEXT, PRIMARY KEY (tenant_id, skill_id));
   CREATE TABLE finding (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_version TEXT,
     natural_key TEXT NOT NULL, severity TEXT NOT NULL, metric_value REAL, threshold REAL, impact_brl REAL,
     data TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, state TEXT NOT NULL);
   CREATE UNIQUE INDEX finding_key ON finding(tenant_id, skill_id, natural_key) WHERE state = 'ABERTO';
   CREATE TABLE evidence (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, finding_id TEXT NOT NULL REFERENCES finding(id), kind TEXT,
     doc_entry INTEGER, doc_num INTEGER, line_num INTEGER, card_code TEXT, item_code TEXT, snapshot TEXT);
   CREATE INDEX evidence_finding ON evidence(finding_id);
   CREATE TABLE recommendation (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, finding_id TEXT NOT NULL REFERENCES finding(id), skill_id TEXT NOT NULL,
     title TEXT NOT NULL, explanation TEXT, action TEXT, impact_brl REAL, severity TEXT NOT NULL, financial INTEGER NOT NULL,
     audience TEXT NOT NULL, status TEXT NOT NULL, snooze_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     expires_at TEXT, replaces TEXT);
   CREATE INDEX rec_status ON recommendation(tenant_id, status);
   CREATE TABLE decision (
     id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recommendation_id TEXT NOT NULL REFERENCES recommendation(id),
     user_code TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, snooze_until TEXT, decided_at TEXT NOT NULL);
   CREATE TABLE config (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (tenant_id, key));
   CREATE TABLE audit_event (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
     ref_type TEXT, ref_id TEXT, payload TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'auditoria é somente inserção'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'auditoria é somente inserção'); END;`
];

const GENESIS = '0'.repeat(64);
const open = new Map();

class Repo {
  constructor(tenantId, file) {
    this.tenantId = tenantId;
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => { this.db.exec(MIGRATIONS[i]); this.db.exec(`PRAGMA user_version = ${i + 1}`); });
    }
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- auditoria encadeada ----------
  audit(actor, action, refType, refId, payload) {
    const last = this.db.prepare('SELECT hash FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1').get(this.tenantId);
    const prev = last ? last.hash : GENESIS;
    const ev = { tenant_id: this.tenantId, at: now(), actor: actor || 'beto', action, ref_type: refType || null, ref_id: refId || null, payload: j(payload) };
    const hash = sha(prev + JSON.stringify(ev));
    this.db.prepare('INSERT INTO audit_event (tenant_id, at, actor, action, ref_type, ref_id, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(ev.tenant_id, ev.at, ev.actor, ev.action, ev.ref_type, ev.ref_id, ev.payload, prev, hash);
    return hash;
  }

  /** Recalcula a cadeia inteira. Retorna { ok, events, brokenAt }. */
  verifyAudit() {
    const rows = this.db.prepare('SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq').all(this.tenantId);
    let prev = GENESIS;
    for (const r of rows) {
      const ev = { tenant_id: r.tenant_id, at: r.at, actor: r.actor, action: r.action, ref_type: r.ref_type, ref_id: r.ref_id, payload: r.payload };
      if (r.prev_hash !== prev || sha(prev + JSON.stringify(ev)) !== r.hash) return { ok: false, events: rows.length, brokenAt: r.seq };
      prev = r.hash;
    }
    return { ok: true, events: rows.length, brokenAt: null };
  }

  listAudit({ refId, limit = 100 } = {}) {
    const rows = refId
      ? this.db.prepare('SELECT * FROM audit_event WHERE tenant_id = ? AND ref_id = ? ORDER BY seq DESC LIMIT ?').all(this.tenantId, refId, limit)
      : this.db.prepare('SELECT * FROM audit_event WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?').all(this.tenantId, limit);
    return rows.map((r) => ({ seq: r.seq, at: r.at, actor: r.actor, action: r.action, refType: r.ref_type, refId: r.ref_id, payload: pj(r.payload) }));
  }

  // ---------- configuração ----------
  getConfig(key, dflt) {
    const r = this.db.prepare('SELECT value FROM config WHERE tenant_id = ? AND key = ?').get(this.tenantId, key);
    return r ? pj(r.value) : dflt;
  }

  setConfig(key, value, actor) {
    this.db.prepare('INSERT INTO config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value')
      .run(this.tenantId, key, j(value));
    this.audit(actor, 'CONFIG_SET', 'config', key, value);
  }

  skillConfig(skillId) {
    const r = this.db.prepare('SELECT * FROM skill_config WHERE tenant_id = ? AND skill_id = ?').get(this.tenantId, skillId);
    return r ? { enabled: !!r.enabled, params: pj(r.params) || {}, updatedBy: r.updated_by, updatedAt: r.updated_at } : null;
  }

  setSkillConfig(skillId, { enabled, params }, actor) {
    this.db.prepare(`INSERT INTO skill_config (tenant_id, skill_id, enabled, params, updated_by, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(tenant_id, skill_id) DO UPDATE SET enabled = excluded.enabled, params = excluded.params, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(this.tenantId, skillId, enabled ? 1 : 0, j(params || {}), actor, now());
    this.audit(actor, 'SKILL_CONFIG', 'skill', skillId, { enabled: !!enabled, params: params || {} });
  }

  // ---------- execuções ----------
  startRun(trig, actor) {
    const id = newId('run');
    this.db.prepare('INSERT INTO run (id, tenant_id, trig, actor, status, started_at) VALUES (?,?,?,?,?,?)').run(id, this.tenantId, trig, actor || null, 'EXECUTANDO', now());
    this.audit(actor, 'RUN_START', 'run', id, { trigger: trig });
    return id;
  }

  addStep(runId, step, { rows = 0, ms = 0, status = 'OK', error = null } = {}) {
    this.db.prepare('INSERT INTO run_step (id, tenant_id, run_id, step, rows, ms, status, error) VALUES (?,?,?,?,?,?,?,?)')
      .run(newId('stp'), this.tenantId, runId, step, rows, ms, status, error);
  }

  endRun(runId, { status, findings = 0, newRecs = 0, error = null }) {
    this.db.prepare('UPDATE run SET status = ?, ended_at = ?, findings = ?, new_recs = ?, error = ? WHERE id = ? AND tenant_id = ?')
      .run(status, now(), findings, newRecs, error, runId, this.tenantId);
    this.audit(null, 'RUN_END', 'run', runId, { status, findings, newRecs, error });
  }

  listRuns(limit = 20) {
    const runs = this.db.prepare('SELECT * FROM run WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?').all(this.tenantId, limit);
    const steps = this.db.prepare('SELECT * FROM run_step WHERE tenant_id = ? AND run_id = ?');
    return runs.map((r) => ({
      id: r.id, trigger: r.trig, actor: r.actor, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
      findings: r.findings, newRecs: r.new_recs, error: r.error,
      steps: steps.all(this.tenantId, r.id).map((s) => ({ step: s.step, rows: s.rows, ms: s.ms, status: s.status, error: s.error }))
    }));
  }

  // ---------- achados e recomendações ----------
  openFinding(skillId, naturalKey) {
    return this.db.prepare("SELECT * FROM finding WHERE tenant_id = ? AND skill_id = ? AND natural_key = ? AND state = 'ABERTO'").get(this.tenantId, skillId, naturalKey);
  }

  openFindingsOf(skillId) {
    return this.db.prepare("SELECT * FROM finding WHERE tenant_id = ? AND skill_id = ? AND state = 'ABERTO'").all(this.tenantId, skillId);
  }

  insertFinding(runId, skill, f) {
    const id = newId('fnd');
    const t = now();
    this.db.prepare(`INSERT INTO finding (id, tenant_id, run_id, skill_id, skill_version, natural_key, severity, metric_value, threshold, impact_brl, data, first_seen, last_seen, state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'ABERTO')`)
      .run(id, this.tenantId, runId, skill.id, skill.version, f.naturalKey, f.severity, f.metricValue ?? null, f.threshold ?? null, f.impactBRL ?? null, j(f.data), t, t);
    const ins = this.db.prepare('INSERT INTO evidence (id, tenant_id, finding_id, kind, doc_entry, doc_num, line_num, card_code, item_code, snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)');
    (f.evidence || []).forEach((e) => ins.run(newId('evd'), this.tenantId, id, e.kind || null, e.docEntry ?? null, e.docNum ?? null, e.lineNum ?? null,
      e.cardCode || null, e.itemCode || null, j(e.values)));
    return id;
  }

  touchFinding(id, runId, f) {
    this.db.prepare('UPDATE finding SET last_seen = ?, run_id = ?, severity = ?, metric_value = ?, impact_brl = ?, data = ? WHERE id = ? AND tenant_id = ?')
      .run(now(), runId, f.severity, f.metricValue ?? null, f.impactBRL ?? null, j(f.data), id, this.tenantId);
  }

  resolveFinding(id) {
    this.db.prepare("UPDATE finding SET state = 'RESOLVIDO', last_seen = ? WHERE id = ? AND tenant_id = ?").run(now(), id, this.tenantId);
    const recs = this.db.prepare("SELECT id FROM recommendation WHERE tenant_id = ? AND finding_id = ? AND status IN ('PENDENTE','ADIADA')").all(this.tenantId, id);
    recs.forEach((r) => {
      this.db.prepare("UPDATE recommendation SET status = 'RESOLVIDA', updated_at = ? WHERE id = ? AND tenant_id = ?").run(now(), r.id, this.tenantId);
      this.audit(null, 'REC_RESOLVED', 'recommendation', r.id, { reason: 'achado não aparece mais nos dados' });
    });
  }

  insertRecommendation(findingId, skill, r) {
    const id = newId('rec');
    const t = now();
    this.db.prepare(`INSERT INTO recommendation (id, tenant_id, finding_id, skill_id, title, explanation, action, impact_brl, severity, financial, audience, status, created_at, updated_at, expires_at, replaces)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PENDENTE', ?,?,?,?)`)
      .run(id, this.tenantId, findingId, skill.id, r.title, r.explanation || null, j(r.action), r.impactBRL ?? null, r.severity,
        skill.financialImpact ? 1 : 0, r.audience || skill.audience || 'todos', t, t, r.expiresAt || null, r.replaces || null);
    this.audit(null, 'REC_CREATED', 'recommendation', id, { skill: skill.id, findingId, severity: r.severity, impactBRL: r.impactBRL ?? null });
    return id;
  }

  /** Expira PENDENTE/ADIADA vencidas e reativa ADIADA cujo prazo passou. */
  housekeeping() {
    const t = now();
    const exp = this.db.prepare("SELECT id FROM recommendation WHERE tenant_id = ? AND status IN ('PENDENTE','ADIADA') AND expires_at IS NOT NULL AND expires_at < ?").all(this.tenantId, t);
    exp.forEach((r) => {
      this.db.prepare("UPDATE recommendation SET status = 'EXPIRADA', updated_at = ? WHERE id = ? AND tenant_id = ?").run(t, r.id, this.tenantId);
      this.audit(null, 'REC_EXPIRED', 'recommendation', r.id, {});
    });
    const wake = this.db.prepare("SELECT id FROM recommendation WHERE tenant_id = ? AND status = 'ADIADA' AND snooze_until IS NOT NULL AND snooze_until <= ?").all(this.tenantId, t.slice(0, 10));
    wake.forEach((r) => {
      this.db.prepare("UPDATE recommendation SET status = 'PENDENTE', snooze_until = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?").run(t, r.id, this.tenantId);
      this.audit(null, 'REC_REOPENED', 'recommendation', r.id, { reason: 'fim do adiamento' });
    });
  }

  recRow(r) {
    return {
      id: r.id, skill: r.skill_id, title: r.title, explanation: r.explanation, action: pj(r.action), impactBRL: r.impact_brl,
      severity: r.severity, financial: !!r.financial, audience: r.audience, status: r.status, snoozeUntil: r.snooze_until,
      createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, findingId: r.finding_id,
      evidenceCount: this.db.prepare('SELECT COUNT(*) n FROM evidence WHERE tenant_id = ? AND finding_id = ?').get(this.tenantId, r.finding_id).n
    };
  }

  listRecommendations({ status, skill, limit = 100 } = {}) {
    let sql = 'SELECT * FROM recommendation WHERE tenant_id = ?';
    const args = [this.tenantId];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (skill) { sql += ' AND skill_id = ?'; args.push(skill); }
    sql += " ORDER BY CASE severity WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, impact_brl DESC, created_at DESC LIMIT ?";
    args.push(Math.min(Number(limit) || 100, 500));
    return this.db.prepare(sql).all(...args).map((r) => this.recRow(r));
  }

  getRecommendation(id, { evidenceLimit = 200 } = {}) {
    const r = this.db.prepare('SELECT * FROM recommendation WHERE tenant_id = ? AND id = ?').get(this.tenantId, id);
    if (!r) return null;
    const out = this.recRow(r);
    const f = this.db.prepare('SELECT * FROM finding WHERE tenant_id = ? AND id = ?').get(this.tenantId, r.finding_id);
    out.finding = f && { id: f.id, skillVersion: f.skill_version, naturalKey: f.natural_key, metricValue: f.metric_value, threshold: f.threshold,
      data: pj(f.data), firstSeen: f.first_seen, lastSeen: f.last_seen, state: f.state };
    out.evidence = this.db.prepare('SELECT * FROM evidence WHERE tenant_id = ? AND finding_id = ? LIMIT ?').all(this.tenantId, r.finding_id, evidenceLimit)
      .map((e) => ({ kind: e.kind, docEntry: e.doc_entry, docNum: e.doc_num, lineNum: e.line_num, cardCode: e.card_code, itemCode: e.item_code, values: pj(e.snapshot) }));
    out.decisions = this.db.prepare('SELECT * FROM decision WHERE tenant_id = ? AND recommendation_id = ? ORDER BY decided_at').all(this.tenantId, id)
      .map((d) => ({ userCode: d.user_code, decision: d.decision, reason: d.reason, snoozeUntil: d.snooze_until, decidedAt: d.decided_at }));
    out.history = this.listAudit({ refId: id, limit: 50 });
    return out;
  }

  decide(id, userCode, decision, reason, snoozeUntil) {
    return this.tx(() => {
      const r = this.db.prepare('SELECT status FROM recommendation WHERE tenant_id = ? AND id = ?').get(this.tenantId, id);
      if (!r) return { error: 404 };
      if (!['PENDENTE', 'ADIADA'].includes(r.status)) return { error: 409, status: r.status };
      const t = now();
      const status = decision;
      this.db.prepare('INSERT INTO decision (id, tenant_id, recommendation_id, user_code, decision, reason, snooze_until, decided_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(newId('dec'), this.tenantId, id, userCode, decision, reason || null, snoozeUntil || null, t);
      this.db.prepare('UPDATE recommendation SET status = ?, snooze_until = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(status, decision === 'ADIADA' ? snoozeUntil : null, t, id, this.tenantId);
      this.audit(userCode, 'REC_DECISION', 'recommendation', id, { decision, reason: reason || null, snoozeUntil: snoozeUntil || null });
      return { status };
    });
  }

  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) n FROM recommendation WHERE tenant_id = ? GROUP BY status').all(this.tenantId);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  close() { this.db.close(); }
}

/** Repositório da empresa (um arquivo por empresa, aberto uma vez por processo). */
function forTenant(tenantId) {
  const key = `${root()}|${tenantId}`;
  if (!open.has(key)) {
    fs.mkdirSync(root(), { recursive: true });
    open.set(key, new Repo(tenantId, path.join(root(), `${safe(tenantId)}.db`)));
  }
  return open.get(key);
}

function closeAll() { for (const r of open.values()) r.close(); open.clear(); }

module.exports = { forTenant, closeAll, GENESIS };
