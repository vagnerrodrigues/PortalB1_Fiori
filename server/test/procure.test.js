'use strict';
/** Ciclo de compras (mock): acesso de comprador, cotação online, mapa, pedidos, contratos e aprovação de pedido. */
process.env.MOCK = '1';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-settings-'));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-data-'));
process.env.PORTAL_SECRET = 'teste';
const assert = require('assert');
const app = require('../index');
const mailer = require('../core/mailer');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function main() {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie, headers = H) => {
    const r = await fetch(base + p, { method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    const json = await r.json().catch(() => null);
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (u) => (await call('POST', '/api/login', { tenantId: 'demo', userName: u, password: '1234' })).cookie;
  const ok = (msg) => console.log('  ✔', msg);

  try {
    const req = await login('requisitante');
    const buy = await login('comprador');
    const apr = await login('aprovador');

    // habilita e-mail (saída em arquivo) para validar convites
    await call('PUT', '/api/m/admin/settings', {
      general: { portalUrl: 'https://portal.demo.com' },
      email: { enabled: true, host: 'outbox', port: 587, security: 'starttls', fromAddress: 'portal@demo.com' }
    }, apr);

    // ---------- acesso por tile ----------
    const meReq = (await call('GET', '/api/me', null, req)).json;
    const reqTiles = meReq.modules.find((m) => m.id === 'compras').tiles.map((t) => t.id);
    assert.deepStrictEqual(reqTiles, ['new', 'mine', 'approvals']);
    const meBuy = (await call('GET', '/api/me', null, buy)).json;
    assert.ok(['rfq', 'offers', 'orders', 'contracts'].every((t) => meBuy.modules.find((m) => m.id === 'compras').tiles.some((x) => x.id === t)));
    assert.strictEqual((await call('GET', '/api/m/compras/rfq', null, req)).status, 403);
    assert.strictEqual((await call('GET', '/api/m/compras/orders', null, req)).status, 403);
    ok('telas de comprador só para compradores (requisitante recebe 403)');

    // ---------- solicitação que vira insumo da cotação ----------
    const pr = await call('POST', '/api/m/compras/purchase-requests', {
      requiredDate: day(10), lines: [
        { itemCode: 'MC-0100', quantity: 20, unitPrice: 10, costCenter: 'PROD', warehouse: '02' },
        { itemCode: 'MC-0101', quantity: 15, unitPrice: 12, costCenter: 'PROD', warehouse: '02' }
      ]
    }, req);
    assert.strictEqual(pr.json.source, 'doc');
    const src = (await call('GET', '/api/m/compras/rfq/sources', null, buy)).json;
    const mine = src.filter((l) => l.prEntry === pr.json.entry);
    assert.strictEqual(mine.length, 2);
    ok('linhas em aberto da solicitação disponíveis para cotação');

    // ---------- cotação ----------
    assert.strictEqual((await call('POST', '/api/m/compras/rfq', { deadline: day(-1), lines: [], suppliers: [] }, buy)).status, 400);
    const sentBefore = mailer.sent.length;
    const created = await call('POST', '/api/m/compras/rfq', {
      title: 'EPIs produção', deadline: day(5),
      lines: mine.map((l) => ({ ...l })).concat([{ itemCode: 'ES-0010', itemName: 'Papel A4', uom: 'CX', quantity: 4 }]),
      suppliers: [{ cardCode: 'F0001' }, { cardCode: 'F0002' }, { cardCode: 'F0004', email: 'papelaria@demo.com' }]
    }, buy);
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const rfq = created.json;
    assert.strictEqual(rfq.suppliers.length, 3);
    assert.ok(rfq.suppliers.every((s) => s.pq && s.pq.entry && s.link.startsWith('https://portal.demo.com/cotacao/')));
    const invites = mailer.sent.slice(sentBefore).filter((m) => m.subject.startsWith(`Cotação nº ${rfq.id}`));
    assert.strictEqual(invites.length, 3);
    ok('cotação cria 1 oferta de compra por fornecedor e envia convites com link exclusivo');

    const offers = (await call('GET', '/api/m/compras/offers', null, buy)).json;
    assert.ok(rfq.suppliers.every((s) => offers.some((o) => o.entry === s.pq.entry)));
    const pqDoc = (await call('GET', `/api/m/compras/docs/pq/doc/${rfq.suppliers[0].pq.entry}`, null, buy)).json;
    assert.strictEqual(pqDoc.lines.length, 3);
    assert.strictEqual(pqDoc.lines[0].baseEntry, pr.json.entry);
    ok('ofertas de compra nativas vinculadas à solicitação (BaseEntry)');

    // ---------- página pública ----------
    const tok = (s) => s.link.split('/').pop();
    const [s1, s2, s3] = rfq.suppliers;
    assert.strictEqual((await call('GET', '/api/public/compras/cotacao/tokeninvalido1234567890')).status, 404);
    const pub = await call('GET', `/api/public/compras/cotacao/${tok(s1)}`);
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(pub.json.supplier.cardCode, 'F0001');
    assert.strictEqual(pub.json.lines.length, 3);
    assert.ok(pub.json.open);
    assert.ok(!('token' in pub.json) && !JSON.stringify(pub.json).includes(tok(s2)));
    const page = await fetch(`${base}/cotacao/${tok(s1)}`);
    assert.strictEqual(page.status, 200);
    assert.ok((await page.text()).includes('cotacao'));
    ok('fornecedor abre só a própria cotação pelo link (sem login)');

    const noPrice = await call('POST', `/api/public/compras/cotacao/${tok(s1)}`, { lines: [{ key: 0, quoted: true, unitPrice: 0 }] });
    assert.strictEqual(noPrice.status, 400);
    const ans1 = await call('POST', `/api/public/compras/cotacao/${tok(s1)}`, {
      paymentTerms: '28 ddl', freight: 'CIF', validUntil: day(20), proposalRef: 'PROP-77',
      lines: [{ key: 0, quoted: true, unitPrice: 9.8, deliveryDate: day(7) }, { key: 1, quoted: true, unitPrice: 14 }, { key: 2, quoted: false }]
    });
    assert.strictEqual(ans1.status, 200, JSON.stringify(ans1.json));
    const ans2 = await call('POST', `/api/public/compras/cotacao/${tok(s2)}`, {
      paymentTerms: '30/60', freight: 'FOB',
      lines: [{ key: 0, quoted: true, unitPrice: 10.5, deliveryDate: day(4) }, { key: 1, quoted: true, unitPrice: 11.2 }, { key: 2, quoted: true, unitPrice: 25 }]
    });
    assert.strictEqual(ans2.status, 200);
    const dec = await call('POST', `/api/public/compras/cotacao/${tok(s3)}`, { decline: true, reason: 'Sem estoque' });
    assert.strictEqual(dec.json.declined, true);
    const noAjax = await fetch(`${base}/api/public/compras/cotacao/${tok(s1)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(noAjax.status, 403);
    assert.ok(mailer.sent.some((m) => m.subject === `Cotação nº ${rfq.id}: Metalúrgica Paulista Ltda respondeu`));
    ok('fornecedores respondem/declinam; comprador é avisado por e-mail');

    // ---------- mapa + sincronização com o B1 ----------
    const synced = (await call('POST', `/api/m/compras/rfq/${rfq.id}/sync`, null, buy)).json;
    assert.ok(synced.suppliers.filter((s) => s.status === 'ANSWERED').every((s) => s.sync === 'SYNCED'));
    const pq1 = (await call('GET', `/api/m/compras/docs/pq/doc/${s1.pq.entry}`, null, buy)).json;
    assert.strictEqual(pq1.lines[0].unitPrice, 9.8);
    assert.strictEqual(pq1.numAtCard, 'PROP-77');
    assert.strictEqual(pq1.lines[2].freeText, 'NÃO COTADO');
    const m = synced.map;
    assert.strictEqual(m.lines[0].bestCardCode, 'F0001');
    assert.strictEqual(m.lines[1].bestCardCode, 'F0002');
    assert.strictEqual(m.lines[2].bestCardCode, 'F0002');
    assert.strictEqual(m.summary.bestSingle.cardCode, 'F0002'); // único que cotou tudo
    assert.strictEqual(m.summary.bestMix, Math.round((20 * 9.8 + 15 * 11.2 + 4 * 25) * 100) / 100);
    assert.deepStrictEqual(m.lines[0].recommended, { price: 'F0001', speed: 'F0002', balance: 'F0002' });
    assert.ok(m.lines[0].offers.find((o) => o.cardCode === 'F0002').fastest);
    assert.strictEqual(m.lines[0].offers.find((o) => o.cardCode === 'F0001').leadDays, 7);
    assert.ok(m.byCriterion.speed.avgDays <= m.byCriterion.price.avgDays);
        ok('respostas gravadas nas ofertas do B1; mapa aponta menor preço por item e melhor fornecedor único');
    ok('recomendação por critério: menor preço, entrega mais rápida e equilíbrio preço x prazo');

    // comprador lança resposta recebida por telefone
    const manual = await call('POST', `/api/m/compras/rfq/${rfq.id}/suppliers/F0004/answer`, {
      lines: [{ key: 2, quoted: true, unitPrice: 22.9, deliveryDate: day(3) }]
    }, buy);
    assert.strictEqual(manual.status, 200, JSON.stringify(manual.json));
    assert.strictEqual(manual.json.map.lines[2].bestCardCode, 'F0004');
    ok('comprador lança proposta recebida por fora do link');

    // ---------- adjudicação -> pedidos ----------
    const bad = await call('POST', `/api/m/compras/rfq/${rfq.id}/award`, { selection: [{ key: 2, cardCode: 'F0001' }] }, buy);
    assert.strictEqual(bad.status, 400);
    const aw = await call('POST', `/api/m/compras/rfq/${rfq.id}/award`, {
      selection: [{ key: 0, cardCode: 'F0001' }, { key: 1, cardCode: 'F0002' }, { key: 2, cardCode: 'F0004' }]
    }, buy);
    assert.strictEqual(aw.status, 200, JSON.stringify(aw.json));
    assert.strictEqual(aw.json.status, 'AWARDED');
    assert.strictEqual(aw.json.award.orders.length, 3);
    const po1 = aw.json.award.orders.find((o) => o.cardCode === 'F0001');
    const poDoc = (await call('GET', `/api/m/compras/docs/po/doc/${po1.entry}`, null, buy)).json;
    assert.strictEqual(poDoc.lines.length, 1);
    assert.strictEqual(poDoc.lines[0].unitPrice, 9.8);
    assert.strictEqual(poDoc.lines[0].baseEntry, s1.pq.entry);
    const again = await call('POST', `/api/m/compras/rfq/${rfq.id}/award`, {}, buy);
    assert.strictEqual(again.status, 400);
    const closedPub = (await call('GET', `/api/public/compras/cotacao/${tok(s1)}`)).json;
    assert.strictEqual(closedPub.open, false);
    ok('vencedores viram pedidos de compra copiados da oferta; cotação encerrada para fornecedores');

    // ---------- mapa de relações ----------
    const rel = (await call('GET', `/api/m/compras/docs/po/doc/${po1.entry}/relations`, null, buy)).json;
    const kinds = rel.nodes.map((n) => n.kind).sort();
    assert.ok(['pr', 'rfq', 'pq', 'po'].every((k) => kinds.includes(k)), JSON.stringify(kinds));
    assert.ok(rel.nodes.find((n) => n.kind === 'po' && n.entry === po1.entry).current);
    const rk = `rfq:${rfq.id}`;
    assert.ok(rel.edges.some((e) => e.from === `pr:${pr.json.entry}` && e.to === rk));
    assert.ok(rel.edges.some((e) => e.from === rk && e.to === `pq:${s1.pq.entry}`));
    assert.ok(rel.edges.some((e) => e.from === `pq:${s1.pq.entry}` && e.to === `po:${po1.entry}`));
    assert.strictEqual(rel.nodes.filter((n) => n.kind === 'pq').length, 3); // as 3 ofertas da cotação
    ok('mapa de relações: solicitação → cotação → ofertas → pedido');

    // ---------- contrato guarda-chuva + pedido consumindo ----------
    const agBad = await call('POST', '/api/m/compras/agreements', { cardCode: 'F0003', startDate: day(10), endDate: day(1), description: '', method: 'item', lines: [] }, buy);
    assert.strictEqual(agBad.status, 400);
    const ag = await call('POST', '/api/m/compras/agreements', {
      cardCode: 'F0003', startDate: day(0), endDate: day(365), description: 'Monitores 2026', method: 'item',
      lines: [{ itemCode: 'TI-0501', plannedQty: 50, unitPrice: 899 }]
    }, buy);
    assert.strictEqual(ag.status, 201);
    const active = (await call('GET', '/api/m/compras/agreements?cardCode=F0003&active=1', null, buy)).json;
    assert.strictEqual(active[0].lines[0].unitPrice, 899);
    const po = await call('POST', '/api/m/compras/orders', {
      cardCode: 'F0003', dueDate: day(15),
      lines: [{ itemCode: 'TI-0501', quantity: 3, unitPrice: 899, agreementNo: ag.json.agreementNo, agreementLine: 0, warehouse: '03' }]
    }, buy);
    assert.strictEqual(po.status, 201);
    assert.strictEqual(po.json.source, 'doc');
    const agAfter = (await call('GET', `/api/m/compras/agreements/${ag.json.agreementNo}`, null, buy)).json;
    assert.strictEqual(agAfter.lines[0].usedQty, 3);
    assert.strictEqual(agAfter.lines[0].openQty, 47);
    ok('contrato guarda-chuva criado e consumido pelo pedido (saldo atualizado)');
    const relAg = (await call('GET', `/api/m/compras/docs/po/doc/${po.json.entry}/relations`, null, buy)).json;
    assert.ok(relAg.edges.some((e) => e.from === `ag:${ag.json.agreementNo}` && e.to === `po:${po.json.entry}`));
    ok('mapa de relações mostra o contrato consumido pelo pedido');

    // ---------- pedido acima do limite: aprovação ----------
    const bigPo = await call('POST', '/api/m/compras/orders', {
      cardCode: 'F0003', dueDate: day(15), lines: [{ itemCode: 'TI-0500', quantity: 2, unitPrice: 4500 }]
    }, buy);
    assert.strictEqual(bigPo.json.source, 'draft');
    const pend = (await call('GET', '/api/m/compras/approvals', null, apr)).json;
    const item = pend.find((a) => a.draftEntry === bigPo.json.entry);
    assert.strictEqual(item.kind, 'po');
    assert.strictEqual(item.cardName, 'TechStore Informática');
    const draftView = await call('GET', `/api/m/compras/docs/po/draft/${bigPo.json.entry}`, null, apr);
    assert.strictEqual(draftView.json.kind, 'po');
    await call('POST', `/api/m/compras/approvals/${item.approvalCode}/decision`, { approve: true }, apr);
    assert.strictEqual((await call('POST', `/api/m/compras/docs/po/draft/${bigPo.json.entry}/finalize`, null, apr)).status, 403);
    const fin = await call('POST', `/api/m/compras/docs/po/draft/${bigPo.json.entry}/finalize`, null, buy);
    assert.strictEqual(fin.status, 200);
    const orders = (await call('GET', '/api/m/compras/orders', null, buy)).json;
    assert.ok(orders.some((o) => o.source === 'doc' && o.entry === fin.json.entry));
    ok('pedido acima da alçada vai para aprovação e o comprador gera após aprovado');

    const counters = (await call('GET', '/api/m/compras/counters', null, buy)).json;
    assert.ok(counters.orders >= 4);
    ok('contadores de pedidos/cotações para o comprador');

    const y = new Date().getFullYear();
    assert.strictEqual((await call('GET', `/api/m/compras/dashboard?year=${y}`, null, req)).status, 403);
    const dash = (await call('GET', `/api/m/compras/dashboard?year=${y}&refresh=1`, null, buy)).json;
    assert.ok(dash.orders.count >= 4 && dash.orders.monthly.length === 12);
    assert.ok(dash.orders.total > 0 && dash.orders.topVendors.length > 0);
    assert.strictEqual(dash.rfq.awarded, 1);
    assert.ok(dash.rfq.saving > 0, 'economia da cotação adjudicada');
    assert.ok(dash.agreements.active >= 2);
    ok('painel do comprador: compras no ano, atrasados, economia das cotações e contratos');

    console.log('\nCiclo de compras: todos os testes passaram.');
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
