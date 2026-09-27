'use strict';
/**
 * Servidor MCP (Model Context Protocol) do Portal B1 — transporte "Streamable HTTP", modo sem estado.
 * POST /mcp com JSON-RPC 2.0. Autenticação: "Authorization: Bearer <token pessoal>" (tela Assistente de IA).
 * Serve para Claude, Copilot, ChatGPT e agentes da Joule (Joule Studio) — o mesmo endpoint para todos.
 *
 * Cada token abre (e reaproveita) uma sessão no Service Layer com o usuário B1 da pessoa, então valem
 * as permissões e alçadas do SAP. Ferramentas que alteram dados exigem token com escopo "write".
 */
const express = require('express');
const aiTokens = require('../core/aiTokens');
const settings = require('../core/settings');
const access = require('../core/access');
const auth = require('../core/auth');
const { audit } = require('../core/audit');
const { TOOLS } = require('./tools');
const compras = require('../modules/compras');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'portal-b1', title: 'Portal B1 (SAP Business One)', version: require('../../package.json').version };
const SESSION_TTL = 20 * 60000;

function createMcpRouter({ mock, registry, tenantById }) {
  const r = express.Router();
  const sessions = new Map(); // token id -> { ctx, user, at }
  const hits = new Map();

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const unauthorized = (res, msg) => res.status(401).set('WWW-Authenticate', 'Bearer realm="portal-b1"').json(rpcError(null, -32001, msg));

  // Proteção contra DNS rebinding: navegador de outra origem não chama o MCP
  r.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json(rpcError(null, -32002, 'Origem não permitida'));
      } catch (_) { return res.status(403).json(rpcError(null, -32002, 'Origem inválida')); }
    }
    next();
  });

  r.get('/', (req, res) => res.status(405).set('Allow', 'POST').json(rpcError(null, -32000, 'Use POST (transporte Streamable HTTP, sem SSE)')));
  r.delete('/', (req, res) => res.status(405).set('Allow', 'POST').end());

  r.post('/', async (req, res) => {
    // ---------- autenticação ----------
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const hit = m && aiTokens.verify(m[1]);
    if (!hit) return unauthorized(res, 'Token ausente, inválido, revogado ou expirado. Gere um novo em Portal B1 > Assistente de IA.');
    const tenant = tenantById(hit.tenantId);
    if (!tenant) return unauthorized(res, 'Empresa do token não existe mais');
    if (!settings.load(tenant.id).general.aiEnabled) {
      return res.status(403).json(rpcError(null, -32003, 'Assistentes de IA estão desligados nas Configurações do portal'));
    }
    const now = Date.now();
    const h = (hits.get(hit.rec.id) || []).filter((t) => now - t < 60000);
    if (h.length >= 120) return res.status(429).json(rpcError(null, -32004, 'Muitas chamadas. Aguarde um minuto.'));
    h.push(now);
    hits.set(hit.rec.id, h);
    aiTokens.touch(hit.tenantId, hit.rec);

    const body = req.body;
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    if (!msgs.length || msgs.some((x) => !x || x.jsonrpc !== '2.0' || typeof x.method !== 'string')) {
      return res.status(400).json(rpcError(null, -32600, 'Requisição JSON-RPC inválida'));
    }

    const out = [];
    for (const msg of msgs) {
      if (msg.id === undefined || msg.id === null) continue; // notificação: sem resposta
      out.push(await handle(msg, { req, tenant, hit }));
    }
    if (!out.length) return res.status(202).end();
    res.json(batch ? out : out[0]);
  });

  /** Sessão B1 do dono do token (reaproveitada; refeita se expirar). */
  async function sessionFor(tenant, hit, force) {
    const cur = sessions.get(hit.rec.id);
    if (cur && !force && Date.now() - cur.at < SESSION_TTL) { cur.at = Date.now(); return cur; }
    if (cur && !mock) auth.logout(tenant, cur.ctx, mock).catch(() => {});
    const { ctx, user } = await auth.login(tenant, hit.rec.userCode, hit.password(), mock);
    const s = { ctx, user, at: Date.now() };
    sessions.set(hit.rec.id, s);
    return s;
  }

  function toolsFor(tenant, user, scope) {
    const enabled = access.enabledModules(tenant, registry);
    return TOOLS.filter((t) =>
      enabled.some((mo) => mo.id === t.module) &&
      access.canAccess(tenant, user, t.module, registry.find((mo) => mo.id === t.module)) &&
      access.canTile(tenant, user, t.module, { buyer: !!t.buyer }) &&
      (!t.write || scope === 'write'));
  }

  async function handle(msg, { req, tenant, hit }) {
    const { id, method, params = {} } = msg;
    try {
      if (method === 'initialize') {
        const asked = params.protocolVersion;
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: `Portal B1 conectado ao SAP Business One da empresa ${tenant.name}, com o usuário ${hit.rec.userName}. ` +
              'Valores em R$. Antes de aprovar, reprovar ou criar documentos, mostre o resumo e peça confirmação ao usuário. ' +
              (hit.rec.scope === 'write' ? '' : 'Este token é somente leitura.')
          }
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

      if (method === 'tools/list') {
        const s = await sessionFor(tenant, hit);
        return {
          jsonrpc: '2.0', id,
          result: {
            tools: toolsFor(tenant, s.user, hit.rec.scope).map((t) => ({
              name: t.name, description: t.description, inputSchema: t.inputSchema,
              annotations: { readOnlyHint: !t.write, openWorldHint: false, ...(t.annotations || {}) }
            }))
          }
        };
      }

      if (method === 'tools/call') {
        let s = await sessionFor(tenant, hit);
        const tool = toolsFor(tenant, s.user, hit.rec.scope).find((t) => t.name === params.name);
        if (!tool) {
          const exists = TOOLS.find((t) => t.name === params.name);
          const why = !exists ? 'Ferramenta desconhecida'
            : exists.write && hit.rec.scope !== 'write' ? 'Este token é somente leitura: gere um token com permissão de alteração'
              : 'Seu usuário não tem acesso a esta função no portal';
          return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: why }] } };
        }
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const run = async (sess) => {
          const b1 = compras.adapter(mock);
          const pseudoReq = {
            tenant, mock, ip: req.ip, session: { tenantId: tenant.id, user: sess.user, ctx: sess.ctx },
            protocol: req.protocol, get: (hd) => req.get(hd)
          };
          const c = {
            tenant, ctx: sess.ctx, user: sess.user, mock, b1, req: pseudoReq,
            isBuyer: access.canTile(tenant, sess.user, 'compras', { buyer: true }),
            rfq: compras.createService({ b1, tenantById }),
            audit: (action, details) => audit(pseudoReq, action, { ...details, via: 'mcp', token: hit.rec.id })
          };
          return tool.run(c, args);
        };
        let data;
        try {
          data = await run(s);
        } catch (e) {
          if (e.status !== 401 || mock) throw e;
          s = await sessionFor(tenant, hit, true); // sessão do SL expirou: refaz e tenta de novo
          data = await run(s);
        }
        const structured = Array.isArray(data) ? { itens: data, total: data.length } : data;
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured }
        };
      }

      return rpcError(id, -32601, `Método não suportado: ${method}`);
    } catch (e) {
      if (e.status === 401 && /login|senha|password|user/i.test(e.message)) {
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'A senha do SAP B1 mudou ou o usuário foi bloqueado. Gere um novo token no portal.' }] } };
      }
      if (method === 'tools/call') {
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message || 'Erro ao executar a ferramenta' }] } };
      }
      return rpcError(id, -32603, e.message || 'Erro interno');
    }
  }

  return r;
}

module.exports = { createMcpRouter };
