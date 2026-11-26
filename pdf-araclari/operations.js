import { blobFromCanvas, geometry, hasReadableText, loadScript, openReader, position, readImage, renderPage, selectedPages, unicodeFont } from "./pdf.js";
import { download } from "/gunluk/common.js?v=1";

const $ = id => document.getElementById(id);
const lib = () => window.PDFLib;
const pdfBlob = bytes => new Blob([bytes], { type: "application/pdf" });
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const number = id => $(id).valueAsNumber;
const text = id => $(id).value.trim();
const angleOf = bounds => lib().degrees(bounds.angle);
let ocrReady, zipReady;

function pagesIn(doc) {
  return selectedPages($("range")?.value ?? "", doc.getPageCount());
}

function drawMark(page, { image, font, label, size, location, opacity }) {
  const bounds = geometry(page);
  const maxWidth = bounds.width * .86, maxHeight = bounds.height * .78;
  if (image) {
    const width = Math.min(maxWidth, bounds.width * size / 100, maxHeight * image.width / image.height);
    const height = width * image.height / image.width;
    const [x, y] = position(bounds, width, height, location);
    page.drawImage(image, { ...bounds.point(x, y), width, height, rotate: angleOf(bounds), opacity });
    return;
  }
  const measure = font.widthOfTextAtSize(label, 1);
  size = Math.min(size, maxWidth / Math.max(measure, 1), maxHeight);
  const width = measure * size;
  const [x, y] = position(bounds, width, size, location);
  page.drawText(label, { ...bounds.point(x, y), font, size, rotate: angleOf(bounds), opacity, color: lib().rgb(.14, .15, .17) });
}

async function output(doc, base, suffix, job) {
  job.signal.throwIfAborted();
  const bytes = await doc.save({ updateFieldAppearances: false });
  job.signal.throwIfAborted();
  download(pdfBlob(bytes), base + "-" + suffix + ".pdf");
  return "PDF indirilmeye hazır.";
}

async function numbered({ doc, base, job }) {
  const style = { sans: lib().StandardFonts.Helvetica, serif: lib().StandardFonts.TimesRoman, mono: lib().StandardFonts.Courier };
  const font = await doc.embedFont(style[$("font").value]);
  const scope = pagesIn(doc);
  const start = number("start");
  for (const [i, index] of scope.entries()) {
    const label = text("format") === "total" ? (start + i) + " / " + (start + scope.length - 1) : String(start + i);
    drawMark(doc.getPage(index), { font, label, size: number("size"), location: $("position").value, opacity: 1 });
  }
  return output(doc, base, "numarali", job);
}

export function cropEdges() {
  return ["left", "bottom", "right", "top"].map(id => number(id) / 100);
}

