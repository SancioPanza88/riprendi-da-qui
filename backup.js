// Backup su file, condiviso da service worker e dashboard.
//  • Con una cartella scelta (consigliata: quella dell'estensione) il file viene scritto lì dentro.
//  • Senza cartella finisce direttamente in Download, senza creare sottocartelle.
// Chrome non permette a un'estensione di scrivere da sola nella propria cartella:
// la si sceglie una volta sola e il "puntatore" resta salvato nel browser (IndexedDB).
const Backup = (() => {
  const FILE = "riprendi-da-qui-backup.json";
  const DB = "rdq", STORE = "handles", KEY = "backupdir";
  const pickable = typeof window !== "undefined" && "showDirectoryPicker" in window;

  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  const getFolder = () => tx("readonly", (s) => s.get(KEY));
  const setFolder = (h) => tx("readwrite", (s) => s.put(h, KEY));
  const clearFolder = () => tx("readwrite", (s) => s.delete(KEY));
  const pickFolder = () => window.showDirectoryPicker({ id: "rdq-backup", mode: "readwrite" });

  async function permission(h, ask) {
    const o = { mode: "readwrite" };
    if ((await h.queryPermission(o)) === "granted") return true;
    return ask ? (await h.requestPermission(o)) === "granted" : false;
  }
  async function writeFile(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async function readFile(dir, name) {
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }
  // La cartella scelta è quella dell'estensione? (contiene il suo manifest.json)
  async function looksLikeExtension(dir) {
    try {
      const m = JSON.parse(await readFile(dir, "manifest.json"));
      return /riprendi da qui/i.test(m.name || "");
    } catch (e) { return false; }
  }

  async function run(force) {
    const d = await chrome.storage.local.get(["library", "progress", "settings", "lastBackupSig", "lastBackupTarget"]);
    if (!force && d.settings && d.settings.autoBackup === false) return { ok: false, skipped: true };
    const library = d.library || {};
    const progress = d.progress || {};
    if (!Object.keys(library).length && !Object.keys(progress).length) return { ok: false, empty: true };

    const sig = Sync.signature(library, progress);
    const folder = await getFolder().catch(() => null);
    const target = folder ? "folder:" + folder.name : "downloads";
    if (!force && sig === d.lastBackupSig && target === d.lastBackupTarget) return { ok: true, unchanged: true };

    const json = JSON.stringify(Sync.snapshot(library, progress));
    if (folder) {
      try {
        if (!(await permission(folder, false))) {
          await chrome.storage.local.set({ backupIssue: "access" });
          return { ok: false, needsAccess: true };
        }
        await writeFile(folder, FILE, json);
      } catch (e) {
        const msg = String((e && e.message) || e);
        await chrome.storage.local.set({ backupIssue: "error:" + msg });
        return { ok: false, error: msg };
      }
    } else {
      await chrome.downloads.download({
        url: "data:application/json;charset=utf-8," + encodeURIComponent(json),
        filename: FILE, // direttamente in Download: nessuna sottocartella
        conflictAction: "overwrite",
        saveAs: false,
      });
    }
    await chrome.storage.local.set({ lastBackupSig: sig, lastBackupAt: Date.now(), lastBackupTarget: target, backupIssue: "" });
    return { ok: true, target };
  }

  return { FILE, pickable, getFolder, setFolder, clearFolder, pickFolder, permission, readFile, looksLikeExtension, run };
})();
