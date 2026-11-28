import { blobFromCanvas, loadScript, openReader, renderPage, selectedPages } from "../pdf-araclari/pdf.js?v=3";

const get = id => document.getElementById(id);
const file = get("file");
const status = get("status");
const fileInfo = get("file-info");
const download = get("download");
const mebibyte = 1024 ** 2;
const maxPdfBytes = 100 * mebibyte;
const maxArchiveBytes = 96 * mebibyte;
let reader, controller, outputUrl, zipReady, sourceName;
let opening = false;

function updateControls() {
  const busy = opening || !!controller;
  file.disabled = busy;
  get("options").disabled = busy;
  get("run").disabled = busy || !reader;
  get("cancel").hidden = !controller;
}

function clearOutput() {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
  download.hidden = true;
  download.removeAttribute("href");
  download.removeAttribute("download");
}

function offerDownload(blob, name, label) {
  outputUrl = URL.createObjectURL(blob);
  download.href = outputUrl;
  download.download = name;
  download.textContent = label;
  download.hidden = false;
}

file.addEventListener("change", async () => {
  if (opening || controller) return;
  const chosen = file.files[0];
  opening = true;
  updateControls();
  clearOutput();
  fileInfo.hidden = true;
  get("range").value = "";
  get("range").placeholder = "1–3, 5";
  status.textContent = "";
  const previous = reader;
  reader = undefined;
  try {
    await previous?.destroy().catch(() => {});
    if (!chosen) return;
    if (!chosen.size || chosen.size > maxPdfBytes) {
      status.textContent = "100 MB veya daha küçük bir PDF seç.";
      return;
    }
    status.textContent = "PDF açılıyor…";
    reader = await openReader(await chosen.arrayBuffer(), { transfer: true });
    sourceName = chosen.name.replace(/\.pdf$/i, "").replace(/[\x00-\x1f\x7f/\\<>:*?"|]/g, "-")
      .slice(0, 120).trim().replace(/[. ]+$/, "") || "belge";
    fileInfo.textContent = `${reader.numPages} sayfa`;
    fileInfo.hidden = false;
    status.textContent = "";
  } catch (error) {
    status.textContent = error?.name === "PasswordException"
      ? "Bu PDF parola korumalı. Parolası kaldırılmış bir kopya seç."
      : "PDF açılamadı. Geçerli bir PDF dosyası seç.";
  } finally {
    opening = false;
    updateControls();
  }
});

get("options").addEventListener("input", () => {
  clearOutput();
  if (reader) status.textContent = "";
});

async function makeZip() {
  zipReady ??= loadScript("../vendor/jszip.min.js").catch(error => { zipReady = undefined; throw error; });
  await zipReady;
  return new window.JSZip();
}

get("settings").addEventListener("submit", async event => {
  event.preventDefault();
  if (opening || controller || !reader) return;
  clearOutput();
  const job = new AbortController();
  controller = job;
  updateControls();
  const canvas = document.createElement("canvas");
  try {
    const pages = selectedPages(get("range").value, reader.numPages).map(index => index + 1);
    const extension = get("format").value;
    const mime = extension === "jpg" ? "image/jpeg" : "image/png";
    const longEdge = Number(get("size").value);
    const archive = pages.length > 1 ? await makeZip() : null;
    let totalBytes = 0;
    for (const [index, page] of pages.entries()) {
      job.signal.throwIfAborted();
      status.textContent = `${index + 1} / ${pages.length} sayfa hazırlanıyor…`;
      await renderPage(reader, page, longEdge, canvas, job);
      job.signal.throwIfAborted();
      const image = await blobFromCanvas(canvas, mime, .9);
      canvas.width = canvas.height = 0;
      job.signal.throwIfAborted();
      if (image.type !== mime) throw new Error("Bu tarayıcı seçtiğin görsel biçimini oluşturamadı.");
      const name = `${sourceName}-sayfa-${page}.${extension}`;
      if (archive) {
        totalBytes += image.size;
        if (totalBytes > maxArchiveBytes) throw new Error("ZIP için daha az sayfa veya daha düşük çözünürlük seç.");
        archive.file(name, image);
      } else {
        offerDownload(image, name, `${extension.toUpperCase()} indir`);
      }
    }
    if (archive) {
      status.textContent = "ZIP hazırlanıyor…";
      const zipped = await archive.generateAsync({ type: "blob", streamFiles: true });
      job.signal.throwIfAborted();
      offerDownload(zipped, sourceName + "-gorseller.zip", "ZIP indir");
    }
    status.textContent = pages.length === 1 ? "Görsel hazır." : `${pages.length} görsel hazır.`;
  } catch (error) {
    status.textContent = job.signal.aborted ? "İşlem iptal edildi." : error?.message || "Görseller hazırlanamadı.";
  } finally {
    canvas.width = canvas.height = 0;
    controller = undefined;
    updateControls();
  }
});

get("cancel").addEventListener("click", () => {
  if (!controller) return;
  controller.abort();
  status.textContent = "İptal ediliyor…";
});
