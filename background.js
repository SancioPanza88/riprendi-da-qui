importScripts("titleparse.js", "progress.js", "tmdb.js", "sync.js", "backup.js", "letterboxdsync.js");

// ---------------------------------------------------------------
//  1) Riconoscimento del titolo
//  Il player sta in un iframe: chiede qui "che film è?". Qui chiediamo alla
//  pagina principale cosa mostra e lo confrontiamo con TMDB.
// ---------------------------------------------------------------
const ctxCache = new Map();
let usedKey = null;

async function resolveContext(tab) {
  const cacheKey = tab.url + "|" + tab.title;
  const hit = ctxCache.get(cacheKey);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.v;

  let meta = {};
  try {
    meta = (await chrome.tabs.sendMessage(tab.id, { type: "getMeta" }, { frameId: 0 })) || {};
  } catch (e) { /* pagina senza script (appena installata): si ripiega sul titolo della scheda */ }

  const fallback = TitleParse.parseTitle(tab.title);
  const info = {
    url: tab.url,
    title: meta.title || fallback.title,
    year: meta.year || fallback.year || "",
    season: meta.season || fallback.season || 0,
    episode: meta.episode || fallback.episode || 0,
    type: meta.type || "",
    tmdb: null,
  };

  const { settings } = await chrome.storage.local.get("settings");
  const key = settings && settings.tmdbKey;
  if (key) {
    if (key !== usedKey) { TMDB.setKey(key); usedKey = key; }
    try {
      info.tmdb = await TMDB.identify({
        title: info.title, year: info.year,
        type: info.season || info.episode ? "tv" : info.type,
        tmdbId: meta.tmdbId,
      });
    } catch (e) { /* senza rete o chiave errata: resta il solo titolo */ }
  }

  if (ctxCache.size > 50) ctxCache.clear();
  // se TMDB non ha risposto non memorizzo, così riprova al prossimo salvataggio
  if (info.tmdb || !key) ctxCache.set(cacheKey, { t: Date.now(), v: info });
  return info;
}

// ---------------------------------------------------------------
//  2) Punti di visione: UN SOLO SCRITTORE
//  Prima ogni scheda/iframe leggeva tutta la mappa `progress` e la riscriveva:
//  due film aperti = l'ultimo che salvava cancellava gli altri. Qui le scritture
//  passano tutte da una coda, si rilegge sempre lo stato aggiornato e si tocca
//  solo la chiave del titolo interessato.
// ---------------------------------------------------------------
let progressChain = Promise.resolve();
function onProgressQueue(fn) {
  const run = progressChain.then(fn, fn);
  progressChain = run.catch(() => {});
  return run;
}

function saveProgress(key, rec, opts) {
  if (!key || !rec || typeof rec !== "object") return Promise.resolve(false);
  return onProgressQueue(async () => {
    const { progress = {} } = await chrome.storage.local.get("progress");
    const cur = progress[key];
    const force = !!(opts && opts.force);
    // un salvataggio vecchio non deve sovrascrivere uno più recente
    if (!force && cur && !cur.deleted && (Number(rec.updated) || 0) < (Number(cur.updated) || 0)) return false;
    progress[key] = { ...rec, key };
    await chrome.storage.local.set({ progress });
    return true;
  });
}

function deleteProgress(key) {
  if (!key) return Promise.resolve(false);
  return onProgressQueue(async () => {
    const { progress = {} } = await chrome.storage.local.get("progress");
    const cur = progress[key] || {};
    progress[key] = { key, url: cur.url || "", title: cur.title || "", deleted: true, updated: Date.now() };
    await chrome.storage.local.set({ progress });
    return true;
  });
}

// ---------------------------------------------------------------
//  3) Backup automatico su file (vedi backup.js): nella cartella scelta,
//     altrimenti direttamente in Download
// ---------------------------------------------------------------
function scheduleBackup() {
  chrome.alarms.create("backup", { delayInMinutes: 1 }); // stesso nome = riparte il conto: accorpa le modifiche
}
const doBackup = (force) => Backup.run(force);

