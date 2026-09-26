'use strict';
/**
 * Cotação online (RFQ).
 *
 * Fluxo:
 *  1. Comprador escolhe linhas de solicitações em aberto (ou itens avulsos) e os fornecedores.
 *  2. Para cada fornecedor o portal cria uma OFERTA DE COMPRA nativa (OPQT), com base na solicitação,
 *     e envia por e-mail um link exclusivo (token) para a página pública de resposta.
 *  3. O fornecedor informa preço, prazo e condições. A resposta fica no portal e é gravada na oferta
 *     do B1 com a sessão do comprador (ao abrir o mapa / "Atualizar SAP") — sem usuário técnico do B1.
 *  4. Mapa de cotação: menor preço por item, melhor fornecedor único, escolha do vencedor por item.
 *  5. "Gerar pedidos": um PEDIDO DE COMPRA por fornecedor vencedor, copiando da oferta (BaseType 540000006).
 *
 * O que fica no portal (data/rfq/<empresa>/<n>.json): convite, token, status da resposta e a escolha
 * do vencedor. Preços, prazos e documentos ficam no SAP B1.
 */
const crypto = require('crypto');
const store = require('../../core/store');
const mailer = require('../../core/mailer');
const settings = require('../../core/settings');
const { SLError } = require('../../core/slClient');

const COLL = 'rfq';
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s));
const round2 = (n) => Math.round(n * 100) / 100;
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '');

// ---------- token -> cotação ----------
const tokenIndex = new Map(); // token -> { tenantId, id }
function indexRfq(tenantId, rfq) {
  rfq.suppliers.forEach((s) => { if (s.token) tokenIndex.set(s.token, { tenantId, id: rfq.id }); });
}
function findByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  let hit = tokenIndex.get(token);
  if (!hit) { // reconstrói o índice (reinício do serviço)
    store.tenantsOf(COLL).forEach((t) => store.list(COLL, t).forEach((r) => indexRfq(t, r)));
    hit = tokenIndex.get(token);
  }
  if (!hit) return null;
  const rfq = store.get(COLL, hit.tenantId, hit.id);
  const supplier = rfq && rfq.suppliers.find((s) => s.token === token);
  return supplier ? { tenantId: hit.tenantId, rfq, supplier } : null;
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

/** Fase efetiva: prazo vencido fecha o recebimento de respostas. */
function phase(rfq) {
  if (rfq.status === 'OPEN' && rfq.deadline < today()) return 'EXPIRED';
  return rfq.status;
}
const canAnswer = (rfq) => phase(rfq) === 'OPEN';

