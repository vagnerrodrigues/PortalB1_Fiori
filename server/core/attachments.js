'use strict';
/**
 * Anexos NATIVOS do SAP B1 (objeto Attachments2 / OATC + ATC1).
 *  - upload: POST /Attachments2 (multipart/form-data) -> AbsoluteEntry
 *  - o documento recebe AttachmentEntry = AbsoluteEntry (aba "Anexos" no client B1)
 *  - download: GET /Attachments2(n)/$value?filename='<nome.ext>'
 *
 * Pré-requisito no B1: pasta de anexos definida em Parametrizações gerais > Caminho, com permissão
 * de gravação para o Service Layer (em HANA/Linux, a pasta precisa estar montada no servidor do SL).
 *
 * O front envia os arquivos em base64 dentro do JSON (simples e funciona no celular/câmera).
 */
const crypto = require('crypto');
const sl = require('./slClient');

const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB por arquivo
const ALLOWED = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'heic', 'webp', 'xml', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'zip'];
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const mockStore = new Map(); // modo demonstração
let mockSeq = 1;

function splitName(name) {
  const clean = String(name || 'arquivo').replace(/[\\/:*?"<>|]/g, '_').trim();
  const i = clean.lastIndexOf('.');
  const ext = i > 0 ? clean.slice(i + 1).toLowerCase() : '';
  const base = (i > 0 ? clean.slice(0, i) : clean)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sem acentos (nome de arquivo no servidor do B1)
    .replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 60) || 'arquivo';
  return { base, ext };
}

/** Valida e decodifica [{ name, data(base64) }]. Retorna { files, errors }. */
function parse(list) {
  const errors = [];
  const files = [];
  if (!Array.isArray(list) || !list.length) return { files, errors };
  if (list.length > MAX_FILES) errors.push(`Máximo de ${MAX_FILES} anexos`);
  list.slice(0, MAX_FILES).forEach((f, i) => {
    const { base, ext } = splitName(f && f.name);
    if (!ALLOWED.includes(ext)) { errors.push(`Anexo ${i + 1}: tipo .${ext || '?'} não permitido`); return; }
    const data = Buffer.from(String((f && f.data) || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!data.length) { errors.push(`Anexo ${i + 1}: arquivo vazio`); return; }
    if (data.length > MAX_BYTES) { errors.push(`Anexo ${i + 1}: maior que 10 MB`); return; }
    // prefixo único evita colisão de nomes na pasta de anexos do B1
    const unique = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${crypto.randomBytes(3).toString('hex')}_${base}`;
    files.push({ fileName: `${unique}.${ext}`, base: unique, ext, original: f.name, data, mime: MIME[ext] || 'application/octet-stream' });
  });
  return { files, errors };
}

function multipart(files) {
  const boundary = '----PortalB1' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  files.forEach((f) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.fileName}"\r\nContent-Type: ${f.mime}\r\n\r\n`, 'utf8'));
    parts.push(f.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Envia os arquivos ao B1 e devolve o AbsoluteEntry (ou null se não houver arquivos). */
async function upload(tenant, ctx, files, mock) {
  if (!files.length) return null;
  if (mock) {
    const entry = mockSeq++;
    mockStore.set(entry, files.map((f, i) => ({ line: i + 1, name: f.base, ext: f.ext, data: f.data, mime: f.mime, date: new Date().toISOString().slice(0, 10) })));
    return entry;
  }
  const { body, contentType } = multipart(files);
  try {
    const r = await sl.requestRaw(tenant, ctx.cookie, 'POST', '/Attachments2', { body, contentType });
    const json = Buffer.isBuffer(r) ? JSON.parse(r.toString('utf8')) : r;
    return json.AbsoluteEntry;
  } catch (e) {
    throw new sl.SLError(e.status || 500, e.code,
      `Não foi possível gravar o anexo no SAP B1: ${e.message}. Verifique a pasta de anexos em Parametrizações gerais > Caminho e a permissão do Service Layer nela.`);
  }
}

// Nome para exibição: sem o prefixo único que o portal adiciona (data_hash_)
const display = (name, ext) => `${String(name || '').replace(/^\d{8}_[0-9a-f]{6}_/, '')}${ext ? '.' + ext : ''}`;

/** Lista os arquivos de um AttachmentEntry. */
async function list(tenant, ctx, entry, mock) {
  if (!entry) return [];
  if (mock) return (mockStore.get(Number(entry)) || []).map(({ line, name, ext, date }) => ({ line, name, ext, date, display: display(name, ext) }));
  try {
    const a = await sl.request(tenant, ctx.cookie, 'GET', `/Attachments2(${Number(entry)})`);
    return (a.Attachments2_Lines || []).map((l, i) => ({
      line: l.LineNum ?? i + 1,
      name: l.FileName,
      ext: l.FileExtension,
      display: display(l.FileName, l.FileExtension),
      date: l.AttachmentDate || null
    }));
  } catch (e) {
    console.error(`[anexos] leitura do anexo ${entry} falhou: ${e.message}`);
    return [];
  }
}

/** Baixa um arquivo. Retorna { data, fileName, mime }. */
async function download(tenant, ctx, entry, line, mock) {
  const files = await list(tenant, ctx, entry, mock);
  const f = files.find((x) => String(x.line) === String(line));
  if (!f) throw new sl.SLError(404, 'NOT_FOUND', 'Anexo não encontrado');
  const fileName = f.ext ? `${f.name}.${f.ext}` : f.name;
  const mime = MIME[String(f.ext || '').toLowerCase()] || 'application/octet-stream';
  if (mock) {
    const m = (mockStore.get(Number(entry)) || []).find((x) => String(x.line) === String(line));
    return { data: m.data, fileName, mime };
  }
  const data = await sl.requestRaw(tenant, ctx.cookie, 'GET',
    `/Attachments2(${Number(entry)})/$value?filename='${encodeURIComponent(fileName)}'`, { binary: true });
  return { data, fileName, mime };
}

/** Envia o arquivo ao navegador (inline para PDF/imagem, download para o resto). */
function send(res, file) {
  const inline = /^(application\/pdf|image\/)/.test(file.mime);
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${file.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(file.data);
}

module.exports = { parse, upload, list, download, send, MAX_FILES, MAX_BYTES, ALLOWED };
