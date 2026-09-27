'use strict';
/**
 * Adapter real: traduz as operações do portal para objetos NATIVOS do SAP B1 via Service Layer.
 * Nenhum UDF/UDT é usado. Regra de aprovação = Procedimentos de Autorização nativos (OWTM/OWDD).
 *
 * Objetos usados:
 *  - PurchaseRequests (OPRQ/PRQ1)   -> solicitação de compra
 *  - Drafts (ODRF/DRF1)             -> solicitação retida por aprovação
 *  - ApprovalRequests (OWDD/WDD1)   -> pedidos de aprovação e decisões
 *  - DraftsService_SaveDraftToDocument -> efetivar rascunho aprovado
 *  - Items, ProfitCenters, Warehouses, BusinessPartners, Users -> dados mestre
 */
const sl = require('../../core/slClient');

const OBJ_PURCHASE_REQUEST = '1470000113';

/**
 * Documentos de compras tratados pelo portal (todos nativos):
 *  pr = Solicitação de compra (OPRQ) | pq = Oferta de compra (OPQT) | po = Pedido de compra (OPOR)
 * draftCode = valor de DocObjectCode no rascunho (ODRF) quando o Procedimento de Autorização retém o documento.
 */
const KINDS = {
  pr: { obj: '1470000113', coll: 'PurchaseRequests', draftCode: 'oPurchaseRequest' },
  pq: { obj: '540000006', coll: 'PurchaseQuotations', draftCode: 'oPurchaseQuotations' },
  po: { obj: '22', coll: 'PurchaseOrders', draftCode: 'oPurchaseOrders' }
};
const ALL_OBJ = Object.values(KINDS).map((k) => k.obj);
const kindByObj = (code) => Object.keys(KINDS).find((k) => KINDS[k].obj === String(code)) || null;
const kindByDraftCode = (code) => Object.keys(KINDS).find((k) => KINDS[k].draftCode === code) || null;

