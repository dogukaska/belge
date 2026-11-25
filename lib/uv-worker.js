// Sayfa düzleştirme (UVDoc, MIT): kıvrık/eğik sayfanın düzleştirme ızgarasını tahmin eder.
import * as ort from "../vendor/ort/ort.wasm.bundle.min.mjs";

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = "error";

const MODEL = new URL("../model/uvdoc.onnx?v=1", import.meta.url).href;
const CACHE = "belge-uvdoc-v1";
let session = null;

async function modelBytes() {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) {}
  let res = cache ? await cache.match(MODEL) : null;
  if (!res) {
    res = await fetch(MODEL);
    if (!res.ok) throw new Error("Düzleştirme modeli indirilemedi");
    if (cache) await cache.put(MODEL, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function getSession() {
  if (!session) session = ort.InferenceSession.create(await modelBytes(), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return session;
}

self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    const s = await getSession();
    if (op === "ping") return postMessage({ id, ok: true, result: true });
    // girdi: 488×712 RGBA → 1×3×712×488, 0–1
    const { data, width: W, height: H } = e.data.img;
    const N = W * H, x = new Float32Array(3 * N);
    for (let i = 0, j = 0; j < N; i += 4, j++) { x[j] = data[i] / 255; x[j + N] = data[i + 1] / 255; x[j + 2 * N] = data[i + 2] / 255; }
    const out = await s.run({ input: new ort.Tensor("float32", x, [1, 3, H, W]) }, ["output"]);
    const grid = out.output.data; // [1, 2, 45, 31], −1…1
    postMessage({ id, ok: true, result: grid }, [grid.buffer]);
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
