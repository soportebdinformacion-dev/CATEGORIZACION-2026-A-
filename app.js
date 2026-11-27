import { CONFIG, FIELDS, NUMERIC } from './config.js';
import * as db from './db.js';
import * as sync from './sync.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace('%', '').replace(',', '.')); return Number.isNaN(n) ? null : n; };
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SEL = ['MODALIDAD', 'HISTORICO', 'CATEG. 2026', 'RANGO %'];
const F0 = { q: '', MODALIDAD: '', HISTORICO: '', 'CATEG. 2026': '', 'RANGO %': '' };
let rows = [], pend = new Set(), f = { ...F0 }, sort = { k: '', d: 1 }, limit = 60, widths = {};
FIELDS.forEach(k => widths[k] = k === 'NOMBRE TRABAJADOR' ? 240 : k === 'DNI' ? 110 : 130);

function view() {
  const q = norm(f.q.trim());
  let r = rows.filter(x => (!q || norm(x.DNI).includes(q) || norm(x['NOMBRE TRABAJADOR']).includes(q)) &&
    SEL.every(k => !f[k] || x[k] === f[k]));
  if (sort.k) {
    const nm = NUMERIC.includes(sort.k);
    r = [...r].sort((a, b) => {
      let A = a[sort.k], B = b[sort.k];
      if (nm) { A = num(A); B = num(B); if (A === null || B === null) return A === B ? 0 : A === null ? 1 : -1; return (A - B) * sort.d; }
      return String(A).localeCompare(String(B), 'es', { numeric: true }) * sort.d;
    });
  }
  return r;
}
const COL = ['linear-gradient(90deg,#5aa312,#78BE20)', 'linear-gradient(90deg,#DA291C,#f0645a)', 'linear-gradient(90deg,#8A8178,#b3aca5)', 'linear-gradient(90deg,#9bd24a,#c3e68f)', 'linear-gradient(90deg,#f0645a,#f7a29c)', 'linear-gradient(90deg,#b3aca5,#d6d1cb)'];
const count = (r, k) => { const m = new Map(); r.forEach(x => { const v = x[k] || '(sin dato)'; (m.get(v) || m.set(v, new Set()).get(v)).add(x.DNI); }); return [...m].map(([v, s]) => [v, s.size]).sort((a, b) => b[1] - a[1]); };
function bars(id, r, k) {
  const d = count(r, k), mx = Math.max(1, ...d.map(x => x[1]));
  $(id).innerHTML = d.map(([v, n], i) => `<div class="bar-row"><span class="bl" title="${esc(v)}">${esc(v)}</span><span class="bt"><i style="width:${n / mx * 100}%;background:${COL[i % COL.length]}"></i></span><b>${n}</b></div>`).join('') || '<p class="muted">Sin datos</p>';
}
const ini = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const card = x => {
  const c = num(x['CUMP. %']), p = c === null ? 0 : Math.max(0, Math.min(100, c));
  const b = (k, cl) => `<span class="b ${cl}"><small>${k}</small>${esc(x[k]) || '—'}</span>`;
  const t = k => `<div class="tile"><dt>${k}</dt><dd>${esc(x[k]) || '—'}</dd></div>`;
  return `<article class="card"><div class="top"><span class="av">${esc(ini(x['NOMBRE TRABAJADOR']))}</span><div class="who"><h3>${esc(x['NOMBRE TRABAJADOR'])}</h3><p class="dni">🪪 DNI ${esc(x.DNI)}${pend.has(x.DNI) ? ' <span class="tag">⏳ Pendiente</span>' : ''}</p></div></div>
<div class="badges">${b('MODALIDAD', 'o')}${b('HISTORICO', 'y')}${b('CATEG. 2026', 'g')}</div>
<div class="prog"><div class="pl"><span>CUMP. %</span><b>${esc(x['CUMP. %']) || '—'}</b></div><div class="pt"><i style="width:${p}%"></i></div></div>
<dl class="tiles">${t('TOTAL DIAS')}${t('RANGO %')}${t('ORDEN_HISTORICO')}${t('ASISTENCIA ACTUAL')}</dl>
${CONFIG.EDITABLE_FIELDS.length ? `<button class="sec" data-edit="${esc(x.DNI)}">✏️ Editar ${esc(CONFIG.EDITABLE_FIELDS[0])}</button>` : ''}</article>`;
};

