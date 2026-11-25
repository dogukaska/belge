// Sayfa işleme: perspektif düzeltme → (yapay zeka) kıvrım düzleştirme → netleştirme
import { warp, unwarp } from "./cv.js?v=9";

// İki yol: önce arka plan işçisi (sayfa donmaz); iPhone gibi orada çalışmayan cihazlarda sayfanın kendisi.
let worker = null, seq = 0, broken = false, reasons = [];
const pending = new Map();
function w() {
  if (worker) return worker;
  worker = new Worker(new URL("./uv-worker.js?v=3", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
  };
  worker.onerror = (ev) => {
    const msg = (ev && ev.message) || "işçi başlatılamadı";
    for (const p of pending.values()) p.rej(new Error(msg));
    pending.clear();
    try { worker.terminate(); } catch (e) {}
    worker = null;
  };
  return worker;
}
const callWorker = (msg, tr) => { const id = ++seq; return new Promise((res, rej) => { pending.set(id, { res, rej }); w().postMessage({ id, ...msg }, tr || []); }); };

// --- sayfanın kendisinde çalışan yollar: ekran kartı (WebGPU) ya da işlemci (wasm)
const MODEL = new URL("../model/uvdoc.onnx?v=1", import.meta.url).href;
const ORT_DIR = new URL("../vendor/ort/", import.meta.url).href;
const sessions = {};
let modelBuf = null;
async function modelBytes() {
  if (modelBuf) return modelBuf;
  try {
    const cache = await caches.open("belge-uvdoc-v1");
    let res = await cache.match(MODEL);
    if (!res) { res = await fetch(MODEL); if (res.ok) await cache.put(MODEL, res.clone()).catch(() => {}); }
    modelBuf = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error("model indirilemedi");
    modelBuf = new Uint8Array(await res.arrayBuffer());
  }
  return modelBuf;
}
async function mainSession(kind) {
  if (sessions[kind]) return sessions[kind];
  sessions[kind] = (async () => {
    const ort = kind === "gpu" ? await import("../vendor/ort/ort.webgpu.bundle.min.mjs") : await import("../vendor/ort/ort.wasm.bundle.min.mjs");
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = 1;
    if (kind === "gpu") {
      if (!("gpu" in navigator)) throw new Error("WebGPU yok");
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) throw new Error("ekran kartı bulunamadı");
    }
    const sess = await ort.InferenceSession.create(await modelBytes(), {
      executionProviders: [kind === "gpu" ? "webgpu" : "wasm"],
      graphOptimizationLevel: "all", enableCpuMemArena: false, enableMemPattern: false,
    });
    return { ort, sess };
  })();
  try { return await sessions[kind]; } catch (e) { sessions[kind] = null; throw e; }
}
async function mainGrid(kind, img) {
  const { ort, sess } = await mainSession(kind);
  const { data, width: W, height: H } = img;
  const N = W * H, x = new Float32Array(3 * N);
  for (let i = 0, j = 0; j < N; i += 4, j++) { x[j] = data[i] / 255; x[j + N] = data[i + 1] / 255; x[j + 2 * N] = data[i + 2] / 255; }
  const out = await sess.run({ input: new ort.Tensor("float32", x, [1, 3, H, W]) }, ["output"]);
  const g = await (out.output.getData ? out.output.getData() : out.output.data);
  if (!g || !g.length || !Number.isFinite(g[0])) throw new Error("geçersiz sonuç");
  return g;
}

// iPhone/iPad Safari'de işlemci yolu (wasm) iOS 26 hatasından etkilenebiliyor: önce ekran kartını dene
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const SAFARI = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
let order = IOS || SAFARI ? ["gpu", "main", "worker"] : ["worker", "gpu", "main"];
const names = { worker: "işçi", gpu: "ekran kartı", main: "işlemci" };

async function getGrid(img) {
  while (order.length) {
    const kind = order[0];
    try {
      if (kind === "worker") return await callWorker({ op: "grid", img: new ImageData(new Uint8ClampedArray(img.data), img.width, img.height) });
      return await mainGrid(kind, img);
    } catch (e) {
      reasons.push(names[kind] + ": " + (e && e.message || e));
      console.warn("Düzleştirici şu yolla çalışmadı:", kind, e);
      order.shift();
    }
  }
  broken = true;
  throw new Error(reasons.join(" | "));
}
export const usedEngine = () => names[order[0]] || "yok";

// önceden ısıt: sıradaki yolu hazırla (model iner, oturum kurulur)
export const warmUpFlatten = () => {
  const kind = order[0];
  const p = kind === "worker" ? callWorker({ op: "ping" }) : mainSession(kind);
  return p.catch(() => {}); // hata olursa ilk sayfada sıradaki yol denenir
};

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
const tag = (img, info) => { img.flatInfo = info; return img; };

export async function processPage(img, quad, mode, flat, maxSide) {
  if (!flat) return tag(await warp(img, quad, mode, maxSide), "kapalı");
  if (broken) return tag(await warp(img, quad, mode, maxSide), "bu cihazda çalışmadı (" + reasons.join(" | ") + ")");
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
    const grid = await getGrid(sx.getImageData(0, 0, 488, 712));
    if (!gridOk(grid)) return tag(await warp(keep, quad, mode, maxSide), "sayfa tanınamadı");
    return tag(await unwarp(page, grid, mode), "ok:" + usedEngine());
  } catch (e) {
    console.warn("Düzleştirme yapılamadı, normal düzeltme kullanılıyor", e);
    return tag(await warp(keep, quad, mode, maxSide), "hata: " + (e.message || e));
  }
}
