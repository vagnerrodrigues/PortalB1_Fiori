'use strict';
/**
 * Adapter real (Service Layer) do ciclo de compras além da solicitação:
 *  - Oferta de compra (OPQT/PQT1)   -> uma por fornecedor na cotação online
 *  - Pedido de compra (OPOR/POR1)   -> manual, a partir da oferta vencedora ou consumindo contrato
 *  - Contrato guarda-chuva (OOAT/OAT1) -> BlanketAgreements
 * Tudo em campos nativos. Vínculos: BaseType/BaseEntry/BaseLine (solicitação -> oferta -> pedido)
 * e AgreementNo/AgreementRowNumber (linha do pedido -> contrato).
 */
const sl = require('../../core/slClient');
const base = require('./sl');

const { KINDS } = base;
const q = (s) => String(s || '').replace(/'/g, "''");
const enc = encodeURIComponent;
const today = () => new Date().toISOString().slice(0, 10);
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

// ---------- Fornecedor ----------
async function vendorContact(tenant, ctx, cardCode) {
  const b = await sl.request(tenant, ctx.cookie, 'GET',
    `/BusinessPartners('${enc(q(cardCode))}')?$select=CardCode,CardName,EmailAddress,ContactPerson,Phone1`);
  return { cardCode: b.CardCode, cardName: b.CardName, email: b.EmailAddress || '', contact: b.ContactPerson || '', phone: b.Phone1 || '' };
}

// ---------- Listas ----------
const LIST_SEL = '$select=DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,DocumentStatus,Cancelled,Comments,NumAtCard,BPL_IDAssignedToInvoice';

/** Documentos (pq/po) + rascunhos meus aguardando aprovação. */
async function listDocs(tenant, ctx, user, kind, { status = 'open', cardCode } = {}) {
  const k = KINDS[kind];
  const f = [];
  if (status === 'open') f.push(`DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`);
  if (status === 'closed') f.push(`DocumentStatus eq 'bost_Close'`);
  if (cardCode) f.push(`CardCode eq '${enc(q(cardCode))}'`);
  const filter = f.length ? `&$filter=${f.join(' and ')}` : '';
  const [docs, approvals] = await Promise.all([
    sl.getAll(tenant, ctx.cookie, `/${k.coll}?${LIST_SEL}${filter}&$orderby=DocEntry desc`, 200),
    status === 'closed' ? new Map() : base.approvalsForDrafts(tenant, ctx, ` and OriginatorID eq ${Number(user.internalKey)}`, [k.obj])
  ]);
  const out = [];
  for (const [draftEntry, a] of approvals) {
    const st = base.mapApprovalStatus(a.Status);
    if (st === 'GENERATED' || st === 'CANCELLED') continue;
    const d = (await base.readDraft(tenant, ctx, draftEntry, false)) || { DocEntry: draftEntry, DocDate: a.CreationDate };
    if (cardCode && d.CardCode && d.CardCode !== cardCode) continue;
    out.push({ ...base.summary('draft', d, st, a), kind });
  }
  docs.forEach((d) => out.push({ ...base.summary('doc', d, base.mapDocStatus(d)), kind, numAtCard: d.NumAtCard || '' }));
  return out;
}

/** Linhas em aberto de solicitações de compra (insumo da cotação). */
async function openRequestLines(tenant, ctx, { branch } = {}) {
  const f = [`DocumentStatus eq 'bost_Open'`, `Cancelled eq 'tNO'`, `DocType eq 'dDocument_Items'`];
  if (branch) f.push(`BPL_IDAssignedToInvoice eq ${Number(branch)}`);
  const docs = await sl.getAll(tenant, ctx.cookie,
    `/PurchaseRequests?$select=DocEntry,DocNum,DocDate,RequriedDate,Requester,RequesterName,BPL_IDAssignedToInvoice,Comments,DocumentLines&$filter=${f.join(' and ')}&$orderby=DocEntry desc`, 200);
  const out = [];
  docs.forEach((d) => (d.DocumentLines || []).forEach((l) => {
    if (l.LineStatus && l.LineStatus !== 'bost_Open') return;
    const open = l.RemainingOpenQuantity ?? l.Quantity;
    if (!(Number(open) > 0)) return;
    out.push({
      prEntry: d.DocEntry, prDocNum: d.DocNum, prLine: l.LineNum, docDate: d.DocDate, requester: d.RequesterName || d.Requester,
      branch: d.BPL_IDAssignedToInvoice ?? null, itemCode: l.ItemCode, itemName: l.ItemDescription, uom: l.UoMCode || l.MeasureUnit || '',
      quantity: Number(open), requiredDate: d10(l.RequiredDate || d.RequriedDate), warehouse: l.WarehouseCode || '',
      costCenter: l.CostingCode || '', freeText: l.FreeText || '', estimatedPrice: l.UnitPrice ?? null
    });
  }));
  return out;
}

// ---------- Oferta de compra (cotação) ----------
/**
 * Cria a Oferta de compra de um fornecedor. Linhas vindas de solicitação usam BaseType/BaseEntry/BaseLine
 * (vínculo nativo OPRQ -> OPQT). Preço 0 até o fornecedor responder.
 */
async function createQuotation(tenant, ctx, p) {
  const series = p.branch ? await base.seriesForBranch(tenant, ctx, Number(p.branch), 'pq') : undefined;
  const body = {
    CardCode: p.cardCode,
    DocDate: today(),
    RequriedDate: p.requiredDate,
    DocDueDate: p.validUntil, // na oferta de compra, "Válido até"
    BPL_IDAssignedToInvoice: p.branch ? Number(p.branch) : undefined,
    Series: series,
    Comments: String(p.comments || '').slice(0, 254) || undefined,
    DocumentLines: p.lines.map((l) => (l.prEntry ? {
      BaseType: Number(KINDS.pr.obj), BaseEntry: Number(l.prEntry), BaseLine: Number(l.prLine),
      Quantity: Number(l.quantity), UnitPrice: 0, RequiredDate: l.requiredDate || undefined
    } : {
      ItemCode: l.itemCode, Quantity: Number(l.quantity), UnitPrice: 0, RequiredDate: l.requiredDate || p.requiredDate,
      WarehouseCode: l.warehouse || undefined, CostingCode: l.costCenter || undefined, FreeText: l.freeText || undefined
    }))
  };
  return base.createDocument(tenant, ctx, 'pq', body, (d) => d.CardCode === p.cardCode);
}

/** Grava a resposta do fornecedor na Oferta de compra (preço, entrega, validade, condições). */
async function writeQuotationAnswer(tenant, ctx, pqEntry, a) {
  const terms = [
    a.paymentTerms && `Cond. pagto: ${a.paymentTerms}`,
    a.freight && `Frete: ${a.freight}`,
    a.notes && `Obs.: ${a.notes}`
  ].filter(Boolean).join(' | ');
  await sl.request(tenant, ctx.cookie, 'PATCH', `/PurchaseQuotations(${Number(pqEntry)})`, {
    DocDueDate: a.validUntil || undefined,
    NumAtCard: a.proposalRef ? String(a.proposalRef).slice(0, 100) : undefined,
    Comments: [a.comments, terms].filter(Boolean).join(' — ').slice(0, 254) || undefined,
    DocumentLines: a.lines.map((l) => ({
      LineNum: Number(l.lineNum),
      UnitPrice: l.quoted ? Number(l.unitPrice) : 0,
      ShipDate: l.quoted && l.deliveryDate ? l.deliveryDate : undefined,
      FreeText: (l.quoted ? (l.notes || '') : `NÃO COTADO${l.notes ? ` - ${l.notes}` : ''}`).slice(0, 100) || undefined
    }))
  });
}

async function closeDoc(tenant, ctx, kind, entry) {
  await sl.request(tenant, ctx.cookie, 'POST', `/${KINDS[kind].coll}(${Number(entry)})/Close`);
}
async function cancelDoc(tenant, ctx, kind, entry) {
  await sl.request(tenant, ctx.cookie, 'POST', `/${KINDS[kind].coll}(${Number(entry)})/Cancel`);
}

// ---------- Pedido de compra ----------
/**
 * Pedido de compra. Linha com baseEntry = cópia nativa da oferta vencedora (preço/condições vêm da oferta).
 * Linha com agreementNo = consumo do contrato guarda-chuva.
 */
async function createPurchaseOrder(tenant, ctx, user, p) {
  const series = p.branch ? await base.seriesForBranch(tenant, ctx, Number(p.branch), 'po') : undefined;
  const body = {
    CardCode: p.cardCode,
    DocDate: today(),
    DocDueDate: p.dueDate,
    BPL_IDAssignedToInvoice: p.branch ? Number(p.branch) : undefined,
    Series: series,
    NumAtCard: p.numAtCard || undefined,
    Comments: String(p.comments || '').slice(0, 254) || undefined,
    AttachmentEntry: p.attachmentEntry || undefined,
    DocumentLines: p.lines.map((l) => (l.baseEntry ? {
      BaseType: Number(KINDS[l.baseKind || 'pq'].obj), BaseEntry: Number(l.baseEntry), BaseLine: Number(l.baseLine),
      Quantity: l.quantity ? Number(l.quantity) : undefined, ShipDate: l.shipDate || undefined
    } : {
      ItemCode: l.itemCode,
      Quantity: Number(l.quantity),
      UnitPrice: l.unitPrice !== undefined && l.unitPrice !== null && l.unitPrice !== '' ? Number(l.unitPrice) : undefined,
      ShipDate: l.shipDate || p.dueDate,
      WarehouseCode: l.warehouse || undefined,
      CostingCode: l.costCenter || undefined,
      FreeText: l.freeText || undefined,
      AgreementNo: l.agreementNo ? Number(l.agreementNo) : undefined,
      AgreementRowNumber: l.agreementNo && l.agreementLine !== undefined && l.agreementLine !== null ? Number(l.agreementLine) : undefined
    }))
  };
  return base.createDocument(tenant, ctx, 'po', body, (d) => d.CardCode === p.cardCode);
}

// ---------- Contrato guarda-chuva (BlanketAgreements / OOAT) ----------
const AG_STATUS = { asApproved: 'ACTIVE', asOnHold: 'ONHOLD', asDraft: 'DRAFT', asTerminated: 'TERMINATED', asCancelled: 'CANCELLED' };
const AG_STATUS_B1 = Object.fromEntries(Object.entries(AG_STATUS).map(([k, v]) => [v, k]));

function mapAgreement(a, withLines) {
  const lines = (a.BlanketAgreements_ItemsLines || []).map((l) => {
    const planned = Number(l.PlannedQuantity) || 0;
    const used = Number(l.CumulativeQuantity) || 0;
    const plannedAmount = Number(l.PlannedAmountLC) || (planned * (Number(l.UnitPrice) || 0));
    const usedAmount = Number(l.CumulativeAmountLC) || 0;
    return {
      lineNum: l.AgreementRowNumber ?? l.LineNum ?? null,
      itemCode: l.ItemNo || '', itemName: l.ItemDescription || '', uom: l.UoMCode || l.InventoryUoM || '',
      plannedQty: planned, usedQty: used, openQty: Math.max(planned - used, 0),
      unitPrice: l.UnitPrice ?? null, plannedAmount, usedAmount
    };
  });
  const plannedAmount = lines.reduce((s, l) => s + l.plannedAmount, 0);
  const usedAmount = lines.reduce((s, l) => s + l.usedAmount, 0);
  return {
    agreementNo: a.AgreementNo,
    cardCode: a.BPCode, cardName: a.BPName,
    startDate: d10(a.StartDate), endDate: d10(a.EndDate), signingDate: d10(a.SigningDate),
    description: a.Description || '', remarks: a.Remarks || '',
    method: a.AgreementMethod === 'amMonetary' ? 'monetary' : 'item',
    type: a.AgreementType === 'atSpecific' ? 'specific' : 'general',
    status: AG_STATUS[a.Status] || a.Status,
    plannedAmount, usedAmount,
    consumption: plannedAmount ? Math.round((usedAmount / plannedAmount) * 1000) / 10 : null,
    lines: withLines ? lines : undefined
  };
}

async function listAgreements(tenant, ctx, { cardCode, activeOnly } = {}) {
  const f = [];
  if (cardCode) f.push(`BPCode eq '${enc(q(cardCode))}'`);
  if (activeOnly) f.push(`Status eq 'asApproved' and EndDate ge '${today()}'`);
  const filter = f.length ? `&$filter=${f.join(' and ')}` : '';
  const rows = await sl.getAll(tenant, ctx.cookie, `/BlanketAgreements?$orderby=AgreementNo desc${filter}`, 300);
  return rows.map((a) => mapAgreement(a, !!activeOnly));
}

async function getAgreement(tenant, ctx, no) {
  return mapAgreement(await sl.request(tenant, ctx.cookie, 'GET', `/BlanketAgreements(${Number(no)})`), true);
}

async function createAgreement(tenant, ctx, p) {
  const monetary = p.method === 'monetary';
  const r = await sl.request(tenant, ctx.cookie, 'POST', '/BlanketAgreements', {
    BPCode: p.cardCode,
    StartDate: p.startDate,
    EndDate: p.endDate,
    SigningDate: p.signingDate || undefined,
    Description: String(p.description || '').slice(0, 254),
    Remarks: p.remarks || undefined,
    AgreementMethod: monetary ? 'amMonetary' : 'amItem',
    AgreementType: 'atGeneral',
    Status: p.status === 'DRAFT' ? 'asDraft' : 'asApproved',
    BlanketAgreements_ItemsLines: p.lines.map((l) => (monetary ? {
      ItemNo: l.itemCode || undefined, PlannedAmountLC: Number(l.plannedAmount)
    } : {
      ItemNo: l.itemCode, PlannedQuantity: Number(l.plannedQty), UnitPrice: Number(l.unitPrice)
    }))
  });
  return { agreementNo: r.AgreementNo };
}

async function setAgreementStatus(tenant, ctx, no, status) {
  await sl.request(tenant, ctx.cookie, 'PATCH', `/BlanketAgreements(${Number(no)})`, { Status: AG_STATUS_B1[status] });
}

module.exports = {
  vendorContact, listDocs, openRequestLines,
  createQuotation, writeQuotationAnswer, closeDoc, cancelDoc,
  createPurchaseOrder,
  listAgreements, getAgreement, createAgreement, setAgreementStatus
};
