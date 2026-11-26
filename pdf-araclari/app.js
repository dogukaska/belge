import { cropEdges, operations } from "./operations.js";
import { addFormField, bindExisting, writeForm } from "./forms.js";
import { openReader, renderPage } from "./pdf.js";

const $ = id => document.getElementById(id);
const titles = {
  numara: ["Sayfa Numarası Ekle", "Konumu, boyutu ve yazı tipini seç."],
  kirp: ["PDF Kırp", "Kenarları yüzdeyle ayarla ve sonucu önizle."],
  form: ["PDF Formlar", "Bir formu doldur veya yeni etkileşimli alanlar ekle."],
  ocr: ["OCR PDF", "Taranmış sayfalara aranabilir Türkçe metin katmanı ekle."],
  filigran: ["PDF Filigran", "Sayfalara metin veya logo ekle."],
  imza: ["PDF İmzala", "İmzanı çiz ve istediğin sayfaya ekle."],
  ayir: ["PDF Ayır", "Sayfaları bağımsız PDF dosyalarına çıkar."],
  kucult: ["PDF Küçült", "PDF’i içeriği koruyarak veya görsel sayfaları sıkıştırarak küçült."],
};
const requested = new URLSearchParams(location.search).get("arac");
const mode = Object.hasOwn(titles, requested) ? requested : "numara";
const [title, intro] = titles[mode];
$("title").textContent = title;
$("intro").textContent = intro;
document.title = title + " · Dijital Çakı";

const range = '<label>Sayfalar (isteğe bağlı)<input id="range" maxlength="1200" placeholder="Tümü veya 1–3, 5"></label>';
function number(id, label, value, min, max) {
  return `<label>${label}<input type="number" id="${id}" value="${value}" min="${min}" max="${max}" required></label>`;
}
function select(id, label, options, active) {
  return `<label>${label}<select id="${id}">${options.map(([value, title]) =>
    `<option value="${value}"${value === active ? " selected" : ""}>${title}</option>`).join("")}</select></label>`;
}
function pos(value) {
  return select("position", "Konum", [
    ["top-left", "Sol üst"], ["top-center", "Üst orta"], ["top-right", "Sağ üst"],
    ["middle-left", "Sol orta"], ["middle-center", "Tam orta"], ["middle-right", "Sağ orta"],
    ["bottom-left", "Sol alt"], ["bottom-center", "Alt orta"], ["bottom-right", "Sağ alt"],
  ], value);
}
const size = () => number("size", "Yazı boyutu (pt)", 12, 5, 160);
const imageSize = () => number("image-size", "Görsel genişliği (%)", 28, 5, 80);
const fields = (...items) => `<div class="fields">${items.join("")}</div>`;
const options = {
  numara: fields(pos("bottom-center"), size(),
    number("start", "İlk numara", 1, 0, 99999),
    select("font", "Yazı tipi", [["sans", "Düz"], ["serif", "Tırnaklı"], ["mono", "Eş aralıklı"]]),
    select("format", "Biçim", [["single", "1"], ["total", "1 / toplam"]])) + range,
  kirp: fields(number("left", "Sol (%)", 0, 0, 90), number("right", "Sağ (%)", 0, 0, 90),
    number("top", "Üst (%)", 0, 0, 90), number("bottom", "Alt (%)", 0, 0, 90)) + range +
    '<p class="muted">Gölgeli kenarlar görünümden kırpılır. Kırpma, gizli içeriği kalıcı olarak silmez.</p>',
  filigran: select("mark-type", "Filigran", [["text", "Metin"], ["image", "Görsel"]]) +
    '<div id="text-options"><label>Metin<input id="mark-text" maxlength="120" value="ÖRNEK"></label>' + size() + '</div>' +
    '<div id="image-options" hidden><label>JPG veya PNG<input id="mark-file" type="file" accept="image/jpeg,image/png"></label>' + imageSize() + '</div>' +
    fields(pos("middle-center"), number("opacity", "Şeffaflık (%)", 30, 1, 100)) + range,
  imza: '<label>İmzanı çiz</label><canvas id="screen-signature" width="700" height="230" aria-label="İmza çizim alanı"></canvas>' +
    '<label>İmza görseli (isteğe bağlı)<input id="signature-file" type="file" accept="image/png,image/jpeg"></label>' +
    '<button id="erase" type="button">Temizle</button>' +
    fields(number("sign-page", "Sayfa", 1, 1, 250), pos("bottom-right"), imageSize()) +
    '<p class="muted">Belgeye imza görseli eklenir. Sertifikalı elektronik imza oluşturulmaz.</p>',
  ayir: select("split-mode", "Çıktı", [["ranges", "Aralık başına PDF"], ["individual", "Sayfa başına PDF"]]) +
    '<label id="group-setting">Aralıklar<input id="groups" value="1" maxlength="2000" placeholder="Örn. 1–3; 5; 7–9"></label>' +
    '<div id="individual-setting" hidden>' + range + '</div><p class="muted">Birden fazla çıktı ZIP olarak indirilir.</p>',
  kucult: select("compress-mode", "Yöntem", [["lossless", "İçeriği koru"], ["raster", "Sayfaları görsel olarak sıkıştır"]]) +
    '<div id="raster-options" hidden>' + fields(number("resolution", "Çözünürlük (DPI)", 144, 72, 200), number("quality", "Görsel kalitesi (%)", 76, 35, 95)) +
    '<p class="muted">Görsel yöntemde metin seçimi, bağlantılar ve form alanları kaybolur.</p></div>',
  ocr: range + '<p class="muted">Metin katmanı bulunan sayfalar korunur. Tarama netliği, tanıma sonucunu etkiler.</p>',
  form: '<div id="existing-fields"></div><div id="new-fields"></div><button id="add-field" type="button">Alan ekle</button>' +
    '<p class="muted">Yeni alanlar form sayfalarına eklenir. Boş bir form için dosya seçmeden başla.</p>',
};
$("options").innerHTML = options[mode];
let bytes, previewReader, current = 1, sourceName = "", bindings = [], sequence = 0;
let busy = false, previewTask, job;
const status = value => { $("status").textContent = value; };

