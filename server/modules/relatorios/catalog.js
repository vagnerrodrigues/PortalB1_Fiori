'use strict';
/**
 * Catálogo de relatórios padrão do Portal B1.
 * Cada relatório vira um objeto SQLQueries no B1 (código PB_R_<id>) e roda com o usuário logado.
 *
 * SQL portável HANA / SQL Server: identificadores SEMPRE entre aspas duplas, sem funções
 * específicas de banco. Parâmetros: :nome (valores entram via ParamList do Service Layer).
 *
 * Tipos de coluna: text | number | money | date
 * Tipos de parâmetro: date | text   | default: today | monthStart | yearStart | texto fixo
 *
 * Relatórios adicionais por cliente: config/reports.json (mesmo formato, sem código).
 */

// gerador determinístico para os dados de demonstração
function rng(seed) { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

const CUSTOMERS = [['C0001', 'Alfa Indústria e Comércio Ltda'], ['C0002', 'Beta Distribuidora S.A.'], ['C0003', 'Gama Serviços Ltda'], ['C0004', 'Delta Alimentos Ltda'], ['C0005', 'Ômega Engenharia Ltda']];
const VENDORS = [['F0001', 'Metalúrgica Paulista Ltda'], ['F0002', 'EPI Brasil Distribuidora Ltda'], ['F0003', 'TechStore Informática Ltda'], ['F0004', 'Transportadora Rápida Ltda']];
const ITEMS = [['MP-0001', 'Aço carbono chapa 2mm'], ['MP-0002', 'Parafuso sextavado M8'], ['MC-0100', 'Luva de segurança nitrílica'], ['TI-0500', 'Notebook 14" i5 16GB'], ['ES-0010', 'Papel A4 75g (resma)']];

function openDocs(list, seed) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const [code, name] = list[i % list.length];
    const total = Math.round(r() * 40000 + 800);
    const paid = r() > 0.6 ? Math.round(total * r() * 0.7) : 0;
    rows.push({ DocNum: 3000 + i * 7, CardCode: code, CardName: name, DocDueDate: addDays(Math.round(r() * 60 - 25)), DocTotal: total, PaidToDate: paid, Saldo: total - paid });
  }
  return rows.sort((a, b) => a.DocDueDate.localeCompare(b.DocDueDate));
}

function byPartner(list, seed) {
  const r = rng(seed);
  return list.map(([code, name]) => ({ CardCode: code, CardName: name, Documentos: Math.round(r() * 30 + 2), Total: Math.round(r() * 250000 + 5000) }))
    .sort((a, b) => b.Total - a.Total);
}

