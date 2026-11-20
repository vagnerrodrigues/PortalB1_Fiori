'use strict';
/** BETO: leitura do SAP no formato real do Service Layer (sem SAP). SQL quando liberado; OData quando o SL recusa a tabela. */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-beto-sl-'));
process.env.PORTAL_SECRET = 'teste';
const assert = require('assert');
const sl = require('../core/slClient');

const calls = [];
let sqlBlocked = false;
const SQL_PO = [
  { DocEntry: 10, DocNum: 5010, CardCode: 'F1', CardName: 'Fornecedor 1', DocDate: '2026-01-05T00:00:00Z', DocDueDate: '2026-02-01T00:00:00Z', DocStatus: 'O', CANCELED: 'N',
    BPLId: 1, UpdateDate: '2026-03-01T00:00:00Z', LineNum: 0, ItemCode: 'A1', Dscription: 'Item A', Quantity: 10, OpenQty: 4, Price: 2.5, LineTotal: 25,
    ShipDate: '2026-02-01', LineStatus: 'O', CFOPCode: '', Usage: 9, BaseType: -1, BaseEntry: null, AgrNo: null },
  { DocEntry: 10, DocNum: 5010, CardCode: 'F1', CardName: 'Fornecedor 1', DocDate: '2026-01-05', DocDueDate: '2026-02-01', DocStatus: 'O', CANCELED: 'N',
    BPLId: 1, UpdateDate: '2026-03-01', LineNum: 1, ItemCode: 'B1', Dscription: 'Item B', Quantity: 1, OpenQty: 0, Price: 100, LineTotal: 100,
    ShipDate: '2026-02-01', LineStatus: 'C', CFOPCode: '1102', Usage: 9, BaseType: 540000006, BaseEntry: 7, AgrNo: 3 }
];
sl.login = async () => ({ cookie: 'B1SESSION=x' });
sl.logout = async () => {};
sl.request = async (t, cookie, method, p, body) => {
  calls.push({ method, p, body });
  if (p.startsWith('/SQLQueries(') && method === 'GET') { const e = new sl.SLError(404, -1, 'not found'); throw e; } // consulta ainda não registrada
  if (p === '/SQLQueries' && method === 'POST') {
    if (sqlBlocked) throw new sl.SLError(400, -1, "Table 'OPOR' not accessible");
    return {};
  }
  if (/\/List$/.test(p.split('?')[0])) {
    if (sqlBlocked) throw new sl.SLError(400, -1, "Table 'OPOR' not accessible");
    const code = /SQLQueries\('([^']+)'\)/.exec(p)[1];
    if (code === 'PB_BETO_PO') return { value: SQL_PO };
    if (code === 'PB_BETO_VENDOR') return { value: [{ CardCode: 'F1', CardName: 'Fornecedor 1', validFor: 'Y', frozenFor: 'N', E_Mail: '', State1: '', UpdateDate: '2026-02-10' }] };
    if (code === 'PB_BETO_ITEM') return { value: [{ ItemCode: 'A1', ItemName: 'Item A', PrchseItem: 'Y', validFor: 'Y', frozenFor: 'N', DfltWH: null, ItmsGrpCod: 100, UpdateDate: '2026-02-11' }] };
    return { value: [] };
  }
  return { value: [] };
};
sl.getAll = async (t, cookie, p) => {
  calls.push({ method: 'GET', p });
  if (p.startsWith('/PurchaseOrders?')) {
    return [{ DocEntry: 20, DocNum: 5020, CardCode: 'F2', CardName: 'Fornecedor 2', DocDate: '2026-04-01', DocDueDate: '2026-04-10', DocumentStatus: 'bost_Open', Cancelled: 'tNO',
      BPL_IDAssignedToInvoice: 1, UpdateDate: '2026-04-02', DocumentLines: [{ LineNum: 0, ItemCode: 'C1', ItemDescription: 'Item C', Quantity: 3, RemainingOpenQuantity: 3,
        Price: 10, LineTotal: 30, ShipDate: '2026-04-10', LineStatus: 'bost_Open', CFOPCode: '2102', Usage: '9', BaseType: -1, AgreementNo: null }] }];
  }
  if (p.startsWith('/BusinessPartners?')) return [{ CardCode: 'F2', CardName: 'Fornecedor 2', Valid: 'tYES', Frozen: 'tNO', EmailAddress: 'a@b.com', UpdateDate: '2026-04-03', BPAddresses: [{ AddressType: 'bo_BillTo', State: 'MG' }] }];
  if (p.startsWith('/Items?')) return [{ ItemCode: 'C1', ItemName: 'Item C', PurchaseItem: 'tYES', Valid: 'tYES', Frozen: 'tNO', DefaultWarehouse: '01', ItemsGroupCode: 100, UpdateDate: '2026-04-04' }];
  return [];
};

