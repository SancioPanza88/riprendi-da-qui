// Ricava titolo, anno, stagione ed episodio da un titolo di pagina "sporco"
// (es. "Guarda Inception in streaming ITA - StreamingCommunity").
const TitleParse = (() => {
  const isBoiler = (p) =>
    /(community|unity)/i.test(p) ||
    /^(streaming|guarda|watch|home|film|serie tv|serie|online|gratis|ita|sub ?ita|hd)$/i.test(p);

  function parseTitle(raw) {
    let t = String(raw || "").replace(/\s+/g, " ").trim();
    let season = 0, episode = 0, year = "", m;

    if ((m = t.match(/\bS(?:tagione)?\s*(\d{1,2})\s*[-·x ]?\s*E(?:pisodio|p)?\s*(\d{1,3})\b/i))) {
      season = +m[1]; episode = +m[2]; t = t.replace(m[0], " ");
    } else {
      if ((m = t.match(/\bStagione\s*(\d{1,2})\b/i))) { season = +m[1]; t = t.replace(m[0], " "); }
      if ((m = t.match(/\bEpisodio\s*(\d{1,3})\b/i))) { episode = +m[1]; t = t.replace(m[0], " "); }
    }
    if ((m = t.match(/\((\d{4})\)/))) { year = m[1]; t = t.replace(m[0], " "); }

    const parts = t.split(/\s+[-–—|•·]\s+|\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    let pick = parts.find((p) => !isBoiler(p)) || parts[0] || "";
    pick = pick
      .replace(/^(guarda|watch)\s+/i, "")
      .replace(/\s+(in\s+)?streaming(\s+(ita|gratis|hd|online|sub\s*ita))*\s*$/i, "")
      .replace(/\s+(ita|sub\s*ita|hd)\s*$/i, "")
      .replace(/^[\s\-–—:|,.]+|[\s\-–—:|,.]+$/g, "")
      .trim();
    return { title: pick || String(raw || "").trim(), year, season, episode };
  }

  // Chiave stabile di un titolo/episodio sul sito: usa l'id numerico nell'URL
  // (/titles/123, /watch/123?e=456), così resta valida anche se il dominio cambia.
  function siteKey(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/(?:titles|watch)\/(\d+)/);
      if (m) {
        const e = u.searchParams.get("e");
        return "sc:" + m[1] + (e ? ":e" + e : "");
      }
      return u.origin + u.pathname + u.search;
    } catch (e) {
      return String(url || "");
    }
  }

  return { parseTitle, siteKey };
})();
