'use strict';
/**
 * Adapter MOCK: simula o SAP B1 (solicitação, oferta, pedido, contrato guarda-chuva, rascunho e
 * procedimento de autorização) para demo comercial e desenvolvimento sem servidor B1.
 * Mesma interface de sl.js + sl-procure.js.
 *
 * Regras demo (simulam OWTM): solicitação > R$ 1.000 e pedido > R$ 5.000 vão para aprovação do usuário "aprovador".
 */
const { SLError } = require('../../core/slClient');

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const USERS = require('../../core/mockUsers');
const LIMIT = { pr: 1000, po: 5000 };
const round2 = (n) => Math.round(n * 100) / 100;

const ITEMS = [
  ['MP-0001', 'Aço carbono chapa 2mm', 'KG', '01'],
  ['MP-0002', 'Parafuso sextavado M8', 'UN', '01'],
  ['MC-0100', 'Luva de segurança nitrílica', 'PAR', '02'],
  ['MC-0101', 'Óculos de proteção incolor', 'UN', '02'],
  ['TI-0500', 'Notebook 14" i5 16GB', 'UN', '03'],
  ['TI-0501', 'Monitor 24" Full HD', 'UN', '03'],
  ['SV-9000', 'Serviço de manutenção preventiva', 'H', '01'],
  ['ES-0010', 'Papel A4 75g (resma)', 'CX', '02']
].map(([itemCode, itemName, uom, defaultWarehouse]) => ({ itemCode, itemName, uom, defaultWarehouse }));

const COST_CENTERS = [
  { code: 'ADM', name: 'Administrativo' }, { code: 'PROD', name: 'Produção' },
  { code: 'TI', name: 'Tecnologia' }, { code: 'COM', name: 'Comercial' }
];
const WAREHOUSES = [
  { code: '01', name: 'Almoxarifado Central' }, { code: '02', name: 'Materiais de Consumo' }, { code: '03', name: 'TI' }
];
const VENDORS = [
  { cardCode: 'F0001', cardName: 'Metalúrgica Paulista Ltda', email: 'vendas@metalurgica.demo' },
  { cardCode: 'F0002', cardName: 'EPI Brasil Distribuidora', email: 'cotacao@epibrasil.demo' },
  { cardCode: 'F0003', cardName: 'TechStore Informática', email: 'comercial@techstore.demo' },
  { cardCode: 'F0004', cardName: 'Papelaria Central', email: '' }
];

const db = {
  pr: [], pq: [], po: [], drafts: [], approvals: [], agreements: [],
  seq: { pr: 100, pq: 300, po: 700, draft: 500, appr: 1, agr: 10 }
};
db.docs = db.pr; // compatibilidade com testes antigos

const like = (s, t) => String(s).toLowerCase().includes(String(t || '').toLowerCase());
const searchItems = async (_t, _c, term) => ITEMS.filter((i) => !term || like(i.itemCode, term) || like(i.itemName, term));
const listCostCenters = async () => COST_CENTERS;
const listWarehouses = async () => WAREHOUSES;
const listBranches = async () => []; // demo sem filiais (campo oculto)
const searchVendors = async (_t, _c, term) => VENDORS.filter((v) => !term || like(v.cardCode, term) || like(v.cardName, term))
  .map(({ cardCode, cardName }) => ({ cardCode, cardName }));
const vendorName = (code) => (VENDORS.find((v) => v.cardCode === code) || {}).cardName || code;
const itemOf = (code) => ITEMS.find((x) => x.itemCode === code) || {};

function line(i, l, service) {
  if (service) {
    const amount = Number(l.amount || 0);
    return {
      lineNum: i, itemCode: '', itemName: l.description, uom: '', quantity: 1, unitPrice: amount, lineTotal: amount,
      requiredDate: l.date || l.requiredDate, costCenter: l.costCenter || '', warehouse: '', vendor: '',
      freeText: l.freeText || '', accountCode: l.accountCode, lineStatus: 'bost_Open'
    };
  }
  const item = itemOf(l.itemCode);
  const unitPrice = Number(l.unitPrice || 0);
  return {
    lineNum: i, itemCode: l.itemCode, itemName: item.itemName || l.itemCode, uom: item.uom || '',
    quantity: Number(l.quantity), openQty: Number(l.quantity), unitPrice, lineTotal: round2(unitPrice * Number(l.quantity)),
    requiredDate: l.requiredDate, shipDate: l.shipDate || null, costCenter: l.costCenter || '', warehouse: l.warehouse || '',
    vendor: l.vendor || '', freeText: l.freeText || '', agreementNo: l.agreementNo || null, agreementLine: l.agreementLine ?? null,
    baseType: l.baseType || null, baseEntry: l.baseEntry || null, baseLine: l.baseLine ?? null, lineStatus: 'bost_Open'
  };
}

