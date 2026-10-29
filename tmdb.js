// Piccolo client per le API di TMDB (https://www.themoviedb.org).
// Accetta sia la "Chiave API (v3)" sia il "Token di lettura (v4)".
const TMDB = (() => {
  const BASE = "https://api.themoviedb.org/3";
  const IMG = "https://image.tmdb.org/t/p";
  const cache = new Map();
  let apiKey = "";

  const setKey = (k) => {
    apiKey = (k || "").trim();
    cache.clear();
  };
  const hasKey = () => !!apiKey;
  const img = (path, size = "w342") => (path ? `${IMG}/${size}${path}` : "");

  async function get(path, params = {}, opts = {}) {
    if (!apiKey) throw new Error("NO_KEY");
    const url = new URL(BASE + path);
    url.searchParams.set("language", "it-IT");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const cacheKey = url.toString();
    if (!opts.nocache && cache.has(cacheKey)) return cache.get(cacheKey);

    const headers = { Accept: "application/json" };
    if (apiKey.length > 40) headers.Authorization = `Bearer ${apiKey}`;
    else url.searchParams.set("api_key", apiKey);

    const p = (async () => {
      for (let i = 0; i < 4; i++) {
        const res = await fetch(url.toString(), { headers });
        if (res.status === 429) { // troppe richieste: aspetta e riprova
          await new Promise((r) => setTimeout(r, (Number(res.headers.get("Retry-After")) || 1) * 1000));
          continue;
        }
        if (res.status === 401) throw new Error("BAD_KEY");
        if (!res.ok) throw new Error("HTTP_" + res.status);
        return res.json();
      }
      throw new Error("HTTP_429");
    })();
    if (!opts.nocache) {
      cache.set(cacheKey, p);
      p.catch(() => cache.delete(cacheKey));
    }
    return p;
  }

  // Normalizza un risultato TMDB (film o serie) in un formato unico
  function norm(r, type) {
    type = type || r.media_type;
    const isMovie = type === "movie";
    const date = isMovie ? r.release_date : r.first_air_date;
    return {
      key: `${type}-${r.id}`,
      id: r.id,
      type,
      title: (isMovie ? r.title : r.name) || "Senza titolo",
      originalTitle: (isMovie ? r.original_title : r.original_name) || "",
      genreIds: r.genre_ids || [],
      year: date ? date.slice(0, 4) : "",
      poster: r.poster_path || null,
      backdrop: r.backdrop_path || null,
      overview: r.overview || "",
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : 0,
      votes: r.vote_count || 0,
    };
  }

  const onlyTitles = (list, type) =>
    (list || [])
      .filter((r) => (type || r.media_type) === "movie" || (type || r.media_type) === "tv")
      .map((r) => norm(r, type));

  async function search(query) {
    const r = await get("/search/multi", { query, include_adult: "false" });
    return onlyTitles(r.results);
  }

  async function trending() {
    const r = await get("/trending/all/week");
    return onlyTitles(r.results);
  }

  async function topRated(type) {
    const r = await get(`/${type}/top_rated`);
    return onlyTitles(r.results, type);
  }

  // id esterni (IMDb): servono per trovare il film su Letterboxd
  async function externalIds(type, id) {
    const r = await get(`/${type}/${id}/external_ids`);
    return { imdb_id: r.imdb_id || "", tvdb_id: r.tvdb_id || 0 };
  }

  async function recommendations(type, id) {
    const r = await get(`/${type}/${id}/recommendations`);
    return onlyTitles(r.results, type);
  }

  async function details(type, id) {
    const r = await get(`/${type}/${id}`, {
      append_to_response: "credits,videos,watch/providers",
      include_video_language: "it,en,null",
    });
    const base = norm(r, type);
    const credits = r.credits || {};
    const crew = credits.crew || [];
    const directors =
      type === "movie"
        ? crew.filter((c) => c.job === "Director").map((c) => c.name)
        : (r.created_by || []).map((c) => c.name);
    const cast = (credits.cast || []).slice(0, 12).map((c) => ({
      name: c.name,
      character: c.character || "",
      photo: c.profile_path || null,
    }));
    const vids = ((r.videos && r.videos.results) || []).filter((v) => v.site === "YouTube");
    const trailer =
      vids.find((v) => v.type === "Trailer" && v.iso_639_1 === "it") ||
      vids.find((v) => v.type === "Trailer") ||
      vids.find((v) => v.type === "Teaser") ||
      null;
    const prov =
      (r["watch/providers"] && r["watch/providers"].results && r["watch/providers"].results.IT) ||
      null;

    return {
      ...base,
      tagline: r.tagline || "",
      genres: (r.genres || []).map((g) => g.name),
      runtime: type === "movie" ? r.runtime || 0 : (r.episode_run_time && r.episode_run_time[0]) || 0,
      seasons: r.number_of_seasons || 0,
      episodes: r.number_of_episodes || 0,
      airStatus: r.status || "",
      directors,
      cast,
      trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : "",
      providers: prov
        ? {
            link: prov.link || "",
            flatrate: prov.flatrate || [],
            rent: prov.rent || [],
            buy: prov.buy || [],
          }
        : null,
    };
  }

  const plain = (s) =>
    String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const likeness = (a, b) => {
    a = plain(a); b = plain(b);
    if (!a || !b) return 0;
    if (a === b) return 3;
    if (a.startsWith(b) || b.startsWith(a)) return 2;
    return a.includes(b) || b.includes(a) ? 1 : 0;
  };
  const lite = (n) => ({
    key: n.key, id: n.id, type: n.type, title: n.title, year: n.year,
    poster: n.poster, backdrop: n.backdrop, rating: n.rating,
  });
  const titleLike = (c, title) => Math.max(likeness(title, c.title), likeness(title, c.originalTitle));

  // Punteggio di un candidato rispetto a ciò che si cerca: titolo, anno e popolarità.
  // Così "Batman" senza anno sceglie il film del 1989 (tanti voti) e non quello degli anni '60.
  function score(c, title, year, preferMovie) {
    let s = titleLike(c, title) * 10;
    if (year && c.year) {
      const d = Math.abs(Number(year) - Number(c.year));
      s += d === 0 ? 12 : d === 1 ? 6 : -4 - Math.min(d, 10);
    }
    s += Math.log10((c.votes || 0) + 1) * 3;
    if (preferMovie && c.type === "movie") s += 2;
    return s;
  }
  function rank(list, title, year, preferMovie) {
    return list
      .map((c) => ({ c, s: score(c, title, year, preferMovie) }))
      .sort((a, b) => b.s - a.s);
  }
  const searchList = async (type, q, opts) =>
    ((await get(`/search/${type}`, { include_adult: "false", ...q }, opts)).results || []).map((r) => norm(r, type));

  // Capisce di che titolo si tratta partendo da ciò che si legge sulla pagina.
  // Con un id TMDB è una corrispondenza esatta, altrimenti si confrontano TUTTI i candidati.
  async function identify({ title, year, type, tmdbId }) {
    if (tmdbId && (type === "movie" || type === "tv")) {
      try {
        return { ...lite(norm(await get(`/${type}/${tmdbId}`), type)), exact: true };
      } catch (e) {
        if (e.message === "BAD_KEY" || e.message === "NO_KEY") throw e;
      }
    }
    if (!title) return null;
    const types = type === "movie" || type === "tv" ? [type] : ["movie", "tv"];
    const pool = new Map();
    for (const t of types) {
      const q = { query: title };
      if (year) q[t === "movie" ? "year" : "first_air_date_year"] = year;
      let list = await searchList(t, q);
      // l'anno della pagina può mancare o differire da TMDB: aggiungo anche i risultati senza filtro
      if (year) list = list.concat(await searchList(t, { query: title }));
      for (const c of list.slice(0, 20)) if (!pool.has(c.key)) pool.set(c.key, c);
    }
    const top = rank([...pool.values()], title, year, !type)[0];
    return top ? { ...lite(top.c), exact: false } : null;
  }

  // Cerca un film per nome + anno (usato dall'import Letterboxd). Restituisce null se non è sicuro.
  async function matchFilm(name, year) {
    year = Number(year) || 0;
    const seen = new Map();
    const accepted = (c) => {
      const dy = year && c.year ? Math.abs(year - Number(c.year)) : 0;
      const l = titleLike(c, name);
      return dy <= 1 && (l >= 1 || (year && dy === 0));
    };
    const attempts = [
      { q: year ? { query: name, year } : { query: name } },
      { q: { query: name }, skip: !year },
      { q: year ? { query: name, year, language: "en-US" } : { query: name, language: "en-US" } },
    ];
    for (const a of attempts) {
      if (a.skip) continue;
      for (const c of await searchList("movie", a.q, { nocache: true })) if (!seen.has(c.key)) seen.set(c.key, c);
      const top = rank([...seen.values()].filter(accepted), name, year, true)[0];
      if (top && titleLike(top.c, name) >= 2) return top.c; // titolo (quasi) identico: basta
    }
    const top = rank([...seen.values()].filter(accepted), name, year, true)[0];
    return top ? top.c : null;
  }

  // Tutto ciò che serve a capire i gusti di un titolo (versione 2): generi, registi, cast,
  // sceneggiatori, musiche, fotografia, temi (parole chiave), produzione, lingua, paese,
  // anno, durata, voto, saga. Risposta compatta, non in cache.
  async function tasteOf(type, id) {
    const r = await get(`/${type}/${id}`, { append_to_response: "credits,keywords" }, { nocache: true });
    const credits = r.credits || {};
    const crew = credits.crew || [];
    const uniq = (arr, n) => {
      const seen = new Set();
      return (arr || []).filter((p) => p && !seen.has(p.id) && seen.add(p.id)).slice(0, n).map((p) => [p.id, p.name]);
    };
    const dirs = type === "movie" ? crew.filter((c) => c.job === "Director") : r.created_by || [];
    const writers = type === "movie" ? crew.filter((c) => /^(Screenplay|Writer|Story|Novel)$/.test(c.job)) : [];
    const composers = crew.filter((c) => c.job === "Original Music Composer" || c.job === "Composer");
    const dps = crew.filter((c) => c.job === "Director of Photography");
    const kw = r.keywords ? (type === "movie" ? r.keywords.keywords : r.keywords.results) || [] : [];
    const date = type === "movie" ? r.release_date : r.first_air_date;
    const countries = type === "movie" ? (r.production_countries || []).map((c) => c.iso_3166_1) : r.origin_country || [];
    return {
      base: norm(r, type),
      taste: {
        v: 2,
        g: (r.genres || []).map((g) => g.id),
        d: uniq(dirs, 3),
        c: (credits.cast || []).slice(0, 5).map((p) => [p.id, p.name]),
        w: uniq(writers, 2),
        m: uniq(composers, 1),
        p: uniq(dps, 1),
        k: kw.slice(0, 10).map((k) => [k.id, k.name]),
        co: (r.production_companies || []).slice(0, 3).map((c) => [c.id, c.name]),
        l: r.original_language || "",
        n: countries.slice(0, 2),
        y: date ? Number(date.slice(0, 4)) || 0 : 0,
        r: type === "movie" ? r.runtime || 0 : (r.episode_run_time && r.episode_run_time[0]) || 0,
        a: Math.round((r.vote_average || 0) * 10) / 10,
        o: r.vote_count || 0,
        f: (r.belongs_to_collection && r.belongs_to_collection.id) || 0,
      },
    };
  }

  // Film diretti / interpretati (da protagonista) da una persona
  async function personFilms(personId, role) {
    const r = await get(`/person/${personId}/movie_credits`);
    const list = role === "director"
      ? (r.crew || []).filter((c) => c.job === "Director")
      : (r.cast || []).filter((c) => c.order === undefined || c.order < 6);
    const seen = new Set();
    return list
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .map((c) => norm(c, "movie"));
  }

  async function discover(type, params) {
    const r = await get(`/discover/${type}`, { include_adult: "false", ...params });
    return onlyTitles(r.results, type);
  }

  let genreMap = null;
  async function genreNames() {
    if (genreMap) return genreMap;
    const [m, t] = await Promise.all([get("/genre/movie/list"), get("/genre/tv/list")]);
    const map = {};
    for (const g of [...(t.genres || []), ...(m.genres || [])]) map[g.id] = g.name;
    return (genreMap = map);
  }

  return { setKey, hasKey, img, get, norm, search, trending, topRated, recommendations, externalIds, details, identify, matchFilm, tasteOf, personFilms, discover, genreNames, likeness };
})();