// ---------------------------------------------------------------
//  4) Letterboxd: sync automatica in background
// ---------------------------------------------------------------
function scheduleLbSync() {
  // accorpa le modifiche ravvicinate, poi lascia lavorare il periodico
  chrome.alarms.create("lbSyncSoon", { when: Date.now() + 20 * 1000 });
}
async function runLbSync(force) {
  try {
    const r = await LBSync.run({ force: !!force });
    if (r && r.pending > 0 && !r.skipped) scheduleLbSync();
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.library || ch.progress || ch.settings) scheduleBackup();
  if (ch.library) {
    scheduleLbSync();
    LBSync.seed().catch(() => {});
  }
  if (ch.settings && ch.settings.newValue) {
    const st = ch.settings.newValue;
    if (st.socialOn === false) closeOffscreen();
    else ensureSocial().catch(() => {});
  }
  if (ch.social) applySocialSideEffects();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (!a) return;
  if (a.name === "backup") doBackup(false).catch(() => {});
  else if (a.name === "lbSync" || a.name === "lbSyncSoon") runLbSync(false);
  else if (a.name === "socialPing") ensureSocial().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  scheduleBackup();
  chrome.alarms.create("lbSync", { periodInMinutes: 2 });
  LBSync.seed().catch(() => {});
  runLbSync(false);
  ensureSocial().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("lbSync", { periodInMinutes: 2 });
  chrome.alarms.create("socialPing", { periodInMinutes: 25 });
  ensureSocial().catch(() => {});
});

// tiene pulita la cronologia dei download: il file resta, sparisce solo la riga
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || item.byExtensionId !== chrome.runtime.id) return;
  if (state === "complete") chrome.downloads.erase({ id: delta.id });
  else { await chrome.storage.local.remove("lastBackupSig"); scheduleBackup(); }
});

// ---------------------------------------------------------------
//  5) Amici: stato condiviso, stanza trystero in un documento offscreen
//     (il service worker può essere sospeso: la stanza deve vivere fuori).
// ---------------------------------------------------------------
const APP_ID = "riprendi-da-qui-social-v1";
const OFFSCREEN_URL = "social.html";
let creatingOffscreen = null;
let socialChain = Promise.resolve();
let lastSocial = null;
let pendingInvite = null;   // invito da rimandare appena la stanza è pronta

function withSocial(fn) {
  const run = socialChain.then(fn, fn);
  socialChain = run.catch(() => {});
  return run;
}

async function getSocial() {
  const { social } = await chrome.storage.local.get("social");
  return social || { me: {}, circle: null, friends: {}, invites: [] };
}
function patchSocial(patch) {
  return withSocial(async () => {
    const cur = await getSocial();
    const next = { ...cur, ...patch, at: Date.now() };
    await chrome.storage.local.set({ social: next });
    return next;
  });
}

function newId() {
  try { return crypto.randomUUID(); } catch (e) { return "u" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (e) {}
}

async function ensureSocial() {
  const { settings = {}, social } = await chrome.storage.local.get(["settings", "social"]);
  if (settings.socialOn === false) return false;
  if (!social || !social.circle || !social.circle.code) return false;
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return true;
  } catch (e) {}
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["WEB_RTC"],
      justification: "Resta connesso alla cerchia di amici per vedere in tempo reale cosa stanno guardando e sincronizzare la visione insieme.",
    }).catch((e) => {
      patchSocial({ error: String((e && e.message) || "OFFSCREEN") }).catch(() => {});
      return null;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
  try { return !!(chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()); } catch (e) { return false; }
}

async function toOffscreen(msg, retry) {
  const ready = await ensureSocial();
  if (!ready) return false;
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(true);
      });
    } catch (e) { resolve(false); }
  });
}

async function socialTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => t.id && /streamingcommunity/i.test(t.url || ""));
}
async function sendToTabs(msg) {
  const tabs = await socialTabs();
  for (const t of tabs) {
    try { chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError); } catch (e) {}
  }
}

function normalizeCode(code) {
  return String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}

// Quando lo stato social cambia (cerchia, nome, condivisione) lo spingo alla stanza
async function syncOffscreen(extra) {
  const soc = await getSocial();
  const { settings = {} } = await chrome.storage.local.get("settings");
  lastSocial = soc;
  if (settings.socialOn === false) {
    await closeOffscreen();
    return;
  }
  if (!soc.circle || !soc.circle.code) return;
  await toOffscreen({ type: "soc:state", me: soc.me || {}, circle: soc.circle, watching: (soc.me && soc.me.watching) || null, ...(extra || {}) });
}

