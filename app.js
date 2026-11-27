/**
 * app.js - Lógica Principal de Interfaz, Filtros, Dashboard, Fichas y Tabla
 * Categorización de Cosechadores 2026+ - Agrícola Huarmey
 */

import { localDB } from './db.js';
import { SyncEngine } from './sync.js';

const PAGE_SIZE_CARDS = 24;

const state = {
  allRecords: [],
  filteredRecords: [],
  currentPage: 1,
  sortCol: 'ORDEN_HISTORICO',
  sortDir: 'asc', // 'asc' | 'desc'
  sortType: 'number',
  editingDni: null,
  deferredInstallPrompt: null,
  filters: {
    search: '',
    modalidad: '',
    historico: '',
    categ2026: '',
    rangoPct: '',
    cumpMin: '',
    cumpMax: '',
    diasMin: '',
    diasMax: ''
  }
};

// Instancia del motor de sincronización
const syncEngine = new SyncEngine(async (event) => {
  if (event.type === 'CONNECTIVITY') {
    updateConnectionBadge(event.isOnline);
  } else if (event.type === 'SYNC_START') {
    const btn = document.getElementById('btnManualSync');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Sincronizando...';
  } else if (event.type === 'SYNC_COMPLETE') {
    const btn = document.getElementById('btnManualSync');
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Sincronizar';
    updateLastSyncLabel(event.lastSync);
    await loadRecordsFromLocalDB();
    await refreshPendingBadge();

    if (event.pushResult && event.pushResult.conflicts > 0) {
      showAlert(
        `Sincronización completada con ${event.pushResult.conflicts} conflicto(s). Revisa la Cola de Sincronización para resolverlos.`,
        'error'
      );
    } else if (event.pushResult && event.pushResult.processed > 0) {
      showAlert(`Se sincronizaron ${event.pushResult.processed} cambio(s) correctamente con Google Sheets.`, 'success');
    }
  } else if (event.type === 'SYNC_ERROR') {
    const btn = document.getElementById('btnManualSync');
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Sincronizar';
    await refreshPendingBadge();
    showAlert(`Aviso de sincronización: ${event.message}`, 'error');
  }
});

/* ==========================================================================
   INICIALIZACIÓN DE LA APLICACIÓN Y SERVICE WORKER
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  registerServiceWorker();
  setupPwaInstallPrompt();
  bindEvents();
  initTableColumnResizing();

  await localDB.init();
  const lastSync = await localDB.getMeta('LAST_SYNC');
  updateLastSyncLabel(lastSync);

  // Cargar inmediatamente datos cacheados en IndexedDB (Offline-First)
  await loadRecordsFromLocalDB();
  await refreshPendingBadge();

  // Verificar si ya existen credenciales configuradas
  const creds = await syncEngine.getCredentials();
  if (!creds.apiUrl || !creds.token) {
    openModal('configModal');
  } else {
    const online = await syncEngine.checkRealConnectivity();
    updateConnectionBadge(online);
    if (online) {
      await syncEngine.syncAll(false);
    }
  }

  syncEngine.startMonitoring(25000);
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('No se pudo registrar el Service Worker:', err);
    });
  }
}

function setupPwaInstallPrompt() {
  const installBtn = document.getElementById('btnInstallPwa');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    installBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    installBtn.classList.add('hidden');
  });
}

/* ==========================================================================
   CARGA DE DATOS, FILTROS COMBINABLES Y ORDENAMIENTO
   ========================================================================== */
async function loadRecordsFromLocalDB() {
  const loadingBox = document.getElementById('cardsLoading');
  loadingBox.classList.remove('hidden');

  try {
    const records = await localDB.getAllRecords();
    state.allRecords = records;
    populateDynamicFilterOptions(records);
    applyFiltersAndRender();
  } catch (err) {
    showAlert('Error leyendo almacenamiento local: ' + err.message, 'error');
  } finally {
    loadingBox.classList.add('hidden');
  }
}

function populateDynamicFilterOptions(records) {
  fillSelectUnique('filterModalidad', records.map(r => r['MODALIDAD']), 'Todas las modalidades');
  fillSelectUnique('filterHistorico', records.map(r => r['HISTORICO']), 'Todos los históricos');
  fillSelectUnique('filterCateg2026', records.map(r => r['CATEG. 2026']), 'Todas las categorías 2026');
  fillSelectUnique('filterRangoPct', records.map(r => formatPctDisplay(r['RANGO %'])), 'Todos los rangos %');
}

