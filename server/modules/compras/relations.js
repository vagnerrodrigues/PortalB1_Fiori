'use strict';
/**
 * Mapa de relações de um documento de compras: percorre os vínculos nativos do B1 nos dois sentidos
 * (solicitação → oferta → pedido → recebimento → nota fiscal / devolução) e acrescenta o que é do portal
 * (cotação online que gerou ofertas e pedidos) e o contrato guarda-chuva consumido.
 * Leituras em sequência (a sessão do SL atende uma por vez), no máximo MAX documentos.
 */
const store = require('../../core/store');

const MAX = 25;
const STAGE = { pr: 0, rfq: 1, pq: 2, ag: 2, po: 3, gr: 4, ap: 5, rt: 5, cm: 6 };
const keyOf = (kind, source, entry) => (source === 'draft' ? `draft:${entry}` : `${kind}:${entry}`);

async function build({ tenant, ctx, b1, kind, source, entry }) {
  const nodes = new Map();
  const edges = new Map();
  const addEdge = (from, to, label) => { if (from !== to) edges.set(`${from}>${to}`, { from, to, label: label || '' }); };
  const queue = [{ kind, source, entry: Number(entry) }];
  const seen = new Set();
  const startKey = keyOf(kind, source, entry);
  const agreements = new Set();

  while (queue.length && nodes.size < MAX) {
    const cur = queue.shift();
    const k = keyOf(cur.kind, cur.source, cur.entry);
    if (seen.has(k)) continue;
    seen.add(k);
    let info;
    try {
      info = cur.source === 'draft' ? await b1.draftLinks(tenant, ctx, cur.entry) : await b1.docLinks(tenant, ctx, cur.kind, cur.entry);
    } catch (e) {
      if (e.status === 401 && /sess/i.test(e.message)) throw e;
      nodes.set(k, { key: k, kind: cur.kind, source: cur.source, entry: cur.entry, docNum: null, error: 'Sem acesso ou não encontrado' });
      continue;
    }
    const nk = keyOf(info.node.kind, info.node.source, info.node.entry);
    nodes.set(nk, { key: nk, ...info.node, current: nk === startKey });
    info.links.forEach((l) => {
      const lk = keyOf(l.kind, 'doc', l.entry);
      if (l.dir === 'up') addEdge(lk, nk); else addEdge(nk, lk, l.generated ? 'gerado' : '');
      if (!seen.has(lk)) queue.push({ kind: l.kind, source: 'doc', entry: l.entry });
    });
    (info.agreements || []).forEach((no) => { agreements.add(no); addEdge(`ag:${no}`, nk, 'consumo'); });
  }

  // Contratos guarda-chuva consumidos pelos pedidos
  for (const no of agreements) {
    try {
      const a = await b1.getAgreement(tenant, ctx, no);
      nodes.set(`ag:${no}`, { key: `ag:${no}`, kind: 'ag', entry: no, docNum: no, date: a.startDate, total: a.plannedAmount,
        status: a.status, cardCode: a.cardCode, cardName: a.cardName, extra: a.consumption !== null ? `${a.consumption}% consumido` : '' });
    } catch (_) {
      nodes.set(`ag:${no}`, { key: `ag:${no}`, kind: 'ag', entry: no, docNum: no, error: 'Sem acesso' });
    }
  }

  // Cotação online do portal ligada às solicitações, ofertas ou pedidos do mapa
  const has = (kd, e) => nodes.has(`${kd}:${e}`);
  store.list('rfq', tenant.id).forEach((r) => {
    const touches = r.lines.some((l) => l.prEntry && has('pr', l.prEntry)) ||
      r.suppliers.some((s) => s.pq && s.pq.source === 'doc' && has('pq', s.pq.entry)) ||
      ((r.award && r.award.orders) || []).some((o) => o.source === 'doc' && has('po', o.entry));
    if (!touches) return;
    const rk = `rfq:${r.id}`;
    nodes.set(rk, { key: rk, kind: 'rfq', entry: r.id, docNum: r.id, date: String(r.createdAt).slice(0, 10), status: r.status,
      cardName: r.title, extra: `${r.suppliers.filter((s) => s.status === 'ANSWERED').length}/${r.suppliers.length} responderam` });
    [...new Set(r.lines.map((l) => l.prEntry).filter(Boolean))].forEach((e) => { if (has('pr', e)) addEdge(`pr:${e}`, rk); });
    r.suppliers.forEach((s) => {
      if (!s.pq || s.pq.source !== 'doc') return;
      const pk = `pq:${s.pq.entry}`;
      if (!nodes.has(pk) && nodes.size < MAX + 10) {
        nodes.set(pk, { key: pk, kind: 'pq', source: 'doc', entry: s.pq.entry, docNum: s.pq.docNum, cardName: s.cardName, status: s.pqClosed ? 'CLOSED' : 'OPEN' });
      }
      addEdge(rk, pk);
      // a cotação substitui o vínculo direto solicitação -> oferta no desenho
      [...edges.keys()].filter((ek) => ek.startsWith('pr:') && ek.endsWith(`>${pk}`)).forEach((ek) => edges.delete(ek));
    });
  });

  // Só arestas entre nós conhecidos
  const list = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return {
    // rascunho fica numa coluna própria antes do documento que ele gerou
    nodes: [...nodes.values()].map((n) => ({ ...n, stage: (STAGE[n.kind] ?? 3) - (n.source === 'draft' ? 0.5 : 0) })),
    edges: list,
    truncated: queue.length > 0
  };
}

module.exports = { build, STAGE };
