'use strict';
/**
 * Fonte do espelho no MODO DEMONSTRAÇÃO (MOCK=1): monta pedidos, fornecedores e itens a partir dos dados
 * sintéticos do módulo Compras, no mesmo formato que o warehouse grava a partir do SAP.
 * Inclui de propósito alguns "defeitos" (linha sem CFOP, fornecedor sem UF, item sem depósito) para as skills terem o que achar.
 */
const ITEMS = [['MP-0001', 'Aço carbono chapa 2mm', '01'], ['MP-0002', 'Parafuso sextavado M8', '01'], ['MC-0100', 'Luva de segurança nitrílica', null],
  ['TI-0500', 'Notebook 14" i5 16GB', '02'], ['ES-0010', 'Papel A4 75g (resma)', '01']];

function orders() {
  const db = require('../compras/mock')._db;
  return (db.po || []).map((p, i) => {
    const [code, name] = ITEMS[i % ITEMS.length];
    const lines = (p.lines && p.lines.length ? p.lines : [{ lineNum: 0, itemCode: code, itemName: name, quantity: 1, openQty: p.status === 'OPEN' ? 1 : 0, unitPrice: p.total }])
      .map((l, k) => ({
        lineNum: l.lineNum ?? k, itemCode: l.itemCode, itemName: l.itemName, quantity: l.quantity, openQty: l.openQty ?? (p.status === 'OPEN' ? l.quantity : 0),
        price: l.unitPrice ?? l.price, lineTotal: l.lineTotal ?? (l.quantity * (l.unitPrice || 0)), shipDate: p.dueDate, lineStatus: p.status === 'OPEN' ? 'O' : 'C',
        cfop: (p.entry + k) % 3 === 0 ? null : '1102', usage: '9', baseType: null, baseEntry: null, agreementNo: l.agreementNo || null
      }));
    return { docEntry: p.entry, docNum: p.docNum, cardCode: p.cardCode, cardName: p.cardName, docDate: String(p.docDate).slice(0, 10), dueDate: p.dueDate ? String(p.dueDate).slice(0, 10) : null,
      status: p.status === 'OPEN' ? 'O' : 'C', canceled: p.status === 'CANCELLED', bplId: null, updateDate: String(p.docDate).slice(0, 10), lines };
  });
}

function vendors() {
  const seen = new Map();
  orders().forEach((o) => { if (o.cardCode && !seen.has(o.cardCode)) seen.set(o.cardCode, o.cardName); });
  return [...seen.entries()].map(([code, name], i) => ({ cardCode: code, cardName: name, active: true, email: i === 1 ? null : `compras@${code.toLowerCase()}.com.br`,
    state: i === 1 ? null : 'SP', updateDate: '2026-01-01' }));
}

const items = () => ITEMS.map(([code, name, wh]) => ({ itemCode: code, itemName: name, purchase: true, active: true, defaultWh: wh, groupCode: 100, updateDate: '2026-01-01' }));

module.exports = { po: orders, vendor: vendors, item: items };
