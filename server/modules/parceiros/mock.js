'use strict';
/** Parceiros em memória para o modo demonstração. Mesma interface de sl.js. */
const br = require('./br');
const { SLError } = require('../../core/slClient');

const bp = (cardCode, cardName, tradeName, type, taxId, city, state, phone, email, balance) => ({
  cardCode, cardName, tradeName, type, taxId, city, state, phone, email, balance, active: true,
  stateRegistration: '', notes: '', phone2: '', mobile: '', website: '', creditLimit: type === 'customer' ? 50000 : 0,
  addresses: [{ name: 'PRINCIPAL', type: 'bill', street: 'Av. Paulista', streetNo: '1000', complement: '', block: 'Bela Vista', zipCode: '01310-100', city, state }],
  contacts: [{ name: 'Contato ' + tradeName, phone, email, position: 'Compras' }]
});

const db = [
  bp('C0001', 'Alfa Indústria e Comércio Ltda', 'Alfa', 'customer', '11.222.333/0001-81', 'São Paulo', 'SP', '(11) 3333-1000', 'compras@alfa.com.br', 18450.9),
  bp('C0002', 'Beta Distribuidora S.A.', 'Beta Distribuição', 'customer', '45.287.913/0001-79', 'Campinas', 'SP', '(19) 3222-2000', 'financeiro@beta.com.br', 7230),
  bp('C0003', 'Gama Serviços Ltda', 'Gama', 'customer', '07.365.489/0001-44', 'Curitiba', 'PR', '(41) 3111-3000', 'contato@gama.com.br', 0),
  bp('F0001', 'Metalúrgica Paulista Ltda', 'Metalpa', 'supplier', '99.887.766/0001-05', 'Guarulhos', 'SP', '(11) 2444-4000', 'vendas@metalpa.com.br', -12500),
  bp('F0002', 'EPI Brasil Distribuidora Ltda', 'EPI Brasil', 'supplier', '33.445.566/0001-86', 'Belo Horizonte', 'MG', '(31) 3555-5000', 'vendas@epibrasil.com.br', -3200),
  bp('F0003', 'TechStore Informática Ltda', 'TechStore', 'supplier', '12.398.745/0001-30', 'São Paulo', 'SP', '(11) 3666-6000', 'b2b@techstore.com.br', 0)
];
let seq = 1;

const summary = ({ cardCode, cardName, tradeName, type, phone, email, city, balance, active }) =>
  ({ cardCode, cardName, tradeName, type, phone, email, city, balance, active });
const like = (a, b) => String(a || '').toLowerCase().includes(String(b || '').toLowerCase());

async function search(_t, _c, { term, type }) {
  const d = br.digits(term);
  return db.filter((b) => (!type || b.type === type) &&
    (!term || like(b.cardName, term) || like(b.cardCode, term) || like(b.tradeName, term) ||
      (d.length >= 11 && br.digits(b.taxId) === d)))
    .map(summary);
}

async function findByTaxId(_t, _c, taxId) {
  const d = br.digits(taxId);
  const hits = db.filter((b) => br.digits(b.taxId) === d).map((b) => ({ cardCode: b.cardCode, cardName: b.cardName, type: b.type }));
  return { hits, checked: true, via: 'mock' };
}

async function get(_t, _c, cardCode) {
  const b = db.find((x) => x.cardCode === cardCode);
  if (!b) throw new SLError(404, -2028, 'Parceiro não encontrado');
  return { ...b };
}

async function createLead(_t, _c, p) {
  const d = br.digits(p.taxId);
  const a = p.address || {};
  const lead = bp(`L${String(seq++).padStart(4, '0')}`, p.name, p.tradeName || '', 'lead',
    d.length === 14 ? br.maskCNPJ(d) : br.maskCPF(d), a.city || '', a.state || '', p.phone || '', p.email || '', 0);
  lead.stateRegistration = p.stateRegistration || '';
  lead.notes = p.notes || '';
  lead.addresses = a.street || a.zipCode ? [{ name: 'PRINCIPAL', type: 'bill', ...a }] : [];
  lead.contacts = p.contact && p.contact.name ? [{ ...p.contact, position: '' }] : [];
  db.push(lead);
  return { cardCode: lead.cardCode, cardName: lead.cardName };
}

module.exports = { search, findByTaxId, get, createLead, _db: db };
