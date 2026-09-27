'use strict';
/**
 * Leitura rápida dos pedidos de aprovação (OWDD/WDD1) via SQLQueries.
 * O objeto ApprovalRequests do Service Layer é caro (medido no B1 10.0: ~9,6 s numa única chamada),
 * porque monta cada pedido com todas as linhas. A consulta SQL filtra direto por usuário/originador/rascunho.
 * Devolve os registros no MESMO formato do SL (Code, Status 'arsPending', ApprovalRequestLines...), então
 * o resto do código não muda. Se o SL não liberar OWDD/WDD1 para SQLQueries, devolve null e o chamador
 * usa o OData.
 */
const sqlQuery = require('../../core/sqlQuery');

// SQLQueries do SL aceita um SQL restrito: sem subconsulta; filtros com AND/OR simples
const OBJ_FILTER = '(T0."ObjType" = \'1470000113\' OR T0."ObjType" = \'540000006\' OR T0."ObjType" = \'22\' OR T0."ObjType" = \'20\')';
const COLS = 'T0."WddCode", T0."ObjType", T0."IsDraft", T0."DraftEntry", T0."DocEntry", T0."Status", T0."CurrStep", T0."OwnerID", ' +
  'T0."CreateDate", T0."Remarks", T1."StepCode", T1."UserID", T1."Status" AS "LineStatus", T1."Remarks" AS "LineRemarks", T1."UpdateDate"';
// Cabeçalho do rascunho na mesma consulta: a lista de aprovações não precisa ler rascunho por rascunho
const DRF_COLS = ', T3."DocNum" AS "DrfNum", T3."DocType" AS "DrfType", T3."DocDate" AS "DrfDate", T3."ReqDate" AS "DrfReqDate", ' +
  'T3."DocDueDate" AS "DrfDueDate", T3."DocTotal" AS "DrfTotal", T3."DocCur" AS "DrfCur", T3."Requester" AS "DrfRequester", ' +
  'T3."ReqName" AS "DrfReqName", T3."CardCode" AS "DrfCardCode", T3."CardName" AS "DrfCardName", T3."Comments" AS "DrfComments"';
const FROM = 'FROM "OWDD" T0 INNER JOIN "WDD1" T1 ON T0."WddCode" = T1."WddCode" ';
const DRF_JOIN = 'LEFT OUTER JOIN "ODRF" T3 ON T3."DocEntry" = T0."DraftEntry" ';

const WHERE = {
  pending: 'INNER JOIN "WDD1" T2 ON T0."WddCode" = T2."WddCode" ' +
    `WHERE T0."Status" = 'W' AND ${OBJ_FILTER} AND T2."UserID" = :user AND T2."Status" = 'W' AND T2."StepCode" = T0."CurrStep" ORDER BY T0."WddCode" DESC`,
  owner: `WHERE T0."OwnerID" = :owner AND ${OBJ_FILTER} ORDER BY T0."WddCode" DESC`,
  draft: `WHERE T0."DraftEntry" = :draft AND ${OBJ_FILTER} ORDER BY T0."WddCode" DESC`
};
const NAMES = { pending: 'aprovacoes pendentes do usuario', owner: 'aprovacoes do originador', draft: 'aprovacao de um rascunho' };
const CODES = { pending: 'PB_APPR_PENDING', owner: 'PB_APPR_OWNER', draft: 'PB_APPR_DRAFT' };
/** Duas versões de cada consulta: com o cabeçalho do rascunho (preferida) e sem (se o SL recusar o LEFT JOIN). */
function query(kind, withDraft) {
  return {
    code: CODES[kind] + (withDraft ? '' : '_S'),
    name: `Portal B1 - ${NAMES[kind]}`,
    sql: `SELECT ${COLS}${withDraft ? DRF_COLS : ''} ${FROM}${withDraft ? DRF_JOIN : ''}${WHERE[kind]}`
  };
}

const HDR = { W: 'arsPending', Y: 'arsApproved', N: 'arsNotApproved', P: 'arsGenerated', A: 'arsGeneratedByAuthorizer', C: 'arsCancelled' };
const LIN = { W: 'ardPending', Y: 'ardApproved', N: 'ardNotApproved' };
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Agrupa linhas SQL (1 por aprovador) no formato do objeto ApprovalRequests do SL. */
function toSL(rows) {
  const map = new Map();
  rows.forEach((r) => {
    let a = map.get(r.WddCode);
    if (!a) {
      const isDraft = r.IsDraft === 'Y';
      a = {
        Code: Number(r.WddCode), ObjectType: String(r.ObjType), IsDraft: r.IsDraft,
        DraftEntry: num(r.DraftEntry) ?? (isDraft ? num(r.DocEntry) : null),
        ObjectEntry: isDraft ? null : num(r.DocEntry),
        Status: HDR[r.Status] || 'arsPending', CurrentStage: num(r.CurrStep), OriginatorID: num(r.OwnerID),
        CreationDate: r.CreateDate, Remarks: r.Remarks || '', ApprovalRequestLines: []
      };
      map.set(r.WddCode, a);
    }
    if (!a._draft && r.DrfNum !== undefined && r.DrfNum !== null) {
      a._draft = {
        DocEntry: a.DraftEntry, DocNum: r.DrfNum, DocType: r.DrfType === 'S' ? 'dDocument_Service' : 'dDocument_Items',
        DocDate: r.DrfDate, RequriedDate: r.DrfReqDate, DocDueDate: r.DrfDueDate, DocTotal: r.DrfTotal, DocCurrency: r.DrfCur,
        Requester: r.DrfRequester, RequesterName: r.DrfReqName, CardCode: r.DrfCardCode, CardName: r.DrfCardName, Comments: r.DrfComments
      };
    }
    a.ApprovalRequestLines.push({
      StageCode: num(r.StepCode), UserID: num(r.UserID), Status: LIN[r.LineStatus] || 'ardPending',
      Remarks: r.LineRemarks || '', UpdateDate: r.UpdateDate || null
    });
  });
  return [...map.values()];
}

const off = new Set(); // empresas onde o SL recusou OWDD/WDD1 em SQLQueries
const plainOnly = new Set(); // empresas onde o LEFT JOIN com ODRF não passou
async function run(tenant, ctx, kind, params) {
  if (off.has(tenant.id)) return null;
  for (const withDraft of plainOnly.has(tenant.id) ? [false] : [true, false]) {
    try {
      return toSL((await sqlQuery.run(tenant, ctx, query(kind, withDraft), params, 5000)).rows);
    } catch (e) {
      if (e.status === 401) throw e; // sessão expirada: não é falta de permissão na tabela
      if (withDraft) { plainOnly.add(tenant.id); continue; }
      off.add(tenant.id);
      console.error(`[compras] SQL de aprovacoes indisponivel (${e.message}); usando ApprovalRequests (mais lento). ` +
        'Para acelerar, libere OWDD, WDD1 e ODRF no b1s_sqltable.conf do Service Layer.');
    }
  }
  return null;
}

module.exports = {
  pendingFor: (tenant, ctx, userKey) => run(tenant, ctx, 'pending', { user: Number(userKey) }),
  byOwner: (tenant, ctx, ownerKey) => run(tenant, ctx, 'owner', { owner: Number(ownerKey) }),
  byDraft: (tenant, ctx, draftEntry) => run(tenant, ctx, 'draft', { draft: Number(draftEntry) }),
  toSL, _off: off, _plainOnly: plainOnly, _query: query
};
