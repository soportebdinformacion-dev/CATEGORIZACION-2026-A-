/**
 * db.js - Capa de Persistencia Local con IndexedDB
 * Categorización de Cosechadores 2026+
 *
 * Almacenes (Object Stores):
 * 1. cosechadores: Almacena los registros indexados por 'DNI' (texto exacto).
 * 2. sync_queue: Cola de operaciones pendientes/sincronizadas/error/conflicto.
 * 3. meta: Configuración local (URL de API, última sincronización, preferencias).
 */

const DB_NAME = 'HuarmeyCosechadoresDB';
const DB_VERSION = 1;

const STORES = {
  RECORDS: 'cosechadores',
  QUEUE: 'sync_queue',
  META: 'meta'
};

class LocalDatabase {
  constructor() {
    this.db = null;
  }

  /**
   * Abre o inicializa la base de datos IndexedDB.
   */
  async init() {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Almacén de registros de cosechadores (DNI como clave primaria de texto)
        if (!db.objectStoreNames.contains(STORES.RECORDS)) {
          const recordStore = db.createObjectStore(STORES.RECORDS, { keyPath: 'DNI' });
          recordStore.createIndex('MODALIDAD', 'MODALIDAD', { unique: false });
          recordStore.createIndex('HISTORICO', 'HISTORICO', { unique: false });
          recordStore.createIndex('CATEG_2026', 'CATEG. 2026', { unique: false });
        }

        // 2. Cola de sincronización offline
        if (!db.objectStoreNames.contains(STORES.QUEUE)) {
          const queueStore = db.createObjectStore(STORES.QUEUE, { keyPath: 'opId' });
          queueStore.createIndex('status', 'status', { unique: false });
          queueStore.createIndex('dni', 'dni', { unique: false });
          queueStore.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // 3. Metadatos y configuración de sesión
        if (!db.objectStoreNames.contains(STORES.META)) {
          db.createObjectStore(STORES.META, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(new Error('Error abriendo IndexedDB: ' + event.target.error));
      };
    });
  }

