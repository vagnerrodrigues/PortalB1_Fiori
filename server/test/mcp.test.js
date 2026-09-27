'use strict';
/** Servidor MCP: token pessoal, lista de ferramentas por perfil/escopo, leitura e ações no SAP (mock). */
process.env.MOCK = '1';
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-settings-'));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-data-'));
process.env.PORTAL_SECRET = 'teste';
const assert = require('assert');
const app = require('../index');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (u) => (await call('POST', '/api/login', { tenantId: 'demo', userName: u, password: '1234' })).cookie;
  let seq = 1;
  const mcp = async (token, method, params, extra = {}) => {
    const r = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params })
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const tool = async (token, name, args) => (await mcp(token, 'tools/call', { name, arguments: args })).json.result;
  const ok = (m) => console.log('  ✔', m);

  try {
    const apr = await login('aprovador');
    const req = await login('requisitante');
    const buy = await login('comprador');

    // desligado por padrão
    assert.strictEqual((await call('POST', '/api/m/ia/tokens', { password: '1234' }, req)).status, 403);
    await call('PUT', '/api/m/admin/settings', { general: { aiEnabled: true, portalUrl: 'https://portal.demo.com' } }, apr);
    const info = (await call('GET', '/api/m/ia/info', null, req)).json;
    assert.strictEqual(info.url, 'https://portal.demo.com/mcp');
    ok('assistente de IA desligado por padrão; administrador liga em Configurações');

    assert.strictEqual((await call('POST', '/api/m/ia/tokens', { password: 'errada' }, req)).status, 400);
    const tReq = (await call('POST', '/api/m/ia/tokens', { password: '1234', scope: 'write', label: 'Claude' }, req)).json.token;
    const tBuyRead = (await call('POST', '/api/m/ia/tokens', { password: '1234', scope: 'read' }, buy)).json.token;
    const tApr = (await call('POST', '/api/m/ia/tokens', { password: '1234', scope: 'write' }, apr)).json.token;
    assert.ok(/^pb1_[0-9a-f]+_[0-9a-f]{12}_/.test(tReq));
    const saved = fs.readdirSync(path.join(process.env.DATA_DIR, 'ai-tokens', 'demo')).map((f) => fs.readFileSync(path.join(process.env.DATA_DIR, 'ai-tokens', 'demo', f), 'utf8')).join('');
    assert.ok(!saved.includes(tReq.split('_').slice(3).join('_')) && !saved.includes('"1234"'));
    ok('token pessoal gerado com confirmação da senha do B1 (só hash do token e senha cifrada no disco)');

    // protocolo
    assert.strictEqual((await mcp(null, 'initialize', {})).status, 401);
    assert.strictEqual((await mcp('pb1_00_000000000000_xxxxxxxxxxxxxxxxxxxxxxxx', 'initialize', {})).status, 401);
    assert.strictEqual((await mcp(tReq, 'initialize', {}, { Origin: 'https://evil.example' })).status, 403);
    const init = (await mcp(tReq, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json;
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    const notif = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tReq}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.strictEqual(notif.status, 202);
    assert.strictEqual((await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${tReq}` } })).status, 405);
    ok('protocolo MCP (initialize, notificação 202, GET 405, sem token 401, origem externa 403)');

    const names = async (t) => (await mcp(t, 'tools/list', {})).json.result.tools.map((x) => x.name);
    const nReq = await names(tReq);
    assert.ok(nReq.includes('criar_solicitacao_compra') && !nReq.includes('listar_pedidos_compra') && !nReq.includes('ver_mapa_cotacao'));
    const nBuy = await names(tBuyRead);
    assert.ok(nBuy.includes('listar_pedidos_compra') && !nBuy.includes('criar_solicitacao_compra') && !nBuy.includes('decidir_aprovacao'));
    ok('ferramentas por perfil (comprador x requisitante) e por escopo (leitura x alteração)');

    // requisitante cria solicitação acima da alçada pelo assistente
    const items = (await tool(tReq, 'buscar_itens', { termo: 'notebook' })).structuredContent.itens;
    assert.strictEqual(items[0].codigo, 'TI-0500');
    const bad = await tool(tReq, 'criar_solicitacao_compra', { data_necessaria: '2000-01-01', itens: [{ codigo_item: 'TI-0500', quantidade: 1 }] });
    assert.ok(bad.isError);
    const created = (await tool(tReq, 'criar_solicitacao_compra', {
      data_necessaria: day(10), observacoes: 'via assistente', itens: [{ codigo_item: 'TI-0500', quantidade: 1, preco_estimado: 4800 }]
    })).structuredContent;
    assert.strictEqual(created.aguardando_aprovacao, true);
    ok('assistente busca item e cria solicitação no SAP (retida pela alçada)');

    const denied = await tool(tBuyRead, 'decidir_aprovacao', { codigo_aprovacao: 1, decisao: 'aprovar' });
    assert.ok(denied.isError && /somente leitura/.test(denied.content[0].text));

    const pend = (await tool(tApr, 'listar_aprovacoes_pendentes', {})).structuredContent.itens;
    const mine = pend.find((p) => p.rascunho === created.rascunho);
    assert.ok(mine && mine.total === 4800);
    const doc = (await tool(tApr, 'ver_documento_compra', { tipo: 'solicitacao', numero: created.rascunho, rascunho: true })).structuredContent;
    assert.strictEqual(doc.itens[0].item, 'TI-0500');
    const noReason = await tool(tApr, 'decidir_aprovacao', { codigo_aprovacao: mine.codigo_aprovacao, decisao: 'reprovar' });
    assert.ok(noReason.isError);
    const dec = (await tool(tApr, 'decidir_aprovacao', { codigo_aprovacao: mine.codigo_aprovacao, decisao: 'aprovar', comentario: 'ok' })).structuredContent;
    assert.strictEqual(dec.decisao, 'aprovado');
    const minhas = (await tool(tReq, 'listar_minhas_solicitacoes', {})).structuredContent.itens;
    assert.ok(minhas.some((x) => x.rascunho && x.status === 'APPROVED'));
    ok('aprovador lista, abre e aprova pelo assistente; token só leitura não altera nada');

    const reps = (await tool(tReq, 'listar_relatorios', {})).structuredContent.itens;
    assert.ok(reps.length > 0);
    const run = (await tool(tReq, 'executar_relatorio', { id: reps[0].id, parametros: Object.fromEntries(reps[0].parametros.map((p) => [p.nome, p.tipo === 'date' ? day(0) : ''])) })).structuredContent;
    assert.ok(Array.isArray(run.linhas));
    ok('relatórios do portal disponíveis ao assistente');

    // revogação
    const tid = tReq.split('_')[2];
    await call('POST', `/api/m/ia/tokens/${tid}/revoke`, null, req);
    assert.strictEqual((await mcp(tReq, 'tools/list', {})).status, 401);
    ok('token revogado para de funcionar na hora');

    console.log('\nMCP: todos os testes passaram.');
  } finally {
    server.close();
  }
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
