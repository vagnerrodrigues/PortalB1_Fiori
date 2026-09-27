'use strict';
/** Desempenho: catálogo de itens em memória e linhas abertas por SQL (sem SAP). */
process.env.ITEM_CACHE = '1';
const assert = require('assert');
const sl = require('../core/slClient');

let itemCalls = 0;
const ITEMS = Array.from({ length: 30000 }, (_, i) => ({ ItemCode: `IT-${String(i).padStart(5, '0')}`, ItemName: i === 777 ? 'Luva nitrílica azul' : `Produto ${i}`, PurchaseUnit: 'UN' }));
sl.getAll = async (t, c, path) => { if (path.startsWith('/Items')) { itemCalls++; return ITEMS; } return []; };
sl.request = async (t, c, m, p) => {
  if (p.startsWith('/Items')) return { value: [{ ItemCode: 'LIVE', ItemName: 'consulta direta' }] };
  if (p === '/SQLQueries') return {};
  if (p.startsWith("/SQLQueries('PB_PR_OPEN_LINES')/List")) {
    return { value: [{ DocEntry: 5, DocNum: 105, DocDate: '2026-09-20T00:00:00Z', ReqName: 'Ana', BPLId: 1, LineNum: 0, ItemCode: 'A', Dscription: 'Item A', OpenQty: 3, unitMsr: 'UN', PQTReqDate: '2026-10-01T00:00:00Z' }] };
  }
  return { value: [] };
};
const b1 = require('../modules/compras/sl');
const proc = require('../modules/compras/sl-procure');
const T = { id: 'perf' };

(async () => {
  const first = await b1.searchItems(T, {}, 'luva');
  assert.strictEqual(first[0].itemCode, 'LIVE'); // catálogo ainda carregando: consulta direta
  await new Promise((r) => setTimeout(r, 50));
  const t0 = process.hrtime.bigint();
  const hit = await b1.searchItems(T, {}, 'LUVA nitrilica');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(hit[0].itemCode, 'IT-00777');
  assert.ok(ms < 50, `busca em memória demorou ${ms} ms`);
  assert.strictEqual((await b1.searchItems(T, {}, 'it-0001'))[0].itemCode, 'IT-00010');
  assert.strictEqual(itemCalls, 1);
  console.log(`  ✔ catálogo em memória: 30 mil itens, busca sem acento em ${ms.toFixed(1)} ms, SAP consultado 1 vez`);

  const lines = await proc.openRequestLines(T, {}, { branch: 1 });
  assert.deepStrictEqual(lines[0], { prEntry: 5, prDocNum: 105, prLine: 0, docDate: '2026-09-20', requester: 'Ana', branch: 1, itemCode: 'A', itemName: 'Item A',
    uom: 'UN', quantity: 3, requiredDate: '2026-10-01', warehouse: '', costCenter: '', freeText: '', estimatedPrice: null });
  console.log('  ✔ linhas abertas das solicitações em uma única consulta SQL');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