// ---------- mapa de cotação ----------
function buildMap(rfq) {
  const award = new Map(((rfq.award && rfq.award.lines) || []).map((x) => [x.key, x.cardCode]));
  const lines = rfq.lines.map((l) => {
    const offers = rfq.suppliers.map((s) => {
      const a = s.answer && s.answer.lines.find((x) => x.key === l.key);
      const quoted = !!(a && a.quoted && Number(a.unitPrice) > 0);
      return {
        cardCode: s.cardCode, quoted,
        unitPrice: quoted ? Number(a.unitPrice) : null,
        total: quoted ? round2(Number(a.unitPrice) * l.quantity) : null,
        deliveryDate: quoted ? a.deliveryDate || null : null,
        notes: a ? a.notes || '' : ''
      };
    });
    const valid = offers.filter((o) => o.quoted);
    const best = valid.length ? valid.reduce((m, o) => (o.unitPrice < m.unitPrice ? o : m)) : null;
    const worst = valid.length ? valid.reduce((m, o) => (o.unitPrice > m.unitPrice ? o : m)) : null;
    offers.forEach((o) => { o.best = !!(best && o.quoted && o.unitPrice === best.unitPrice); });
    return {
      ...l, offers,
      bestCardCode: best ? best.cardCode : null,
      bestPrice: best ? best.unitPrice : null,
      spread: best && worst && worst.unitPrice ? Math.round((1 - best.unitPrice / worst.unitPrice) * 1000) / 10 : null,
      winner: award.has(l.key) ? award.get(l.key) : (best ? best.cardCode : null)
    };
  });
  const suppliers = rfq.suppliers.map((s) => {
    const mine = lines.map((l) => l.offers.find((o) => o.cardCode === s.cardCode));
    const quotedCount = mine.filter((o) => o.quoted).length;
    return {
      cardCode: s.cardCode,
      total: round2(mine.reduce((acc, o) => acc + (o.total || 0), 0)),
      quotedCount,
      complete: quotedCount === lines.length,
      winnerTotal: round2(lines.reduce((acc, l, i) => acc + (l.winner === s.cardCode ? mine[i].total || 0 : 0), 0)),
      winnerCount: lines.filter((l) => l.winner === s.cardCode).length
    };
  });
  const complete = suppliers.filter((s) => s.complete && s.total > 0);
  const bestSingle = complete.length ? complete.reduce((m, s) => (s.total < m.total ? s : m)) : null;
  const bestMix = round2(lines.reduce((acc, l) => acc + (l.bestPrice ? l.bestPrice * l.quantity : 0), 0));
  const selected = round2(lines.reduce((acc, l) => {
    const o = l.offers.find((x) => x.cardCode === l.winner);
    return acc + (o && o.total ? o.total : 0);
  }, 0));
  return {
    lines, suppliers,
    summary: {
      bestMix, selected,
      bestSingle: bestSingle ? { cardCode: bestSingle.cardCode, total: bestSingle.total } : null,
      savingVsSingle: bestSingle ? round2(bestSingle.total - bestMix) : null,
      answered: rfq.suppliers.filter((s) => s.status === 'ANSWERED').length,
      invited: rfq.suppliers.length
    }
  };
}

// ---------- validação ----------
function validateAnswer(rfq, a) {
  const e = [];
  if (!a || typeof a !== 'object' || !Array.isArray(a.lines)) return ['Resposta inválida'];
  const keys = new Set(rfq.lines.map((l) => l.key));
  const lines = [];
  a.lines.forEach((x) => {
    if (!keys.has(Number(x.key))) return;
    const l = rfq.lines.find((y) => y.key === Number(x.key));
    const quoted = !!x.quoted;
    if (quoted && !(Number(x.unitPrice) > 0)) e.push(`${l.itemName || l.itemCode}: informe o preço unitário`);
    if (quoted && x.deliveryDate && !isDate(x.deliveryDate)) e.push(`${l.itemName || l.itemCode}: data de entrega inválida`);
    if (quoted && x.deliveryDate && x.deliveryDate < today()) e.push(`${l.itemName || l.itemCode}: data de entrega no passado`);
    lines.push({
      key: Number(x.key), quoted,
      unitPrice: quoted ? round2(Number(x.unitPrice) * 10000) / 10000 : null,
      deliveryDate: quoted && x.deliveryDate ? x.deliveryDate : null,
      notes: String(x.notes || '').slice(0, 90)
    });
  });
  if (!lines.some((l) => l.quoted)) e.push('Informe o preço de ao menos um item (ou use "Não vou cotar")');
  if (a.validUntil && !isDate(a.validUntil)) e.push('Validade da proposta inválida');
  return e.length ? e : {
    lines: rfq.lines.map((l) => lines.find((x) => x.key === l.key) || { key: l.key, quoted: false, unitPrice: null, deliveryDate: null, notes: '' }),
    paymentTerms: String(a.paymentTerms || '').slice(0, 60),
    freight: ['CIF', 'FOB', ''].includes(a.freight) ? a.freight : '',
    validUntil: a.validUntil || null,
    proposalRef: String(a.proposalRef || '').slice(0, 40),
    notes: String(a.notes || '').slice(0, 120)
  };
}

