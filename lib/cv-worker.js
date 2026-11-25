// Görüntü işleme işçisi (OpenCV.js): sayfa kenarlarını bulur, eğikliği düzeltir, netleştirir.
/* global cv */
importScripts("../vendor/opencv.js");
self.DEBUG = false;

const ready = new Promise((res) => {
  const done = () => res();
  if (self.cv && self.cv.Mat) return done();
  if (self.cv && typeof self.cv.then === "function") {
    self.cv.then((m) => { self.cv = m; done(); });
  } else {
    self.cv.onRuntimeInitialized = done;
  }
});

// ---------- yardımcılar
function orderCorners(pts) {
  // [tl, tr, br, bl]
  const s = pts.map((p) => p.x + p.y), d = pts.map((p) => p.y - p.x);
  const tl = pts[s.indexOf(Math.min(...s))], br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.min(...d))], bl = pts[d.indexOf(Math.max(...d))];
  return [tl, tr, br, bl];
}

function matToPts(m) {
  const out = [];
  for (let i = 0; i < m.rows; i++) out.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] });
  return out;
}

function quadFromContours(contours, minArea) {
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < minArea) { c.delete(); continue; }
    const peri = cv.arcLength(c, true);
    for (const eps of [0.02, 0.03, 0.045]) {
      const ap = new cv.Mat();
      cv.approxPolyDP(c, ap, eps * peri, true);
      if (ap.rows === 4 && cv.isContourConvex(ap)) {
        const a = cv.contourArea(ap);
        if (a > bestArea) { bestArea = a; best = matToPts(ap); }
        ap.delete();
        break;
      }
      ap.delete();
    }
    // dört köşeye inmeyen büyük şekiller: dış zarfı dene
    if (!best && area > minArea * 1.6) {
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const hp = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.04, 0.06, 0.08]) {
        const ap = new cv.Mat();
        cv.approxPolyDP(hull, ap, eps * hp, true);
        if (ap.rows === 4) {
          const a = cv.contourArea(ap);
          if (a > bestArea * 1.05) { bestArea = a; best = matToPts(ap); }
          ap.delete();
          break;
        }
        ap.delete();
      }
      hull.delete();
    }
    c.delete();
  }
  return best ? { pts: best, area: bestArea } : null;
}

// Bir dörtgenin "sayfa olma" puanı: kenarın iki yanı belirgin biçimde farklı olmalı (sayfa açık ya da koyu olabilir),
// iç kenar bandı düzgün olmalı (sayfa boşluğu). Yazı bloğunun iç bandı karışıktır, bu yüzden düşük puan alır.
function scoreQuad(pts, white, gray, W, H) {
  const mask = cv.Mat.zeros(H, W, cv.CV_8U);
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flatMap((p) => [Math.round(p.x), Math.round(p.y)]));
  const mv = new cv.MatVector(); mv.push_back(poly);
  cv.fillPoly(mask, mv, new cv.Scalar(255));
  const r = Math.max(4, Math.round(Math.min(W, H) * 0.03));
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(r, r));
  const outer = new cv.Mat(), inner = new cv.Mat(), bandOut = new cv.Mat(), bandIn = new cv.Mat();
  cv.dilate(mask, outer, k); cv.erode(mask, inner, k);
  cv.subtract(outer, mask, bandOut);
  cv.subtract(mask, inner, bandIn);
  const nOut = cv.countNonZero(bandOut), nIn = Math.max(1, cv.countNonZero(bandIn));
  const area = cv.countNonZero(mask);
  let contrast = 0, stdIn = 0;
  if (nOut > 20) {
    const gm = new cv.Mat(), gs = new cv.Mat(), om = new cv.Mat(), os = new cv.Mat();
    cv.meanStdDev(gray, gm, gs, bandIn);
    cv.meanStdDev(gray, om, os, bandOut);
    stdIn = gs.data64F[0];
    const dGray = Math.abs(gm.data64F[0] - om.data64F[0]);
    const dWhite = Math.abs(cv.mean(white, bandIn)[0] - cv.mean(white, bandOut)[0]);
    contrast = Math.max(dGray, dWhite);
    [gm, gs, om, os].forEach((m) => m.delete());
  }
  const outFrac = nOut / nIn; // kenara dayanınca dış bant küçülür
  [mask, poly, mv, k, outer, inner, bandOut, bandIn].forEach((m) => m.delete());
  const edge = pts.filter((p) => p.x < W * 0.015 || p.x > W * 0.985 || p.y < H * 0.015 || p.y > H * 0.985).length;
  const edgePen = edge >= 3 ? 0.15 : edge === 2 ? 0.5 : edge === 1 ? 0.8 : 1;
  return contrast * Math.sqrt(area / (W * H)) * edgePen * Math.min(1, 0.3 + outFrac) / (1 + stdIn / 18);
}

