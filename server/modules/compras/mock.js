'use strict';
/**
 * Adapter MOCK: simula o comportamento do SAP B1 (solicitação, rascunho, procedimento de autorização)
 * para demo comercial e desenvolvimento do front sem servidor B1. Mesma interface do serviceLayer.js.
 *
 * Usuários demo: ver core/mockUsers.js. O aprovador da etapa é o usuário "aprovador".
 * Regra demo: total estimado > R$ 1.000,00 dispara aprovação (simula um OWTM "DocTotal > 1000").
 */
const { SLError } = require('../../core/slClient');

const today = () => new Date().toISOString().slice(0, 10);
const USERS = require('../../core/mockUsers');
const LIMIT = 1000;

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
  { cardCode: 'F0001', cardName: 'Metalúrgica Paulista Ltda' },
  { cardCode: 'F0002', cardName: 'EPI Brasil Distribuidora' },
  { cardCode: 'F0003', cardName: 'TechStore Informática' }
];

const db = { docs: [], drafts: [], approvals: [], seq: { doc: 100, draft: 500, appr: 1 } };

const like = (s, t) => String(s).toLowerCase().includes(String(t || '').toLowerCase());
const searchItems = async (_t, _c, term) => ITEMS.filter((i) => !term || like(i.itemCode, term) || like(i.itemName, term));
const listCostCenters = async () => COST_CENTERS;
const listWarehouses = async () => WAREHOUSES;
const listBranches = async () => []; // demo sem filiais (campo oculto)
const searchVendors = async (_t, _c, term) => VENDORS.filter((v) => !term || like(v.cardCode, term) || like(v.cardName, term));

function buildDoc(user, p, entry, docNum) {
  const service = p.docType === 'service';
  const lines = p.lines.map((l, i) => {
    if (service) {
      const amount = Number(l.amount || 0);
      return {
        lineNum: i, itemCode: '', itemName: l.description, uom: '', quantity: 1, unitPrice: amount, lineTotal: amount,
        requiredDate: l.date || p.requiredDate, costCenter: l.costCenter || '', warehouse: '', vendor: '',
        freeText: l.freeText || '', accountCode: l.accountCode, lineStatus: 'bost_Open'
      };
    }
    const item = ITEMS.find((x) => x.itemCode === l.itemCode) || {};
    const unitPrice = Number(l.unitPrice || 0);
    return {
      lineNum: i, itemCode: l.itemCode, itemName: item.itemName || l.itemCode, uom: item.uom || '',
      quantity: Number(l.quantity), unitPrice, lineTotal: +(unitPrice * Number(l.quantity)).toFixed(2),
      requiredDate: l.requiredDate || p.requiredDate, costCenter: l.costCenter || '', warehouse: l.warehouse || '',
      vendor: l.vendor || '', freeText: l.freeText || '', lineStatus: 'bost_Open'
    };
  });
  return {
    entry, docNum, docDate: today(), requiredDate: p.requiredDate, requester: user.userCode,
    requesterName: user.userName, originatorId: user.internalKey, comments: p.comments || '',
    currency: 'R$', total: +lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2), lines, status: 'OPEN',
    docType: service ? 'service' : 'items', attachmentEntry: p.attachmentEntry || null
  };
}

async function createPurchaseRequest(_t, _c, user, p) {
  const probe = buildDoc(user, p, 0, 0);
  if (probe.total > LIMIT) {
    const entry = ++db.seq.draft;
    const draft = { ...buildDoc(user, p, entry, entry), status: 'PENDING' };
    db.drafts.push(draft);
    db.approvals.push({
      code: db.seq.appr++, status: 'PENDING', currentStage: 1, originatorId: user.internalKey,
      createdAt: today(), remarks: `Total ${draft.total} acima de ${LIMIT}`, draftEntry: entry,
      steps: [{ stage: 1, userId: USERS.aprovador.internalKey, status: 'PENDING', remarks: '', date: null }]
    });
    return { source: 'draft', entry, docNum: entry, status: 'PENDING' };
  }
  const entry = ++db.seq.doc;
  db.docs.push(buildDoc(user, p, entry, entry));
  return { source: 'doc', entry, docNum: entry, status: 'OPEN' };
}

const approvalOf = (draftEntry) => db.approvals.find((a) => a.draftEntry === draftEntry);
const sum = (source, d, status) => ({
  source, docType: d.docType || 'items', entry: d.entry, docNum: d.docNum, docDate: d.docDate, requiredDate: d.requiredDate, total: d.total,
  currency: d.currency, comments: d.comments, status, approvalCode: source === 'draft' ? approvalOf(d.entry).code : null
});

async function listMyRequests(_t, _c, user, kind) {
  const drafts = db.drafts.filter((d) => d.requester === user.userCode)
    .map((d) => sum('draft', d, approvalOf(d.entry).status)).filter((d) => d.status !== 'GENERATED');
  const docs = db.docs.filter((d) => d.requester === user.userCode).map((d) => sum('doc', d, d.status));
  return [...drafts, ...docs].filter((x) => !kind || x.docType === kind).sort((a, b) => b.entry - a.entry);
}

async function getRequest(_t, _c, source, entry) {
  const list = source === 'draft' ? db.drafts : db.docs;
  const d = list.find((x) => x.entry === Number(entry));
  if (!d) throw new SLError(404, -2028, 'Documento não encontrado');
  const approval = source === 'draft' ? approvalOf(d.entry) : null;
  const generated = approval && approval.generatedEntry ? { entry: approval.generatedEntry, docNum: approval.generatedEntry } : null;
  return { source, ...d, status: approval ? approval.status : d.status, approval, generated };
}

async function listPendingApprovals(_t, _c, user) {
  return db.approvals
    .filter((a) => a.status === 'PENDING' && a.steps.some((s) => s.userId === user.internalKey && s.status === 'PENDING' && s.stage === a.currentStage))
    .map((a) => {
      const d = db.drafts.find((x) => x.entry === a.draftEntry);
      return {
        approvalCode: a.code, draftEntry: a.draftEntry, docType: d.docType || 'items', docNum: d.docNum, docDate: d.docDate,
        requiredDate: d.requiredDate, requester: d.requesterName, total: d.total, currency: d.currency, comments: d.comments
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
  const entry = ++db.seq.doc;
  db.docs.push({ ...d, entry, docNum: entry, status: 'OPEN' });
  a.status = 'GENERATED';
  a.generatedEntry = entry;
  return { ok: true, entry };
}

module.exports = {
  name: 'mock',
  searchItems, listCostCenters, listWarehouses, listBranches, searchVendors,
  createPurchaseRequest, listMyRequests, getRequest,
  listPendingApprovals, countPendingApprovals: async (t, c, u) => (await listPendingApprovals(t, c, u)).length,
  countMyRequests: async (t, c, u) => (await listMyRequests(t, c, u)).filter((x) => ['PENDING', 'APPROVED', 'OPEN'].includes(x.status)).length, decide, finalizeDraft,
  _db: db
};
