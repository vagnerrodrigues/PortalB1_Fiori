'use strict';
/** BETO etapa 1: fundação (repositório, auditoria, execução, recomendações, perfis, isolamento, sem escrita no SAP). */
process.env.MOCK = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SETTINGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-settings-'));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb1-beto-'));
process.env.PORTAL_SECRET = 'teste';
process.env.BETO_SCHEDULER = '0';
const assert = require('assert');
const app = require('../index');
const repoMod = require('../modules/beto/repo');

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const ok = (msg) => console.log('  ✔', msg);

async function main() {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (u) => (await call('POST', '/api/login', { tenantId: 'demo', userName: u, password: '1234' })).cookie;
  try {
    // ---------- regra de ouro: o Beto não escreve no SAP ----------
    const dir = path.join(__dirname, '..', 'modules', 'beto');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') && files.push(path.join(d, e.name))));
    walk(dir);
    const FORBIDDEN = /slClient|sl-procure|['"]\.\/sl['"]|\/compras\/sl['"]|createDocument|finalizeDraft|createGoodsReceipt|createPurchase|\.decide\(\s*tenant|['"](PATCH|DELETE)['"]/;
    files.forEach((f) => {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!FORBIDDEN.test(src), `${path.relative(dir, f)} referencia escrita no SAP`);
      if (/compras\/mock/.test(src)) assert.ok(require(path.join(path.dirname(f), 'manifest.json')).mockOnly, `${path.relative(dir, f)} usa dados demo sem mockOnly`);
    });
    ok(`nenhum arquivo do Beto referencia escrita no SAP (${files.length} arquivos verificados)`);

    // ---------- acesso por perfil ----------
    const req = await login('requisitante');
    assert.strictEqual((await call('GET', '/api/m/beto/health', null, req)).status, 403);
    const buyer = await login('comprador');
    const boss = await login('aprovador');
    const me = (await call('GET', '/api/m/beto/me', null, buyer)).json.roles;
    assert.ok(me.decider && !me.admin);
    assert.ok((await call('GET', '/api/m/beto/me', null, boss)).json.roles.admin);
    ok('módulo só para quem tem acesso; comprador decide, superusuário administra');

    // ---------- execução manual ----------
    assert.strictEqual((await call('POST', '/api/m/beto/runs', {}, buyer)).status, 403);
    const run1 = await call('POST', '/api/m/beto/runs', {}, boss);
    assert.strictEqual(run1.status, 201, JSON.stringify(run1.json));
    assert.strictEqual(run1.json.status, 'CONCLUIDO');
    assert.ok(run1.json.newRecs >= 1, 'demo deve gerar ao menos uma recomendação');
    ok(`execução manual: ${run1.json.findings} achado(s), ${run1.json.newRecs} recomendação(ões)`);

    const run2 = (await call('POST', '/api/m/beto/runs', {}, boss)).json;
    assert.strictEqual(run2.newRecs, 0);
    ok('segunda execução com os mesmos dados não duplica recomendações');

    // ---------- recomendações ----------
    const list = (await call('GET', '/api/m/beto/recommendations?status=PENDENTE', null, buyer)).json.items;
    assert.ok(list.length >= 1 && list.every((x) => x.status === 'PENDENTE' && x.financial && x.audience === 'comprador'));
    const rec = list[0];
    const det = (await call('GET', `/api/m/beto/recommendations/${rec.id}`, null, buyer)).json;
    assert.ok(det.evidence.length >= 1 && det.evidence.every((e) => e.kind === 'po' && e.docEntry));
    assert.ok(det.finding && det.finding.skillVersion);
    ok('recomendação com evidências rastreáveis até o documento (DocEntry) e versão da skill');

    assert.strictEqual((await call('POST', `/api/m/beto/recommendations/${rec.id}/decision`, { decision: 'REJEITADA' }, buyer)).status, 400);
    assert.strictEqual((await call('POST', `/api/m/beto/recommendations/${rec.id}/decision`, { decision: 'ADIADA', reason: 'aguardando fornecedor', snoozeUntil: '2000-01-01' }, buyer)).status, 400);
    const acc = await call('POST', `/api/m/beto/recommendations/${rec.id}/decision`, { decision: 'ACEITA' }, buyer);
    assert.strictEqual(acc.status, 200);
    assert.strictEqual(acc.json.status, 'ACEITA');
    assert.strictEqual(acc.json.action.route, 'compras.orders');
    assert.strictEqual((await call('POST', `/api/m/beto/recommendations/${rec.id}/decision`, { decision: 'ACEITA' }, buyer)).status, 409);
    ok('decisão humana: motivo obrigatório para rejeitar/adiar; aceitar devolve só o atalho (o Beto não executa); sem decisão dupla');

    if (list[1]) {
      const fut = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
      const ad = await call('POST', `/api/m/beto/recommendations/${list[1].id}/decision`, { decision: 'ADIADA', reason: 'revisar no fechamento', snoozeUntil: fut }, buyer);
      assert.strictEqual(ad.json.status, 'ADIADA');
      ok('recomendação adiada até data futura');
    }

    // ---------- auditoria encadeada ----------
    const aud = (await call('GET', '/api/m/beto/audit', null, boss)).json;
    assert.ok(aud.integrity.ok && aud.integrity.events >= 5);
    assert.ok(aud.events.some((e) => e.action === 'REC_DECISION' && e.actor === 'comprador'));
    const repo = repoMod.forTenant('demo');
    assert.throws(() => repo.db.exec("UPDATE audit_event SET actor = 'x'"), /somente inserção/);
    assert.throws(() => repo.db.exec('DELETE FROM audit_event'), /somente inserção/);
    // adulteração por fora (sem triggers) é detectada
    repo.db.exec('DROP TRIGGER audit_no_update');
    repo.db.exec("UPDATE audit_event SET payload = '{\"x\":1}' WHERE seq = 2");
    const broken = repo.verifyAudit();
    assert.ok(!broken.ok && broken.brokenAt === 2);
    ok('auditoria só inserção (UPDATE/DELETE bloqueados) e adulteração detectada pela cadeia de hash');

    // ---------- skills e agenda ----------
    const sk = (await call('GET', '/api/m/beto/skills', null, buyer)).json;
    assert.ok(sk.some((s) => s.id === 'demo-late-po' && s.mockOnly));
    assert.strictEqual((await call('PUT', '/api/m/beto/skills/demo-late-po', { enabled: true, params: { foo: 1 } }, boss)).status, 400);
    assert.strictEqual((await call('PUT', '/api/m/beto/skills/demo-late-po', { enabled: false, params: { bands: [60] } }, boss)).json.enabled, false);
    assert.strictEqual((await call('PUT', '/api/m/beto/schedule', { enabled: true, time: '25:00' }, boss)).status, 400);
    assert.strictEqual((await call('PUT', '/api/m/beto/schedule', { enabled: true, time: '06:30' }, boss)).json.time, '06:30');
    const sched = require('../modules/beto/scheduler');
    assert.strictEqual(sched.due({ enabled: true, time: '06:30' }, null, new Date('2026-11-21T07:00:00')), true);
    assert.strictEqual(sched.due({ enabled: true, time: '06:30' }, null, new Date('2026-11-21T05:00:00')), false);
    assert.ok(!sched.due({ enabled: false, time: '06:30' }, null));
    ok('configuração de skill validada (parâmetros conhecidos) e agenda por empresa');

    // ---------- isolamento multiempresa ----------
    const a = repoMod.forTenant('empresa-a');
    const b = repoMod.forTenant('empresa-b');
    const rid = a.startRun('teste', 'x');
    a.endRun(rid, { status: 'CONCLUIDO' });
    assert.strictEqual(a.listRuns().length, 1);
    assert.strictEqual(b.listRuns().length, 0);
    assert.notStrictEqual(a.file, b.file);
    assert.ok(b.verifyAudit().ok && b.verifyAudit().events === 0);
    ok('isolamento: arquivo e dados separados por empresa');

    const health = (await call('GET', '/api/m/beto/health', null, buyer)).json;
    assert.strictEqual(health.stage, 1);
    assert.strictEqual(health.llm.enabled, false);
    ok('health: etapa, última execução, agenda, contagens, integridade da auditoria');

    console.log('\nBETO etapa 1: OK');
  } catch (e) {
    console.error('FALHOU:', e);
    process.exitCode = 1;
  } finally {
    server.close();
    repoMod.closeAll();
  }
}
main();