function buildDoc(kind, user, p, entry) {
  const service = p.docType === 'service';
  const lines = p.lines.map((l, i) => line(i, { ...l, requiredDate: l.requiredDate || p.requiredDate }, service));
  return {
    kind, entry, docNum: entry, docDate: today(), requiredDate: p.requiredDate, dueDate: p.dueDate || p.validUntil || null,
    cardCode: p.cardCode || '', cardName: p.cardCode ? vendorName(p.cardCode) : '', numAtCard: p.numAtCard || '',
    requester: user.userCode, requesterName: user.userName, originatorId: user.internalKey, comments: p.comments || '',
    currency: 'R$', total: round2(lines.reduce((s, l) => s + l.lineTotal, 0)), lines, status: 'OPEN',
    docType: service ? 'service' : 'items', attachmentEntry: p.attachmentEntry || null, branch: p.branch || null
  };
}

/** Cria documento; acima do limite do tipo, retém em rascunho + aprovação (como o OWTM). */
function create(kind, user, p) {
  const probe = buildDoc(kind, user, p, 0);
  if (LIMIT[kind] && probe.total > LIMIT[kind]) {
    const entry = ++db.seq.draft;
    db.drafts.push({ ...buildDoc(kind, user, p, entry), status: 'PENDING', _payload: p });
    db.approvals.push({
      code: db.seq.appr++, kind, status: 'PENDING', currentStage: 1, originatorId: user.internalKey,
      createdAt: today(), remarks: `Total ${probe.total} acima de ${LIMIT[kind]}`, draftEntry: entry,
      steps: [{ stage: 1, userId: USERS.aprovador.internalKey, status: 'PENDING', remarks: '', date: null }]
    });
    return { kind, source: 'draft', entry, docNum: entry, status: 'PENDING' };
  }
  return materialize(kind, user, p);
}

function materialize(kind, user, p) {
  const entry = ++db.seq[kind];
  const doc = buildDoc(kind, user, p, entry);
  // Cópia de base (oferta -> pedido): preço da oferta, baixa da linha de origem
  doc.lines.forEach((l) => {
    if (!l.baseEntry) return;
    const src = db[l.baseType === 'pr' ? 'pr' : 'pq'].find((d) => d.entry === Number(l.baseEntry));
    const sl = src && src.lines[Number(l.baseLine)];
    if (!sl) throw new SLError(400, -5002, `Linha base ${l.baseEntry}/${l.baseLine} não encontrada`);
    Object.assign(l, { itemCode: sl.itemCode, itemName: sl.itemName, uom: sl.uom, unitPrice: sl.unitPrice, warehouse: sl.warehouse, costCenter: sl.costCenter });
    l.quantity = l.quantity || sl.openQty;
    l.lineTotal = round2(l.unitPrice * l.quantity);
    l.shipDate = l.shipDate || sl.shipDate;
    sl.openQty = Math.max(0, sl.openQty - l.quantity);
    if (!sl.openQty) sl.lineStatus = 'bost_Close';
    if (src.lines.every((x) => x.lineStatus === 'bost_Close')) src.status = 'CLOSED';
  });
  doc.lines.forEach((l) => { // consumo do contrato
    if (!l.agreementNo) return;
    const ag = db.agreements.find((a) => a.agreementNo === Number(l.agreementNo));
    const al = ag && ag.lines.find((x) => x.itemCode === l.itemCode);
    if (al) { al.usedQty += l.quantity; al.usedAmount = round2(al.usedAmount + l.lineTotal); }
  });
  doc.total = round2(doc.lines.reduce((s, l) => s + l.lineTotal, 0));
  db[kind].push(doc);
  return { kind, source: 'doc', entry, docNum: entry, status: 'OPEN' };
}

const createPurchaseRequest = async (_t, _c, user, p) => create('pr', user, p);