function applySocialSideEffects() {
  // badge con gli amici online (utile su qualunque scheda)
  getSocial().then((soc) => {
    const n = Object.values(soc.friends || {}).filter((f) => f && f.at && Date.now() - f.at < 60000).length;
    try {
      chrome.action.setBadgeText({ text: n ? String(n) : "" });
      chrome.action.setBadgeBackgroundColor({ color: "#00c030" });
    } catch (e) {}
  }).catch(() => {});
}

let lastOnlineCount = null;
async function setFriends(peers) {
  const me = (await getSocial()).me || {};
  const friends = {};
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p || !p.peerId) continue;
    if (p.id && me.id && p.id === me.id) continue;
    friends[p.peerId] = {
      peerId: p.peerId,
      id: p.id || "",
      name: p.name || "Amico",
      watching: p.watching || null,
      at: Date.now(),
    };
  }
  const n = Object.keys(friends).length;
  const next = await patchSocial({ friends, online: n });
  if (n !== lastOnlineCount) {
    lastOnlineCount = n;
    sendToTabs({ type: "social:count", count: n });
  }
  return next;
}

async function socialMe(watching, sender) {
  return withSocial(async () => {
    const soc = await getSocial();
    const me = { ...(soc.me || {}) };
    if (!me.id) me.id = newId();
    me.watching = watching ? { ...watching, at: Date.now() } : null;
    if (sender && sender.tab) me.tabId = sender.tab.id;
    const next = { ...soc, me, at: Date.now() };
    await chrome.storage.local.set({ social: next });
    return next;
  }).then((soc) => {
    toOffscreen({ type: "soc:watching", watching: (soc.me && soc.me.watching) || null }).catch(() => {});
  });
}

async function socialStartParty(peerId) {
  const soc = await getSocial();
  const film = soc.me && soc.me.watching;
  if (!film || !film.key) return { ok: false, error: "NO_FILM" };
  if (!soc.circle || !soc.circle.code) return { ok: false, error: "NO_CIRCLE" };
  const code = Math.random().toString(36).slice(2, 8);
  const party = { code, role: "host", since: Date.now(), peers: [] };
  await patchSocial({ party });
  await toOffscreen({ type: "soc:party", action: "join", code, role: "host" });
  if (peerId) {
    pendingInvite = {
      peer: peerId,
      info: {
        code,
        from: { id: (soc.me && soc.me.id) || "", name: (soc.me && soc.me.name) || "Amico" },
        film: { key: film.key, title: film.title || "", url: film.url || "", time: Number(film.time) || 0 },
      },
    };
    const sent = await toOffscreen({ type: "soc:invite", peer: pendingInvite.peer, info: pendingInvite.info });
    if (sent) pendingInvite = null;
  }
  await sendToTabs({ type: "party:state", party });
  return { ok: true, party };
}

async function socialAcceptInvite(invite, senderTab) {
  if (!invite || !invite.code) return { ok: false };
  const soc = await getSocial();
  const party = { code: invite.code, role: "guest", since: Date.now(), host: invite.from || null, peers: [] };
  await patchSocial({ party, invites: [] });
  await toOffscreen({ type: "soc:party", action: "join", code: invite.code, role: "guest" });
  await toOffscreen({
    type: "soc:inviteReply",
    peer: invite.peerId,
    info: { code: invite.code, accept: true, from: { id: (soc.me && soc.me.id) || "", name: (soc.me && soc.me.name) || "Amico" } },
  });
  await sendToTabs({ type: "party:state", party });
  // se la scheda da cui accetti non è già su quel film, apri il film
  const film = invite.film;
  const onIt = senderTab && film && film.key && soc.me && soc.me.watching && soc.me.watching.key === film.key;
  if (film && film.url && !onIt) {
    try { chrome.tabs.create({ url: film.url }); } catch (e) {}
  }
  return { ok: true, party };
}

async function socialLeaveParty() {
  await patchSocial({ party: null });
  await toOffscreen({ type: "soc:party", action: "leave" });
  await sendToTabs({ type: "party:state", party: null });
  return { ok: true };
}

async function socialSetCircle(code) {
  const clean = normalizeCode(code);
  const soc = await getSocial();
  if (!clean) {
    await patchSocial({ circle: null, friends: {}, online: 0, party: null });
    await sendToTabs({ type: "party:state", party: null });
    await closeOffscreen();
    return { ok: true, circle: null };
  }
  const next = await patchSocial({ circle: { code: clean, at: Date.now() }, error: "" });
  await syncOffscreen();
  await ensureSocial();
  return { ok: true, circle: next.circle };
}

