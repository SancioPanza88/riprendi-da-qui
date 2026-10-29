// Motore dei consigli. Nessun accesso alla rete né al DOM: riceve la tua libreria e i
// candidati, restituisce punteggi spiegabili. Tutti i criteri e i pesi sono qui sotto
// (CRITERIA / PARAMS / PRESETS) e nella dashboard diventano cursori regolabili.
const Reco = (() => {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const decadeOf = (y) => (y ? Math.floor(y / 10) * 10 : 0);
  const YEAR_MS = 365.25 * 864e5;

  // ---------------------------------------------------------------
  //  Criteri (pesi) e parametri: id, gruppo, testo, intervallo, valore di partenza
  // ---------------------------------------------------------------
  const GROUPS = {
    taste: "Cosa ti piace",
    context: "Epoca, paese e durata",
    quality: "Qualità e popolarità",
    list: "Come costruisco la lista",
    reading: "Come leggo i tuoi dati",
  };

  const CRITERIA = [
    { id: "similar", g: "taste", label: "Simili ai tuoi preferiti", hint: "Titoli che TMDB collega a quelli che hai amato o messo in watchlist.", min: 0, max: 3, step: 0.1, def: 1.2 },
    { id: "director", g: "taste", label: "Registi", hint: "Registi (o creatori di serie) dei titoli che ti sono piaciuti.", min: 0, max: 3, step: 0.1, def: 1.6 },
    { id: "cast", g: "taste", label: "Attori", hint: "Protagonisti ricorrenti nei film che ami.", min: 0, max: 3, step: 0.1, def: 0.8 },
    { id: "crew", g: "taste", label: "Sceneggiatori, musiche, fotografia", hint: "Chi ha scritto, composto la colonna sonora o curato la fotografia.", min: 0, max: 3, step: 0.1, def: 0.4 },
    { id: "studio", g: "taste", label: "Casa di produzione", hint: "Studi che firmano film che ti piacciono (A24, Ghibli, Pixar…).", min: 0, max: 3, step: 0.1, def: 0.3 },
    { id: "genre", g: "taste", label: "Generi e combinazioni", hint: "Generi singoli e coppie (es. thriller + fantascienza).", min: 0, max: 3, step: 0.1, def: 1.2 },
    { id: "themes", g: "taste", label: "Temi e parole chiave", hint: "Argomenti ricorrenti nei tuoi film (colpo grosso, viaggio nel tempo, vendetta…).", min: 0, max: 3, step: 0.1, def: 1.0 },
    { id: "franchise", g: "taste", label: "Saghe che segui", hint: "Titoli che fanno parte di una saga di cui hai già visto e apprezzato dei capitoli.", min: 0, max: 3, step: 0.1, def: 0.5 },
    { id: "era", g: "context", label: "Epoca preferita", hint: "Il decennio in cui escono i film che ti piacciono di più.", min: 0, max: 3, step: 0.1, def: 0.5 },
    { id: "origin", g: "context", label: "Paese e lingua", hint: "Cinema coreano, francese, italiano… se ti piace, lo premio.", min: 0, max: 3, step: 0.1, def: 0.4 },
    { id: "runtime", g: "context", label: "Durata", hint: "Premia i film con una durata vicina a quella che di solito scegli.", min: 0, max: 3, step: 0.1, def: 0.3 },
    { id: "quality", g: "quality", label: "Voto del pubblico", hint: "Voto TMDB corretto dal numero di voti. Si adatta da solo a quanto i tuoi voti seguono quelli del pubblico.", min: 0, max: 3, step: 0.1, def: 1.0 },
    { id: "gems", g: "quality", label: "Titoli famosi ↔ gemme poco conosciute", hint: "Verso destra premia i film poco visti; verso sinistra i più popolari.", min: -2, max: 2, step: 0.1, def: 0.3, bipolar: true },
    { id: "fresh", g: "quality", label: "Vecchi classici ↔ uscite recenti", hint: "Verso destra premia le novità; verso sinistra i classici.", min: -2, max: 2, step: 0.1, def: 0, bipolar: true },
  ];

  const PARAMS = [
    { id: "diversity", g: "list", label: "Varietà", hint: "Evita una lista piena di titoli quasi identici (stesso regista, stessi generi).", min: 0, max: 2, step: 0.1, def: 0.8 },
    { id: "penalty", g: "list", label: "Severità su ciò che non ami", hint: "Quanto pesano registi, attori e generi legati a film che ti sono piaciuti poco.", min: 0, max: 2, step: 0.1, def: 1 },
    { id: "minVotes", g: "list", label: "Voti minimi su TMDB", hint: "Scarta i titoli con troppi pochi voti per essere affidabili.", min: 0, max: 3000, step: 50, def: 150, fmt: "int" },
    { id: "watchlistW", g: "reading", label: "Peso della watchlist", hint: "Quanto conta un titolo che hai solo messo da parte (non ancora visto).", min: 0, max: 1.5, step: 0.1, def: 0.7 },
    { id: "unratedW", g: "reading", label: "Peso dei visti senza voto", hint: "Un film segnato come visto ma senza stelle.", min: 0, max: 1.5, step: 0.1, def: 0.9 },
    { id: "likeBonus", g: "reading", label: "Bonus per i cuori", hint: "Extra per i film che hai segnato con il cuore su Letterboxd.", min: 0, max: 2, step: 0.1, def: 1 },
    { id: "halfLife", g: "reading", label: "I gusti recenti contano di più", hint: "Emivita in anni: un film visto N anni fa conta la metà. 0 = tutti uguali.", min: 0, max: 15, step: 1, def: 6, fmt: "years" },
    { id: "calibrate", g: "reading", type: "bool", label: "Calibra i miei voti", hint: "Se tendi a dare voti generosi o severi, ne tengo conto.", def: true },
  ];

  const PRESETS = [
    { id: "balanced", label: "Equilibrato", v: {} },
    { id: "faithful", label: "Fedele ai miei gusti", v: { similar: 1.6, director: 2.2, cast: 1.2, genre: 1.6, themes: 1.4, quality: 0.6, gems: 0, diversity: 0.4 } },
    { id: "discovery", label: "Scoperta", v: { similar: 0.8, director: 1.0, cast: 0.5, genre: 0.8, themes: 0.7, quality: 1.0, gems: 1.0, era: 0.2, origin: 0.1, diversity: 1.6 } },
    { id: "masterpieces", label: "Capolavori", v: { quality: 2.4, gems: -0.6, director: 1.2, genre: 0.8, minVotes: 1500 } },
    { id: "hidden", label: "Gemme nascoste", v: { quality: 1.2, gems: 2, themes: 1.4, diversity: 1.2, minVotes: 80 } },
    { id: "recent", label: "Novità", v: { fresh: 1.6, quality: 1.0, era: 0, minVotes: 100 } },
  ];

  const DEFAULTS = Object.fromEntries([...CRITERIA, ...PARAMS].map((c) => [c.id, c.def]));

  // Valori effettivi: i predefiniti + ciò che hai cambiato tu
  function resolve(saved) {
    const P = { ...DEFAULTS };
    for (const [k, v] of Object.entries((saved && saved.v) || {})) if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) P[k] = v;
    return P;
  }

  // Parole chiave troppo generiche per dire qualcosa sui gusti
  const GENERIC_KW = new Set(["aftercreditsstinger", "duringcreditsstinger", "woman director", "sequel", "remake", "based on novel or book", "based on comic", "based on comic book", "reboot", "3d", "imax"]);

  // ---------------------------------------------------------------
  //  Profilo dei gusti
  // ---------------------------------------------------------------
  // `prior`: quanta evidenza serve prima di fidarsi di una caratteristica (più alto = più prudente).
  // Le caratteristiche "relative" (generi, temi, epoche…) si confrontano con la media di tutto ciò che
  // hai guardato: se ami il 60% di drammi non ti dice nulla; se ami l'unico western sì.
  const PRIOR = { g: 3, gp: 3, k: 4, d: 1.5, c: 2, w: 2, m: 2, p: 2, co: 3, dec: 3, lang: 4, cn: 4 };
  const RELATIVE = new Set(["g", "gp", "k", "co", "dec", "lang", "cn"]);

  function makeWeigher(lib, P) {
    let pivot = 2.25;
    if (P.calibrate) {
      const st = Object.values(lib).filter((e) => e && e.status === "watched" && e.stars > 0).map((e) => e.stars);
      if (st.length >= 10) {
        const m = st.reduce((a, b) => a + b, 0) / st.length;
        pivot = 2.25 + clamp(m - 3.5, -0.5, 0.75) * 0.6; // voti generosi: 4★ vale meno
      }
    }
    const now = Date.now();
    // quanto un titolo "dice" dei tuoi gusti (positivo = ti piace, negativo = no)
    const weight = (e) => {
      if (!e || e.status === "removed") return 0;
      if (e.status === "watchlist") return P.watchlistW;
      if (e.status !== "watched") return 0;
      const s = e.stars || 0;
      let w = !s ? P.unratedW : s <= 2 ? -0.4 - (2 - s) * 0.4 : (s - pivot) * 1.2;
      if (e.liked) w += P.likeBonus;
      return w;
    };
    // quanto è "fresco" quel dato (i gusti recenti pesano di più)
    const evidence = (e) => {
      if (!(P.halfLife > 0)) return 1;
      const t = (e && (e.watchedAt || e.added)) || now;
      const age = Math.max(0, (now - t) / YEAR_MS);
      return Math.max(0.3, Math.pow(0.5, age / P.halfLife));
    };
    return { weight, evidence, pivot };
  }

  function build(lib, P) {
    const W = makeWeigher(lib, P);
    const F = {};
    for (const k of Object.keys(PRIOR)) F[k] = new Map();
    const col = new Map();
    let totS = 0, totN = 0;

    const add = (type, id, name, w, ev) => {
      if (id == null || id === "" || id === 0) return;
      let x = F[type].get(id);
      if (!x) { x = { id, name: name || "", s: 0, n: 0, raw: 0 }; F[type].set(id, x); }
      x.s += w * ev; x.n += ev; x.raw++;
    };

    const rated = [];
    let runN = 0, runS = 0, runQ = 0;
    const runs = [];
    for (const e of Object.values(lib)) {
      const w = W.weight(e);
      const t = e && e.taste;
      if (!w || !t) continue;
      const ev = W.evidence(e);
      totS += w * ev; totN += ev;

      const gs = t.g || [];
      for (const id of gs) add("g", id, "", w, ev);
      const g3 = gs.slice(0, 3);
      for (let i = 0; i < g3.length; i++) for (let j = i + 1; j < g3.length; j++) {
        const a = Math.min(g3[i], g3[j]), b = Math.max(g3[i], g3[j]);
        add("gp", a + "-" + b, "", w, ev);
      }
      for (const [id, name] of t.d || []) add("d", id, name, w, ev);
      (t.c || []).forEach(([id, name], i) => add("c", id, name, w, i < 3 ? ev : ev * 0.5));
      for (const [id, name] of t.w || []) add("w", id, name, w, ev);
      for (const [id, name] of t.m || []) add("m", id, name, w, ev);
      for (const [id, name] of t.p || []) add("p", id, name, w, ev);
      for (const [id, name] of t.k || []) if (!GENERIC_KW.has(String(name).toLowerCase())) add("k", id, name, w, ev);
      for (const [id, name] of t.co || []) add("co", id, name, w, ev);
      if (t.y) {
        const d = decadeOf(t.y);
        add("dec", d, "", w, ev);
        add("dec", d - 10, "", w, ev * 0.35);
        add("dec", d + 10, "", w, ev * 0.35);
      }
      if (t.l) add("lang", t.l, "", w, ev);
      for (const c of t.n || []) add("cn", c, "", w, ev);
      if (t.f) col.set(t.f, (col.get(t.f) || 0) + w * ev);
      if (w > 0.5 && t.r > 0 && e.type === "movie") { runs.push([t.r, w * ev]); }
      if (e.status === "watched" && e.stars > 0 && t.a > 0 && (t.o || 0) >= 50) rated.push([e.stars, t.a]);
    }
    const mu = totN > 0 ? totS / totN : 0;

    // durata abituale (media e dispersione pesate)
    let rt = null;
    if (runs.length >= 8) {
      const sw = runs.reduce((a, [, w]) => a + w, 0);
      const mean = runs.reduce((a, [r, w]) => a + r * w, 0) / sw;
      const sd = Math.sqrt(runs.reduce((a, [r, w]) => a + w * (r - mean) ** 2, 0) / sw);
      rt = { mean, sd };
    }

    // quanto i tuoi voti seguono quelli del pubblico (correlazione) → moltiplicatore del criterio "qualità"
    let corr = null, qf = 1;
    if (rated.length >= 15) {
      const n = rated.length;
      const mx = rated.reduce((a, [x]) => a + x, 0) / n, my = rated.reduce((a, [, y]) => a + y, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (const [x, y] of rated) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      if (sxx > 0 && syy > 0) { corr = sxy / Math.sqrt(sxx * syy); qf = clamp(1 + 1.2 * corr, 0.4, 1.6); }
    }
    const stars = Object.values(lib).filter((e) => e && e.status === "watched" && e.stars > 0).map((e) => e.stars);
    const meanStars = stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : 0;

    // affinità di una caratteristica, da -1 (la eviti) a +1 (la cerchi)
    const aff = (type, id) => {
      const x = F[type] && F[type].get(id);
      if (!x || x.n <= 0) return 0;
      const mean = x.s / x.n;
      const base = RELATIVE.has(type) ? mu * 0.6 : 0;
      const conf = x.n / (x.n + PRIOR[type]);
      return conf * Math.tanh((mean - base) / 1.4);
    };
    const top = (type, n, minA = 0.2) =>
      [...F[type].values()]
        .map((x) => ({ id: x.id, name: x.name, n: x.raw, a: aff(type, x.id) }))
        .filter((x) => x.a >= minA)
        .sort((a, b) => b.a - a.a)
        .slice(0, n);
    const colAff = (id) => clamp((col.get(id) || 0) / 2.5, -1, 1);

    const count = Object.values(lib).filter((e) => e && e.taste && W.weight(e) !== 0).length;
    return { aff, top, colAff, hasCol: (id) => col.has(id), rt, qf, corr, meanStars, mu, count, weight: W.weight, evidence: W.evidence, pivot: W.pivot };
  }

  // ---------------------------------------------------------------
  //  Punteggio di un candidato
  // ---------------------------------------------------------------
  // c = { item, seed, seeds[], srcDirs[{a,name}], srcCast[{a,name}] }; t = taste v2 (o null: pre-selezione)
  function aggregate(arr, penalty) {
    let keep = 1, neg = 0, best = null;
    for (const x of arr) {
      if (x.a > 0) { keep *= 1 - x.a; if (!best || x.a > best.a) best = x; }
      else if (x.a < 0) neg = Math.max(neg, -x.a);
    }
    return { v: clamp(1 - keep - neg * penalty, -1, 1), best, pos: arr.filter((x) => x.a > 0.12).sort((a, b) => b.a - a.a) };
  }

  const bayes = (rating, votes) => {
    const m = 300, C = 6.3;
    return ((votes || 0) * (rating || 0) + m * C) / ((votes || 0) + m);
  };

  function comps(c, t, prof, P, names) {
    const it = c.item;
    const out = {};
    const pen = P.penalty;
    const votes = it.votes != null ? it.votes : t && t.o != null ? t.o : null;
    const rating = it.rating || (t && t.a) || 0;
    const year = (t && t.y) || Number(it.year) || 0;

    // 1) simili
    out.similar = {
      v: clamp((c.seed || 0) / 4, 0, 1),
      txt: c.seeds && c.seeds.length ? `Simile a «${c.seeds[0]}»${c.seeds.length > 1 ? ` +${c.seeds.length - 1}` : ""}` : "",
    };

    // 2) registi
    const dArr = t ? (t.d || []).map(([id, name]) => ({ a: prof.aff("d", id), name })) : c.srcDirs || [];
    const dg = aggregate(dArr, pen);
    out.director = { v: dg.v, txt: dg.best && dg.best.a > 0.12 ? "Regia di " + dg.best.name : "" };

    // 3) attori (i primi tre in locandina contano di più)
    const cArr = t ? (t.c || []).map(([id, name], i) => ({ a: prof.aff("c", id) * (i < 3 ? 1 : 0.6), name })) : c.srcCast || [];
    const cg = aggregate(cArr, pen * 0.5);
    out.cast = { v: cg.v, txt: cg.pos.length ? "Con " + cg.pos.slice(0, 2).map((x) => x.name).join(", ") : "" };

    // 4) sceneggiatori, musiche, fotografia
    if (t) {
      const roles = [["w", "Scritto da "], ["m", "Musiche di "], ["p", "Fotografia di "]];
      const arr = [];
      for (const [k, lbl] of roles) for (const [id, name] of t[k] || []) arr.push({ a: prof.aff(k, id), name, lbl });
      const g = aggregate(arr, pen * 0.5);
      out.crew = { v: g.v, txt: g.best && g.best.a > 0.2 ? g.best.lbl + g.best.name : "" };

      // 5) casa di produzione
      const sg = aggregate((t.co || []).map(([id, name]) => ({ a: prof.aff("co", id), name })), pen * 0.5);
      out.studio = { v: sg.v, txt: sg.best && sg.best.a > 0.25 ? "Prodotto da " + sg.best.name : "" };
    }

    // 6) generi (singoli + coppie)
    const gids = (t ? t.g : it.genreIds) || [];
    if (gids.length) {
      const singles = gids.map((id) => ({ id, a: prof.aff("g", id) }));
      const mean = singles.reduce((s, x) => s + x.a, 0) / singles.length;
      const g3 = gids.slice(0, 3);
      let pair = null;
      for (let i = 0; i < g3.length; i++) for (let j = i + 1; j < g3.length; j++) {
        const a = prof.aff("gp", Math.min(g3[i], g3[j]) + "-" + Math.max(g3[i], g3[j]));
        pair = pair == null ? a : Math.max(pair, a);
      }
      let v = pair == null ? mean : 0.55 * mean + 0.45 * pair;
      if (v < 0) v *= pen;
      const liked = singles.filter((x) => x.a > 0.2).sort((a, b) => b.a - a.a).map((x) => names.genre(x.id)).filter(Boolean);
      out.genre = { v: clamp(v, -1, 1), txt: liked.length ? "Generi che ami: " + liked.slice(0, 2).join(", ") : "" };
    }

    // 7) temi
    if (t && t.k && t.k.length) {
      const arr = t.k.filter(([, n]) => !GENERIC_KW.has(String(n).toLowerCase())).map(([id, name]) => ({ a: prof.aff("k", id), name }));
      const pos = arr.filter((x) => x.a > 0).sort((a, b) => b.a - a.a);
      const neg = arr.reduce((m, x) => Math.max(m, -x.a), 0);
      const s = (pos[0] ? pos[0].a : 0) + (pos[1] ? 0.7 * pos[1].a : 0) + (pos[2] ? 0.5 * pos[2].a : 0);
      out.themes = { v: clamp(s / 1.5, 0, 1) - neg * 0.5 * pen, txt: pos.length && pos[0].a > 0.15 ? "Temi: " + pos.slice(0, 2).map((x) => x.name).join(", ") : "" };
    }

    // 8) saga
    if (t && t.f && prof.hasCol(t.f)) {
      const v = prof.colAff(t.f);
      out.franchise = { v, txt: v > 0.2 ? "Fa parte di una saga che segui" : "" };
    }

    // 9) epoca
    if (year) {
      const d = decadeOf(year);
      const a = prof.aff("dec", d);
      out.era = { v: a, txt: a > 0.25 ? `Anni ${d}` : "" };
    }

    // 10) paese e lingua
    if (t && (t.l || (t.n && t.n.length))) {
      const al = t.l ? prof.aff("lang", t.l) : 0;
      const ac = (t.n || []).reduce((m, c) => Math.max(m, prof.aff("cn", c)), -1);
      const v = t.n && t.n.length ? (al + (ac === -1 ? 0 : ac)) / 2 : al;
      const nm = t.l && t.l !== "en" ? names.lang(t.l) : "";
      out.origin = { v, txt: v > 0.25 && nm ? "Cinema in " + nm : "" };
    }

    // 11) durata
    if (t && t.r && prof.rt && it.type === "movie") {
      const z = (t.r - prof.rt.mean) / (prof.rt.sd + 15);
      const v = 2 * Math.exp(-0.5 * z * z) - 1;
      out.runtime = { v, txt: v > 0.6 ? "Durata nelle tue corde" : "" };
    }

    // 12) qualità
    if (rating) {
      const q = bayes(rating, votes == null ? 1000 : votes);
      const v = clamp(clamp((q - 6.4) / 1.5, -1, 1) * prof.qf, -1, 1);
      out.quality = { v, txt: v > 0.45 ? `Molto apprezzato (${Number(rating).toFixed(1)})` : "" };
    }

    // 13) popolarità ↔ gemme
    if (votes != null) {
      const v = clamp((4.1 - Math.log10(votes + 1)) / 1.2, -1, 1);
      out.gems = { v, txt: P.gems > 0 && v > 0.5 ? "Gemma poco conosciuta" : P.gems < 0 && v < -0.4 ? "Un titolo molto popolare" : "" };
    }

    // 14) novità ↔ classici
    if (year) {
      const v = clamp((year - 1998) / 22, -1, 1);
      out.fresh = { v, txt: P.fresh > 0 && v > 0.5 ? "Uscita recente" : P.fresh < 0 && v < -0.3 ? "Un classico" : "" };
    }
    return out;
  }

  function score(c, t, prof, P, names) {
    const parts = comps(c, t, prof, P, names);
    let raw = 0, D = 0;
    const list = [];
    for (const [id, p] of Object.entries(parts)) {
      const w = P[id];
      if (!w || p.v == null || Number.isNaN(p.v)) continue;
      const contrib = w * p.v;
      raw += contrib; D += Math.abs(w);
      list.push({ id, v: p.v, w, contrib, txt: p.txt });
    }
    const frac = D > 0 ? raw / D : 0;
    const pct = clamp(Math.round(50 + 50 * Math.tanh(2.2 * frac)), 1, 99);
    const reasons = list.filter((x) => x.contrib > 0.05 && x.txt).sort((a, b) => b.contrib - a.contrib).slice(0, 3).map((x) => x.txt);
    return { pct, raw, frac, parts: list, reason: reasons.join(" · ") };
  }

  // ---------------------------------------------------------------
  //  Scelta finale con varietà (evita 10 film quasi uguali)
  // ---------------------------------------------------------------
  const jacc = (a, b) => {
    if (!a.size || !b.size) return 0;
    let i = 0;
    for (const x of a) if (b.has(x)) i++;
    return i / (a.size + b.size - i);
  };
  function sig(c, t) {
    const it = c.item;
    return {
      g: new Set((t ? t.g : it.genreIds) || []),
      d: new Set(t ? (t.d || []).map((x) => x[0]) : []),
      k: new Set(t ? (t.k || []).map((x) => x[0]) : []),
      f: t && t.f ? t.f : 0,
    };
  }
  function similarity(a, b) {
    if (a.f && a.f === b.f) return 1;
    for (const d of a.d) if (b.d.has(d)) return 0.9;
    return 0.6 * jacc(a.g, b.g) + 0.4 * jacc(a.k, b.k);
  }
  function select(list, n, P) {
    const pool = [...list].sort((a, b) => b.pct - a.pct || b.raw - a.raw);
    const chosen = [];
    while (chosen.length < n && pool.length) {
      let bi = 0, bv = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        let sim = 0;
        for (const s of chosen) sim = Math.max(sim, similarity(pool[i].sig, s.sig));
        const v = pool[i].pct + pool[i].raw * 0.01 - P.diversity * 14 * sim;
        if (v > bv) { bv = v; bi = i; }
      }
      chosen.push(pool.splice(bi, 1)[0]);
    }
    return chosen;
  }

  return { CRITERIA, PARAMS, PRESETS, GROUPS, DEFAULTS, resolve, build, score, sig, select, decadeOf, GENERIC_KW };
})();
if (typeof module !== "undefined") module.exports = Reco;