const approvalOf = (draftEntry) => db.approvals.find((a) => a.draftEntry === draftEntry);
const sum = (source, d, status) => ({
  kind: d.kind, source, docType: d.docType || 'items', entry: d.entry, docNum: d.docNum, docDate: d.docDate, requiredDate: d.requiredDate,
  dueDate: d.dueDate, cardCode: d.cardCode, cardName: d.cardName, numAtCard: d.numAtCard, total: d.total,
  currency: d.currency, comments: d.comments, status, approvalCode: source === 'draft' ? approvalOf(d.entry).code : null
});

async function listMyRequests(_t, _c, user, kind) {
  const drafts = db.drafts.filter((d) => d.kind === 'pr' && d.requester === user.userCode)
    .map((d) => sum('draft', d, approvalOf(d.entry).status)).filter((d) => d.status !== 'GENERATED');
  const docs = db.pr.filter((d) => d.requester === user.userCode).map((d) => sum('doc', d, d.status));
  return [...drafts, ...docs].filter((x) => !kind || x.docType === kind).sort((a, b) => b.entry - a.entry);
}

async function getRequest(_t, _c, source, entry, kind = 'pr') {
  const d = source === 'draft' ? db.drafts.find((x) => x.entry === Number(entry)) : db[kind].find((x) => x.entry === Number(entry));
  if (!d) throw new SLError(404, -2028, 'Documento não encontrado');
  const approval = source === 'draft' ? approvalOf(d.entry) : null;
  const generated = approval && approval.generatedEntry ? { entry: approval.generatedEntry, docNum: approval.generatedEntry } : null;
  const { _payload, ...rest } = d;
  return { source, ...rest, kind: d.kind, status: approval ? approval.status : d.status, approval, generated };
}

async function listPendingApprovals(_t, _c, user) {
  return db.approvals
    .filter((a) => a.status === 'PENDING' && a.steps.some((s) => s.userId === user.internalKey && s.status === 'PENDING' && s.stage === a.currentStage))
    .map((a) => {
      const d = db.drafts.find((x) => x.entry === a.draftEntry);
      return {
        kind: a.kind, approvalCode: a.code, draftEntry: a.draftEntry, docType: d.docType || 'items', docNum: d.docNum, docDate: d.docDate,
        requiredDate: d.requiredDate, requester: d.requesterName, cardName: d.cardName, total: d.total, currency: d.currency, comments: d.comments
      };
    });
}

async function decide(_t, ctx, code, approve, remarks) {
  const a = db.approvals.find((x) => x.code === Number(code));
  const me = USERS[ctx.userCode];
  const step = a && a.steps.find((s) => s.userId === me.internalKey && s.status === 'PENDING');
  if (!step) throw new SLError(403, -1, 'Usuário não é aprovador desta etapa');
  step.status = approve ? 'APPROVED' : 'REJECTED';
  step.remarks = remarks || '';
  step.date = today();
  a.status = step.status;
  return a;
}

async function finalizeDraft(_t, _c, draftEntry) {
  const a = approvalOf(Number(draftEntry));
  if (!a || a.status !== 'APPROVED') throw new SLError(400, -1, 'Rascunho não está aprovado');
  const d = db.drafts.find((x) => x.entry === Number(draftEntry));
  const user = Object.values(USERS).find((u) => u.userCode === d.requester) || {};
  const r = materialize(d.kind, user, d._payload);
  a.status = 'GENERATED';
  a.generatedEntry = r.entry;
  return { ok: true, entry: r.entry };
}

async function usersContact(_t, _c, ids) {
  return Object.values(USERS).filter((u) => (ids || []).some((k) => String(k) === String(u.internalKey) || k === u.userCode))
    .map((u) => ({ key: u.internalKey, code: u.userCode, name: u.userName, email: u.email }));
}

// ---------- Ciclo de compras (espelha sl-procure.js) ----------
async function vendorContact(_t, _c, cardCode) {
  const v = VENDORS.find((x) => x.cardCode === cardCode);
  if (!v) throw new SLError(404, -2028, `Fornecedor ${cardCode} não encontrado`);
  return { cardCode: v.cardCode, cardName: v.cardName, email: v.email, contact: '', phone: '' };
}

