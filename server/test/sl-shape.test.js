'use strict';
/** Regressão com o formato REAL do OWDD devolvido pelo SL (B1 10.0, SL 1000321). Não precisa de SAP. */
const assert = require('assert');
const sl = require('../core/slClient');

const rec = {
  Code: 78053, ApprovalTemplatesID: 5, ObjectType: '1470000113', IsDraft: 'Y', ObjectEntry: null,
  Status: 'arsPending', CurrentStage: 663, OriginatorID: 1, CreationDate: '2026-09-25T00:00:00Z',
  DraftEntry: 80651, DraftType: '112',
  ApprovalRequestLines: [{ StageCode: 663, UserID: 82, Status: 'ardPending' }]
};
let current = rec;
sl.getAll = async () => [current];
let sqlRows = null; // null = SL recusa OWDD/WDD1 em SQLQueries (usa OData)
let draftReads = 0;
sl.request = async (t, c, m, p) => {
  if (p.startsWith('/Drafts(')) draftReads++;
  if (p.startsWith('/SQLQueries')) {
    if (!sqlRows) { const e = new sl.SLError(400, -1, "Table 'OWDD' not accessible"); throw e; }
    return p.endsWith('/List') ? { value: sqlRows } : {};
  }
  if (p.startsWith('/PurchaseRequests(')) return { DocEntry: 555, DocNum: 9001 };
  if (p.startsWith('/Drafts(')) return { DocEntry: 80651, DocNum: 10712, DocTotal: 50, Requester: 'manager', RequesterName: 'manager', DocumentLines: [] };
  return { value: [] };
};
const b1 = require('../modules/compras/sl');

(async () => {
  const mine = await b1.listPendingApprovals({}, {}, { internalKey: 82 });
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].draftEntry, 80651);
  assert.strictEqual((await b1.listPendingApprovals({}, {}, { internalKey: 99 })).length, 0);
  const det = await b1.getRequest({}, {}, 'draft', 80651);
  assert.strictEqual(det.status, 'PENDING');
  assert.strictEqual(det.approval.steps[0].status, 'PENDING');
  console.log('  ✔ formato real do OWDD (DraftEntry, IsDraft "Y", ardPending)');

  // Depois de gerar: IsDraft "N", ObjectEntry = documento criado, Status arsGenerated
  current = { ...rec, IsDraft: 'N', ObjectEntry: 555, Status: 'arsGenerated', ApprovalRequestLines: [{ StageCode: 663, UserID: 82, Status: 'ardApproved' }] };
  const gen = await b1.getRequest({}, {}, 'draft', 80651);
  assert.strictEqual(gen.status, 'GENERATED');
  assert.deepStrictEqual(gen.generated, { entry: 555, docNum: 9001 });
  console.log('  ✔ rascunho gerado aponta para a solicitação criada');

  // Caminho rápido: OWDD/WDD1 via SQLQueries (2 aprovadores na mesma etapa) no formato do SL
  const aq = require('../modules/compras/approvalsSql');
  aq._off.clear();
  sqlRows = [
    { WddCode: 90001, ObjType: '22', IsDraft: 'Y', DraftEntry: 81000, DocEntry: 81000, Status: 'W', CurrStep: 663, OwnerID: 1, CreateDate: '2026-09-27', Remarks: '', StepCode: 663, UserID: 82, LineStatus: 'W',
      DrfNum: 44, DrfType: 'I', DrfDate: '2026-09-27', DrfTotal: 12600, DrfCardCode: 'F3', DrfCardName: 'TechStore', DrfReqName: 'Diego' },
    { WddCode: 90001, ObjType: '22', IsDraft: 'Y', DraftEntry: 81000, DocEntry: 81000, Status: 'W', CurrStep: 663, OwnerID: 1, CreateDate: '2026-09-27', Remarks: '', StepCode: 663, UserID: 90, LineStatus: 'Y' }
  ];
  draftReads = 0;
  const viaSql = await b1.listPendingApprovals({ id: 'sql' }, {}, { internalKey: 82 });
  assert.strictEqual(draftReads, 0, 'cabeçalho do rascunho deve vir na própria consulta SQL');
  assert.strictEqual(viaSql[0].cardName, 'TechStore');
  assert.strictEqual(viaSql[0].total, 12600);
  assert.strictEqual(viaSql.length, 1);
  assert.strictEqual(viaSql[0].kind, 'po');
  assert.strictEqual(viaSql[0].draftEntry, 81000);
  const shaped = aq.toSL(sqlRows)[0];
  assert.strictEqual(shaped.Status, 'arsPending');
  assert.deepStrictEqual(shaped.ApprovalRequestLines.map((l) => l.Status), ['ardPending', 'ardApproved']);
  console.log('  ✔ aprovações via SQL (OWDD/WDD1) no mesmo formato do Service Layer');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