function fillSelectUnique(selectId, values, defaultLabel) {
  const select = document.getElementById(selectId);
  const currentVal = select.value;
  const unique = Array.from(new Set(values.filter(v => v !== '' && v !== null && v !== undefined)))
    .sort((a, b) => String(a).localeCompare(String(b), 'es', { numeric: true }));

  select.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`;
  unique.forEach(val => {
    const opt = document.createElement('option');
    opt.value = String(val);
    opt.textContent = String(val);
    select.appendChild(opt);
  });

  if (unique.map(String).includes(currentVal)) {
    select.value = currentVal;
  }
}

function applyFiltersAndRender() {
  const f = state.filters;
  const query = f.search.trim().toLowerCase();

  const filtered = state.allRecords.filter(rec => {
    // 1. Búsqueda única por DNI o NOMBRE TRABAJADOR (case-insensitive)
    if (query) {
      const dniMatch = String(rec['DNI'] || '').toLowerCase().includes(query);
      const nameMatch = String(rec['NOMBRE TRABAJADOR'] || '').toLowerCase().includes(query);
      if (!dniMatch && !nameMatch) return false;
    }

    // 2. Filtros exactos por categoría
    if (f.modalidad && String(rec['MODALIDAD']) !== f.modalidad) return false;
    if (f.historico && String(rec['HISTORICO']) !== f.historico) return false;
    if (f.categ2026 && String(rec['CATEG. 2026']) !== f.categ2026) return false;
    if (f.rangoPct && formatPctDisplay(rec['RANGO %']) !== f.rangoPct) return false;

    // 3. Filtros numéricos de rango para CUMP. %
    const cumpVal = Number(rec['CUMP. %'] || 0);
    if (f.cumpMin !== '' && !isNaN(Number(f.cumpMin)) && cumpVal < Number(f.cumpMin)) return false;
    if (f.cumpMax !== '' && !isNaN(Number(f.cumpMax)) && cumpVal > Number(f.cumpMax)) return false;

    // 4. Filtros numéricos de rango para TOTAL DIAS
    const diasVal = Number(rec['TOTAL DIAS'] || 0);
    if (f.diasMin !== '' && !isNaN(Number(f.diasMin)) && diasVal < Number(f.diasMin)) return false;
    if (f.diasMax !== '' && !isNaN(Number(f.diasMax)) && diasVal > Number(f.diasMax)) return false;

    return true;
  });

  // Ordenar respetando el tipo de dato (texto vs número)
  filtered.sort((a, b) => compareValues(a[state.sortCol], b[state.sortCol], state.sortType, state.sortDir));

  state.filteredRecords = filtered;
  state.currentPage = 1;

  updateResultsCounter(filtered.length, state.allRecords.length);
  renderDashboard(filtered, state.allRecords.length);
  renderCardsPaginated();
  renderTable(filtered);
}

function compareValues(valA, valB, type, dir) {
  const factor = dir === 'asc' ? 1 : -1;

  if (type === 'number') {
    const numA = Number(valA) || 0;
    const numB = Number(valB) || 0;
    return (numA - numB) * factor;
  }

  // Comparación de texto (conserva ceros iniciales en DNI sin convertir a número)
  const strA = String(valA ?? '').trim();
  const strB = String(valB ?? '').trim();
  return strA.localeCompare(strB, 'es', { sensitivity: 'base' }) * factor;
}

/* ==========================================================================
   RENDERIZADO DEL DASHBOARD (SIN DUPLICAR PERSONAS POR DNI)
   ========================================================================== */
function renderDashboard(records, totalLoadedCount) {
  // Deduplicar estrictamente por DNI para contar cosechadores únicos
  const uniqueMap = new Map();
  records.forEach(rec => {
    const dni = String(rec['DNI'] || '').trim();
    if (dni && !uniqueMap.has(dni)) {
      uniqueMap.set(dni, rec);
    }
  });

  const uniqueWorkers = Array.from(uniqueMap.values());
  const totalUnique = uniqueWorkers.length;

  document.getElementById('kpiTotalUnique').textContent = totalUnique.toLocaleString('es-PE');
  document.getElementById('kpiTotalSubtitle').textContent =
    `De ${totalLoadedCount.toLocaleString('es-PE')} registros totales en base local`;

  if (totalUnique === 0) {
    document.getElementById('kpiAvgCump').textContent = '0.0%';
    document.getElementById('kpiAvgDias').textContent = '0.0';
  } else {
    const sumCump = uniqueWorkers.reduce((acc, r) => acc + (Number(r['CUMP. %']) || 0), 0);
    const sumDias = uniqueWorkers.reduce((acc, r) => acc + (Number(r['TOTAL DIAS']) || 0), 0);
    document.getElementById('kpiAvgCump').textContent = `${(sumCump / totalUnique).toFixed(1)}%`;
    document.getElementById('kpiAvgDias').textContent = (sumDias / totalUnique).toFixed(1);
  }

  renderDistributionChart('chartModalidad', countUniqueByField(uniqueWorkers, 'MODALIDAD'), totalUnique);
  renderDistributionChart('chartHistorico', countUniqueByField(uniqueWorkers, 'HISTORICO'), totalUnique);
  renderDistributionChart('chartCateg2026', countUniqueByField(uniqueWorkers, 'CATEG. 2026'), totalUnique);
}

function countUniqueByField(uniqueWorkers, fieldName) {
  const counts = {};
  uniqueWorkers.forEach(w => {
    const key = String(w[fieldName] || 'SIN ESPECIFICAR').trim() || 'SIN ESPECIFICAR';
    counts[key] = (counts[key] || 0) + 1;
  });

  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function renderDistributionChart(containerId, items, total) {
  const container = document.getElementById(containerId);
  if (!items || items.length === 0) {
    container.innerHTML = '<p class="offline-note">Sin datos para mostrar con los filtros actuales.</p>';
    return;
  }

  container.innerHTML = items.map(item => {
    const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : '0.0';
    return `
      <div class="bar-row">
        <div class="bar-row__header">
          <span>${escapeHtml(item.label)}</span>
          <span><strong>${item.count}</strong> pers. (${pct}%)</span>
        </div>
        <div class="bar-row__track">
          <div class="bar-row__fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================================================
   RENDERIZADO DE FICHAS INDIVIDUALES (10 CAMPOS EXACTOS)
   ========================================================================== */
function renderCardsPaginated() {
  const container = document.getElementById('cardsContainer');
  const emptyBox = document.getElementById('cardsEmpty');
  const records = state.filteredRecords;

  if (records.length === 0) {
    container.innerHTML = '';
    emptyBox.classList.remove('hidden');
    renderPaginationControls(0, 1);
    return;
  }

  emptyBox.classList.add('hidden');
  const totalPages = Math.ceil(records.length / PAGE_SIZE_CARDS);
  if (state.currentPage > totalPages) state.currentPage = totalPages;

  const startIdx = (state.currentPage - 1) * PAGE_SIZE_CARDS;
  const pageItems = records.slice(startIdx, startIdx + PAGE_SIZE_CARDS);

  container.innerHTML = pageItems.map(rec => {
    const syncStatus = rec._syncStatus || 'SINCRONIZADO';
    let cardModifier = '';
    let pillHtml = '<span class="sync-pill sync-pill--ok">SINCRONIZADO</span>';

    if (syncStatus === 'PENDIENTE') {
      cardModifier = 'worker-card--pending';
      pillHtml = '<span class="sync-pill sync-pill--pending">PENDIENTE</span>';
    } else if (syncStatus === 'ERROR' || syncStatus === 'CONFLICT') {
      cardModifier = 'worker-card--error';
      pillHtml = `<span class="sync-pill sync-pill--error">${escapeHtml(syncStatus)}</span>`;
    }

    return `
      <article class="worker-card ${cardModifier}">
        <div>
          <div class="worker-card__header">
            <div>
              <h3 class="worker-card__name">${escapeHtml(rec['NOMBRE TRABAJADOR'])}</h3>
              <span class="worker-card__dni">DNI: ${escapeHtml(rec['DNI'])}</span>
            </div>
            ${pillHtml}
          </div>

          <div class="worker-card__fields">
            <div class="field-item">
              <span class="field-item__label">MODALIDAD</span>
              <span class="field-item__value">${escapeHtml(rec['MODALIDAD'] || '-')}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">HISTORICO</span>
              <span class="field-item__value">${escapeHtml(rec['HISTORICO'] || '-')}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">CUMP. %</span>
              <span class="field-item__value">${formatPctDisplay(rec['CUMP. %'])}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">TOTAL DIAS</span>
              <span class="field-item__value">${escapeHtml(String(rec['TOTAL DIAS'] ?? 0))}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">CATEG. 2026</span>
              <span class="field-item__value">${escapeHtml(rec['CATEG. 2026'] || '-')}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">RANGO %</span>
              <span class="field-item__value">${formatPctDisplay(rec['RANGO %'])}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">ORDEN_HISTORICO</span>
              <span class="field-item__value">${escapeHtml(String(rec['ORDEN_HISTORICO'] ?? '-'))}</span>
            </div>
            <div class="field-item">
              <span class="field-item__label">ASISTENCIA ACTUAL</span>
              <span class="field-item__value">${escapeHtml(rec['ASISTENCIA ACTUAL'] || 'SIN REGISTRO')}</span>
            </div>
          </div>
        </div>

        <div class="worker-card__footer">
          <button type="button" class="btn btn--primary btn--sm" data-edit-dni="${escapeHtml(rec['DNI'])}">
            Actualizar Asistencia
          </button>
        </div>
      </article>
    `;
  }).join('');

  renderPaginationControls(totalPages, state.currentPage);
}

function renderPaginationControls(totalPages, currentPage) {
  const top = document.getElementById('cardsPaginationTop');
  const bottom = document.getElementById('cardsPaginationBottom');

  if (totalPages <= 1) {
    top.innerHTML = '';
    bottom.innerHTML = '';
    return;
  }

  const html = `
    <button type="button" class="btn btn--ghost btn--sm" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>
      &laquo; Anterior
    </button>
    <span style="font-size:0.85rem;font-weight:700;">Página ${currentPage} de ${totalPages}</span>
    <button type="button" class="btn btn--ghost btn--sm" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>
      Siguiente &raquo;
    </button>
  `;

  top.innerHTML = html;
  bottom.innerHTML = html;
}

/* ==========================================================================
   RENDERIZADO DE TABLA DETALLADA (MISMO ORDEN DE 10 COLUMNAS)
   ========================================================================== */
function renderTable(records) {
  const tbody = document.getElementById('tableBody');
  const stateBox = document.getElementById('tableStateBox');

  if (records.length === 0) {
    tbody.innerHTML = '';
    stateBox.textContent = 'No hay registros en la tabla para los filtros seleccionados.';
    stateBox.classList.remove('hidden');
    return;
  }

  stateBox.classList.add('hidden');

  // Renderizado eficiente mediante DocumentFragment
  const fragment = document.createDocumentFragment();
  records.forEach(rec => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-mono">${escapeHtml(rec['DNI'])}</td>
      <td>${escapeHtml(rec['NOMBRE TRABAJADOR'])}</td>
      <td>${escapeHtml(rec['MODALIDAD'])}</td>
      <td>${escapeHtml(rec['HISTORICO'])}</td>
      <td class="td-num">${formatPctDisplay(rec['CUMP. %'])}</td>
      <td class="td-num">${escapeHtml(String(rec['TOTAL DIAS'] ?? 0))}</td>
      <td>${escapeHtml(rec['CATEG. 2026'])}</td>
      <td class="td-num">${formatPctDisplay(rec['RANGO %'])}</td>
      <td class="td-num">${escapeHtml(String(rec['ORDEN_HISTORICO'] ?? 0))}</td>
      <td><strong>${escapeHtml(rec['ASISTENCIA ACTUAL'] || '-')}</strong></td>
    `;
    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll('#cosechadoresTable thead th').forEach(th => {
    const col = th.getAttribute('data-col');
    const indicator = th.querySelector('.sort-indicator');
    if (col === state.sortCol) {
      indicator.textContent = state.sortDir === 'asc' ? '▲' : '▼';
    } else {
      indicator.textContent = '↕';
    }
  });
}

/* ==========================================================================
   AJUSTE MANUAL DEL ANCHO DE COLUMNAS (MOUSE Y TÁCTIL)
   ========================================================================== */
function initTableColumnResizing() {
  const headers = document.querySelectorAll('#cosechadoresTable thead th');
  headers.forEach(th => {
    const resizer = th.querySelector('.col-resizer');
    if (!resizer) return;

    let startX = 0;
    let startWidth = 0;

    const onPointerMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const newWidth = Math.max(85, startWidth + (clientX - startX));
      th.style.width = `${newWidth}px`;
    };

    const onPointerUp = () => {
      resizer.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('touchmove', onPointerMove);
      document.removeEventListener('touchend', onPointerUp);
    };

    const onPointerDown = (e) => {
      e.stopPropagation();
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startWidth = th.offsetWidth;
      resizer.classList.add('is-resizing');
      document.addEventListener('mousemove', onPointerMove);
      document.addEventListener('mouseup', onPointerUp);
      document.addEventListener('touchmove', onPointerMove, { passive: true });
      document.addEventListener('touchend', onPointerUp);
    };

    resizer.addEventListener('mousedown', onPointerDown);
    resizer.addEventListener('touchstart', onPointerDown, { passive: true });
  });
}

/* ==========================================================================
   EVENTOS DE FILTROS, EDICIÓN EN CAMPO, COLA DE SYNC Y MODALES
   ========================================================================== */
function bindEvents() {
  // Búsqueda y filtros combinables
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    applyFiltersAndRender();
  });

  document.getElementById('filterModalidad').addEventListener('change', (e) => {
    state.filters.modalidad = e.target.value;
    applyFiltersAndRender();
  });

  document.getElementById('filterHistorico').addEventListener('change', (e) => {
    state.filters.historico = e.target.value;
    applyFiltersAndRender();
  });

  document.getElementById('filterCateg2026').addEventListener('change', (e) => {
    state.filters.categ2026 = e.target.value;
    applyFiltersAndRender();
  });

  document.getElementById('filterRangoPct').addEventListener('change', (e) => {
    state.filters.rangoPct = e.target.value;
    applyFiltersAndRender();
  });

  ['filterCumpMin', 'filterCumpMax', 'filterDiasMin', 'filterDiasMax'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      state.filters.cumpMin = document.getElementById('filterCumpMin').value;
      state.filters.cumpMax = document.getElementById('filterCumpMax').value;
      state.filters.diasMin = document.getElementById('filterDiasMin').value;
      state.filters.diasMax = document.getElementById('filterDiasMax').value;
      applyFiltersAndRender();
    });
  });

  // Limpiar todos los filtros
  document.getElementById('btnClearFilters').addEventListener('click', () => {
    state.filters = {
      search: '',
      modalidad: '',
      historico: '',
      categ2026: '',
      rangoPct: '',
      cumpMin: '',
      cumpMax: '',
      diasMin: '',
      diasMax: ''
    };
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterModalidad').value = '';
    document.getElementById('filterHistorico').value = '';
    document.getElementById('filterCateg2026').value = '';
    document.getElementById('filterRangoPct').value = '';
    document.getElementById('filterCumpMin').value = '';
    document.getElementById('filterCumpMax').value = '';
    document.getElementById('filterDiasMin').value = '';
    document.getElementById('filterDiasMax').value = '';
    applyFiltersAndRender();
  });

  // Ordenamiento en tabla
  document.querySelectorAll('#cosechadoresTable thead th .sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const th = btn.closest('th');
      const col = th.getAttribute('data-col');
      const type = th.getAttribute('data-type');

      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
        state.sortType = type;
      }
      applyFiltersAndRender();
    });
  });

  // Paginación y botones de edición en fichas (delegación de eventos)
  document.addEventListener('click', async (e) => {
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn && !pageBtn.disabled) {
      state.currentPage = Number(pageBtn.getAttribute('data-page'));
      renderCardsPaginated();
      document.getElementById('headingCards').scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const editBtn = e.target.closest('[data-edit-dni]');
    if (editBtn) {
      const dni = editBtn.getAttribute('data-edit-dni');
      await openEditWorkerModal(dni);
      return;
    }

    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) {
      closeModal(closeBtn.getAttribute('data-close-modal'));
    }
  });

  // Sincronización manual
  document.getElementById('btnManualSync').addEventListener('click', async () => {
    const res = await syncEngine.syncAll(true);
    if (!res.ok && res.code === 'MISSING_CONFIG') {
      openModal('configModal');
    } else if (!res.ok) {
      showAlert(res.message, 'error');
    }
  });

  // Abrir modal de configuración
  document.getElementById('btnConfigModal').addEventListener('click', async () => {
    const creds = await syncEngine.getCredentials();
    document.getElementById('inputApiUrl').value = creds.apiUrl || '';
    document.getElementById('inputAccessToken').value = creds.token || '';
    openModal('configModal');
  });

  // Guardar configuración
  document.getElementById('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiUrl = document.getElementById('inputApiUrl').value.trim();
    const token = document.getElementById('inputAccessToken').value.trim();

    await syncEngine.saveCredentials(apiUrl, token);
    closeModal('configModal');
    showAlert('Configuración guardada. Conectando con Google Sheets...', 'success');
    await syncEngine.syncAll(true);
  });

  // Selector de asistencia personalizada
  document.getElementById('selectAsistencia').addEventListener('change', (e) => {
    const customWrap = document.getElementById('customAsistenciaWrap');
    if (e.target.value === 'CUSTOM') {
      customWrap.classList.remove('hidden');
    } else {
      customWrap.classList.add('hidden');
    }
  });

  // Guardar actualización de ASISTENCIA ACTUAL
  document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.editingDni) return;

    const selectVal = document.getElementById('selectAsistencia').value;
    const finalVal = selectVal === 'CUSTOM'
      ? document.getElementById('inputCustomAsistencia').value.trim()
      : selectVal;

    if (!finalVal) {
      showAlert('Debes especificar un valor válido para ASISTENCIA ACTUAL.', 'error');
      return;
    }

    const opId = syncEngine.generateOperationId(state.editingDni);
    await localDB.updateRecordAndEnqueue(
      state.editingDni,
      { 'ASISTENCIA ACTUAL': finalVal },
      opId,
      false
    );

    closeModal('editModal');
    await loadRecordsFromLocalDB();
    await refreshPendingBadge();

    showAlert('Cambio guardado localmente como PENDIENTE. Intentando sincronizar...', 'success');

    // Intentar envío inmediato si hay red
    const online = await syncEngine.checkRealConnectivity();
    if (online) {
      await syncEngine.syncAll(false);
    }
  });

  // Abrir cola de sincronización
  document.getElementById('btnQueueModal').addEventListener('click', async () => {
    await renderQueueModal();
    openModal('queueModal');
  });

  document.getElementById('btnRetryAllQueue').addEventListener('click', async () => {
    await syncEngine.syncAll(true);
    await renderQueueModal();
  });

  document.getElementById('btnClearSyncedQueue').addEventListener('click', async () => {
    await localDB.clearSyncedOperations();
    await renderQueueModal();
    await refreshPendingBadge();
  });
}

async function openEditWorkerModal(dni) {
  const rec = await localDB.getRecordByDni(dni);
  if (!rec) return;

  state.editingDni = dni;
  document.getElementById('editDni').textContent = rec['DNI'];
  document.getElementById('editNombre').textContent = rec['NOMBRE TRABAJADOR'];
  document.getElementById('editCateg').textContent = rec['CATEG. 2026'] || '-';

  const select = document.getElementById('selectAsistencia');
  const customWrap = document.getElementById('customAsistenciaWrap');
  const customInput = document.getElementById('inputCustomAsistencia');

  const currentVal = String(rec['ASISTENCIA ACTUAL'] || '').trim();
  const presetOptions = Array.from(select.options).map(o => o.value);

  if (presetOptions.includes(currentVal)) {
    select.value = currentVal;
    customWrap.classList.add('hidden');
  } else {
    select.value = 'CUSTOM';
    customInput.value = currentVal;
    customWrap.classList.remove('hidden');
  }

  openModal('editModal');
}

async function renderQueueModal() {
  const listContainer = document.getElementById('queueListContainer');
  const ops = await localDB.getAllOperations();

  if (ops.length === 0) {
    listContainer.innerHTML = '<p class="offline-note">No hay operaciones registradas en la cola local.</p>';
    return;
  }

  listContainer.innerHTML = ops.slice().reverse().map(op => {
    let conflictHtml = '';
    if (op.status === 'CONFLICT' && op.serverConflictRecord) {
      conflictHtml = `
        <div class="conflict-box">
          <strong>Conflicto de edición concurrente:</strong><br/>
          Tu valor local: <strong>${escapeHtml(op.changes['ASISTENCIA ACTUAL'])}</strong><br/>
          Valor actual en Google Sheets: <strong>${escapeHtml(op.serverConflictRecord['ASISTENCIA ACTUAL'])}</strong>
          <div class="conflict-actions">
            <button type="button" class="btn btn--primary btn--sm" data-resolve-op="${escapeHtml(op.opId)}" data-choice="LOCAL">
              Conservar mi cambio local
            </button>
            <button type="button" class="btn btn--outline-red btn--sm" data-resolve-op="${escapeHtml(op.opId)}" data-choice="SERVER">
              Aceptar valor de Sheets
            </button>
          </div>
        </div>
      `;
    }

    return `
      <div class="queue-item">
        <div class="queue-item__top">
          <span>${escapeHtml(op.workerName)} (DNI: ${escapeHtml(op.dni)})</span>
          <span class="sync-pill ${op.status === 'SINCRONIZADO' ? 'sync-pill--ok' : op.status === 'PENDIENTE' ? 'sync-pill--pending' : 'sync-pill--error'}">
            ${escapeHtml(op.status)}
          </span>
        </div>
        <div>Cambio: <strong>ASISTENCIA ACTUAL &rarr; ${escapeHtml(op.changes['ASISTENCIA ACTUAL'])}</strong></div>
        <div style="font-size:0.76rem;color:#666;">Fecha: ${new Date(op.createdAt).toLocaleString('es-PE')} · Intentos: ${op.retries || 0}</div>
        ${op.lastError ? `<div style="color:#B51F14;font-size:0.8rem;">Detalle: ${escapeHtml(op.lastError)}</div>` : ''}
        ${conflictHtml}
      </div>
    `;
  }).join('');

  // Vincular botones de resolución de conflicto
  listContainer.querySelectorAll('[data-resolve-op]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const opId = btn.getAttribute('data-resolve-op');
      const choice = btn.getAttribute('data-choice');
      await localDB.resolveConflict(opId, choice);
      await loadRecordsFromLocalDB();
      await refreshPendingBadge();
      await renderQueueModal();
      if (choice === 'LOCAL') {
        await syncEngine.syncAll(true);
      }
    });
  });
}

/* ==========================================================================
   UTILIDADES DE UI
   ========================================================================== */
function updateConnectionBadge(isOnline) {
  const badge = document.getElementById('connectionBadge');
  const text = document.getElementById('connectionText');
  if (isOnline) {
    badge.className = 'conn-badge conn-badge--online';
    text.textContent = 'En línea (Sheets conectado)';
  } else {
    badge.className = 'conn-badge conn-badge--offline';
    text.textContent = 'Sin conexión (Modo Offline)';
  }
}

function updateLastSyncLabel(isoString) {
  const el = document.getElementById('lastSyncText');
  if (!isoString) {
    el.textContent = 'Última sinc.: Nunca';
    return;
  }
  const formatted = new Date(isoString).toLocaleString('es-PE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  el.textContent = `Última sinc.: ${formatted}`;
}

async function refreshPendingBadge() {
  const allOps = await localDB.getAllOperations();
  const activeCount = allOps.filter(op => op.status !== 'SINCRONIZADO').length;
  document.getElementById('pendingCountBadge').textContent = String(activeCount);
}

function updateResultsCounter(filteredCount, totalCount) {
  document.getElementById('resultsCountText').textContent =
    `Mostrando ${filteredCount.toLocaleString('es-PE')} de ${totalCount.toLocaleString('es-PE')} registros encontrados`;
}

function showAlert(message, type = 'success') {
  const banner = document.getElementById('alertBanner');
  banner.textContent = message;
  banner.className = `alert-banner alert-banner--${type}`;
  banner.classList.remove('hidden');

  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.classList.add('hidden');
  }, 7000);
}

function openModal(id) {
  const dlg = document.getElementById(id);
  if (dlg && typeof dlg.showModal === 'function' && !dlg.open) {
    dlg.showModal();
  }
}

function closeModal(id) {
  const dlg = document.getElementById(id);
  if (dlg && dlg.open) {
    dlg.close();
  }
}

function formatPctDisplay(val) {
  const num = Number(val);
  if (isNaN(num)) return String(val || '0%');
  return `${num.toFixed(1)}%`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
