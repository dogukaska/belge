// Kitap sayfalarını telefonda (IndexedDB) saklar; sayfa kapansa da kaybolmaz.
const DB = "belge-kitap";

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("pages", { keyPath: "id" });
      db.createObjectStore("meta");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

let dbp = null;
const db = () => (dbp ??= open());

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Kaydedilemedi (telefonda yer kalmamış olabilir)"));
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const putPage = (p) => tx("pages", "readwrite", (s) => { s.put(p); });
export const finishPendingPage = (page) => tx("pages", "readwrite", (s) => {
  const current = s.get(page.id);
  current.onsuccess = () => {
    if (current.result?.pending) s.put(page);
  };
});
export const delPage = (id) => tx("pages", "readwrite", (s) => { s.delete(id); });
export const getPage = (id) => tx("pages", "readonly", (s) => req(s.get(id)));
/** sayfaları sırasıyla, yalnızca küçük önizlemeleriyle döner */
export async function listPages() {
  const all = await tx("pages", "readonly", (s) => req(s.getAll()));
  return all.sort((a, b) => a.order - b.order).map(({ id, order, thumb, w, h, mode, size, pending, failed }) => ({ id, order, thumb, w, h, mode, size, pending: !!pending, failed: !!failed }));
}
export const clearBook = () => tx("pages", "readwrite", (s) => { s.clear(); });
export const getMeta = (k) => tx("meta", "readonly", (s) => req(s.get(k)));
export const setMeta = (k, v) => tx("meta", "readwrite", (s) => { s.put(v, k); });

/** Uygulamalar arası dosya aktarımı (aynı adres: dogukaska.github.io) */
export function shareFile(name, blob) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("paylasim", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("dosyalar");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction("dosyalar", "readwrite");
      t.objectStore("dosyalar").put({ name, blob, at: Date.now() }, "son");
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
  });
}

export async function storageInfo() {
  try { await navigator.storage?.persist?.(); } catch (e) {}
  try { return await navigator.storage.estimate(); } catch (e) { return null; }
}
