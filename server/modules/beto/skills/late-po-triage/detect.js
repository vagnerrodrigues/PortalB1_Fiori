'use strict';
/**
 * S1 — Pedidos atrasados. Lê só o espelho (wh_po / wh_po_line). Determinística.
 * Atraso = hoje − data de entrega do pedido (DocDueDate), para pedidos abertos, não cancelados, com saldo em aberto.
 * Valor em aberto = Σ (quantidade em aberto × preço) das linhas abertas (moeda do documento).
 */
const DAY = 864e5;
const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const round2 = (n) => Math.round(n * 100) / 100;

function detect({ repo, params, today = new Date() }) {
  const t0 = today.toISOString().slice(0, 10);
  const rows = repo.wh(`SELECT p.doc_entry, p.doc_num, p.card_code, p.card_name, p.due_date,
      SUM(COALESCE(l.open_qty, 0) * COALESCE(l.price, 0)) AS open_value, COUNT(*) AS open_lines
    FROM wh_po p JOIN wh_po_line l ON l.tenant_id = p.tenant_id AND l.doc_entry = p.doc_entry
    WHERE p.tenant_id = ? AND p.status = 'O' AND p.canceled = 0 AND l.line_status = 'O' AND COALESCE(l.open_qty, 0) > 0
      AND p.due_date IS NOT NULL AND p.due_date < ?
    GROUP BY p.doc_entry, p.doc_num, p.card_code, p.card_name, p.due_date`, t0);
  const bands = [...(params.bands || [30, 90, 180])].map(Number).filter((n) => n > 0).sort((a, b) => b - a);
  const groups = new Map();
  rows.forEach((r) => {
    const days = Math.floor((Date.parse(t0) - Date.parse(r.due_date)) / DAY);
    const band = bands.find((b) => days > b);
    if (band === undefined) return;
    if (!groups.has(band)) groups.set(band, []);
    groups.get(band).push({ ...r, days });
  });
  return [...groups.entries()].map(([band, list]) => {
    list.sort((a, b) => b.days - a.days);
    const total = round2(list.reduce((s, x) => s + Number(x.open_value || 0), 0));
    const vendors = new Set(list.map((x) => x.card_code)).size;
    return {
      naturalKey: `late-po:>${band}`,
      severity: band >= 180 ? 'alta' : band >= 90 ? 'media' : 'baixa',
      metricValue: list.length, threshold: band, impactBRL: total,
      data: { band, count: list.length, total, vendors, oldestDays: list[0].days },
      evidence: list.map((x) => ({ kind: 'po', docEntry: x.doc_entry, docNum: x.doc_num, cardCode: x.card_code,
        values: { cardName: x.card_name, dueDate: x.due_date, daysLate: x.days, openValue: round2(x.open_value), openLines: x.open_lines } }))
    };
  });
}

function describe(f) {
  const d = f.data;
  return {
    title: `${d.count} pedido(s) em aberto com entrega vencida há mais de ${d.band} dias`,
    explanation: `Valor ainda em aberto: ${money(d.total)}, em ${d.vendors} fornecedor(es). O mais antigo está ${d.oldestDays} dias atrasado. ` +
      (d.band >= 180 ? 'Atrasos tão longos costumam ser pedidos esquecidos: confirme com o fornecedor e encerre no SAP os que não serão entregues.'
        : 'Cobre o fornecedor pela entrega ou ajuste a data prevista no pedido.'),
    action: { type: 'open_list', route: 'compras.orders', params: {}, label: 'Revisar pedidos' }
  };
}

module.exports = { detect, describe };