function contoursOf(bin, minArea, out) {
  const cs = new cv.MatVector(), hi = new cv.Mat();
  cv.findContours(bin, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const q = quadFromContours(cs, minArea);
  if (q) out.push(q);
  cs.delete(); hi.delete();
}

function detect(img) {
  const W = img.width, H = img.height;
  const src = cv.matFromImageData(img);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  // "beyazlık": parlak ve renksiz (kâğıt). Ahşap/masa renkli olduğu için ayrılır.
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  rgb.delete();
  const ch = new cv.MatVector();
  cv.split(hsv, ch);
  hsv.delete();
  const S = ch.get(1), V = ch.get(2);
  ch.delete();
  const white = new cv.Mat();
  cv.addWeighted(V, 1, S, -1.6, 0, white); // V − 1.6·S (doygun renkler düşer)
  S.delete(); V.delete();
  cv.GaussianBlur(white, white, new cv.Size(5, 5), 0);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  const minArea = W * H * 0.12;
  const k5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const kBig = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(9, Math.round(W / 25)), Math.max(9, Math.round(W / 25))));
  const cands = [];

  // 1) kenarlar
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 40, 120);
  cv.dilate(edges, edges, k5, new cv.Point(-1, -1), 2);
  contoursOf(edges, minArea, cands);
  edges.delete();

  // 1b) düşük karşıtlıklı kenarlar (açık renkli masa)
  const e2 = new cv.Mat();
  cv.Canny(gray, e2, 12, 36);
  cv.dilate(e2, e2, k5, new cv.Point(-1, -1), 1);
  contoursOf(e2, minArea, cands);
  cv.Canny(white, e2, 12, 36);
  cv.dilate(e2, e2, k5, new cv.Point(-1, -1), 1);
  contoursOf(e2, minArea, cands);
  e2.delete();

  // 2) beyazlık ve parlaklık eşikleri, iki yönde (sayfa masadan açık ya da koyu olabilir)
  const tb = new cv.Mat();
  for (const srcM of [white, gray]) {
    for (const inv of [false, true]) {
      cv.threshold(srcM, tb, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
      cv.morphologyEx(tb, tb, cv.MORPH_CLOSE, kBig); // yazıları doldur
      cv.morphologyEx(tb, tb, cv.MORPH_OPEN, k5, new cv.Point(-1, -1), 2); // doku kırıntılarını temizle
      contoursOf(tb, minArea, cands);
    }
  }
  tb.delete(); k5.delete(); kBig.delete();

  if (self.DEBUG) console.log("aday sayısı", cands.length, W, H);
  if (!cands.length) { white.delete(); gray.delete(); return null; }
  const scored = cands.map((c) => {
    const pts = orderCorners(c.pts);
    const sc = scoreQuad(pts, white, gray, W, H);
    const edge = pts.filter((p) => p.x < W * 0.015 || p.x > W * 0.985 || p.y < H * 0.015 || p.y > H * 0.985).length;
    if (self.DEBUG) console.log("aday", JSON.stringify(pts.map((p) => [Math.round(p.x), Math.round(p.y)])), sc.toFixed(1), (c.area / (W * H)).toFixed(2));
    return { pts, sc, area: c.area, edge };
  });
  white.delete(); gray.delete();
  scored.sort((a, b) => b.sc - a.sc);
  const top = scored[0];
  if (!top || top.sc < 3) return null; // sayfa ile çevresi arasında belirgin fark yok
  // Yazı bloğu sayfanın içinde kalır: puanı yakın olanlar içinden, en iyiyi kapsayan en dış dörtgeni seç
  const inside = (q, pt) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const c = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
      if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
    }
    return true;
  };
  let pick = top;
  for (const c of scored) {
    if (c === top || c.sc < top.sc * 0.6 || c.edge >= 1 || c.area <= pick.area * 1.15) continue;
    if (top.pts.every((pt) => inside(c.pts, pt))) pick = c;
  }
  let pts = pick.pts;
  // kenar genişletmesi yüzünden dışa taşan köşeleri biraz içeri çek
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  pts = pts.map((p) => { const dx = cx - p.x, dy = cy - p.y, d = Math.hypot(dx, dy) || 1, m = Math.min(4, d * 0.03); return { x: p.x + dx / d * m, y: p.y + dy / d * m }; });
  return pts.map((p) => ({ x: p.x / W, y: p.y / H }));
}

