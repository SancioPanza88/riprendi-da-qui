// Sincronizzazione con Letterboxd (estensione → Letterboxd), in tempo reale.
//
// Usa la sessione che hai già nel browser: nessuna password viene chiesta o
// salvata. Le richieste partono dal service worker con le stesse credenziali
// della scheda letterboxd.com aperta, e il token CSRF viene letto dalla pagina.
//
// Stato per titolo in `lbSync` (chiave = chiave della libreria):
//   { lid, uid, slug, imdb, synced: {watched, watchlist, stars, liked}, at, error }
// `synced` è l'ultimo stato inviato: se la libreria cambia, la differenza si nota
// e viene rimandata. Niente coda da tenere in ordine: è tutto idempotente.
const LBSync = (() => {
  const BASE = "https://letterboxd.com";
  // La web app usa la v0 sotto letterboxd.com; il dominio api. è per le app OAuth.
  const APIS = ["https://letterboxd.com/api/v0", "https://api.letterboxd.com/api/v0"];
  const COOLDOWN = 25 * 1000;      // dopo un errore non riprovare subito
  const MAX_PER_RUN = 14;
  const GAP = 420;                 // pausa tra due scritture

  let csrf = "";
  let csrfAt = 0;
  let who = null;
  let whoAt = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const decode = (s) => String(s || "")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

  // un solo giro alla volta: seed e sync non si pestano i piedi su `lbSync`
  let chain = Promise.resolve();
  const serial = (fn) => {
    const r = chain.then(fn, fn);
    chain = r.catch(() => {});
    return r;
  };

  async function grab(url, opts) {
    const res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      ...opts,
      headers: {
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...(opts && opts.headers),
      },
    });
    const text = await res.text();
    return { res, text, url: res.url || url };
  }

  async function token(force) {
    if (!force && csrf && Date.now() - csrfAt < 30 * 60 * 1000) return csrf;
    let html = "";
    try {
      const r = await grab(BASE + "/");
      if (r.res.status === 403) throw new Error("BLOCKED");
      html = r.text;
    } catch (e) {
      if (String(e && e.message) === "BLOCKED") throw new Error("BLOCKED");
      throw new Error("NETWORK");
    }
    const pats = [
      /supermodelCSRF\s*[:=]\s*['"]([A-Za-z0-9._~+/=-]{6,})['"]/,
      /["']csrf["']\s*:\s*["']([A-Za-z0-9._~+/=-]{6,})["']/,
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
      /name=["']__csrf["'][^>]+value=["']([^"']+)["']/i,
      /__csrf\s*=\s*["']([^"']+)["']/,
    ];
    for (const p of pats) {
      const m = html.match(p);
      if (m) { csrf = m[1]; csrfAt = Date.now(); return csrf; }
    }
    throw new Error("NO_CSRF");
  }

  // Chi sei su Letterboxd (solo se la sessione è valida)
  async function whoami(force) {
    if (!force && who && Date.now() - whoAt < 10 * 60 * 1000) return who;
    const r = await grab(BASE + "/");
    if (r.res.status === 403) throw new Error("BLOCKED");
    const html = r.text;
    const m = html.match(/person\s*[:=]\s*\{[\s\S]{0,6000}?["']username["']\s*:\s*["']([^"'\\]{1,64})["']/);
    const user = html.match(/\/member\/([a-z0-9_-]{1,64})\//i) ||
      html.match(/href=["']\/([a-z0-9_-]{2,64})\/["'][^>]*class=["'][^"']*(?:avatar|nav-account)/i);
    const loggedOut = /sign-in|signin|Sign In/i.test(html) && /\/sign-in\//i.test(html) && !/sign-out/i.test(html);
    const logged = (!!m || !loggedOut) && !/["']loggedIn["']\s*:\s*false/.test(html);
    who = logged ? { username: (m && m[1]) || (user && user[1]) || "tu", ok: true } : { ok: false };
    whoAt = Date.now();
    return who;
  }

  // ---------- da TMDB a Letterboxd ----------
  async function lookup(item, entry) {
    if (entry && entry.lid && entry.uid) return entry;
    let imdb = (entry && entry.imdb) || item.imdbId || "";
    if (!imdb && item.id && (item.type === "movie" || item.type === "tv") && typeof TMDB !== "undefined" && TMDB.hasKey()) {
      try {
        const ext = await TMDB.externalIds(item.type, item.id);
        imdb = (ext && ext.imdb_id) || "";
      } catch (e) { /* senza chiave TMDB si può ancora provare con l'id salvato */ }
    }
    if (!imdb) throw new Error("NO_IMDB");

    const r = await grab(BASE + "/imdb/" + encodeURIComponent(imdb) + "/");
    if (r.res.status === 404) throw new Error("NOT_ON_LB");
    if (!r.res.ok) throw new Error("HTTP_" + r.res.status);

    let lid = "", uid = "", slug = "";
    const meta = r.text.match(/<meta[^>]+name=["']production:identifier["'][^>]+content=["']([^"']+)["']/i) ||
      r.text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']production:identifier["']/i);
    if (meta) {
      try {
        const j = JSON.parse(decode(meta[1]));
        lid = String(j.lid || "");
        uid = String(j.uid || "");
      } catch (e) { /* si prova con l'HTML */ }
    }
    try { slug = (new URL(r.url)).pathname.split("/").filter(Boolean)[1] || ""; } catch (e) {}
    if (!lid) {
      const m = r.text.match(/data-film-id=["'](\d+)["']/);
      if (m) { lid = m[1]; uid = uid || "film:" + m[1]; }
    }
    if (!lid) {
      const m = r.text.match(/\/film\/([a-z0-9-]+)\//i);
      if (m) slug = m[1];
    }
    if (!lid && slug) {
      // ultima spiaggia: la pagina del film espone l'id anche nel link al voto
      const r2 = await grab(BASE + "/film/" + encodeURIComponent(slug) + "/");
      const m2 = r2.text.match(/data-film-id=["'](\d+)["']/) || r2.text.match(/film:(\d+)/);
      if (m2) { lid = m2[1]; uid = uid || "film:" + lid; }
    }
    if (!lid) throw new Error("NOT_ON_LB");
    return { lid, uid: uid || "film:" + lid, slug: slug || "", imdb };
  }

  // ---------- scritture ----------
  const path_join = (p) => p.replace(/\/+$/, "") + "/";

  async function write(paths, methods, body) {
    const t = await token();
    let last = null;
    for (const base of APIS) {
      for (const method of methods) {
        try {
          const res = await fetch(base + path_join(paths), {
            method,
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRF-Token": t,
            },
            body: JSON.stringify({ ...body, __csrf: t }),
          });
          if (res.status === 401 || res.status === 403) { csrf = ""; throw new Error("AUTH"); }
          if (res.status === 404 || res.status === 405) { last = new Error("HTTP_" + res.status); continue; }
          if (!res.ok) { last = new Error("HTTP_" + res.status); continue; }
          return true;
        } catch (e) {
          if (String(e && e.message) === "AUTH") throw e;
          last = e;
        }
      }
    }
    throw last || new Error("HTTP");
  }
  // vecchio percorso a form (alcune azioni non passano dalla v0)
  async function postForm(path, fields) {
    const t = await token();
    const res = await fetch(BASE + path, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": t,
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
      body: new URLSearchParams({ ...fields, __csrf: t }).toString(),
    });
    if (res.status === 401 || res.status === 403) { csrf = ""; throw new Error("AUTH"); }
    if (!res.ok) throw new Error("HTTP_" + res.status);
    return true;
  }

  const uidPath = (uid) => "/s/" + String(uid).replace(/^\/+|\/+$/g, "");

  async function pushFields(found, want, prev) {
    const out = {};
    const synced = (prev && prev.synced) || {};
    // "visto": si manda solo true, non si cancella mai la cronologia di Letterboxd
    if (want.watched) {
      await write("/me/watch/" + encodeURIComponent(found.lid), ["POST", "PATCH"], { watched: true });
      out.watched = true;
    }
    // watchlist: true/false
    if (want.watchlist !== undefined && want.watchlist !== null) {
      await write("/me/watchlist/" + encodeURIComponent(found.lid), ["PATCH", "POST"], { inWatchlist: !!want.watchlist });
      out.watchlist = !!want.watchlist;
    }
    // voto: mando 0 solo se c'era davvero un voto nostro da togliere
    const oldStars = Number(synced.stars) || 0;
    if (want.stars !== null && (want.stars > 0 || oldStars > 0)) {
      await write("/me/rate/" + encodeURIComponent(found.lid), ["PATCH", "POST"], { rating: Number(want.stars) || 0 });
      out.stars = Number(want.stars) || 0;
    }
    // cuore: mai toglierlo se non l'avevamo messo noi
    if (want.liked !== null && (want.liked || synced.liked)) {
      await write("/me/like/" + encodeURIComponent(found.lid), ["POST", "PATCH"], { liked: !!want.liked });
      out.liked = !!want.liked;
    }
    return out;
  }

  // ---------- cosa dovrebbe esserci su Letterboxd ----------
  function desired(item) {
    if (!item || item.status === "removed") return null;
    // Letterboxd è solo film: le serie non si sincronizzano
    if (item.type === "tv") return null;
    const watched = item.status === "watched";
    return {
      watched,
      watchlist: item.status === "watchlist",
      stars: watched ? Number(item.stars) || 0 : null,
      liked: watched ? !!item.liked : null,
    };
  }

  function pending(item, entry) {
    const want = desired(item);
    if (!want) return false;
    const s = (entry && entry.synced) || {};
    if (want.watched !== !!s.watched) return true;
    if (want.watchlist !== !!s.watchlist) return true;
    // confronto con 0/false: senza voto o senza cuore non c'è niente da mandare
    if (want.stars !== null && want.stars !== (Number(s.stars) || 0)) return true;
    if (want.liked !== null && !!want.liked !== !!s.liked) return true;
    return false;
  }

  async function setStatus(patch) {
    const { lbStatus } = await chrome.storage.local.get("lbStatus");
    await chrome.storage.local.set({ lbStatus: { ...(lbStatus || {}), ...patch, at: Date.now() } });
  }

  // Tutto ciò che arriva dall'import di Letterboxd è già su Letterboxd: lo segno
  // come "sincronizzato" senza riscrivere nulla (niente 1000 richieste inutili).
  function seed() { return serial(seedInner); }
  async function seedInner() {
    const { library = {}, lbSync = {} } = await chrome.storage.local.get(["library", "lbSync"]);
    const map = { ...lbSync };
    let added = 0;
    for (const item of Object.values(library)) {
      if (!item || !item.key || map[item.key]) continue;
      if (item.status === "removed") continue;
      if (item.src !== "letterboxd") continue;
      const want = desired(item);
      if (!want) continue;
      map[item.key] = { synced: want, seeded: true, at: Date.now() };
      added++;
    }
    if (added) await chrome.storage.local.set({ lbSync: map });
    return added;
  }

  // ---------- giro di sincronizzazione ----------
  function run(opts) { return serial(() => runInner(opts)); }
  async function runInner(opts) {
    const force = !!(opts && opts.force);
    const { settings = {}, library = {}, lbSync = {} } = await chrome.storage.local.get(["settings", "library", "lbSync"]);
    if (settings.lbSync === false && !force) return { ok: true, skipped: true };

    // già dentro la coda: chiamare seed() qui bloccherebbe tutto (aspetterebbe sé stesso)
    await seedInner().catch(() => {});
    const { lbSync: map0 } = await chrome.storage.local.get("lbSync");

    const now = Date.now();
    const items = Object.values(library).filter((i) => {
      if (!i || !i.key) return false;
      if (!pending(i, map0[i.key])) return false;
      const e = map0[i.key];
      if (e && e.nextAt && e.nextAt > now) return false;
      return true;
    });

    if (!items.length) {
      await setStatus({ ok: true, pending: 0, error: "", running: false, user: who && who.ok ? who.username : "" });
      return { ok: true, pending: 0 };
    }

    await setStatus({ running: true, pending: items.length });
    let me;
    try {
      me = await whoami(force);
    } catch (e) {
      await setStatus({ ok: false, error: String(e.message || e), pending: items.length, running: false });
      return { ok: false, error: String(e.message || e) };
    }
    if (!me.ok) {
      await setStatus({ ok: false, error: "LOGIN", pending: items.length, running: false });
      return { ok: false, error: "LOGIN" };
    }

    const map = { ...map0 };
    let done = 0;
    const errors = [];
    for (const item of items.slice(0, MAX_PER_RUN)) {
      const prev = map[item.key] || {};
      const want = desired(item);
      try {
        const found = await lookup(item, prev);
        const pushed = await pushFields(found, want, prev);
        map[item.key] = {
          ...prev,
          ...found,
          synced: { ...(prev.synced || {}), ...pushed },
          at: Date.now(),
          error: "",
          nextAt: 0,
        };
        done++;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg === "AUTH") { csrf = ""; who = null; }
        map[item.key] = { ...prev, error: msg, at: Date.now(), nextAt: Date.now() + (msg === "AUTH" ? 5 * 60 * 1000 : COOLDOWN) };
        errors.push(msg);
        if (msg === "AUTH" || msg === "BLOCKED") break;
      }
      await chrome.storage.local.set({ lbSync: map });
      await sleep(GAP);
    }

    const left = Object.values(library).filter((i) => pending(i, map[i.key])).length;
    const fatal = errors.find((e) => e === "AUTH" || e === "LOGIN" || e === "BLOCKED");
    await setStatus({
      ok: !fatal,
      error: fatal || (errors[0] || ""),
      pending: left,
      user: me.username,
      lastRun: Date.now(),
      done,
      running: false,
    });
    return { ok: !fatal, done, pending: left, error: fatal || errors[0] || "" };
  }

  // Anteprima di cosa verrà inviato (per l'interfaccia)
  function summary(item) {
    const want = desired(item);
    if (!want) return "";
    const p = [];
    if (want.watched) p.push("visto");
    if (want.watchlist) p.push("watchlist");
    if (want.stars) p.push(want.stars + "★");
    if (want.liked) p.push("♥");
    return p.join(" · ");
  }

  return { run, seed, whoami, desired, pending, summary, lookup, token };
})();
