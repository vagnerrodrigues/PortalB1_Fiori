'use strict';
/** Teste ponta a ponta do fluxo da Fase 1 usando o adapter MOCK. Rodar: npm test */
process.env.MOCK = '1';
const assert = require('assert');
const app = require('../index');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

async function main() {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    const json = await r.json().catch(() => null);
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const ok = (msg) => console.log('  ✔', msg);

  try {
    // Login inválido
    assert.strictEqual((await call('POST', '/api/login', { tenantId: 'demo', userName: 'requisitante', password: 'x' })).status, 401);
    ok('login inválido rejeitado');

    // CSRF
    const noAjax = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(noAjax.status, 403);
    ok('mutação sem X-Requested-With bloqueada');

    const req = await call('POST', '/api/login', { tenantId: 'demo', userName: 'requisitante', password: '1234' });
    assert.strictEqual(req.status, 200);
    const rc = req.cookie;
    ok('login requisitante');

    assert.strictEqual((await call('GET', '/api/m/compras/purchase-requests')).status, 401);
    ok('rota protegida sem sessão -> 401');

    const items = await call('GET', '/api/m/compras/items?q=luva', null, rc);
    assert.ok(items.json.length === 1);
    ok('busca de item');

    // Validação
    const bad = await call('POST', '/api/m/compras/purchase-requests', { requiredDate: '2000-01-01', lines: [] }, rc);
    assert.strictEqual(bad.status, 400);
    ok('validação de payload');

    // Abaixo do limite -> documento direto
    const small = await call('POST', '/api/m/compras/purchase-requests', {
      requiredDate: future, lines: [{ itemCode: 'MC-0100', quantity: 10, unitPrice: 12.5, costCenter: 'PROD', warehouse: '02' }]
    }, rc);
    assert.strictEqual(small.status, 201);
    assert.strictEqual(small.json.source, 'doc');
    ok('solicitação abaixo do limite gerada direto (OPRQ)');

    // Acima do limite -> rascunho + aprovação
    const big = await call('POST', '/api/m/compras/purchase-requests', {
      requiredDate: future, comments: 'Notebooks novos colaboradores',
      lines: [{ itemCode: 'TI-0500', quantity: 2, unitPrice: 4500, costCenter: 'TI', warehouse: '03' }]
    }, rc);
    assert.strictEqual(big.json.source, 'draft');
    assert.strictEqual(big.json.status, 'PENDING');
    ok('solicitação acima do limite retida para aprovação (ODRF + OWDD)');

    const apr = (await call('POST', '/api/login', { tenantId: 'demo', userName: 'aprovador', password: '1234' })).cookie;
    const pend = await call('GET', '/api/m/compras/approvals', null, apr);
    assert.strictEqual(pend.json.length, 1);
    ok('aprovador vê 1 pendência');

    const noReason = await call('POST', `/api/m/compras/approvals/${pend.json[0].approvalCode}/decision`, { approve: false }, apr);
    assert.strictEqual(noReason.status, 400);
    ok('reprovação exige motivo');

    const dec = await call('POST', `/api/m/compras/approvals/${pend.json[0].approvalCode}/decision`, { approve: true, remarks: 'OK' }, apr);
    assert.strictEqual(dec.json.status, 'APPROVED');
    ok('aprovação registrada');

    const mine = await call('GET', '/api/m/compras/purchase-requests', null, rc);
    const d = mine.json.find((x) => x.source === 'draft');
    assert.strictEqual(d.status, 'APPROVED');
    ok('requisitante vê status APROVADO');

    const fin = await call('POST', `/api/m/compras/purchase-requests/draft/${d.entry}/finalize`, {}, rc);
    assert.strictEqual(fin.status, 200);
    const after = await call('GET', '/api/m/compras/purchase-requests', null, rc);
    assert.strictEqual(after.json.filter((x) => x.source === 'doc').length, 2);
    ok('rascunho efetivado em solicitação de compra');

    const det = await call('GET', `/api/m/compras/purchase-requests/doc/${after.json[0].entry}`, null, rc);
    assert.ok(det.json.lines.length === 1);
    ok('detalhe do documento');

    // ---------- Controle de acesso por módulo ----------
    const me = await call('GET', '/api/me', null, rc);
    assert.deepStrictEqual(me.json.modules.map((m) => m.id), ['compras', 'despesas', 'relatorios']);
    assert.strictEqual((await call('GET', '/api/m/parceiros?q=alfa', null, rc)).status, 403);
    ok('requisitante vê Compras + Despesas + Relatórios; Parceiros bloqueado (403)');

    const com = (await call('POST', '/api/login', { tenantId: 'demo', userName: 'comercial', password: '1234' })).cookie;
    const meC = await call('GET', '/api/me', null, com);
    assert.deepStrictEqual(meC.json.modules.map((m) => m.id), ['despesas', 'parceiros', 'relatorios']);
    assert.strictEqual((await call('GET', '/api/m/compras/purchase-requests', null, com)).status, 403);
    ok('comercial vê Despesas + Parceiros + Relatórios; Compras bloqueado (403)');

    const meA = await call('GET', '/api/me', null, apr);
    assert.strictEqual(meA.json.modules.length, 4);
    ok('superusuário vê todos os módulos');

    // ---------- Parceiros ----------
    const bps = await call('GET', '/api/m/parceiros?q=alfa', null, com);
    assert.strictEqual(bps.json[0].cardCode, 'C0001');
    const byDoc = await call('GET', '/api/m/parceiros?q=11222333000181', null, com);
    assert.strictEqual(byDoc.json[0].cardCode, 'C0001');
    ok('busca de PN por nome e por CNPJ');

    const sup = await call('GET', '/api/m/parceiros?type=supplier', null, com);
    assert.ok(sup.json.length === 3 && sup.json.every((b) => b.type === 'supplier'));
    ok('filtro por tipo (fornecedor)');

    const det2 = await call('GET', '/api/m/parceiros/C0001', null, com);
    assert.strictEqual(det2.json.taxId, '11.222.333/0001-81');
    ok('detalhe do PN com CNPJ (CRD7)');

    const badDoc = await call('POST', '/api/m/parceiros', { taxId: '11.222.333/0001-80', name: 'X' }, com);
    assert.strictEqual(badDoc.status, 400);
    ok('CNPJ com dígito inválido rejeitado');

    const dup = await call('POST', '/api/m/parceiros', { taxId: '11222333000181', name: 'Alfa de novo' }, com);
    assert.strictEqual(dup.status, 409);
    ok('duplicidade por CNPJ bloqueada (409)');

    const lead = await call('POST', '/api/m/parceiros', {
      taxId: '529.982.247-25', name: 'João da Silva', email: 'joao@exemplo.com',
      address: { zipCode: '01310100', street: 'Av. Paulista', streetNo: '1000', city: 'São Paulo', state: 'SP' },
      contact: { name: 'João', phone: '(11) 99999-0000' }
    }, com);
    assert.strictEqual(lead.status, 201);
    const leadDet = await call('GET', `/api/m/parceiros/${lead.json.cardCode}`, null, com);
    assert.strictEqual(leadDet.json.type, 'lead');
    ok('lead cadastrado com CPF, endereço e contato');

    // ---------- Relatórios ----------
    const cat = await call('GET', '/api/m/relatorios', null, rc);
    assert.ok(cat.json.length >= 6);
    ok(`catálogo com ${cat.json.length} relatórios`);

    const noDate = await call('POST', '/api/m/relatorios/vendas-cliente/run', { params: {} }, rc);
    assert.strictEqual(noDate.status, 400);
    ok('parâmetro de data obrigatório validado');

    const run = await call('POST', '/api/m/relatorios/vendas-cliente/run', { params: { dataInicio: '2026-01-01', dataFim: '2026-12-31' } }, rc);
    assert.ok(run.json.rows.length > 0 && run.json.columns.length === 4);
    ok('relatório executado com colunas e linhas');

    const est = await call('POST', '/api/m/relatorios/estoque-deposito/run', { params: { deposito: '01' } }, rc);
    assert.ok(est.json.rows.every((x) => x.WhsCode === '01'));
    ok('filtro de parâmetro texto (depósito)');

    // ---------- Anexos (Compras) ----------
    const pdf = Buffer.from('%PDF-1.4 teste').toString('base64');
    const withAtt = await call('POST', '/api/m/compras/purchase-requests', {
      requiredDate: future, lines: [{ itemCode: 'MC-0100', quantity: 1, unitPrice: 10 }],
      attachments: [{ name: 'Orçamento fornecedor.pdf', data: pdf }]
    }, rc);
    assert.strictEqual(withAtt.status, 201);
    const detAtt = await call('GET', `/api/m/compras/purchase-requests/doc/${withAtt.json.entry}`, null, rc);
    assert.strictEqual(detAtt.json.attachments.length, 1);
    assert.strictEqual(detAtt.json.attachments[0].display, 'Orcamento_fornecedor.pdf');
    const dl = await fetch(`${base}/api/m/compras/purchase-requests/doc/${withAtt.json.entry}/attachments/1`, { headers: { Cookie: rc } });
    assert.strictEqual(dl.headers.get('content-type'), 'application/pdf');
    assert.strictEqual(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-1.4 teste');
    ok('anexo gravado, listado e baixado (solicitação de compra)');

    const badAtt = await call('POST', '/api/m/compras/purchase-requests', {
      requiredDate: future, lines: [{ itemCode: 'MC-0100', quantity: 1 }], attachments: [{ name: 'virus.exe', data: pdf }]
    }, rc);
    assert.strictEqual(badAtt.status, 400);
    ok('tipo de anexo não permitido bloqueado');

    // ---------- Despesas ----------
    const cfg = await call('GET', '/api/m/despesas/config', null, rc);
    assert.ok(cfg.json.categories.length >= 5 && cfg.json.requireAttachment === true);
    ok('configuração de despesas (categorias com conta contábil)');

    const today = new Date().toISOString().slice(0, 10);
    const noReceipt = await call('POST', '/api/m/despesas', { lines: [{ date: today, category: 'REF', description: 'Almoço cliente', amount: 80 }] }, rc);
    assert.strictEqual(noReceipt.status, 400);
    ok('despesa sem comprovante bloqueada');

    const exp = await call('POST', '/api/m/despesas', {
      comments: 'Visita cliente Campinas',
      lines: [
        { date: today, category: 'REF', description: 'Almoço cliente', amount: 80 },
        { date: today, category: 'KM', description: '120 km ida e volta', amount: 1100 }
      ],
      attachments: [{ name: 'cupom.jpg', data: Buffer.from('jpg').toString('base64') }]
    }, rc);
    assert.strictEqual(exp.status, 201);
    assert.strictEqual(exp.json.source, 'draft'); // 1.180 > limite demo -> aprovação
    ok('despesa lançada como solicitação de serviço e retida para aprovação');

    const myExp = await call('GET', '/api/m/despesas', null, rc);
    assert.ok(myExp.json.length === 1 && myExp.json[0].docType === 'service');
    const myPR = await call('GET', '/api/m/compras/purchase-requests', null, rc);
    assert.ok(myPR.json.every((x) => x.docType === 'items'));
    ok('despesas separadas das solicitações de compra');

    const expDet = await call('GET', `/api/m/despesas/draft/${exp.json.entry}`, null, rc);
    assert.strictEqual(expDet.json.lines[1].accountCode, '4.1.1.01.001');
    assert.strictEqual(expDet.json.attachments.length, 1);
    ok('detalhe da despesa com conta contábil e comprovante');

    console.log('\nTodos os testes passaram.');
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