module.exports = [
  {
    id: 'receber-aberto',
    title: 'Contas a receber em aberto',
    category: 'Financeiro',
    description: 'Notas fiscais de saída com saldo em aberto, por vencimento',
    params: [],
    columns: [
      { key: 'DocNum', label: 'Nº NF', type: 'text' }, { key: 'CardCode', label: 'Cliente', type: 'text' },
      { key: 'CardName', label: 'Nome', type: 'text' }, { key: 'DocDueDate', label: 'Vencimento', type: 'date' },
      { key: 'DocTotal', label: 'Total', type: 'money' }, { key: 'PaidToDate', label: 'Pago', type: 'money' },
      { key: 'Saldo', label: 'Saldo', type: 'money', sum: true }
    ],
    sql: 'SELECT T0."DocNum", T0."CardCode", T0."CardName", T0."DocDueDate", T0."DocTotal", T0."PaidToDate", ' +
         '(T0."DocTotal" - T0."PaidToDate") AS "Saldo" FROM "OINV" T0 ' +
         'WHERE T0."DocStatus" = \'O\' AND T0."CANCELED" = \'N\' ORDER BY T0."DocDueDate"',
    mock: () => openDocs(CUSTOMERS, 7)
  },
  {
    id: 'pagar-aberto',
    title: 'Contas a pagar em aberto',
    category: 'Financeiro',
    description: 'Notas fiscais de entrada com saldo em aberto, por vencimento',
    params: [],
    columns: [
      { key: 'DocNum', label: 'Nº doc.', type: 'text' }, { key: 'CardCode', label: 'Fornecedor', type: 'text' },
      { key: 'CardName', label: 'Nome', type: 'text' }, { key: 'DocDueDate', label: 'Vencimento', type: 'date' },
      { key: 'DocTotal', label: 'Total', type: 'money' }, { key: 'PaidToDate', label: 'Pago', type: 'money' },
      { key: 'Saldo', label: 'Saldo', type: 'money', sum: true }
    ],
    sql: 'SELECT T0."DocNum", T0."CardCode", T0."CardName", T0."DocDueDate", T0."DocTotal", T0."PaidToDate", ' +
         '(T0."DocTotal" - T0."PaidToDate") AS "Saldo" FROM "OPCH" T0 ' +
         'WHERE T0."DocStatus" = \'O\' AND T0."CANCELED" = \'N\' ORDER BY T0."DocDueDate"',
    mock: () => openDocs(VENDORS, 13)
  },
  {
    id: 'vendas-cliente',
    title: 'Vendas por cliente',
    category: 'Vendas',
    description: 'Total faturado por cliente no período (NF de saída não canceladas)',
    params: [
      { name: 'dataInicio', label: 'De', type: 'date', default: 'monthStart' },
      { name: 'dataFim', label: 'Até', type: 'date', default: 'today' }
    ],
    columns: [
      { key: 'CardCode', label: 'Cliente', type: 'text' }, { key: 'CardName', label: 'Nome', type: 'text' },
      { key: 'Documentos', label: 'Notas', type: 'number', sum: true }, { key: 'Total', label: 'Total', type: 'money', sum: true }
    ],
    sql: 'SELECT T0."CardCode", T0."CardName", COUNT(T0."DocEntry") AS "Documentos", SUM(T0."DocTotal") AS "Total" ' +
         'FROM "OINV" T0 WHERE T0."CANCELED" = \'N\' AND T0."DocDate" >= :dataInicio AND T0."DocDate" <= :dataFim ' +
         'GROUP BY T0."CardCode", T0."CardName" ORDER BY SUM(T0."DocTotal") DESC',
    mock: () => byPartner(CUSTOMERS, 21)
  },
  {
    id: 'compras-fornecedor',
    title: 'Compras por fornecedor',
    category: 'Compras',
    description: 'Total em pedidos de compra por fornecedor no período',
    params: [
      { name: 'dataInicio', label: 'De', type: 'date', default: 'monthStart' },
      { name: 'dataFim', label: 'Até', type: 'date', default: 'today' }
    ],
    columns: [
      { key: 'CardCode', label: 'Fornecedor', type: 'text' }, { key: 'CardName', label: 'Nome', type: 'text' },
      { key: 'Documentos', label: 'Pedidos', type: 'number', sum: true }, { key: 'Total', label: 'Total', type: 'money', sum: true }
    ],
    sql: 'SELECT T0."CardCode", T0."CardName", COUNT(T0."DocEntry") AS "Documentos", SUM(T0."DocTotal") AS "Total" ' +
         'FROM "OPOR" T0 WHERE T0."CANCELED" = \'N\' AND T0."DocDate" >= :dataInicio AND T0."DocDate" <= :dataFim ' +
         'GROUP BY T0."CardCode", T0."CardName" ORDER BY SUM(T0."DocTotal") DESC',
    mock: () => byPartner(VENDORS, 33)
  },
  {
    id: 'solicitacoes-abertas',
    title: 'Solicitações de compra em aberto',
    category: 'Compras',
    description: 'Itens solicitados ainda não atendidos, por data necessária',
    params: [],
    columns: [
      { key: 'DocNum', label: 'Nº', type: 'text' }, { key: 'ReqDate', label: 'Necessário em', type: 'date' },
      { key: 'ReqName', label: 'Solicitante', type: 'text' }, { key: 'ItemCode', label: 'Item', type: 'text' },
      { key: 'Dscription', label: 'Descrição', type: 'text' }, { key: 'OpenQty', label: 'Qtd. aberta', type: 'number' }
    ],
    sql: 'SELECT T0."DocNum", T0."ReqDate", T0."ReqName", T1."ItemCode", T1."Dscription", T1."OpenQty" ' +
         'FROM "OPRQ" T0 INNER JOIN "PRQ1" T1 ON T0."DocEntry" = T1."DocEntry" ' +
         'WHERE T0."DocStatus" = \'O\' AND T1."LineStatus" = \'O\' ORDER BY T0."ReqDate"',
    mock: () => {
      const r = rng(5);
      return Array.from({ length: 9 }, (_, i) => {
        const [code, name] = ITEMS[i % ITEMS.length];
        return { DocNum: 100 + i, ReqDate: addDays(Math.round(r() * 20)), ReqName: i % 2 ? 'Ana Requisitante' : 'João Almoxarifado', ItemCode: code, Dscription: name, OpenQty: Math.round(r() * 50 + 1) };
      }).sort((a, b) => a.ReqDate.localeCompare(b.ReqDate));
    }
  },
  {
    id: 'estoque-deposito',
    title: 'Estoque por depósito',
    category: 'Estoque',
    description: 'Em estoque, comprometido, pedido e disponível por item e depósito',
    params: [{ name: 'deposito', label: 'Depósito (vazio = todos)', type: 'text', default: '' }],
    columns: [
      { key: 'ItemCode', label: 'Item', type: 'text' }, { key: 'ItemName', label: 'Descrição', type: 'text' },
      { key: 'WhsCode', label: 'Depósito', type: 'text' }, { key: 'OnHand', label: 'Em estoque', type: 'number' },
      { key: 'IsCommited', label: 'Comprometido', type: 'number' }, { key: 'OnOrder', label: 'Pedido', type: 'number' },
      { key: 'Disponivel', label: 'Disponível', type: 'number' }
    ],
    sql: 'SELECT T0."ItemCode", T1."ItemName", T0."WhsCode", T0."OnHand", T0."IsCommited", T0."OnOrder", ' +
         '(T0."OnHand" - T0."IsCommited") AS "Disponivel" FROM "OITW" T0 ' +
         'INNER JOIN "OITM" T1 ON T0."ItemCode" = T1."ItemCode" ' +
         'WHERE (T0."OnHand" <> 0 OR T0."OnOrder" <> 0) AND (T0."WhsCode" = :deposito OR :deposito = \'\') ' +
         'ORDER BY T0."ItemCode", T0."WhsCode"',
    mock: (p) => {
      const r = rng(9);
      const rows = [];
      ITEMS.forEach(([code, name]) => ['01', '02'].forEach((w) => {
        const on = Math.round(r() * 300);
        const com = Math.round(on * r() * 0.5);
        rows.push({ ItemCode: code, ItemName: name, WhsCode: w, OnHand: on, IsCommited: com, OnOrder: Math.round(r() * 80), Disponivel: on - com });
      }));
      return p.deposito ? rows.filter((x) => x.WhsCode === p.deposito) : rows;
    }
  }
];
