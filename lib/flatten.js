// Sayfa işleme: perspektif düzeltme → (yapay zeka) kıvrım düzleştirme → netleştirme
import { warp, unwarp } from "./cv.js?v=8";

let worker = null, seq = 0, broken = false;
const pending = new Map();
function w() {
  if (worker) return worker;
  worker = new Worker(new URL("./uv-worker.js?v=2", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
  };
  worker.onerror = () => { broken = true; for (const p of pending.values()) p.rej(new Error("Düzleştirici başlatılamadı")); pending.clear(); worker = null; };
  return worker;
}
const call = (msg, tr) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); w().postMessage({ id, ...msg }, tr || []); }); };
export const warmUpFlatten = () => call({ op: "ping" }).catch(() => { broken = true; });

// köşeleri biraz dışa it: kıvrık sayfanın kenarları dışarıda kalmasın, düzleştirici kenarı kendisi bulur
function expand(q, f) {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
  return q.map((p) => ({ x: Math.max(0, Math.min(1, p.x + (p.x - cx) * f)), y: Math.max(0, Math.min(1, p.y + (p.y - cy) * f)) }));
}

// ızgara mantıklı mı? (belge dışı görüntülerde model saçmalayabilir)
function gridOk(g) {
  const GH = 45, GW = 31, N = GH * GW;
  let minX = 9, maxX = -9, minY = 9, maxY = -9, incX = 0, incY = 0, tx = 0, ty = 0;
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    const x = g[r * GW + c], y = g[N + r * GW + c];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (c > 0) { tx++; if (x > g[r * GW + c - 1]) incX++; }
    if (r > 0) { ty++; if (y > g[N + (r - 1) * GW + c]) incY++; }
  }
  return maxX - minX > 0.9 && maxY - minY > 0.9 && incX / tx > 0.97 && incY / ty > 0.97;
}

/**
 * img: tam boy ImageData; quad: oransal köşeler; mode: color|gray|bw|orig; flat: düzleştirme açık mı
 * Döner: ImageData
 */
export async function processPage(img, quad, mode, flat, maxSide) {
  if (!flat || broken) return warp(img, quad, mode, maxSide);
  const keep = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); // düzleştirme başarısız olursa
  try {
    const page = await warp(img, expand(quad, 0.035), "orig", maxSide);
    // modele 488×712 girdi
    const c = new OffscreenCanvas(page.width, page.height);
    c.getContext("2d").putImageData(page, 0, 0);
    const s = new OffscreenCanvas(488, 712);
    const sx = s.getContext("2d", { willReadFrequently: true });
    sx.imageSmoothingQuality = "high";
    sx.drawImage(c, 0, 0, 488, 712);
    const grid = await call({ op: "grid", img: sx.getImageData(0, 0, 488, 712) });
    if (!gridOk(grid)) return warp(keep, quad, mode, maxSide);
    return await unwarp(page, grid, mode);
  } catch (e) {
    console.warn("Düzleştirme yapılamadı, normal düzeltme kullanılıyor", e);
    return warp(keep, quad, mode, maxSide);
  }
}
