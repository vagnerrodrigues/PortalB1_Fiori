'use strict';
/**
 * Módulo Compras: solicitação de compra + aprovação nativa (Procedimentos de Autorização do B1).
 * Rotas montadas em /api/m/compras
 */
const express = require('express');
const attachments = require('../../core/attachments');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s));

function validateRequest(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['Payload inválido'];
  if (!isDate(p.requiredDate)) errors.push('Data necessária inválida');
  else if (p.requiredDate < new Date().toISOString().slice(0, 10)) errors.push('Data necessária não pode estar no passado');
  if (!Array.isArray(p.lines) || p.lines.length === 0) errors.push('Inclua ao menos um item');
  else if (p.lines.length > 50) errors.push('Máximo de 50 itens por solicitação');
  else p.lines.forEach((l, i) => {
    if (!l.itemCode) errors.push(`Linha ${i + 1}: item obrigatório`);
    if (!(Number(l.quantity) > 0)) errors.push(`Linha ${i + 1}: quantidade deve ser maior que zero`);
    if (l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== '' && !(Number(l.unitPrice) >= 0)) errors.push(`Linha ${i + 1}: preço inválido`);
    if (l.requiredDate && !isDate(l.requiredDate)) errors.push(`Linha ${i + 1}: data inválida`);
  });
  if (p.comments && String(p.comments).length > 254) errors.push('Observações: máximo 254 caracteres');
  return errors;
}

