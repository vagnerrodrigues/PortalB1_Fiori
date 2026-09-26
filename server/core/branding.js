'use strict';
/**
 * Identidade visual (white-label): padrão do produto -> config/branding.json -> "branding" da empresa (tenants.json).
 * Logo customizada: coloque o arquivo em config/brand/ e aponte "logo": "brand/<arquivo>".
 */
const fs = require('fs');
const path = require('path');

const DEFAULT = {
  productName: 'Portal B1',
  company: 'Blue Ocean',
  logo: 'brand/blueocean.png',             // logo para fundo claro (login)
  logoOnDark: 'brand/blueocean-white.png', // logo para a barra superior escura
  colors: {
    primary: '#070070',      // azul-marinho Blue Ocean: botões principais, links, seleção
    primaryHover: '#0A0A9C',
    header: '#070070',       // barra superior
    headerText: '#FFFFFF',
    accent: '#035DD0',       // azul da onda: destaques e linha da barra
    loginFrom: '#070070',    // gradiente da tela de login
    loginTo: '#035DD0'
  }
};

const HEX = /^#[0-9a-fA-F]{6}$/;

function merge(base, over) {
  if (!over) return base;
  const out = { ...base, ...over, colors: { ...base.colors } };
  Object.entries(over.colors || {}).forEach(([k, v]) => { if (HEX.test(v)) out.colors[k] = v; });
  return out;
}

function loadGlobal() {
  const file = process.env.BRANDING_FILE || path.join(__dirname, '..', '..', 'config', 'branding.json');
  try { return merge(DEFAULT, fs.existsSync(file) ? require('./readJson')(file) : null); }
  catch (e) { console.warn('[branding] arquivo inválido, usando padrão:', e.message); return DEFAULT; }
}

const forTenant = (tenant) => merge(loadGlobal(), tenant && tenant.branding);

module.exports = { loadGlobal, forTenant };