// Yapay zekanın bulduğu köşeleri gerçek kenar çizgilerine oturtur.
// Her kenarın çevresindeki ince bantta kenar noktalarını toplar, bunlara doğru uydurur, köşeleri kesişimlerden hesaplar.
function refine(img, quad) {
  const W = img.width, H = img.height;
  const P = quad.map((p) => ({ x: p.x * W, y: p.y * H }));
  const src = cv.matFromImageData(img);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 25, 75);
  gray.delete();
  const band = Math.max(4, Math.round(Math.min(W, H) * 0.025));
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const mask = cv.Mat.zeros(H, W, cv.CV_8U);
    // köşelere yakın uçları dışarıda bırak (köşede iki kenar karışır)
    const t0 = 0.08, t1 = 0.92;
    cv.line(mask, new cv.Point(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0), new cv.Point(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1), new cv.Scalar(255), band * 2);
    const sel = new cv.Mat();
    cv.bitwise_and(edges, mask, sel);
    const pts = new cv.Mat();
    cv.findNonZero(sel, pts);
    let line = null;
    if (pts.rows >= Math.max(20, len * 0.25)) {
      const L = new cv.Mat();
      cv.fitLine(pts, L, cv.DIST_HUBER, 0, 0.01, 0.01);
      const vx = L.data32F[0], vy = L.data32F[1], x0 = L.data32F[2], y0 = L.data32F[3];
      L.delete();
      // uydurulan doğru, yapay zekanın kenarıyla aşağı yukarı aynı yönde olmalı
      const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
      if (Math.abs(vx * dx + vy * dy) > 0.985) line = { vx, vy, x0, y0 };
    }
    lines.push(line || { vx: (b.x - a.x) / len, vy: (b.y - a.y) / len, x0: a.x, y0: a.y, ml: true });
    [mask, sel, pts].forEach((m) => m.delete());
  }
  edges.delete();
  const meet = (l1, l2) => {
    const d = l1.vx * l2.vy - l1.vy * l2.vx;
    if (Math.abs(d) < 1e-6) return null;
    const t = ((l2.x0 - l1.x0) * l2.vy - (l2.y0 - l1.y0) * l2.vx) / d;
    return { x: l1.x0 + l1.vx * t, y: l1.y0 + l1.vy * t };
  };
  const maxShift = Math.min(W, H) * 0.05;
  const out = P.map((p, i) => {
    const c = meet(lines[(i + 3) % 4], lines[i]); // köşe i: önceki kenar ile bu kenar
    if (!c || Math.hypot(c.x - p.x, c.y - p.y) > maxShift) return p;
    return c;
  });
  return out.map((p) => ({ x: Math.max(0, Math.min(1, p.x / W)), y: Math.max(0, Math.min(1, p.y / H)) }));
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// Perspektiften sayfanın gerçek en/boy oranını tahmin eder (Zhang & He, 2007).
function trueRatio(P, W, H) {
  const u0 = W / 2, v0 = H / 2;
  const v = (p) => [p.x - u0, p.y - v0, 1];
  const m1 = v(P[0]), m2 = v(P[1]), m3 = v(P[3]), m4 = v(P[2]); // tl, tr, bl, br
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((x, i) => k2 * x - m1[i]);
  const n3 = m3.map((x, i) => k3 * x - m1[i]);
  const M = Math.max(W, H);
  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
  const flat2 = Math.abs(n2[2]) * M < 0.01 * Math.hypot(n2[0], n2[1]);
  const flat3 = Math.abs(n3[2]) * M < 0.01 * Math.hypot(n3[0], n3[1]);
  if (flat2 && flat3) return null; // tam karşıdan çekilmiş: kenar uzunlukları doğru
  // odak uzaklığı hesaplanamıyor ya da makul değilse telefon kamerası için tipik değeri kullan
  if (flat2 || flat3 || !(f2 > 0) || !isFinite(f2) || Math.sqrt(f2) < 0.5 * M || Math.sqrt(f2) > 3 * M) f2 = (0.9 * M) ** 2;
  const r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
  return isFinite(r) && r > 0.2 && r < 5 ? r : null;
}

