'use strict';
/** Lê JSON de configuração tolerando BOM (arquivos gravados pelo PowerShell/Bloco de Notas no Windows). */
const fs = require('fs');

module.exports = function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Arquivo de configuração inválido (${file}): ${e.message}`);
  }
};
