// İşçiyle konuşan küçük katman
let worker = null, seq = 0;
const pending = new Map();

function w() {
  if (worker) return worker;
  worker = new Worker(new URL("./cv-worker.js?v=9", import.meta.url));
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
  };
  worker.onerror = () => {
    for (const p of pending.values()) p.rej(new Error("Görüntü işleyici başlatılamadı"));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(msg, transfer) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    w().postMessage({ id, ...msg }, transfer || []);
  });
}

export const cvReady = () => call({ op: "ping" });
/** küçük bir ImageData'da sayfayı arar; oransal [tl,tr,br,bl] ya da null */
export const detect = (img) => call({ op: "detect", img }, [img.data.buffer]);
/** yaklaşık köşeleri gerçek kenarlara oturtur */
export const refine = (img, quad) => call({ op: "refine", img, quad }, [img.data.buffer]);
/** tam boy ImageData'yı düzeltir */
export const warp = (img, quad, mode, maxSide) => call({ op: "warp", img, quad, mode, maxSide }, [img.data.buffer]);

/** Bir kaynaktan (video, bitmap, canvas) küçük ImageData üretir */
export function smallFrame(source, sw, sh, max = 640) {
  const s = Math.min(1, max / Math.max(sw, sh));
  const c = new OffscreenCanvas(Math.round(sw * s), Math.round(sh * s));
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(source, 0, 0, c.width, c.height);
  return cx.getImageData(0, 0, c.width, c.height);
}

export function fullFrame(source, sw, sh) {
  const c = new OffscreenCanvas(sw, sh);
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(source, 0, 0, sw, sh);
  return cx.getImageData(0, 0, sw, sh);
}

/** ızgara ile düzleştir + netleştir */
export const unwarp = (img, grid, mode) => call({ op: "unwarp", img, grid, mode }, [img.data.buffer]);
