// Única configuración editable. No coloques secretos aquí.
export const CONFIG = {
  API_URL: '[URL_DEL_WEB_APP_DE_APPS_SCRIPT]', // termina en /exec
  TIMEOUT_MS: 15000,
  MAX_RETRIES: 5,
  SYNC_INTERVAL_MS: 120000,
  EDITABLE_FIELDS: ['ASISTENCIA ACTUAL'] // debe coincidir con EDITABLE en codigo.gs
};
export const FIELDS = ['DNI','NOMBRE TRABAJADOR','MODALIDAD','HISTORICO','CUMP. %','TOTAL DIAS','CATEG. 2026','RANGO %','ORDEN_HISTORICO','ASISTENCIA ACTUAL'];
export const NUMERIC = ['CUMP. %','TOTAL DIAS','ORDEN_HISTORICO'];