  /**
   * Reemplaza el catálogo local tras una descarga exitosa desde Google Sheets,
   * preservando cualquier cambio local que aún esté PENDIENTE en la cola.
   */
  async saveServerRecords(serverRecords) {
    await this.init();
    const pendingOps = await this.getPendingOperations();
    const pendingByDni = new Map();

    pendingOps.forEach(op => {
      pendingByDni.set(op.dni, op);
    });

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.RECORDS], 'readwrite');
      const store = tx.objectStore(STORES.RECORDS);

      store.clear();

      serverRecords.forEach(rawRec => {
        const record = { ...rawRec };
        // Si hay una operación local pendiente para este DNI, reflejar el valor local en UI
        if (pendingByDni.has(record.DNI)) {
          const pendingOp = pendingByDni.get(record.DNI);
          if (pendingOp.changes && pendingOp.changes['ASISTENCIA ACTUAL'] !== undefined) {
            record['ASISTENCIA ACTUAL'] = pendingOp.changes['ASISTENCIA ACTUAL'];
          }
          record._syncStatus = pendingOp.status;
        } else {
          record._syncStatus = 'SINCRONIZADO';
        }
        store.put(record);
      });

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(new Error('Error guardando registros locales: ' + e.target.error));
    });
  }

  /**
   * Obtiene todos los registros almacenados localmente.
   */
  async getAllRecords() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.RECORDS], 'readonly');
      const store = tx.objectStore(STORES.RECORDS);
      const req = store.getAll();

      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(new Error('Error leyendo registros locales: ' + e.target.error));
    });
  }

  /**
   * Obtiene un registro individual por DNI exacto.
   */
  async getRecordByDni(dni) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.RECORDS], 'readonly');
      const store = tx.objectStore(STORES.RECORDS);
      const req = store.get(String(dni));

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Actualiza un registro localmente y encola la operación de sincronización
   * de forma atómica en una sola transacción IndexedDB.
   */
  async updateRecordAndEnqueue(dni, changes, opId, forceOverwrite = false) {
    await this.init();
    const existing = await this.getRecordByDni(dni);
    if (!existing) {
      throw new Error(`No existe el trabajador con DNI ${dni} en la base local.`);
    }

    const updatedRecord = {
      ...existing,
      ...changes,
      _syncStatus: 'PENDIENTE'
    };

    const operation = {
      opId: opId,
      dni: String(dni),
      workerName: existing['NOMBRE TRABAJADOR'],
      changes: { ...changes },
      baseVersionHash: existing._versionHash || null,
      forceOverwrite: Boolean(forceOverwrite),
      status: 'PENDIENTE', // PENDIENTE | SINCRONIZADO | ERROR | CONFLICT
      retries: 0,
      lastError: null,
      serverConflictRecord: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.RECORDS, STORES.QUEUE], 'readwrite');
      tx.objectStore(STORES.RECORDS).put(updatedRecord);
      tx.objectStore(STORES.QUEUE).put(operation);

      tx.oncomplete = () => resolve({ record: updatedRecord, operation });
      tx.onerror = (e) => reject(new Error('Error encolando operación local: ' + e.target.error));
    });
  }

  /**
   * Obtiene todas las operaciones de la cola ordenadas por fecha de creación.
   */
  async getAllOperations() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.QUEUE], 'readonly');
      const store = tx.objectStore(STORES.QUEUE);
      const req = store.getAll();

      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        resolve(list);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Obtiene operaciones que requieren envío o reintento (PENDIENTE o ERROR).
   */
  async getPendingOperations() {
    const all = await this.getAllOperations();
    return all.filter(op => op.status === 'PENDIENTE' || op.status === 'ERROR');
  }

  /**
   * Actualiza el estado de una operación tras intentar sincronizarla con el servidor.
   */
  async updateOperationResult(opId, resultData) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.QUEUE, STORES.RECORDS], 'readwrite');
      const queueStore = tx.objectStore(STORES.QUEUE);
      const recordStore = tx.objectStore(STORES.RECORDS);

      const getOpReq = queueStore.get(opId);
      getOpReq.onsuccess = () => {
        const op = getOpReq.result;
        if (!op) return;

        op.status = resultData.status;
        op.updatedAt = new Date().toISOString();

        if (resultData.status === 'SINCRONIZADO') {
          op.lastError = null;
          op.serverConflictRecord = null;
          queueStore.put(op);

          const getRecReq = recordStore.get(op.dni);
          getRecReq.onsuccess = () => {
            const rec = getRecReq.result;
            if (rec) {
              const merged = resultData.updatedRecord
                ? { ...rec, ...resultData.updatedRecord, _syncStatus: 'SINCRONIZADO' }
                : { ...rec, _syncStatus: 'SINCRONIZADO' };
              recordStore.put(merged);
            }
          };
        } else if (resultData.status === 'CONFLICT') {
          op.lastError = resultData.message || 'Conflicto de versión detectado.';
          op.serverConflictRecord = resultData.serverRecord || null;
          queueStore.put(op);

          const getRecReq = recordStore.get(op.dni);
          getRecReq.onsuccess = () => {
            const rec = getRecReq.result;
            if (rec) {
              rec._syncStatus = 'CONFLICT';
              recordStore.put(rec);
            }
          };
        } else {
          op.retries = (op.retries || 0) + 1;
          op.lastError = resultData.message || 'Error desconocido al sincronizar.';
          queueStore.put(op);

          const getRecReq = recordStore.get(op.dni);
          getRecReq.onsuccess = () => {
            const rec = getRecReq.result;
            if (rec) {
              rec._syncStatus = 'ERROR';
              recordStore.put(rec);
            }
          };
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Resuelve un conflicto eligiendo la versión del servidor (descarta cambio local)
   * o forzando la versión local (reencola con forceOverwrite = true).
   */
  async resolveConflict(opId, choice) {
    await this.init();
    const ops = await this.getAllOperations();
    const op = ops.find(item => item.opId === opId);
    if (!op) throw new Error('Operación de conflicto no encontrada.');

    if (choice === 'SERVER') {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORES.QUEUE, STORES.RECORDS], 'readwrite');
        const queueStore = tx.objectStore(STORES.QUEUE);
        const recordStore = tx.objectStore(STORES.RECORDS);

        if (op.serverConflictRecord) {
          recordStore.put({
            ...op.serverConflictRecord,
            _syncStatus: 'SINCRONIZADO'
          });
        }
        queueStore.delete(opId);

        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => reject(e.target.error);
      });
    } else if (choice === 'LOCAL') {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction([STORES.QUEUE, STORES.RECORDS], 'readwrite');
        const queueStore = tx.objectStore(STORES.QUEUE);
        const recordStore = tx.objectStore(STORES.RECORDS);

        op.status = 'PENDIENTE';
        op.forceOverwrite = true;
        op.lastError = null;
        op.updatedAt = new Date().toISOString();
        queueStore.put(op);

        const getRec = recordStore.get(op.dni);
        getRec.onsuccess = () => {
          if (getRec.result) {
            getRec.result._syncStatus = 'PENDIENTE';
            recordStore.put(getRec.result);
          }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = (e) => reject(e.target.error);
      });
    }
  }

  /**
   * Elimina operaciones ya sincronizadas antiguas para mantener ligera la base local.
   */
  async clearSyncedOperations() {
    await this.init();
    const all = await this.getAllOperations();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.QUEUE], 'readwrite');
      const store = tx.objectStore(STORES.QUEUE);
      all.filter(op => op.status === 'SINCRONIZADO').forEach(op => store.delete(op.opId));
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Guarda un valor en metadatos (ej. última fecha de sincronización, URL API).
   */
  async setMeta(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.META], 'readwrite');
      tx.objectStore(STORES.META).put({ key, value });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Lee un valor desde metadatos.
   */
  async getMeta(key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORES.META], 'readonly');
      const req = tx.objectStore(STORES.META).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = (e) => reject(e.target.error);
    });
  }
}

export const localDB = new LocalDatabase();
