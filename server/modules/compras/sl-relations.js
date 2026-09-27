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
const OBJ_OF = Object.fromEntries(Object.entries(BY_OBJ).map(([o, k]) => [k, Number(o)]));

// Documentos que podem ser copiados a partir de cada tipo (destinos possíveis no B1)
const TARGETS = { pr: ['pq', 'po'], pq: ['po'], po: ['gr', 'ap'], gr: ['ap', 'rt'], ap: ['cm'], rt: [], cm: [] };
const noAny = new Set(); // empresas cujo SL não aceita any() em DocumentLines

/**
 * Busca TODOS os documentos copiados deste (a linha só guarda o último destino em TargetType):
 * filtro nas linhas do destino por BaseType/BaseEntry. Se o SL não aceitar any(), fica só o TargetType.
 */
async function copiesOf(tenant, ctx, kind, entry, head = {}) {
  if (noAny.has(tenant.id)) return copiesByScan(tenant, ctx, kind, entry, head);
  const out = [];
  for (const t of TARGETS[kind] || []) {
    try {
      const rows = await sl.getAll(tenant, ctx.cookie,
        `/${COLL[t]}?$select=DocEntry&$filter=DocumentLines/any(l: l/BaseType eq ${OBJ_OF[kind]} and l/BaseEntry eq ${Number(entry)})`, 50);
      rows.forEach((r) => out.push({ dir: 'down', kind: t, entry: Number(r.DocEntry) }));
    } catch (e) {
      if (e.status === 401) throw e;
      noAny.add(tenant.id);
      console.error(`[compras] mapa de relações: SL não aceita filtro nas linhas (${e.message}); usando varredura por fornecedor e data`);
      return copiesByScan(tenant, ctx, kind, entry, head);
    }
  }
  return out;
}

/**
 * Plano B (SL sem any()): lê os documentos de destino do mesmo fornecedor a partir da data do documento
 * e confere as linhas (BaseType/BaseEntry). Limitado a 100 por tipo de destino.
 */
async function copiesByScan(tenant, ctx, kind, entry, head) {
  const out = [];
  if (!head.date) return out;
  for (const t of TARGETS[kind] || []) {
    const f = [`DocDate ge '${head.date}'`];
    if (head.cardCode && kind !== 'pr') f.push(`CardCode eq '${String(head.cardCode).replace(/'/g, "''")}'`);
    try {
      const rows = await sl.getAll(tenant, ctx.cookie,
        `/${COLL[t]}?$select=DocEntry,DocumentLines&$filter=${encodeURIComponent(f.join(' and '))}&$orderby=DocEntry desc`, 100, 50);
      rows.forEach((r) => {
        if ((r.DocumentLines || []).some((l) => Number(l.BaseType) === OBJ_OF[kind] && Number(l.BaseEntry) === Number(entry))) {
          out.push({ dir: 'down', kind: t, entry: Number(r.DocEntry) });
        }
      });
    } catch (e) {
      if (e.status === 401) throw e;
      console.error(`[compras] mapa de relações: varredura de ${COLL[t]} falhou (${e.message})`);
    }
  }
  return out;
}

function linksOf(lines) {
  const links = new Map();
  const agreements = new Set();
  (lines || []).forEach((l) => {
    const up = BY_OBJ[Number(l.BaseType)];
    if (up && Number(l.BaseEntry) > 0) links.set(`up:${up}:${l.BaseEntry}`, { dir: 'up', kind: up, entry: Number(l.BaseEntry) });
    const down = BY_OBJ[Number(l.TargetType)];
    const te = Number(l.TargetAbsEntry) || Number(l.TargetEntry) || 0; // o nome muda entre versões do SL
    if (down && Number(te) > 0) links.set(`down:${down}:${te}`, { dir: 'down', kind: down, entry: Number(te) });
    if (Number(l.AgreementNo) > 0) agreements.add(Number(l.AgreementNo));
  });
  return { links: [...links.values()], agreements: [...agreements] };
}

async function docLinks(tenant, ctx, kind, entry) {
  const d = await sl.request(tenant, ctx.cookie, 'GET', `/${COLL[kind]}(${Number(entry)})`);
  const own = linksOf(d.DocumentLines);
  const seen = new Set(own.links.map((l) => `${l.dir}:${l.kind}:${l.entry}`));
  (await copiesOf(tenant, ctx, kind, entry, { cardCode: d.CardCode, date: d10(d.DocDate) })).forEach((l) => {
    if (!seen.has(`${l.dir}:${l.kind}:${l.entry}`)) own.links.push(l);
  });
  // Diagnóstico: documento atendido sem nenhum destino encontrado
  if (base.mapDocStatus(d) === 'CLOSED' && (TARGETS[kind] || []).length && !own.links.some((l) => l.dir === 'down')) {
    const l0 = (d.DocumentLines || [])[0] || {};
    console.error(`[compras] mapa de relações: ${COLL[kind]}(${entry}) atendido sem destino. Campos de destino na linha: ` +
      JSON.stringify(Object.fromEntries(Object.entries(l0).filter(([k2]) => /target|trget/i.test(k2)))));
  }
  return {
    node: {
      kind, source: 'doc', entry: d.DocEntry, docNum: d.DocNum, date: d10(d.DocDate), total: base.docTotal(d),
      status: base.mapDocStatus(d), cardCode: d.CardCode || '', cardName: d.CardName || d.RequesterName || ''
    },
    ...own
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

module.exports = { docLinks, draftLinks, linksOf, copiesOf, BY_OBJ, COLL };