function revise() {
  $("run").disabled = busy || (!bytes && mode !== "form");
  $("file").disabled = busy;
  $("options").inert = busy;
  $("cancel").hidden = !job;
  $("previous").disabled = busy || current <= 1;
  $("next").disabled = busy || current >= (previewReader?.numPages ?? 0);
}

if (mode === "form") {
  $("file-label").textContent = "Doldurulacak PDF (isteğe bağlı)";
  $("add-field").addEventListener("click", addFormField);
}
if (mode === "filigran") {
  $("mark-type").addEventListener("change", () => {
    const image = $("mark-type").value === "image";
    $("text-options").hidden = image;
    $("image-options").hidden = !image;
    $("size").disabled = image;
    $("image-size").disabled = !image;
  });
  $("image-size").disabled = true;
}
if (mode === "kucult") {
  $("resolution").disabled = $("quality").disabled = true;
  $("compress-mode").addEventListener("change", () => {
    const raster = $("compress-mode").value === "raster";
    $("raster-options").hidden = !raster;
    $("resolution").disabled = $("quality").disabled = !raster;
  });
}
if (mode === "ayir") $("split-mode").addEventListener("change", () => {
  const individual = $("split-mode").value === "individual";
  $("group-setting").hidden = individual;
  $("individual-setting").hidden = !individual;
});
if (mode === "imza") {
  const pad = $("screen-signature"), ctx = pad.getContext("2d");
  ctx.strokeStyle = "#202126"; ctx.fillStyle = "#202126";
  ctx.lineWidth = 4; ctx.lineCap = ctx.lineJoin = "round";
  const point = event => {
    const box = pad.getBoundingClientRect();
    return [(event.clientX - box.left) * pad.width / box.width, (event.clientY - box.top) * pad.height / box.height];
  };
  let pen;
  pad.addEventListener("pointerdown", event => {
    if (pen !== undefined || event.button !== 0) return;
    pen = event.pointerId;
    pad.setPointerCapture(pen);
    const [x,y] = point(event);
    ctx.beginPath(); ctx.arc(x,y,2,0,Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x,y);
  });
  pad.addEventListener("pointermove", event => {
    if (pen !== event.pointerId) return;
    const p = point(event);
    ctx.lineTo(...p); ctx.stroke(); ctx.beginPath(); ctx.moveTo(...p);
  });
  pad.addEventListener("lostpointercapture", () => { pen = undefined; });
  $("erase").addEventListener("click", () => { ctx.clearRect(0, 0, pad.width, pad.height); $("signature-file").value = ""; });
}

