'use strict';
/** Utilidades Brasil: CNPJ/CPF (validação + máscara) e consulta pública de CNPJ (BrasilAPI). */
const https = require('https');

const digits = (s) => String(s || '').replace(/\D/g, '');

function validCNPJ(v) {
  const c = digits(v);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((acc, x, i) => acc + x * Number(c[i]), 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

function validCPF(v) {
  const c = digits(v);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

const maskCNPJ = (v) => digits(v).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const maskCPF = (v) => digits(v).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const maskCEP = (v) => digits(v).replace(/^(\d{5})(\d{3})$/, '$1-$2');

function getJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'PortalB1' }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Consulta dados públicos do CNPJ (Receita Federal via BrasilAPI) para pré-preencher o cadastro. */
async function lookupCNPJ(cnpj) {
  const d = await getJSON(`https://brasilapi.com.br/api/cnpj/v1/${digits(cnpj)}`);
  if (!d) return null;
  const phone = digits(d.ddd_telefone_1);
  return {
    taxId: maskCNPJ(cnpj),
    name: d.razao_social || '',
    tradeName: d.nome_fantasia || '',
    status: d.descricao_situacao_cadastral || '',
    cnae: d.cnae_fiscal_descricao || '',
    phone: phone ? phone.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') : '',
    email: (d.email || '').toLowerCase(),
    address: {
      zipCode: maskCEP(d.cep),
      street: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '),
      streetNo: d.numero || '',
      complement: d.complemento || '',
      block: d.bairro || '',
      city: d.municipio || '',
      state: d.uf || ''
    }
  };
}

/** Endereço pelo CEP (BrasilAPI v2, com fallback v1). */
async function lookupCEP(cep) {
  const c = digits(cep);
  let d = null;
  try { d = await getJSON(`https://brasilapi.com.br/api/cep/v2/${c}`); } catch (_) { d = await getJSON(`https://brasilapi.com.br/api/cep/v1/${c}`); }
  if (!d) return null;
  return { zipCode: maskCEP(c), street: d.street || '', block: d.neighborhood || '', city: d.city || '', state: d.state || '' };
}

module.exports = { digits, validCNPJ, validCPF, maskCNPJ, maskCPF, maskCEP, lookupCNPJ, lookupCEP };
