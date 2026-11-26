import { cvReady, warp, smallFrame, fullFrame } from "./lib/cv.js?v=14";
import { detectPage, warmUp } from "./lib/detect.js?v=9";
import { processPage, warmUpFlatten } from "./lib/flatten.js?v=9";
import { makePdf, packBits } from "./lib/pdf.js?v=2";
import * as store from "./lib/store.js?v=9";

const $ = (id) => document.getElementById(id);
const pages = [];          // { id, orig: Blob, ow, oh, quad, mode, rot, out: Blob, w, h, url }
let uid = 0;
const DEFAULT_MODE = "color";
const MAX_SIDE = 3200;

cvReady().catch(() => {}); // işleyiciyi önceden ısıt
warmUp(); // yapay zeka köşe bulucuyu önceden yükle

// Yeni sürüm yayınlandıysa telefonun eski kopyası yerine onu yükle
const APP_VERSION = "24";
fetch("version.txt?t=" + Date.now(), { cache: "no-store" }).then((r) => r.ok ? r.text() : "").then((v) => {
  v = v.trim();
  if (v && v !== APP_VERSION && !sessionStorage.getItem("yenilendi-" + v)) {
    sessionStorage.setItem("yenilendi-" + v, "1");
    fetch("./", { cache: "reload" }).catch(() => {}).finally(() => location.reload());
  }
}).catch(() => {});

let tab = "doc";
const tabs = [...document.querySelectorAll(".tab")];
tabs.forEach((t) => t.addEventListener("click", () => {
  tab = t.dataset.tab;
  for (const button of tabs) {
    const selected = button === t;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected);
    button.tabIndex = selected ? 0 : -1;
  }
  $("tab-doc").classList.toggle("hidden", tab !== "doc");
  $("tab-book").classList.toggle("hidden", tab !== "book");
  if (tab === "book") bookRefresh();
}));
tabs[0].parentElement.addEventListener("keydown", (event) => {
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  let next;
  if (event.key === "Home") next = tabs[0];
  else if (event.key === "End") next = tabs.at(-1);
  else if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
  else if (event.key === "ArrowLeft") next = tabs[(index + tabs.length - 1) % tabs.length];
  else return;
  event.preventDefault();
  next.focus();
  next.click();
});


// =====================================================================
// Yardımcılar
// =====================================================================
const defaultQuad = (inset = 0.04) => {
  const end = 1 - inset;
  return [{ x: inset, y: inset }, { x: end, y: inset }, { x: end, y: end }, { x: inset, y: end }];
};

function canvasFromImageData(d) {
  const c = document.createElement("canvas");
  c.width = d.width; c.height = d.height;
  c.getContext("2d").putImageData(d, 0, 0);
  return c;
}

function rotated(canvas, rot) {
  if (!rot) return canvas;
  const c = document.createElement("canvas");
  const swap = rot % 180 !== 0;
  c.width = swap ? canvas.height : canvas.width;
  c.height = swap ? canvas.width : canvas.height;
  const cx = c.getContext("2d");
  cx.translate(c.width / 2, c.height / 2);
  cx.rotate((rot * Math.PI) / 180);
  cx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return c;
}

const toBlob = (c, type = "image/jpeg", q = 0.9) => new Promise((r) => c.toBlob(r, type, q));

// A4'e yakın sayfaları tam A4 oranına getir (dikey ya da yatay)
function toA4(c, tolerance = 0.1) {
  const A4 = Math.SQRT2, r = c.height / c.width;
  let w = c.width, h = c.height;
  if (Math.abs(r - A4) / A4 < tolerance) h = Math.round(w * A4);
  else if (Math.abs(1 / r - A4) / A4 < tolerance) w = Math.round(h * A4);
  else return c;
  if (w === c.width && h === c.height) return c;
  const o = document.createElement("canvas");
  o.width = w; o.height = h;
  const ox = o.getContext("2d");
  ox.imageSmoothingQuality = "high";
  ox.drawImage(c, 0, 0, w, h);
  return o;
}

async function bitmapOf(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const { image, url } = await openPhoto(blob);
    URL.revokeObjectURL(url);
    return image;
  }
}

async function openPhoto(blob) {
  let url;
  try {
    if (!blob?.size) throw new Error();
    const local = new Blob([await blob.arrayBuffer()], { type: blob.type || "image/jpeg" });
    url = URL.createObjectURL(local);
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    return { blob: local, image, url };
  } catch {
    if (url) URL.revokeObjectURL(url);
    throw new Error("Fotoğraf açılamadı.");
  }
}

