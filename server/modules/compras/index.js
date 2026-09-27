'use strict';
/**
 * Módulo Compras: ciclo completo em objetos nativos do B1.
 *   Solicitação (OPRQ) -> Cotação online / Oferta de compra (OPQT) -> Pedido de compra (OPOR)
 *   Contrato guarda-chuva (OOAT) consumido no pedido | Aprovação = Procedimentos de Autorização (OWDD)
 * Rotas montadas em /api/m/compras ; página pública do fornecedor em /api/public/compras
 *
 * Telas de comprador (tiles "buyer"): liberadas por tenants.json > moduleAccess.compras.buyers
 * { "departments": [..], "users": [..] }. Sem essa regra, quem acessa Compras vê tudo.
 */
const express = require('express');
const attachments = require('../../core/attachments');
const notify = require('../../core/notify');
const access = require('../../core/access');
const { createService, buildMap } = require('./rfq');
const dashboard = require('./dashboard');
const relations = require('./relations');

const adapter = (mock) => (mock ? require('./mock') : { ...require('./sl'), ...require('./sl-procure'), ...require('./sl-relations') });
const KIND_OK = ['pr', 'pq', 'po', 'gr'];
const today = () => new Date().toISOString().slice(0, 10);

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

function validateOrder(p) {
  const e = [];
  if (!p || typeof p !== 'object') return ['Payload inválido'];
  if (!p.cardCode) e.push('Informe o fornecedor');
  if (!isDate(p.dueDate)) e.push('Data de entrega inválida');
  else if (p.dueDate < today()) e.push('Data de entrega no passado');
  if (!Array.isArray(p.lines) || !p.lines.length) e.push('Inclua ao menos um item');
  else if (p.lines.length > 100) e.push('Máximo de 100 itens por pedido');
  else p.lines.forEach((l, i) => {
    if (!l.itemCode) e.push(`Linha ${i + 1}: item obrigatório`);
    if (!(Number(l.quantity) > 0)) e.push(`Linha ${i + 1}: quantidade deve ser maior que zero`);
    if (l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== '' && !(Number(l.unitPrice) >= 0)) e.push(`Linha ${i + 1}: preço inválido`);
    if (l.shipDate && !isDate(l.shipDate)) e.push(`Linha ${i + 1}: data de entrega inválida`);
    if (l.agreementNo && !/^\d+$/.test(String(l.agreementNo))) e.push(`Linha ${i + 1}: contrato inválido`);
  });
  if (p.comments && String(p.comments).length > 254) e.push('Observações: máximo 254 caracteres');
  return e;
}

function validateAgreement(p) {
  const e = [];
  if (!p || typeof p !== 'object') return ['Payload inválido'];
  if (!p.cardCode) e.push('Informe o fornecedor');
  if (!isDate(p.startDate) || !isDate(p.endDate)) e.push('Informe início e fim do contrato');
  else if (p.endDate < p.startDate) e.push('Fim do contrato antes do início');
  if (!String(p.description || '').trim()) e.push('Informe a descrição do contrato');
  if (!['item', 'monetary'].includes(p.method)) e.push('Método do contrato inválido');
  if (!Array.isArray(p.lines) || !p.lines.length) e.push('Inclua ao menos uma linha');
  else p.lines.forEach((l, i) => {
    if (p.method === 'monetary') {
      if (!(Number(l.plannedAmount) > 0)) e.push(`Linha ${i + 1}: valor planejado inválido`);
    } else {
      if (!l.itemCode) e.push(`Linha ${i + 1}: item obrigatório`);
      if (!(Number(l.plannedQty) > 0)) e.push(`Linha ${i + 1}: quantidade planejada inválida`);
      if (!(Number(l.unitPrice) >= 0)) e.push(`Linha ${i + 1}: preço inválido`);
    }
  });
  return e;
}

