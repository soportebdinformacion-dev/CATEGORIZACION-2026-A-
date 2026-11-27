/** API de CATEGORIZACIÓN DE COSECHADORES – Google Apps Script (Web App) */
const CFG = {
  SPREADSHEET_ID: '[ID_DEL_SPREADSHEET]',
  SHEET: '[NOMBRE_EXACTO_DE_LA_PESTAÑA]',
  FIELDS: ['DNI','NOMBRE TRABAJADOR','MODALIDAD','HISTORICO','CUMP. %','TOTAL DIAS','CATEG. 2026','RANGO %','ORDEN_HISTORICO','ASISTENCIA ACTUAL'],
  EDITABLE: ['ASISTENCIA ACTUAL'],   // debe coincidir con EDITABLE_FIELDS en config.js
  OPS_SHEET: '_OPS'                  // bitácora oculta (idempotencia)
};
const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const sheet_ = () => { const s = SpreadsheetApp.openById(CFG.SPREADSHEET_ID).getSheetByName(CFG.SHEET); if (!s) throw new Error('Pestaña no encontrada'); return s; };

function doGet() { return out({ ok: true, msg: 'API Categorización de Cosechadores' }); }

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);
    const ac = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE'); // opcional
    if (ac && String(b.code) !== ac) return out({ ok: false, code: 'AUTH', error: 'Código de acceso incorrecto' });
    if (b.action === 'ping') return out({ ok: true, ts: new Date().toISOString() });
    if (b.action === 'list') return out(list_());
    if (b.action === 'update') return out(update_(b));
    return out({ ok: false, code: 'ACCION', error: 'Acción no válida' });
  } catch (err) { console.error(err); return out({ ok: false, code: 'SERVER', error: 'Error interno del servidor' }); }
}

// Caché en trozos (límite 100 KB por clave) para no leer la hoja en cada consulta
function cachePut_(s) { const c = CacheService.getScriptCache(), n = Math.ceil(s.length / 90000), o = { 'list_n': String(n) }; for (let i = 0; i < n; i++) o['list_' + i] = s.substr(i * 90000, 90000); c.putAll(o, 60); }
function cacheGet_() { const c = CacheService.getScriptCache(), n = +c.get('list_n'); if (!n) return null; const k = []; for (let i = 0; i < n; i++) k.push('list_' + i); const p = c.getAll(k); let s = ''; for (const x of k) { if (!p[x]) return null; s += p[x]; } return s; }
function cacheClear_() { const c = CacheService.getScriptCache(), n = +c.get('list_n') || 0, k = ['list_n']; for (let i = 0; i < n; i++) k.push('list_' + i); c.removeAll(k); }

function list_() {
  const hit = cacheGet_(); if (hit) return JSON.parse(hit);
  const v = sheet_().getDataRange().getDisplayValues();   // texto tal cual se ve: conserva ceros del DNI
  const hd = v[0].map(x => String(x).trim()), ix = CFG.FIELDS.map(f => hd.indexOf(f));
  const miss = CFG.FIELDS.filter((f, i) => ix[i] < 0);
  if (miss.length) return { ok: false, code: 'ENCABEZADOS', error: 'Faltan encabezados en la hoja: ' + miss.join(', ') };
  const seen = {}, data = []; let dup = 0;
  for (let i = 1; i < v.length; i++) {
    const r = {}; CFG.FIELDS.forEach((f, j) => r[f] = String(v[i][ix[j]]).trim());
    if (!r.DNI) continue;
    if (seen[r.DNI]) { dup++; continue; } seen[r.DNI] = 1; data.push(r);
  }
  const res = { ok: true, data: data, duplicados: dup, generado: new Date().toISOString() };
  try { cachePut_(JSON.stringify(res)); } catch (e) {}
  return res;
}

function update_(b) {
  const val = typeof b.value === 'string' ? b.value.trim() : '';
  if (!b.opId || !/^[0-9A-Za-z-]{4,20}$/.test(String(b.dni)) || CFG.EDITABLE.indexOf(b.field) < 0 || !val || val.length > 50 || /^[=+\-@]/.test(val))
    return { ok: false, code: 'VALIDACION', error: 'Datos inválidos' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, code: 'LOCK', error: 'Servidor ocupado; se reintentará' };
  try {
    const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
    let ops = ss.getSheetByName(CFG.OPS_SHEET); if (!ops) { ops = ss.insertSheet(CFG.OPS_SHEET); ops.hideSheet(); }
    const ids = ops.getLastRow() ? ops.getRange(1, 1, ops.getLastRow(), 1).getValues().flat() : [];
    if (ids.indexOf(b.opId) > -1) return { ok: true, status: 'DUPLICADO' };   // operación idempotente
    const s = sheet_(), v = s.getDataRange().getDisplayValues(), hd = v[0].map(x => String(x).trim());
    const ci = hd.indexOf(b.field), di = hd.indexOf('DNI');
    if (ci < 0 || di < 0) return { ok: false, code: 'ENCABEZADOS', error: 'Encabezado no encontrado' };
    let row = -1; for (let i = 1; i < v.length; i++) if (String(v[i][di]).trim() === String(b.dni)) { row = i + 1; break; }
    if (row < 0) return { ok: false, code: 'NOENCONTRADO', error: 'El DNI no existe en la hoja' };
    const cur = String(v[row - 1][ci]).trim();
    if (!b.force && cur !== String(b.base).trim()) return { ok: false, code: 'CONFLICTO', error: 'El valor cambió en la hoja', actual: cur };
    s.getRange(row, ci + 1).setValue(val);
    ops.appendRow([b.opId, "'" + b.dni, b.field, cur, val, new Date()]);
    cacheClear_();
    return { ok: true, status: 'OK' };
  } finally { lock.releaseLock(); }
}
