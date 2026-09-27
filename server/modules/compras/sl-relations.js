'use strict';
/**
 * Vínculos entre documentos de compras no SAP B1 (para o Mapa de relações), só com campos nativos:
 *  - para trás:  linha.BaseType / BaseEntry        (de onde a linha foi copiada)
 *  - para frente: linha.TargetType / TargetAbsEntry (para onde a linha foi copiada por último)
 *  - contrato:   linha.AgreementNo
 */
const sl = require('../../core/slClient');
const base = require('./sl');

const BY_OBJ = { 1470000113: 'pr', 540000006: 'pq', 22: 'po', 20: 'gr', 18: 'ap', 21: 'rt', 19: 'cm' };
const COLL = {
  pr: 'PurchaseRequests', pq: 'PurchaseQuotations', po: 'PurchaseOrders',
  gr: 'PurchaseDeliveryNotes', ap: 'PurchaseInvoices', rt: 'PurchaseReturns', cm: 'PurchaseCreditNotes'
};
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

function linksOf(lines) {
  const links = new Map();
  const agreements = new Set();
  (lines || []).forEach((l) => {
    const up = BY_OBJ[Number(l.BaseType)];
    if (up && Number(l.BaseEntry) > 0) links.set(`up:${up}:${l.BaseEntry}`, { dir: 'up', kind: up, entry: Number(l.BaseEntry) });
    const down = BY_OBJ[Number(l.TargetType)];
    const te = l.TargetAbsEntry ?? l.TargetEntry;
    if (down && Number(te) > 0) links.set(`down:${down}:${te}`, { dir: 'down', kind: down, entry: Number(te) });
    if (Number(l.AgreementNo) > 0) agreements.add(Number(l.AgreementNo));
  });
  return { links: [...links.values()], agreements: [...agreements] };
}

async function docLinks(tenant, ctx, kind, entry) {
  const d = await sl.request(tenant, ctx.cookie, 'GET', `/${COLL[kind]}(${Number(entry)})`);
  return {
    node: {
      kind, source: 'doc', entry: d.DocEntry, docNum: d.DocNum, date: d10(d.DocDate), total: base.docTotal(d),
      status: base.mapDocStatus(d), cardCode: d.CardCode || '', cardName: d.CardName || d.RequesterName || ''
    },
    ...linksOf(d.DocumentLines)
  };
}

async function draftLinks(tenant, ctx, draftEntry) {
  const doc = await base.getRequest(tenant, ctx, 'draft', Number(draftEntry));
  const raw = await base.readDraft(tenant, ctx, draftEntry, true).catch(() => null);
  const out = linksOf(raw && raw.DocumentLines);
  if (doc.generated && doc.generated.entry) out.links.push({ dir: 'down', kind: doc.kind, entry: Number(doc.generated.entry), generated: true });
  return {
    node: {
      kind: doc.kind, source: 'draft', entry: doc.entry, docNum: doc.entry, date: d10(doc.docDate), total: doc.total,
      status: doc.status, cardCode: doc.cardCode || '', cardName: doc.cardName || doc.requesterName || ''
    },
    ...out
  };
}

module.exports = { docLinks, draftLinks, linksOf, BY_OBJ, COLL };
