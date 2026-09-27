'use strict';
/**
 * Ferramentas do Portal B1 para assistentes de IA (MCP). Cada ferramenta:
 *  - roda com a sessão B1 do próprio usuário (mesmas permissões e alçadas do SAP)
 *  - respeita o acesso por módulo do portal e as telas de comprador
 *  - ferramentas que alteram dados exigem token com escopo "write"
 * Os nomes e descrições são em português porque é o que o assistente mostra ao usuário.
 */
const compras = require('../modules/compras');
const relatorios = require('../modules/relatorios');
const notify = require('../core/notify');

const SLUG = { solicitacao: 'pr', oferta: 'pq', pedido: 'po' };
const KIND_NAME = { pr: 'solicitação de compra', pq: 'oferta de compra', po: 'pedido de compra' };
const today = () => new Date().toISOString().slice(0, 10);
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

function docView(doc) {
  return {
    tipo: KIND_NAME[doc.kind] || doc.kind,
    rascunho: doc.source === 'draft',
    numero: doc.source === 'draft' ? doc.entry : doc.docNum,
    status: doc.status,
    data: d10(doc.docDate), necessario_em: d10(doc.requiredDate), entrega: d10(doc.dueDate),
    fornecedor: doc.cardCode ? `${doc.cardCode} - ${doc.cardName}` : undefined,
    solicitante: doc.requesterName || doc.requester, total: doc.total, observacoes: doc.comments || undefined,
    itens: (doc.lines || []).map((l) => ({
      item: l.itemCode, descricao: l.itemName, quantidade: l.quantity, um: l.uom, preco: l.unitPrice, total: l.lineTotal,
      entrega: d10(l.shipDate || l.requiredDate), centro_custo: l.costCenter || undefined, contrato: l.agreementNo || undefined
    })),
    aprovacao: doc.approval ? {
      codigo: doc.approval.code, status: doc.approval.status,
      etapas: doc.approval.steps.map((s) => ({ etapa: s.stage, aprovador: s.userId, status: s.status, comentario: s.remarks || undefined }))
    } : undefined,
    gerado_no_sap: doc.generated ? { numero: doc.generated.docNum || doc.generated.entry } : undefined
  };
}