const q = (s) => String(s || '').replace(/'/g, "''"); // escape OData string
const enc = encodeURIComponent;

// ---------- Dados mestre ----------
const catalog = require('./itemCatalog');
/**
 * Busca de itens. Padrão: consulta direta (1 chamada leve por busca).
 * ITEM_CACHE=1 liga o catálogo em memória. Atenção: o Service Layer atende as chamadas de uma sessão em fila,
 * então carregar o catálogo com a sessão do usuário trava as outras telas dele enquanto carrega
 * (medido no B1 real: chamadas simples passaram de 20 s). Só ligue em bases com SL folgado.
 */
const CATALOG_ON = process.env.ITEM_CACHE === '1';
async function searchItems(tenant, ctx, term) {
  if (!CATALOG_ON) return searchItemsLive(tenant, ctx, term);
  return catalog.find(tenant, ctx, term, () => searchItemsLive(tenant, ctx, term));
}
const warmup = (tenant, ctx) => { if (CATALOG_ON) catalog.warm(tenant, ctx); };

async function searchItemsLive(tenant, ctx, term) {
  const t = enc(q(term));
  const filter = `PurchaseItem eq 'tYES' and Valid eq 'tYES'` +
    (term ? ` and (contains(ItemCode,'${t}') or contains(ItemName,'${t}'))` : '');
  const r = await sl.request(tenant, ctx.cookie, 'GET',
    `/Items?$select=ItemCode,ItemName,PurchaseUnit,InventoryUOM,DefaultWarehouse&$filter=${filter}&$top=20`);
  return (r.value || []).map((i) => ({
    itemCode: i.ItemCode,
    itemName: i.ItemName,
    uom: i.PurchaseUnit || i.InventoryUOM || '',
    defaultWarehouse: i.DefaultWarehouse || ''
  }));
}

/**
 * Centro de custo da linha (CostingCode) = REGRA DE DISTRIBUIÇÃO (OOCR), não o centro de lucro (OPRC).
 * Validado no B1 10.0: "Centr_z" (centro padrão, sem regra) faz o SL devolver -2028.
 */
async function listCostCenters(tenant, ctx) {
  try {
    const rows = await sl.getAll(tenant, ctx.cookie,
      `/DistributionRules?$select=FactorCode,FactorDescription,InWhichDimension,Active&$filter=InWhichDimension eq 1 and Active eq 'tYES'`, 2000);
    return rows.filter((r) => r.FactorCode !== 'Centr_z')
      .map((r) => ({ code: r.FactorCode, name: r.FactorDescription || r.FactorCode }));
  } catch (_) {
    const rows = await sl.getAll(tenant, ctx.cookie,
      `/ProfitCenters?$select=CenterCode,CenterName&$filter=InWhichDimension eq 1 and Active eq 'tYES'`, 2000);
    return rows.filter((c) => c.CenterCode !== 'Centr_z').map((c) => ({ code: c.CenterCode, name: c.CenterName }));
  }
}

async function listWarehouses(tenant, ctx) {
  const rows = await sl.getAll(tenant, ctx.cookie,
    `/Warehouses?$select=WarehouseCode,WarehouseName,BusinessPlaceID&$filter=Inactive eq 'tNO'`, 2000);
  return rows.map((w) => ({ code: w.WarehouseCode, name: w.WarehouseName, branch: w.BusinessPlaceID ?? null }));
}

/**
 * Filiais (multi-branch / OBPL). Base sem filiais -> [] e o campo some da tela.
 * Validado no B1 10.0: com filiais ativas, OPRQ sem BPL_IDAssignedToInvoice retorna -2028.
 */
async function listBranches(tenant, ctx, user) {
  let rows;
  try {
    rows = await sl.getAll(tenant, ctx.cookie, `/BusinessPlaces?$select=BPLID,BPLName,Disabled&$filter=Disabled eq 'tNO'`);
  } catch (e) {
    return []; // filiais não habilitadas na empresa
  }
  let allowed = null; // filiais atribuídas ao usuário (OUSR > Filiais), quando o SL expõe
  try {
    const u = await sl.request(tenant, ctx.cookie, 'GET',
      `/Users?$select=UserBranchAssignment&$filter=UserCode eq '${enc(q(user.userCode))}'`);
    const list = ((u.value || [])[0] || {}).UserBranchAssignment;
    if (Array.isArray(list) && list.length) allowed = list.map((b) => b.BPLID);
  } catch (_) { /* campo indisponível nesta versão: mostra todas */ }
  return rows
    .filter((b) => !allowed || allowed.includes(b.BPLID))
    .map((b) => ({ id: b.BPLID, name: b.BPLName }));
}

/** Série de numeração da Solicitação de compra vinculada à filial (OB1 multi-filial). */
const seriesCache = new Map();
async function seriesForBranch(tenant, ctx, branchId, kind = 'pr') {
  const key = `${tenant.id}:${kind}`;
  let list = seriesCache.get(key);
  if (!list) {
    try {
      const r = await sl.request(tenant, ctx.cookie, 'POST', '/SeriesService_GetDocumentSeries',
        { DocumentTypeParams: { Document: KINDS[kind].obj } });
      list = r.value || [];
    } catch (_) { list = []; }
    seriesCache.set(key, list);
    setTimeout(() => seriesCache.delete(key), 30 * 60 * 1000).unref();
  }
  const open = list.filter((s) => s.Locked !== 'tYES');
  const ofBranch = open.find((s) => Number(s.BPLID) === Number(branchId));
  const shared = open.find((s) => s.BPLID === null || s.BPLID === undefined); // série sem filial (vale para todas)
  return (ofBranch || shared || {}).Series;
}

async function searchVendors(tenant, ctx, term) {
  const t = enc(q(term));
  const filter = `CardType eq 'cSupplier' and Valid eq 'tYES'` +
    (term ? ` and (contains(CardCode,'${t}') or contains(CardName,'${t}'))` : '');
  const r = await sl.request(tenant, ctx.cookie, 'GET',
    `/BusinessPartners?$select=CardCode,CardName&$filter=${filter}&$top=20`);
  return (r.value || []).map((b) => ({ cardCode: b.CardCode, cardName: b.CardName }));
}

// ---------- Solicitação de compra ----------
/**
 * Monta a Solicitação de compra (OPRQ).
 *  - itens (Compras):  DocType dDocument_Items, linhas com ItemCode/Quantity
 *  - serviço (Despesas): DocType dDocument_Service, linhas com descrição + conta contábil + valor
 */
function toSLPurchaseRequest(user, p, series) {
  const service = p.docType === 'service';
  return {
    DocType: service ? 'dDocument_Service' : undefined,
    BPL_IDAssignedToInvoice: p.branch ? Number(p.branch) : undefined,
    Series: series,
    ReqType: 12, // 12 = Usuário (171 = Funcionário)
    Requester: user.userCode,
    // Sem e-mail no usuário B1, desliga o aviso por e-mail; senão o B1 recusa (1470000454 - OPRQ.Email)
    RequesterEmail: user.email || undefined,
    SendNotification: user.email ? 'tYES' : 'tNO',
    RequesterDepartment: user.department ?? undefined,
    RequriedDate: p.requiredDate, // sic: nome oficial do campo no DI/SL
    DocDate: p.docDate || undefined,
    Comments: p.comments || undefined,
    AttachmentEntry: p.attachmentEntry || undefined,
    DocumentLines: p.lines.map((l) => (service ? {
      ItemDescription: String(l.description || '').slice(0, 100),
      AccountCode: l.accountCode,
      LineTotal: Number(l.amount),
      RequiredDate: l.date || p.requiredDate,
      CostingCode: l.costCenter || undefined,
      FreeText: l.freeText || undefined
    } : {
      ItemCode: l.itemCode,
      Quantity: Number(l.quantity),
      UnitPrice: l.unitPrice ? Number(l.unitPrice) : undefined,
      RequiredDate: l.requiredDate || p.requiredDate,
      CostingCode: l.costCenter || undefined,
      WarehouseCode: l.warehouse || undefined,
      LineVendor: l.vendor || undefined,
      FreeText: l.freeText || undefined
    }))
  };
}

async function lastDraftEntry(tenant, ctx) {
  // ODRF é um só para todos os objetos: a maior chave vale como "foto" antes do POST
  const r = await sl.request(tenant, ctx.cookie, 'GET', `/Drafts?$select=DocEntry&$orderby=DocEntry desc&$top=1`);
  return ((r.value || [])[0] || {}).DocEntry || 0;
}

async function draftsCreatedAfter(tenant, ctx, entry, kind = 'pr') {
  const r = await sl.request(tenant, ctx.cookie, 'GET',
    `/Drafts?$select=DocEntry,DocNum,Requester,CardCode&$filter=DocObjectCode eq '${KINDS[kind].draftCode}' and DocEntry gt ${Number(entry)}&$orderby=DocEntry desc&$top=20`);
  return r.value || [];
}

/**
 * Cria um documento de compras (pr/pq/po). Se um Procedimento de Autorização se aplica, o B1 grava
 * rascunho (ODRF) + pedido de aprovação (OWDD) e o SL responde com erro -2028 (validado no B1 10.0).
 * match(draft) identifica o rascunho criado por este POST entre os rascunhos novos.
 */
async function createDocument(tenant, ctx, kind, body, match) {
  const before = await lastDraftEntry(tenant, ctx);
  let postError = null;
  try {
    const doc = await sl.request(tenant, ctx.cookie, 'POST', `/${KINDS[kind].coll}`, body);
    if (doc && doc.DocEntry) return { kind, source: 'doc', entry: doc.DocEntry, docNum: doc.DocNum, status: 'OPEN' };
  } catch (e) {
    postError = e;
  }
  const created = await draftsCreatedAfter(tenant, ctx, before, kind);
  const mine = created.find(match) || (created.length === 1 ? created[0] : null);
  if (mine) return { kind, source: 'draft', entry: mine.DocEntry, docNum: mine.DocNum, status: 'PENDING' };
  if (postError) {
    console.error(`[compras] POST ${KINDS[kind].coll} recusado:`, postError.message,
      JSON.stringify({ ...body, RequesterEmail: body.RequesterEmail ? '***' : undefined }));
    throw postError;
  }
  throw new sl.SLError(500, 'APPROVAL', 'O B1 não confirmou a criação do documento. Verifique no SAP antes de enviar de novo.');
}

/**
 * Cria a solicitação. Se um Procedimento de Autorização se aplica, o B1 grava rascunho (ODRF) +
 * pedido de aprovação (OWDD). Nesse caso o Service Layer (validado no B1 10.0, SL 1000321) responde
 * com ERRO "No matching records found (ODBC -2028)" em vez de sucesso — o rascunho foi criado.
 * Por isso: foto do último rascunho antes do POST; se o POST falhar e surgir um rascunho novo deste
 * usuário, é aprovação pendente. Sem rascunho novo, o erro é real e sobe para a tela.
 */
async function createPurchaseRequest(tenant, ctx, user, payload) {
  const series = payload.branch ? await seriesForBranch(tenant, ctx, Number(payload.branch)) : undefined;
  const body = toSLPurchaseRequest(user, payload, series);
  return createDocument(tenant, ctx, 'pr', body, (d) => d.Requester === user.userCode);
}

function mapApprovalStatus(s) {
  return ({
    arsPending: 'PENDING',
    arsApproved: 'APPROVED',
    // status da decisão de cada aprovador (ApprovalRequestLines): enum "ard*"
    ardPending: 'PENDING',
    ardApproved: 'APPROVED',
    ardNotApproved: 'REJECTED',
    arsNotApproved: 'REJECTED',
    arsGenerated: 'GENERATED',
    arsGeneratedByAuthorizer: 'GENERATED',
    arsCancelled: 'CANCELLED'
  })[s] || 'PENDING';
}

function mapDocStatus(d) {
  if (d.Cancelled === 'tYES') return 'CANCELLED';
  return d.DocumentStatus === 'bost_Close' ? 'CLOSED' : 'OPEN';
}

/**
 * Formato real do OWDD no SL (validado no B1 10.0, SL 1000321):
 *   IsDraft: "Y" | DraftEntry: nº do rascunho (ODRF) | ObjectEntry: null enquanto é rascunho
 *   Linhas: { StageCode, UserID, Status: "ardPending" | "ardApproved" | "ardNotApproved" }
 */
const draftKey = (a) => Number(a.DraftEntry ?? a.ObjectEntry);
const isDraftFlag = (v) => v === 'Y' || v === 'tYES' || v === true;

// ---------- Leitura do rascunho (com fallback) ----------
// O aprovador pode não ter permissão para ler o rascunho de outro usuário via /Drafts.
// Fallback 1: SQLQueries em ODRF/DRF1. Fallback 2: dados do próprio pedido de aprovação.
const sqlQuery = require('../../core/sqlQuery');
const DRAFT_HDR = {
  code: 'PB_DRAFT_HDR', name: 'Portal B1 - cabecalho de rascunho',
  sql: 'SELECT T0."DocEntry", T0."DocNum", T0."DocType", T0."DocDate", T0."ReqDate", T0."DocTotal", T0."DocCur", T0."ReqName", T0."Requester", T0."Comments", T0."AtcEntry", ' +
       'T0."ObjType", T0."CardCode", T0."CardName", T0."DocDueDate", T0."NumAtCard" ' +
       'FROM "ODRF" T0 WHERE T0."DocEntry" = :entry'
};
const DRAFT_LINES = {
  code: 'PB_DRAFT_LIN', name: 'Portal B1 - linhas de rascunho',
  sql: 'SELECT T0."LineNum", T0."ItemCode", T0."Dscription", T0."Quantity", T0."unitMsr", T0."Price", T0."LineTotal", ' +
       'T0."PQTReqDate", T0."OcrCode", T0."WhsCode", T0."LineVendor", T0."FreeTxt", T0."AcctCode", T0."ShipDate", T0."AgrNo" FROM "DRF1" T0 WHERE T0."DocEntry" = :entry ORDER BY T0."LineNum"'
};
const warned = new Set();

// OPRQ/ODRF de solicitação não expõe DocTotal no SL (B1 10.0: "Property 'DocTotal' of 'Document' is invalid").
// Total = soma das linhas.
const docTotal = (d) => (d.DocTotal !== undefined && d.DocTotal !== null)
  ? d.DocTotal
  : (d.DocumentLines || []).reduce((acc, l) => acc + (Number(l.LineTotal) || 0), 0);

async function readDraft(tenant, ctx, entry, withLines) {
  try {
    return await sl.request(tenant, ctx.cookie, 'GET', withLines ? `/Drafts(${Number(entry)})`
      : `/Drafts(${Number(entry)})?$select=DocEntry,DocNum,DocType,DocObjectCode,DocDate,DocDueDate,RequriedDate,DocCurrency,Requester,RequesterName,CardCode,CardName,Comments,AttachmentEntry,DocumentLines`);
  } catch (e) {
    if (!warned.has(tenant.id)) { warned.add(tenant.id); console.error(`[compras] leitura /Drafts(${entry}) recusada: ${e.message} — usando SQLQueries`); }
  }
  try {
    const h = (await sqlQuery.run(tenant, ctx, DRAFT_HDR, { entry: Number(entry) }, 1)).rows[0];
    if (!h) return null;
    const lines = withLines ? (await sqlQuery.run(tenant, ctx, DRAFT_LINES, { entry: Number(entry) }, 200)).rows : [];
    return {
      DocEntry: h.DocEntry, DocNum: h.DocNum, DocDate: h.DocDate, RequriedDate: h.ReqDate, DocTotal: h.DocTotal,
      DocCurrency: h.DocCur, Requester: h.Requester, RequesterName: h.ReqName, Comments: h.Comments,
      DocType: h.DocType === 'S' ? 'dDocument_Service' : 'dDocument_Items', AttachmentEntry: h.AtcEntry || null,
      DocObjectCode: (KINDS[kindByObj(h.ObjType)] || {}).draftCode, CardCode: h.CardCode, CardName: h.CardName,
      DocDueDate: h.DocDueDate, NumAtCard: h.NumAtCard,
      DocumentLines: lines.map((l) => ({
        LineNum: l.LineNum, ItemCode: l.ItemCode, ItemDescription: l.Dscription, Quantity: l.Quantity, MeasureUnit: l.unitMsr,
        UnitPrice: l.Price, LineTotal: l.LineTotal, RequiredDate: l.PQTReqDate, CostingCode: l.OcrCode,
        WarehouseCode: l.WhsCode, LineVendor: l.LineVendor, FreeText: l.FreeTxt, AccountCode: l.AcctCode,
        ShipDate: l.ShipDate, AgreementNo: l.AgrNo
      }))
    };
  } catch (e) {
    console.error(`[compras] leitura do rascunho ${entry} via SQLQueries falhou: ${e.message}`);
    return null;
  }
}

/** Executa fn em paralelo com no máximo `n` chamadas simultâneas, preservando a ordem. */
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

/**
 * Cabeçalhos de vários rascunhos numa única chamada (/Drafts com filtro por DocEntry, 20 por vez),
 * em vez de um GET por rascunho — cada GET entra na fila da sessão do SL.
 */
async function readDraftHeaders(tenant, ctx, entries) {
  const out = new Map();
  const list = [...new Set(entries.map(Number).filter(Boolean))];
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    try {
      const rows = await sl.getAll(tenant, ctx.cookie,
        `/Drafts?$select=DocEntry,DocNum,DocType,DocObjectCode,DocDate,DocDueDate,RequriedDate,DocCurrency,Requester,RequesterName,CardCode,CardName,Comments,DocumentLines` +
        `&$filter=${chunk.map((e) => `DocEntry eq ${e}`).join(' or ')}`, 100);
      rows.forEach((d) => out.set(Number(d.DocEntry), d));
    } catch (e) {
      if (e.status === 401) throw e;
      // aprovador sem permissão de ler rascunho alheio: tenta um a um (usa o fallback SQL do readDraft)
      for (const entry of chunk) {
        const d = await readDraft(tenant, ctx, entry, false).catch(() => null);
        if (d) out.set(entry, d);
      }
    }
  }
  return out;
}

