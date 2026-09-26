'use strict';
/**
 * Módulo Despesas (reembolso): cada prestação vira uma SOLICITAÇÃO DE COMPRA DE SERVIÇO (OPRQ,
 * DocType dDocument_Service) — mesmo motor e mesmo procedimento de autorização de Compras.
 *  - linha = uma despesa: data, categoria (-> conta contábil), descrição, valor, centro de custo
 *  - comprovantes = anexos nativos (Attachments2) vinculados ao documento
 * As aprovações aparecem em Compras > Aprovações pendentes (mesmo objeto do B1).
 *
 * tenants.json:
 *   "expenseCategories": [ { "code": "KM", "name": "Quilometragem", "account": "4.1.1.01.001" }, ... ],
 *   "expenseRequireAttachment": true    // padrão: comprovante obrigatório
 * Categoria sem "account" -> o usuário escolhe a conta contábil na tela.
 */
const express = require('express');
const attachments = require('../../core/attachments');
const notify = require('../../core/notify');
const sl = require('../../core/slClient');

const DEFAULT_CATEGORIES = [
  { code: 'KM', name: 'Quilometragem' }, { code: 'REF', name: 'Refeição' }, { code: 'HOSP', name: 'Hospedagem' },
  { code: 'TRANSP', name: 'Transporte (táxi, app, ônibus)' }, { code: 'PED', name: 'Pedágio e estacionamento' },
  { code: 'COMB', name: 'Combustível' }, { code: 'OUT', name: 'Outras despesas' }
];
const MOCK_ACCOUNTS = [
  ['4.1.1.01.001', 'Despesas com viagens'], ['4.1.1.01.002', 'Refeições e lanches'], ['4.1.1.01.003', 'Hospedagem'],
  ['4.1.1.01.004', 'Combustíveis e lubrificantes'], ['4.1.1.01.005', 'Pedágios e estacionamentos'], ['4.1.1.01.009', 'Outras despesas administrativas']
].map(([code, name]) => ({ code, formatCode: code, name }));
const MOCK_ACCOUNT_BY_CAT = { KM: '4.1.1.01.001', REF: '4.1.1.01.002', HOSP: '4.1.1.01.003', TRANSP: '4.1.1.01.001', PED: '4.1.1.01.005', COMB: '4.1.1.01.004', OUT: '4.1.1.01.009' };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s));
const today = () => new Date().toISOString().slice(0, 10);
const q = (s) => String(s || '').replace(/'/g, "''");

function categoriesFor(tenant, mock) {
  const list = Array.isArray(tenant.expenseCategories) && tenant.expenseCategories.length ? tenant.expenseCategories : DEFAULT_CATEGORIES;
  return list.map((c) => ({ code: c.code, name: c.name, account: c.account || (mock ? MOCK_ACCOUNT_BY_CAT[c.code] : null) || null }));
}

function validate(p, cats, requireAttachment) {
  const e = [];
  if (!p || typeof p !== 'object') return ['Payload inválido'];
  if (!Array.isArray(p.lines) || !p.lines.length) e.push('Inclua ao menos uma despesa');
  else if (p.lines.length > 50) e.push('Máximo de 50 despesas por prestação');
  else p.lines.forEach((l, i) => {
    const n = `Despesa ${i + 1}`;
    if (!isDate(l.date)) e.push(`${n}: data inválida`);
    else if (l.date > today()) e.push(`${n}: data no futuro`);
    const cat = cats.find((c) => c.code === l.category);
    if (!cat) e.push(`${n}: categoria obrigatória`);
    else if (!cat.account && !l.accountCode) e.push(`${n}: informe a conta contábil`);
    if (!String(l.description || '').trim()) e.push(`${n}: descrição obrigatória`);
    if (!(Number(l.amount) > 0)) e.push(`${n}: valor deve ser maior que zero`);
  });
  if (requireAttachment && !(Array.isArray(p.attachments) && p.attachments.length)) e.push('Anexe ao menos um comprovante');
  if (p.comments && String(p.comments).length > 254) e.push('Observações: máximo 254 caracteres');
  return e;
}

module.exports = {
  id: 'despesas',
  title: 'Despesas',
  description: 'Prestação de contas e reembolso',
  tiles: [
    { id: 'new', title: 'Nova despesa', subtitle: 'Lançar despesas com comprovantes', icon: 'sap-icon://expense-report', route: 'despesas.new' },
    { id: 'mine', title: 'Minhas despesas', subtitle: 'Acompanhe o reembolso', icon: 'sap-icon://travel-expense', route: 'despesas.mine', counter: true }
  ],

  createRouter({ mock, wrap, audit }) {
    const b1 = mock ? require('../compras/mock') : require('../compras/sl');
    const r = express.Router();

    r.get('/counters', wrap(async (req, res) => {
      try {
        const list = await b1.listMyRequests(req.tenant, req.session.ctx, req.session.user, 'service');
        res.json({ mine: list.filter((x) => ['PENDING', 'APPROVED', 'OPEN'].includes(x.status)).length });
      } catch (e) { console.error('[despesas] contador falhou:', e.message); res.json({}); }
    }));

    r.get('/config', wrap(async (req, res) => {
      const [branches, costCenters] = await Promise.all([
        b1.listBranches(req.tenant, req.session.ctx, req.session.user).catch(() => []),
        b1.listCostCenters(req.tenant, req.session.ctx).catch(() => [])
      ]);
      res.json({
        categories: categoriesFor(req.tenant, mock),
        requireAttachment: req.tenant.expenseRequireAttachment !== false,
        maxFiles: attachments.MAX_FILES,
        allowed: attachments.ALLOWED,
        branches, costCenters
      });
    }));

    // Plano de contas (contas analíticas ativas) para categorias sem conta configurada
    r.get('/accounts', wrap(async (req, res) => {
      const term = String(req.query.q || '').slice(0, 50);
      if (mock) return res.json(MOCK_ACCOUNTS.filter((a) => !term || a.name.toLowerCase().includes(term.toLowerCase()) || a.formatCode.includes(term)));
      const t = encodeURIComponent(q(term));
      const f = `ActiveAccount eq 'tYES'` + (term ? ` and (contains(Name,'${t}') or contains(FormatCode,'${t}'))` : '');
      const rr = await sl.request(req.tenant, req.session.ctx.cookie, 'GET', `/ChartOfAccounts?$select=Code,Name,FormatCode&$filter=${f}&$top=20`);
      res.json((rr.value || []).map((a) => ({ code: a.Code, formatCode: a.FormatCode || a.Code, name: a.Name })));
    }));

    r.post('/', wrap(async (req, res) => {
      const cats = categoriesFor(req.tenant, mock);
      const requireAttachment = req.tenant.expenseRequireAttachment !== false;
      const errors = validate(req.body, cats, requireAttachment);
      const branches = await b1.listBranches(req.tenant, req.session.ctx, req.session.user).catch(() => []);
      if (branches.length && !branches.some((b) => String(b.id) === String(req.body && req.body.branch))) errors.push('Selecione a filial');
      const att = attachments.parse(req.body && req.body.attachments);
      errors.push(...att.errors);
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

      const attachmentEntry = await attachments.upload(req.tenant, req.session.ctx, att.files, mock);
      const lines = req.body.lines.map((l) => {
        const cat = cats.find((c) => c.code === l.category);
        return {
          date: l.date,
          description: `${cat.name} - ${String(l.description).trim()}`,
          accountCode: cat.account || l.accountCode,
          amount: Number(l.amount),
          costCenter: l.costCenter || undefined
        };
      });
      const result = await b1.createPurchaseRequest(req.tenant, req.session.ctx, req.session.user, {
        docType: 'service',
        branch: req.body.branch,
        requiredDate: today(),
        comments: `[DESPESA] ${req.body.comments || ''}`.trim().slice(0, 254),
        lines,
        attachmentEntry
      });
      audit(req, 'EXPENSE_CREATE', { ...result, attachments: att.files.length });
      if (result.source === 'draft') notify.approvalRequested(req, b1, result.entry);
      res.status(201).json(result);
    }));

    r.get('/', wrap(async (req, res) => {
      res.json(await b1.listMyRequests(req.tenant, req.session.ctx, req.session.user, 'service'));
    }));

    r.get('/:source/:entry', wrap(async (req, res) => {
      const { source, entry } = req.params;
      if (!['doc', 'draft'].includes(source) || !/^\d+$/.test(entry)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const doc = await b1.getRequest(req.tenant, req.session.ctx, source, Number(entry));
      doc.attachments = await attachments.list(req.tenant, req.session.ctx, doc.attachmentEntry, mock);
      res.json(doc);
    }));

    r.get('/:source/:entry/attachments/:line', wrap(async (req, res) => {
      const { source, entry, line } = req.params;
      if (!['doc', 'draft'].includes(source) || !/^\d+$/.test(entry) || !/^\d+$/.test(line)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const doc = await b1.getRequest(req.tenant, req.session.ctx, source, Number(entry));
      if (!doc.attachmentEntry) return res.status(404).json({ error: 'Documento sem anexos' });
      attachments.send(res, await attachments.download(req.tenant, req.session.ctx, doc.attachmentEntry, line, mock));
    }));

    r.post('/draft/:entry/finalize', wrap(async (req, res) => {
      if (!/^\d+$/.test(req.params.entry)) return res.status(400).json({ error: 'Parâmetro inválido' });
      const draft = await b1.getRequest(req.tenant, req.session.ctx, 'draft', Number(req.params.entry));
      if (draft.requester !== req.session.user.userCode) return res.status(403).json({ error: 'Somente o solicitante pode efetivar' });
      if (draft.status !== 'APPROVED') return res.status(400).json({ error: 'Despesa ainda não aprovada' });
      const out = await b1.finalizeDraft(req.tenant, req.session.ctx, Number(req.params.entry));
      audit(req, 'EXPENSE_FINALIZE', { draftEntry: Number(req.params.entry) });
      notify.generated(req, b1, Number(req.params.entry));
      res.json(out);
    }));

    return r;
  }
};