async function cropped({ doc, base, job }) {
  const edges = cropEdges();
  if (edges[0] + edges[2] >= .95 || edges[1] + edges[3] >= .95) throw new Error("Karşılıklı kenarları azalt. Sayfada en az %5 alan kalmalı.");
  for (const index of pagesIn(doc)) {
    const page = doc.getPage(index);
    const { point, width, height } = geometry(page);
    const a = point(width * edges[0], height * edges[1]);
    const b = point(width * (1 - edges[2]), height * (1 - edges[3]));
    page.setCropBox(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return output(doc, base, "kirpilmis", job);
}

async function watermarked({ doc, base, job }) {
  const opacity = number("opacity") / 100;
  const location = $("position").value;
  if ($("mark-type").value === "image") {
    const { bytes, jpg } = await readImage($("mark-file").files[0]);
    const image = await (jpg ? doc.embedJpg(bytes) : doc.embedPng(bytes));
    for (const index of pagesIn(doc)) drawMark(doc.getPage(index), { image, size: number("image-size"), location, opacity });
  } else {
    const label = text("mark-text");
    if (!label) throw new Error("Filigran metnini gir.");
    const font = await unicodeFont(doc);
    if ([...label].some(char => !font.getCharacterSet().includes(char.codePointAt(0)))) throw new Error("Filigranda yazı tipinin desteklemediği karakter var.");
    for (const index of pagesIn(doc)) drawMark(doc.getPage(index), { label, font, size: number("size"), location, opacity });
  }
  return output(doc, base, "filigranli", job);
}

async function signed({ doc, base, job }) {
  const uploaded = $("signature-file").files[0];
  if (uploaded) {
    const { bytes, jpg } = await readImage(uploaded);
    const image = await (jpg ? doc.embedJpg(bytes) : doc.embedPng(bytes));
    const position = number("sign-page") - 1;
    if (position < 0 || position >= doc.getPageCount()) throw new Error("İmzanın ekleneceği sayfayı kontrol et.");
    drawMark(doc.getPage(position), { image, size: number("image-size"), location: $("position").value, opacity: 1 });
    return output(doc, base, "imzali", job);
  }
  const pad = $("screen-signature");
  const w = pad.width, h = pad.height;
  const pixels = pad.getContext("2d").getImageData(0, 0, w, h).data;
  let left = w, right = -1, top = h, bottom = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!pixels[(y * w + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) throw new Error("Önce imzanı çiz.");
  const stamp = document.createElement("canvas");
  stamp.width = right - left + 1; stamp.height = bottom - top + 1;
  stamp.getContext("2d").drawImage(pad, left, top, stamp.width, stamp.height, 0, 0, stamp.width, stamp.height);
  const image = await doc.embedPng(await (await blobFromCanvas(stamp)).arrayBuffer());
  stamp.width = stamp.height = 0;
  const index = number("sign-page") - 1;
  if (index < 0 || index >= doc.getPageCount()) throw new Error("İmzanın ekleneceği sayfayı kontrol et.");
  drawMark(doc.getPage(index), { image, size: number("image-size"), location: $("position").value, opacity: 1 });
  return output(doc, base, "imzali", job);
}

async function split({ doc, base, job, status }) {
  const total = doc.getPageCount();
  const groups = $("split-mode").value === "individual"
    ? pagesIn(doc).map(index => [index])
    : text("groups").split(";").map(group => {
      if (!group.trim()) throw new Error("En az bir sayfa aralığı gir.");
      return selectedPages(group, total);
    });
  if (groups.length > 250) throw new Error("Bir seferde en fazla 250 çıktı oluştur.");
  const name = (i) => base + (groups[i].length === 1 ? "-sayfa-" + (groups[i][0] + 1) : "-bolum-" + (i + 1)) + ".pdf";
  let zip;
  if (groups.length > 1) {
    zipReady ??= loadScript("../vendor/jszip.min.js").catch(error => { zipReady = undefined; throw error; });
    await zipReady;
    zip = new window.JSZip();
  }
  for (const [i, indices] of groups.entries()) {
    job.signal.throwIfAborted();
    status((i + 1) + " / " + groups.length + " dosya hazırlanıyor…");
    const part = await lib().PDFDocument.create();
    for (const page of await part.copyPages(doc, indices)) part.addPage(page);
    const bytes = await part.save();
    if (zip) zip.file((i + 1) + "-" + name(i), bytes);
    else download(pdfBlob(bytes), name(i));
  }
  if (zip) {
    const archive = await zip.generateAsync({ type: "blob" });
    job.signal.throwIfAborted();
    download(archive, base + "-ayrilmis.zip");
  }
  return groups.length + " PDF hazır.";
}

async function compress({ bytes, doc, base, job, status, reader }) {
  let result;
  if ($("compress-mode").value === "lossless") {
    result = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  } else {
    const dpi = number("resolution");
    const quality = number("quality") / 100;
    const out = await lib().PDFDocument.create();
    const canvas = document.createElement("canvas");
    try {
      for (let n = 1; n <= reader.numPages; n++) {
        status(n + " / " + reader.numPages + " sayfa sıkıştırılıyor…");
        const bounds = geometry(doc.getPage(n - 1));
        await renderPage(reader, n, Math.min(2400, Math.max(bounds.width, bounds.height) * dpi / 72), canvas, job);
        job.signal.throwIfAborted();
        const jpg = await out.embedJpg(await (await blobFromCanvas(canvas, "image/jpeg", quality)).arrayBuffer());
        out.addPage([bounds.width, bounds.height]).drawImage(jpg, { x: 0, y: 0, width: bounds.width, height: bounds.height });
      }
      result = await out.save();
    } finally { canvas.width = canvas.height = 0; }
  }
  job.signal.throwIfAborted();
  if (result.byteLength >= bytes.byteLength) return "Dosya zaten daha küçük. Orijinal dosya korundu.";
  download(pdfBlob(result), base + "-kucultulmus.pdf");
  return "Boyut %" + Math.floor(100 * (1 - result.byteLength / bytes.byteLength)) + " azaldı.";
}

async function searchable({ doc, reader, base, job, status }) {
  let pool;
  const canvas = document.createElement("canvas");
  const charMap = new Set();
  let font, recognized = 0, empty = 0, skipped = 0;
  let rejectRecognition;
  const cancellation = new Promise((_, reject) => { rejectRecognition = reject; });
  cancellation.catch(() => {});
  const abort = () => rejectRecognition(job.signal.reason);
  job.signal.addEventListener("abort", abort, { once: true });
  try {
    for (const index of pagesIn(doc)) {
      job.signal.throwIfAborted();
      const source = await reader.getPage(index + 1);
      if (await hasReadableText(source)) { skipped++; source.cleanup(); continue; }
      if (!pool) {
        ocrReady ??= Promise.all([
          loadScript("/pdf-epub/vendor/tesseract/tesseract.min.js"),
          import("/pdf-epub/lib/ocr.js"),
        ]).catch(error => { ocrReady = undefined; throw error; });
        const [, module] = await ocrReady;
        pool = await module.createOcrPool(1, status);
        job.signal.throwIfAborted();
        font = await unicodeFont(doc);
        for (const char of font.getCharacterSet()) charMap.add(char);
      }
      status("Sayfa " + (index + 1) + " / " + reader.numPages + " Türkçe okunuyor…");
      const { viewport } = await renderPage(reader, index + 1, 2400, canvas, job);
      const lines = await Promise.race([pool.recognize(canvas), cancellation]);
      job.signal.throwIfAborted();
      const page = doc.getPage(index);
      const bounds = geometry(page);
      let any = false;
      for (const line of lines) {
        const value = [...line.text.normalize("NFC")].filter(ch => charMap.has(ch.codePointAt(0))).join("").trim();
        if (!value) continue;
        const [x, y] = viewport.convertToPdfPoint(line.x0, line.y1);
        const width = (line.x1 - line.x0) / viewport.scale;
        const height = (line.y1 - line.y0) / viewport.scale;
        const size = clamp(Math.min(height, width / font.widthOfTextAtSize(value, 1)), 1, 72);
        page.drawText(value, { x, y, font, size, rotate: angleOf(bounds), opacity: 0 });
        any = true;
      }
      if (any) recognized++;
      else empty++;
    }
  } finally {
    job.signal.removeEventListener("abort", abort);
    canvas.width = canvas.height = 0;
    await pool?.terminate().catch(() => {});
  }
  if (!recognized) return skipped && !empty ? "Seçilen sayfalarda zaten metin var." : "Eklenecek okunabilir metin bulunamadı.";
  await output(doc, base, "aranabilir", job);
  return [recognized + " sayfaya metin eklendi.", skipped ? skipped + " sayfanın mevcut metni korundu." : "", empty ? empty + " sayfada metin bulunamadı." : ""].filter(Boolean).join(" ");
}

export const operations = { numara: numbered, kirp: cropped, filigran: watermarked, imza: signed, ayir: split, kucult: compress, ocr: searchable };