const userNames = new Map();
async function userName(tenant, ctx, internalKey) {
  const key = `${tenant.id}:${internalKey}`;
  if (userNames.has(key)) return userNames.get(key);
  let name = '';
  try {
    const r = await sl.request(tenant, ctx.cookie, 'GET', `/Users?$select=UserName,UserCode&$filter=InternalKey eq ${Number(internalKey)}`);
    const u = (r.value || [])[0];
    name = u ? (u.UserName || u.UserCode) : '';
  } catch (_) { /* sem permissão */ }
  userNames.set(key, name);
  return name;
}

const approvalsSql = require('./approvalsSql');

/**
 * Pedidos de aprovação indexados pelo rascunho. spec = { owner } ou { draft } usa SQL (rápido);
 * sem SQL liberado, cai no OData com filterExtra.
 */
async function approvalsForDrafts(tenant, ctx, filterExtra, objs = [OBJ_PURCHASE_REQUEST], spec = null) {
  let rows = null;
  if (spec && spec.owner !== undefined) rows = await approvalsSql.byOwner(tenant, ctx, spec.owner);
  else if (spec && spec.draft !== undefined) rows = await approvalsSql.byDraft(tenant, ctx, spec.draft);
  if (!rows) {
    const extra = String(filterExtra || '').replace(/^\s*and\s+/i, '');
    rows = await sl.getAll(tenant, ctx.cookie, `/ApprovalRequests${extra ? `?$filter=${extra}` : ''}`, 1000);
  }
  const byDraft = new Map();
  // Depois de gerado o documento, o OWDD passa a IsDraft "N" e ObjectEntry = documento criado;
  // DraftEntry continua apontando o rascunho de origem -> não filtrar por IsDraft.
  rows.filter((a) => objs.includes(String(a.ObjectType)) && (a.DraftEntry !== null && a.DraftEntry !== undefined || isDraftFlag(a.IsDraft)))
    .forEach((a) => byDraft.set(draftKey(a), a));
  return byDraft;
}

