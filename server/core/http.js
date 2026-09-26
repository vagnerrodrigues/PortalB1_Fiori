'use strict';
/** Middlewares HTTP compartilhados pelo núcleo e pelos módulos. */
const session = require('./session');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// CSRF: mutações exigem header customizado (não enviado cross-site sem CORS)
function requireAjax(req, res, next) {
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Requisição inválida' });
  }
  next();
}

function requireAuth(tenantById) {
  return (req, res, next) => {
    const sid = session.readCookie(req);
    const s = session.get(sid);
    if (!s) return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    req.sid = sid;
    req.session = s;
    req.tenant = tenantById(s.tenantId);
    next();
  };
}

function errorHandler(err, req, res, _next) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 401 && req.sid) {
    session.destroy(req.sid);
    res.setHeader('Set-Cookie', session.cookieHeader('', true));
  }
  if (status >= 500) console.error('[erro]', err);
  res.status(status).json({ error: err.message || 'Erro interno', code: err.code });
}

module.exports = { wrap, requireAjax, requireAuth, errorHandler };