// ---------------------------------------------------------------
//  6) Messaggi
// ---------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // --- player ---
  if (msg.type === "getContext" && sender.tab) {
    resolveContext(sender.tab).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === "backupNow") {
    doBackup(true).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "saveProgress") {
    saveProgress(msg.key, msg.rec, { force: msg.force }).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "saveProgressMany") {
    onProgressQueue(async () => {
      const { progress = {} } = await chrome.storage.local.get("progress");
      for (const it of Array.isArray(msg.items) ? msg.items : []) {
        if (!it || !it.key || !it.rec) continue;
        const cur = progress[it.key];
        if (!cur || (Number(it.rec.updated) || 0) >= (Number(cur.updated) || 0)) progress[it.key] = { ...it.rec, key: it.key };
      }
      await chrome.storage.local.set({ progress });
      return true;
    }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "deleteProgress") {
    deleteProgress(msg.key).then((ok) => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "progressOne") {
    chrome.storage.local.get("progress").then((d) => sendResponse((d.progress || {})[msg.key] || null), () => sendResponse(null));
    return true;
  }

  // --- letterboxd ---
  if (msg.type === "lbSyncNow") {
    runLbSync(true).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  // --- amici ---
  if (msg.type === "social:me") {
    socialMe(msg.watching, sender);
    return;
  }
  if (msg.type === "social:state" || msg.type === "social:get") {
    getSocial().then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === "social:profile") {
    patchSocial({ me: { ...(msg.me || {}), id: (msg.me && msg.me.id) || newId() } })
      .then(() => syncOffscreen())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "social:circle") {
    socialSetCircle(msg.code).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "social:party:start") {
    socialStartParty(msg.peerId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "social:inviteAccept") {
    socialAcceptInvite(msg.invite, sender.tab).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "social:inviteDecline") {
    getSocial().then((soc) => patchSocial({ invites: [] })).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "social:party:leave") {
    socialLeaveParty().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "party:beat") {
    if (msg.beat) toOffscreen({ type: "soc:beat", beat: msg.beat }, true);
    return;
  }
  if (msg.type === "party:event") {
    if (msg.event) toOffscreen({ type: "soc:event", event: msg.event }, true);
    return;
  }

  // --- dalla stanza offscreen ---
  if (msg.type === "soc:ready") {
    syncOffscreen().then(async () => {
      if (pendingInvite) {
        const inv = pendingInvite;
        const sent = await toOffscreen({ type: "soc:invite", peer: inv.peer, info: inv.info });
        if (sent) pendingInvite = null;
      }
    }).catch(() => {});
    return;
  }
  if (msg.type === "soc:peers") {
    setFriends(msg.peers).catch(() => {});
    return;
  }
  if (msg.type === "soc:party") {
    patchSocial({ party: msg.party || null }).then((soc) => {
      sendToTabs({ type: "party:state", party: soc.party });
    }).catch(() => {});
    return;
  }
  if (msg.type === "soc:partyPeers") {
    getSocial().then((soc) => {
      if (!soc.party) return null;
      return patchSocial({ party: { ...soc.party, peers: Number(msg.count) || 0 } }).then((next) => {
        sendToTabs({ type: "party:state", party: next.party });
      });
    }).catch(() => {});
    return;
  }
  if (msg.type === "soc:needBeat") {
    sendToTabs({ type: "party:beatNow" });
    return;
  }
  if (msg.type === "soc:notice") {
    sendToTabs({ type: "party:notice", text: String(msg.text || "") });
    return;
  }
  if (msg.type === "soc:invite") {
    const invite = msg.invite || {};
    getSocial().then((soc) => {
      const list = (soc.invites || []).filter((i) => i && i.code !== invite.code);
      list.unshift({ ...invite, at: Date.now() });
      return patchSocial({ invites: list.slice(0, 8) });
    }).then(() => {
      sendToTabs({ type: "party:invite", invite });
    }).catch(() => {});
    return;
  }
  if (msg.type === "soc:event") {
    if (msg.event) sendToTabs({ type: "party:event", event: msg.event, from: msg.from || null, at: Date.now() });
    return;
  }
});