const warehouse = require('../modules/beto/warehouse');
const repoMod = require('../modules/beto/repo');
const tenant = { id: 'sl', serviceLayerUrl: 'https://x:50000/b1s/v1', companyDB: 'X' };
const conn = { open: async () => ({ cookie: 'B1SESSION=x' }), close: async () => {} };

(async () => {
  try {
    // 1) SQL liberado
    let res = await warehouse.syncAll(tenant, conn);
    assert.deepStrictEqual(res.map((r) => [r.entity, r.mode, r.rows]), [['po', 'sql', 2], ['vendor', 'sql', 1], ['item', 'sql', 1]]);
    const repo = repoMod.forTenant('sl');
    const lines = repo.wh('SELECT * FROM wh_po_line WHERE tenant_id = ? ORDER BY line_num');
    assert.strictEqual(lines[0].cfop, null); // CFOP vazio no SAP = sem CFOP
    assert.strictEqual(lines[0].open_qty, 4);
    assert.strictEqual(lines[1].line_status, 'C');
    assert.strictEqual(lines[1].agreement_no, 3);
    assert.strictEqual(repo.wh('SELECT due_date FROM wh_po WHERE tenant_id = ?')[0].due_date, '2026-02-01');
    assert.strictEqual(repo.syncState('po').watermark, '2026-03-01');
    const poList = calls.find((c) => /PB_BETO_PO'\)\/List/.test(c.p));
    assert.ok(/upd='1900-01-01'/.test(poList.body.ParamList) && /horizon='\d{4}-\d{2}-\d{2}'/.test(poList.body.ParamList));
    console.log('  ✔ espelho via SQLQueries (OPOR/POR1, OCRD, OITM): datas, CFOP vazio, saldo e watermark normalizados');

    // 2) incremental: a próxima leitura parte do watermark
    calls.length = 0;
    await warehouse.syncAll(tenant, conn);
    assert.ok(/upd='2026-03-01'/.test(calls.find((c) => /PB_BETO_PO'\)\/List/.test(c.p)).body.ParamList));
    console.log('  ✔ leitura incremental pelo UpdateDate (watermark por entidade)');

    // 3) SL recusa a tabela em SQLQueries -> OData GET
    repoMod.closeAll();
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-beto-sl2-'));
    sqlBlocked = true;
    calls.length = 0;
    res = await warehouse.syncAll(tenant, conn);
    assert.deepStrictEqual(res.map((r) => [r.entity, r.mode]), [['po', 'odata'], ['vendor', 'odata'], ['item', 'odata']]);
    const r2 = repoMod.forTenant('sl');
    assert.strictEqual(r2.wh('SELECT state FROM wh_vendor WHERE tenant_id = ?')[0].state, 'MG');
    assert.strictEqual(r2.wh('SELECT cfop FROM wh_po_line WHERE tenant_id = ?')[0].cfop, '2102');
    assert.ok(calls.find((c) => c.p.startsWith('/PurchaseOrders?')).p.includes("DocumentStatus eq 'bost_Open'"));
    console.log('  ✔ tabela não liberada no b1s_sqltable.conf: cai para OData (GET) no mesmo formato');

    // 4) nada além de leitura
    const writes = calls.filter((c) => c.method !== 'GET' && !(c.method === 'POST' && (c.p === '/SQLQueries' || /\/List$/.test(c.p.split('?')[0]))));
    assert.deepStrictEqual(writes, []);
    console.log('  ✔ só GET e SQLQueries: nenhuma gravação de documento ou cadastro');
  } catch (e) {
    console.error('FALHOU:', e);
    process.exitCode = 1;
  } finally {
    repoMod.closeAll();
  }
})();
