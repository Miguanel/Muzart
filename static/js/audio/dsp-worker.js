// Web Worker: ciężkie przetwarzanie audio poza wątkiem UI (odpowiednik Dispatchers.Default).
import { runJob } from "./dsp-jobs.js";

self.onmessage = (e) => {
  const { id, op, args } = e.data;
  try {
    const result = runJob(op, args);
    const transfer = [];
    for (const v of Object.values(result || {})) if (v && v.buffer instanceof ArrayBuffer) transfer.push(v.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
