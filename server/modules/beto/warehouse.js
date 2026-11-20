'use strict';
/**
 * BETO — espelho analítico (etapa 2). Copia do SAP B1, SOMENTE LEITURA, os campos que as skills usam:
 * pedidos de compra (OPOR/POR1), fornecedores (OCRD) e itens de compra (OITM).
 *
 * Caminho preferido: SQLQueries PB_BETO_* (rápido; exige as tabelas liberadas no b1s_sqltable.conf).
 * Se o SL recusar a tabela, cai para OData GET (mais lento, mas funciona sem liberar nada).
 * Incremental por UpdateDate (watermark por entidade). Carga inicial: pedidos em aberto + últimos N meses.
 *
 * Conexão: usuário B1 configurado pelo administrador do Beto (decisão D2: "manager"), senha cifrada.
 * Este arquivo e connection.js são os ÚNICOS do Beto que falam com o Service Layer — e só com GET,
 * login/logout e SQLQueries (o teste beto.test.js garante isso).
 */
const sl = require('../../core/slClient');
const sqlQuery = require('../../core/sqlQuery');
const repoOf = require('./repo').forTenant;

const d10 = (s) => (s ? String(s).slice(0, 10) : null);
const num = (v) => (v == null || v === '' ? null : Number(v));
const yes = (v) => v === 'Y' || v === 'tYES' || v === true;
const q = (s) => String(s || '').replace(/'/g, "''");
const MAX_ROWS = Number(process.env.BETO_WH_MAX_ROWS || 300000);

// ---------- consultas SQL (portáveis HANA / SQL Server; sem subconsulta, como exige o SQLQueries) ----------
const SQL = {
  po: {
    code: 'PB_BETO_PO', name: 'Beto - pedidos de compra (linhas)',
    sql: 'SELECT T0."DocEntry", T0."DocNum", T0."CardCode", T0."CardName", T0."DocDate", T0."DocDueDate", T0."DocStatus", T0."CANCELED", ' +
      'T0."BPLId", T0."UpdateDate", T1."LineNum", T1."ItemCode", T1."Dscription", T1."Quantity", T1."OpenQty", T1."Price", T1."LineTotal", ' +
      'T1."ShipDate", T1."LineStatus", T1."CFOPCode", T1."Usage", T1."BaseType", T1."BaseEntry", T1."AgrNo" ' +
      'FROM "OPOR" T0 INNER JOIN "POR1" T1 ON T0."DocEntry" = T1."DocEntry" ' +
      'WHERE T0."UpdateDate" >= :upd AND (T0."DocStatus" = \'O\' OR T0."DocDate" >= :horizon) ORDER BY T0."DocEntry", T1."LineNum"'
  },
  vendor: {
    code: 'PB_BETO_VENDOR', name: 'Beto - fornecedores',
    sql: 'SELECT T0."CardCode", T0."CardName", T0."validFor", T0."frozenFor", T0."E_Mail", T0."State1", T0."UpdateDate" ' +
      'FROM "OCRD" T0 WHERE T0."CardType" = \'S\' AND T0."UpdateDate" >= :upd ORDER BY T0."CardCode"'
  },
  item: {
    code: 'PB_BETO_ITEM', name: 'Beto - itens de compra',
    sql: 'SELECT T0."ItemCode", T0."ItemName", T0."PrchseItem", T0."validFor", T0."frozenFor", T0."DfltWH", T0."ItmsGrpCod", T0."UpdateDate" ' +
      'FROM "OITM" T0 WHERE T0."PrchseItem" = \'Y\' AND T0."UpdateDate" >= :upd ORDER BY T0."ItemCode"'
  }
};

// ---------- normalização (mesmo formato vindo de SQL ou de OData) ----------
function ordersFromSql(rows) {
  const map = new Map();
  rows.forEach((r) => {
    let d = map.get(r.DocEntry);
    if (!d) {
      d = { docEntry: Number(r.DocEntry), docNum: num(r.DocNum), cardCode: r.CardCode, cardName: r.CardName, docDate: d10(r.DocDate), dueDate: d10(r.DocDueDate),
        status: r.DocStatus === 'O' ? 'O' : 'C', canceled: r.CANCELED === 'Y', bplId: num(r.BPLId), updateDate: d10(r.UpdateDate), lines: [] };
      map.set(r.DocEntry, d);
    }
    d.lines.push({ lineNum: Number(r.LineNum), itemCode: r.ItemCode, itemName: r.Dscription, quantity: num(r.Quantity), openQty: num(r.OpenQty),
      price: num(r.Price), lineTotal: num(r.LineTotal), shipDate: d10(r.ShipDate), lineStatus: r.LineStatus === 'O' ? 'O' : 'C',
      cfop: r.CFOPCode || null, usage: r.Usage, baseType: num(r.BaseType), baseEntry: num(r.BaseEntry), agreementNo: num(r.AgrNo) });
  });
  return [...map.values()];
}

function ordersFromOData(docs) {
  return docs.map((d) => ({
    docEntry: Number(d.DocEntry), docNum: num(d.DocNum), cardCode: d.CardCode, cardName: d.CardName, docDate: d10(d.DocDate), dueDate: d10(d.DocDueDate),
    status: d.DocumentStatus === 'bost_Open' ? 'O' : 'C', canceled: d.Cancelled === 'tYES', bplId: num(d.BPL_IDAssignedToInvoice), updateDate: d10(d.UpdateDate),
    lines: (d.DocumentLines || []).map((l) => ({
      lineNum: Number(l.LineNum), itemCode: l.ItemCode, itemName: l.ItemDescription, quantity: num(l.Quantity), openQty: num(l.RemainingOpenQuantity ?? l.Quantity),
      price: num(l.Price ?? l.UnitPrice), lineTotal: num(l.LineTotal), shipDate: d10(l.ShipDate), lineStatus: (l.LineStatus || 'bost_Open') === 'bost_Open' ? 'O' : 'C',
      cfop: l.CFOPCode || null, usage: l.Usage, baseType: num(l.BaseType), baseEntry: num(l.BaseEntry), agreementNo: num(l.AgreementNo)
    }))
  }));
}

const vendorFromSql = (r) => ({ cardCode: r.CardCode, cardName: r.CardName, active: r.validFor !== 'N' && r.frozenFor !== 'Y', email: r.E_Mail, state: r.State1, updateDate: d10(r.UpdateDate) });
function vendorFromOData(b) {
  const a = (b.BPAddresses || []).find((x) => x.AddressType === 'bo_BillTo') || (b.BPAddresses || [])[0] || {};
  return { cardCode: b.CardCode, cardName: b.CardName, active: b.Valid !== 'tNO' && b.Frozen !== 'tYES', email: b.EmailAddress, state: a.State, updateDate: d10(b.UpdateDate) };
}
const itemFromSql = (r) => ({ itemCode: r.ItemCode, itemName: r.ItemName, purchase: yes(r.PrchseItem), active: r.validFor !== 'N' && r.frozenFor !== 'Y', defaultWh: r.DfltWH, groupCode: num(r.ItmsGrpCod), updateDate: d10(r.UpdateDate) });
const itemFromOData = (i) => ({ itemCode: i.ItemCode, itemName: i.ItemName, purchase: yes(i.PurchaseItem), active: i.Valid !== 'tNO' && i.Frozen !== 'tYES', defaultWh: i.DefaultWarehouse, groupCode: num(i.ItemsGroupCode), updateDate: d10(i.UpdateDate) });

// ---------- leitores (SQL com fallback para OData) ----------
const isTableBlocked = (e) => /not accessible|não acess|not allowed|invalid table|table.*not|b1s_sqltable/i.test(String(e && e.message));

const READERS = {
  po: {
    sql: async (tenant, ctx, w) => ordersFromSql((await sqlQuery.run(tenant, ctx, SQL.po, { upd: w.upd, horizon: w.horizon }, MAX_ROWS)).rows),
    odata: async (tenant, ctx, w) => ordersFromOData(await sl.getAll(tenant, ctx.cookie,
      '/PurchaseOrders?$select=DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocumentStatus,Cancelled,BPL_IDAssignedToInvoice,UpdateDate,DocumentLines' +
      `&$filter=UpdateDate ge '${q(w.upd)}' and (DocumentStatus eq 'bost_Open' or DocDate ge '${q(w.horizon)}')&$orderby=DocEntry`, MAX_ROWS, 100)),
    save: (repo, rows) => repo.upsertOrders(rows),
    count: (rows) => rows.reduce((s, d) => s + d.lines.length, 0)
  },
  vendor: {
    sql: async (tenant, ctx, w) => (await sqlQuery.run(tenant, ctx, SQL.vendor, { upd: w.upd }, MAX_ROWS)).rows.map(vendorFromSql),
    odata: async (tenant, ctx, w) => (await sl.getAll(tenant, ctx.cookie,
      `/BusinessPartners?$select=CardCode,CardName,Valid,Frozen,EmailAddress,BPAddresses,UpdateDate&$filter=CardType eq 'cSupplier' and UpdateDate ge '${q(w.upd)}'&$orderby=CardCode`,
      MAX_ROWS, 100)).map(vendorFromOData),
    save: (repo, rows) => repo.upsertVendors(rows),
    count: (rows) => rows.length
  },
  item: {
    sql: async (tenant, ctx, w) => (await sqlQuery.run(tenant, ctx, SQL.item, { upd: w.upd }, MAX_ROWS)).rows.map(itemFromSql),
    odata: async (tenant, ctx, w) => (await sl.getAll(tenant, ctx.cookie,
      `/Items?$select=ItemCode,ItemName,PurchaseItem,Valid,Frozen,DefaultWarehouse,ItemsGroupCode,UpdateDate&$filter=PurchaseItem eq 'tYES' and UpdateDate ge '${q(w.upd)}'&$orderby=ItemCode`,
      MAX_ROWS, 100)).map(itemFromOData),
    save: (repo, rows) => repo.upsertItems(rows),
    count: (rows) => rows.length
  }
};
const ENTITIES = Object.keys(READERS);

/**
 * Sincroniza uma entidade. Watermark = maior UpdateDate lido (a próxima leitura repete esse dia, por segurança).
 * horizonMonths: na carga, pedidos fechados mais antigos que isso ficam de fora (os abertos sempre entram).
 */
async function syncEntity(tenant, ctx, entity, { horizonMonths = 24, full = false, onStep } = {}) {
  const repo = repoOf(tenant.id);
  const st = repo.syncState(entity);
  const started = Date.now();
  const h = new Date();
  h.setMonth(h.getMonth() - horizonMonths);
  const w = { upd: !full && st && st.watermark ? st.watermark : '1900-01-01', horizon: h.toISOString().slice(0, 10) };
  const reader = READERS[entity];
  let rows;
  let mode = 'sql';
  if (ctx && ctx.mock) {
    rows = require('./mocksource')[entity]();
    mode = 'demo';
  } else try {
    rows = await reader.sql(tenant, ctx, w);
  } catch (e) {
    if (e.status === 401) throw e;
    if (!isTableBlocked(e)) console.warn(`[beto] SQL de ${entity} recusado (${e.message}); usando OData`);
    mode = 'odata';
    rows = await reader.odata(tenant, ctx, w);
  }
  reader.save(repo, rows);
  const marks = rows.map((r) => r.updateDate).filter(Boolean).sort();
  const watermark = marks.length ? marks[marks.length - 1] : (st && st.watermark) || null;
  const out = { entity, rows: reader.count(rows), mode, watermark, ms: Date.now() - started };
  repo.setSyncState(entity, { ...out, total: totalOf(repo, entity), ok: true });
  if (onStep) onStep(out);
  return out;
}

function totalOf(repo, entity) {
  const table = { po: 'wh_po_line', vendor: 'wh_vendor', item: 'wh_item' }[entity];
  return repo.wh(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`)[0].n;
}

/** Sincroniza tudo com uma sessão própria (login/logout). Erro de uma entidade não derruba as outras. */
async function syncAll(tenant, conn, opts = {}) {
  const repo = repoOf(tenant.id);
  const ctx = await conn.open(tenant);
  const results = [];
  try {
    for (const entity of ENTITIES) {
      const started = Date.now();
      try {
        results.push(await syncEntity(tenant, ctx, entity, opts));
      } catch (e) {
        const r = { entity, rows: 0, mode: null, ms: Date.now() - started, error: e.message };
        repo.setSyncState(entity, { ...(repo.syncState(entity) || {}), rows: 0, ok: false, error: e.message, ms: r.ms, mode: null });
        results.push(r);
        if (e.status === 401) break;
      }
    }
  } finally {
    await conn.close(tenant, ctx);
  }
  return results;
}

module.exports = { syncAll, syncEntity, ENTITIES, SQL, ordersFromSql, ordersFromOData, vendorFromSql, vendorFromOData, itemFromSql, itemFromOData };