/** quad: oransal köşeler [tl,tr,br,bl]; mode: color|gray|bw|orig */
function warp(img, quad, mode, maxSide) {
  const W = img.width, H = img.height;
  const P = quad.map((p) => ({ x: p.x * W, y: p.y * H }));
  let w = Math.max(dist(P[0], P[1]), dist(P[3], P[2]));
  let h = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
  const r = trueRatio(P, W, H);
  if (r) { if (r >= w / h) h = w / r; else w = h * r; }
  // siyah-beyazda küçük sayfayı önce büyüt: harf kenarları daha düzgün olur
  const s = Math.min(mode === "bw" ? 2 : 1, maxSide / Math.max(w, h));
  w = Math.max(10, Math.round(w * s)); h = Math.max(10, Math.round(h * s));
  const src = cv.matFromImageData(img);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, P.flatMap((p) => [p.x, p.y]));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  src.delete(); from.delete(); to.delete(); M.delete();
  // kenarda kalan masa/gölge izlerini temizlemek için çok az kırp
  const m = Math.round(Math.min(w, h) * 0.008);
  const inner = out.roi(new cv.Rect(m, m, w - 2 * m, h - 2 * m));
  const res = enhance(inner, mode);
  inner.delete(); out.delete();
  const data = new ImageData(new Uint8ClampedArray(res.data), res.cols, res.rows);
  res.delete();
  return data;
}

