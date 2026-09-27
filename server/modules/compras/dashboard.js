'use strict';
/**
 * Painel do comprador (tela inicial): compras do ano, pedidos em aberto/atrasados, economia das
 * cotações online e contratos guarda-chuva. Cache de 10 min por empresa/ano: o painel é o mesmo para
 * todos os compradores e não deve disputar a fila da sessão do Service Layer a cada visita.
 */
const store = require('../../core/store');

const TTL = 10 * 60000;
const cache = new Map();
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function orderStats(orders) {
  const valid = orders.filter((o) => o.status !== 'CANCELLED');
  const monthly = Array(12).fill(0);
  valid.forEach((o) => { const m = Number(String(o.date).slice(5, 7)) - 1; if (m >= 0 && m < 12) monthly[m] += o.total; });
  const open = valid.filter((o) => o.status === 'OPEN');
  const late = open.filter((o) => o.dueDate && o.dueDate < today());
  const byVendor = new Map();
  valid.forEach((o) => {
    const v = byVendor.get(o.cardCode) || { cardCode: o.cardCode, cardName: o.cardName, total: 0, count: 0 };
    v.total += o.total; v.count += 1;
    byVendor.set(o.cardCode, v);
  });
  const sum = (a) => round2(a.reduce((s, o) => s + o.total, 0));
  return {
    count: valid.length, total: sum(valid), monthly: monthly.map(round2),
    open: { count: open.length, total: sum(open) },
    late: { count: late.length, total: sum(late), oldest: late.map((o) => o.dueDate).sort()[0] || null },
    topVendors: [...byVendor.values()].sort((a, b) => b.total - a.total).slice(0, 5).map((v) => ({ ...v, total: round2(v.total) }))
  };
}

/**
 * Economia das cotações online adjudicadas: para cada item comprado,
 * (média das propostas válidas − preço escolhido) × quantidade.
 */
function rfqStats(tenantId, year, buildMap) {
  const list = store.list('rfq', tenantId).filter((r) => String(r.createdAt).startsWith(String(year)));
  let saving = 0; let bought = 0; let invited = 0; let answered = 0;
  list.forEach((r) => {
    invited += r.suppliers.length;
    answered += r.suppliers.filter((s) => s.status === 'ANSWERED').length;
    if (!r.award) return;
    const map = buildMap(r);
    r.award.lines.forEach((a) => {
      const l = map.lines.find((x) => x.key === a.key);
      const quoted = l ? l.offers.filter((o) => o.quoted) : [];
      const chosen = quoted.find((o) => o.cardCode === a.cardCode);
      if (!chosen) return;
      const avg = quoted.reduce((s, o) => s + o.unitPrice, 0) / quoted.length;
      saving += (avg - chosen.unitPrice) * l.quantity;
      bought += chosen.total;
    });
  });
  return {
    count: list.length,
    open: list.filter((r) => r.status === 'OPEN' && r.deadline >= today()).length,
    awarded: list.filter((r) => r.award).length,
    responseRate: invited ? Math.round((answered / invited) * 100) : null,
    saving: round2(saving),
    savingPct: bought + saving > 0 ? Math.round((saving / (bought + saving)) * 1000) / 10 : null
  };
}

function agreementStats(list) {
  const active = list.filter((a) => a.status === 'ACTIVE');
  const planned = active.reduce((s, a) => s + (a.plannedAmount || 0), 0);
  const used = active.reduce((s, a) => s + (a.usedAmount || 0), 0);
  const limit = addDays(60);
  return {
    active: active.length,
    planned: round2(planned), used: round2(used),
    consumption: planned ? Math.round((used / planned) * 1000) / 10 : null,
    expiring: active.filter((a) => a.endDate && a.endDate <= limit).length,
    overConsumed: active.filter((a) => a.consumption !== null && a.consumption >= 90).length
  };
}

async function build({ tenant, ctx, b1, year, buildMap }) {
  const key = `${tenant.id}:${year}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  // Em sequência (e não em paralelo): a sessão do SL atende uma chamada por vez
  const orders = await b1.ordersForYear(tenant, ctx, year).catch((e) => { console.error('[painel] pedidos:', e.message); return null; });
  const agreements = await b1.listAgreements(tenant, ctx, {}).catch((e) => { console.error('[painel] contratos:', e.message); return null; });
  const value = {
    year: Number(year), generatedAt: new Date().toISOString(),
    orders: orders ? orderStats(orders) : null,
    rfq: rfqStats(tenant.id, year, buildMap),
    agreements: agreements ? agreementStats(agreements) : null
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

const clear = (tenantId) => { for (const k of cache.keys()) if (k.startsWith(`${tenantId}:`)) cache.delete(k); };

module.exports = { build, clear, orderStats, rfqStats, agreementStats };