module.exports = {
  id: 'compras',
  title: 'Compras',
  description: 'Solicitação de compra e aprovação',
  tiles: [
    { id: 'new', title: 'Nova solicitação', subtitle: 'Solicitar materiais e serviços', icon: 'sap-icon://cart-4', route: 'compras.new' },
    { id: 'mine', title: 'Minhas solicitações', subtitle: 'Acompanhe o status', icon: 'sap-icon://my-sales-order', route: 'compras.mine', counter: true },
    { id: 'approvals', title: 'Aprovações pendentes', subtitle: 'Aguardando sua decisão', icon: 'sap-icon://approvals', route: 'compras.approvals', counter: true, critical: true }
  ],

  createRouter({ mock, wrap, audit }) {
    const b1 = mock ? require('./mock') : require('./sl');
    const r = express.Router();
    const cache = new Map();
    const cached = async (key, ttl, fn) => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.value;
      const value = await fn();
      cache.set(key, { at: Date.now(), value });
      return value;
    };

    // Contadores dos tiles
    // Contadores dos tiles: consultas leves ($count), cache curto por usuário, independentes entre si
    const counterCache = new Map();
    const clearCounters = (req) => { for (const k of counterCache.keys()) if (k.startsWith(`${req.tenant.id}:`)) counterCache.delete(k); };
    r.get('/counters', wrap(async (req, res) => {
      const key = `${req.tenant.id}:${req.session.user.userCode}`;
      const hit = counterCache.get(key);
      if (hit && Date.now() - hit.at < 30000) return res.json(hit.value);
      const [mine, approvals] = await Promise.allSettled([
        b1.countMyRequests(req.tenant, req.session.ctx, req.session.user),
        b1.countPendingApprovals(req.tenant, req.session.ctx, req.session.user)
      ]);
      [mine, approvals].forEach((x) => { if (x.status === 'rejected') console.error('[compras] contador falhou:', x.reason && x.reason.message); });
      const out = {};
      if (mine.status === 'fulfilled') out.mine = mine.value;
      if (approvals.status === 'fulfilled') out.approvals = approvals.value;
      counterCache.set(key, { at: Date.now(), value: out });
      res.json(out);
    }));
    r.use((req, res, next) => { if (req.method !== 'GET') clearCounters(req); next(); });

    // Dados mestre
    r.get('/items', wrap(async (req, res) => {
      res.json(await b1.searchItems(req.tenant, req.session.ctx, String(req.query.q || '').slice(0, 50)));
    }));
    r.get('/vendors', wrap(async (req, res) => {
      res.json(await b1.searchVendors(req.tenant, req.session.ctx, String(req.query.q || '').slice(0, 50)));
    }));
    r.get('/cost-centers', wrap(async (req, res) => {
      res.json(await cached(`cc:${req.tenant.id}`, 600000, () => b1.listCostCenters(req.tenant, req.session.ctx)));
    }));
    r.get('/warehouses', wrap(async (req, res) => {
      res.json(await cached(`wh:${req.tenant.id}`, 600000, () => b1.listWarehouses(req.tenant, req.session.ctx)));
    }));

    r.get('/branches', wrap(async (req, res) => {
      res.json(await cached(`bpl:${req.tenant.id}:${req.session.user.userCode}`, 600000,
        () => b1.listBranches(req.tenant, req.session.ctx, req.session.user)));
    }));

    // Solicitações
    r.post('/purchase-requests', wrap(async (req, res) => {
      const errors = validateRequest(req.body);
      const branches = await cached(`bpl:${req.tenant.id}:${req.session.user.userCode}`, 600000,
        () => b1.listBranches(req.tenant, req.session.ctx, req.session.user));
      if (branches.length && !branches.some((b) => String(b.id) === String(req.body && req.body.branch))) {
        errors.push('Selecione a filial');
      }
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
      const att = attachments.parse(req.body.attachments);
      if (att.errors.length) return res.status(400).json({ error: att.errors.join('; ') });
      const attachmentEntry = await attachments.upload(req.tenant, req.session.ctx, att.files, mock);
      const result = await b1.createPurchaseRequest(req.tenant, req.session.ctx, req.session.user,
        { ...req.body, attachments: undefined, docType: 'items', attachmentEntry });
      audit(req, 'PR_CREATE', result);
      res.status(201).json(result);
    }));

    r.get('/purchase-requests', wrap(async (req, res) => {
      res.json(await b1.listMyRequests(req.tenant, req.session.ctx, req.session.user, 'items'));
    }));

    r.get('/purchase-requests/:source/:entry', wrap(async (req, res) => {
      const { source, entry } = req.params;
      if (!['doc', 'draft'].includes(source) || !/^\d+$/.test(entry)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const doc = await b1.getRequest(req.tenant, req.session.ctx, source, Number(entry));
      doc.attachments = await attachments.list(req.tenant, req.session.ctx, doc.attachmentEntry, mock);
      res.json(doc);
    }));

    // Download de anexo: só a partir do documento (quem não enxerga o documento não baixa o anexo)
    r.get('/purchase-requests/:source/:entry/attachments/:line', wrap(async (req, res) => {
      const { source, entry, line } = req.params;
      if (!['doc', 'draft'].includes(source) || !/^\d+$/.test(entry) || !/^\d+$/.test(line)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const doc = await b1.getRequest(req.tenant, req.session.ctx, source, Number(entry));
      if (!doc.attachmentEntry) return res.status(404).json({ error: 'Documento sem anexos' });
      attachments.send(res, await attachments.download(req.tenant, req.session.ctx, doc.attachmentEntry, line, mock));
    }));

    r.post('/purchase-requests/draft/:entry/finalize', wrap(async (req, res) => {
      if (!/^\d+$/.test(req.params.entry)) return res.status(400).json({ error: 'Parâmetro inválido' });
      const draft = await b1.getRequest(req.tenant, req.session.ctx, 'draft', Number(req.params.entry));
      if (draft.requester !== req.session.user.userCode) return res.status(403).json({ error: 'Somente o solicitante pode efetivar' });
      if (draft.status !== 'APPROVED') return res.status(400).json({ error: 'Solicitação ainda não aprovada' });
      const out = await b1.finalizeDraft(req.tenant, req.session.ctx, Number(req.params.entry));
      audit(req, 'PR_FINALIZE', { draftEntry: Number(req.params.entry) });
      res.json(out);
    }));

    // Aprovações
    r.get('/approvals', wrap(async (req, res) => {
      res.json(await b1.listPendingApprovals(req.tenant, req.session.ctx, req.session.user));
    }));

    r.post('/approvals/:code/decision', wrap(async (req, res) => {
      const { approve, remarks } = req.body || {};
      if (!/^\d+$/.test(req.params.code) || typeof approve !== 'boolean') return res.status(400).json({ error: 'Parâmetros inválidos' });
      if (!approve && !String(remarks || '').trim()) return res.status(400).json({ error: 'Informe o motivo da reprovação' });
      const out = await b1.decide(req.tenant, req.session.ctx, Number(req.params.code), approve, String(remarks || '').slice(0, 254));
      audit(req, approve ? 'PR_APPROVE' : 'PR_REJECT', { approvalCode: Number(req.params.code) });
      res.json(out);
    }));

    return r;
  }
};