// UVDoc ızgarasıyla sayfayı düzleştirir (tam çözünürlükte), sonra netleştirir
function unwarp(img, grid, mode) {
  const W = img.width, H = img.height, GH = 45, GW = 31;
  const gx = cv.matFromArray(GH, GW, cv.CV_32F, Array.from(grid.subarray(0, GH * GW)));
  const gy = cv.matFromArray(GH, GW, cv.CV_32F, Array.from(grid.subarray(GH * GW, 2 * GH * GW)));
  const mx = new cv.Mat(), my = new cv.Mat();
  cv.resize(gx, mx, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  cv.resize(gy, my, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  gx.delete(); gy.delete();
  // −1…1 → piksel
  mx.convertTo(mx, cv.CV_32F, W / 2, W / 2 - 0.5);
  my.convertTo(my, cv.CV_32F, H / 2, H / 2 - 0.5);
  const src = cv.matFromImageData(img);
  const dst = new cv.Mat();
  cv.remap(src, dst, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  src.delete(); mx.delete(); my.delete();
  const res = enhance(dst, mode);
  dst.delete();
  const data = new ImageData(new Uint8ClampedArray(res.data), res.cols, res.rows);
  res.delete();
  return data;
}

// Sayfa kenarına değen parmakları (ve masa artıklarını) kâğıt rengiyle kapatır. rgba üzerinde yerinde çalışır.
function removeFingers(rgba) {
  const W = rgba.cols, H = rgba.rows;
  const s = Math.min(1, 900 / Math.max(W, H));
  const w = Math.max(10, Math.round(W * s)), h = Math.max(10, Math.round(H * s));
  const small = new cv.Mat(), rgb = new cv.Mat(), ycc = new cv.Mat();
  cv.resize(rgba, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  rgb.delete();
  const range = (a, b) => {
    const lo = new cv.Mat(h, w, ycc.type(), new cv.Scalar(...a)), hi = new cv.Mat(h, w, ycc.type(), new cv.Scalar(...b)), m = new cv.Mat();
    cv.inRange(ycc, lo, hi, m); lo.delete(); hi.delete(); return m;
  };
  const core = range([50, 136, 75], [255, 185, 128]);
  const k5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  cv.morphologyEx(core, core, cv.MORPH_OPEN, k5);
  k5.delete();
  const cs = new cv.MatVector(), hi = new cv.Mat();
  cv.findContours(core, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  core.delete(); hi.delete();
  const keep = cv.Mat.zeros(h, w, cv.CV_8U);
  let any = false;
  for (let i = 0; i < cs.size(); i++) {
    const c = cs.get(i), r = cv.boundingRect(c), a = cv.contourArea(c);
    const touches = r.x <= 2 || r.y <= 2 || r.x + r.width >= w - 2 || r.y + r.height >= h - 2;
    if (touches && a > w * h * 0.0004) { cv.drawContours(keep, cs, i, new cv.Scalar(255), -1); any = true; }
    c.delete();
  }
  cs.delete();
  if (!any || cv.countNonZero(keep) > w * h * 0.25) { keep.delete(); ycc.delete(); small.delete(); return; }
  // çekirdeğin çevresinde gevşek renk aralığıyla büyüt (tırnak, parlak kısımlar)
  const big = Math.max(9, Math.round(Math.min(w, h) * 0.06));
  const zone = new cv.Mat();
  cv.dilate(keep, zone, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(big, big)));
  const loose = range([0, 132, 0], [255, 255, 130]);
  cv.bitwise_and(zone, loose, zone);
  cv.bitwise_or(keep, zone, keep);
  zone.delete(); loose.delete(); ycc.delete();
  const r2 = Math.max(5, Math.round(Math.min(w, h) * 0.02));
  cv.dilate(keep, keep, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(r2, r2)));
  // kâğıt rengi: maskenin dışındaki aydınlık piksellerin ortalaması
  const gray = new cv.Mat(), bright = new cv.Mat(), notKeep = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, bright, 170, 255, cv.THRESH_BINARY);
  cv.bitwise_not(keep, notKeep);
  cv.bitwise_and(bright, notKeep, bright);
  const paper = cv.countNonZero(bright) > 100 ? cv.mean(small, bright) : [246, 244, 238, 255];
  gray.delete(); notKeep.delete(); bright.delete(); small.delete();
  const full = new cv.Mat();
  cv.resize(keep, full, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
  keep.delete();
  rgba.setTo(new cv.Scalar(paper[0], paper[1], paper[2], 255), full);
  full.delete();
}

// Kalan eğikliği düzeltir: yazı satırlarının açısını ölçer (izdüşüm yöntemi), gerekirse döndürür. rgba yerinde değişmez, yeni Mat döner.
function deskew(rgba) {
  const W = rgba.cols, H = rgba.rows;
  const s = Math.min(1, 700 / Math.max(W, H));
  const small = new cv.Mat(), gray = new cv.Mat(), bw = new cv.Mat();
  cv.resize(rgba, small, new cv.Size(Math.round(W * s), Math.round(H * s)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  small.delete();
  cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 25, 15);
  gray.delete();
  // kenarlardaki gölge/çizgiler ölçümü bozmasın
  const m = Math.round(Math.min(bw.cols, bw.rows) * 0.06);
  const roi = bw.roi(new cv.Rect(m, m, bw.cols - 2 * m, bw.rows - 2 * m));
  const ink = cv.countNonZero(roi);
  if (ink < roi.cols * roi.rows * 0.01) { roi.delete(); bw.delete(); return null; } // yazı yok
  const c = new cv.Point(roi.cols / 2, roi.rows / 2);
  const rot = new cv.Mat();
  const score = (deg) => {
    const M = cv.getRotationMatrix2D(c, deg, 1);
    cv.warpAffine(roi, rot, M, new cv.Size(roi.cols, roi.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    M.delete();
    const rows = new cv.Mat();
    cv.reduce(rot, rows, 1, cv.REDUCE_SUM, cv.CV_32F);
    let mean = 0; for (let i = 0; i < rows.rows; i++) mean += rows.data32F[i]; mean /= rows.rows;
    let v = 0; for (let i = 0; i < rows.rows; i++) v += (rows.data32F[i] - mean) ** 2;
    rows.delete();
    return v;
  };
  let best = 0, bestV = score(0);
  for (let d = -4; d <= 4.001; d += 0.5) { if (d === 0) continue; const v = score(d); if (v > bestV) { bestV = v; best = d; } }
  for (let d = best - 0.4; d <= best + 0.401; d += 0.1) { const v = score(d); if (v > bestV) { bestV = v; best = d; } }
  rot.delete(); roi.delete(); bw.delete();
  if (Math.abs(best) < 0.15) return null;
  const M = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), best, 1);
  const out = new cv.Mat();
  // köşelerde açılan boşluğu kâğıt rengiyle doldur (kenar pikselini uzatmak çizgi izi bırakır)
  const paper = cv.mean(rgba);
  cv.warpAffine(rgba, out, M, new cv.Size(W, H), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(paper[0], paper[1], paper[2], 255));
  M.delete();
  return out;
}

// Hafif bulanıklığa karşı keskinleştirme (bulanık maske). Yazı kenarlarını belirginleştirir.
function sharpen(mat, amount) {
  const sigma = Math.max(0.8, Math.min(mat.cols, mat.rows) / 1400);
  const blur = new cv.Mat();
  cv.GaussianBlur(mat, blur, new cv.Size(0, 0), sigma);
  cv.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
  blur.delete();
}

// Gölgeyi ve ışık farkını temizler: her kanalı kendi arka planına böler.
function flatten(ch) {
  const small = new cv.Mat();
  const f = 0.25;
  cv.resize(ch, small, new cv.Size(0, 0), f, f, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.dilate(small, small, k);
  k.delete();
  const ks = Math.max(3, (Math.round(Math.min(small.cols, small.rows) / 20) | 1));
  cv.medianBlur(small, small, Math.min(ks, 61));
  const bg = new cv.Mat();
  cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
  small.delete();
  const out = new cv.Mat();
  cv.divide(ch, bg, out, 255);
  bg.delete();
  // seviyeleri biraz aç: kâğıt beyaz, yazı koyu
  out.convertTo(out, -1, 1.12, -24);
  return out;
}

function enhance(rgba0, mode) {
  const out = new cv.Mat();
  if (mode === "orig") { rgba0.copyTo(out); return out; }
  let rgba = rgba0, rotated = null;
  try { rotated = deskew(rgba0); if (rotated) rgba = rotated; } catch (e) {}
  try { removeFingers(rgba); } catch (e) {}
  const res = enhanceInner(rgba, mode, out);
  if (rotated) rotated.delete();
  return res;
}

function enhanceInner(rgba, mode, out) {
  if (mode === "color") {
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const chs = new cv.MatVector();
    cv.split(rgb, chs);
    const fixed = new cv.MatVector();
    for (let i = 0; i < 3; i++) { const c = chs.get(i); const f = flatten(c); sharpen(f, 0.7); fixed.push_back(f); c.delete(); f.delete(); }
    cv.merge(fixed, rgb);
    cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
    rgb.delete(); chs.delete(); fixed.delete();
    return out;
  }
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  let g = flatten(gray);
  gray.delete();
  sharpen(g, mode === "bw" ? 1.0 : 0.7);
  if (mode === "bw") {
    const bw = new cv.Mat();
    const bs = Math.max(15, (Math.round(Math.min(g.cols, g.rows) / 40) | 1));
    cv.adaptiveThreshold(g, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bs, 12);
    g.delete();
    g = bw;
  }
  cv.cvtColor(g, out, cv.COLOR_GRAY2RGBA);
  g.delete();
  return out;
}

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    await ready;
    let result;
    if (op === "ping") result = true;
    else if (op === "detect") result = detect(e.data.img);
    else if (op === "refine") result = refine(e.data.img, e.data.quad);
    else if (op === "unwarp") {
      const img = unwarp(e.data.img, e.data.grid, e.data.mode);
      postMessage({ id, ok: true, result: img }, [img.data.buffer]);
      return;
    }
    else if (op === "warp") {
      const img = warp(e.data.img, e.data.quad, e.data.mode, e.data.maxSide || 3200);
      postMessage({ id, ok: true, result: img }, [img.data.buffer]);
      return;
    }
    postMessage({ id, ok: true, result });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
