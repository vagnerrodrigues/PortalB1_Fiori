'use strict';
/**
 * Armazenamento local do PORTAL (não do negócio): um JSON por registro em data/<coleção>/<empresa>/<id>.json.
 * Usado só para o que o B1 não tem onde guardar sem UDF — ex.: convites/links da cotação online.
 * Os documentos (ofertas, pedidos) continuam sendo do SAP B1.
 * DATA_DIR=... muda a pasta (padrão ./data).
 */
const fs = require('fs');
const path = require('path');

const root = () => process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');
const dirOf = (coll, tenantId) => path.join(root(), safe(coll), safe(tenantId));
const fileOf = (coll, tenantId, id) => path.join(dirOf(coll, tenantId), `${safe(id)}.json`);

function get(coll, tenantId, id) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(coll, tenantId, id), 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function put(coll, tenantId, id, obj) {
  const dir = dirOf(coll, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileOf(coll, tenantId, id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file); // gravação atômica
  return obj;
}

function list(coll, tenantId) {
  const dir = dirOf(coll, tenantId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean);
}

/** Todas as empresas de uma coleção (para localizar um token público). */
function tenantsOf(coll) {
  const dir = path.join(root(), safe(coll));
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Próximo número sequencial da coleção na empresa. */
function nextNumber(coll, tenantId) {
  const dir = dirOf(coll, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '_seq');
  const n = (Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) || 0) + 1;
  fs.writeFileSync(f, String(n));
  return n;
}

module.exports = { get, put, list, tenantsOf, nextNumber };
