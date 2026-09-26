'use strict';
/**
 * Módulo Relatórios: catálogo de consultas executadas via SQLQueries do Service Layer.
 * Rotas montadas em /api/m/relatorios
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const builtIn = require('./catalog');
const sqlQuery = require('../../core/sqlQuery');

const ID = /^[a-z0-9-]{2,40}$/;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s));

/** Relatórios extras do cliente (config/reports.json), sem precisar de código. */
function loadCustom() {
  const file = process.env.REPORTS_FILE || path.join(__dirname, '..', '..', '..', 'config', 'reports.json');
  if (!fs.existsSync(file)) return [];
  const list = require('../../core/readJson')(file);
  return list.filter((r) => {
    const ok = ID.test(r.id) && typeof r.sql === 'string' && /^\s*select\s/i.test(r.sql) && !/;\s*\S/.test(r.sql);
    if (!ok) console.warn(`[relatorios] ignorado relatório inválido: ${r.id}`);
    return ok;
  });
}

function catalogFor(tenant) {
  const custom = loadCustom();
  const all = [...builtIn.filter((b) => !custom.some((c) => c.id === b.id)), ...custom];
  const allow = Array.isArray(tenant.reports) ? tenant.reports : null; // tenants.json: "reports": ["id", ...]
  return all.filter((r) => !allow || allow.includes(r.id));
}

// Código curto e estável do objeto SQLQueries no B1 (evita colisão e limite de tamanho)
const queryCode = (id) => 'PB_R' + require('crypto').createHash('sha1').update(id).digest('hex').slice(0, 10).toUpperCase();

const publicInfo = ({ id, title, category, description, params, columns }) =>
  ({ id, title, category: category || 'Geral', description: description || '', params: params || [], columns: columns || [] });

module.exports = {
  id: 'relatorios',
  title: 'Relatórios',
  description: 'Consultas e exportação',
  tiles: [
    { id: 'catalog', title: 'Relatórios', subtitle: 'Financeiro, vendas, compras e estoque', icon: 'sap-icon://business-objects-experience', route: 'relatorios.list' }
  ],

  createRouter({ mock, wrap, audit }) {
    const r = express.Router();

    r.get('/', (req, res) => res.json(catalogFor(req.tenant).map(publicInfo)));

    r.post('/:id/run', wrap(async (req, res) => {
      const rep = catalogFor(req.tenant).find((x) => x.id === req.params.id);
      if (!rep) return res.status(404).json({ error: 'Relatório não encontrado' });

      const input = (req.body && req.body.params) || {};
      const params = {};
      for (const p of rep.params || []) {
        const v = input[p.name] ?? '';
        if (p.type === 'date' && !isDate(v)) return res.status(400).json({ error: `Informe uma data válida em "${p.label}"` });
        params[p.name] = String(v).slice(0, 100);
      }

      const started = Date.now();
      const out = mock
        ? { rows: rep.mock ? rep.mock(params) : [], truncated: false }
        : await sqlQuery.run(req.tenant, req.session.ctx, { code: queryCode(rep.id), name: `Portal B1 - ${rep.title}`, sql: rep.sql }, params);

      const rows = out.rows.map((row) => { const o = { ...row }; delete o['odata.etag']; return o; });
      const columns = rep.columns && rep.columns.length
        ? rep.columns
        : Object.keys(rows[0] || {}).map((k) => ({ key: k, label: k, type: typeof rows[0][k] === 'number' ? 'number' : 'text' }));

      audit(req, 'REPORT_RUN', { report: rep.id, rows: rows.length, ms: Date.now() - started });
      res.json({ report: publicInfo(rep), columns, rows, truncated: out.truncated, ms: Date.now() - started });
    }));

    return r;
  }
};
