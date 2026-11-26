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

export const putPage = (page) => tx("pages", "readwrite", (s) => new Promise((resolve) => {
  const request = s.count();
  request.onsuccess = () => {
    const chooseFront = request.result === 0;
    s.add({ ...page, chooseFront });
    resolve(chooseFront);
  };
}));
export const setFrontChoice = (id, front) => tx("pages", "readwrite", (s) => {
  const request = s.get(id);
  request.onsuccess = () => {
    const page = request.result;
    if (page?.chooseFront) s.put({ ...page, chooseFront: false, cover: front ? "front" : "" });
  };
});
export const finishPendingPage = (page) => tx("pages", "readwrite", (s) => {
  const current = s.get(page.id);
  current.onsuccess = () => {
    if (current.result?.pending) s.put(page);
  };
});
export const updateBookPage = (id, result) => tx("pages", "readwrite", (s) => new Promise((resolve) => {
  const request = s.get(id);
  request.onsuccess = () => {
    const page = request.result;
    if (!page || page.pending) return resolve(false);
    s.put({ ...page, ...result });
    resolve(true);
  };
}));
export const delPage = (id) => tx("pages", "readwrite", (s) => { s.delete(id); });
export const getPage = (id) => tx("pages", "readonly", (s) => req(s.get(id)));
const byBookOrder = (a, b) => {
  const rank = (page) => page.cover === "front" ? -1 : page.cover === "back" ? 1 : 0;
  return rank(a) - rank(b) || a.order - b.order;
};

export const setLastPageCover = (candidate, mode) => tx("pages", "readwrite", (s) => new Promise((resolve) => {
  const request = s.getAll();
  request.onsuccess = () => {
    const pages = request.result.sort(byBookOrder);
    const last = pages.at(-1);
    if (pages.length < 2 || last.id !== candidate.id || last.cover !== candidate.cover
      || !last.raw || last.pending || last.cover === "front") {
      resolve(false);
      return;
    }
    const cover = last.cover === "back" ? "" : "back";
    s.put({ ...last, cover, mode: last.mode === "orig" ? mode : last.mode,
      pending: true, reclassify: true, forBack: false });
    resolve(true);
  };
}));

export const pruneBookOriginals = () => tx("pages", "readwrite", (s) => {
  const request = s.getAll();
  request.onsuccess = () => {
    const pages = request.result.sort(byBookOrder);
    const last = pages.findLast((page) => !page.cover);
    for (const page of pages) {
      if (page !== last && !page.pending && page.forBack) {
        s.put({ ...page, raw: null, forBack: false });
      }
    }
  };
});

/** sayfaları sırasıyla, yalnızca küçük önizlemeleriyle döner */
export async function listPages() {
  const all = await tx("pages", "readonly", (s) => req(s.getAll()));
  return all.sort(byBookOrder)
    .map(({ id, order, thumb, w, h, mode, cover, size, pending, failed, raw, chooseFront, forBack }) => ({
      id, order, thumb, w, h, mode, cover, size, pending: !!pending, failed: !!failed, hasRaw: !!raw, chooseFront, forBack
    }));
}
export const clearBook = () => tx("pages", "readwrite", (s) => { s.clear(); });
export const getMeta = (k) => tx("meta", "readonly", (s) => req(s.get(k)));
export const setMeta = (k, v) => tx("meta", "readwrite", (s) => { s.put(v, k); });

/** Uygulamalar arası dosya aktarımı (aynı adres: dogukaska.github.io) */
export function shareFile(name, blob, covers) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("paylasim", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("dosyalar");
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction("dosyalar", "readwrite");
      t.objectStore("dosyalar").put({ name, blob, covers, at: Date.now() }, "son");
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
  });
}

export async function storageInfo() {
  try { await navigator.storage?.persist?.(); } catch (e) {}
  try { return await navigator.storage.estimate(); } catch (e) { return null; }
}
