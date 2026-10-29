// Punti di visione: chiavi stabili e ricerca della voce giusta.
// La chiave preferita è quella di TMDB ("movie-603", "tv-1399-s1e2"): non cambia
// se il sito cambia dominio o URL. Restano valide anche le vecchie chiavi "sc:123",
// che vengono trovate e spostate sulla chiave nuova al primo salvataggio.
const Progress = (() => {
  const alive = (r) => (r && !r.deleted && r.status !== "removed" ? r : null);

  function canon(ctx) {
    const t = ctx && ctx.tmdb;
    if (t && t.id && (t.type === "movie" || t.type === "tv")) {
      if (t.type === "movie") return "movie-" + t.id;
      const s = Number(ctx.season) || 0;
      const e = Number(ctx.episode) || 0;
      return "tv-" + t.id + (s || e ? "-s" + s + "e" + e : "");
    }
    return TitleParse.siteKey((ctx && ctx.url) || "");
  }

  function sameTitle(rec, ctx) {
    const a = rec && rec.tmdb;
    const b = ctx && ctx.tmdb;
    if (!a || !b || !a.id || !b.id) return false;
    if (a.type !== b.type || String(a.id) !== String(b.id)) return false;
    if (b.type === "tv") {
      return (Number(rec.season) || 0) === (Number(ctx.season) || 0) &&
        (Number(rec.episode) || 0) === (Number(ctx.episode) || 0);
    }
    return true;
  }

  // Ordine: chiave del sito (la più precisa per QUESTO url), chiave TMDB,
  // poi qualunque voce che parla dello stesso film/episodio.
  function find(all, ctx) {
    all = all || {};
    if (!ctx) return null;
    const sk = TitleParse.siteKey(ctx.url);
    if (alive(all[sk])) return { key: sk, rec: all[sk] };
    const ck = canon(ctx);
    if (alive(all[ck])) return { key: ck, rec: all[ck] };
    for (const [k, v] of Object.entries(all)) {
      if (alive(v) && sameTitle(v, ctx)) return { key: k, rec: v };
    }
    return null;
  }

  // Chiave con cui salvare. Se il titolo è stato corretto a mano non si sposta.
  function targetKey(ctx, prev, prevKey) {
    if (prev && prev.tmdbFixed && prev.tmdb && prevKey) return prevKey;
    return canon(ctx);
  }

  // Unisce la lettura del player con quello che c'era già.
  function build(prev, ctx, data) {
    const fixed = !!(prev && prev.tmdbFixed && prev.tmdb);
    const tmdb = fixed ? prev.tmdb : (ctx.tmdb || (prev && prev.tmdb) || null);
    const season = Number(ctx.season) || Number(prev && prev.season) || 0;
    const episode = Number(ctx.episode) || Number(prev && prev.episode) || 0;
    const duration = Math.max(0, Number(data.duration) || 0);
    const time = Math.max(0, Number(data.time) || 0);
    const finished = data.finished != null
      ? !!data.finished
      : duration > 0 && (time / duration >= 0.95 || duration - time <= 120);
    return {
      key: "",
      url: ctx.url || (prev && prev.url) || "",
      title: String((ctx.title || (prev && prev.title) || "Senza titolo")).trim(),
      tmdb,
      tmdbFixed: fixed,
      season,
      episode,
      time,
      duration,
      finished: finished && time > 0,
      updated: Date.now(),
    };
  }

  return { alive, canon, sameTitle, find, targetKey, build };
})();
if (typeof globalThis !== "undefined" && !globalThis.Progress) globalThis.Progress = Progress;