async function listDocs(_t, _c, user, kind, { status = 'open', cardCode } = {}) {
  const drafts = status === 'closed' ? [] : db.drafts
    .filter((d) => d.kind === kind && d.originatorId === user.internalKey && !['GENERATED', 'CANCELLED'].includes(approvalOf(d.entry).status))
    .map((d) => sum('draft', d, approvalOf(d.entry).status));
  const docs = db[kind].filter((d) => status === 'all' || (status === 'open' ? d.status === 'OPEN' : d.status === 'CLOSED'))
    .map((d) => sum('doc', d, d.status));
  return [...drafts, ...docs].filter((d) => !cardCode || d.cardCode === cardCode).sort((a, b) => b.entry - a.entry);
}

async function openRequestLines() {
  const out = [];
  db.pr.filter((d) => d.status === 'OPEN' && d.docType !== 'service').forEach((d) => d.lines.forEach((l) => {
    if (l.lineStatus !== 'bost_Open' || !(l.openQty > 0)) return;
    out.push({
      prEntry: d.entry, prDocNum: d.docNum, prLine: l.lineNum, docDate: d.docDate, requester: d.requesterName, branch: d.branch,
      itemCode: l.itemCode, itemName: l.itemName, uom: l.uom, quantity: l.openQty, requiredDate: l.requiredDate,
      warehouse: l.warehouse, costCenter: l.costCenter, freeText: l.freeText, estimatedPrice: l.unitPrice
    });
  }));
  return out.sort((a, b) => b.prEntry - a.prEntry);
}

async function createQuotation(_t, _c, p) {
  const user = { userCode: 'portal', userName: 'Portal', internalKey: 0 };
  const lines = p.lines.map((l) => {
    if (!l.prEntry) return { ...l, unitPrice: 0 };
    const pr = db.pr.find((d) => d.entry === Number(l.prEntry));
    const src = pr && pr.lines[Number(l.prLine)];
    if (!src) throw new SLError(400, -5002, `Linha ${l.prLine} da solicitação ${l.prEntry} não encontrada`);
    return { itemCode: src.itemCode, quantity: l.quantity, unitPrice: 0, requiredDate: l.requiredDate || src.requiredDate,
      warehouse: src.warehouse, costCenter: src.costCenter, baseType: 'pr', baseEntry: pr.entry, baseLine: src.lineNum };
  });
  const entry = ++db.seq.pq;
  db.pq.push(buildDoc('pq', user, { ...p, lines }, entry));
  return { kind: 'pq', source: 'doc', entry, docNum: entry, status: 'OPEN' };
}

async function writeQuotationAnswer(_t, _c, pqEntry, a) {
  const pq = db.pq.find((d) => d.entry === Number(pqEntry));
  if (!pq) throw new SLError(404, -2028, 'Oferta não encontrada');
  if (pq.status !== 'OPEN') throw new SLError(400, -5002, 'Oferta de compra fechada');
  a.lines.forEach((x) => {
    const l = pq.lines[Number(x.lineNum)];
    l.unitPrice = x.quoted ? Number(x.unitPrice) : 0;
    l.lineTotal = round2(l.unitPrice * l.quantity);
    l.shipDate = x.quoted ? x.deliveryDate || null : null;
    l.freeText = x.quoted ? (x.notes || '') : 'NÃO COTADO';
  });
  pq.total = round2(pq.lines.reduce((s, l) => s + l.lineTotal, 0));
  pq.dueDate = a.validUntil || pq.dueDate;
  pq.numAtCard = a.proposalRef || pq.numAtCard;
  pq.comments = [a.comments, a.paymentTerms && `Cond. pagto: ${a.paymentTerms}`, a.freight && `Frete: ${a.freight}`].filter(Boolean).join(' | ');
}

async function closeDoc(_t, _c, kind, entry) {
  const d = db[kind].find((x) => x.entry === Number(entry));
  if (d) { d.status = 'CLOSED'; d.lines.forEach((l) => { l.lineStatus = 'bost_Close'; }); }
}
async function cancelDoc(_t, _c, kind, entry) {
  const d = db[kind].find((x) => x.entry === Number(entry));
  if (d) d.status = 'CANCELLED';
}

async function createPurchaseOrder(_t, _c, user, p) {
  const lines = p.lines.map((l) => (l.baseEntry ? { ...l, baseType: l.baseKind || 'pq' } : l));
  return create('po', user, { ...p, lines, requiredDate: p.dueDate });
}