async function listMyRequests(tenant, ctx, user, kind) {
  const u = enc(q(user.userCode));
  const sel = '$select=DocEntry,DocNum,DocType,DocDate,RequriedDate,DocCurrency,DocumentStatus,Cancelled,Comments,AttachmentEntry,DocumentLines';
  const [docs, drafts, approvals] = await Promise.all([
    sl.getAll(tenant, ctx.cookie, `/PurchaseRequests?${sel}&$filter=Requester eq '${u}'&$orderby=DocEntry desc`, 100),
    sl.getAll(tenant, ctx.cookie, `/Drafts?${sel}&$filter=DocObjectCode eq 'oPurchaseRequest' and Requester eq '${u}'&$orderby=DocEntry desc`, 100),
    approvalsForDrafts(tenant, ctx, ` and OriginatorID eq ${Number(user.internalKey)}`, undefined, { owner: user.internalKey })
  ]);
  const out = [];
  drafts.forEach((d) => {
    const a = approvals.get(d.DocEntry);
    const status = a ? mapApprovalStatus(a.Status) : 'DRAFT';
    if (status === 'GENERATED') return; // já virou documento
    out.push(summary('draft', d, status, a));
  });
  docs.forEach((d) => out.push(summary('doc', d, mapDocStatus(d))));
  const want = kind === 'service' ? 'service' : kind === 'items' ? 'items' : null;
  return out.filter((x) => !want || x.docType === want).sort((a, b) => String(b.docDate).localeCompare(String(a.docDate)));
}

