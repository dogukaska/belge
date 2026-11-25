// Sayfa bulma: önce yapay zeka (scanic / DocCornerNet) köşeleri bulur, sonra kenar çizgileriyle ince ayar yapılır.
// Yapay zeka yüklenemezse eski kenar algılamaya düşer.
import { detect as classicDetect, refine, smallFrame } from "./cv.js?v=8";

const ML_BASE = new URL("../vendor/scanic-ml/", import.meta.url).href;
let ml = null, mlFailed = false;

async function getMl() {
  if (ml || mlFailed) return ml;
  try {
    const mod = await import("../vendor/scanic/scanic-mlDetector.js");
    await mod.initializeMl({ assetBaseUrl: ML_BASE });
    ml = mod;
  } catch (e) {
    console.warn("Yapay zeka köşe bulucu yüklenemedi, klasik yönteme geçiliyor", e);
    mlFailed = true;
  }
  return ml;
}
export const warmUp = () => getMl();

/**
 * source: video / canvas / bitmap; sw, sh: kaynak boyutu.
 * Döner: { quad: [tl,tr,br,bl] oransal, score } ya da null
 */
// Sayfaya benzemeyen dörtgenleri ele (kadrajdan taşan sayfada model saçma sonuç verebilir)
function plausible(q, W, H) {
  const P = q.map((p) => ({ x: p.x * W, y: p.y * H }));
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  area = Math.abs(area) / 2;
  if (area < W * H * 0.08) return false;
  const m = Math.min(W, H);
  for (let i = 0; i < 4; i++) {
    const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4];
    if (Math.hypot(c.x - b.x, c.y - b.y) < m * 0.15) return false;
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 40 || ang > 140) return false;
  }
  // dışbükey olmalı
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4], c = P[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

export async function detectPage(source, sw, sh, { max = 640, minScore = 0.6 } = {}) {
  const frame = source && source.data ? source : smallFrame(source, sw, sh, max);
  const m = await getMl();
  if (m) {
    const r = await m.detectDocumentMl(frame, { assetBaseUrl: ML_BASE, minScore });
    if (!r.corners || !(r.score >= minScore)) return null;
    const c = r.corners, W = frame.width, H = frame.height;
    let quad = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => ({ x: p.x / W, y: p.y / H }));
    if (!plausible(quad, W, H)) return null;
    // kenarlarla ince ayar
    try { const rq = await refine(frame, quad); if (plausible(rq, W, H)) quad = rq; } catch (e) {}
    return { quad, score: r.score };
  }
  const q = await classicDetect(frame);
  return q ? { quad: q, score: 1 } : null;
}
