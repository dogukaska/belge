import { cvReady, detect, warp, smallFrame, fullFrame } from "./lib/cv.js?v=1";
import { makePdf } from "./lib/pdf.js?v=1";

const $ = (id) => document.getElementById(id);
const pages = [];          // { id, orig: Blob, ow, oh, quad, mode, rot, out: Blob, w, h, url }
let uid = 0;
const DEFAULT_MODE = "color";
const MAX_SIDE = 3200;

cvReady().catch(() => {}); // işleyiciyi önceden ısıt

// =====================================================================
// Yardımcılar
// =====================================================================
const defaultQuad = () => [{ x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 }];

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

async function bitmapOf(blob) {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** Sayfanın sonucunu (düzeltilmiş görüntü) üretir */
async function render(p) {
  const bmp = await bitmapOf(p.orig);
  const img = fullFrame(bmp, bmp.width, bmp.height);
  bmp.close?.();
  const out = await warp(img, p.quad, p.mode, MAX_SIDE);
  const c = rotated(canvasFromImageData(out), p.rot);
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
  for (const f of files) {
    try {
      const bmp = await bitmapOf(f);
      // çok büyükse makul boyuta indir
      const s = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      const q = await detect(smallFrame(c, c.width, c.height)).catch(() => null);
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
const video = $("video");
const cam = { stream: null, on: false, busy: false, auto: true, hist: [], lastQuad: null, armed: true, cool: 0, shots: 0, missing: 0 };
const STABLE_MS = 900, TOL = 0.018;

async function openCamera() {
  $("cam").classList.remove("hidden");
  document.body.classList.add("noscroll");
  $("cam-hint").textContent = "Kamera açılıyor…";
  cam.shots = 0;
  updateDone();
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (e) {
    $("cam-hint").textContent = "Kameraya izin verilmedi. Tarayıcı ayarlarından kamera iznini aç ya da “Fotoğraflardan seç”i kullan.";
    return;
  }
  const track = cam.stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  video.srcObject = cam.stream;
  await video.play().catch(() => {});
  cam.on = true;
  cam.hist = []; cam.armed = true; cam.lastQuad = null; cam.cool = 0;
  $("cam-hint").textContent = "Sayfayı kadraja al";
  loop();
}

function closeCamera() {
  cam.on = false;
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  video.srcObject = null;
  $("cam").classList.add("hidden");
  document.body.classList.remove("noscroll");
  drawQuad(null);
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

async function loop() {
  if (!cam.on) return;
  if (!cam.busy && video.videoWidth) {
    cam.busy = true;
    const now = performance.now();
    let q = null;
    try { q = await detect(smallFrame(video, video.videoWidth, video.videoHeight, 480)); } catch (e) {}
    cam.busy = false;
    if (!cam.on) return;
    if (q) {
      cam.missing = 0;
      cam.hist.push({ t: now, q });
      cam.hist = cam.hist.filter((h) => now - h.t < STABLE_MS + 400);
      const recent = cam.hist.filter((h) => now - h.t <= STABLE_MS);
      const stable = recent.length >= 3 && now - recent[0].t >= STABLE_MS * 0.7 && recent.every((h) => qdist(h.q, q) < TOL);
      // aynı sayfa ikinci kez çekilmesin: sayfa değişmeli ya da kadraj boşalmalı
      if (!cam.armed && cam.lastQuad && qdist(cam.lastQuad, q) > 0.12) cam.armed = true;
      const span = recent.length ? (now - recent[0].t) / STABLE_MS : 0;
      const ready = cam.auto && cam.armed && now > cam.cool;
      drawQuad(q, stable);
      setProgress(ready && recent.every((h) => qdist(h.q, q) < TOL) ? span : 0);
      if (ready && stable) {
        // köşeleri son karelerin ortalaması yap (titreşmesin)
        const avg = q.map((_, i) => ({ x: recent.reduce((s, h) => s + h.q[i].x, 0) / recent.length, y: recent.reduce((s, h) => s + h.q[i].y, 0) / recent.length }));
        capture(avg);
      } else {
        $("cam-hint").textContent = !cam.armed ? "Sonraki sayfaya geç" : cam.auto ? "Sabit tut…" : "Hazır olunca çek";
      }
    } else {
      cam.missing++;
      cam.hist = [];
      drawQuad(null);
      setProgress(0);
      if (cam.missing > 4) cam.armed = true;
      $("cam-hint").textContent = "Sayfayı kadraja al";
    }
  }
  requestAnimationFrame(() => setTimeout(loop, 60));
}

async function capture(quad) {
  if (!video.videoWidth) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  // çekim anındaki kareyi tam çözünürlükte al
  const c = document.createElement("canvas");
  c.width = vw; c.height = vh;
  c.getContext("2d").drawImage(video, 0, 0, vw, vh);
  const f = $("flash");
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  navigator.vibrate?.(30);
  cam.armed = false;
  cam.lastQuad = quad;
  cam.cool = performance.now() + 1500;
  cam.hist = [];
  setProgress(0);
  $("cam-hint").textContent = "Çekildi";
  if (!quad) {
    // elle çekimde o anki kareden bul
    quad = await detect(smallFrame(c, vw, vh, 640)).catch(() => null);
  }
  const blob = await toBlob(c, "image/jpeg", 0.92);
  c.width = c.height = 0;
  cam.shots++;
  updateDone();
  const p = await addPage(blob, vw, vh, quad);
  if (p?.url) { $("last").style.backgroundImage = `url(${p.url})`; $("last").classList.add("has"); }
}

function updateDone() {
  $("cam-done").textContent = cam.shots ? `Bitti (${cam.shots})` : "Bitti";
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
$("last").addEventListener("click", closeCamera);
window.addEventListener("resize", () => { if (!cam.on) drawQuad(null); });

// =====================================================================
// SAYFA DÜZENLEME
// =====================================================================
const ed = { p: null, cropping: false, quad: null, mode: null, rot: 0, origUrl: null, drag: -1 };

function openEdit(p, startCrop = false) {
  ed.p = p;
  ed.quad = p.quad.map((q) => ({ ...q }));
  ed.mode = p.mode;
  ed.rot = p.rot;
  ed.cropping = false;
  $("ed-title").textContent = `Sayfa ${pages.indexOf(p) + 1}`;
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
  ed.p = null;
}

function markMode() {
  $("ed-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === ed.mode));
}

function showResult() {
  $("ed-svg").innerHTML = "";
  $("ed-img").src = ed.p.url;
  $("ed-crop").querySelector("span").textContent = "Köşeleri ayarla";
}

async function preview() {
  // değişikliği önizle (geçici)
  const p = ed.p;
  const tmp = { ...p, quad: ed.quad, mode: ed.mode, rot: ed.rot, url: null };
  $("ed-busy").classList.remove("hidden");
  try { await render(tmp); $("ed-img").src = tmp.url; ed.tmp?.url && URL.revokeObjectURL(ed.tmp.url); ed.tmp = tmp; }
  catch (e) { alert(e.message); }
  $("ed-busy").classList.add("hidden");
}

function toggleCrop() {
  ed.cropping = !ed.cropping;
  if (ed.cropping) {
    if (!ed.origUrl) ed.origUrl = URL.createObjectURL(ed.p.orig);
    $("ed-img").src = ed.origUrl;
    $("ed-img").onload = drawHandles;
    $("ed-crop").querySelector("span").textContent = "Köşeleri uygula";
  } else {
    $("ed-img").onload = null;
    $("ed-svg").innerHTML = "";
    $("ed-crop").querySelector("span").textContent = "Köşeleri ayarla";
    preview();
  }
}

function imgRect() {
  const img = $("ed-img"), st = $("ed-stage").getBoundingClientRect(), r = img.getBoundingClientRect();
  return { x: r.left - st.left, y: r.top - st.top, w: r.width, h: r.height, sw: st.width, sh: st.height };
}

function drawHandles() {
  if (!ed.cropping) return;
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
$("ed-close").addEventListener("click", () => { if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url); ed.tmp = null; closeEdit(); });
$("ed-ok").addEventListener("click", async () => {
  const p = ed.p;
  const changed = ed.cropping || ed.mode !== p.mode || ed.rot !== p.rot || qdist(ed.quad, p.quad) > 1e-4;
  if (ed.cropping) { ed.cropping = false; $("ed-svg").innerHTML = ""; if (ed.tmp?.url) URL.revokeObjectURL(ed.tmp.url); ed.tmp = null; }
  if (changed) {
    p.quad = ed.quad; p.mode = ed.mode; p.rot = ed.rot; p.guessed = false;
    if (ed.tmp && ed.tmp.quad === ed.quad && ed.tmp.mode === ed.mode && ed.tmp.rot === ed.rot) {
      if (p.url) URL.revokeObjectURL(p.url);
      p.out = ed.tmp.out; p.url = ed.tmp.url; p.w = ed.tmp.w; p.h = ed.tmp.h;
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
