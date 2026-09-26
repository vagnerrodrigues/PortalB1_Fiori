'use strict';
/**
 * Módulo Parceiros de negócio: consulta de clientes/fornecedores/leads e cadastro de LEAD.
 * Rotas montadas em /api/m/parceiros
 */
const express = require('express');
const br = require('./br');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UF = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

function validateLead(p) {
  const e = [];
  if (!p || typeof p !== 'object') return ['Payload inválido'];
  const d = br.digits(p.taxId);
  if (d.length === 14) { if (!br.validCNPJ(d)) e.push('CNPJ inválido'); }
  else if (d.length === 11) { if (!br.validCPF(d)) e.push('CPF inválido'); }
  else e.push('Informe um CNPJ ou CPF');
  if (!String(p.name || '').trim()) e.push('Razão social / nome obrigatório');
  if (p.email && !EMAIL.test(p.email)) e.push('E-mail inválido');
  const a = p.address || {};
  if (a.state && !UF.includes(String(a.state).toUpperCase())) e.push('UF inválida');
  if (a.zipCode && br.digits(a.zipCode).length !== 8) e.push('CEP inválido');
  return e;
}

module.exports = {
  id: 'parceiros',
  title: 'Parceiros de negócio',
  description: 'Clientes, fornecedores e leads',
  tiles: [
    { id: 'search', title: 'Consultar parceiros', subtitle: 'Clientes, fornecedores e leads', icon: 'sap-icon://customer-and-contacts', route: 'parceiros.list' },
    { id: 'new', title: 'Novo cadastro', subtitle: 'Cadastrar lead com CNPJ', icon: 'sap-icon://add-contact', route: 'parceiros.new' }
  ],

  createRouter({ mock, wrap, audit }) {
    const b1 = mock ? require('./mock') : require('./sl');
    const r = express.Router();

    r.get('/', wrap(async (req, res) => {
      const type = ['customer', 'supplier', 'lead'].includes(req.query.type) ? req.query.type : '';
      res.json(await b1.search(req.tenant, req.session.ctx, { term: String(req.query.q || '').trim().slice(0, 60), type }));
    }));

    // Consulta pública do CNPJ (Receita via BrasilAPI) + checagem de duplicidade no B1
    r.get('/cnpj/:taxId', wrap(async (req, res) => {
      const d = br.digits(req.params.taxId);
      if (!(d.length === 14 ? br.validCNPJ(d) : d.length === 11 && br.validCPF(d))) {
        return res.status(400).json({ error: d.length === 11 ? 'CPF inválido' : 'CNPJ inválido' });
      }
      // Receita e duplicidade em paralelo e independentes: uma falha não derruba a outra
      const [dup, rf] = await Promise.allSettled([
        b1.findByTaxId(req.tenant, req.session.ctx, d),
        d.length === 14 ? br.lookupCNPJ(d) : Promise.resolve(null)
      ]);
      const existing = dup.status === 'fulfilled' ? dup.value.hits : [];
      const duplicateCheck = dup.status === 'fulfilled' && dup.value.checked;
      const data = rf.status === 'fulfilled' ? rf.value : null;
      let lookupError = null;
      if (rf.status === 'rejected') lookupError = 'Consulta à Receita indisponível no momento. Preencha manualmente.';
      else if (d.length === 14 && !data) lookupError = 'CNPJ não encontrado na Receita. Confira o número ou preencha manualmente.';
      res.json({ existing, duplicateCheck, data, lookupError });
    }));

    r.get('/cep/:cep', wrap(async (req, res) => {
      const c = br.digits(req.params.cep);
      if (c.length !== 8) return res.status(400).json({ error: 'CEP inválido' });
      let data = null;
      try { data = await br.lookupCEP(c); } catch (_) { /* serviço fora */ }
      res.json({ data });
    }));

    r.get('/:cardCode', wrap(async (req, res) => {
      res.json(await b1.get(req.tenant, req.session.ctx, String(req.params.cardCode).slice(0, 15)));
    }));

    r.post('/', wrap(async (req, res) => {
      const errors = validateLead(req.body);
      if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
      let dup = { hits: [] };
      try { dup = await b1.findByTaxId(req.tenant, req.session.ctx, req.body.taxId); } catch (_) { /* segue sem checagem */ }
      if (dup.hits.length) {
        return res.status(409).json({ error: `Já existe cadastro com este documento: ${dup.hits[0].cardCode} - ${dup.hits[0].cardName}`, existing: dup.hits });
      }
      const out = await b1.createLead(req.tenant, req.session.ctx, req.body);
      audit(req, 'BP_CREATE_LEAD', out);
      res.status(201).json(out);
    }));

    return r;
  }
};