async function preview() {
  if (!previewReader) return;
  previewTask?.abort();
  const task = new AbortController();
  previewTask = task;
  $("page-label").textContent = current + " / " + previewReader.numPages;
  revise();
  try {
    const { canvas } = await renderPage(previewReader, current, 700, undefined, task);
    if (task.signal.aborted) return;
    const target = $("preview");
    target.width = canvas.width; target.height = canvas.height;
    const ctx = target.getContext("2d", { alpha: false });
    ctx.drawImage(canvas, 0, 0);
    if (mode === "kirp") {
      const [left, bottom, right, top] = cropEdges();
      if ([left, bottom, right, top].every(Number.isFinite)) {
        const w = canvas.width, h = canvas.height;
        ctx.fillStyle = "#1f202277";
        ctx.fillRect(0, 0, w, h * top);
        ctx.fillRect(0, h * (1 - bottom), w, h * bottom);
        ctx.fillRect(0, h * top, w * left, h * (1 - top - bottom));
        ctx.fillRect(w * (1 - right), h * top, w * right, h * (1 - top - bottom));
      }
    }
    canvas.width = canvas.height = 0;
    $("document-preview").hidden = false;
  } catch { if (!task.signal.aborted) $("document-preview").hidden = true; }
}
for (const [id, step] of [["previous", -1], ["next", 1]]) $(id).addEventListener("click", () => {
  current += step;
  if (mode === "imza") $("sign-page").value = current;
  preview();
});
if (mode === "kirp") $("options").addEventListener("change", preview);

$("file").addEventListener("change", async () => {
  const serial = ++sequence;
  previewTask?.abort();
  await previewReader?.destroy().catch(() => {});
  if (serial !== sequence) return;
  bytes = undefined; previewReader = undefined; bindings = [];
  if (mode === "form") bindExisting(null);
  $("document-preview").hidden = true;
  $("file-info").textContent = "";
  status("");
  revise();
  const file = $("file").files[0];
  if (!file) return;
  try {
    if (!file.size || file.size > 100 * 1024 ** 2) throw new Error("100 MB’tan küçük bir PDF seç.");
    status("PDF açılıyor…");
    const data = await file.arrayBuffer();
    const doc = await window.PDFLib.PDFDocument.load(data);
    const total = doc.getPageCount();
    if (!total || total > 250) throw new Error("En fazla 250 sayfalık bir PDF seç.");
    const reader = await openReader(data);
    if (serial !== sequence) { await reader.destroy(); return; }
    bytes = data; previewReader = reader; current = 1;
    sourceName = file.name.replace(/\.pdf$/i, "") || "belge";
    if (mode === "form") bindings = bindExisting(doc);
    if (mode === "imza") { $("sign-page").max = total; $("sign-page").value = 1; }
    $("file-info").textContent = total + " sayfa · " + new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(file.size / 1024) + " KB";
    status("");
    revise();
    await preview();
  } catch (error) {
    if (serial !== sequence) return;
    status(error.message || "PDF açılamadı.");
    revise();
  }
});

$("settings").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || (!bytes && mode !== "form")) return;
  busy = true; job = new AbortController();
  revise(); status("PDF hazırlanıyor…");
  try {
    const doc = bytes ? await window.PDFLib.PDFDocument.load(bytes) : null;
    const operation = mode === "form" ? writeForm : operations[mode];
    status(await operation({ doc, bytes, reader: previewReader, base: sourceName, job, status, bindings }));
  } catch (error) { status(job.signal.aborted ? "İşlem iptal edildi." : error.message || "PDF hazırlanamadı."); }
  finally { busy = false; job = undefined; revise(); }
});
$("cancel").addEventListener("click", () => job?.abort());
revise();
