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
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'auditoria é somente inserção'); END;`,
  // v2 — espelho analítico (etapa 2): cópia de leitura, só os campos que as skills usam
  `CREATE TABLE wh_po (
     tenant_id TEXT NOT NULL, doc_entry INTEGER NOT NULL, doc_num INTEGER, card_code TEXT, card_name TEXT, doc_date TEXT, due_date TEXT,
     status TEXT, canceled INTEGER DEFAULT 0, bpl_id INTEGER, update_date TEXT, PRIMARY KEY (tenant_id, doc_entry));
   CREATE TABLE wh_po_line (
     tenant_id TEXT NOT NULL, doc_entry INTEGER NOT NULL, line_num INTEGER NOT NULL, item_code TEXT, item_name TEXT, quantity REAL, open_qty REAL,
     price REAL, line_total REAL, ship_date TEXT, line_status TEXT, cfop TEXT, usage TEXT, base_type INTEGER, base_entry INTEGER, agreement_no INTEGER,
     PRIMARY KEY (tenant_id, doc_entry, line_num));
   CREATE INDEX wh_po_open ON wh_po(tenant_id, status, due_date);
   CREATE TABLE wh_vendor (
     tenant_id TEXT NOT NULL, card_code TEXT NOT NULL, card_name TEXT, active INTEGER, email TEXT, state TEXT, update_date TEXT, PRIMARY KEY (tenant_id, card_code));
   CREATE TABLE wh_item (
     tenant_id TEXT NOT NULL, item_code TEXT NOT NULL, item_name TEXT, purchase INTEGER, active INTEGER, default_wh TEXT, group_code INTEGER, update_date TEXT,
     PRIMARY KEY (tenant_id, item_code));
   CREATE TABLE wh_sync (
     tenant_id TEXT NOT NULL, entity TEXT NOT NULL, watermark TEXT, last_run TEXT, rows INTEGER, total INTEGER, mode TEXT, ok INTEGER, error TEXT, ms INTEGER,
     PRIMARY KEY (tenant_id, entity));`
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

  /** auditValue: o que vai para a auditoria (ex.: sem senha). Padrão: o próprio valor. */
  setConfig(key, value, actor, auditValue) {
    this.db.prepare('INSERT INTO config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value')
      .run(this.tenantId, key, j(value));
    this.audit(actor, 'CONFIG_SET', 'config', key, auditValue === undefined ? value : auditValue);
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

  /** Achado que continua aberto mas mudou (ex.: mais pedidos na faixa): troca as evidências e atualiza o texto da recomendação ainda não decidida. */
  refreshFinding(id, f, d) {
    this.db.prepare('DELETE FROM evidence WHERE tenant_id = ? AND finding_id = ?').run(this.tenantId, id);
    const ins = this.db.prepare('INSERT INTO evidence (id, tenant_id, finding_id, kind, doc_entry, doc_num, line_num, card_code, item_code, snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)');
    (f.evidence || []).forEach((e) => ins.run(newId('evd'), this.tenantId, id, e.kind || null, e.docEntry ?? null, e.docNum ?? null, e.lineNum ?? null,
      e.cardCode || null, e.itemCode || null, j(e.values)));
    const recs = this.db.prepare("SELECT id, title FROM recommendation WHERE tenant_id = ? AND finding_id = ? AND status IN ('PENDENTE','ADIADA')").all(this.tenantId, id);
    recs.forEach((r) => {
      if (r.title === d.title) return;
      this.db.prepare('UPDATE recommendation SET title = ?, explanation = ?, impact_brl = ?, severity = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
        .run(d.title, d.explanation || null, f.impactBRL ?? null, f.severity, now(), r.id, this.tenantId);
      this.audit(null, 'REC_UPDATED', 'recommendation', r.id, { from: r.title, to: d.title });
    });
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

  // ---------- espelho analítico ----------
  syncState(entity) {
    const r = this.db.prepare('SELECT * FROM wh_sync WHERE tenant_id = ? AND entity = ?').get(this.tenantId, entity);
    return r ? { entity, watermark: r.watermark, lastRun: r.last_run, rows: r.rows, total: r.total, mode: r.mode, ok: !!r.ok, error: r.error, ms: r.ms } : null;
  }

  setSyncState(entity, s) {
    this.db.prepare(`INSERT INTO wh_sync (tenant_id, entity, watermark, last_run, rows, total, mode, ok, error, ms) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, entity) DO UPDATE SET watermark = excluded.watermark, last_run = excluded.last_run, rows = excluded.rows, total = excluded.total,
      mode = excluded.mode, ok = excluded.ok, error = excluded.error, ms = excluded.ms`)
      .run(this.tenantId, entity, s.watermark ?? null, now(), s.rows ?? 0, s.total ?? 0, s.mode ?? null, s.ok ? 1 : 0, s.error ?? null, s.ms ?? 0);
  }

  listSync() {
    return this.db.prepare('SELECT entity FROM wh_sync WHERE tenant_id = ? ORDER BY entity').all(this.tenantId).map((r) => this.syncState(r.entity));
  }

  /** Substitui pedidos inteiros (cabeçalho + linhas) vindos de uma leitura. */
  upsertOrders(docs) {
    const t = this.tenantId;
    const head = this.db.prepare(`INSERT INTO wh_po (tenant_id, doc_entry, doc_num, card_code, card_name, doc_date, due_date, status, canceled, bpl_id, update_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id, doc_entry) DO UPDATE SET doc_num = excluded.doc_num, card_code = excluded.card_code,
      card_name = excluded.card_name, doc_date = excluded.doc_date, due_date = excluded.due_date, status = excluded.status, canceled = excluded.canceled,
      bpl_id = excluded.bpl_id, update_date = excluded.update_date`);
    const del = this.db.prepare('DELETE FROM wh_po_line WHERE tenant_id = ? AND doc_entry = ?');
    const line = this.db.prepare(`INSERT INTO wh_po_line (tenant_id, doc_entry, line_num, item_code, item_name, quantity, open_qty, price, line_total, ship_date,
      line_status, cfop, usage, base_type, base_entry, agreement_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    this.tx(() => docs.forEach((d) => {
      head.run(t, d.docEntry, d.docNum ?? null, d.cardCode ?? null, d.cardName ?? null, d.docDate ?? null, d.dueDate ?? null, d.status ?? null,
        d.canceled ? 1 : 0, d.bplId ?? null, d.updateDate ?? null);
      del.run(t, d.docEntry);
      (d.lines || []).forEach((l) => line.run(t, d.docEntry, l.lineNum, l.itemCode ?? null, l.itemName ?? null, l.quantity ?? null, l.openQty ?? null,
        l.price ?? null, l.lineTotal ?? null, l.shipDate ?? null, l.lineStatus ?? null, l.cfop || null, l.usage == null || l.usage === '' ? null : String(l.usage),
        l.baseType ?? null, l.baseEntry ?? null, l.agreementNo ?? null));
    }));
  }

  upsertVendors(rows) {
    const st = this.db.prepare(`INSERT INTO wh_vendor (tenant_id, card_code, card_name, active, email, state, update_date) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, card_code) DO UPDATE SET card_name = excluded.card_name, active = excluded.active, email = excluded.email,
      state = excluded.state, update_date = excluded.update_date`);
    this.tx(() => rows.forEach((v) => st.run(this.tenantId, v.cardCode, v.cardName ?? null, v.active ? 1 : 0, v.email || null, v.state || null, v.updateDate ?? null)));
  }

  upsertItems(rows) {
    const st = this.db.prepare(`INSERT INTO wh_item (tenant_id, item_code, item_name, purchase, active, default_wh, group_code, update_date) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, item_code) DO UPDATE SET item_name = excluded.item_name, purchase = excluded.purchase, active = excluded.active,
      default_wh = excluded.default_wh, group_code = excluded.group_code, update_date = excluded.update_date`);
    this.tx(() => rows.forEach((i) => st.run(this.tenantId, i.itemCode, i.itemName ?? null, i.purchase ? 1 : 0, i.active ? 1 : 0, i.defaultWh || null, i.groupCode ?? null, i.updateDate ?? null)));
  }

  /** Consulta somente leitura ao espelho (usada pelas skills). Sempre filtra pela empresa. */
  wh(sql, ...args) {
    if (!/^\s*select\b/i.test(sql) || !/tenant_id\s*=\s*\?/i.test(sql)) throw new Error('Consulta ao espelho deve ser SELECT e filtrar tenant_id = ?');
    return this.db.prepare(sql).all(this.tenantId, ...args);
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
