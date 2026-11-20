'use strict';
/**
 * Registro de skills do Beto. Cada skill é uma pasta com:
 *   manifest.json  id, nome, versão, categoria, financialImpact, audience, params padrão, mockOnly
 *   detect.js      detect(ctx) -> Finding[]  e  describe(finding) -> { title, explanation, action }
 * Regra: skills NÃO acessam o Service Layer. Leem só o espelho analítico (etapa 2) ou, no modo demo, os dados sintéticos.
 */
const fs = require('fs');
const path = require('path');

const AUDIENCES = ['comprador', 'recebedor', 'gestor', 'todos'];

function load() {
  const dir = __dirname;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const manifest = require(path.join(dir, d.name, 'manifest.json'));
    const impl = require(path.join(dir, d.name, 'detect.js'));
    if (manifest.id !== d.name) throw new Error(`[beto] skill ${d.name}: id do manifest difere da pasta`);
    if (typeof impl.detect !== 'function' || typeof impl.describe !== 'function') throw new Error(`[beto] skill ${d.name}: detect/describe ausentes`);
    if (!AUDIENCES.includes(manifest.audience)) throw new Error(`[beto] skill ${d.name}: audience inválida`);
    return { ...manifest, financialImpact: !!manifest.financialImpact, params: manifest.params || {}, detect: impl.detect, describe: impl.describe };
  });
}

let cache = null;
const all = () => (cache = cache || load());
/** Skills disponíveis no modo atual (as mockOnly só aparecem com MOCK=1). */
const available = (mock) => all().filter((s) => mock || !s.mockOnly);

module.exports = { available, AUDIENCES };
