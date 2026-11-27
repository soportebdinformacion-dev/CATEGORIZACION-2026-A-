# Categorización de Cosechadores – PWA (Agrícola Huarmey)

**Arquitectura:** HTML + CSS + JavaScript puro (módulos ES, sin dependencias ni build: lo más estable y fácil de mantener y funciona offline sin librerías externas). Datos en IndexedDB, Service Worker para el shell, y Google Apps Script como API sobre Google Sheets.

```
index.html  styles.css  app.js (UI/filtros/tabla)  db.js (IndexedDB)  sync.js (cola, conexión, API)
config.js (API_URL)  service-worker.js  manifest.json  codigo.gs (API)  assets/ (logo e iconos)
```

## 1. Google Sheets y Apps Script
1. Abre tu hoja y copia su ID (la parte entre `/d/` y `/edit` de la URL). La pestaña debe tener en la fila 1 exactamente: `DNI, NOMBRE TRABAJADOR, MODALIDAD, HISTORICO, CUMP. %, TOTAL DIAS, CATEG. 2026, RANGO %, ORDEN_HISTORICO, ASISTENCIA ACTUAL` (el orden no importa). Se leen como texto, así el DNI conserva sus ceros.
2. *Extensiones → Apps Script*, pega `codigo.gs` y reemplaza `[ID_DEL_SPREADSHEET]` y `[NOMBRE_EXACTO_DE_LA_PESTAÑA]`.
3. (Recomendado) *Configuración del proyecto → Propiedades del script* → agrega `ACCESS_CODE` con un código; cada usuario lo escribe una vez en su equipo. Nunca va en el código.
4. *Implementar → Nueva implementación → Aplicación web*: ejecutar como **Yo**; acceso según tu entorno (**Cualquier usuario** para equipos de campo, o solo tu organización). Autoriza permisos y copia la URL `/exec`.

## 2. Frontend
1. En `config.js` reemplaza `[URL_DEL_WEB_APP_DE_APPS_SCRIPT]`.
2. Publica la carpeta en cualquier hosting **HTTPS** (GitHub Pages, Netlify, Firebase Hosting). Las PWA no se instalan desde `file://`. Local: `python3 -m http.server 8000`.
3. Abre la URL, espera la primera sincronización y usa “Instalar / Agregar a pantalla de inicio”.
4. Al actualizar archivos, cambia `V` en `service-worker.js` para renovar la caché.

## Cómo funciona
- **Offline:** lo ya sincronizado se consulta sin internet. “En línea” exige que el navegador tenga red **y** que la API responda (ping).
- **Cola:** cada cambio (por defecto solo `ASISTENCIA ACTUAL`, botón en cada ficha) se guarda con `opId` único y estado PENDIENTE → SINCRONIZADO / ERROR. Reintentos automáticos cada 2 min (máx. 5) y botón “Sincronizar” manual. Panel “Cola de envío” con el detalle.
- **Idempotencia:** `codigo.gs` registra cada `opId` en la hoja oculta `_OPS`; reenviar no duplica.
- **Conflictos:** cada cambio viaja con el valor original (`base`). Si la hoja cambió, no se sobrescribe: queda en ERROR y el usuario elige “Usar valor de la hoja” o “Reenviar el mío”.
- **DNI repetidos:** se muestra solo el primero y aparece un aviso.
- **Concurrencia/límites:** las escrituras se serializan con `LockService` (espera 20 s) y las lecturas se cachean 60 s, así 20 usuarios generan pocas lecturas de la hoja. Google Sheets no es una base transaccional; Apps Script tiene cuotas diarias y tiempo máximo por ejecución (consulta las cuotas vigentes de tu cuenta).

## Pruebas sugeridas
1. Cargar con internet: logo, título, subtítulo y totales por MODALIDAD / HISTORICO / CATEG. 2026 coinciden con la hoja.
2. Buscar por DNI y por parte del nombre (sin importar mayúsculas); combinar filtros; ver que KPI, gráficos, fichas y tabla cambian juntos; “Limpiar filtros”.
3. Ordenar cada columna ↑/↓ (DNI como texto, CUMP. %/TOTAL DIAS como número); arrastrar el borde de un encabezado; deslizar en móvil.
4. Modo avión: recargar, los datos siguen; editar una ficha → “Pendiente”; reconectar → pasa a SINCRONIZADO y la hoja cambia.
5. Editar el mismo valor en la hoja y en la app → aparece CONFLICTO con las dos opciones.
6. Reenviar la misma operación dos veces (reintento) → una sola fila en `_OPS`.
7. 20 usuarios: abrir la app en 20 dispositivos/pestañas y editar a la vez; verificar sin duplicados ni errores LOCK persistentes.
8. Instalar como PWA en Android/iOS y escritorio.

## Supuestos a confirmar
- `ASISTENCIA ACTUAL` como único campo editable (cámbialo en `config.js` y `codigo.gs`).
- `CUMP. %`, `TOTAL DIAS` y `ORDEN_HISTORICO` se ordenan como números (lista `NUMERIC` en `config.js`); los filtros de CUMP. % y TOTAL DIAS son rangos mín–máx.
