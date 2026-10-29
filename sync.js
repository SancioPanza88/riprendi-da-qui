// Logica di unione dei dati tra dispositivi/file.
// Ogni voce ha `updated` (timestamp): in caso di conflitto vince la più recente.
// Le cancellazioni sono "lapidi" (tombstone) così si propagano agli altri dispositivi.
const Sync = (() => {
  const DAY = 864e5;
  const isTomb = (v) => !!v && (v.deleted === true || v.status === "removed");
  const stamp = (v) => (v && (v.updated ?? v.watchedAt ?? v.added)) || 0;

  function mergeMaps(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      if (!v || typeof v !== "object") continue;
      const cur = out[k];
      if (!cur || stamp(v) > stamp(cur)) out[k] = v;
    }
    return out;
  }

  function differs(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) if (JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])) return true;
    return false;
  }

  function prune(map) {
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
      if (isTomb(v) && now - stamp(v) > 90 * DAY) continue;
      out[k] = v;
    }
    return out;
  }

  // La trama si ricarica da TMDB: la tolgo per tenere il file leggero.
  function slimLibrary(lib) {
    const out = {};
    for (const [k, v] of Object.entries(lib || {})) {
      const { overview, ...rest } = v || {};
      out[k] = rest;
    }
    return out;
  }

  function snapshot(library, progress) {
    return {
      app: "riprendi-da-qui", version: 4, savedAt: Date.now(),
      library: slimLibrary(library), progress: progress || {},
    };
  }

  function parse(text) {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || (typeof d.library !== "object" && typeof d.progress !== "object")) {
      throw new Error("BAD_FORMAT");
    }
    return { library: d.library || {}, progress: d.progress || {} };
  }

  function merge(local, incoming) {
    const library = prune(mergeMaps(local.library, incoming.library));
    const progress = prune(mergeMaps(local.progress, incoming.progress));
    return {
      library, progress,
      localChanged: differs(local.library, library) || differs(local.progress, progress),
      fileChanged: differs(slimLibrary(incoming.library), slimLibrary(library)) || differs(incoming.progress, progress),
    };
  }

  // impronta per capire se è cambiato qualcosa dall'ultimo backup
  function signature(library, progress) {
    const norm = (x) => JSON.stringify(Object.keys(x || {}).sort().map((k) => [k, x[k]]));
    const s = norm(slimLibrary(library)) + "|" + norm(progress);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h + ":" + s.length;
  }

  return { isTomb, mergeMaps, merge, parse, snapshot, signature, prune };
})();
