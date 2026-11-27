// Cola de sincronización, detección real de conexión y llamadas a Apps Script
import { CONFIG } from './config.js';
import * as db from './db.js';
const KEY = 'accessCode';
let running = false, online = false, lastError = '';
const listeners = [];
export const onChange = f => listeners.push(f);
const emit = () => listeners.forEach(f => f());
export const state = () => ({ online, running, lastError });

async function api(action, body = {}, retry = true) {
  if (!CONFIG.API_URL || CONFIG.API_URL.includes('[')) throw Object.assign(new Error('Falta configurar API_URL en config.js'), { code: 'CONFIG' });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), CONFIG.TIMEOUT_MS);
  try {
    const r = await fetch(CONFIG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, action, code: localStorage.getItem(KEY) || '' }), signal: ctl.signal });
    const j = await r.json();
    if (j.code === 'AUTH' && retry) {
      const c = prompt('Ingresa el código de acceso de la aplicación:');
      if (c !== null) { localStorage.setItem(KEY, c.trim()); return api(action, body, false); }
    }
    if (!j.ok) throw Object.assign(new Error(j.error || 'Error del servidor'), { code: j.code || 'SERVER', actual: j.actual });
    return j;
  } finally { clearTimeout(t); }
}

// "online" real: el navegador dice que hay red Y el servidor responde
export async function ping() {
  if (!navigator.onLine) { online = false; emit(); return false; }
  try { await api('ping'); online = true; lastError = ''; }
  catch (e) { online = false; lastError = e.code ? e.message : 'Sin respuesta del servidor'; }
  emit(); return online;
}

export async function enqueue(rec, field, value) {
  const ops = await db.getAll('cola');
  const prev = ops.find(o => o.dni === rec.DNI && o.field === field && o.estado === 'PENDIENTE');
  if (prev) await db.put('cola', { ...prev, value }); // fusiona ediciones: la base sigue siendo la del servidor
  else await db.put('cola', { opId: crypto.randomUUID(), dni: rec.DNI, field, value, base: rec[field],
    estado: 'PENDIENTE', intentos: 0, error: '', creado: new Date().toISOString() });
  await db.put('cosechadores', { ...rec, [field]: value });
  emit();
}

export async function syncAll(manual = false) {
  if (running) return;
  running = true; emit();
  try {
    if (!await ping()) return;
    let ops = (await db.getAll('cola')).filter(o => o.estado === 'PENDIENTE' || (manual && o.estado === 'ERROR' && o.code !== 'CONFLICTO'));
    ops.sort((a, b) => a.creado.localeCompare(b.creado));
    for (const o of ops) {
      try {
        await api('update', { opId: o.opId, dni: o.dni, field: o.field, value: o.value, base: o.base, force: !!o.force });
        await db.put('cola', { ...o, estado: 'SINCRONIZADO', error: '', code: '', fin: new Date().toISOString() });
      } catch (e) {
        const permanente = ['CONFLICTO', 'VALIDACION', 'NOENCONTRADO'].includes(e.code), n = o.intentos + 1;
        await db.put('cola', { ...o, intentos: n, code: e.code || 'RED', error: e.message, actual: e.actual,
          estado: permanente || n >= CONFIG.MAX_RETRIES ? 'ERROR' : 'PENDIENTE' });
        if (!e.code) break; // fallo de red: reintenta en el siguiente ciclo
      }
    }
    const j = await api('list'), all = await db.getAll('cola');
    const data = j.data.filter(r => r.DNI), map = Object.fromEntries(data.map(r => [r.DNI, r]));
    all.filter(o => o.estado === 'PENDIENTE').forEach(o => { if (map[o.dni]) map[o.dni][o.field] = o.value; });
    await db.replaceAll('cosechadores', data);
    await db.setMeta('last', new Date().toISOString());
    await db.setMeta('dupes', j.duplicados || 0);
    for (const o of all) if (o.estado === 'SINCRONIZADO' && Date.now() - Date.parse(o.fin || o.creado) > 7 * 864e5) await db.del('cola', o.opId);
    lastError = '';
  } catch (e) { lastError = e.message; }
  finally { running = false; emit(); }
}

// Conflictos: 'server' descarta mi cambio; 'mine' lo reenvía forzando
export async function resolve(opId, mode) {
  const o = (await db.getAll('cola')).find(x => x.opId === opId);
  if (!o) return;
  if (mode === 'server') await db.del('cola', opId);
  else await db.put('cola', { ...o, estado: 'PENDIENTE', force: true, intentos: 0, error: '' });
  emit(); syncAll();
}

export function start() {
  addEventListener('online', () => syncAll());
  addEventListener('offline', () => { online = false; emit(); });
  setInterval(() => { if (!document.hidden) syncAll(); }, CONFIG.SYNC_INTERVAL_MS);
  syncAll();
}
