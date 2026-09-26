'use strict';
/**
 * Notificações por e-mail das etapas do fluxo (Compras e Despesas).
 *  approvalRequested -> aprovador(es) da etapa atual
 *  approved/rejected -> solicitante
 *  generated         -> solicitante
 * Sempre em segundo plano: falha de e-mail é registrada no log e na auditoria, nunca bloqueia o B1.
 */
const settings = require('./settings');
const mailer = require('./mailer');
const { audit } = require('./audit');

const money = (v) => (v === null || v === undefined || v === '') ? '' :
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const date = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '');
const clean = (s) => String(s || '').replace(/^\[DESPESA\]\s*/, '');

function label(doc) {
  const expense = doc.docType === 'service';
  const kind = expense ? 'Despesa' : 'Solicitação de compra';
  const id = doc.source === 'draft' ? `rascunho ${doc.entry}` : `nº ${doc.docNum}`;
  return { kind, id, expense };
}

function link(tenant, hash) {
  const base = settings.load(tenant.id).general.portalUrl;
  return base ? `${base}/#/${hash}` : null;
}

function rows(doc) {
  return [
    ['Solicitante', doc.requesterName || doc.requester],
    ['Data', date(doc.docDate)],
    ['Total', money(doc.total)],
    ['Observações', clean(doc.comments)],
    ['Itens', (doc.lines || []).slice(0, 5).map((l) => l.itemName || l.itemCode).filter(Boolean).join('; ') + ((doc.lines || []).length > 5 ? '…' : '')]
  ];
}

/** Dispara em segundo plano; nunca lança erro. */
function fire(req, event, fn) {
  const tenant = req.tenant;
  if (!settings.load(tenant.id).notify[event]) return;
  setImmediate(async () => {
    try {
      const r = await fn();
      if (r && r.to && r.to.length) {
        const out = await mailer.send(tenant, r, { mock: req.mock });
        audit(req, 'EMAIL', { event, to: r.to, ok: out.ok, skipped: out.skipped, error: out.error });
        if (!out.ok && out.error) console.error(`[email] ${event}: ${out.error}`);
      }
    } catch (e) {
      console.error(`[email] ${event} falhou: ${e.message}`);
    }
  });
}

/** Documento retido para aprovação -> aprovadores da etapa atual. */
function approvalRequested(req, b1, draftEntry) {
  fire(req, 'approvalRequested', async () => {
    const doc = await b1.getRequest(req.tenant, req.session.ctx, 'draft', draftEntry);
    const ap = doc.approval;
    if (!ap) return null;
    const ids = ap.steps.filter((s) => s.status === 'PENDING' && (ap.currentStage == null || String(s.stage) === String(ap.currentStage))).map((s) => s.userId);
    const approvers = (await b1.usersContact(req.tenant, req.session.ctx, ids)).filter((u) => u.email);
    const { kind, id } = label(doc);
    return {
      to: approvers.map((u) => u.email),
      subject: `Aprovação pendente: ${kind} ${id} — ${doc.requesterName || req.session.user.userName}`,
      html: mailer.render(req.tenant, {
        title: `${kind} aguardando sua aprovação`,
        intro: `${doc.requesterName || req.session.user.userName} enviou ${kind.toLowerCase()} (${id}) que depende da sua decisão.`,
        rows: rows(doc),
        buttonText: 'Revisar e aprovar',
        buttonUrl: link(req.tenant, `compras/solicitacao/draft/${draftEntry}?mode=approve&code=${ap.code}`)
      })
    };
  });
}

/** Decisão do aprovador -> solicitante. */
function decided(req, b1, draftEntry, approve, remarks) {
  fire(req, approve ? 'approved' : 'rejected', async () => {
    const doc = await b1.getRequest(req.tenant, req.session.ctx, 'draft', draftEntry);
    const who = await b1.usersContact(req.tenant, req.session.ctx, [doc.approval && doc.approval.originatorId, doc.requester]);
    const to = [...new Set(who.map((u) => u.email).filter(Boolean))];
    const { kind, id, expense } = label(doc);
    const r = rows(doc);
    r.push(['Decisão', `${approve ? 'Aprovada' : 'Reprovada'} por ${req.session.user.userName}`], ['Comentário', remarks]);
    return {
      to,
      subject: `${kind} ${id} ${approve ? 'aprovada' : 'reprovada'}`,
      html: mailer.render(req.tenant, {
        title: `${kind} ${approve ? 'aprovada' : 'reprovada'}`,
        intro: approve
          ? `Sua ${kind.toLowerCase()} (${id}) foi aprovada. Abra no portal e clique em "Gerar no SAP" para efetivar.`
          : `Sua ${kind.toLowerCase()} (${id}) foi reprovada. Veja o motivo abaixo.`,
        rows: r,
        buttonText: approve ? 'Abrir e gerar no SAP' : 'Ver no portal',
        buttonUrl: link(req.tenant, expense ? `despesas/draft/${draftEntry}` : `compras/solicitacao/draft/${draftEntry}`)
      })
    };
  });
}

/** Documento efetivado no B1 -> solicitante (confirmação com o número definitivo). */
function generated(req, b1, draftEntry) {
  fire(req, 'generated', async () => {
    const doc = await b1.getRequest(req.tenant, req.session.ctx, 'draft', draftEntry);
    const { kind, expense } = label(doc);
    const num = doc.generated ? (doc.generated.docNum || doc.generated.entry) : '';
    const to = [req.session.user.email].filter(Boolean);
    return {
      to,
      subject: `${kind} gerada no SAP${num ? ` — nº ${num}` : ''}`,
      html: mailer.render(req.tenant, {
        title: `${kind} gerada no SAP B1`,
        intro: `O documento foi efetivado no SAP Business One${num ? ` com o número ${num}` : ''}.`,
        rows: rows(doc),
        buttonText: 'Ver no portal',
        buttonUrl: link(req.tenant, expense ? `despesas/draft/${draftEntry}` : `compras/solicitacao/draft/${draftEntry}`)
      })
    };
  });
}

module.exports = { approvalRequested, decided, generated };
