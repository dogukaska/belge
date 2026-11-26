import * as pdfjs from "/pdf-epub/vendor/pdfjs/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf-epub/vendor/pdfjs/pdf.worker.min.mjs";

export function openReader(bytes) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    isEvalSupported: false,
    cMapUrl: "/pdf-epub/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf-epub/vendor/pdfjs/standard_fonts/",
  }).promise;
}

export async function hasReadableText(page) {
  const { items } = await page.getTextContent();
  const text = items.map(item => item.str ?? "").join(" ").trim();
  const letters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (letters >= 28 && letters >= text.length / 4) return true;
  if (!letters) return false;
  const { paintImageXObject, paintInlineImageXObject, paintImageMaskXObject } = pdfjs.OPS;
  const { fnArray } = await page.getOperatorList();
  return !fnArray.some(code => [paintImageXObject, paintInlineImageXObject, paintImageMaskXObject].includes(code));
}

export const makeCanvas = () => document.createElement("canvas");

export async function renderPage(reader, pageNumber, limit, canvas = makeCanvas(), job) {
  job?.signal.throwIfAborted();
  const page = await reader.getPage(pageNumber);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(4, limit / Math.max(original.width, original.height)) });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
  const cancel = () => task.cancel();
  job?.signal.addEventListener("abort", cancel, { once: true });
  try { await task.promise; }
  finally {
    job?.signal.removeEventListener("abort", cancel);
    page.cleanup();
  }
  return { canvas, viewport, original };
}

export function geometry(page) {
  const { x, y, width: w, height: h } = page.getCropBox();
  const angle = (page.getRotation().angle % 360 + 360) % 360;
  const transposed = angle === 90 || angle === 270;
  const point = (horizontal, vertical) => {
    if (angle === 90) return { x: x + w - vertical, y: y + horizontal };
    if (angle === 180) return { x: x + w - horizontal, y: y + h - vertical };
    if (angle === 270) return { x: x + vertical, y: y + h - horizontal };
    return { x: x + horizontal, y: y + vertical };
  };
  return { width: transposed ? h : w, height: transposed ? w : h, angle, point };
}

export function selectedPages(input, total) {
  const spec = input.trim();
  if (!spec) return Array.from({ length: total }, (_, i) => i);
  const pages = new Set();
  for (const part of spec.split(",")) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? start);
    if (!match || start < 1 || end < start || end > total) throw new Error("Sayfa aralığını kontrol et. Örnek: 1–3, 5.");
    for (let n = start; n <= end; n++) pages.add(n - 1);
  }
  return [...pages];
}

export function blobFromCanvas(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error("Görüntü hazırlanamadı.")), type, quality,
  ));
}

export function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Yardımcı kütüphane yüklenemedi."));
    document.head.append(script);
  });
}

let fontKitReady;
const fontFiles = { sans: "DejaVuSans", serif: "DejaVuSerif", mono: "DejaVuSansMono" };
const fonts = new Map();
export async function unicodeFont(doc, subset = true, family = "sans") {
  fontKitReady ??= loadScript("../vendor/fontkit.min.js?v=1.1.1").catch(error => {
    fontKitReady = undefined;
    throw error;
  });
  if (!fonts.has(family)) {
    fonts.set(family, fetch("../vendor/" + fontFiles[family] + "-Latin.ttf").then(r => {
      if (!r.ok) throw new Error("Türkçe yazı tipi yüklenemedi.");
      return r.arrayBuffer();
    }).catch(error => { fonts.delete(family); throw error; }));
  }
  const [, bytes] = await Promise.all([fontKitReady, fonts.get(family)]);
  doc.registerFontkit(window.fontkit);
  return doc.embedFont(bytes, { subset });
}

export function position(bounds, w, h, code) {
  const edge = Math.min(28, bounds.width * .06, bounds.height * .06);
  const [v, x] = code.split("-");
  return [
    x === "left" ? edge : x === "right" ? bounds.width - w - edge : (bounds.width - w) / 2,
    v === "top" ? bounds.height - h - edge : v === "middle" ? (bounds.height - h) / 2 : edge,
  ];
}

export async function readImage(file) {
  if (!file || !["image/jpeg", "image/png"].includes(file.type) || file.size > 12 * 1024 ** 2) {
    throw new Error("12 MB’tan küçük bir JPG veya PNG seç.");
  }
  return { bytes: await file.arrayBuffer(), jpg: file.type === "image/jpeg" };
}
