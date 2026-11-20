'use strict';
/**
 * Skill de demonstração (só MOCK=1): pedidos em aberto com entrega vencida, agrupados por faixa de atraso.
 * Determinística: mesmos dados -> mesmos achados. Não lê nem grava no SAP.
 */
const DAY = 864e5;

function detect({ params, today = new Date() }) {
  const db = require('../../../compras/mock')._db; // dados sintéticos do modo demonstração
  const bands = [...(params.bands || [30, 90, 180])].sort((a, b) => b - a); // maior faixa primeiro
  const t0 = Date.parse(today.toISOString().slice(0, 10));
  const groups = new Map();
  (db.po || []).filter((p) => p.status === 'OPEN' && p.dueDate).forEach((p) => {
    const days = Math.floor((t0 - Date.parse(String(p.dueDate).slice(0, 10))) / DAY);
    const band = bands.find((b) => days > b);
    if (band === undefined) return;
    if (!groups.has(band)) groups.set(band, []);
    groups.get(band).push({ p, days });
  });
  return [...groups.entries()].map(([band, list]) => {
    const total = Math.round(list.reduce((s, x) => s + Number(x.p.total || 0), 0) * 100) / 100;
    return {
      naturalKey: `late-po:>${band}`,
      severity: band >= 180 ? 'alta' : band >= 90 ? 'media' : 'baixa',
      metricValue: list.length,
      threshold: band,
      impactBRL: total,
      data: { band, count: list.length, total, oldestDays: Math.max(...list.map((x) => x.days)) },
      evidence: list.map(({ p, days }) => ({
        kind: 'po', docEntry: p.entry, docNum: p.docNum, cardCode: p.cardCode,
        values: { dueDate: p.dueDate, daysLate: days, total: p.total, cardName: p.cardName }
      }))
    };
  });
}

/** Texto e atalho determinísticos (sem LLM na etapa 1). */
function describe(f) {
  const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return {
    title: `${f.data.count} pedido(s) em aberto com entrega vencida há mais de ${f.data.band} dias`,
    explanation: `Somam ${money(f.data.total)}. O mais antigo está ${f.data.oldestDays} dias atrasado. ` +
      'Confirme com o fornecedor se ainda serão entregues; os que não serão devem ser encerrados no SAP para liberar o saldo comprometido.',
    action: { type: 'open_list', route: 'compras.orders', params: {}, label: 'Revisar pedidos' }
  };
}

module.exports = { detect, describe };
