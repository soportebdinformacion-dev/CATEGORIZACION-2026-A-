// Acceso a IndexedDB: cosechadores (DNI), cola (opId), meta (k)
let _db;
const open = () => _db || (_db = new Promise((res, rej) => {
  const r = indexedDB.open('cosechadores-db', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('cosechadores', { keyPath: 'DNI' });
    d.createObjectStore('cola', { keyPath: 'opId' });
    d.createObjectStore('meta', { keyPath: 'k' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const tx = async (s, m, f) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(s, m), o = f(t.objectStore(s));
    t.oncomplete = () => res(o && o.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
};
export const getAll = s => tx(s, 'readonly', o => o.getAll());
export const put = (s, v) => tx(s, 'readwrite', o => o.put(v));
export const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));
export const replaceAll = (s, arr) => tx(s, 'readwrite', o => { o.clear(); arr.forEach(v => o.put(v)); return o; });
export const getMeta = async k => (await tx('meta', 'readonly', o => o.get(k)))?.v;
export const setMeta = (k, v) => put('meta', { k, v });
