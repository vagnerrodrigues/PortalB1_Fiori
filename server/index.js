'use strict';
/**
 * Portal B1 - núcleo (BFF). Front SAPUI5 -> este servidor -> SAP B1 Service Layer.
 * Módulos em server/modules/<id> são carregados e liberados por empresa/usuário.
 *
 * Variáveis de ambiente:
 *   PORT=8080            porta HTTP
 *   HOST=0.0.0.0         interface (127.0.0.1 quando estiver atrás do IIS)
 *   MOCK=1               modo demonstração (sem SAP)
 *   COOKIE_SECURE=1      cookie só via HTTPS (obrigatório em produção)
 *   SESSION_IDLE_MIN=25  expiração por inatividade
 *   TENANTS_FILE=...     JSON de empresas (padrão config/tenants.json)
 *   REPORTS_FILE=...     relatórios extras (padrão config/reports.json)
 *   WEBAPP_DIR=...       pasta do front (padrão ./webapp)
 *   BRANDING_FILE=...    identidade visual (padrão config/branding.json)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('./core/session');
const { audit } = require('./core/audit');
const auth = require('./core/auth');
const branding = require('./core/branding');
const access = require('./core/access');
const { wrap, requireAjax, requireAuth, errorHandler } = require('./core/http');

const MOCK = process.env.MOCK === '1';

// ---------- Módulos registrados ----------
const registry = ['compras', 'despesas', 'parceiros', 'relatorios', 'admin'].map((id) => require(`./modules/${id}`));

// ---------- Empresas (multi-tenant) ----------
function loadTenants() {
  if (MOCK) {
    return [{
      id: 'demo',
      name: 'Empresa Demo (simulado)',
      serviceLayerUrl: 'mock://',
      companyDB: 'SBODEMO',
      // demo do controle de acesso: requisitante (depto 1) = Compras; comercial (depto 3) = Parceiros;
      // aprovador é superusuário (vê tudo); Relatórios liberado para todos
      moduleAccess: { compras: { departments: [1, 2] }, parceiros: { departments: [2, 3] } }
    }];
  }
  const file = process.env.TENANTS_FILE || path.join(__dirname, '..', 'config', 'tenants.json');
  if (!fs.existsSync(file)) {
    console.error(`Arquivo de empresas não encontrado: ${file}. Copie config/tenants.example.json.`);
    process.exit(1);
  }
  return require('./core/readJson')(file);
}
const tenants = loadTenants();
const tenantById = (id) => tenants.find((t) => t.id === id);
const authed = requireAuth(tenantById);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '60mb' })); // anexos em base64 (até 5 x 10 MB)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', requireAjax);
app.use((req, res, next) => { req.mock = MOCK; next(); });

// Rate limit de login por IP
const loginHits = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const hits = (loginHits.get(req.ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (hits.length >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  hits.push(now);
  loginHits.set(req.ip, hits);
  next();
}

function describe(tenant, user) {
  return {
    user,
    tenant: { id: tenant.id, name: tenant.name },
    branding: branding.forTenant(tenant),
    mock: MOCK,
    modules: access.modulesForUser(tenant, user, registry)
      .map(({ id, title, description, tiles }) => ({ id, title, description, tiles }))
  };
}

// ---------- Núcleo ----------
app.get('/api/health', (req, res) => res.json({ ok: true, mode: MOCK ? 'mock' : 'service-layer', modules: registry.map((m) => m.id) }));

// Marca da tela de login: global ou da empresa escolhida (?tenant=)
app.get('/api/branding', (req, res) => {
  const t = req.query.tenant ? tenantById(String(req.query.tenant)) : null;
  res.json(t ? branding.forTenant(t) : branding.loadGlobal());
});

app.get('/api/tenants', (req, res) => res.json(tenants.map((t) => ({ id: t.id, name: t.name }))));

app.post('/api/login', loginRateLimit, wrap(async (req, res) => {
  const { tenantId, userName, password } = req.body || {};
  const tenant = tenantById(tenantId);
  if (!tenant || !userName || !password) return res.status(400).json({ error: 'Informe empresa, usuário e senha' });
  const { ctx, user } = await auth.login(tenant, userName, password, MOCK);
  const info = describe(tenant, user);
  if (!info.modules.length) {
    await auth.logout(tenant, ctx, MOCK);
    return res.status(403).json({ error: 'Seu usuário não tem acesso a nenhum módulo do portal. Fale com o administrador.' });
  }
  const sid = session.create({ tenantId: tenant.id, ctx, user });
  res.setHeader('Set-Cookie', session.cookieHeader(sid));
  req.session = { tenantId: tenant.id, user };
  audit(req, 'LOGIN', {});
  res.json(info);
}));

app.post('/api/logout', authed, wrap(async (req, res) => {
  await auth.logout(req.tenant, req.session.ctx, MOCK);
  session.destroy(req.sid);
  res.setHeader('Set-Cookie', session.cookieHeader('', true));
  res.json({ ok: true });
}));

app.get('/api/me', authed, (req, res) => res.json(describe(req.tenant, req.session.user)));

// ---------- Módulos: /api/m/<id>/... ----------
registry.forEach((mod) => {
  const guard = (req, res, next) => {
    const enabled = access.enabledModules(req.tenant, registry).some((m) => m.id === mod.id);
    if (!enabled || !access.canAccess(req.tenant, req.session.user, mod.id, mod)) {
      return res.status(403).json({ error: `Sem acesso ao módulo ${mod.title}` });
    }
    next();
  };
  app.use(`/api/m/${mod.id}`, authed, guard, mod.createRouter({ mock: MOCK, wrap, audit }));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

// ---------- Front SAPUI5 ----------
app.use('/brand', express.static(path.join(__dirname, '..', 'config', 'brand'))); // logos do cliente
app.use(express.static(process.env.WEBAPP_DIR || path.join(__dirname, '..', 'webapp'), { index: 'index.html' }));

app.use(errorHandler);

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => console.log(`Portal B1 em http://${host}:${port} (${MOCK ? 'demonstração' : 'Service Layer'}; módulos: ${registry.map((m) => m.id).join(', ')})`))
    .on('error', (e) => {
      console.error(e.code === 'EACCES' || e.code === 'EADDRINUSE'
        ? `Porta ${port} indisponível (${e.code}). Use outra porta: PORT=18080 ou install-service.ps1 -Port 18080`
        : e);
      process.exit(1);
    });
}

module.exports = app;