/** Definições: module = módulo do portal exigido; buyer = só compradores; write = altera dados no SAP. */
const TOOLS = [
  {
    name: 'listar_aprovacoes_pendentes',
    module: 'compras',
    description: 'Lista os documentos de compras (solicitação, oferta ou pedido de compra) e despesas que aguardam a decisão do usuário na etapa atual do procedimento de autorização do SAP B1.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(c) {
      const list = await c.b1.listPendingApprovals(c.tenant, c.ctx, c.user);
      return list.map((a) => ({
        codigo_aprovacao: a.approvalCode, tipo: a.docType === 'service' ? 'despesa' : KIND_NAME[a.kind], rascunho: a.draftEntry,
        solicitante: a.requester, fornecedor: a.cardName || undefined, total: a.total, data: d10(a.docDate), observacoes: a.comments || undefined
      }));
    }
  },
  {
    name: 'ver_documento_compra',
    module: 'compras',
    description: 'Mostra um documento de compras com itens, valores e histórico de aprovação. Use rascunho=true para documentos aguardando aprovação (o número é o do rascunho); caso contrário, o número é o Nº do documento no SAP.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['solicitacao', 'oferta', 'pedido'], description: 'Tipo do documento' },
        numero: { type: 'integer', description: 'Nº do documento no SAP, ou nº do rascunho se rascunho=true' },
        rascunho: { type: 'boolean', default: false }
      },
      required: ['tipo', 'numero'], additionalProperties: false
    },
    async run(c, a) {
      const kind = SLUG[a.tipo];
      if (!kind) throw bad('tipo deve ser solicitacao, oferta ou pedido');
      if (kind !== 'pr' && !a.rascunho && !c.isBuyer) throw bad('Consulta de ofertas e pedidos é exclusiva de compradores');
      let entry = Number(a.numero);
      if (!a.rascunho) {
        entry = await c.b1.entryByDocNum(c.tenant, c.ctx, kind, a.numero);
        if (!entry) throw bad(`${KIND_NAME[kind]} Nº ${a.numero} não encontrada`);
      }
      return docView(await c.b1.getRequest(c.tenant, c.ctx, a.rascunho ? 'draft' : 'doc', entry, kind));
    }
  },
  {
    name: 'decidir_aprovacao',
    module: 'compras',
    write: true,
    annotations: { destructiveHint: true, idempotentHint: false },
    description: 'Aprova ou reprova um documento pendente no SAP B1 em nome do usuário. SEMPRE confirme com o usuário antes de chamar. Reprovação exige comentário com o motivo.',
    inputSchema: {
      type: 'object',
      properties: {
        codigo_aprovacao: { type: 'integer', description: 'Código da aprovação (de listar_aprovacoes_pendentes)' },
        decisao: { type: 'string', enum: ['aprovar', 'reprovar'] },
        comentario: { type: 'string', maxLength: 254 }
      },
      required: ['codigo_aprovacao', 'decisao'], additionalProperties: false
    },
    async run(c, a) {
      const approve = a.decisao === 'aprovar';
      if (!approve && !String(a.comentario || '').trim()) throw bad('Informe o motivo da reprovação em "comentario"');
      const out = await c.b1.decide(c.tenant, c.ctx, Number(a.codigo_aprovacao), approve, String(a.comentario || '').slice(0, 254));
      c.audit(approve ? 'PR_APPROVE' : 'PR_REJECT', { approvalCode: Number(a.codigo_aprovacao) });
      if (out && out.draftEntry) notify.decided(c.req, c.b1, Number(out.draftEntry), approve, String(a.comentario || ''));
      return { ok: true, decisao: approve ? 'aprovado' : 'reprovado', status_atual: out && out.status };
    }
  },
  {
    name: 'listar_minhas_solicitacoes',
    module: 'compras',
    description: 'Lista as solicitações de compra do usuário (abertas, em aprovação, aprovadas e atendidas) com status e total.',
    inputSchema: {
      type: 'object',
      properties: { somente_em_andamento: { type: 'boolean', default: true, description: 'true = só abertas/em aprovação/aprovadas' } },
      additionalProperties: false
    },
    async run(c, a) {
      const list = await c.b1.listMyRequests(c.tenant, c.ctx, c.user, 'items');
      const onlyOpen = a.somente_em_andamento !== false;
      return list.filter((x) => !onlyOpen || ['PENDING', 'APPROVED', 'OPEN'].includes(x.status)).slice(0, 50).map((x) => ({
        numero: x.source === 'draft' ? x.entry : x.docNum, rascunho: x.source === 'draft', status: x.status,
        data: d10(x.docDate), necessario_em: d10(x.requiredDate), total: x.total, observacoes: x.comments || undefined
      }));
    }
  },
  {
    name: 'buscar_itens',
    module: 'compras',
    description: 'Busca itens de compra ativos no cadastro do SAP B1 por código ou descrição. Use antes de criar uma solicitação para obter o código exato do item.',
    inputSchema: { type: 'object', properties: { termo: { type: 'string', minLength: 2 } }, required: ['termo'], additionalProperties: false },
    async run(c, a) {
      return (await c.b1.searchItems(c.tenant, c.ctx, String(a.termo).slice(0, 50)))
        .map((i) => ({ codigo: i.itemCode, descricao: i.itemName, um: i.uom }));
    }
  },
  {
    name: 'criar_solicitacao_compra',
    module: 'compras',
    write: true,
    annotations: { destructiveHint: false, idempotentHint: false },
    description: 'Cria uma solicitação de compra no SAP B1 em nome do usuário. Confirme itens, quantidades e data com o usuário antes de chamar. Se houver procedimento de autorização, ela fica aguardando aprovação.',
    inputSchema: {
      type: 'object',
      properties: {
        data_necessaria: { type: 'string', description: 'AAAA-MM-DD' },
        observacoes: { type: 'string', maxLength: 254 },
        filial: { type: 'integer', description: 'ID da filial (obrigatório em empresas com filiais)' },
        itens: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object',
            properties: {
              codigo_item: { type: 'string' }, quantidade: { type: 'number', exclusiveMinimum: 0 },
              preco_estimado: { type: 'number', minimum: 0 }, centro_custo: { type: 'string' }, deposito: { type: 'string' }
            },
            required: ['codigo_item', 'quantidade'], additionalProperties: false
          }
        }
      },
      required: ['data_necessaria', 'itens'], additionalProperties: false
    },
    async run(c, a) {
      const payload = {
        requiredDate: a.data_necessaria, comments: a.observacoes || '', branch: a.filial,
        lines: (a.itens || []).map((l) => ({ itemCode: l.codigo_item, quantity: l.quantidade, unitPrice: l.preco_estimado, costCenter: l.centro_custo, warehouse: l.deposito }))
      };
      const errors = compras.validateRequest(payload);
      const branches = await c.b1.listBranches(c.tenant, c.ctx, c.user).catch(() => []);
      if (branches.length && !branches.some((b) => String(b.id) === String(a.filial))) {
        errors.push(`Informe a filial: ${branches.map((b) => `${b.id} = ${b.name}`).join('; ')}`);
      }
      if (errors.length) throw bad(errors.join('; '));
      const r = await c.b1.createPurchaseRequest(c.tenant, c.ctx, c.user, { ...payload, docType: 'items' });
      c.audit('PR_CREATE', { ...r, via: 'mcp' });
      if (r.source === 'draft') notify.approvalRequested(c.req, c.b1, r.entry);
      return r.source === 'draft'
        ? { criada: true, aguardando_aprovacao: true, rascunho: r.entry }
        : { criada: true, numero: r.docNum };
    }
  },
  {
    name: 'listar_pedidos_compra',
    module: 'compras',
    buyer: true,
    description: 'Lista pedidos de compra (abertos por padrão), com fornecedor, entrega e total. Inclui pedidos do usuário aguardando aprovação.',
    inputSchema: {
      type: 'object',
      properties: {
        situacao: { type: 'string', enum: ['abertos', 'fechados', 'todos'], default: 'abertos' },
        fornecedor: { type: 'string', description: 'Código do fornecedor (opcional)' }
      },
      additionalProperties: false
    },
    async run(c, a) {
      const status = { abertos: 'open', fechados: 'closed', todos: 'all' }[a.situacao || 'abertos'];
      const list = await c.b1.listDocs(c.tenant, c.ctx, c.user, 'po', { status, cardCode: a.fornecedor });
      return list.slice(0, 100).map((x) => ({
        numero: x.source === 'draft' ? x.entry : x.docNum, rascunho: x.source === 'draft', status: x.status,
        fornecedor: `${x.cardCode} - ${x.cardName}`, data: d10(x.docDate), entrega: d10(x.dueDate), total: x.total
      }));
    }
  },
  {
    name: 'listar_cotacoes',
    module: 'compras',
    buyer: true,
    description: 'Lista as cotações online (pedidos de cotação a fornecedores) com prazo, situação e quantos fornecedores responderam.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(c) {
      return c.rfq.list(c.req).slice(0, 50).map((r) => ({
        numero: r.id, descricao: r.title, situacao: r.status, prazo: r.deadline, itens: r.lines,
        responderam: `${r.answered}/${r.invited}`, pedidos_gerados: r.orders
      }));
    }
  },
  {
    name: 'ver_mapa_cotacao',
    module: 'compras',
    buyer: true,
    description: 'Mapa de uma cotação online: por item, preço, prazo (dias) e nota de cada fornecedor, e o recomendado por critério (menor preço, entrega mais rápida, equilíbrio preço x prazo); resumo com o total e o prazo médio de cada critério.',
    inputSchema: { type: 'object', properties: { numero: { type: 'integer' } }, required: ['numero'], additionalProperties: false },
    async run(c, a) {
      const r = c.rfq.get(c.req, a.numero);
      const name = Object.fromEntries(r.suppliers.map((s) => [s.cardCode, s.cardName]));
      return {
        numero: r.id, descricao: r.title, situacao: r.status, prazo: r.deadline,
        fornecedores: r.suppliers.map((s) => ({ codigo: s.cardCode, nome: s.cardName, situacao: s.status, condicao_pagamento: s.answer && s.answer.paymentTerms, frete: s.answer && s.answer.freight })),
        itens: r.map.lines.map((l) => ({
          item: `${l.itemCode} - ${l.itemName}`, quantidade: l.quantity, menor_preco: l.bestPrice, vencedor: l.winner ? name[l.winner] : null,
          recomendado: { menor_preco: name[l.recommended.price], entrega_mais_rapida: name[l.recommended.speed], equilibrio: name[l.recommended.balance] },
          ofertas: l.offers.filter((o) => o.quoted).map((o) => ({ fornecedor: name[o.cardCode], preco: o.unitPrice, total: o.total, entrega: o.deliveryDate, prazo_dias: o.leadDays, nota_equilibrio: o.score }))
        })),
        resumo: {
          melhor_preco_por_item: r.map.summary.bestMix,
          melhor_fornecedor_unico: r.map.summary.bestSingle ? { nome: name[r.map.summary.bestSingle.cardCode], total: r.map.summary.bestSingle.total } : null,
          ganho_dividindo: r.map.summary.savingVsSingle,
          por_criterio: {
            menor_preco: r.map.byCriterion.price, entrega_mais_rapida: r.map.byCriterion.speed, equilibrio: r.map.byCriterion.balance
          }
        }
      };
    }
  },
  {
    name: 'consultar_contratos',
    module: 'compras',
    buyer: true,
    description: 'Contratos guarda-chuva com fornecedores: vigência, valor planejado, consumido e saldo por item. Informe o número para ver um contrato específico.',
    inputSchema: {
      type: 'object',
      properties: { numero: { type: 'integer' }, fornecedor: { type: 'string', description: 'Código do fornecedor' }, somente_ativos: { type: 'boolean', default: true } },
      additionalProperties: false
    },
    async run(c, a) {
      if (a.numero) return c.b1.getAgreement(c.tenant, c.ctx, Number(a.numero));
      const list = await c.b1.listAgreements(c.tenant, c.ctx, { cardCode: a.fornecedor, activeOnly: a.somente_ativos !== false });
      return list.slice(0, 50).map(({ lines, ...x }) => x);
    }
  },
  {
    name: 'listar_relatorios',
    module: 'relatorios',
    description: 'Lista os relatórios disponíveis no portal (financeiro, vendas, compras, estoque) e os parâmetros de cada um.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(c) {
      return relatorios.catalogFor(c.tenant).map(relatorios.publicInfo)
        .map((r) => ({ id: r.id, titulo: r.title, categoria: r.category, descricao: r.description, parametros: r.params.map((p) => ({ nome: p.name, rotulo: p.label, tipo: p.type })) }));
    }
  },
  {
    name: 'executar_relatorio',
    module: 'relatorios',
    description: 'Executa um relatório do portal e devolve as linhas (até 200). Datas no formato AAAA-MM-DD.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, parametros: { type: 'object', additionalProperties: { type: ['string', 'number'] } } },
      required: ['id'], additionalProperties: false
    },
    async run(c, a) {
      const out = await relatorios.runReport(c.tenant, c.ctx, String(a.id), a.parametros || {}, c.mock);
      c.audit('REPORT_RUN', { report: out.report.id, rows: out.rows.length, via: 'mcp' });
      return { relatorio: out.report.title, colunas: out.columns.map((x) => x.label), linhas: out.rows.slice(0, 200), total_linhas: out.rows.length, truncado: out.truncated || out.rows.length > 200 };
    }
  }
];

module.exports = { TOOLS, today };
