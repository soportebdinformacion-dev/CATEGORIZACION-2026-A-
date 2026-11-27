// Única configuración editable. No coloques secretos aquí.
export const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbws9Kbf_aeQg2udt6IhzrWLNlpBzsEHY7yOT2p5l_6REpC6eHoPS0d2vXar0YbkEZF8WA/exec', // termina en /exec
  TIMEOUT_MS: 15000,
  MAX_RETRIES: 5,
  SYNC_INTERVAL_MS: 120000,
  EDITABLE_FIELDS: ['ASISTENCIA ACTUAL'] // debe coincidir con EDITABLE en codigo.gs
};
export const FIELDS = ['DNI','NOMBRE TRABAJADOR','MODALIDAD','HISTORICO','CUMP. %','TOTAL DIAS','CATEG. 2026','RANGO %','ORDEN_HISTORICO','ASISTENCIA ACTUAL'];
export const NUMERIC = ['CUMP. %','TOTAL DIAS','ORDEN_HISTORICO'];
