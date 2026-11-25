// Resimlerden PDF yapar (kütüphanesiz).
// Sayfa türleri: { kind: "jpeg", bytes, w, h } ya da { kind: "bits", bytes (deflate ile sıkışmış 1-bit), w, h }
// Eski kullanım için { blob: JPEG, w, h } de kabul edilir.

export async function makePdf(pages, onProgress) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const add = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const begin = (n) => { offsets[n] = len; add(`${n} 0 obj\n`); };

  add("%PDF-1.4\n%âãÏÓ\n");
  const n = pages.length;
  const kids = Array.from({ length: n }, (_, i) => `${3 + i * 3} 0 R`).join(" ");
  begin(1); add("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2); add(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    let pg = pages[i];
    if (typeof pg === "function") pg = await pg();
    const { w, h } = pg;
    const bytes = pg.bytes || new Uint8Array(await pg.blob.arrayBuffer());
    const kind = pg.kind || "jpeg";
    const land = w > h;
    const Pw = land ? 841.89 : 595.28;
    const Ph = +(Pw * h / w).toFixed(2);
    const po = 3 + i * 3, co = po + 1, io = po + 2;
    begin(po);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Pw} ${Ph}] /Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);
    const content = `q ${Pw} 0 0 ${Ph} 0 0 cm /Im0 Do Q`;
    begin(co); add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(io);
    if (kind === "bits") {
      add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${bytes.length} >>\nstream\n`);
    } else {
      add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    }
    add(bytes);
    add("\nendstream\nendobj\n");
    onProgress?.((i + 1) / n);
  }
  const total = 3 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  add(x);
  add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}

/** Siyah-beyaz bir tuvali 1-bit'e paketleyip deflate ile sıkıştırır */
export async function packBits(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const rowBytes = (w + 7) >> 3;
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const ro = y * rowBytes, po = y * w * 4;
    for (let x = 0; x < w; x++) {
      // 1 = beyaz, 0 = siyah (DeviceGray)
      if (d[po + x * 4] >= 128) out[ro + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const cs = new Blob([out]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}
