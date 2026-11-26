// Kitap sayfalarını telefonda (IndexedDB) saklar; sayfa kapansa da kaybolmaz.
const DB = "belge-kitap";

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = (e) => {
      const db = r.result;
      if (e.oldVersion < 1) {
        db.createObjectStore("pages", { keyPath: "id" });
        db.createObjectStore("meta");
      }
      db.createObjectStore("images");
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  });
}

let dbp = null;
const db = () => (dbp ??= open());

async function tx(store, mode, fn, withImages = false) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(withImages ? [store, "images"] : store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s, withImages ? t.objectStore("images") : null)).then((v) => { out = v; }, rej);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("Kaydedilemedi (telefonda yer kalmamış olabilir)"));
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// IndexedDB'de dosya referansı yerine fotoğrafın baytlarını sakla.
const packPhoto = async (blob) => blob && { bytes: await blob.arrayBuffer(), type: blob.type };
const unpackPhoto = (photo) => photo?.bytes
  ? new Blob([photo.bytes], { type: photo.type }) : photo;

export const putPage = async (page) => {
  const raw = await packPhoto(page.raw);
  const thumb = await packPhoto(page.thumb);
  return tx("pages", "readwrite", (s, images) => new Promise((resolve) => {
    const request = s.count();
    request.onsuccess = () => {
      const chooseFront = request.result === 0;
      images.put(raw, "raw:" + page.id);
      s.add({ ...page, raw: true, thumb, chooseFront });
      resolve(chooseFront);
    };
  }), true);
};
export const setFrontChoice = (id, front) => tx("pages", "readwrite", (s) => {
  const request = s.get(id);
  request.onsuccess = () => {
    const page = request.result;
    if (page?.chooseFront) s.put({ ...page, chooseFront: false, cover: front ? "front" : "" });
  };
});
export const finishPendingPage = async (page, keepOutput = false) => {
  const images = keepOutput ? null : await packResult(page);
  return tx("pages", "readwrite", (s, files) => {
    const request = s.get(page.id);
    request.onsuccess = () => {
      const current = request.result;
      if (current?.pending) {
        if (images) files.put(images.blob, "result:" + page.id);
        const stored = images ? { blob: true, thumb: images.thumb } : { blob: current.blob, thumb: current.thumb };
        s.put({ ...page, ...stored, raw: current.raw });
      }
    };
  }, true);
};
async function packResult(result) {
  const [blob, thumb] = await Promise.all([packPhoto(result.blob), packPhoto(result.thumb)]);
  return { blob, thumb };
}
export const updateBookPage = async (id, result) => {
  const [raw, images] = await Promise.all([packPhoto(result.raw), packResult(result)]);
  return tx("pages", "readwrite", (s, files) => new Promise((resolve) => {
    const request = s.get(id);
    request.onsuccess = () => {
      const page = request.result;
      if (!page || page.pending) return resolve(false);
      files.put(raw, "raw:" + id);
      files.put(images.blob, "result:" + id);
      s.put({ ...page, ...result, blob: true, thumb: images.thumb, raw: true });
      resolve(true);
    };
  }), true);
};
export const delPage = (id) => tx("pages", "readwrite", (s, files) => {
  s.delete(id);
  files.delete("raw:" + id);
  files.delete("result:" + id);
}, true);
export const getPage = (id) => tx("pages", "readonly", (s, files) => {
  const reads = [s.get(id), files.get("raw:" + id), files.get("result:" + id)];
  return Promise.all(reads.map(req)).then(([page, raw, blob]) => {
    if (!page) return;
    return { ...page, raw: page.raw === true ? unpackPhoto(raw) : page.raw,
      blob: page.blob === true ? unpackPhoto(blob) : page.blob, thumb: unpackPhoto(page.thumb) };
  });
}, true);
const byBookOrder = (a, b) => {
  const rank = (page) => page.cover === "front" ? -1 : page.cover === "back" ? 1 : 0;
  return rank(a) - rank(b) || a.order - b.order;
};

export const setLastPageCover = async (candidate, result) => {
  const [raw, images] = await Promise.all([packPhoto(result.raw), packResult(result)]);
  return tx("pages", "readwrite", (s, files) => new Promise((resolve) => {
    const request = s.getAll();
    request.onsuccess = () => {
      const pages = request.result.sort(byBookOrder);
      const last = pages.at(-1);
      if (pages.length < 2 || last.id !== candidate.id || last.cover !== candidate.cover
        || !last.raw || last.pending || last.cover === "front") {
        resolve(false);
        return;
      }
      if (last.raw !== true) files.put(raw, "raw:" + last.id);
      files.put(images.blob, "result:" + last.id);
      s.put({ ...last, ...result, raw: true, blob: true, thumb: images.thumb });
      resolve(true);
    };
  }), true);
};

export const pruneBookOriginals = () => tx("pages", "readwrite", (s, files) => {
  const request = s.getAll();
  request.onsuccess = () => {
    const pages = request.result.sort(byBookOrder);
    const last = pages.findLast((page) => !page.cover);
    for (const page of pages) {
      if (page !== last && !page.pending && page.forBack) {
        s.put({ ...page, raw: null, forBack: false });
        files.delete("raw:" + page.id);
      }
    }
  };
}, true);

/** sayfaları sırasıyla, yalnızca küçük önizlemeleriyle döner */
export async function listPages() {
  const all = await tx("pages", "readonly", (s) => req(s.getAll()));
  return all.sort(byBookOrder)
    .map(({ id, order, thumb, w, h, mode, cover, size, pending, failed, raw, chooseFront, forBack, needsCrop, needsFocus }) => ({
      id, order, thumb: unpackPhoto(thumb), w, h, mode, cover, size, pending: !!pending, failed: !!failed, hasRaw: !!raw, chooseFront, forBack, needsCrop, needsFocus
    }));
}
export const clearBook = () => tx("pages", "readwrite", (s, files) => {
  s.clear();
  files.clear();
}, true);
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
