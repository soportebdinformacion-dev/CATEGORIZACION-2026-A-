/**
 * sync.js - Motor de Conectividad Real y Sincronización Offline-First
 * Categorización de Cosechadores 2026+
 */

import { localDB } from './db.js';

const MAX_RETRIES = 5;
const PING_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 20000;

export class SyncEngine {
  constructor(onStatusChange) {
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : () => {};
    this.isOnline = false;
    this.isSyncing = false;
    this.monitorTimer = null;
  }

  /**
   * Genera un identificador único estable e idempotente para cada operación.
   */
  generateOperationId(dni) {
    const randomPart = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
    return `${dni}_${randomPart}`;
  }

  /**
   * Obtiene las credenciales de sesión almacenadas localmente (sin hardcodear secretos).
   */
  async getCredentials() {
    const apiUrl = await localDB.getMeta('API_URL');
    const token = await localDB.getMeta('ACCESS_TOKEN');
    return { apiUrl, token };
  }

  /**
   * Guarda la URL del Web App de Apps Script y el Token de acceso de campo.
   */
  async saveCredentials(apiUrl, token) {
    await localDB.setMeta('API_URL', String(apiUrl || '').trim());
    await localDB.setMeta('ACCESS_TOKEN', String(token || '').trim());
  }

  /**
   * Verifica conectividad real mediante solicitud ligera 'ping' al servidor,
   * sin depender exclusivamente de navigator.onLine.
   */
  async checkRealConnectivity() {
    if (!navigator.onLine) {
      this.setOnlineState(false);
      return false;
    }

    const { apiUrl } = await this.getCredentials();
    if (!apiUrl) {
      this.setOnlineState(false);
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

    try {
      const pingUrl = `${apiUrl}?action=ping&_t=${Date.now()}`;
      const response = await fetch(pingUrl, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        this.setOnlineState(false);
        return false;
      }

      const data = await response.json();
      const online = Boolean(data && data.ok === true);
      this.setOnlineState(online);
      return online;
    } catch (_err) {
      clearTimeout(timeoutId);
      this.setOnlineState(false);
      return false;
    }
  }

  setOnlineState(online) {
    const changed = this.isOnline !== online;
    this.isOnline = online;
    if (changed) {
      this.onStatusChange({
        type: 'CONNECTIVITY',
        isOnline: this.isOnline
      });
    }
  }

  /**
   * Inicia monitoreo periódico y eventos de red del navegador.
   */
  startMonitoring(intervalMs = 25000) {
    window.addEventListener('online', async () => {
      const realOnline = await this.checkRealConnectivity();
      if (realOnline) {
        await this.syncAll();
      }
    });

    window.addEventListener('offline', () => {
      this.setOnlineState(false);
    });

    this.stopMonitoring();
    this.monitorTimer = setInterval(async () => {
      const wasOffline = !this.isOnline;
      const nowOnline = await this.checkRealConnectivity();
      const pending = await localDB.getPendingOperations();

      if (nowOnline && (wasOffline || pending.length > 0)) {
        await this.syncAll();
      }
    }, intervalMs);
  }

  stopMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  /**
   * Ejecuta ciclo completo de sincronización:
   * 1. Envía operaciones pendientes (cola) a Google Sheets.
   * 2. Descarga la última versión consolidada desde Google Sheets a IndexedDB.
   */
  async syncAll(manual = false) {
    if (this.isSyncing) {
      return { ok: false, message: 'Sincronización en curso.' };
    }

    const { apiUrl, token } = await this.getCredentials();
    if (!apiUrl || !token) {
      return { ok: false, code: 'MISSING_CONFIG', message: 'Falta configurar URL de API o Token.' };
    }

    const online = await this.checkRealConnectivity();
    if (!online) {
      return { ok: false, code: 'OFFLINE', message: 'Sin conexión real con el servidor.' };
    }

    this.isSyncing = true;
    this.onStatusChange({ type: 'SYNC_START', manual });

    try {
      // Paso 1: Enviar operaciones pendientes en cola
      const pushResult = await this.pushPendingOperations(apiUrl, token);

      // Paso 2: Descargar registros actualizados desde Google Sheets
      const pullResult = await this.pullServerRecords(apiUrl, token);

      const nowIso = new Date().toISOString();
      await localDB.setMeta('LAST_SYNC', nowIso);

      this.isSyncing = false;
      this.onStatusChange({
        type: 'SYNC_COMPLETE',
        lastSync: nowIso,
        pushResult,
        pullResult
      });

      return {
        ok: true,
        lastSync: nowIso,
        pushResult,
        pullResult
      };
    } catch (error) {
      this.isSyncing = false;
      this.onStatusChange({
        type: 'SYNC_ERROR',
        message: error.message
      });
      return {
        ok: false,
        message: error.message
      };
    }
  }

  /**
   * Envía en lote las operaciones pendientes con reintentos controlados.
   */
  async pushPendingOperations(apiUrl, token) {
    const pendingOps = await localDB.getPendingOperations();
    const eligibleOps = pendingOps.filter(op => (op.retries || 0) < MAX_RETRIES);

    if (eligibleOps.length === 0) {
      return { processed: 0, conflicts: 0, errors: 0 };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // Nota: Google Apps Script requiere text/plain para evitar preflight CORS complejo
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify({
          action: 'sync_batch',
          token: token,
          operations: eligibleOps.map(op => ({
            opId: op.opId,
            dni: op.dni,
            changes: op.changes,
            baseVersionHash: op.baseVersionHash,
            forceOverwrite: op.forceOverwrite
          }))
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status} al enviar cambios.`);
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.message || 'El servidor rechazó el lote de sincronización.');
      }

      let conflicts = 0;
      let errors = 0;
      let synced = 0;

      for (const res of (data.results || [])) {
        await localDB.updateOperationResult(res.opId, res);
        if (res.status === 'SINCRONIZADO') synced++;
        else if (res.status === 'CONFLICT') conflicts++;
        else errors++;
      }

      return { processed: synced, conflicts, errors };
    } catch (err) {
      clearTimeout(timeoutId);
      // Registrar intento fallido en cada operación del lote
      for (const op of eligibleOps) {
        await localDB.updateOperationResult(op.opId, {
          status: 'ERROR',
          message: err.name === 'AbortError'
            ? 'Tiempo de espera agotado al conectar con Google Sheets.'
            : err.message
        });
      }
      throw err;
    }
  }

  /**
   * Descarga todos los registros desde Google Sheets y los guarda en IndexedDB.
   */
  async pullServerRecords(apiUrl, token) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = `${apiUrl}?action=list&token=${encodeURIComponent(token)}&_t=${Date.now()}`;
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status} al consultar registros.`);
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.message || 'Error al obtener datos de Google Sheets.');
      }

      await localDB.saveServerRecords(data.records || []);
      return { total: (data.records || []).length };
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}
