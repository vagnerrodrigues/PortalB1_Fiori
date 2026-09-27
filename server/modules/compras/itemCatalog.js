'use strict';
/**
 * Catálogo de itens de compra em memória, por empresa.
 * A busca por "contains" no Service Layer vira LIKE '%x%' na OITM a cada tecla: lento em cadastros grandes.
 * Aqui o catálogo (itens de compra ativos) é lido uma vez, em segundo plano, e a busca roda em memória (ms).
 * Atualiza sozinho a cada ITEM_CACHE_MIN minutos (padrão 15). Enquanto carrega, a busca vai direto ao SL.
 */
const sl = require('../../core/slClient');

const TTL = Number(process.env.ITEM_CACHE_MIN || 15) * 60000;
const MAX = Number(process.env.ITEM_CACHE_MAX || 200000);
const caches = new Map(); // tenantId -> { items, loadedAt, loading }

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function load(tenant, ctx) {
  const rows = await sl.getAll(tenant, ctx.cookie,
    `/Items?$select=ItemCode,ItemName,PurchaseUnit,InventoryUOM,DefaultWarehouse&$filter=PurchaseItem eq 'tYES' and Valid eq 'tYES'&$orderby=ItemCode`,
    MAX, 1000);
  return rows.map((i) => {
    const item = { itemCode: i.ItemCode, itemName: i.ItemName, uom: i.PurchaseUnit || i.InventoryUOM || '', defaultWarehouse: i.DefaultWarehouse || '' };
    item._code = norm(i.ItemCode);
    item._text = `${item._code} ${norm(i.ItemName)}`;
    return item;
  });
}

/** Dispara (ou reaproveita) a carga em segundo plano. Nunca lança erro. */
function warm(tenant, ctx) {
  let c = caches.get(tenant.id);
  if (!c) { c = { items: null, loadedAt: 0, loading: null }; caches.set(tenant.id, c); }
  const stale = !c.items || Date.now() - c.loadedAt > TTL;
  if (stale && !c.loading) {
    const t0 = Date.now();
    c.loading = load(tenant, ctx)
      .then((items) => {
        c.items = items; c.loadedAt = Date.now();
        console.log(`[compras] catálogo de itens: ${items.length} itens em ${Date.now() - t0} ms`);
      })
      .catch((e) => console.error(`[compras] catálogo de itens não carregou (${e.message}); busca direto no SAP`))
      .finally(() => { c.loading = null; });
  }
  return c;
}

/** Busca em memória: todas as palavras precisam aparecer; código exato/prefixo primeiro. */
function search(items, term, limit = 20) {
  const t = norm(term).trim();
  if (!t) return items.slice(0, limit).map(pub);
  const words = t.split(/\s+/);
  const hits = [];
  for (const i of items) {
    if (!words.every((w) => i._text.includes(w))) continue;
    const rank = i._code === t ? 0 : i._code.startsWith(t) ? 1 : i._text.includes(` ${words[0]}`) ? 2 : 3;
    hits.push([rank, i]);
    if (rank === 0 && hits.length >= limit * 5) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].itemCode.localeCompare(b[1].itemCode));
  return hits.slice(0, limit).map((h) => pub(h[1]));
}
const pub = ({ _code, _text, ...i }) => i;

/**
 * Retorna itens do cache se já carregado; senão usa `fallback` (consulta direta) e aquece o cache.
 */
async function find(tenant, ctx, term, fallback) {
  const c = warm(tenant, ctx);
  if (c.items) return search(c.items, term);
  return fallback();
}

function invalidate(tenantId) { caches.delete(tenantId); }

module.exports = { find, warm, search, invalidate, _caches: caches };
