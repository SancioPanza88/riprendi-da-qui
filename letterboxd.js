// Lettura dell'esportazione di Letterboxd (Impostazioni → Dati → "Esporta i tuoi dati").
// È uno ZIP con vari CSV: watched, ratings, watchlist, diary, likes/films.
// Niente librerie: lo ZIP si apre con DecompressionStream, integrato in Chrome.
const Letterboxd = (() => {
  // ---------- CSV (gestisce virgolette, virgole e a capo dentro le celle) ----------
  function parseCSV(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = ""; rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    const head = (rows.shift() || []).map((s) => s.trim());
    return rows
      .filter((r) => r.some((c) => c !== ""))
      .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] === undefined ? "" : r[i]).trim()])));
  }

  // ---------- ZIP ----------
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Restituisce { "percorso/minuscolo.csv": "testo" } per i soli file .csv
  async function readZip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("BAD_ZIP");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder("utf-8");
    const out = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("BAD_ZIP");
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/\.csv$/i.test(name) || /^__MACOSX\//.test(name)) continue;
      const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(dataStart, dataStart + csize);
      const bytes = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
      if (bytes) out[name.toLowerCase()] = dec.decode(bytes);
    }
    return out;
  }

  // ---------- da CSV a elenco di film ----------
  // files: { nomefile: testo }. Funziona sia con lo zip intero sia con i singoli CSV.
  function plan(files) {
    const find = (...names) => {
      for (const n of names) {
        const k = Object.keys(files).find((f) => f === n || f.endsWith("/" + n));
        if (k) return parseCSV(files[k]);
      }
      return [];
    };
    const watched = find("watched.csv");
    const ratings = find("ratings.csv");
    const diary = find("diary.csv");
    const watchlist = find("watchlist.csv");
    const likes = find("likes/films.csv", "films.csv");

    const map = new Map();
    const ts = (s) => { const t = Date.parse(s); return isNaN(t) ? 0 : t; };
    const ent = (r) => {
      if (!r.Name) return null;
      const k = r.Name.toLowerCase() + "|" + (r.Year || "");
      let e = map.get(k);
      if (!e) {
        e = { name: r.Name, year: Number(r.Year) || 0, watched: false, watchlist: false, stars: 0, liked: false, date: 0, addedAt: 0 };
        map.set(k, e);
      }
      return e;
    };

    for (const r of watched) { const e = ent(r); if (e) { e.watched = true; e.date = Math.max(e.date, ts(r.Date)); } }
    for (const r of ratings) {
      const e = ent(r); if (!e) continue;
      e.watched = true;
      if (Number(r.Rating)) e.stars = Number(r.Rating);
      e.date = Math.max(e.date, ts(r.Date));
    }
    for (const r of diary) {
      const e = ent(r); if (!e) continue;
      e.watched = true;
      if (!e.stars && Number(r.Rating)) e.stars = Number(r.Rating);
      e.date = Math.max(e.date, ts(r["Watched Date"]) || ts(r.Date));
    }
    for (const r of likes) { const e = ent(r); if (e) { e.liked = true; e.watched = true; } }
    for (const r of watchlist) { const e = ent(r); if (e) { e.watchlist = true; e.addedAt = ts(r.Date); } }

    const entries = [...map.values()].filter((e) => e.watched || e.watchlist);
    return {
      entries,
      counts: {
        watched: entries.filter((e) => e.watched).length,
        watchlist: entries.filter((e) => !e.watched && e.watchlist).length,
        rated: entries.filter((e) => e.stars).length,
        liked: entries.filter((e) => e.liked).length,
      },
    };
  }

  return { parseCSV, readZip, plan };
})();
