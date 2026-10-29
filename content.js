(() => {
  if (window.__riprendiDaQuiLoaded) return;
  window.__riprendiDaQuiLoaded = true;

  // Attivo solo sul sito (qualunque dominio contenga "streamingcommunity")
  // e negli iframe incorporati in quel sito.
  const SITE_RE = /streamingcommunity/i;

  function isOnSite() {
    if (SITE_RE.test(location.hostname)) return true;
    try {
      const ao = location.ancestorOrigins;
      for (let i = 0; i < ao.length; i++) {
        if (SITE_RE.test(ao[i])) return true;
      }
    } catch (e) {}
    return false;
  }
  if (!isOnSite()) return;

  const IS_TOP = window === window.top;

  // ---------- utilità ----------
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res || null);
        });
      } catch (e) {
        resolve(null); // estensione aggiornata/ricaricata: serve ricaricare la pagina
      }
    });
  }
  const tell = (msg) => { try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {} };

  const plain = (s) =>
    String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const normType = (x) => {
    x = String(x || "").toLowerCase();
    return /^(movie|film)/.test(x) ? "movie" : /^(tv|serie|series)/.test(x) ? "tv" : "";
  };

  // ---------- lettura dei dati del film dalla pagina (solo finestra principale) ----------
  function findDeep(root, test, maxDepth) {
    const queue = [[root, 0]];
    let n = 0;
    while (queue.length && n++ < 4000) {
      const [o, d] = queue.shift();
      if (!o || typeof o !== "object" || d > maxDepth) continue;
      if (!Array.isArray(o) && test(o)) return o;
      for (const v of Object.values(o)) if (v && typeof v === "object") queue.push([v, d + 1]);
    }
    return null;
  }

  function extractMeta() {
    const meta = { title: "", year: "", type: "", tmdbId: 0, season: 0, episode: 0 };
    const ogTitle = ((document.querySelector('meta[property="og:title"]') || {}).content || "").trim();
    const pageText = plain(document.title + " " + ogTitle);

    // 1) dati strutturati della pagina (Inertia). Si usano solo se riferiti a QUESTO URL:
    //    dopo una navigazione "single page" l'attributo può essere rimasto quello vecchio.
    try {
      const app = document.getElementById("app");
      const raw = app && app.getAttribute("data-page");
      if (raw) {
        const page = JSON.parse(raw);
        let samePage = false;
        try { samePage = new URL(page.url, location.origin).pathname === location.pathname; } catch (e) {}
        if (samePage && page.props) {
          const hasId = (o) => o && (o.tmdb_id || o.tmdbId);
          let t = hasId(page.props.title) && typeof page.props.title === "object" ? page.props.title : null;
          if (!t) {
            // ricerca più larga: accettata solo se il nome compare nel titolo della pagina
            t = findDeep(page.props, (o) => hasId(o) && (o.name || o.title) && pageText.includes(plain(o.name || o.title)), 5);
          }
          if (t) {
            meta.tmdbId = Number(t.tmdb_id || t.tmdbId) || 0;
            meta.type = normType(t.type || t.media_type);
            meta.title = String(t.name || t.title || "");
            const d = String(t.release_date || t.first_air_date || "");
            if (/^\d{4}/.test(d)) meta.year = d.slice(0, 4);
          }
          const ep = page.props.episode;
          if (ep && typeof ep === "object") {
            meta.episode = Number(ep.number ?? ep.episode_number) || 0;
            meta.season = Number(ep.season_number ?? (ep.season && ep.season.number)) || 0;
          }
        }
      }
    } catch (e) {}

    // 2) JSON-LD (schema.org)
    try {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        const j = JSON.parse(s.textContent);
        const list = Array.isArray(j) ? j : j && j["@graph"] ? j["@graph"] : [j];
        const o = list.find((x) => x && /Movie|TVSeries|TVEpisode/i.test([].concat(x["@type"] || []).join(" ")));
        if (!o) continue;
        const ty = [].concat(o["@type"]).join(" ");
        if (!meta.type) meta.type = /Movie/i.test(ty) ? "movie" : "tv";
        if (/TVEpisode/i.test(ty)) {
          if (!meta.title && o.partOfSeries && o.partOfSeries.name) meta.title = String(o.partOfSeries.name);
          if (!meta.episode) meta.episode = Number(o.episodeNumber) || 0;
          if (!meta.season && o.partOfSeason) meta.season = Number(o.partOfSeason.seasonNumber) || 0;
        } else if (!meta.title && o.name) meta.title = String(o.name);
        if (!meta.year && /^\d{4}/.test(String(o.datePublished || ""))) meta.year = String(o.datePublished).slice(0, 4);
        break;
      }
    } catch (e) {}

    // 3) titolo della pagina, ripulito dal "rumore" (nome del sito, "Guarda… in streaming", ecc.)
    const parsed = TitleParse.parseTitle(ogTitle || document.title);
    if (!meta.title) meta.title = parsed.title;
    if (!meta.year) meta.year = parsed.year;
    if (!meta.year) {
      // ultimo tentativo: anno di uscita dichiarato nella pagina (aiuta a distinguere i remake)
      const el = document.querySelector('[itemprop="datePublished"], meta[property="video:release_date"], time[datetime]');
      const v = el && (el.getAttribute("content") || el.getAttribute("datetime") || el.textContent);
      const m = v && String(v).match(/\b(19|20)\d{2}\b/);
      if (m) meta.year = m[0];
    }
    if (!meta.season) meta.season = parsed.season;
    if (!meta.episode) meta.episode = parsed.episode;
    if (!meta.type && (meta.season || meta.episode)) meta.type = "tv";
    return meta;
  }

  if (IS_TOP) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === "getMeta") {
        try { sendResponse(extractMeta()); } catch (e) { sendResponse({}); }
      }
    });
  }

  // ---------- contesto (titolo riconosciuto) e dati salvati ----------
  let ctxCache = null;
  let ctxAt = 0;
  let ctxHref = "";
  async function getContext(force) {
    if (!force && ctxCache && ctxHref === location.href && Date.now() - ctxAt < 15000) return ctxCache;
    const c = await send({ type: "getContext" });
    ctxCache = c || { url: location.href, title: document.title, tmdb: null, season: 0, episode: 0 };
    ctxAt = Date.now();
    ctxHref = location.href;
    return ctxCache;
  }

  async function loadAll() {
    try {
      const data = await chrome.storage.local.get("progress");
      return data.progress || {};
    } catch (e) {
      return {};
    }
  }
  const alive = (r) => (r && !r.deleted && r.status !== "removed" ? r : null);

  // chiave del titolo corrente (aggiornata a ogni riconoscimento)
  let currentKey = "";

  // Trova la voce salvata per questo film: chiave del sito, chiave TMDB o
  // qualunque voce che parla dello stesso film/episodio (progress.js).
  function findEntry(all, ctx) {
    try {
      const hit = Progress.find(all, ctx);
      if (hit && hit.rec) return hit;
    } catch (e) {}
    const k = ctx && ctx.url ? TitleParse.siteKey(ctx.url) : "";
    return k && alive(all[k]) ? { key: k, rec: all[k] } : null;
  }

  function keyFor(ctx, found) {
    if (found && found.key) return found.key;
    try {
      if (ctx && ctx.tmdb && (ctx.tmdb.type === "movie" || ctx.tmdb.type === "tv")) return Progress.canon(ctx);
    } catch (e) {}
    return TitleParse.siteKey((ctx && ctx.url) || location.href);
  }

  async function getSettings() {
    try {
      const d = await chrome.storage.local.get("settings");
      return d.settings || {};
    } catch (e) {
      return {};
    }
  }

  // copia in memoria dell'impostazione: in chiusura non c'è tempo di rileggerla
  let autoOn = true;
  let socialOn = true;
  getSettings().then((st) => { autoOn = st.autoSave !== false; socialOn = st.socialOn !== false; });
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !ch.settings) return;
      const st = ch.settings.newValue || {};
      autoOn = st.autoSave !== false;
      socialOn = st.socialOn !== false;
    });
  } catch (e) {}

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    // il più grande è quasi certamente il player principale
    videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return videos[0];
  }

  // ---------- interfaccia ----------
  let host = null;
  let ui = {};
  let currentVideo = null;
  let hideTimer = null;
  let lastRefresh = 0;
  let allowBack = false;      // true quando sei tu a spostarti indietro nel film (o a ricominciare)
  let ignoreSeekUntil = 0;    // salti del player/nostri che non contano come "scelta tua"
  let lastTime = 0;           // ultima posizione nota: serve a riconoscere un salto indietro

  function buildUI() {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:6px;
                font-family: system-ui, sans-serif; opacity:0; transition:opacity .25s;
                pointer-events:none; max-width:420px; }
        .wrap.show { opacity:1; pointer-events:auto; }
        .row { display:flex; gap:6px; }
        button { all:unset; cursor:pointer; background:rgba(20,20,20,.88); color:#fff;
                 padding:7px 12px; border-radius:8px; font-size:13px; font-weight:600;
                 border:1px solid rgba(255,255,255,.18); }
        button:hover { background:#e50914; }
        button[hidden] { display:none; }
        .label { background:rgba(0,0,0,.72); color:#fff; font-size:12px; padding:4px 10px;
                 border-radius:6px; text-align:right; }
        .label.unk { color:#bbb; font-style:italic; }
        .label[hidden] { display:none; }
        .toast { background:rgba(0,0,0,.85); color:#fff; font-size:12px; padding:5px 10px;
                 border-radius:6px; opacity:0; transition:opacity .2s; text-align:right; }
        .toast.on { opacity:1; }
        .partyl { background:rgba(0,160,80,.92); color:#fff; font-size:12px; font-weight:700;
                  padding:4px 10px; border-radius:6px; display:flex; gap:8px; align-items:center; }
        .partyl button { padding:2px 8px; font-size:11px; background:rgba(0,0,0,.28); }
        .partyl[hidden] { display:none; }
        .friendsl { background:rgba(0,0,0,.72); color:#7ef0a8; font-size:12px; font-weight:600;
                   padding:3px 9px; border-radius:6px; }
        .friendsl[hidden] { display:none; }
        .invite { background:rgba(20,20,20,.95); border:1px solid rgba(0,255,120,.5); border-radius:8px;
                  padding:10px; display:flex; flex-direction:column; gap:8px; max-width:320px; }
        .invite[hidden] { display:none; }
        .invite .t { font-size:12px; color:#eee; text-align:left; line-height:1.35; }
        .invite .r { display:flex; gap:6px; justify-content:flex-end; }
      </style>
      <div class="wrap" id="wrap">
        <div class="label" id="label" hidden></div>
        <div class="friendsl" id="friendsl" hidden></div>
        <div class="partyl" id="partyl" hidden>
          <span id="partyText">🎉 Insieme</span>
          <button id="partyLeave">Esci</button>
        </div>
        <div class="invite" id="invite" hidden>
          <div class="t" id="inviteText"></div>
          <div class="r"><button id="inviteNo">No</button><button id="inviteYes">Guarda insieme</button></div>
        </div>
        <div class="row">
          <button id="resume" hidden></button>
          <button id="save">📌 Segna qui</button>
        </div>
        <div class="toast" id="toast"></div>
      </div>`;
    ui.wrap = root.getElementById("wrap");
    ui.save = root.getElementById("save");
    ui.resume = root.getElementById("resume");
    ui.toast = root.getElementById("toast");
    ui.label = root.getElementById("label");
    ui.friendsl = root.getElementById("friendsl");
    ui.partyl = root.getElementById("partyl");
    ui.partyText = root.getElementById("partyText");
    ui.partyLeave = root.getElementById("partyLeave");
    ui.invite = root.getElementById("invite");
    ui.inviteText = root.getElementById("inviteText");
    ui.inviteYes = root.getElementById("inviteYes");
    ui.inviteNo = root.getElementById("inviteNo");

    ui.save.addEventListener("click", () => saveProgress({}));
    ui.resume.addEventListener("click", resumeProgress);
    ui.partyLeave.addEventListener("click", () => {
      tell({ type: "social:party:leave" });
      party = null;
      updatePartyUI();
      toast("Hai lasciato la visione insieme");
    });
    ui.inviteYes.addEventListener("click", acceptInvite);
    ui.inviteNo.addEventListener("click", () => {
      ui.invite.hidden = true;
      tell({ type: "social:inviteDecline" });
    });
    updatePartyUI();
    updateFriendsBadge();
    placeHost();
  }

  function updateFriendsBadge() {
    if (!ui.friendsl) return;
    ui.friendsl.hidden = friendsOnline < 1;
    if (friendsOnline < 1) return;
    ui.friendsl.textContent = friendsOnline === 1 ? "👥 1 amico online" : `👥 ${friendsOnline} amici online`;
  }

  function placeHost() {
    if (!host) return;
    const fs = document.fullscreenElement;
    const target = fs && fs.tagName !== "VIDEO" && fs.tagName !== "IFRAME" ? fs : document.documentElement;
    if (host.parentNode !== target) target.appendChild(host);
  }

  let toastTimer;
  function toast(text) {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("on"), 2600);
  }

  function labelFor(ctx) {
    const name = ctx.tmdb ? ctx.tmdb.title + (ctx.tmdb.year ? ` (${ctx.tmdb.year})` : "") : ctx.title || "";
    if (!name) return "";
    const ep = ctx.season || ctx.episode ? ` · ${ctx.season ? "S" + ctx.season : ""}${ctx.episode ? "E" + ctx.episode : ""}` : "";
    return name + ep;
  }

  async function refreshUI() {
    const ctx = await getContext(false);
    const text = labelFor(ctx);
    if (text) {
      ui.label.hidden = false;
      ui.label.classList.toggle("unk", !ctx.tmdb);
      ui.label.textContent = (ctx.tmdb ? "🎬 " : "❔ ") + text;
    } else {
      ui.label.hidden = true;
    }
    const all = await loadAll();
    const found = findEntry(all, ctx);
    const rec = found && found.rec;
    if (rec && rec.time > 5 && !rec.finished) {
      ui.resume.textContent = `▶ Riprendi da ${fmt(rec.time)}`;
      ui.resume.hidden = false;
    } else {
      ui.resume.hidden = true;
    }
  }

  function showTemporarily() {
    if (!ui.wrap) return;
    placeHost();
    const now = Date.now();
    if (now - lastRefresh > 2000) { // il mouse genera molti eventi: aggiorna al massimo ogni 2s
      lastRefresh = now;
      refreshUI();
    }
    ui.wrap.classList.add("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => ui.wrap.classList.remove("show"), 3500);
  }

  // ---------- salvataggio ----------
  async function saveProgress(opts) {
    const auto = !!(opts && opts.auto);
    const v = currentVideo || findVideo();
    if (!v) return;
    // salvataggio periodico: aspetta un momento libero del browser, così non disturba il video
    if (auto && !(opts && opts.fast)) {
      await new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(r, { timeout: 2000 }) : setTimeout(r, 0)));
    }
    const dur = isFinite(v.duration) ? v.duration : 0;
    // percorso rapido (chiusura scheda): niente attese di rete, uso il titolo già riconosciuto
    let ctx;
    if (opts && opts.fast && ctxCache && ctxHref === location.href) ctx = ctxCache;
    else ctx = await getContext(!auto);
    if (!ctx) return;

    const all = await loadAll();
    const found = findEntry(all, ctx);
    const prev = found && found.rec;
    const key = keyFor(ctx, found);
    currentKey = key;

    // Il salvataggio automatico non fa "tornare indietro" un punto già raggiunto
    // se il player si è riavviato da solo...
    // ...ma se sei TU ad aver ripreso dall'inizio o a esserti spostato indietro,
    // allowBack è true e il nuovo punto vale (era il bug: restava il vecchio film).
    if (auto && prev && !prev.finished && prev.time > v.currentTime + 2 && !allowBack) return;
    // niente scritture inutili se il punto non si è mosso
    if (auto && prev && !prev.finished && Math.abs(prev.time - v.currentTime) < 3) return;

    const rec = Progress.build(prev, ctx, {
      time: v.currentTime,
      duration: dur,
      finished: dur > 0 ? v.currentTime / dur >= 0.95 || dur - v.currentTime <= 120 : false,
    });
    rec.key = key;

    const res = await send({ type: "saveProgress", key, rec });
    if (!res || !res.ok) {
      if (!auto) toast("Errore nel salvataggio (ricarica la pagina)");
      return;
    }
    lastTime = v.currentTime;
    if (!auto) {
      toast(`Salvato a ${fmt(v.currentTime)}${labelFor(ctx) ? " · " + labelFor(ctx) : ""}`);
      refreshUI();
    }
    pingPresence(true);
  }

  // Sposta il video al punto salvato. Alcuni player lo riportano a 0 appena parte:
  // per qualche secondo controllo e, se serve, ripeto il salto.
  function seekTo(video, t) {
    ignoreSeekUntil = Date.now() + 4000;
    lastTime = t;
    const apply = () => { if (Math.abs(video.currentTime - t) > 3) video.currentTime = t; };
    apply();
    toast(`Ripreso da ${fmt(t)}`);
    let tries = 0;
    const check = () => {
      if (++tries > 4) return;
      setTimeout(() => {
        if (video.currentTime < t - 5 && !allowBack) { ignoreSeekUntil = Date.now() + 4000; apply(); }
        check();
      }, 1500);
    };
    check();
  }

  // Se il player riparte da zero e c'era un punto avanzato, stai ricominciando:
  // il nuovo punto deve sostituire il vecchio, non essere ignorato.
  let resumeRequested = false;

  async function resumeProgress() {
    const v = currentVideo || findVideo();
    if (!v) return;
    const ctx = await getContext(true);
    const rec = findEntry(await loadAll(), ctx);
    if (!rec || !rec.rec) return;
    resumeRequested = true;
    allowBack = false;
    seekTo(v, rec.rec.time);
  }

  // Se arrivi dal popup/dashboard con "Riprendi", salta da solo al punto salvato
  let resumedKey = null;
  async function maybeAutoResume(video) {
    try {
      if (!(await chrome.storage.local.get("autoResume")).autoResume) return;
      const ctx = await getContext(true);
      const key = keyFor(ctx, findEntry(await loadAll(), ctx));
      if ((await chrome.storage.local.get("autoResume")).autoResume !== key || resumedKey === key) return;
      if (video.readyState < 1) await new Promise((res) => video.addEventListener("loadedmetadata", res, { once: true }));
      // trailer e pubblicità sono brevi: aspetto il player vero senza "consumare" la richiesta
      if (!(video.duration >= 600)) return;
      const data = await chrome.storage.local.get(["autoResume", "progress"]);
      if (data.autoResume !== key || resumedKey === key) return;
      resumedKey = key;
      await chrome.storage.local.remove("autoResume");
      const rec = findEntry(data.progress || {}, ctx);
      if (rec && rec.rec) { resumeRequested = true; seekTo(video, rec.rec.time); }
    } catch (e) {}
  }

  // ---------- salvataggio automatico ----------
  let lastAuto = 0;
  function autoSave(minGap, fast) {
    const v = currentVideo;
    if (!v || !isFinite(v.duration) || !autoOn) return;
    // niente trailer/anteprime/pubblicità (brevi) e niente primi secondi
    if (v.duration < 600 || v.currentTime < 30) return;
    const now = Date.now();
    if (now - lastAuto < minGap) return;
    lastAuto = now;
    saveProgress({ auto: true, fast: !!fast });
  }

  // ---------- presenza per gli amici ----------
  let lastPresence = 0;
  function pingPresence(force) {
    const v = currentVideo;
    if (!v || !socialOn) return;
    const now = Date.now();
    if (!force && now - lastPresence < 8000) return;
    lastPresence = now;
    const ctx = ctxCache || { url: location.href, title: document.title, tmdb: null, season: 0, episode: 0 };
    const t = ctx.tmdb || null;
    tell({
      type: "social:me",
      watching: {
        key: currentKey || TitleParse.siteKey(ctx.url || location.href),
        title: (t && t.title) || ctx.title || "",
        year: (t && t.year) || ctx.year || "",
        tmdb: t,
        season: Number(ctx.season) || 0,
        episode: Number(ctx.episode) || 0,
        time: Math.floor(v.currentTime || 0),
        duration: Math.floor(isFinite(v.duration) ? v.duration : 0),
        paused: v.paused,
        url: ctx.url || location.href,
      },
    });
  }

  // ---------- visione insieme ----------
  let party = null;            // { code, role }
  let friendsOnline = 0;
  let applyingRemote = 0;
  let lastBeat = 0;
  let lastLocalAction = 0;     // per non far sovrascrivere subito un tuo comando dallo stato del padrone

  function sendBeat(force) {
    const v = currentVideo;
    if (!v || !party || party.role !== "host") return;
    const now = Date.now();
    if (!force && now - lastBeat < 2400) return;
    lastBeat = now;
    tell({
      type: "party:beat",
      beat: { t: v.currentTime, playing: !v.paused && !v.ended, key: currentKey || "", at: now },
    });
  }

  function partySend(kind) {
    const v = currentVideo;
    if (!v || !party) return;
    const now = Date.now();
    if (now - applyingRemote < 900) return;   // è un effetto del comando di un altro, non tuo
    lastLocalAction = now;
    tell({
      type: "party:event",
      event: { kind, t: v.currentTime, playing: !v.paused && !v.ended, key: currentKey || "", at: now },
    });
  }

  function applyPartyEvent(ev, receivedAt) {
    const v = currentVideo || findVideo();
    if (!v || !ev || !party) return;
    if (ev.key && currentKey && ev.key !== currentKey) return;
    const now = Date.now();
    const latency = Math.max(0, Math.min(5, (now - (receivedAt || now)) / 1000));
    const want = Number(ev.t) || 0;

    if (ev.kind === "state") {
      // subito dopo un tuo comando non accettare lo stato in arrivo (evita il "rimbalzo")
      if (now - lastLocalAction < 1600) return;
      const target = want + (ev.playing ? latency : 0);
      if (target > 1 && Math.abs(v.currentTime - target) > 2) {
        applyingRemote = now;
        ignoreSeekUntil = now + 1500;
        try { v.currentTime = target; lastTime = target; } catch (e) {}
      }
      if (ev.playing === true && v.paused) { applyingRemote = now; v.play().catch(() => {}); }
      if (ev.playing === false && !v.paused) { applyingRemote = now; v.pause(); }
      return;
    }

    applyingRemote = now;
    ignoreSeekUntil = now + 1500;
    if (ev.kind === "seek") {
      try { v.currentTime = want; lastTime = want; } catch (e) {}
    } else if (ev.kind === "play") {
      if (Math.abs(v.currentTime - (want + latency)) > 1.5) { try { v.currentTime = want + latency; lastTime = want + latency; } catch (e) {} }
      v.play().catch(() => {});
    } else if (ev.kind === "pause") {
      if (Math.abs(v.currentTime - want) > 1.5) { try { v.currentTime = want; lastTime = want; } catch (e) {} }
      v.pause();
    }
  }

  function updatePartyUI() {
    if (!ui.partyl) return;
    ui.partyl.hidden = !party;
    if (party) ui.partyText.textContent = "🎉 Insieme" + (party.peers ? ` · ${party.peers}` : "");
  }

  function showInvite(invite) {
    if (!invite || !ui.invite) return;
    const who = (invite.from && invite.from.name) || "Un amico";
    const what = (invite.film && invite.film.title) || "un film";
    ui.inviteText.textContent = `${who} ti invita a guardare ${what} insieme.`;
    ui.invite.hidden = false;
    ui.wrap.classList.add("show");
    showTemporarily();
    ui.invite._invite = invite;
  }

  async function acceptInvite() {
    const invite = ui.invite && ui.invite._invite;
    if (!invite) return;
    ui.invite.hidden = true;
    const res = await send({ type: "social:inviteAccept", invite });
    if (!res || !res.ok) toast("Non riesco a unirmi alla visione");
    else toast("Ti sei unito alla visione insieme");
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "party:state") {
      party = msg.party || null;
      updatePartyUI();
      if (party && party.role === "host") sendBeat(true);
    } else if (msg.type === "party:event") {
      applyPartyEvent(msg.event, msg.at);
    } else if (msg.type === "party:invite") {
      showInvite(msg.invite);
    } else if (msg.type === "party:beatNow") {
      sendBeat(true);
    } else if (msg.type === "party:notice") {
      if (msg.text) toast(msg.text);
    } else if (msg.type === "social:count") {
      friendsOnline = Number(msg.count) || 0;
      updateFriendsBadge();
    }
  });

  // ---------- avvio ----------
  const wired = new WeakSet();
  function attach(video) {
    currentVideo = video;
    allowBack = false;
    resumeRequested = false;
    ignoreSeekUntil = Date.now() + 4000;
    lastTime = video.currentTime || 0;
    if (!host) buildUI();
    if (!wired.has(video)) {
      wired.add(video);
      video.addEventListener("play", () => { showTemporarily(); partySend("play"); sendBeat(true); });
      video.addEventListener("pause", () => {
        showTemporarily();
        partySend("pause");
        autoSave(0, true);
        pingPresence(true);
      });
      // nessun salvataggio mentre guardi: qui si ricorda solo che ti sei spostato tu
      // (così in chiusura vale il punto dove sei, anche se è prima di quello vecchio)
      video.addEventListener("seeked", () => {
        if (Date.now() < ignoreSeekUntil) return;
        if (video.currentTime < lastTime - 2) allowBack = true;
        lastTime = video.currentTime;
        partySend("seek");
        pingPresence(true);
      });
      // un salto indietro di oltre 5 secondi è un seek dell'utente: vale anche
      // se il player non emette "seeked" (streaming community a volte non lo fa)
      video.addEventListener("timeupdate", () => {
        const t = video.currentTime;
        if (!applyingRemote && Date.now() > ignoreSeekUntil && t < lastTime - 5) allowBack = true;
        lastTime = t;
      });
    }
    getContext(false).then((ctx) => {
      const key = keyFor(ctx, null);
      currentKey = key;
      pingPresence(true);
      // riparti da zero con un punto avanzato già salvato = stai ricominciando
      loadAll().then((all) => {
        const found = findEntry(all, ctx);
        const rec = found && found.rec;
        if (found) currentKey = found.key;
        if (!resumeRequested && rec && !rec.finished && rec.time > 90 && (video.currentTime || 0) < 15) allowBack = true;
      }).catch(() => {});
    }).catch(() => {});
    showTemporarily();
    maybeAutoResume(video);
  }

  // il player compare in ritardo (e può cambiare navigando): controlla ogni secondo
  setInterval(() => {
    const v = findVideo();
    if (v && v !== currentVideo) attach(v);
  }, 1000);

  // salvataggio periodico mentre guardi: se chiudi di colpo non perdi niente
  setInterval(() => autoSave(20000, true), 5000);
  // posizione per gli amici + battito della visione insieme
  setInterval(() => { pingPresence(false); sendBeat(false); }, 2500);

  // Se la scheda si apre già dentro una visione insieme (invito accettato), lo
  // stato del party è stato mandato prima che questo script esistesse: lo chiedo.
  send({ type: "social:get" }).then((soc) => {
    if (!soc) return;
    friendsOnline = Number(soc.online) || 0;
    updateFriendsBadge();
    if (!soc.party || !soc.party.code) return;
    party = { code: soc.party.code, role: soc.party.role, peers: soc.party.peers || 0 };
    updatePartyUI();
    if (party.role === "host") sendBeat(true);
  }).catch(() => {});

  document.addEventListener("mousemove", showTemporarily, { passive: true });
  document.addEventListener("fullscreenchange", () => {
    placeHost();
    showTemporarily();
  });
  // il punto si salva qui (oltre al pulsante «Segna qui»): quando lasci o chiudi la scheda, o chiudi il browser
  const flush = () => autoSave(0, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { flush(); pingPresence(true); } });
  // chiusura vera della scheda: smetto di dire agli amici che sto guardando
  window.addEventListener("pagehide", () => { flush(); if (socialOn) tell({ type: "social:me", watching: null }); });
  window.addEventListener("beforeunload", flush);

  // Scorciatoie (quando il focus è sul player): Alt+S salva, Alt+R riprende
  document.addEventListener("keydown", (e) => {
    if (!currentVideo || !e.altKey) return;
    if (e.code === "KeyS") {
      e.preventDefault();
      saveProgress({});
    } else if (e.code === "KeyR") {
      e.preventDefault();
      resumeProgress();
    }
  });
})();