/** Sayfanın sonucunu (düzeltilmiş görüntü) üretir */
async function render(p) {
  const bmp = await bitmapOf(p.orig);
  const img = fullFrame(bmp, bmp.width, bmp.height);
  bmp.close?.();
  const out = await processPage(img, p.quad, p.mode, p.flat !== false, MAX_SIDE);
  p.flatInfo = out.flatInfo;
  const c = rotated(toA4(canvasFromImageData(out)), p.rot);
  p.out = await toBlob(c, "image/jpeg", p.mode === "bw" ? 0.85 : 0.9);
  p.w = c.width; p.h = c.height;
  if (p.url) URL.revokeObjectURL(p.url);
  p.url = URL.createObjectURL(p.out);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const fmtSize = (b) => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`;

// =====================================================================
// Sayfa listesi
// =====================================================================
function renderList() {
  const has = pages.length > 0;
  $("start").classList.toggle("hidden", has);
  $("doc").classList.toggle("hidden", !has);
  const ul = $("pages");
  ul.innerHTML = "";
  pages.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "page glass";
    li.tabIndex = 0;
    const img = document.createElement("img");
    img.alt = `Sayfa ${i + 1}`;
    if (p.url) img.src = p.url;
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = i + 1;
    li.append(img, n);
    if (!p.url) { const s = document.createElement("div"); s.className = "spinner small"; li.append(s); }
    li.addEventListener("click", () => p.url && openEdit(p));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" && p.url) openEdit(p); });
    ul.append(li);
  });
  const total = pages.reduce((s, p) => s + (p.out ? p.out.size : 0), 0);
  $("doc-info").textContent = has ? `${pages.length} sayfa · yaklaşık ${fmtSize(total)}` : "";
}

async function addPage(orig, ow, oh, quad) {
  const p = { id: ++uid, orig, ow, oh, quad: quad || defaultQuad(), mode: DEFAULT_MODE, rot: 0, out: null, url: null, guessed: !quad };
  pages.push(p);
  renderList();
  try { await render(p); } catch (e) { console.error(e); pages.splice(pages.indexOf(p), 1); alert("Sayfa işlenemedi: " + e.message); }
  renderList();
  return p;
}

window.addEventListener("beforeunload", (e) => { if (pages.length) { e.preventDefault(); e.returnValue = ""; } });

// =====================================================================
// Galeriden ekleme
// =====================================================================
async function addFiles(files) {
  warmFlat();
  for (const f of files) {
    try {
      const bmp = await bitmapOf(f);
      // çok büyükse makul boyuta indir
      const s = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      const q = (await detectPage(c, c.width, c.height, { max: 1024, minScore: 0.4 }).catch(() => null))?.quad || null;
      const blob = await toBlob(c, "image/jpeg", 0.92);
      const p = await addPage(blob, c.width, c.height, q);
      if (!q && files.length === 1 && p) openEdit(p, true);
    } catch (e) {
      console.error(e);
      alert(`“${f.name}” açılamadı.`);
    }
  }
}
for (const id of ["pick", "pick2"]) {
  $(id).addEventListener("change", (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) addFiles(fs); });
}

// =====================================================================
// KAMERA
// =====================================================================
let video = $("video");
// iPhone Safari: aynı video öğesine yeniden kamera bağlanınca görüntü küçük kalabiliyor. Her açılışta yeni öğe kullan.
function freshVideo() {
  const v = document.createElement("video");
  v.id = "video";
  v.playsInline = true; v.muted = true; v.autoplay = true;
  v.setAttribute("playsinline", ""); v.setAttribute("muted", ""); v.setAttribute("autoplay", "");
  video.replaceWith(v);
  video = v;
}
const cam = { generation: 0, stream: null, on: false, busy: false, auto: true, hist: [], lastQuad: null, armed: true, cool: 0, shots: 0, missing: 0, sig: null, lastSig: null };

// Sayfanın kendi içeriğinin parmak izi (sayfa içinden örneklenir): el titreyince değişmez, sayfa çevrilince değişir
function signature(img, q) {
  const W = img.width, H = img.height, d = img.data, NX = 8, NY = 11, out = new Float32Array(NX * NY);
  const at = (u, v) => {
    // dörtgen içinde (u,v) noktası (çift doğrusal)
    const top = { x: q[0].x + (q[1].x - q[0].x) * u, y: q[0].y + (q[1].y - q[0].y) * u };
    const bot = { x: q[3].x + (q[2].x - q[3].x) * u, y: q[3].y + (q[2].y - q[3].y) * u };
    return { x: (top.x + (bot.x - top.x) * v) * W, y: (top.y + (bot.y - top.y) * v) * H };
  };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    let sum = 0, n = 0;
    for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) {
      const p = at(0.08 + (i + (a + 0.5) / 3) * 0.84 / NX, 0.08 + (j + (b + 0.5) / 3) * 0.84 / NY);
      const x = Math.max(0, Math.min(W - 1, p.x | 0)), y = Math.max(0, Math.min(H - 1, p.y | 0)), k = (y * W + x) * 4;
      sum += d[k] + d[k + 1] + d[k + 2]; n++;
    }
    out[j * NX + i] = sum / n;
  }
  // ışık değişimine dayanıklı olsun: ortalamayı çıkar, yaya böl
  let m = 0; for (const v of out) m += v; m /= out.length;
  let sd = 0; for (const v of out) sd += (v - m) ** 2; sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
}
// Kare kare hareket ölçüsü (bütün kare, kaba bloklar): sayfa çevirirken el ve sayfa büyük hareket yaratır
function motionSig(img) {
  const W = img.width, H = img.height, d = img.data, NX = 24, NY = 16, out = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    let sum = 0;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
      const x = Math.min(W - 1, ((i + (a + 0.5) / 4) * W / NX) | 0), y = Math.min(H - 1, ((j + (b + 0.5) / 4) * H / NY) | 0), k = (y * W + x) * 4;
      sum += d[k] + d[k + 1] + d[k + 2];
    }
    out[j * NX + i] = sum / 48;
  }
  return out;
}
// Netlik ölçüsü (Laplace varyansı): sayfanın orta bölgesinde. Bulanık karede düşük çıkar.
function sharpness(img, q) {
  const W = img.width, H = img.height, d = img.data;
  const xs = q.map((p) => p.x * W), ys = q.map((p) => p.y * H);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ix = (x1 - x0) * 0.15, iy = (y1 - y0) * 0.15;
  x0 = Math.max(1, Math.round(x0 + ix)); x1 = Math.min(W - 2, Math.round(x1 - ix));
  y0 = Math.max(1, Math.round(y0 + iy)); y1 = Math.min(H - 2, Math.round(y1 - iy));
  const g = (x, y) => { const k = (y * W + x) * 4; return d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11; };
  let n = 0, sum = 0, sum2 = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const l = 4 * g(x, y) - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1);
    sum += l; sum2 += l * l; n++;
  }
  if (!n) return 0;
  const m = sum / n;
  return sum2 / n - m * m;
}

// Netlik en az bir yazılı bölgeye dayanmalı; bulanık bir kare kendi başına referans olamaz.
function bookFocus(img, quad) {
  const { width, height, data } = img;
  const q = quad || defaultQuad(0.08);
  const light = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  };
  let regions = 0, min = Infinity;
  for (let band = 0; band < 3; band++) {
    let edges = 0, variation = 0, curvature = 0;
    for (let row = 0; row < 36; row++) {
      const v = 0.08 + (band * 36 + row + 0.5) / 108 * 0.84;
      const lx = q[0].x + (q[3].x - q[0].x) * v, rx = q[1].x + (q[2].x - q[1].x) * v;
      const ly = q[0].y + (q[3].y - q[0].y) * v, ry = q[1].y + (q[2].y - q[1].y) * v;
      for (let col = 0; col < 110; col++) {
        const u = 0.08 + (col + 0.5) / 110 * 0.84;
        const x = Math.min(width - 2, Math.max(1, Math.round((lx + (rx - lx) * u) * width)));
        const y = Math.min(height - 2, Math.max(1, Math.round((ly + (ry - ly) * u) * height)));
        const c = light(x, y);
        const l = light(x - 1, y) - c, r = light(x + 1, y) - c;
        const t = light(x, y - 1) - c, b = light(x, y + 1) - c;
        const energy = l*l + r*r + t*t + b*b;
        if (energy < 9) continue;
        edges++;
        variation += energy;
        curvature += (l + r) ** 2 + (t + b) ** 2;
      }
    }
    if (edges >= 16) {
      regions++;
      min = Math.min(min, curvature / variation);
    }
  }
  return regions ? min : 0;
}

function sigDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const STABLE_MS = 900, TOL = 0.028, SIG_NEW = 0.9, MOTION = 22;

// Çerçeveyi yumuşat: tek karelik sıçramaları yok say, küçük titremeleri ortala
function smoothQuad(q) {
  if (!q) { cam.far = 0; return cam.smooth; }
  if (!cam.smooth) { cam.smooth = q; cam.far = 0; return q; }
  const d = qdist(cam.smooth, q);
  if (d > 0.08) {
    // çok farklı: art arda gelirse yeni yer kabul edilir, tek seferlikse yok sayılır
    cam.far = (cam.far || 0) + 1;
    if (cam.far < 3) return cam.smooth;
    cam.far = 0;
    cam.smooth = q;
    return q;
  }
  cam.far = 0;
  const a = d > 0.03 ? 0.6 : 0.3;
  cam.smooth = cam.smooth.map((p, i) => ({ x: p.x + (q[i].x - p.x) * a, y: p.y + (q[i].y - p.y) * a }));
  return cam.smooth;
}

let flatWarm = false;
function warmFlat() { if (!flatWarm) { flatWarm = true; warmUpFlatten(); } }

async function openCamera() {
  if (!$("cam").classList.contains("hidden")) return;
  const generation = ++cam.generation;
  warmFlat();
  $("cam").classList.remove("hidden");
  document.body.classList.add("noscroll");
  $("cam-hint").textContent = "Kamera açılıyor…";
  cam.shots = 0;
  cam.lastBookId = null;
  clearCameraThumb();
  updateDone();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: tab === "book" ? 2880 : 2160 } },
    });
    if (generation !== cam.generation) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    cam.stream = stream;
  } catch (e) {
    if (generation !== cam.generation) return;
    $("cam-hint").textContent = "Kameraya izin verilmedi. Tarayıcı ayarlarından kamera iznini aç ya da “Fotoğraflardan seç”i kullan.";
    return;
  }
  const track = cam.stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  if (generation !== cam.generation) return;
  freshVideo();
  video.srcObject = cam.stream;
  await new Promise((r) => { if (video.readyState >= 1) r(); else video.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 3000); });
  if (generation !== cam.generation) return;
  await video.play().catch(() => {});
  if (generation !== cam.generation) return;
  if (track.readyState === "ended") { closeCamera(); return; }
  track.addEventListener("ended", () => {
    if (generation === cam.generation) closeCamera();
  }, { once: true });
  cam.on = true;
  cam.hist = []; cam.armed = true; cam.lastQuad = null; cam.cool = 0;
  cam.busy = cam.capturing = false;
  cam.smooth = cam.prevMs = cam.lastSig = null;
  cam.sharpHist = [];
  $("cam-hint").textContent = "Sayfayı kadraja al";
  loop(generation);
}

function closeCamera() {
  if ($("cam").classList.contains("hidden")) return;
  cam.generation++;
  if (tab === "book") setTimeout(() => { bookRefresh(); processPending(); }, 50);
  cam.on = false;
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  try { video.pause(); } catch (e) {}
  video.srcObject = null;
  video.removeAttribute("src");
  try { video.load(); } catch (e) {}
  $("cam").classList.add("hidden");
  document.body.classList.remove("noscroll");
  drawQuad(null);
  clearCameraThumb();
}

// görüntünün ekrandaki yerleşimi (object-fit: contain)
function videoRect() {
  const st = $("cam-stage").getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(st.width / vw, st.height / vh);
  const w = vw * s, h = vh * s;
  return { x: (st.width - w) / 2, y: (st.height - h) / 2, w, h, sw: st.width, sh: st.height };
}

function drawQuad(q, good) {
  const poly = $("poly");
  if (!q || !video.videoWidth) { poly.setAttribute("points", ""); return; }
  const r = videoRect();
  $("overlay").setAttribute("viewBox", `0 0 ${r.sw} ${r.sh}`);
  poly.setAttribute("points", q.map((p) => `${r.x + p.x * r.w},${r.y + p.y * r.h}`).join(" "));
  poly.classList.toggle("good", !!good);
}

const qdist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

function setProgress(f) {
  const c = 2 * Math.PI * 36;
  $("prog").style.strokeDasharray = `${c}`;
  $("prog").style.strokeDashoffset = `${c * (1 - Math.max(0, Math.min(1, f)))}`;
}

async function loop(generation) {
  if (!cam.on || generation !== cam.generation) return;
  if (!cam.busy && video.videoWidth) {
    cam.busy = true;
    const now = performance.now();
    let q = null;
    try {
      const book = tab === "book";
      const fr = smallFrame(video, video.videoWidth, video.videoHeight, book ? 600 : 480);
      const copy = new ImageData(new Uint8ClampedArray(fr.data), fr.width, fr.height);
      const ms = motionSig(copy);
      if (cam.prevMs) {
        const mv = sigDiff(cam.prevMs, ms);
        // art arda iki karede güçlü hareket: sayfa çevriliyor
        cam.moving = mv > MOTION ? (cam.moving || 0) + 1 : 0;
        if (!cam.armed && (cam.moving >= 2 || mv > MOTION * 1.8)) { cam.armed = true; }
      }
      cam.prevMs = ms;
      q = (await detectPage(fr, null, null, { recover: book, book }))?.quad || null;
      if (generation !== cam.generation) return;
      cam.sig = q ? signature(copy, q) : null;
      cam.sharp = q ? sharpness(copy, q) : 0;
      cam.focus = book && q ? bookFocus(copy, q) : 0;
    } catch (e) {}
    if (!cam.on || generation !== cam.generation) return;
    cam.busy = false;
    if (q) q = smoothQuad(q);
    if (q) {
      cam.missing = 0;
      cam.hist.push({ t: now, q });
      cam.hist = cam.hist.filter((h) => now - h.t < STABLE_MS + 400);
      const recent = cam.hist.filter((h) => now - h.t <= STABLE_MS);
      const stable = recent.length >= 3 && now - recent[0].t >= STABLE_MS * 0.7 && recent.every((h) => qdist(h.q, q) < TOL);
      // aynı sayfa ikinci kez çekilmesin: sayfa değişmeli ya da kadraj boşalmalı
      // yeni sayfa mı? İçeriği belirgin biçimde değişmiş olmalı (el titremesi ya da kısa kesinti yetmez)
      if (cam.sig && cam.lastSig) {
        const sd = sigDiff(cam.lastSig, cam.sig);
        if (!cam.armed && (sd > SIG_NEW || (sd > SIG_NEW * 0.7 && cam.lastQuad && qdist(cam.lastQuad, q) > 0.12))) { cam.armed = true; }
      }
      const span = recent.length ? (now - recent[0].t) / STABLE_MS : 0;
      const ready = cam.auto && cam.armed && now > cam.cool && !bk.frontChoice;
      drawQuad(q, stable);
      setProgress(ready && recent.every((h) => qdist(h.q, q) < TOL) ? span : 0);
      // netlik geçmişi: son 1.5 sn içindeki en net kareye yakın olmalı
      cam.sharpHist = (cam.sharpHist || []).filter((h) => now - h.t < 1500);
      cam.sharpHist.push({ t: now, v: cam.sharp });
      const bestSharp = Math.max(...cam.sharpHist.map((h) => h.v));
      const stableFor = recent.length ? now - recent[0].t : 0;
      const sharpOk = tab === "book"
        ? cam.focus >= 0.26 && cam.sharp >= bestSharp * 0.85
        : cam.sharp >= bestSharp * 0.85 || stableFor > STABLE_MS * 3;
      if (ready && stable && !sharpOk) $("cam-hint").textContent = "Netleşmesini bekliyor…";
      if (ready && stable && sharpOk) {
        // köşeleri son karelerin ortalaması yap (titreşmesin)
        const avg = q.map((_, i) => ({ x: recent.reduce((s, h) => s + h.q[i].x, 0) / recent.length, y: recent.reduce((s, h) => s + h.q[i].y, 0) / recent.length }));
        capture(avg);
      } else if (!(ready && stable)) {
        $("cam-hint").textContent = !cam.armed ? "Sonraki sayfaya geç" : cam.auto ? "Sabit tut…" : "Hazır olunca çek";
      }
    } else {
      cam.missing++;
      // kısa kayıplarda çerçeveyi hemen silme
      if (cam.missing <= 2 && cam.smooth) { drawQuad(cam.smooth, false); requestAnimationFrame(() => setTimeout(() => loop(generation), 60)); return; }
      cam.smooth = null;
      cam.hist = [];
      drawQuad(null);
      setProgress(0);
      if (cam.missing > 30 && !cam.armed) { cam.armed = true; } // ≈3 sn sayfa yoksa yeniden hazır ol
      $("cam-hint").textContent = "Sayfanın tamamını kadraja al";
    }
  }
  requestAnimationFrame(() => setTimeout(() => loop(generation), 60));
}

// Destekleyen telefonlarda kameranın tam çözünürlüklü fotoğrafı (video karesinden çok daha net)
async function takeFullPhoto(vw, vh) {
  try {
    if (!("ImageCapture" in window) || !cam.stream) return null;
    const ic = new ImageCapture(cam.stream.getVideoTracks()[0]);
    const blob = await Promise.race([ic.takePhoto(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    // video karesinden belirgin biçimde büyük ve aynı oranda değilse kullanma
    const sameRatio = Math.abs(bmp.width / bmp.height - vw / vh) < 0.03;
    if (!sameRatio || bmp.width * bmp.height < vw * vh * 1.6) { bmp.close?.(); return null; }
    return bmp;
  } catch (e) { return null; }
}

async function capture(quad) {
  if (!cam.on || !video.videoWidth || cam.capturing || bk.frontChoice) return;
  const generation = cam.generation;
  // kilidi hemen al: tam çözünürlüklü fotoğraf beklenirken ikinci çekim olmasın
  cam.capturing = true;
  cam.armed = false;
  cam.lastQuad = quad;
  cam.lastSig = cam.sig;
  cam.cool = performance.now() + 1500;
  cam.hist = [];
  const book = tab === "book";
  try { await doCapture(quad, book, generation); } finally {
    if (generation === cam.generation) {
      cam.capturing = false;
      cam.cool = performance.now() + 1200;
    }
  }
}

async function doCapture(quad, book, generation) {
  let vw = video.videoWidth, vh = video.videoHeight;
  // çekim anındaki kareyi tam çözünürlükte al
  const c = document.createElement("canvas");
  c.width = vw; c.height = vh;
  c.getContext("2d").drawImage(video, 0, 0, vw, vh);
  if (cam.hiRes !== false) {
    const photo = await takeFullPhoto(vw, vh);
    if (generation !== cam.generation) { photo?.close?.(); c.width = c.height = 0; return; }
    if (photo) {
      vw = c.width = photo.width; vh = c.height = photo.height;
      c.getContext("2d").drawImage(photo, 0, 0);
      photo.close?.();
      // Tam çözünürlüklü fotoğrafın görüş alanı önizlemeyle birebir aynı olmayabilir.
      if (book) quad = null;
    } else if (cam.hiRes === undefined) cam.hiRes = false; // desteklenmiyorsa bir daha deneme
    if (photo) cam.hiRes = true;
  }
  const f = $("flash");
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  navigator.vibrate?.(30);
  setProgress(0);
  $("cam-hint").textContent = "Çekildi";
  // çekilen karede daha yüksek çözünürlükte yeniden bul: köşeler daha hassas olur
  if (!book) {
    const fine = (await detectPage(c, vw, vh, { max: 1280, minScore: 0.4 }).catch(() => null))?.quad || null;
    if (fine && (!quad || qdist(fine, quad) < 0.06)) quad = fine;
  }
  const blob = await toBlob(c, "image/jpeg", 0.92);
  c.width = c.height = 0;
  if (generation !== cam.generation) return;
  if (book) {
    if (await bookAdd(blob, quad) && generation === cam.generation) {
      cam.shots++;
      updateDone();
    }
    return;
  }
  const p = await addPage(blob, vw, vh, quad);
  if (p?.url && generation === cam.generation) {
    cam.shots++;
    updateDone();
    setCameraThumb(p.url);
  }
}

function clearCameraThumb() {
  if (cam.thumbUrl) URL.revokeObjectURL(cam.thumbUrl);
  cam.thumbUrl = null;
  $("last").style.backgroundImage = "";
  $("last").classList.remove("has");
}
function setCameraThumb(url, owned = false) {
  clearCameraThumb();
  if (owned) cam.thumbUrl = url;
  $("last").style.backgroundImage = `url("${url}")`;
  $("last").classList.add("has");
}

function updateDone() {
  $("cam-done").textContent = cam.shots ? `Bitti (${cam.shots})` : "Bitti";
  if (tab === "book") $("cam-hint").dataset.count = cam.shots;
}

$("open-cam").addEventListener("click", openCamera);
$("more-cam").addEventListener("click", openCamera);
$("cam-close").addEventListener("click", closeCamera);
$("cam-done").addEventListener("click", closeCamera);
$("shutter").addEventListener("click", () => {
  const recent = cam.hist.length ? cam.hist[cam.hist.length - 1].q : null;
  capture(recent);
});
$("auto").addEventListener("click", () => {
  cam.auto = !cam.auto;
  $("auto").classList.toggle("on", cam.auto);
  $("auto").textContent = cam.auto ? "Otomatik çekim" : "Elle çekim";
});
$("last").addEventListener("click", async () => {
  const bookId = cam.lastBookId;
  closeCamera();
  if (tab === "doc") {
    const latest = pages.at(-1);
    if (latest) openEdit(latest);
  } else if (bookId) {
    const list = await store.listPages();
    const index = list.findIndex(page => page.id === bookId);
    if (index >= 0) await bookView(list[index], index);
  }
});
window.addEventListener("pagehide", closeCamera);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && cam.on) closeCamera();
});
window.addEventListener("resize", () => { if (!cam.on) drawQuad(null); });

// =====================================================================
// SAYFA DÜZENLEME
// =====================================================================
const ed = { p: null, cropping: false, quad: null, mode: null, rot: 0, flat: true, origUrl: null, drag: -1, previewRequest: 0 };
function markFlat() {
  $("ed-flat").classList.toggle("on", ed.flat);
  $("ed-flat").querySelector("span").textContent = ed.flat ? "Düzleştirme açık" : "Düzleştirme kapalı";
}

function openEdit(p, startCrop = false) {
  ed.p = p;
  ed.quad = p.quad.map((q) => ({ ...q }));
  ed.mode = p.mode;
  ed.rot = p.rot;
  ed.flat = p.flat !== false;
  ed.cropping = false;
  markFlat();
  $("ed-title").textContent = p.book ? p.label : `Sayfa ${pages.indexOf(p) + 1}`;
  $("ed-mode").classList.toggle("hidden", !!p.book);
  $("ed-del").classList.toggle("hidden", !!p.book);
  $("ed-flat").classList.toggle("hidden", !!p.book?.cover);
  $("edit").classList.remove("hidden");
  document.body.classList.add("noscroll");
  markMode();
  showResult();
  if (startCrop) toggleCrop();
}

function closeEdit() {
  $("edit").classList.add("hidden");
  document.body.classList.remove("noscroll");
  if (ed.origUrl) { URL.revokeObjectURL(ed.origUrl); ed.origUrl = null; }
  $("ed-img").onload = null;
  $("ed-img").onerror = null;
  $("ed-busy").classList.add("hidden");
  ed.previewRequest++;
  ed.drag = -1;
  ed.p = null;
}

function markMode() {
  $("ed-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === ed.mode));
}

function flatLabel(info) {
  if (info && info.startsWith("ok")) return "Düzleştirildi (" + info.slice(3) + ")";
  return info === "ok" ? "Düzleştirildi" : info === "kapalı" ? "Düzleştirme kapalı" : info ? "Düzleştirilemedi: " + info : "";
}
function showResult() {
  $("ed-svg").innerHTML = "";
  $("ed-img").src = ed.p.url;
  const { book, flatInfo } = ed.p;
  $("ed-state").textContent = book ? (book.needsCrop ? "" : bookEditStatus(book.flatInfo)) : flatLabel(flatInfo);
  $("ed-crop").querySelector("span").textContent = "Köşeleri ayarla";
}

async function preview() {
  // değişikliği önizle (geçici)
  const p = ed.p;
  const request = ++ed.previewRequest;
  const quad = p.book ? ed.quad.map((corner) => ({ ...corner })) : ed.quad;
  const tmp = { ...p, quad, mode: ed.mode, rot: ed.rot, flat: ed.flat, url: null };
  $("ed-busy").classList.remove("hidden");
  try {
    if (p.book) {
      tmp.result = await renderBookEdit(tmp);
      tmp.url = URL.createObjectURL(tmp.result.blob);
      tmp.flatInfo = tmp.result.flatInfo;
    } else await render(tmp);
    if (request === ed.previewRequest && !ed.cropping) {
      $("ed-img").src = tmp.url;
      $("ed-state").textContent = p.book ? bookEditStatus(tmp.flatInfo) : flatLabel(tmp.flatInfo);
      if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url);
      ed.tmp = tmp;
    } else URL.revokeObjectURL(tmp.url);
  } catch (e) {
    if (request === ed.previewRequest) alert(e.message);
  } finally {
    if (request === ed.previewRequest) $("ed-busy").classList.add("hidden");
  }
}

function toggleCrop() {
  ed.cropping = !ed.cropping;
  if (ed.cropping) {
    if (!ed.origUrl) ed.origUrl = URL.createObjectURL(ed.p.orig);
    const img = $("ed-img");
    img.onload = drawHandles;
    img.onerror = () => { $("ed-state").textContent = "Fotoğraf görüntülenemedi. Önizlemeye dönüp yeniden dene."; };
    img.src = ed.origUrl;
    if (ed.p.book) $("ed-state").textContent = ed.p.savedSource
      ? "Orijinal açılamadı. Köşeler kayıtlı görüntüde düzenleniyor."
      : "Dört köşeyi sayfanın kenarlarına taşı";
    if (img.complete && img.naturalWidth) drawHandles();
    $("ed-crop").querySelector("span").textContent = "Köşeleri uygula";
  } else {
    $("ed-img").onload = null;
    $("ed-img").onerror = null;
    $("ed-svg").innerHTML = "";
    $("ed-crop").querySelector("span").textContent = "Köşeleri ayarla";
    preview();
  }
}

function imgRect() {
  // görüntü kutusunu doldurur (object-fit: contain): gerçek resim alanını hesapla
  const img = $("ed-img"), st = $("ed-stage").getBoundingClientRect(), r = img.getBoundingClientRect();
  const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
  const s = Math.min(r.width / nw, r.height / nh), w = nw * s, h = nh * s;
  return { x: r.left - st.left + (r.width - w) / 2, y: r.top - st.top + (r.height - h) / 2, w, h, sw: st.width, sh: st.height };
}

function drawHandles() {
  if (!ed.cropping || !$("ed-img").naturalWidth) return;
  const r = imgRect();
  const svg = $("ed-svg");
  svg.setAttribute("viewBox", `0 0 ${r.sw} ${r.sh}`);
  const P = ed.quad.map((p) => [r.x + p.x * r.w, r.y + p.y * r.h]);
  svg.innerHTML = `<polygon class="qpoly" points="${P.map((p) => p.join(",")).join(" ")}"/>` +
    P.map((p, i) => `<circle class="h" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="16"/><circle class="hdot" cx="${p[0]}" cy="${p[1]}" r="5"/>`).join("");
}

$("ed-svg").addEventListener("pointerdown", (e) => {
  const t = e.target.closest(".h");
  if (!t) return;
  ed.drag = +t.dataset.i;
  $("ed-svg").setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("ed-svg").addEventListener("pointermove", (e) => {
  if (ed.drag < 0) return;
  const r = imgRect(), st = $("ed-stage").getBoundingClientRect();
  const x = (e.clientX - st.left - r.x) / r.w, y = (e.clientY - st.top - r.y) / r.h;
  ed.quad[ed.drag] = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  drawHandles();
});
const endDrag = () => { ed.drag = -1; };
$("ed-svg").addEventListener("pointerup", endDrag);
$("ed-svg").addEventListener("pointercancel", endDrag);
window.addEventListener("resize", () => drawHandles());

$("ed-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  ed.mode = b.dataset.m;
  markMode();
  if (ed.cropping) { ed.cropping = true; toggleCrop(); } else preview();
});
$("ed-rot").addEventListener("click", () => {
  ed.rot = (ed.rot + 90) % 360;
  if (ed.cropping) { toggleCrop(); } else preview();
});
$("ed-crop").addEventListener("click", toggleCrop);
$("ed-flat").addEventListener("click", () => {
  ed.flat = !ed.flat;
  markFlat();
  if (ed.cropping) toggleCrop(); else preview();
});
$("ed-close").addEventListener("click", () => { if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url); ed.tmp = null; closeEdit(); });
$("ed-ok").addEventListener("click", async () => {
  const p = ed.p;
  if (!p) return;
  if (p.book) return saveBookEdit(p);
  const changed = ed.cropping || ed.mode !== p.mode || ed.rot !== p.rot || ed.flat !== (p.flat !== false) || qdist(ed.quad, p.quad) > 1e-4;
  if (ed.cropping) { ed.cropping = false; $("ed-svg").innerHTML = ""; if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url); ed.tmp = null; }
  if (changed) {
    p.quad = ed.quad; p.mode = ed.mode; p.rot = ed.rot; p.flat = ed.flat; p.guessed = false;
    if (ed.tmp && ed.tmp.quad === ed.quad && ed.tmp.mode === ed.mode && ed.tmp.rot === ed.rot && ed.tmp.flat === ed.flat) {
      if (p.url) URL.revokeObjectURL(p.url);
      p.out = ed.tmp.out; p.url = ed.tmp.url; p.w = ed.tmp.w; p.h = ed.tmp.h; p.flatInfo = ed.tmp.flatInfo;
      ed.tmp = null;
    } else {
      $("ed-busy").classList.remove("hidden");
      await render(p);
      $("ed-busy").classList.add("hidden");
    }
  }
  if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url);
  ed.tmp = null;
  closeEdit();
  renderList();
});
$("ed-del").addEventListener("click", () => {
  if (!confirm("Bu sayfa silinsin mi?")) return;
  const p = ed.p;
  pages.splice(pages.indexOf(p), 1);
  if (p.url) URL.revokeObjectURL(p.url);
  closeEdit();
  renderList();
});

// =====================================================================
// DIŞA AKTARMA
// =====================================================================
$("pdf").addEventListener("click", async () => {
  const ready = pages.filter((p) => p.out);
  if (!ready.length) return;
  const b = $("pdf");
  b.disabled = true;
  try {
    const pdf = await makePdf(ready.map((p) => ({ blob: p.out, w: p.w, h: p.h })));
    download(pdf, `belge-${stamp()}.pdf`);
  } finally { b.disabled = false; }
});

$("jpg").addEventListener("click", async () => {
  const ready = pages.filter((p) => p.out);
  if (!ready.length) return;
  if (ready.length === 1) return download(ready[0].out, `belge-${stamp()}.jpg`);
  const zip = new window.JSZip();
  ready.forEach((p, i) => zip.file(`sayfa-${String(i + 1).padStart(2, "0")}.jpg`, p.out));
  download(await zip.generateAsync({ type: "blob", compression: "STORE" }), `belge-${stamp()}.zip`);
});

$("clear").addEventListener("click", () => {
  if (!confirm("Bütün sayfalar silinsin mi?")) return;
  pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  pages.length = 0;
  renderList();
});

renderList();

// =====================================================================
// KİTAP
// =====================================================================
const bk = { mode: "text", pages: [], urls: [], frontChoice: null };
const COVER_LABELS = { front: "Ön kapak", back: "Arka kapak" };
const BOOK_SIDE = 2200;

(async () => {
  bk.mode = (await store.getMeta("mode").catch(() => null)) || "text";
  $("bk-title").value = (await store.getMeta("title").catch(() => "")) || "";
  markBookMode();
  const n = (await store.listPages().catch(() => [])).length;
  if (n) { // yarım kalmış kitap varsa doğrudan oraya aç
    document.querySelector('.tab[data-tab="book"]').click();
    processPending();
  }
})();

function markBookMode() {
  $("bk-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === bk.mode));
  $("bk-mode-note").textContent = bk.mode === "text"
    ? "Yazı: siyah-beyaz ve çok net, en küçük dosya. 100 sayfa yaklaşık 5–10 MB."
    : "Resimli: gri tonlu, fotoğraflı sayfalar için. Dosya daha büyük olur.";
}
$("bk-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  bk.mode = b.dataset.m;
  markBookMode();
  store.setMeta("mode", bk.mode).catch(() => {});
});
$("bk-title").addEventListener("change", () => store.setMeta("title", $("bk-title").value.trim()).catch(() => {}));

const frontDialog = $("bk-front");
frontDialog.addEventListener("cancel", (e) => e.preventDefault());

function chooseFrontPage(id) {
  if (bk.frontChoice) return bk.frontChoice;
  bk.frontChoice = (async () => {
    const page = await store.getPage(id);
    if (!page?.chooseFront) return;
    const url = URL.createObjectURL(page.thumb || page.raw);
    const yes = $("bk-front-yes"), no = $("bk-front-no");
    $("bk-front-img").src = url;
    try {
      await new Promise((resolve) => {
        async function answer(e) {
          if (e.target !== yes && e.target !== no) return;
          yes.disabled = no.disabled = true;
          try {
            await store.setFrontChoice(id, e.target === yes);
            frontDialog.removeEventListener("click", answer);
            frontDialog.close();
            resolve();
          } catch (err) {
            alert("Seçim kaydedilemedi: " + err.message);
          } finally {
            yes.disabled = no.disabled = false;
          }
        }
        frontDialog.showModal();
        frontDialog.addEventListener("click", answer);
      });
    } finally {
      $("bk-front-img").removeAttribute("src");
      URL.revokeObjectURL(url);
    }
  })().finally(() => { bk.frontChoice = null; });
  return bk.frontChoice;
}

// Kitap: kamera açıkken sayfalar yalnızca ham kaydedilir (hızlı, kaybolmaz); ağır işleme kamera kapanınca yapılır.
async function bookAdd(origBlob, quad) {
  const mode = bk.mode;
  const generation = cam.generation;
  try {
    if (!origBlob?.size) throw new Error("Fotoğraf oluşturulamadı. Yeniden çekmeyi dene.");
    const tb = await createImageBitmap(origBlob, { resizeWidth: 120, resizeQuality: "medium" }).catch(() => null);
    let thumb = null;
    if (tb) {
      const t = document.createElement("canvas");
      t.width = tb.width; t.height = tb.height;
      t.getContext("2d").drawImage(tb, 0, 0);
      tb.close?.();
      thumb = await toBlob(t, "image/jpeg", 0.6);
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const first = await store.putPage({ id, order: Date.now() + Math.random(), raw: origBlob, quad: quad || null, thumb, mode, pending: true, size: 0 });
    if (first) await chooseFrontPage(id);
    if (cam.on && thumb && cam.generation === generation) {
      cam.lastBookId = id;
      setCameraThumb(URL.createObjectURL(thumb), true);
    }
  } catch (e) {
    console.error(e);
    alert("Sayfa kaydedilemedi: " + (e.message || e));
    return false;
  }
  if (!cam.on) processPending();
  return true;
}

let processing = null;
// Bekleyen (ham) sayfaları sırayla işler. Kamera açılırsa durur, kapanınca devam eder.
function processPending() {
  if (processing) return processing;
  processing = (async () => {
    try {
      for (;;) {
        if (cam.on) break;
        const list = await store.listPages();
        const next = list.find((p) => p.pending);
        if (!next) {
          const lastInterior = list.findLast((p) => !p.cover);
          if (list.some((p) => p.forBack && p.id !== lastInterior?.id)) await store.pruneBookOriginals();
          break;
        }
        if (next.chooseFront) break;
        bookProgress(true, null, `Sayfalar düzeltiliyor… ${list.filter((p) => !p.pending).length + 1}/${list.length}`);
        const rec = await store.getPage(next.id);
        if (!rec || !rec.pending || rec.chooseFront) continue;
        try {
          const corners = rec.reclassify && rec.keepOriginal && !rec.needsCrop ? rec.quad : null;
          const result = await renderBookPhoto(rec, corners, !rec.cover, rec.rot || 0);
          const forBack = !rec.cover && !result.needsCrop && !result.needsFocus && !rec.keepOriginal;
          await store.finishPendingPage({ ...rec, ...result, pending: false, forBack, reclassify: false });
        } catch (e) {
          console.error("sayfa işlenemedi", e);
          // ham hali bozuksa sonsuz döngüye girme
          const cover = rec.reclassify ? (rec.cover === "back" ? "" : "back") : rec.cover;
          await store.finishPendingPage({ ...rec, cover, pending: false, reclassify: false,
            failed: !rec.blob, needsCrop: true, size: rec.blob?.size || rec.raw?.size || 0 }, true);
        }
        if (!$("tab-book").classList.contains("hidden")) bookRefresh();
      }
    } finally {
      processing = null;
      const left = (await store.listPages().catch(() => [])).filter((p) => p.pending).length;
      if (!left) bookProgress(false);
      if (tab === "book" && !cam.on) bookRefresh();
    }
  })();
  return processing;
}

async function renderBookPhoto(rec, corners, flat = !rec.cover, rot = 0) {
  const bmp = rec.decoded || await bitmapOf(rec.raw);
  let quad, img, focus;
  try {
    const found = corners ? null : await detectPage(bmp, bmp.width, bmp.height, { max: 1280, minScore: 0.4, recover: true, book: true }).catch(() => null);
    quad = corners || found?.quad;
    focus = !rec.cover && bookFocus(smallFrame(bmp, bmp.width, bmp.height, 600), quad) < 0.26;
    img = quad ? fullFrame(bmp, bmp.width, bmp.height) : smallFrame(bmp, bmp.width, bmp.height, BOOK_SIDE);
  } finally {
    bmp.close?.();
  }
  const crop = quad || defaultQuad(0);
  const mode = rec.cover || !quad ? "orig" : focus ? "book-gray" : rec.mode === "text" ? "bw" : "gray";
  const out = quad ? await processPage(img, crop, mode, flat, BOOK_SIDE, true) : img;
  const corrected = canvasFromImageData(out);
  const c = rotated(quad ? toA4(corrected, 0.025) : corrected, rot);
  const blob = mode === "bw" ? await toBlob(c, "image/png") : await toBlob(c, "image/jpeg", rec.cover ? 0.94 : 0.78);
  if (!blob) throw new Error("Sayfa görüntüsü oluşturulamadı.");
  const t = document.createElement("canvas");
  t.width = 120;
  t.height = Math.round(120 * c.height / c.width);
  t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
  const thumb = await toBlob(t, "image/jpeg", 0.7);
  return { blob, thumb, w: c.width, h: c.height, quad: crop, flat, flatInfo: out.flatInfo, rot,
    needsCrop: !quad, needsFocus: focus, bilevel: mode === "bw", failed: false, size: blob.size };
}

function renderBookEdit(p) {
  const quad = p.quad;
  const convex = quad.every((a, i) => {
    const b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) > 0.001;
  });
  if (!convex) throw new Error("Köşeleri kesişmeyecek biçimde sayfanın dört kenarına yerleştir.");
  return renderBookPhoto(p.book, quad, p.flat, p.rot);
}

function bookEditStatus(info) {
  return info?.startsWith("ok:") ? "Düzleştirildi" : "Perspektif düzeltildi";
}

async function saveBookEdit(p) {
  const button = $("ed-ok");
  if (button.disabled) return;
  button.disabled = true;
  ed.previewRequest++;
  $("ed-busy").classList.remove("hidden");
  try {
    const adjustments = { ...p, quad: ed.quad.map((corner) => ({ ...corner })), flat: ed.flat, rot: ed.rot };
    const tmp = ed.tmp;
    const samePreview = tmp?.book === p.book && tmp.flat === adjustments.flat && tmp.rot === adjustments.rot
      && qdist(tmp.quad, adjustments.quad) < 1e-4;
    const result = samePreview ? tmp.result : await renderBookEdit(adjustments);
    if (ed.p !== p) return;
    if (!await store.updateBookPage(p.book.id, { ...result, raw: p.orig, keepOriginal: true, forBack: false })) throw new Error("Bu sayfa artık kitapta yok.");
    if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url);
    ed.tmp = null;
    closeEdit();
    await bookRefresh();
  } catch (e) {
    if (ed.p === p) alert(e.message);
  } finally {
    button.disabled = false;
    $("ed-busy").classList.add("hidden");
  }
}

async function bookRefresh() {
  const list = await store.listPages().catch(() => []);
  bk.pages = list;
  const first = list.find((p) => p.chooseFront);
  if (first && tab === "book" && !bk.frontChoice) {
    chooseFrontPage(first.id).then(processPending).catch(console.error);
  }
  const last = list.at(-1);
  const back = $("bk-back");
  back.classList.toggle("hidden", list.length < 2 || !last?.hasRaw || !!last.pending);
  back.textContent = last?.cover === "back" ? "Arka kapağı iç sayfa yap" : "Son sayfayı arka kapak yap";
  bk.urls.forEach((u) => URL.revokeObjectURL(u));
  bk.urls = [];
  $("bk-doc").classList.toggle("hidden", !list.length);
  $("bk-cam-label").textContent = list.length ? "Çekmeye devam et" : "Sayfaları çek";
  $("bk-count").textContent = `${list.length} sayfa`;
  const total = list.reduce((s, p) => s + (p.size || 0), 0);
  $("bk-size").textContent = list.length ? `PDF yaklaşık ${fmtSize(total * (bk.mode === "text" ? 0.75 : 1.02))}` : "";
  const ul = $("bk-pages");
  ul.innerHTML = "";
  list.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "page glass";
    li.tabIndex = 0;
    const img = document.createElement("img");
    if (p.thumb) {
      const u = URL.createObjectURL(p.thumb);
      bk.urls.push(u);
      img.src = u;
    }
    img.alt = COVER_LABELS[p.cover] || `Sayfa ${i + 1}`;
    img.loading = "lazy";
    const n = document.createElement("span");
    n.className = "num"; n.textContent = COVER_LABELS[p.cover] || i + 1;
    li.append(img, n);
    if (p.pending) { li.classList.add("pending"); const sp = document.createElement("div"); sp.className = "spinner small"; li.append(sp); }
    li.addEventListener("click", () => bookView(p, i));
    li.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      bookView(p, i);
    });
    ul.append(li);
  });
}

let viewing = null, viewUrl = null;
async function bookView(p, i) {
  const full = await store.getPage(p.id);
  if (!full || $("bk-view").open) return;
  viewing = full;
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  const img = $("bk-view-img");
  const source = full.blob || full.raw;
  viewUrl = source ? URL.createObjectURL(source) : null;
  img.alt = COVER_LABELS[p.cover] || `Sayfa ${i + 1}`;
  $("bk-view-crop").classList.toggle("hidden", !(full.raw || full.cover) || full.pending);
  const note = $("bk-view-note");
  note.textContent = full.needsCrop
    ? "Dört kenar doğrulanamadı. Kadrajı kontrol et veya köşeleri fotoğraf üzerinde işaretle."
    : "Yazı net görünmüyorsa sayfayı yeniden çekebilirsin.";
  note.classList.toggle("hidden", !full.needsCrop && !full.needsFocus);
  img.onerror = () => {
    if (viewing !== full) return;
    img.onerror = null;
    note.textContent = "Kayıtlı görüntü açılamadı. Orijinal fotoğrafı Köşeleri düzelt ile açmayı dene.";
    note.classList.remove("hidden");
    if (full.thumb) {
      URL.revokeObjectURL(viewUrl);
      viewUrl = URL.createObjectURL(full.thumb);
      img.src = viewUrl;
    }
  };
  if (viewUrl) img.src = viewUrl;
  else { img.removeAttribute("src"); img.onerror(); }
  $("bk-view").showModal();
}
$("bk-view-crop").addEventListener("click", async () => {
  const page = viewing, dialog = $("bk-view"), button = $("bk-view-crop");
  if (!page || button.disabled) return;
  button.disabled = true;
  let photo, savedSource = false;
  try {
    photo = await openPhoto(page.raw).catch(() => null);
    if (!photo) {
      savedSource = true;
      photo = await openPhoto(page.blob);
    }
    if (viewing !== page || !dialog.open) return;
    const book = { ...page, raw: photo.blob, decoded: photo.image };
    const label = $("bk-view-img").alt;
    dialog.close();
    ed.origUrl = photo.url;
    photo = null;
    openEdit({ book, label, orig: book.raw, url: viewUrl, savedSource,
      quad: savedSource ? defaultQuad(0) : book.quad || defaultQuad(0),
      mode: book.mode, rot: savedSource ? 0 : book.rot || 0, flat: book.flat ?? !book.cover }, true);
  } catch {
    if (viewing === page && dialog.open) {
      $("bk-view-note").textContent = "Fotoğraf açılamadı. Bu sayfayı yeniden çekmen gerekiyor.";
      $("bk-view-note").classList.remove("hidden");
    }
  } finally {
    if (photo) URL.revokeObjectURL(photo.url);
    button.disabled = false;
  }
});
$("bk-view-close").addEventListener("click", () => $("bk-view").close());
$("bk-view").addEventListener("click", (e) => { if (e.target === $("bk-view")) $("bk-view").close(); });
$("bk-view-del").addEventListener("click", async () => {
  if (!viewing || !confirm("Bu sayfa silinsin mi?")) return;
  await store.delPage(viewing.id);
  $("bk-view").close();
  bookRefresh();
});

$("bk-cam").addEventListener("click", openCamera);
$("bk-back").addEventListener("click", async () => {
  const button = $("bk-back"), last = bk.pages.at(-1);
  if (!last || button.disabled) return;
  button.disabled = true;
  try {
    const page = await store.getPage(last.id);
    if (!page?.raw) throw new Error("Orijinal fotoğraf açılamadı.");
    const cover = page.cover === "back" ? "" : "back";
    const mode = page.mode === "orig" ? bk.mode : page.mode;
    const corners = page.keepOriginal && !page.needsCrop ? page.quad : null;
    const result = await renderBookPhoto({ ...page, cover, mode }, corners, !cover, page.rot || 0);
    await store.setLastPageCover(last, { ...result, raw: page.raw, cover, mode, reclassify: false,
      forBack: !cover && !result.needsCrop && !result.needsFocus && !page.keepOriginal });
    await bookRefresh();
  } catch (e) {
    bookProgress(true, 0, "Son sayfa güncellenemedi. Mevcut kayıt korundu. " + e.message);
  } finally {
    button.disabled = false;
  }
});
$("bk-pick").addEventListener("change", async (e) => {
  const fs = [...e.target.files]; e.target.value = "";
  for (const f of fs) {
    try {
      const bmp = await bitmapOf(f);
      const s = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      await bookAdd(await toBlob(c, "image/jpeg", 0.92), null);
    } catch (err) { alert(`“${f.name}” açılamadı.`); }
  }
  bookRefresh();
  processPending();
});

function bookProgress(on, f, text) {
  $("bk-prog").classList.toggle("hidden", !on);
  if (f != null) $("bk-bar").style.width = `${Math.round(f * 100)}%`;
  if (text != null) $("bk-status").textContent = text;
}

async function buildBookPdf(list) {
  if (!list.length) throw new Error("Henüz sayfa yok");
  if (list.some((p) => p.pending)) throw new Error("Sayfalar işlenirken biraz bekle.");
  const loaders = list.map((p) => async () => {
    const full = await store.getPage(p.id);
    if ((full.bilevel ?? full.mode === "text") && !full.cover && !full.failed) {
      const bmp = await bitmapOf(full.blob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      const bytes = await packBits(c);
      c.width = c.height = 0;
      return { kind: "bits", bytes, w: full.w, h: full.h };
    }
    const source = full.blob || full.raw;
    let w = full.w, h = full.h;
    if (!w || !h) { const b = await bitmapOf(source); w = b.width; h = b.height; b.close?.(); }
    return { kind: "jpeg", bytes: new Uint8Array(await source.arrayBuffer()), w, h };
  });
  return makePdf(loaders, (f) => bookProgress(true, f, `PDF hazırlanıyor… ${Math.round(f * list.length)}/${list.length}`));
}

const bookName = () => (($("bk-title").value.trim() || "kitap").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80));

$("bk-pdf").addEventListener("click", async () => {
  const b = $("bk-pdf");
  b.disabled = true;
  try {
    await processPending();
    const pdf = await buildBookPdf(await store.listPages());
    bookProgress(true, 1, `Hazır: ${fmtSize(pdf.size)}`);
    download(pdf, `${bookName()}.pdf`);
  } catch (e) { bookProgress(true, 0, e.message || String(e)); }
  finally { b.disabled = false; }
});

$("bk-epub").addEventListener("click", async () => {
  const b = $("bk-epub");
  b.disabled = true;
  try {
    await processPending();
    const list = await store.listPages();
    if (!list.some((p) => !p.cover)) throw new Error("EPUB için en az bir iç sayfa ekle.");
    const covers = { front: list[0].cover === "front", back: list.at(-1).cover === "back" };
    const pdf = await buildBookPdf(list);
    bookProgress(true, 1, "Kitap Çevirici açılıyor…");
    const transfer = await store.shareFile(`${bookName()}.pdf`, pdf, covers);
    location.href = "/pdf-epub/?kaynak=belge&aktarim=" + encodeURIComponent(transfer);
  } catch (e) { bookProgress(true, 0, e.message || String(e)); b.disabled = false; }
});

$("bk-clear").addEventListener("click", async () => {
  if (!confirm("Bu kitabın bütün sayfaları silinsin mi? Geri alınamaz.")) return;
  await store.clearBook();
  await store.setMeta("title", "");
  $("bk-title").value = "";
  bookProgress(false);
  bookRefresh();
});

store.storageInfo();
