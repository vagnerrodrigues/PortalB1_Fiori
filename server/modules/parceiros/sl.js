'use strict';
/**
 * Parceiros de negócio via objetos NATIVOS:
 *  - BusinessPartners (OCRD)                     -> consulta e cadastro
 *  - BPFiscalTaxIDCollection (CRD7, loc. Brasil)  -> CNPJ (TaxId0), IE (TaxId1), CPF (TaxId4)
 *  - BPAddresses (CRD1) / ContactEmployees (OCPR)
 * O portal cadastra somente como LEAD (CardType cLid); o time de cadastro completa e converte no B1.
 */
const sl = require('../../core/slClient');
const sqlQuery = require('../../core/sqlQuery');
const br = require('./br');

const q = (s) => String(s || '').replace(/'/g, "''");
const enc = encodeURIComponent;
const TYPES = { customer: 'cCustomer', supplier: 'cSupplier', lead: 'cLid' };
const TYPE_BACK = { cCustomer: 'customer', cSupplier: 'supplier', cLid: 'lead' };

const TAXID_QUERY = {
  code: 'PB_BP_TAXID',
  name: 'Portal B1 - PN por CNPJ/CPF',
  sql: 'SELECT DISTINCT T0."CardCode", T1."CardName", T1."CardType" FROM "CRD7" T0 ' +
       'INNER JOIN "OCRD" T1 ON T0."CardCode" = T1."CardCode" ' +
       'WHERE T0."TaxId0" = :cnpj OR T0."TaxId4" = :cpf'
};

function mapSummary(b) {
  return {
    cardCode: b.CardCode,
    cardName: b.CardName,
    tradeName: b.CardForeignName || '',
    type: TYPE_BACK[b.CardType] || 'customer',
    phone: b.Phone1 || '',
    email: b.EmailAddress || '',
    city: b.City || '',
    balance: b.CurrentAccountBalance,
    active: b.Valid !== 'tNO' && b.Frozen !== 'tYES'
  };
}

/** Busca por CNPJ/CPF (CRD7) quando o termo é numérico; senão por nome/código/fantasia. */
async function search(tenant, ctx, { term, type }) {
  const sel = '$select=CardCode,CardName,CardForeignName,CardType,Phone1,EmailAddress,City,CurrentAccountBalance,Valid,Frozen';
  const d = br.digits(term);
  if (d.length === 11 || d.length === 14) {
    const { hits } = await findByTaxId(tenant, ctx, d);
    const out = [];
    for (const h of hits.slice(0, 20)) {
      out.push(mapSummary(await sl.request(tenant, ctx.cookie, 'GET', `/BusinessPartners('${enc(q(h.cardCode))}')?${sel}`)));
    }
    return out.filter((b) => !type || b.type === type);
  }
  const filters = [];
  if (type && TYPES[type]) filters.push(`CardType eq '${TYPES[type]}'`);
  if (term) {
    const t = enc(q(term));
    filters.push(`(contains(CardName,'${t}') or contains(CardCode,'${t}') or contains(CardForeignName,'${t}'))`);
  }
  const filter = filters.length ? `&$filter=${filters.join(' and ')}` : '';
  const r = await sl.request(tenant, ctx.cookie, 'GET', `/BusinessPartners?${sel}${filter}&$orderby=CardName&$top=50`);
  return (r.value || []).map(mapSummary);
}

/**
 * Procura PN pelo CNPJ/CPF. Três estratégias, na ordem, porque cada ambiente libera coisas diferentes:
 *  1) SQLQueries em CRD7 (exige CRD7 liberada no b1s_sqltable.conf do Service Layer)
 *  2) Filtro OData na coleção BPFiscalTaxIDCollection (any)
 *  3) Campo FederalTaxID (OCRD.LicTradNum) com e sem máscara
 * Retorna { hits, checked }: checked=false quando nenhuma estratégia pôde ser executada.
 */
const taxIdStrategy = new Map(); // tenant -> estratégia que funcionou (evita repetir as que falham)

async function findByTaxId(tenant, ctx, taxId) {
  const d = br.digits(taxId);
  const masked = d.length === 14 ? br.maskCNPJ(d) : br.maskCPF(d);
  const field = d.length === 14 ? 'TaxId0' : 'TaxId4';
  const map = (rows) => rows.map((r) => ({ cardCode: r.CardCode, cardName: r.CardName, type: TYPE_BACK[r.CardType] }));
  const strategies = {
    sql: async () => map((await sqlQuery.run(tenant, ctx, TAXID_QUERY, {
      cnpj: d.length === 14 ? masked : '-', cpf: d.length === 11 ? masked : '-'
    }, 20)).rows),
    any: async () => map((await sl.request(tenant, ctx.cookie, 'GET',
      `/BusinessPartners?$select=CardCode,CardName,CardType&$filter=BPFiscalTaxIDCollection/any(t: t/${field} eq '${enc(masked)}')&$top=20`)).value || []),
    federal: async () => map((await sl.request(tenant, ctx.cookie, 'GET',
      `/BusinessPartners?$select=CardCode,CardName,CardType&$filter=FederalTaxID eq '${enc(masked)}' or FederalTaxID eq '${d}'&$top=20`)).value || [])
  };
  const order = taxIdStrategy.has(tenant.id) ? [taxIdStrategy.get(tenant.id)] : ['sql', 'any', 'federal'];
  for (const name of order) {
    try {
      const hits = await strategies[name]();
      taxIdStrategy.set(tenant.id, name);
      return { hits, checked: true, via: name };
    } catch (e) {
      console.error(`[parceiros] duplicidade por ${name} indisponível: ${e.message}`);
      if (taxIdStrategy.get(tenant.id) === name) taxIdStrategy.delete(tenant.id);
    }
  }
  return { hits: [], checked: false };
}

async function get(tenant, ctx, cardCode) {
  const b = await sl.request(tenant, ctx.cookie, 'GET', `/BusinessPartners('${enc(q(cardCode))}')`);
  const fiscal = (b.BPFiscalTaxIDCollection || []).find((f) => !f.Address) || (b.BPFiscalTaxIDCollection || [])[0] || {};
  return {
    ...mapSummary(b),
    phone2: b.Phone2 || '',
    mobile: b.Cellular || '',
    website: b.Website || '',
    notes: b.FreeText || '',
    creditLimit: b.CreditLimit,
    taxId: fiscal.TaxId0 || fiscal.TaxId4 || '',
    stateRegistration: fiscal.TaxId1 || '',
    addresses: (b.BPAddresses || []).map((a) => ({
      name: a.AddressName,
      type: a.AddressType === 'bo_ShipTo' ? 'ship' : 'bill',
      street: a.Street, streetNo: a.StreetNo, complement: a.BuildingFloorRoom, block: a.Block,
      zipCode: a.ZipCode, city: a.City, state: a.State
    })),
    contacts: (b.ContactEmployees || []).map((c) => ({
      name: c.Name, phone: c.Phone1 || c.MobilePhone || '', email: c.E_Mail || '', position: c.Position || ''
    }))
  };
}

function leadCode() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `L${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function createLead(tenant, ctx, p) {
  const d = br.digits(p.taxId);
  const isCNPJ = d.length === 14;
  const addr = p.address || {};
  const address = (type) => ({
    AddressName: 'PRINCIPAL',
    AddressType: type,
    Street: addr.street || undefined,
    StreetNo: addr.streetNo || undefined,
    BuildingFloorRoom: addr.complement || undefined,
    Block: addr.block || undefined,
    ZipCode: addr.zipCode ? br.maskCEP(addr.zipCode) : undefined,
    City: addr.city || undefined,
    State: addr.state || undefined,
    Country: 'BR'
  });
  const body = {
    CardType: 'cLid',
    ...(tenant.bpLeadSeries ? { Series: tenant.bpLeadSeries } : { CardCode: leadCode() }),
    CardName: p.name.slice(0, 100),
    CardForeignName: p.tradeName ? p.tradeName.slice(0, 100) : undefined,
    Phone1: p.phone || undefined,
    EmailAddress: p.email || undefined,
    FreeText: p.notes || undefined,
    BPFiscalTaxIDCollection: [{
      Address: '',
      ...(isCNPJ ? { TaxId0: br.maskCNPJ(d) } : { TaxId4: br.maskCPF(d) }),
      ...(p.stateRegistration ? { TaxId1: p.stateRegistration } : {})
    }],
    BPAddresses: addr.street || addr.zipCode ? [address('bo_BillTo'), address('bo_ShipTo')] : undefined,
    ContactEmployees: p.contact && p.contact.name
      ? [{ Name: p.contact.name.slice(0, 50), Phone1: p.contact.phone || undefined, E_Mail: p.contact.email || undefined }]
      : undefined
  };
  const created = await sl.request(tenant, ctx.cookie, 'POST', '/BusinessPartners', body);
  return { cardCode: created.CardCode, cardName: created.CardName };
}

module.exports = { search, findByTaxId, get, createLead };
