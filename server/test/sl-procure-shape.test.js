'use strict';
/** Corpo enviado ao Service Layer para oferta, pedido e contrato (sem SAP): campos nativos e vínculos de base. */
const assert = require('assert');
const sl = require('../core/slClient');

const calls = [];
let draftsAfter = [];
sl.getAll = async () => [];
sl.request = async (t, c, method, p, body) => {
  calls.push({ method, p, body });
  if (p.startsWith('/Drafts?$select=DocEntry&')) return { value: [{ DocEntry: 100 }] };
  if (p.startsWith('/Drafts?')) return { value: draftsAfter };
  if (method === 'POST' && p === '/PurchaseQuotations') return { DocEntry: 11, DocNum: 5011 };
  if (method === 'POST' && p === '/PurchaseOrders') {
    const e = new sl.SLError(400, -2028, 'No matching records found (ODBC -2028)'); // aprovação disparada
    throw e;
  }
  if (method === 'POST' && p === '/BlanketAgreements') return { AgreementNo: 7 };
  if (method === 'POST' && p === '/PurchaseDeliveryNotes') return { DocEntry: 55, DocNum: 8055 };
  return {};
};
const proc = require('../modules/compras/sl-procure');

(async () => {
  const pq = await proc.createQuotation({ id: 't' }, {}, {
    cardCode: 'F1', requiredDate: '2026-10-10', validUntil: '2026-10-01', comments: 'Cotação online nº 3',
    lines: [{ prEntry: 40, prLine: 2, quantity: 5 }, { itemCode: 'A1', quantity: 2, warehouse: '01' }]
  });
  assert.deepStrictEqual(pq, { kind: 'pq', source: 'doc', entry: 11, docNum: 5011, status: 'OPEN' });
  const pqBody = calls.find((c) => c.p === '/PurchaseQuotations').body;
  assert.strictEqual(pqBody.CardCode, 'F1');
  assert.strictEqual(pqBody.DocDueDate, '2026-10-01');
  assert.deepStrictEqual(pqBody.DocumentLines[0], { BaseType: 1470000113, BaseEntry: 40, BaseLine: 2, Quantity: 5, UnitPrice: 0, RequiredDate: undefined });
  assert.strictEqual(pqBody.DocumentLines[1].ItemCode, 'A1');
  console.log('  ✔ oferta de compra com vínculo nativo à solicitação (BaseType 1470000113)');

  await proc.writeQuotationAnswer({}, {}, 11, {
    validUntil: '2026-10-20', proposalRef: 'P-9', paymentTerms: '28 ddl', freight: 'CIF', comments: 'Cotação online nº 3',
    lines: [{ lineNum: 0, quoted: true, unitPrice: 9.5, deliveryDate: '2026-10-05' }, { lineNum: 1, quoted: false }]
  });
  const patch = calls.find((c) => c.method === 'PATCH' && c.p === '/PurchaseQuotations(11)').body;
  assert.strictEqual(patch.NumAtCard, 'P-9');
  assert.ok(patch.Comments.includes('Cond. pagto: 28 ddl') && patch.Comments.includes('Frete: CIF'));
  assert.deepStrictEqual(patch.DocumentLines[1], { LineNum: 1, UnitPrice: 0, ShipDate: undefined, FreeText: 'NÃO COTADO' });
  console.log('  ✔ resposta do fornecedor gravada na oferta (preço, entrega, validade, Nº ref. do PN)');

  draftsAfter = [{ DocEntry: 101, DocNum: 88, CardCode: 'F1' }];
  const po = await proc.createPurchaseOrder({ id: 't' }, {}, { userCode: 'u' }, {
    cardCode: 'F1', dueDate: '2026-10-12',
    lines: [{ baseKind: 'pq', baseEntry: 11, baseLine: 0, quantity: 5 }, { itemCode: 'B2', quantity: 1, unitPrice: 10, agreementNo: 7, agreementLine: 0 }]
  });
  assert.deepStrictEqual(po, { kind: 'po', source: 'draft', entry: 101, docNum: 88, status: 'PENDING' });
  const poBody = calls.find((c) => c.p === '/PurchaseOrders').body;
  assert.deepStrictEqual(poBody.DocumentLines[0], { BaseType: 540000006, BaseEntry: 11, BaseLine: 0, Quantity: 5, ShipDate: undefined });
  assert.strictEqual(poBody.DocumentLines[1].AgreementNo, 7);
  assert.strictEqual(poBody.DocumentLines[1].AgreementRowNumber, 0);
  assert.ok(calls.some((c) => c.p.includes("DocObjectCode eq 'oPurchaseOrders'")));
  console.log('  ✔ pedido copiado da oferta (BaseType 540000006) e retido para aprovação detectado como rascunho');

  const ag = await proc.createAgreement({}, {}, {
    cardCode: 'F1', startDate: '2026-10-01', endDate: '2027-09-30', description: 'Anual', method: 'item',
    lines: [{ itemCode: 'A1', plannedQty: 100, unitPrice: 3.5 }]
  });
  assert.deepStrictEqual(ag, { agreementNo: 7 });
  const agBody = calls.find((c) => c.p === '/BlanketAgreements').body;
  assert.strictEqual(agBody.AgreementMethod, 'amItem');
  assert.strictEqual(agBody.Status, 'asApproved');
  assert.deepStrictEqual(agBody.BlanketAgreements_ItemsLines[0], { ItemNo: 'A1', PlannedQuantity: 100, UnitPrice: 3.5 });
  console.log('  ✔ contrato guarda-chuva (BlanketAgreements) por item');

  const gr = await proc.createGoodsReceipt({ id: 't' }, {}, { userCode: 'u' }, {
    poEntry: 101, cardCode: 'F1', date: '2026-09-27', numAtCard: 'NF 1234',
    lines: [{ lineNum: 0, quantity: 12, warehouse: '02' }, { lineNum: 2, quantity: 5, batch: 'L1', expiry: '2027-09-01' }]
  });
  assert.deepStrictEqual(gr, { kind: 'gr', source: 'doc', entry: 55, docNum: 8055, status: 'OPEN' });
  const grBody = calls.find((c) => c.p === '/PurchaseDeliveryNotes').body;
  assert.strictEqual(grBody.NumAtCard, 'NF 1234');
  assert.deepStrictEqual(grBody.DocumentLines[0], { BaseType: 22, BaseEntry: 101, BaseLine: 0, Quantity: 12, WarehouseCode: '02', BatchNumbers: undefined });
  assert.deepStrictEqual(grBody.DocumentLines[1].BatchNumbers, [{ BatchNumber: 'L1', Quantity: 5, ExpiryDate: '2027-09-01' }]);
  console.log('  ✔ recebimento de mercadorias copiado do pedido (BaseType 22) com lote e validade');

  const { linksOf } = require('../modules/compras/sl-relations');
  const lk = linksOf([
    { BaseType: 540000006, BaseEntry: 11, TargetType: 20, TargetAbsEntry: 90, AgreementNo: 7 },
    { BaseType: -1, BaseEntry: null, TargetType: -1, TargetAbsEntry: null },
    { BaseType: 540000006, BaseEntry: 11, TargetType: 18, TargetAbsEntry: 95 }
  ]);
  assert.deepStrictEqual(lk.links, [
    { dir: 'up', kind: 'pq', entry: 11 }, { dir: 'down', kind: 'gr', entry: 90 }, { dir: 'down', kind: 'ap', entry: 95 }
  ]);
  assert.deepStrictEqual(lk.agreements, [7]);
  // versões do SL em que o destino vem em TargetEntry (TargetAbsEntry = 0)
  assert.deepStrictEqual(linksOf([{ BaseType: -1, TargetType: 20, TargetAbsEntry: 0, TargetEntry: 91 }]).links, [{ dir: 'down', kind: 'gr', entry: 91 }]);

  // SL sem any(): varre recebimentos do fornecedor a partir da data do pedido
  const rel = require('../modules/compras/sl-relations');
  const origGetAll = sl.getAll;
  sl.getAll = async (t, c, p) => {
    if (p.includes('/any(')) throw new sl.SLError(400, -1, 'Invalid filter');
    if (p.startsWith('/PurchaseDeliveryNotes')) return [{ DocEntry: 2, DocumentLines: [{ BaseType: 22, BaseEntry: 13317 }] }, { DocEntry: 3, DocumentLines: [{ BaseType: 22, BaseEntry: 999 }] }];
    return [];
  };
  const found = await rel.copiesOf({ id: 'scan' }, {}, 'po', 13317, { cardCode: 'F09670', date: '2026-09-27' });
  assert.deepStrictEqual(found, [{ dir: 'down', kind: 'gr', entry: 2 }]);
  sl.getAll = origGetAll;
  console.log('  ✔ mapa de relações sem any(): encontra o recebimento pela varredura do fornecedor');
  console.log('  ✔ vínculos do mapa de relações (BaseType/BaseEntry, TargetType/TargetAbsEntry, AgreementNo)');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
