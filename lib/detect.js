// Sayfa bulma: önce yapay zeka (scanic / DocCornerNet) köşeleri bulur, sonra kenar çizgileriyle ince ayar yapılır.
// Yapay zeka yüklenemezse eski kenar algılamaya düşer.
import { detect as classicDetect, refine, smallFrame } from "./cv.js?v=14";

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
  // karşılıklı kenarlar arasında aşırı açı farkı olamaz (perspektif bunu yapmaz)
  const ang = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  const diffAng = (x, y) => { let d = Math.abs(x - y) % 180; return d > 90 ? 180 - d : d; };
  if (diffAng(ang(P[0], P[1]), ang(P[3], P[2])) > 20) return false; // üst ↔ alt
  if (diffAng(ang(P[0], P[3]), ang(P[1], P[2])) > 20) return false; // sol ↔ sağ
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

// Bir kitabın yazı bloğunun kenarını sayfanın kenarı sanma.
function hasBookEdges(frame, quad) {
  const { width, height, data } = frame;
  if (quad.some(({ x, y }) => x < 0.012 || x > 0.988 || y < 0.012 || y > 0.988)) return false;
  const points = quad.map(({ x, y }) => ({ x: x * width, y: y * height }));
  const band = Math.max(3, Math.min(width, height) * 0.013);
  const pixel = (x, y) => {
    const ix = Math.min(width - 1, Math.max(0, Math.round(x)));
    const iy = Math.min(height - 1, Math.max(0, Math.round(y)));
    return (iy * width + ix) * 4;
  };
  return points.every((a, i) => {
    const b = points[(i + 1) % 4];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const nx = -dy / length * band, ny = dx / length * band;
    const hits = [0, 0, 0];
    for (let j = 0; j < 24; j++) {
      const t = 0.08 + (j + 0.5) / 24 * 0.84;
      const x = a.x + dx * t, y = a.y + dy * t;
      const left = pixel(x + nx, y + ny), right = pixel(x - nx, y - ny);
      const distance = Math.max(...[0, 1, 2].map((ch) => Math.abs(data[left + ch] - data[right + ch])));
      if (distance >= 22) hits[Math.floor(j / 8)]++;
    }
    return hits.every((n) => n >= 4) && hits.reduce((a, b) => a + b, 0) >= 17;
  });
}

export async function detectPage(source, sw, sh, { max = 640, minScore = 0.6, recover = false, book = false } = {}) {
  const frame = source && source.data ? source : smallFrame(source, sw, sh, max);
  const m = await getMl();
  if (m) {
    const result = await detectWithModel(m, frame, minScore, recover || book).catch((e) => {
      if (!recover) throw e;
      return null;
    });
    if (result && (!book || hasBookEdges(frame, result.quad))) return result;
    if (!recover) return null;
  }
  const input = book ? new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height) : frame;
  const q = await classicDetect(input);
  return q && (!book || hasBookEdges(frame, q)) ? { quad: q, score: 1 } : null;
}

async function detectWithModel(m, frame, minScore, recover) {
  const r = await m.detectDocumentMl(frame, { assetBaseUrl: ML_BASE, minScore });
  if (!r.corners || !(r.score >= minScore)) return null;
  const c = r.corners, W = frame.width, H = frame.height;
  let quad = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => ({ x: p.x / W, y: p.y / H }));
  if (!plausible(quad, W, H)) return null;
  try {
    // refine() tamponu işçiye aktarır. Gerektiğinde yedek algılayıcıya sakla.
    const input = recover ? new ImageData(new Uint8ClampedArray(frame.data), W, H) : frame;
    const rq = await refine(input, quad);
    if (rq.contrast < 8) return null;
    if (plausible(rq.quad, W, H)) quad = rq.quad;
  } catch (e) {}
  return { quad, score: r.score };
}
