// File di sincronizzazione scelto dall'utente (File System Access API).
// Il "puntatore" al file resta salvato nel browser (IndexedDB); Chrome può
// chiedere di riconfermare il permesso dopo un riavvio.
const FileLink = (() => {
  const DB = "rdq", STORE = "handles", KEY = "syncfile";
  const supported = typeof window !== "undefined" && "showSaveFilePicker" in window;
  const TYPES = [{ description: "Dati Riprendi da qui", accept: { "application/json": [".json"] } }];

  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };

  const get = () => run("readonly", (s) => s.get(KEY));
  const set = (h) => run("readwrite", (s) => s.put(h, KEY));
  const clear = () => run("readwrite", (s) => s.delete(KEY));

  async function permission(handle, ask) {
    const opts = { mode: "readwrite" };
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return ask ? (await handle.requestPermission(opts)) === "granted" : false;
  }
  const read = async (h) => (await h.getFile()).text();
  async function write(h, text) {
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
  }
  const pickNew = () => window.showSaveFilePicker({ suggestedName: "riprendi-da-qui.json", types: TYPES });
  const pickExisting = async () => (await window.showOpenFilePicker({ types: TYPES, multiple: false }))[0];

  return { supported, get, set, clear, permission, read, write, pickNew, pickExisting };
})();