function createService({ b1, tenantById }) {
  const load = (tenant, id) => {
    const r = /^\d+$/.test(String(id)) ? store.get(COLL, tenant.id, id) : null;
    if (!r) { const e = new Error('Cotação não encontrada'); e.status = 404; throw e; }
    return r;
  };
  const save = (tenant, rfq) => { rfq.updatedAt = new Date().toISOString(); store.put(COLL, tenant.id, rfq.id, rfq); indexRfq(tenant.id, rfq); return rfq; };

  function baseUrl(req, tenant) {
    const configured = settings.load(tenant.id).general.portalUrl;
    return configured || `${req.protocol}://${req.get('host')}`;
  }
  const linkOf = (req, tenant, s) => `${baseUrl(req, tenant)}/cotacao/${s.token}`;

  /** Envia (ou reenvia) o convite ao fornecedor. Retorna o resultado do e-mail, sem lançar erro. */
  async function invite(req, tenant, rfq, s) {
    if (!s.email) return { ok: false, skipped: 'fornecedor sem e-mail' };
    const link = linkOf(req, tenant, s);
    const html = mailer.render(tenant, {
      title: `Pedido de cotação nº ${rfq.id}`,
      intro: `${tenant.name} convida ${s.cardName} a enviar preços para os itens abaixo. Responda pelo link até ${br(rfq.deadline)}.${rfq.message ? ` ${rfq.message}` : ''}`,
      rows: rfq.lines.slice(0, 15).map((l) => [`${l.quantity} ${l.uom || ''}`.trim(), `${l.itemName || l.itemCode}`])
        .concat(rfq.lines.length > 15 ? [['…', `mais ${rfq.lines.length - 15} itens`]] : []),
      buttonText: 'Informar meus preços',
      buttonUrl: link,
      footer: `Link exclusivo para ${s.cardName}. Não encaminhe. Dúvidas: responda para ${rfq.createdBy.email || 'o comprador'}.`
    });
    const out = await mailer.send(tenant, { to: [s.email], subject: `Cotação nº ${rfq.id} — ${tenant.name}`, html }, { mock: req.mock });
    s.lastEmail = { at: new Date().toISOString(), ok: !!out.ok, info: out.error || out.skipped || '' };
    return out;
  }

  // ---------- comprador ----------
  async function create(req, p) {
    const tenant = req.tenant;
    const e = [];
    if (!p || typeof p !== 'object') throw bad('Payload inválido');
    if (!isDate(p.deadline)) e.push('Prazo para resposta inválido');
    else if (p.deadline < today()) e.push('Prazo para resposta no passado');
    if (!Array.isArray(p.lines) || !p.lines.length) e.push('Inclua ao menos um item');
    else if (p.lines.length > 60) e.push('Máximo de 60 itens por cotação');
    else p.lines.forEach((l, i) => {
      if (!l.prEntry && !l.itemCode) e.push(`Item ${i + 1}: informe o item`);
      if (!(Number(l.quantity) > 0)) e.push(`Item ${i + 1}: quantidade inválida`);
    });
    const codes = [...new Set((p.suppliers || []).map((s) => s && s.cardCode).filter(Boolean))];
    if (!codes.length) e.push('Escolha ao menos um fornecedor');
    if (codes.length > 15) e.push('Máximo de 15 fornecedores por cotação');
    (p.suppliers || []).forEach((s) => { if (s && s.email && !EMAIL_RE.test(s.email)) e.push(`E-mail inválido para ${s.cardCode}`); });
    if (e.length) throw bad(e.join('; '));

    const id = store.nextNumber(COLL, tenant.id);
    const user = req.session.user;
    const lines = p.lines.map((l, key) => ({
      key,
      prEntry: l.prEntry ? Number(l.prEntry) : null, prDocNum: l.prDocNum || null, prLine: l.prEntry ? Number(l.prLine) : null,
      itemCode: l.itemCode, itemName: l.itemName || l.itemCode, uom: l.uom || '', quantity: Number(l.quantity),
      requiredDate: isDate(l.requiredDate) ? l.requiredDate : (p.requiredDate || null),
      warehouse: l.warehouse || '', costCenter: l.costCenter || '', freeText: String(l.freeText || '').slice(0, 100)
    }));
    const rfq = {
      id, title: String(p.title || '').slice(0, 80) || `Cotação ${id}`, message: String(p.message || '').slice(0, 300),
      deadline: p.deadline, branch: p.branch || null,
      requiredDate: lines.map((l) => l.requiredDate).filter(Boolean).sort()[0] || p.deadline,
      status: 'OPEN', createdAt: new Date().toISOString(),
      createdBy: { userCode: user.userCode, userName: user.userName, email: user.email || '', internalKey: user.internalKey },
      lines, suppliers: [], award: null, log: []
    };
    for (const code of codes) {
      const given = p.suppliers.find((s) => s.cardCode === code) || {};
      rfq.suppliers.push(await addSupplierDoc(req, rfq, code, given.email));
    }
    if (!rfq.suppliers.some((s) => s.pq)) {
      throw bad(`Nenhuma oferta de compra foi criada no B1: ${rfq.suppliers.map((s) => `${s.cardCode}: ${s.error}`).join('; ')}`);
    }
    save(tenant, rfq);
    for (const s of rfq.suppliers.filter((x) => x.pq)) await invite(req, tenant, rfq, s);
    save(tenant, rfq);
    return view(req, rfq);
  }

  /** Cria a oferta de compra do fornecedor no B1 e prepara o convite. */
  async function addSupplierDoc(req, rfq, cardCode, emailOverride) {
    const s = { cardCode, cardName: cardCode, email: '', token: newToken(), status: 'INVITED', invitedAt: new Date().toISOString(), pq: null, lineMap: {}, answer: null, sync: null };
    try {
      const v = await b1.vendorContact(req.tenant, req.session.ctx, cardCode);
      s.cardName = v.cardName;
      s.email = emailOverride || v.email || '';
      const r = await b1.createQuotation(req.tenant, req.session.ctx, {
        cardCode, branch: rfq.branch, requiredDate: rfq.requiredDate, validUntil: rfq.deadline,
        comments: `Cotação online nº ${rfq.id} (Portal)${rfq.title ? ` - ${rfq.title}` : ''}`,
        lines: rfq.lines
      });
      s.pq = { source: r.source, entry: r.entry, docNum: r.docNum };
      rfq.lines.forEach((l, i) => { s.lineMap[l.key] = i; }); // LineNum da oferta = ordem das linhas
    } catch (e) {
      s.status = 'ERROR';
      s.error = e.message;
    }
    return s;
  }

  function list(req) {
    return store.list(COLL, req.tenant.id).sort((a, b) => b.id - a.id).map((r) => ({
      id: r.id, title: r.title, deadline: r.deadline, status: phase(r), createdAt: r.createdAt, createdBy: r.createdBy.userName,
      lines: r.lines.length, invited: r.suppliers.length, answered: r.suppliers.filter((s) => s.status === 'ANSWERED').length,
      pendingSync: r.suppliers.filter((s) => s.sync === 'PENDING' || s.sync === 'ERROR').length,
      orders: ((r.award && r.award.orders) || []).length
    }));
  }

  function view(req, rfq) {
    return {
      ...rfq,
      status: phase(rfq),
      suppliers: rfq.suppliers.map(({ token, ...s }) => ({ ...s, link: token ? linkOf(req, req.tenant, { token }) : null })),
      map: buildMap(rfq)
    };
  }

  const get = (req, id) => view(req, load(req.tenant, id));

  /** Grava no B1 (ofertas de compra) as respostas ainda não sincronizadas, com a sessão do comprador. */
  async function sync(req, id) {
    const rfq = load(req.tenant, id);
    let changed = false;
    for (const s of rfq.suppliers) {
      if (!s.answer || s.sync === 'SYNCED' || !s.pq) continue;
      if (s.pq.source !== 'doc') { s.sync = 'ERROR'; s.syncError = 'Oferta de compra aguardando aprovação no B1'; changed = true; continue; }
      try {
        await b1.writeQuotationAnswer(req.tenant, req.session.ctx, s.pq.entry, {
          ...s.answer,
          comments: `Cotação online nº ${rfq.id} (Portal)`,
          lines: s.answer.lines.map((l) => ({ ...l, lineNum: s.lineMap[l.key] }))
        });
        s.sync = 'SYNCED'; s.syncedAt = new Date().toISOString(); delete s.syncError;
      } catch (e) {
        s.sync = 'ERROR'; s.syncError = e.message;
      }
      changed = true;
    }
    if (changed) save(req.tenant, rfq);
    return view(req, rfq);
  }

  async function addSupplier(req, id, cardCode, email) {
    const rfq = load(req.tenant, id);
    if (!canAnswer(rfq)) throw bad('Cotação encerrada: não é possível incluir fornecedores');
    if (rfq.suppliers.some((s) => s.cardCode === cardCode)) throw bad('Fornecedor já está nesta cotação');
    if (email && !EMAIL_RE.test(email)) throw bad('E-mail inválido');
    const s = await addSupplierDoc(req, rfq, cardCode, email);
    if (!s.pq) throw bad(`Não foi possível criar a oferta de compra no B1: ${s.error}`);
    rfq.suppliers.push(s);
    save(req.tenant, rfq);
    await invite(req, req.tenant, rfq, s);
    save(req.tenant, rfq);
    return view(req, rfq);
  }

  async function resend(req, id, cardCode, { email, newLink } = {}) {
    const rfq = load(req.tenant, id);
    const s = rfq.suppliers.find((x) => x.cardCode === cardCode);
    if (!s) throw bad('Fornecedor não está nesta cotação');
    if (email) { if (!EMAIL_RE.test(email)) throw bad('E-mail inválido'); s.email = email; }
    if (newLink) { tokenIndex.delete(s.token); s.token = newToken(); }
    const out = await invite(req, req.tenant, rfq, s);
    save(req.tenant, rfq);
    return { ...view(req, rfq), email: out };
  }

  /** Comprador lança a resposta (proposta recebida por telefone, e-mail, PDF...). */
  async function buyerAnswer(req, id, cardCode, answer) {
    const rfq = load(req.tenant, id);
    if (rfq.status === 'AWARDED' || rfq.status === 'CANCELLED') throw bad('Cotação já finalizada');
    const s = rfq.suppliers.find((x) => x.cardCode === cardCode);
    if (!s) throw bad('Fornecedor não está nesta cotação');
    const a = validateAnswer(rfq, answer);
    if (Array.isArray(a)) throw bad(a.join('; '));
    Object.assign(s, { answer: a, status: 'ANSWERED', answeredAt: new Date().toISOString(), answeredBy: req.session.user.userName, sync: 'PENDING' });
    rfq.log.push({ at: s.answeredAt, by: req.session.user.userCode, what: `resposta de ${cardCode} lançada pelo comprador` });
    save(req.tenant, rfq);
    return sync(req, id);
  }

  function setStatus(req, id, status) {
    const rfq = load(req.tenant, id);
    if (rfq.status === 'AWARDED') throw bad('Cotação já gerou pedidos');
    rfq.status = status;
    rfq.log.push({ at: new Date().toISOString(), by: req.session.user.userCode, what: `status ${status}` });
    return rfq;
  }

  async function close(req, id) { const rfq = setStatus(req, id, 'CLOSED'); save(req.tenant, rfq); return view(req, rfq); }
  async function reopen(req, id, deadline) {
    if (!isDate(deadline) || deadline < today()) throw bad('Informe um novo prazo válido');
    const rfq = setStatus(req, id, 'OPEN');
    rfq.deadline = deadline;
    save(req.tenant, rfq);
    return view(req, rfq);
  }

  async function cancel(req, id) {
    const rfq = setStatus(req, id, 'CANCELLED');
    for (const s of rfq.suppliers) {
      if (s.pq && s.pq.source === 'doc') {
        try { await b1.cancelDoc(req.tenant, req.session.ctx, 'pq', s.pq.entry); } catch (e) { s.error = `Cancelamento da oferta: ${e.message}`; }
      }
    }
    save(req.tenant, rfq);
    return view(req, rfq);
  }

  /**
   * Gera os pedidos de compra: um por fornecedor vencedor, copiando as linhas da oferta.
   * selection: [{ key, cardCode }] (linha sem vencedor não é comprada). closeLosers: fecha ofertas sem item vencedor.
   */
  async function award(req, id, { selection, closeLosers = true } = {}) {
    let rfq = load(req.tenant, id);
    if (rfq.status === 'AWARDED') throw bad('Esta cotação já gerou pedidos');
    if (rfq.status === 'CANCELLED') throw bad('Cotação cancelada');
    await sync(req, id);
    rfq = load(req.tenant, id);
    const map = buildMap(rfq);
    const sel = new Map((Array.isArray(selection) ? selection : map.lines.map((l) => ({ key: l.key, cardCode: l.winner })))
      .filter((x) => x && x.cardCode).map((x) => [Number(x.key), x.cardCode]));
    const byVendor = new Map();
    for (const [key, cardCode] of sel) {
      const l = map.lines.find((x) => x.key === key);
      const o = l && l.offers.find((x) => x.cardCode === cardCode);
      if (!o || !o.quoted) throw bad(`Item ${l ? l.itemName : key}: ${cardCode} não cotou este item`);
      const s = rfq.suppliers.find((x) => x.cardCode === cardCode);
      if (s.sync !== 'SYNCED') throw bad(`A resposta de ${s.cardName} ainda não foi gravada no B1${s.syncError ? `: ${s.syncError}` : ''}`);
      if (!byVendor.has(cardCode)) byVendor.set(cardCode, []);
      byVendor.get(cardCode).push({ l, o, s });
    }
    if (!byVendor.size) throw bad('Escolha o vencedor de ao menos um item');

    const orders = [];
    for (const [cardCode, rows] of byVendor) {
      const s = rows[0].s;
      const due = rows.map((r) => r.o.deliveryDate || r.l.requiredDate).filter(Boolean).sort().pop() || rfq.requiredDate;
      try {
        const r = await b1.createPurchaseOrder(req.tenant, req.session.ctx, req.session.user, {
          cardCode, branch: rfq.branch, dueDate: due < today() ? today() : due,
          numAtCard: s.answer.proposalRef || undefined,
          comments: `Cotação online nº ${rfq.id} (Portal)${rfq.title ? ` - ${rfq.title}` : ''}`,
          lines: rows.map((x) => ({ baseKind: 'pq', baseEntry: s.pq.entry, baseLine: s.lineMap[x.l.key], quantity: x.l.quantity, shipDate: x.o.deliveryDate || undefined }))
        });
        orders.push({ cardCode, cardName: s.cardName, ...r, total: round2(rows.reduce((acc, x) => acc + x.o.total, 0)), lines: rows.length });
      } catch (e) {
        orders.push({ cardCode, cardName: s.cardName, error: e.message, lines: rows.length });
      }
    }
    const created = orders.filter((o) => !o.error);
    if (!created.length) throw bad(`Nenhum pedido foi gerado: ${orders.map((o) => `${o.cardName}: ${o.error}`).join('; ')}`);

    if (closeLosers) {
      for (const s of rfq.suppliers) {
        if (byVendor.has(s.cardCode) || !s.pq || s.pq.source !== 'doc') continue;
        try { await b1.closeDoc(req.tenant, req.session.ctx, 'pq', s.pq.entry); s.pqClosed = true; } catch (e) { s.error = `Fechamento da oferta: ${e.message}`; }
      }
    }
    rfq.award = {
      at: new Date().toISOString(), by: req.session.user.userName,
      lines: [...sel].map(([key, cardCode]) => ({ key, cardCode })), orders
    };
    rfq.status = orders.some((o) => o.error) ? 'CLOSED' : 'AWARDED';
    save(req.tenant, rfq);
    return view(req, rfq);
  }

  /** Linhas de solicitações em aberto + em qual cotação aberta cada uma já está. */
  async function sources(req, branch) {
    const lines = await b1.openRequestLines(req.tenant, req.session.ctx, { branch });
    const used = new Map();
    store.list(COLL, req.tenant.id).filter((r) => ['OPEN', 'CLOSED'].includes(r.status))
      .forEach((r) => r.lines.forEach((l) => { if (l.prEntry) used.set(`${l.prEntry}:${l.prLine}`, r.id); }));
    return lines.map((l) => ({ ...l, inRfq: used.get(`${l.prEntry}:${l.prLine}`) || null }));
  }

  // ---------- público (fornecedor) ----------
  function publicGet(token) {
    const hit = findByToken(token);
    if (!hit) return null;
    const { rfq, supplier: s, tenantId } = hit;
    const tenant = tenantById(tenantId);
    if (!s.viewedAt) { s.viewedAt = new Date().toISOString(); if (s.status === 'INVITED') s.status = 'VIEWED'; store.put(COLL, tenantId, rfq.id, rfq); }
    return {
      tenant, rfq, supplier: s,
      data: {
        company: tenant ? tenant.name : '',
        number: rfq.id, title: rfq.title, message: rfq.message, deadline: rfq.deadline,
        open: canAnswer(rfq) && s.status !== 'ERROR', status: phase(rfq),
        buyer: { name: rfq.createdBy.userName, email: rfq.createdBy.email },
        supplier: { cardCode: s.cardCode, cardName: s.cardName },
        lines: rfq.lines.map((l) => ({ key: l.key, itemCode: l.itemCode, itemName: l.itemName, uom: l.uom, quantity: l.quantity, requiredDate: l.requiredDate, freeText: l.freeText })),
        answer: s.answer, answeredAt: s.answeredAt || null, declined: s.status === 'DECLINED'
      }
    };
  }

  async function publicSubmit(req, token, body) {
    const hit = findByToken(token);
    if (!hit) return null;
    const { rfq, supplier: s, tenantId } = hit;
    const tenant = tenantById(tenantId);
    if (!canAnswer(rfq)) throw bad('O prazo desta cotação terminou. Fale com o comprador.');
    const now = new Date().toISOString();
    if (body && body.decline) {
      Object.assign(s, { status: 'DECLINED', answer: null, answeredAt: now, answeredBy: 'fornecedor', declineReason: String(body.reason || '').slice(0, 120), sync: null });
    } else {
      const a = validateAnswer(rfq, body);
      if (Array.isArray(a)) throw bad(a.join('; '));
      Object.assign(s, { answer: a, status: 'ANSWERED', answeredAt: now, answeredBy: 'fornecedor', sync: 'PENDING' });
    }
    rfq.log.push({ at: now, by: `fornecedor ${s.cardCode}`, what: s.status === 'DECLINED' ? 'declinou' : 'respondeu' });
    store.put(COLL, tenantId, rfq.id, rfq);

    // Aviso ao comprador (em segundo plano)
    if (tenant && rfq.createdBy.email && settings.load(tenant.id).notify.rfqAnswered) {
      const answered = rfq.suppliers.filter((x) => x.status === 'ANSWERED').length;
      const quoted = s.answer ? s.answer.lines.filter((l) => l.quoted) : [];
      const total = quoted.reduce((acc, l) => acc + l.unitPrice * rfq.lines.find((x) => x.key === l.key).quantity, 0);
      const base = settings.load(tenant.id).general.portalUrl;
      setImmediate(() => mailer.send(tenant, {
        to: [rfq.createdBy.email],
        subject: `Cotação nº ${rfq.id}: ${s.cardName} ${s.status === 'DECLINED' ? 'declinou' : 'respondeu'}`,
        html: mailer.render(tenant, {
          title: s.status === 'DECLINED' ? `${s.cardName} não vai cotar` : `Nova resposta na cotação nº ${rfq.id}`,
          intro: s.status === 'DECLINED'
            ? `O fornecedor declinou o pedido de cotação.${s.declineReason ? ` Motivo: ${s.declineReason}` : ''}`
            : `${s.cardName} enviou preços. Já são ${answered} de ${rfq.suppliers.length} respostas. Abra o mapa de cotação para gravar no SAP e comparar.`,
          rows: s.status === 'DECLINED' ? [] : [['Itens cotados', `${quoted.length} de ${rfq.lines.length}`], ['Total cotado', money(total)],
            ['Cond. pagto', s.answer.paymentTerms], ['Frete', s.answer.freight], ['Validade', br(s.answer.validUntil)]],
          buttonText: 'Abrir mapa de cotação',
          buttonUrl: base ? `${base}/#/compras/cotacoes/${rfq.id}` : null
        })
      }, { mock: req.mock }).catch((e) => console.error('[email] rfqAnswered:', e.message)));
    }
    return publicGet(token).data;
  }

  return {
    create, list, get, sync, addSupplier, resend, buyerAnswer, close, reopen, cancel, award, sources,
    publicGet, publicSubmit
  };
}

module.exports = { createService, buildMap, validateAnswer, SLError };