const kindOf = (d) => (d.DocType === 'dDocument_Service' ? 'service' : 'items');

function summary(source, d, status, approval) {
  return {
    source,
    docType: kindOf(d),
    entry: d.DocEntry,
    docNum: d.DocNum,
    docDate: d.DocDate,
    requiredDate: d.RequriedDate,
    dueDate: d.DocDueDate || null,
    cardCode: d.CardCode || '',
    cardName: d.CardName || '',
    total: docTotal(d),
    currency: d.DocCurrency,
    comments: d.Comments || '',
    status,
    approvalCode: approval ? approval.Code : null
  };
}

async function getRequest(tenant, ctx, source, entry, kind = 'pr') {
  let approval = null;
  if (source === 'draft') {
    const map = await approvalsForDrafts(tenant, ctx, ` and DraftEntry eq ${Number(entry)}`, ALL_OBJ, { draft: entry });
    approval = map.get(Number(entry)) || null;
  }
  let d = source === 'draft'
    ? await readDraft(tenant, ctx, entry, true)
    : await sl.request(tenant, ctx.cookie, 'GET', `/${KINDS[kind].coll}(${Number(entry)})`);
  if (!d) {
    if (!approval) throw new sl.SLError(404, 'NOT_FOUND', 'Rascunho não encontrado ou sem permissão de leitura');
    d = { DocEntry: Number(entry), DocDate: approval.CreationDate, RequesterName: await userName(tenant, ctx, approval.OriginatorID), Comments: approval.Remarks || '', DocumentLines: [] };
  }
  // No rascunho, o tipo real vem do próprio ODRF (ou do pedido de aprovação)
  if (source === 'draft') kind = kindByDraftCode(d.DocObjectCode) || (approval && kindByObj(approval.ObjectType)) || kind;
  let generated = null;
  const ap = approval && mapApproval(approval);
  if (ap && ap.generatedEntry) {
    try {
      const g = await sl.request(tenant, ctx.cookie, 'GET', `/${KINDS[kind].coll}(${ap.generatedEntry})?$select=DocEntry,DocNum`);
      generated = { entry: g.DocEntry, docNum: g.DocNum };
    } catch (_) { generated = { entry: ap.generatedEntry, docNum: null }; }
  }
  return {
    kind,
    source,
    generated,
    docType: kindOf(d),
    attachmentEntry: d.AttachmentEntry || null,
    entry: d.DocEntry,
    docNum: d.DocNum,
    docDate: d.DocDate,
    requiredDate: d.RequriedDate,
    dueDate: d.DocDueDate || null,
    cardCode: d.CardCode || '',
    cardName: d.CardName || '',
    numAtCard: d.NumAtCard || '',
    branch: d.BPL_IDAssignedToInvoice ?? null,
    requester: d.Requester,
    requesterName: d.RequesterName,
    total: docTotal(d),
    currency: d.DocCurrency,
    comments: d.Comments || '',
    status: source === 'draft' ? (approval ? mapApprovalStatus(approval.Status) : 'DRAFT') : mapDocStatus(d),
    approval: approval && mapApproval(approval),
    lines: (d.DocumentLines || []).map((l) => ({
      lineNum: l.LineNum,
      itemCode: l.ItemCode,
      itemName: l.ItemDescription,
      quantity: l.Quantity,
      uom: l.UoMCode || l.MeasureUnit || '',
      unitPrice: l.UnitPrice ?? l.Price,
      lineTotal: l.LineTotal,
      requiredDate: l.RequiredDate,
      shipDate: l.ShipDate || null,
      costCenter: l.CostingCode,
      warehouse: l.WarehouseCode,
      vendor: l.LineVendor,
      freeText: l.FreeText,
      accountCode: l.AccountCode,
      agreementNo: l.AgreementNo || null,
      baseType: l.BaseType ?? null,
      baseEntry: l.BaseEntry ?? null,
      lineStatus: l.LineStatus
    }))
  };
}

