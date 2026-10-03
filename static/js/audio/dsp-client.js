// Klient Workera DSP z automatycznym trybem awaryjnym w wątku głównym.
import { runJob } from "./dsp-jobs.js";

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker === false) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./dsp-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      console.warn("DSP worker error, falling back to main thread", e);
      worker = false;
      for (const [, p] of pending) p.fallback();
      pending.clear();
    };
  } catch (e) {
    worker = false;
    return null;
  }
  return worker;
}

export function dsp(op, args) {
  const w = getWorker();
  if (!w) return Promise.resolve().then(() => runJob(op, args));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {
      resolve, reject,
      fallback: () => { try { resolve(runJob(op, args)); } catch (e) { reject(e); } },
    });
    w.postMessage({ id, op, args });
  });
}
