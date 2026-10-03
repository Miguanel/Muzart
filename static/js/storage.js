// Trwały zapis na urządzeniu (IndexedDB) — odpowiednik SharedPreferences i filesDir z Androida.
// Typed arrays (nagrania PCM) zapisywane są natywnie bez konwersji do JSON.

const DB_NAME = "muzart";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn("IndexedDB blocked");
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const kv = {
  get: (key) => tx("kv", "readonly", (s) => s.get(key)),
  set: (key, value) => tx("kv", "readwrite", (s) => { s.put(value, key); }),
  del: (key) => tx("kv", "readwrite", (s) => { s.delete(key); }),
};

export const projects = {
  list: () => tx("projects", "readonly", (s) => s.getAllKeys()),
  get: (name) => tx("projects", "readonly", (s) => s.get(name)),
  put: (name, blob) => tx("projects", "readwrite", (s) => { s.put({ name, blob, savedAt: Date.now() }); }),
  del: (name) => tx("projects", "readwrite", (s) => { s.delete(name); }),
};

export const prefs = {
  get(key, def = null) {
    try { const v = localStorage.getItem("muzart_" + key); return v == null ? def : JSON.parse(v); }
    catch (_) { return def; }
  },
  set(key, value) {
    try { localStorage.setItem("muzart_" + key, JSON.stringify(value)); } catch (_) { /* ignore */ }
  },
};

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist();
    return await navigator.storage?.persisted?.();
  } catch (_) { return false; }
}

export async function storageEstimate() {
  try { return await navigator.storage?.estimate?.(); } catch (_) { return null; }
}