function mapApproval(a) {
  return {
    code: a.Code,
    status: mapApprovalStatus(a.Status),
    currentStage: a.CurrentStage,
    originatorId: a.OriginatorID,
    createdAt: a.CreationDate,
    remarks: a.Remarks || '',
    draftEntry: draftKey(a),
    generatedEntry: a.DraftEntry !== null && a.DraftEntry !== undefined && a.ObjectEntry ? Number(a.ObjectEntry) : null,
    steps: (a.ApprovalRequestLines || []).map((l) => ({
      stage: l.StageCode,
      userId: l.UserID,
      status: mapApprovalStatus(l.Status),
      remarks: l.Remarks || '',
      date: l.UpdateDate || null
    }))
  };
}

// ---------- Aprovação ----------
const APPROVAL_SEL = '$select=Code,ObjectType,IsDraft,Status,CurrentStage,DraftEntry,ObjectEntry,OriginatorID,CreationDate,Remarks,ApprovalRequestLines';

// Pendências por usuário: o contador da tela inicial e a lista de aprovações usam a mesma leitura (20 s de cache)
const pendingCache = new Map();
const PENDING_TTL = 20000;
const clearPending = (tenant) => { for (const k of pendingCache.keys()) if (k.startsWith(`${tenant.id}:`)) pendingCache.delete(k); };
const noAnyFilter = new Set(); // empresas cujo SL não aceita any() em ApprovalRequestLines