function render() {
  const r = view();
  $('#total').textContent = new Set(r.map(x => x.DNI)).size;
  $('#totalAll').textContent = `de ${rows.length} registros cargados`;
  bars('#mod', r, 'MODALIDAD'); bars('#his', r, 'HISTORICO'); bars('#cat', r, 'CATEG. 2026');
  $('#count').textContent = `${r.length} resultado${r.length === 1 ? '' : 's'}`;
  $('#cards').innerHTML = r.slice(0, limit).map(card).join('');
  $('#tbody').innerHTML = r.slice(0, limit).map(x => `<tr>${FIELDS.map(k => `<td>${esc(x[k])}</td>`).join('')}</tr>`).join('');
  $('#more').hidden = r.length <= limit;
  const m = $('#msg');
  if (!rows.length) { m.hidden = false; m.className = 'state'; m.textContent = sync.state().running ? '⏳ Cargando datos…' : sync.state().lastError ? `⚠️ ${sync.state().lastError}` : 'Aún no hay datos. Conéctate a internet para la primera sincronización.'; }
  else if (!r.length) { m.hidden = false; m.className = 'state'; m.textContent = '🔎 No hay coincidencias. Prueba con otros filtros o límpialos.'; }
  else m.hidden = true;
  $('#tbl').style.width = FIELDS.reduce((s, k) => s + widths[k], 0) + 'px';
}
function head() {
  $('#cols').innerHTML = FIELDS.map(k => `<col style="width:${widths[k]}px">`).join('');
  $('#thead').innerHTML = '<tr>' + FIELDS.map(k => `<th scope="col" aria-sort="${sort.k === k ? (sort.d > 0 ? 'ascending' : 'descending') : 'none'}"><button data-sort="${esc(k)}">${esc(k)} ${sort.k === k ? (sort.d > 0 ? '▲' : '▼') : '↕'}</button><span class="rs" data-rs="${esc(k)}"></span></th>`).join('') + '</tr>';
}
function selects() {
  SEL.forEach(k => {
    const el = document.querySelector(`[data-f="${k}"]`), vals = [...new Set(rows.map(x => x[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    el.innerHTML = '<option value="">Todos</option>' + vals.map(v => `<option>${esc(v)}</option>`).join(''); el.value = vals.includes(f[k]) ? f[k] : '';
  });
}
async function status() {
  const s = sync.state(), last = await db.getMeta('last'), dup = await db.getMeta('dupes');
  $('#net').textContent = s.online ? '📶 En línea' : '📵 Sin conexión';
  $('#net').className = s.online ? 'ok' : 'off';
  $('#last').textContent = '🕒 Última sincronización: ' + (last ? new Date(last).toLocaleString('es-PE') : 'nunca');
  const ops = await db.getAll('cola'), p = ops.filter(o => o.estado === 'PENDIENTE').length, e = ops.filter(o => o.estado === 'ERROR').length;
  $('#pend').textContent = `⏳ ${p} pendiente(s)` + (e ? ` · ⚠️ ${e} con error` : '');
  $('#bSync').disabled = s.running; $('#bSync').textContent = s.running ? '🔄 Sincronizando…' : '🔄 Sincronizar';
  $('#warn').hidden = !dup; $('#warn').textContent = dup ? `⚠️ La hoja tiene ${dup} DNI repetido(s); se muestra solo el primero de cada uno.` : '';
  $('#opsList').innerHTML = ops.sort((a, b) => b.creado.localeCompare(a.creado)).slice(0, 40).map(o => `<li><b>${esc(o.estado)}</b> · DNI ${esc(o.dni)} · ${esc(o.field)}: “${esc(o.base)}” → “${esc(o.value)}”${o.error ? `<br><small>${esc(o.error)}${o.actual !== undefined ? ` (valor actual en la hoja: “${esc(o.actual)}”)` : ''}</small>` : ''}${o.code === 'CONFLICTO' && o.estado === 'ERROR' ? `<br><button class="sec" data-res="server" data-id="${o.opId}">Usar valor de la hoja</button> <button class="sec" data-res="mine" data-id="${o.opId}">Reenviar el mío</button>` : ''}</li>`).join('') || '<li>Sin operaciones.</li>';
}
async function load() {
  rows = await db.getAll('cosechadores');
  pend = new Set((await db.getAll('cola')).filter(o => o.estado !== 'SINCRONIZADO').map(o => o.dni));
  selects(); render(); status();
}
function toast(t, cls = '') { const el = $('#toast'); el.textContent = t; el.className = 'show ' + cls; clearTimeout(toast.t); toast.t = setTimeout(() => el.className = '', 4000); }

async function edit(dni) {
  const x = rows.find(r => r.DNI === dni), fld = CONFIG.EDITABLE_FIELDS[0];
  const v = prompt(`${fld} de ${x['NOMBRE TRABAJADOR']}:`, x[fld]);
  if (v === null) return;
  const t = v.trim();
  if (!t || t.length > 50 || /^[=+\-@]/.test(t)) return toast('Valor no válido: no puede estar vacío, superar 50 caracteres ni empezar con = + - @.', 'err');
  if (t === x[fld]) return;
  await sync.enqueue(x, fld, t); await load();
  toast('Cambio guardado en el equipo. Se enviará cuando haya conexión.', 'good'); sync.syncAll();
}

// Eventos
let tm;
$('#q').addEventListener('input', e => { clearTimeout(tm); tm = setTimeout(() => { f.q = e.target.value; limit = 60; render(); }, 200); });
document.querySelectorAll('[data-f]').forEach(el => el.addEventListener('change', e => { f[el.dataset.f] = e.target.value; limit = 60; render(); }));
$('#reset').onclick = () => { f = { ...F0 }; document.querySelectorAll('.filters input,.filters select').forEach(el => el.value = ''); limit = 60; render(); };
$('#more').onclick = () => { limit += 100; render(); };
$('#bSync').onclick = () => sync.syncAll(true);
$('#bPanel').onclick = () => $('#panel').showModal();
$('#close').onclick = () => $('#panel').close();
$('#cards').addEventListener('click', e => { const b = e.target.closest('[data-edit]'); if (b) edit(b.dataset.edit); });
$('#panel').addEventListener('click', e => { const b = e.target.closest('[data-res]'); if (b) sync.resolve(b.dataset.id, b.dataset.res); });
$('#thead').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]'); if (!b) return;
  sort = sort.k === b.dataset.sort ? { k: sort.k, d: -sort.d } : { k: b.dataset.sort, d: 1 }; head(); render();
});
$('#thead').addEventListener('pointerdown', e => {
  const h = e.target.closest('[data-rs]'); if (!h) return;
  const k = h.dataset.rs, x0 = e.clientX, w0 = widths[k], idx = FIELDS.indexOf(k);
  h.setPointerCapture(e.pointerId);
  const mv = ev => { widths[k] = Math.max(70, w0 + ev.clientX - x0); $('#cols').children[idx].style.width = widths[k] + 'px'; $('#tbl').style.width = FIELDS.reduce((s, c) => s + widths[c], 0) + 'px'; };
  h.addEventListener('pointermove', mv); h.addEventListener('pointerup', () => h.removeEventListener('pointermove', mv), { once: true });
});
sync.onChange(() => { load(); });

head(); load().then(() => sync.start());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