// Contratos guarda-chuva
function seedAgreements() {
  if (db.agreements.length) return;
  db.agreements.push({
    agreementNo: ++db.seq.agr, cardCode: 'F0002', cardName: vendorName('F0002'), startDate: addDays(-60), endDate: addDays(300),
    signingDate: addDays(-62), description: 'Fornecimento anual de EPIs', remarks: '', method: 'item', type: 'general', status: 'ACTIVE',
    lines: [
      { lineNum: 0, itemCode: 'MC-0100', itemName: itemOf('MC-0100').itemName, uom: 'PAR', plannedQty: 1000, usedQty: 200, unitPrice: 11.9, usedAmount: 2380 },
      { lineNum: 1, itemCode: 'MC-0101', itemName: itemOf('MC-0101').itemName, uom: 'UN', plannedQty: 300, usedQty: 0, unitPrice: 18.5, usedAmount: 0 }
    ]
  });
}
function agView(a, withLines) {
  const lines = a.lines.map((l) => ({
    ...l, openQty: Math.max(l.plannedQty - l.usedQty, 0),
    plannedAmount: l.plannedAmount || round2(l.plannedQty * (l.unitPrice || 0))
  }));
  const plannedAmount = round2(lines.reduce((s, l) => s + l.plannedAmount, 0));
  const usedAmount = round2(lines.reduce((s, l) => s + l.usedAmount, 0));
  const { lines: _l, ...head } = a;
  return { ...head, plannedAmount, usedAmount, consumption: plannedAmount ? Math.round((usedAmount / plannedAmount) * 1000) / 10 : null, lines: withLines ? lines : undefined };
}
async function listAgreements(_t, _c, { cardCode, activeOnly } = {}) {
  seedAgreements();
  return db.agreements
    .filter((a) => (!cardCode || a.cardCode === cardCode) && (!activeOnly || (a.status === 'ACTIVE' && a.endDate >= today())))
    .map((a) => agView(a, !!activeOnly)).sort((a, b) => b.agreementNo - a.agreementNo);
}
async function getAgreement(_t, _c, no) {
  seedAgreements();
  const a = db.agreements.find((x) => x.agreementNo === Number(no));
  if (!a) throw new SLError(404, -2028, 'Contrato não encontrado');
  return agView(a, true);
}
async function createAgreement(_t, _c, p) {
  seedAgreements();
  const monetary = p.method === 'monetary';
  const a = {
    agreementNo: ++db.seq.agr, cardCode: p.cardCode, cardName: vendorName(p.cardCode), startDate: p.startDate, endDate: p.endDate,
    signingDate: p.signingDate || null, description: p.description, remarks: p.remarks || '', method: monetary ? 'monetary' : 'item',
    type: 'general', status: p.status === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
    lines: p.lines.map((l, i) => ({
      lineNum: i, itemCode: l.itemCode || '', itemName: itemOf(l.itemCode).itemName || '', uom: itemOf(l.itemCode).uom || '',
      plannedQty: monetary ? 0 : Number(l.plannedQty), usedQty: 0, unitPrice: monetary ? null : Number(l.unitPrice),
      plannedAmount: monetary ? Number(l.plannedAmount) : undefined, usedAmount: 0
    }))
  };
  db.agreements.push(a);
  return { agreementNo: a.agreementNo };
}
async function setAgreementStatus(_t, _c, no, status) {
  const a = db.agreements.find((x) => x.agreementNo === Number(no));
  if (!a) throw new SLError(404, -2028, 'Contrato não encontrado');
  a.status = status;
}

module.exports = {
  usersContact,
  name: 'mock',
  searchItems, listCostCenters, listWarehouses, listBranches, searchVendors,
  createPurchaseRequest, listMyRequests, getRequest,
  listPendingApprovals, countPendingApprovals: async (t, c, u) => (await listPendingApprovals(t, c, u)).length,
  countMyRequests: async (t, c, u) => (await listMyRequests(t, c, u)).filter((x) => ['PENDING', 'APPROVED', 'OPEN'].includes(x.status)).length, decide, finalizeDraft,
  countOpen: async (_t, _c, kind) => db[kind].filter((d) => d.status === 'OPEN').length,
  vendorContact, listDocs, openRequestLines, createQuotation, writeQuotationAnswer, closeDoc, cancelDoc, createPurchaseOrder,
  listAgreements, getAgreement, createAgreement, setAgreementStatus,
  _db: db
};