async function pendingForUser(tenant, ctx, user) {
  const key = `${tenant.id}:${user.internalKey}`;
  const hit = pendingCache.get(key);
  if (hit && Date.now() - hit.at < PENDING_TTL) return hit.value;
  const p = pendingForUserLoad(tenant, ctx, user);
  pendingCache.set(key, { at: Date.now(), value: p });
  p.catch(() => pendingCache.delete(key));
  return p;
}

async function pendingForUserLoad(tenant, ctx, user) {
  // SQL já traz só os pedidos em que o usuário é aprovador da etapa atual (o OData traz os de todos)
  let rows = await approvalsSql.pendingFor(tenant, ctx, user.internalKey);
  // OData: tenta filtrar no SL só os pedidos em que o usuário tem decisão pendente
  if (!rows && !noAnyFilter.has(tenant.id)) {
    try {
      rows = await sl.getAll(tenant, ctx.cookie, `/ApprovalRequests?${APPROVAL_SEL}&$filter=Status eq 'arsPending' and ` +
        `ApprovalRequestLines/any(l: l/UserID eq ${Number(user.internalKey)} and l/Status eq 'ardPending')`, 2000);
    } catch (e) {
      if (e.status === 401) throw e;
      noAnyFilter.add(tenant.id);
      rows = null;
    }
  }
  if (!rows) try {
    rows = await sl.getAll(tenant, ctx.cookie, `/ApprovalRequests?${APPROVAL_SEL}&$filter=Status eq 'arsPending'`, 2000);
  } catch (_) { // versão do SL que não aceita $select nesses campos
    rows = await sl.getAll(tenant, ctx.cookie, `/ApprovalRequests?$filter=Status eq 'arsPending'`, 2000);
  }
  const isPR = (a) => ALL_OBJ.includes(String(a.ObjectType)) && isDraftFlag(a.IsDraft);
  // Linhas (WDD1) usam o enum de decisão "ardPending"; aceita também "ars*".
  const isPending = (st) => /Pending$/i.test(String(st || ''));
  const myLine = (a, stageOnly) => (a.ApprovalRequestLines || []).some((l) =>
    Number(l.UserID) === Number(user.internalKey) && isPending(l.Status) &&
    (!stageOnly || a.CurrentStage === undefined || a.CurrentStage === null || Number(l.StageCode) === Number(a.CurrentStage)));
  return rows.filter((a) => isPR(a) && myLine(a, true));
}

/** Contagem rápida de "Minhas solicitações" (abertas + em aprovação) via $count, sem ler documentos. */
async function countMyRequests(tenant, ctx, user) {
  const u = enc(q(user.userCode));
  const count = async (path) => Number(await sl.request(tenant, ctx.cookie, 'GET', path)) || 0;
  const flow = `OriginatorID eq ${Number(user.internalKey)} and (Status eq 'arsPending' or Status eq 'arsApproved')`;
  let inApproval;
  // as duas contagens em paralelo
  const [open, viaSql] = await Promise.all([
    count(`/PurchaseRequests/$count?$filter=Requester eq '${u}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`),
    approvalsSql.byOwner(tenant, ctx, user.internalKey)
  ]);
  if (viaSql) {
    inApproval = viaSql.filter((a) => String(a.ObjectType) === OBJ_PURCHASE_REQUEST && ['arsPending', 'arsApproved'].includes(a.Status)).length;
  } else try {
    inApproval = await count(`/ApprovalRequests/$count?$filter=${flow} and ObjectType eq '${OBJ_PURCHASE_REQUEST}'`);
  } catch (_) {
    const rows = await sl.getAll(tenant, ctx.cookie, `/ApprovalRequests?$select=Code,ObjectType&$filter=${flow}`, 2000);
    inApproval = rows.filter((a) => String(a.ObjectType) === OBJ_PURCHASE_REQUEST).length;
  }
  return open + inApproval;
}

/** Só a contagem (tile da tela inicial), sem ler os rascunhos. */
async function countPendingApprovals(tenant, ctx, user) {
  return (await pendingForUser(tenant, ctx, user)).length;
}

