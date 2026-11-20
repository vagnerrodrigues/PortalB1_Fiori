'use strict';
/** S2 — Qualidade de dados fiscais/cadastrais. Lê só o espelho. Determinística. Sem impacto financeiro direto. */

function detect({ repo, params }) {
  const out = [];
  if (params.checkCfop !== false) {
    const rows = repo.wh(`SELECT p.doc_entry, p.doc_num, p.card_code, p.card_name, l.line_num, l.item_code, l.item_name
      FROM wh_po p JOIN wh_po_line l ON l.tenant_id = p.tenant_id AND l.doc_entry = p.doc_entry
      WHERE p.tenant_id = ? AND p.status = 'O' AND p.canceled = 0 AND l.line_status = 'O' AND (l.cfop IS NULL OR l.cfop = '')
      ORDER BY p.doc_num, l.line_num`);
    if (rows.length) {
      out.push({
        naturalKey: 'fiscal:po-no-cfop', severity: 'alta', metricValue: rows.length, threshold: 0,
        data: { kind: 'po-no-cfop', count: rows.length, docs: new Set(rows.map((r) => r.doc_entry)).size },
        evidence: rows.map((r) => ({ kind: 'po', docEntry: r.doc_entry, docNum: r.doc_num, lineNum: r.line_num, cardCode: r.card_code, itemCode: r.item_code,
          values: { cardName: r.card_name, itemName: r.item_name } }))
      });
    }
  }
  if (params.checkVendorState !== false) {
    const rows = repo.wh("SELECT card_code, card_name FROM wh_vendor WHERE tenant_id = ? AND active = 1 AND (state IS NULL OR state = '') ORDER BY card_code");
    if (rows.length) {
      out.push({
        naturalKey: 'fiscal:vendor-no-state', severity: 'media', metricValue: rows.length, threshold: 0,
        data: { kind: 'vendor-no-state', count: rows.length },
        evidence: rows.map((r) => ({ kind: 'vendor', cardCode: r.card_code, values: { cardName: r.card_name } }))
      });
    }
  }
  if (params.checkItemWarehouse !== false) {
    const rows = repo.wh("SELECT item_code, item_name FROM wh_item WHERE tenant_id = ? AND active = 1 AND purchase = 1 AND (default_wh IS NULL OR default_wh = '') ORDER BY item_code");
    if (rows.length) {
      out.push({
        naturalKey: 'fiscal:item-no-wh', severity: 'baixa', metricValue: rows.length, threshold: 0,
        data: { kind: 'item-no-wh', count: rows.length },
        evidence: rows.map((r) => ({ kind: 'item', itemCode: r.item_code, values: { itemName: r.item_name } }))
      });
    }
  }
  return out;
}

function describe(f) {
  const d = f.data;
  if (d.kind === 'po-no-cfop') {
    return {
      title: `${d.count} linha(s) de ${d.docs} pedido(s) em aberto sem CFOP`,
      explanation: 'Sem CFOP o SAP recusa o recebimento dessas linhas ("Please Input CFOP Code"). Preencha a Utilização/CFOP no pedido ou configure a Utilização padrão do fornecedor/item.',
      action: { type: 'open_list', route: 'compras.orders', params: {}, label: 'Abrir pedidos' }
    };
  }
  if (d.kind === 'vendor-no-state') {
    return {
      title: `${d.count} fornecedor(es) ativo(s) sem UF no endereço de cobrança`,
      explanation: 'Sem a UF, o portal não consegue decidir o CFOP de entrada dentro/fora do estado quando o pedido vem sem CFOP. Corrija o endereço no cadastro do fornecedor.',
      action: { type: 'open_list', route: 'parceiros.list', params: {}, label: 'Abrir parceiros' }
    };
  }
  return {
    title: `${d.count} item(ns) de compra sem depósito padrão`,
    explanation: 'Solicitações e recebimentos desses itens dependem de o usuário escolher o depósito manualmente. Defina o depósito padrão no cadastro do item (SAP › Dados do item › Dados de estoque).',
    action: { type: 'info', route: null, params: {}, label: 'Corrigir no SAP (cadastro do item)' }
  };
}

module.exports = { detect, describe };