module.exports = {
  id: 'compras',
  adapter, validateRequest, validateOrder, createService,
  title: 'Compras',
  description: 'Solicitação, cotação, pedido, contratos e aprovação',
  tiles: [
    { id: 'new', title: 'Nova solicitação', subtitle: 'Solicitar materiais e serviços', icon: 'sap-icon://cart-4', route: 'compras.new' },
    { id: 'mine', title: 'Solicitações de compra', subtitle: 'Minhas solicitações', icon: 'sap-icon://my-sales-order', route: 'compras.mine', counter: true },
    { id: 'rfq', title: 'Cotações online', subtitle: 'Em andamento (sem pedido gerado)', icon: 'sap-icon://compare', route: 'compras.rfqs', counter: true, buyer: true },
    { id: 'offers', title: 'Ofertas de compra', subtitle: 'Propostas dos fornecedores', icon: 'sap-icon://sales-quote', route: 'compras.offers', buyer: true },
    { id: 'orders', title: 'Pedidos de compra', subtitle: 'Emitir e acompanhar', icon: 'sap-icon://sales-order', route: 'compras.orders', counter: true, buyer: true },
    { id: 'receipts', title: 'Recebimento de mercadorias', subtitle: 'Pedidos a receber', icon: 'sap-icon://receipt', route: 'compras.receipts', counter: true, receiver: true },
    { id: 'contracts', title: 'Contratos guarda-chuva', subtitle: 'Acordos com fornecedores', icon: 'sap-icon://umbrella', route: 'compras.contracts', buyer: true },
    { id: 'approvals', title: 'Aprovações de compras', subtitle: 'Aguardando sua decisão', icon: 'sap-icon://approvals', route: 'compras.approvals', counter: true, critical: true }
  ],

  createPublicRouter({ mock, wrap, tenantById }) {
    const rfq = createService({ b1: adapter(mock), tenantById });
    const r = express.Router();
    const hits = new Map();
    r.use((req, res, next) => { // limite por IP: 60 chamadas / 5 min
      const now = Date.now();
      const h = (hits.get(req.ip) || []).filter((t) => now - t < 300000);
      if (h.length >= 60) return res.status(429).json({ error: 'Muitas requisições. Aguarde alguns minutos.' });
      h.push(now);
      hits.set(req.ip, h);
      next();
    });
    r.get('/cotacao/:token', wrap(async (req, res) => {
      const out = rfq.publicGet(req.params.token);
      if (!out) return res.status(404).json({ error: 'Link inválido ou expirado. Fale com o comprador.' });
      res.json({ ...out.data, branding: require('../../core/branding').forTenant(out.tenant || {}) });
    }));
    r.post('/cotacao/:token', wrap(async (req, res) => {
      const out = await rfq.publicSubmit(req, req.params.token, req.body || {});
      if (!out) return res.status(404).json({ error: 'Link inválido ou expirado. Fale com o comprador.' });
      res.json(out);
    }));
    return r;
  },

  createRouter({ mock, wrap, audit, tenantById }) {
    const b1 = adapter(mock);
    const rfq = createService({ b1, tenantById });
    const r = express.Router();
    const isReceiver = (req) => access.canTile(req.tenant, req.session.user, 'compras', { receiver: true });
    const receiverOnly = (req, res, next) => (isReceiver(req) ? next() : res.status(403).json({ error: 'Função exclusiva do recebimento' }));
    const buyerOnly = (req, res, next) => (access.canTile(req.tenant, req.session.user, 'compras', { buyer: true })
      ? next() : res.status(403).json({ error: 'Função exclusiva de compradores' }));
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
      if (b1.warmup) b1.warmup(req.tenant, req.session.ctx); // tela inicial já aquece o catálogo de itens
      const key = `${req.tenant.id}:${req.session.user.userCode}`;
      const hit = counterCache.get(key);
      if (hit && Date.now() - hit.at < 30000) return res.json(hit.value);
      const buyer = access.canTile(req.tenant, req.session.user, 'compras', { buyer: true });
      const [mine, approvals, rfqs, orders] = await Promise.allSettled([
        b1.countMyRequests(req.tenant, req.session.ctx, req.session.user),
        b1.countPendingApprovals(req.tenant, req.session.ctx, req.session.user),
        // Em andamento = ainda sem pedido: recebendo respostas, prazo vencido ou encerrada aguardando decisão
        buyer ? Promise.resolve(rfq.list(req).filter((x) => ['OPEN', 'EXPIRED', 'CLOSED'].includes(x.status) || x.pendingSync).length) : Promise.resolve(undefined),
        buyer ? b1.countOpen(req.tenant, req.session.ctx, 'po') : Promise.resolve(undefined)
      ]);
      [mine, approvals, rfqs, orders].forEach((x) => { if (x.status === 'rejected') console.error('[compras] contador falhou:', x.reason && x.reason.message); });
      const out = {};
      if (mine.status === 'fulfilled') out.mine = mine.value;
      if (approvals.status === 'fulfilled') out.approvals = approvals.value;
      if (rfqs.status === 'fulfilled' && rfqs.value !== undefined) out.rfq = rfqs.value;
      if (orders.status === 'fulfilled' && orders.value !== undefined) out.orders = orders.value;
      if (isReceiver(req)) {
        out.receipts = out.orders !== undefined ? out.orders
          : await b1.countOpen(req.tenant, req.session.ctx, 'po').catch(() => undefined);
      }
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
    r.get('/vendors/:cardCode/contact', buyerOnly, wrap(async (req, res) => {
      res.json(await b1.vendorContact(req.tenant, req.session.ctx, String(req.params.cardCode).slice(0, 50)));
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
      if (result.source === 'draft') notify.approvalRequested(req, b1, result.entry);
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
      notify.generated(req, b1, Number(req.params.entry));
      res.json(out);
    }));

    // ---------- Documentos genéricos (solicitação, oferta, pedido) ----------
    const docParams = (req, res) => {
      const { kind, source, entry } = req.params;
      if (!KIND_OK.includes(kind) || !['doc', 'draft'].includes(source) || !/^\d+$/.test(entry)) {
        res.status(400).json({ error: 'Parâmetros inválidos' });
        return null;
      }
      // Oferta/pedido efetivados: só comprador. Rascunho: quem aprova ou quem criou (checado no B1).
      const canView = access.canTile(req.tenant, req.session.user, 'compras', { buyer: true }) ||
        (['po', 'gr'].includes(kind) && isReceiver(req));
      if (kind !== 'pr' && source === 'doc' && !canView) {
        res.status(403).json({ error: 'Função exclusiva de compradores' });
        return null;
      }
      return { kind, source, entry: Number(entry) };
    };

    r.get('/docs/:kind/:source/:entry', wrap(async (req, res) => {
      const p = docParams(req, res);
      if (!p) return;
      const doc = await b1.getRequest(req.tenant, req.session.ctx, p.source, p.entry, p.kind);
      doc.attachments = await attachments.list(req.tenant, req.session.ctx, doc.attachmentEntry, mock);
      res.json(doc);
    }));

    // Mapa de relações (solicitação → cotação → oferta → pedido → recebimento → nota)
    r.get('/docs/:kind/:source/:entry/relations', wrap(async (req, res) => {
      const p = docParams(req, res);
      if (!p) return;
      res.json(await relations.build({ tenant: req.tenant, ctx: req.session.ctx, b1, kind: p.kind, source: p.source, entry: p.entry }));
    }));

    r.get('/docs/:kind/:source/:entry/attachments/:line', wrap(async (req, res) => {
      const p = docParams(req, res);
      if (!p) return;
      if (!/^\d+$/.test(req.params.line)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      const doc = await b1.getRequest(req.tenant, req.session.ctx, p.source, p.entry, p.kind);
      if (!doc.attachmentEntry) return res.status(404).json({ error: 'Documento sem anexos' });
      attachments.send(res, await attachments.download(req.tenant, req.session.ctx, doc.attachmentEntry, req.params.line, mock));
    }));

    r.post('/docs/:kind/draft/:entry/finalize', wrap(async (req, res) => {
      if (!KIND_OK.includes(req.params.kind) || !/^\d+$/.test(req.params.entry)) return res.status(400).json({ error: 'Parâmetro inválido' });
      const entry = Number(req.params.entry);
      const draft = await b1.getRequest(req.tenant, req.session.ctx, 'draft', entry, req.params.kind);
      const u = req.session.user;
      const mineDoc = draft.requester === u.userCode || (draft.approval && Number(draft.approval.originatorId) === Number(u.internalKey));
      if (!mineDoc) return res.status(403).json({ error: 'Somente quem criou o documento pode efetivar' });
      if (draft.status !== 'APPROVED') return res.status(400).json({ error: 'Documento ainda não aprovado' });
      const out = await b1.finalizeDraft(req.tenant, req.session.ctx, entry);
      audit(req, `${draft.kind.toUpperCase()}_FINALIZE`, { draftEntry: entry });
      notify.generated(req, b1, entry);
      res.json(out);
    }));

    // ---------- Ofertas e pedidos ----------
    const listStatus = (s) => (['open', 'closed', 'all'].includes(s) ? s : 'open');
    r.get('/offers', buyerOnly, wrap(async (req, res) => {
      res.json(await b1.listDocs(req.tenant, req.session.ctx, req.session.user, 'pq', { status: listStatus(req.query.status), cardCode: req.query.cardCode }));
    }));
    r.get('/orders', buyerOnly, wrap(async (req, res) => {
      res.json(await b1.listDocs(req.tenant, req.session.ctx, req.session.user, 'po', { status: listStatus(req.query.status), cardCode: req.query.cardCode }));
    }));

    r.post('/orders', buyerOnly, wrap(async (req, res) => {
      const errors = validateOrder(req.body);
      const branches = await cached(`bpl:${req.tenant.id}:${req.session.user.userCode}`, 600000,
        () => b1.listBranches(req.tenant, req.session.ctx, req.session.user));
      if (branches.length && !branches.some((b) => String(b.id) === String(req.body && req.body.branch))) errors.push('Selecione a filial');
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
      const att = attachments.parse(req.body.attachments);
      if (att.errors.length) return res.status(400).json({ error: att.errors.join('; ') });
      const attachmentEntry = await attachments.upload(req.tenant, req.session.ctx, att.files, mock);
      const result = await b1.createPurchaseOrder(req.tenant, req.session.ctx, req.session.user,
        { ...req.body, attachments: undefined, attachmentEntry });
      audit(req, 'PO_CREATE', result);
      if (result.source === 'draft') notify.approvalRequested(req, b1, result.entry);
      res.status(201).json(result);
    }));

    // ---------- Recebimento de mercadorias ----------
    r.get('/receipts/pending', receiverOnly, wrap(async (req, res) => {
      const list = await b1.listDocs(req.tenant, req.session.ctx, req.session.user, 'po', { status: 'open' });
      const today = new Date().toISOString().slice(0, 10);
      res.json(list.filter((x) => x.source === 'doc').map((x) => ({ ...x, late: !!(x.dueDate && String(x.dueDate).slice(0, 10) < today) })));
    }));

    r.get('/receipts/po/:entry', receiverOnly, wrap(async (req, res) => {
      if (!/^\d+$/.test(req.params.entry)) return res.status(400).json({ error: 'Parâmetro inválido' });
      res.json(await b1.poForReceipt(req.tenant, req.session.ctx, Number(req.params.entry)));
    }));

    r.post('/receipts', receiverOnly, wrap(async (req, res) => {
      const p = req.body || {};
      if (!/^\d+$/.test(String(p.poEntry || ''))) return res.status(400).json({ error: 'Pedido inválido' });
      const po = await b1.poForReceipt(req.tenant, req.session.ctx, Number(p.poEntry));
      const errors = [];
      if (po.status !== 'OPEN') errors.push('Pedido não está em aberto');
      if (!isDate(p.date) || p.date > today()) errors.push('Data do recebimento inválida');
      const lines = (Array.isArray(p.lines) ? p.lines : []).filter((l) => Number(l.quantity) > 0);
      if (!lines.length) errors.push('Informe a quantidade recebida de ao menos um item');
      lines.forEach((l) => {
        const pl = po.lines.find((x) => Number(x.lineNum) === Number(l.lineNum));
        if (!pl) { errors.push(`Linha ${Number(l.lineNum) + 1}: não está em aberto no pedido`); return; }
        const name = pl.itemName || pl.itemCode;
        if (Number(l.quantity) > pl.open + 1e-9) errors.push(`${name}: recebendo ${l.quantity}, mas só faltam ${pl.open} ${pl.uom || ''}`.trim());
        if (pl.serial) errors.push(`${name}: item controlado por número de série — registre este recebimento no SAP`);
        if (pl.batch && !String(l.batch || '').trim()) errors.push(`${name}: informe o lote`);
        if (l.expiry && !isDate(l.expiry)) errors.push(`${name}: validade inválida`);
        l.batch = pl.batch ? String(l.batch).trim() : null;
      });
      if (p.comments && String(p.comments).length > 254) errors.push('Observações: máximo 254 caracteres');
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
      const att = attachments.parse(p.attachments);
      if (att.errors.length) return res.status(400).json({ error: att.errors.join('; ') });
      const attachmentEntry = await attachments.upload(req.tenant, req.session.ctx, att.files, mock);
      const result = await b1.createGoodsReceipt(req.tenant, req.session.ctx, req.session.user, {
        poEntry: po.entry, cardCode: po.cardCode, branch: po.branch, date: p.date, numAtCard: String(p.numAtCard || '').slice(0, 100),
        comments: p.comments, attachmentEntry,
        lines: lines.map((l) => ({ lineNum: Number(l.lineNum), quantity: Number(l.quantity), warehouse: l.warehouse, batch: l.batch, expiry: l.expiry || undefined }))
      });
      audit(req, 'GR_CREATE', { ...result, poEntry: po.entry });
      if (result.source === 'draft') notify.approvalRequested(req, b1, result.entry);
      if (dashboard.clear) dashboard.clear(req.tenant.id);
      res.status(201).json(result);
    }));

    // ---------- Contratos guarda-chuva ----------
    r.get('/agreements', wrap(async (req, res) => {
      res.json(await b1.listAgreements(req.tenant, req.session.ctx, { cardCode: req.query.cardCode, activeOnly: req.query.active === '1' }));
    }));
    r.get('/agreements/:no', buyerOnly, wrap(async (req, res) => {
      if (!/^\d+$/.test(req.params.no)) return res.status(400).json({ error: 'Parâmetro inválido' });
      res.json(await b1.getAgreement(req.tenant, req.session.ctx, Number(req.params.no)));
    }));
    r.post('/agreements', buyerOnly, wrap(async (req, res) => {
      const errors = validateAgreement(req.body);
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
      const out = await b1.createAgreement(req.tenant, req.session.ctx, req.body);
      audit(req, 'AGREEMENT_CREATE', out);
      res.status(201).json(out);
    }));
    r.post('/agreements/:no/status', buyerOnly, wrap(async (req, res) => {
      const st = String((req.body || {}).status || '');
      if (!/^\d+$/.test(req.params.no) || !['ACTIVE', 'ONHOLD', 'TERMINATED', 'CANCELLED'].includes(st)) return res.status(400).json({ error: 'Parâmetros inválidos' });
      await b1.setAgreementStatus(req.tenant, req.session.ctx, Number(req.params.no), st);
      audit(req, 'AGREEMENT_STATUS', { agreementNo: Number(req.params.no), status: st });
      res.json(await b1.getAgreement(req.tenant, req.session.ctx, Number(req.params.no)));
    }));

    // ---------- Painel do comprador ----------
    r.get('/dashboard', buyerOnly, wrap(async (req, res) => {
      const y = Number(req.query.year) || new Date().getFullYear();
      if (y < 2000 || y > 2100) return res.status(400).json({ error: 'Ano inválido' });
      if (req.query.refresh === '1') dashboard.clear(req.tenant.id);
      res.json(await dashboard.build({ tenant: req.tenant, ctx: req.session.ctx, b1, year: y, buildMap }));
    }));

    // ---------- Cotação online ----------
    const idOk = (req, res) => (/^\d+$/.test(req.params.id) ? true : (res.status(400).json({ error: 'Parâmetro inválido' }), false));
    r.get('/rfq', buyerOnly, wrap(async (req, res) => res.json(rfq.list(req))));
    r.get('/rfq/sources', buyerOnly, wrap(async (req, res) => res.json(await rfq.sources(req, req.query.branch || null))));
    r.post('/rfq', buyerOnly, wrap(async (req, res) => {
      const out = await rfq.create(req, req.body);
      audit(req, 'RFQ_CREATE', { id: out.id, suppliers: out.suppliers.map((s) => s.cardCode) });
      res.status(201).json(out);
    }));
    r.get('/rfq/:id', buyerOnly, wrap(async (req, res) => { if (idOk(req, res)) res.json(rfq.get(req, req.params.id)); }));
    r.post('/rfq/:id/sync', buyerOnly, wrap(async (req, res) => { if (idOk(req, res)) res.json(await rfq.sync(req, req.params.id)); }));
    r.post('/rfq/:id/suppliers', buyerOnly, wrap(async (req, res) => {
      if (!idOk(req, res)) return;
      const { cardCode, email } = req.body || {};
      if (!cardCode) return res.status(400).json({ error: 'Informe o fornecedor' });
      res.json(await rfq.addSupplier(req, req.params.id, String(cardCode), email));
    }));
    r.post('/rfq/:id/suppliers/:cardCode/resend', buyerOnly, wrap(async (req, res) => {
      if (idOk(req, res)) res.json(await rfq.resend(req, req.params.id, req.params.cardCode, req.body || {}));
    }));
    r.post('/rfq/:id/suppliers/:cardCode/answer', buyerOnly, wrap(async (req, res) => {
      if (!idOk(req, res)) return;
      const out = await rfq.buyerAnswer(req, req.params.id, req.params.cardCode, req.body);
      audit(req, 'RFQ_BUYER_ANSWER', { id: Number(req.params.id), cardCode: req.params.cardCode });
      res.json(out);
    }));
    r.post('/rfq/:id/close', buyerOnly, wrap(async (req, res) => { if (idOk(req, res)) res.json(await rfq.close(req, req.params.id)); }));
    r.post('/rfq/:id/reopen', buyerOnly, wrap(async (req, res) => { if (idOk(req, res)) res.json(await rfq.reopen(req, req.params.id, (req.body || {}).deadline)); }));
    r.post('/rfq/:id/cancel', buyerOnly, wrap(async (req, res) => {
      if (!idOk(req, res)) return;
      const out = await rfq.cancel(req, req.params.id);
      audit(req, 'RFQ_CANCEL', { id: Number(req.params.id) });
      res.json(out);
    }));
    r.post('/rfq/:id/award', buyerOnly, wrap(async (req, res) => {
      if (!idOk(req, res)) return;
      const out = await rfq.award(req, req.params.id, req.body || {});
      audit(req, 'RFQ_AWARD', { id: out.id, orders: out.award.orders });
      out.award.orders.filter((o) => o.source === 'draft').forEach((o) => notify.approvalRequested(req, b1, o.entry));
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
      if (out && out.draftEntry) notify.decided(req, b1, Number(out.draftEntry), approve, String(remarks || ''));
      res.json(out);
    }));

    return r;
  }
};