async function listPendingApprovals(tenant, ctx, user) {
  const mine = await pendingForUser(tenant, ctx, user);
  mine.sort((a, b) => Number(b.Code) - Number(a.Code)); // mais recentes primeiro
  // Enriquecer com cabeçalho do rascunho (nº, total, datas, solicitante)
  // Cabeçalhos dos rascunhos em paralelo (até 8 por vez) em vez de um por um
  // Via SQL o cabeçalho do rascunho já vem junto (_draft); só lê pelo SL o que faltar
  const headMap = await readDraftHeaders(tenant, ctx, mine.slice(0, 100).filter((a) => !a._draft).map(draftKey));
  const heads = mine.slice(0, 100).map((a) => a._draft || headMap.get(draftKey(a)) || null);
  const out = [];
  for (const [idx, a] of mine.slice(0, 100).entries()) {
    const d = heads[idx] || {};
    out.push({
      kind: kindByObj(a.ObjectType),
      cardName: d.CardName || '',
      approvalCode: a.Code,
      draftEntry: draftKey(a),
      docType: d.DocType ? kindOf(d) : 'items',
      docNum: d.DocNum ?? draftKey(a),
      docDate: d.DocDate || a.CreationDate,
      requiredDate: d.RequriedDate,
      requester: d.RequesterName || d.Requester || (await userName(tenant, ctx, a.OriginatorID)),
      total: docTotal(d),
      currency: d.DocCurrency,
      comments: d.Comments || a.Remarks || ''
    });
  }
  return out;
}

async function decide(tenant, ctx, approvalCode, approve, remarks) {
  clearPending(tenant);
  await sl.request(tenant, ctx.cookie, 'PATCH', `/ApprovalRequests(${Number(approvalCode)})`, {
    ApprovalRequestDecisions: [{ Status: approve ? 'ardApproved' : 'ardNotApproved', Remarks: remarks || '' }]
  });
  const a = await sl.request(tenant, ctx.cookie, 'GET', `/ApprovalRequests(${Number(approvalCode)})`);
  return mapApproval(a);
}

/** Efetiva o rascunho aprovado em Solicitação de Compra (ação do originador, como no B1). */
/**
 * Efetiva o rascunho aprovado em Solicitação de compra (ação do originador, como no B1).
 * O SL trata o corpo como a versão do documento a gravar: enviar só o DocEntry faz o B1 entender
 * que o rascunho foi alterado após a aprovação (234000127). Por isso enviamos o rascunho COMPLETO,
 * exatamente como está gravado (sem metadados OData).
 */
async function finalizeDraft(tenant, ctx, draftEntry) {
  const draft = await sl.request(tenant, ctx.cookie, 'GET', `/Drafts(${Number(draftEntry)})`);
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === 'object') {
      const out = {};
      Object.entries(o).forEach(([k, v]) => { if (!k.startsWith('odata.') && !k.startsWith('@odata')) out[k] = clean(v); });
      return out;
    }
    return o;
  };
  try {
    await sl.request(tenant, ctx.cookie, 'POST', '/DraftsService_SaveDraftToDocument', { Document: clean(draft) });
  } catch (e) {
    if (/234000127/.test(String(e.code)) || /updated after it was approved/i.test(e.message)) {
      throw new sl.SLError(409, e.code,
        'O B1 considera que este rascunho foi alterado depois da aprovação. Abra o rascunho no SAP e adicione por lá (o B1 reenviará para aprovação, se necessário).');
    }
    throw e;
  }
  return { ok: true };
}

/** DocEntry a partir do número visível (DocNum) do documento. */
async function entryByDocNum(tenant, ctx, kind, docNum) {
  const r = await sl.request(tenant, ctx.cookie, 'GET', `/${KINDS[kind].coll}?$select=DocEntry&$filter=DocNum eq ${Number(docNum)}&$orderby=DocEntry desc&$top=1`);
  return ((r.value || [])[0] || {}).DocEntry || null;
}

/** Contatos de usuários B1 (para notificações por e-mail). Aceita InternalKey (número) ou UserCode (texto). */
async function usersContact(tenant, ctx, ids) {
  const keys = [...new Set((ids || []).filter((x) => x !== null && x !== undefined && x !== ''))];
  if (!keys.length) return [];
  const f = keys.map((k) => (typeof k === 'number' || /^\d+$/.test(k)) ? `InternalKey eq ${Number(k)}` : `UserCode eq '${enc(q(k))}'`).join(' or ');
  try {
    const r = await sl.request(tenant, ctx.cookie, 'GET', `/Users?$select=InternalKey,UserCode,UserName,eMail&$filter=${f}`);
    return (r.value || []).map((u) => ({ key: u.InternalKey, code: u.UserCode, name: u.UserName || u.UserCode, email: u.eMail || '' }));
  } catch (e) {
    console.error(`[notificacao] leitura de usuários falhou: ${e.message}`);
    return [];
  }
}

module.exports = {
  name: 'service-layer',
  warmup, mapLimit, entryByDocNum, readDraftHeaders, clearPending,
  KINDS, kindByObj, createDocument, seriesForBranch, docTotal, mapDocStatus, approvalsForDrafts, mapApprovalStatus, summary, readDraft,
  usersContact,
  searchItems, listCostCenters, listWarehouses, listBranches, searchVendors,
  createPurchaseRequest, listMyRequests, getRequest,
  listPendingApprovals, countPendingApprovals, countMyRequests, decide, finalizeDraft
};
