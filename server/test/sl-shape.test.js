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
sl.request = async (t, c, m, p) => {
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
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
