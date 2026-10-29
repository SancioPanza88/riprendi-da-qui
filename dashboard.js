(() => {
  "use strict";

  // ---------------------------------------------------------------
  //  Utilità
  // ---------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);

  // Costruisce elementi DOM in modo sicuro (nessun innerHTML con dati esterni)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const TYPE_LABEL = { movie: "Film", tv: "Serie TV" };

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const hh = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return hh > 0 ? `${hh}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  const fmtRuntime = (min) => {
    if (!min) return "";
    const hh = Math.floor(min / 60);
    const m = min % 60;
    return hh ? `${hh}h ${m}min` : `${m}min`;
  };
  const fmtWhen = (ts) =>
    ts ? new Date(ts).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "mai";

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // ---------------------------------------------------------------
  //  Stato e archivio
  //  Ogni voce ha `updated`; le cancellazioni sono "lapidi" (status "removed")
  //  così si propagano al file di backup/sincronizzazione.
  // ---------------------------------------------------------------
  let lib = {};
  let settings = {};
  let social = {};
  let lastSocialRender = 0;
  let view = "watchlist";
  let searchQuery = "";
  let renderToken = 0;
  const filters = { type: "all", sort: "added" };
  let modalKey = null;
  let modalItem = null;

  const pick = (i) => ({
    key: i.key, id: i.id, type: i.type, title: i.title, year: i.year,
    poster: i.poster, backdrop: i.backdrop, overview: i.overview, rating: i.rating,
  });

  const get = (key) => (lib[key] && lib[key].status !== "removed" ? lib[key] : undefined);
  const entries = (status) => Object.values(lib).filter((i) => i.status === status);
  // Ogni salvataggio porta un timbro: l'evento di ritorno dallo storage si riconosce e non
  // sostituisce `lib` con una copia mentre import/analisi stanno ancora scrivendo.
  const ownStamps = new Set();
  const saveLib = () => {
    const stamp = Date.now() + ":" + Math.random().toString(36).slice(2);
    ownStamps.add(stamp);
    if (ownStamps.size > 200) for (const x of ownStamps) { ownStamps.delete(x); if (ownStamps.size <= 100) break; }
    return chrome.storage.local.set({ library: lib, libStamp: stamp });
  };
  const saveSettings = () => chrome.storage.local.set({ settings });

  function updateCounts() {
    $("#c-watchlist").textContent = entries("watchlist").length || "";
    $("#c-watched").textContent = entries("watched").length || "";
    const online = Object.keys(social.friends || {}).length;
    const el = $("#c-online");
    if (el) el.textContent = online || "";
  }

  function setStatus(item, status) {
    const cur = lib[item.key];
    const now = Date.now();
    lib[item.key] = {
      ...pick(item),
      ...(cur && cur.status !== "removed" ? pick(cur) : {}),
      status,
      added: cur && cur.added ? cur.added : now,
      watchedAt: status === "watched" ? now : undefined,
      stars: status === "watched" && cur && cur.status === "watched" ? cur.stars || 0 : 0,
      liked: cur && cur.status !== "removed" ? cur.liked : undefined,
      taste: cur && cur.status !== "removed" ? cur.taste : undefined,
      src: cur && cur.status !== "removed" ? cur.src : undefined,
      updated: now,
    };
    changed(item, status === "watched" ? "Segnato come visto" : "Aggiunto alla watchlist");
  }

  function removeItem(item) {
    lib[item.key] = { key: item.key, title: item.title, status: "removed", updated: Date.now() };
    changed(item, "Rimosso");
  }

  function rate(key, n) {
    const e = get(key);
    if (!e || e.status !== "watched") return;
    e.stars = e.stars === n ? 0 : n;
    e.updated = Date.now();
    changed(e, e.stars ? `Voto: ${e.stars}/5` : "Voto rimosso");
  }

  function changed(item, msg) {
    saveLib();
    updateCounts();
    scheduleFileSync();
    enrichSoon();
    if (msg) toast(msg);
    if (view === "watchlist" || view === "watched") {
      render();
    } else {
      // aggiorna solo le schede interessate (consigli, ricerca)
      document.querySelectorAll(`.card[data-key="${CSS.escape(item.key)}"]`).forEach((el) => {
        if (el._item) el.replaceWith(card(el._item, el._reason, el._opts));
      });
    }
    if (modalKey === item.key) renderModalActions();
  }

  // progressi salvati dal player
  async function readProgress() {
    const d = await chrome.storage.local.get("progress");
    return d.progress || {};
  }
  // Le scritture dei progressi passano dal background, che è l'unico scrittore:
  // così due film aperti non si cancellano a vicenda.
  const progSend = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })); } catch (e) { res({ ok: false }); }
  });
  async function patchProgress(key, fn) {
    const p = await readProgress();
    const cur = p[key];
    if (!cur) return;
    const rec = { ...cur, ...fn(cur), updated: Date.now(), key };
    await progSend({ type: "saveProgress", key, rec, force: true });
  }
  async function dropProgress(rec) {
    await progSend({ type: "deleteProgress", key: rec.key });
  }
  // scritture di più progressi in blocco (import/merge del file): passano dal
  // background, che le fonde con quello che il player sta salvando in questo momento
  async function writeProgressMerged(progressMap) {
    const items = Object.entries(progressMap || {}).map(([key, rec]) => ({ key, rec }));
    if (!items.length) return;
    await progSend({ type: "saveProgressMany", items });
  }

  // ---------------------------------------------------------------
  //  Componenti: schede, azioni, stelle
  // ---------------------------------------------------------------
  function btn(label, fn, cls) {
    return h("button", {
      class: "btn" + (cls ? " " + cls : ""),
      type: "button",
      onclick: (e) => { e.stopPropagation(); fn(); },
    }, label);
  }

  function starsEl(key) {
    const cur = (get(key) && get(key).stars) || 0;
    const box = h("div", { class: "stars", title: "Il tuo voto (metà sinistra della stella = mezzo voto)" });
    for (let n = 1; n <= 5; n++) {
      const fill = cur >= n ? " full" : cur >= n - 0.5 ? " half" : "";
      const zone = (cls, val) => h("button", {
        type: "button", class: cls, "aria-label": `${val} stelle`,
        onclick: (e) => { e.stopPropagation(); rate(key, val); },
      });
      box.append(h("span", { class: "st" + fill }, zone("l", n - 0.5), zone("r", n), "★"));
    }
    return box;
  }

  function actionsEl(item, big) {
    const e = get(item.key);
    const box = h("div", { class: "actions" + (big ? " big" : "") });
    if (e && e.status === "watched") {
      box.append(
        starsEl(item.key),
        btn("↩ Da vedere", () => setStatus(item, "watchlist")),
        btn("✕ Rimuovi", () => removeItem(item), "danger")
      );
    } else if (e) {
      box.append(
        btn("✓ Visto", () => setStatus(item, "watched"), "primary"),
        btn("✕ Rimuovi", () => removeItem(item), "danger")
      );
    } else {
      box.append(
        btn("+ Watchlist", () => setStatus(item, "watchlist"), "primary"),
        btn("✓ Visto", () => setStatus(item, "watched"))
      );
    }
    return box;
  }

  function posterEl(item, size) {
    if (!item.poster) return h("div", { class: "poster noimg" }, item.title);
    const img = h("img", {
      class: "poster", loading: "lazy", alt: item.title,
      src: TMDB.img(item.poster, size),
    });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "poster noimg" }, item.title)));
    return img;
  }

  function card(item, reason, opts) {
    opts = opts || {};
    const e = get(item.key);
    const el = h("div", { class: "card", "data-key": item.key, tabindex: "0", role: "button" },
      h("div", { class: "poster-wrap" },
        posterEl(item, "w342"),
        e ? h("span", { class: "badge" + (e.status === "watched" ? " watched" : "") },
              e.status === "watched" ? "✓ Visto" : "🔖") : null,
        item.rating ? h("span", { class: "score" }, "★ " + Number(item.rating).toFixed(1)) : null,
        opts.match ? h("span", { class: "match", title: "Quanto è in linea con i tuoi gusti" }, opts.match + "%") : null,
        opts.onHide ? h("button", { class: "hidex", type: "button", title: "Non mi interessa", onclick: (ev) => { ev.stopPropagation(); opts.onHide(ev.currentTarget.closest(".card")); } }, "✕") : null,
        actionsEl(item, false)
      ),
      h("div", { class: "cap" },
        h("div", { class: "t", title: item.title }, item.title),
        h("div", { class: "s" }, [TYPE_LABEL[item.type], item.year].filter(Boolean).join(" · ")),
        reason ? h("div", { class: "why", title: opts.detail || "" }, reason) : null
      )
    );
    el._item = item;
    el._reason = reason;
    el._opts = opts;
    el.addEventListener("click", (ev) => { if (!ev.target.closest("button")) openDetail(item); });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && ev.target === el) openDetail(item);
    });
    return el;
  }

  const pageHead = (title, sub, toolbar) =>
    h("div", { class: "pagehead" },
      h("h2", {}, title),
      sub ? h("span", { class: "muted" }, sub) : null,
      toolbar ? h("div", { class: "toolbar" }, toolbar) : null);

  const loadingEl = (txt) => h("div", { class: "loading" }, h("div", { class: "spinner" }), txt || "Caricamento…");

  // ---------------------------------------------------------------
  //  Viste
  // ---------------------------------------------------------------
  function libView(status) {
    let items = entries(status);
    if (filters.type !== "all") items = items.filter((i) => i.type === filters.type);

    const sorters = {
      added: (a, b) => (b.watchedAt || b.added || 0) - (a.watchedAt || a.added || 0),
      title: (a, b) => a.title.localeCompare(b.title, "it"),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
      stars: (a, b) => (b.stars || 0) - (a.stars || 0),
    };
    items.sort(sorters[filters.sort] || sorters.added);

    const chips = h("div", { class: "chips" },
      [["all", "Tutti"], ["movie", "Film"], ["tv", "Serie"]].map(([v, l]) =>
        h("button", {
          class: "chip" + (filters.type === v ? " on" : ""), type: "button",
          onclick: () => { filters.type = v; render(); },
        }, l)));

    const opts = [["added", status === "watched" ? "Visti di recente" : "Aggiunti di recente"],
      ["title", "Titolo"], ["year", "Anno"], ["rating", "Voto TMDB"]];
    if (status === "watched") opts.push(["stars", "Il mio voto"]);
    const sel = h("select", { "aria-label": "Ordina per" },
      opts.map(([v, l]) => h("option", { value: v, selected: filters.sort === v }, l)));
    sel.addEventListener("change", () => { filters.sort = sel.value; render(); });

    const tools = [chips, sel];
    if (status === "watchlist" && items.length > 1) {
      tools.unshift(btn("🎲 Sorprendimi", () => {
        const it = items[Math.floor(Math.random() * items.length)];
        openDetail(it);
      }, "primary"));
    }

    const title = status === "watchlist" ? "Watchlist" : "Film e serie visti";
    const page = h("div", { class: "page" }, pageHead(title, `${items.length} titoli`, tools));

    if (!items.length) {
      page.append(h("div", { class: "empty" },
        h("h3", {}, status === "watchlist" ? "Nessun titolo in watchlist" : "Non hai ancora segnato nulla come visto"),
        h("p", {}, "Usa la ricerca in alto per trovare film e serie, oppure guarda i consigli."),
        status === "watchlist" ? btn("Importa il tuo profilo Letterboxd", () => go("settings")) : null));
    } else {
      page.append(h("div", { class: "grid" }, items.map((i) => card(i))));
    }
    return page;
  }

  // ---- Continua a guardare ----
  async function continueView() {
    const all = Object.values(await readProgress())
      .filter((r) => r && !r.deleted)
      .sort((a, b) => b.updated - a.updated);

    // per le serie mostra solo l'episodio più recente di ciascuna
    const seen = new Set();
    const list = all.filter((r) => {
      const id = r.tmdb && r.tmdb.type === "tv" ? r.tmdb.key : null;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const page = h("div", { class: "page" }, pageHead("Continua a guardare", `${list.length} titoli`));
    if (!list.length) {
      page.append(h("div", { class: "empty" },
        h("h3", {}, "Niente in corso"),
        h("p", {}, "Quando guardi un film il punto si salva da solo e lo ritrovi qui, con la copertina.")));
      return page;
    }

    const wrap = h("div", { class: "cwlist" });
    for (const rec of list) {
      const t = rec.tmdb;
      const pct = rec.duration ? Math.min(100, (rec.time / rec.duration) * 100) : 0;
      const ep = rec.season || rec.episode ? `${rec.season ? "S" + rec.season : ""}${rec.episode ? "E" + rec.episode : ""}` : "";
      const name = t ? t.title : rec.title;
      const open = t ? () => openDetail(t) : null;

      const thumb = h("div", { class: "thumb", onclick: open, title: t ? "Dettagli" : "" },
        t && t.poster ? h("img", { src: TMDB.img(t.poster, "w154"), alt: name, loading: "lazy" }) : name);

      const actions = h("div", { class: "actions" },
        btn(rec.finished ? "▶ Rivedi" : "▶ Riprendi", async () => {
          if (!rec.finished) await chrome.storage.local.set({ autoResume: rec.key });
          chrome.tabs.create({ url: rec.url });
        }, "primary"));
      if (rec.finished && t && t.type === "movie") {
        actions.append(btn("✓ Visto", async () => {
          setStatus(t, "watched");
          await dropProgress(rec);
          render();
        }));
      }
      actions.append(
        btn(t ? "Non è questo?" : "Riconosci", () => openFix(rec), "ghost"),
        btn("🗑", async () => { await dropProgress(rec); render(); }, "ghost danger"));

      wrap.append(h("div", { class: "cw" }, thumb,
        h("div", { class: "body" },
          h("div", { class: "t" + (open ? " link" : ""), onclick: open },
            name,
            ep ? h("span", { class: "tag" }, ep) : null,
            rec.finished ? h("span", { class: "tag done" }, "Finito") : null,
            !t ? h("span", { class: "tag unk" }, "Non riconosciuto") : null),
          h("div", { class: "m" },
            (rec.duration ? `${fmtTime(rec.time)} / ${fmtTime(rec.duration)}` : fmtTime(rec.time)) +
            " · " + fmtWhen(rec.updated)),
          h("div", { class: "bar" }, h("div", { style: `width:${pct}%` })),
          actions)));
    }
    page.append(wrap);
    return page;
  }

  // correzione manuale del titolo riconosciuto
  function openFix(rec) {
    modalKey = null;
    modalItem = null;
    const results = h("div", {});
    const input = h("input", { type: "search", value: (rec.tmdb && rec.tmdb.title) || rec.title || "", placeholder: "Titolo del film o della serie" });
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) return;
      results.replaceChildren(loadingEl());
      try {
        const found = (await TMDB.search(q)).slice(0, 8);
        results.replaceChildren(...(found.length ? found.map((it) =>
          h("div", {
            class: "pick", tabindex: "0",
            onclick: async () => {
              await patchProgress(rec.key, () => ({ tmdb: { ...pick(it), overview: undefined }, tmdbFixed: true }));
              modal.close();
              toast("Titolo aggiornato");
              render();
            },
          },
            it.poster ? h("img", { src: TMDB.img(it.poster, "w92"), alt: "" }) : h("div", { class: "ph" }),
            h("div", {}, h("div", { class: "t" }, it.title),
              h("div", { class: "s" }, [TYPE_LABEL[it.type], it.year].filter(Boolean).join(" · "))))
        ) : [h("div", { class: "hint" }, "Nessun risultato.")]));
      } catch (e) {
        results.replaceChildren(h("div", { class: "hint" },
          e.message === "NO_KEY" || e.message === "BAD_KEY" ? "Serve una chiave TMDB valida (Impostazioni)." : "Impossibile contattare TMDB."));
      }
    };
    const form = h("form", { onsubmit: (e) => { e.preventDefault(); run(); } }, input, btn("Cerca", run, "primary"));
    modal.replaceChildren(h("div", { class: "modal-body fixbox" },
      h("button", { class: "close", type: "button", "aria-label": "Chiudi", onclick: () => modal.close() }, "✕"),
      h("h3", {}, "Che titolo è?"),
      h("div", { class: "muted" }, rec.title),
      form, results));
    if (!modal.open) modal.showModal();
    input.focus();
    if (input.value) run();
  }

  // ---------------------------------------------------------------
  //  Amici: cerchia, presenza in tempo reale, visione insieme
  //  La rete (trystero) vive nel documento offscreen gestito dal background:
  //  qui si leggono i dati e si mandano comandi.
  // ---------------------------------------------------------------
  const socSend = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(r || null)); } catch (e) { res(null); }
  });
  const socMe = () => social.me || {};
  const onlineFriends = () => Object.values(social.friends || {}).filter((f) => f && f.name);

  function friendCard(f) {
    const w = f.watching;
    const who = f.name || "Amico";
    const ep = w && (w.season || w.episode)
      ? ` · ${w.season ? "S" + w.season : ""}${w.episode ? "E" + w.episode : ""}` : "";
    let body;
    if (w && w.title) {
      const pct = w.duration ? Math.min(100, (w.time / w.duration) * 100) : 0;
      body = h("div", { class: "fmain" },
        h("div", { class: "fmuted" }, w.paused ? "In pausa su" : "Sta guardando"),
        h("div", { class: "ftitle" }, w.title + (w.year ? ` (${w.year})` : "") + ep),
        h("div", { class: "bar" }, h("div", { style: `width:${pct}%` })),
        h("div", { class: "fmuted" }, `${fmtTime(w.time)}${w.duration ? " / " + fmtTime(w.duration) : ""}`),
        h("div", { class: "actions" }, btn("🎉 Guarda insieme", () => inviteFriend(f), "primary")));
    } else {
      body = h("div", { class: "fmain" },
        h("div", { class: "fmuted" }, "Online, non sta guardando niente"),
        h("div", { class: "actions" }, btn("🎉 Guarda insieme", () => inviteFriend(f))));
    }
    return h("div", { class: "friend" },
      h("div", { class: "fava" }, (who[0] || "?").toUpperCase()), body);
  }

  async function inviteFriend(f) {
    const r = await socSend({ type: "social:party:start", peerId: f.peerId });
    if (!r || !r.ok) {
      toast(r && r.error === "NO_FILM"
        ? "Metti in play un film su StreamingCommunity, poi invitalo di nuovo"
        : r && r.error === "NO_CIRCLE" ? "Prima entra in una cerchia" : "Invito non riuscito");
      return;
    }
    toast(`Invito inviato a ${f.name}`);
    render();
  }

  function socialProfilePanel() {
    const me = socMe();
    const name = h("input", { type: "text", value: me.name || "", placeholder: "Il tuo nome per gli amici", maxlength: "24" });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") saveProfile(); });
    const saveProfile = async () => {
      const v = name.value.trim().slice(0, 24) || "Amico";
      await socSend({ type: "social:profile", me: { ...me, name: v } });
      toast("Nome aggiornato");
      render();
    };
    return h("div", { class: "panel" },
      h("h3", {}, "Il tuo profilo"),
      h("p", { class: "muted" }, "Gli amici vedono questo nome. Non serve un account: l'identità resta sul tuo computer."),
      h("div", { class: "keyform" }, name, btn("Salva", saveProfile, "primary")),
      option("socialOn", "Mostra agli amici cosa sto guardando",
        "Se lo spegni resti online nella cerchia, ma nessuno vede titolo e punto di visione.", true));
  }

  function socialCirclePanel() {
    const code = social.circle && social.circle.code;
    if (code) {
      return h("div", { class: "panel" },
        h("h3", {}, "La tua cerchia"),
        h("div", { class: "statusline" }, "Codice invito: ", h("b", { class: "code" }, String(code).toUpperCase())),
        h("p", { class: "muted" }, "Chi ha l'estensione e inserisce questo codice entra nella tua cerchia: vi vedete in tempo reale e potete guardare insieme."),
        h("div", { class: "actions big" },
          btn("📋 Copia il codice", async () => {
            try { await navigator.clipboard.writeText(String(code).toUpperCase()); toast("Codice copiato"); }
            catch (e) { toast(String(code).toUpperCase()); }
          }),
          btn("Esci dalla cerchia", async () => {
            await socSend({ type: "social:circle", code: "" });
            toast("Sei uscito dalla cerchia");
            render();
          }, "danger")));
    }
    const inp = h("input", { type: "text", placeholder: "Codice della cerchia (es. LUCA7)", maxlength: "24" });
    const join = async () => {
      const c = inp.value.trim();
      if (c.length < 4) { toast("Il codice è troppo corto"); return; }
      const r = await socSend({ type: "social:circle", code: c });
      if (r && r.ok) { toast("Sei nella cerchia"); render(); } else toast("Non riesco a entrare nella cerchia");
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });
    return h("div", { class: "panel" },
      h("h3", {}, "Crea o entra in una cerchia"),
      h("p", { class: "muted" }, "La cerchia è un gruppo privato: chi ha il codice vede cosa stai guardando e può guardare insieme a te, in tempo reale."),
      h("div", { class: "actions big" },
        btn("Crea una cerchia", async () => {
          const c = Math.random().toString(36).slice(2, 8).toUpperCase();
          const r = await socSend({ type: "social:circle", code: c });
          if (r && r.ok) { toast("Cerchia creata: " + c); render(); } else toast("Non riesco a creare la cerchia");
        }, "primary")),
      h("div", { class: "keyform" }, inp, btn("Entra", join)));
  }

  function socialView() {
    const party = social.party && social.party.code ? social.party : null;
    const friends = onlineFriends();
    const page = h("div", { class: "page" }, pageHead("Amici", friends.length ? `${friends.length} online` : ""),
      party ? btn("⏹ Termina la visione insieme", async () => {
        await socSend({ type: "social:party:leave" });
        toast("Visione insieme terminata");
        render();
      }, "danger") : null);

    if (social.error) {
      page.append(h("div", { class: "banner" },
        "La rete degli amici non è disponibile in questo browser: aggiorna Chrome all'ultima versione e ricarica l'estensione."));
    }

    const invites = social.invites || [];
    if (invites.length) {
      page.append(h("div", { class: "panel" }, h("h3", {}, "Inviti"),
        invites.map((inv) => h("div", { class: "invite-row" },
          h("div", {},
            h("b", {}, (inv.from && inv.from.name) || "Un amico"),
            " ti invita a guardare ",
            h("b", {}, (inv.film && inv.film.title) || "un film")),
          h("div", { class: "actions" },
            btn("Accetta", async () => {
              const r = await socSend({ type: "social:inviteAccept", invite: inv });
              toast(r && r.ok ? "Ti sei unito alla visione" : "Non riesco a unirmi");
              render();
            }, "primary"),
            btn("Ignora", async () => { await socSend({ type: "social:inviteDecline" }); render(); }))))));
    }

    if (party) {
      page.append(h("div", { class: "panel" },
        h("h3", {}, "🎉 Stai guardando insieme"),
        h("p", { class: "muted" },
          (party.role === "host" ? "Hai avviato tu" : "Ti sei unito") +
          ` · codice ${String(party.code).toUpperCase()}` +
          (party.peers ? ` · ${party.peers} collegati` : "") +
          ". Il player di tutti segue play, pausa e spostamenti.")));
    }

    page.append(socialProfilePanel(), socialCirclePanel());

    if (social.circle && social.circle.code) {
      page.append(h("div", { class: "panel" }, h("h3", {}, "Chi c'è adesso"),
        h("p", { class: "muted" }, "Gli amici con la stessa cerchia e l'estensione aperta compaiono qui, con quello che stanno guardando."),
        friends.length
          ? h("div", { class: "friends" }, friends.map(friendCard))
          : h("div", { class: "empty" }, h("h3", {}, "Nessuno online"),
              h("p", {}, "Passa il codice della cerchia a chi ha l'estensione: appena apre StreamingCommunity lo vedi qui."))));
    }
    return page;
  }

  async function searchView(q) {
    const results = await TMDB.search(q);
    const page = h("div", { class: "page" }, pageHead(`Risultati per “${q}”`, `${results.length} titoli`));
    page.append(results.length
      ? h("div", { class: "grid" }, results.map((i) => card(i)))
      : h("div", { class: "empty" }, h("h3", {}, "Nessun risultato"), h("p", {}, "Prova con un altro titolo.")));
    return page;
  }

  // ---------------------------------------------------------------
  //  Consigli: criteri e pesi stanno in reco.js e si regolano da "⚙ Regola l'analisi"
  // ---------------------------------------------------------------
  const recoSaved = () => (settings.reco = settings.reco || { v: {}, hidden: [] });
  const recoP = () => Reco.resolve(recoSaved());
  let saveTimer;
  const saveRecoSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 400); };

  let job = null; // operazione lunga in corso (import): job.cancel la interrompe
  let enriching = false;
  let enrichTimer;

  // Scarica generi, registi, cast, temi, musiche… dei titoli della libreria che ancora non li hanno
  // (o li hanno nella versione vecchia, più povera). Si fa una volta sola per titolo.
  async function enrichMissing(onProgress) {
    if (enriching || !TMDB.hasKey()) return;
    const todo = Object.values(lib).filter((e) => e && e.status !== "removed" && (!e.taste || e.taste.v !== 2) && e.id && (e.type === "movie" || e.type === "tv"));
    if (!todo.length) return;
    enriching = true;
    const total = todo.length;
    let done = 0;
    const worker = async () => {
      while (todo.length && !(job && job.cancel)) {
        const e = todo.shift();
        try {
          const { base, taste } = await TMDB.tasteOf(e.type, e.id);
          const cur = lib[e.key];
          if (cur && cur.status !== "removed") {
            cur.taste = taste;
            if (cur.src === "letterboxd") Object.assign(cur, pick(base)); // titolo e copertina in italiano
          }
        } catch (err) {
          if (err.message === "HTTP_404" && lib[e.key]) lib[e.key].taste = { v: 2, g: [], d: [], c: [] };
          else if (err.message === "BAD_KEY" || err.message === "NO_KEY") todo.length = 0;
        }
        done++;
        if (onProgress) onProgress(done, total);
        if (done % 25 === 0) await saveLib();
      }
    };
    try { await Promise.all(Array.from({ length: 6 }, worker)); } finally { enriching = false; }
    await saveLib();
  }
  function enrichSoon() {
    clearTimeout(enrichTimer);
    enrichTimer = setTimeout(() => enrichMissing().catch(() => {}), 2000);
  }

  const langName = (c) => { try { return new Intl.DisplayNames(["it"], { type: "language" }).of(c) || c; } catch (e) { return c; } };
  const regionName = (c) => { try { return new Intl.DisplayNames(["it"], { type: "region" }).of(c) || c; } catch (e) { return c; } };
  const SHORT = { similar: "Simili", director: "Regista", cast: "Attori", crew: "Troupe", studio: "Studio", genre: "Generi", themes: "Temi", franchise: "Saga", era: "Epoca", origin: "Paese", runtime: "Durata", quality: "Voto", gems: "Popolarità", fresh: "Novità" };
  const libSig = () => { let m = 0, n = 0; for (const e of Object.values(lib)) { n++; if (e.updated > m) m = e.updated; } return n + ":" + m; };
  const fmtDecade = (d) => (d >= 1950 ? `Anni '${String(d % 100).padStart(2, "0")}` : `Anni ${d}`);

  const candTaste = new Map(); // analisi dei titoli consigliati (resta finché la scheda è aperta)
  let reco = null;             // candidati raccolti: si riordinano senza rifare le richieste
  let recoType = "all";
  let recoPanelOpen = false;
  let recoToken = 0;

  // --- 1) raccolta dei candidati da tutte le fonti (rete) ---
  async function gatherReco(note) {
    const P = recoP();
    const prof = Reco.build(lib, P);
    const gn = await TMDB.genreNames().catch(() => ({}));
    const names = { genre: (id) => gn[id] || "", lang: langName, region: regionName };

    const seeds = Object.values(lib)
      .filter((e) => e && e.id && (e.type === "movie" || e.type === "tv") && prof.weight(e) > 0.5)
      .map((e) => ({ e, w: prof.weight(e), ev: prof.evidence(e) }))
      .sort((a, b) => b.w * b.ev - a.w * a.ev)
      .slice(0, 14);

    const dirs = prof.top("d", 6), cast = prof.top("c", 5), kws = prof.top("k", 3), studios = prof.top("co", 1, 0.25);
    const gIds = prof.top("g", 4, 0.15).map((x) => x.id);
    const genrePairs = gIds.length >= 3 ? [[gIds[0], gIds[1]], [gIds[0], gIds[2]], [gIds[1], gIds[2]]]
      : gIds.length === 2 ? [[gIds[0], gIds[1]]] : gIds.length === 1 ? [[gIds[0]]] : [];

    note("Cerco i consigli…");
    const [recs, dirRes, castRes, genRes, kwList, coList, trend, topM, topT] = await Promise.all([
      Promise.allSettled(seeds.map((s) => TMDB.recommendations(s.e.type, s.e.id))),
      Promise.allSettled(dirs.map((p) => TMDB.personFilms(p.id, "director"))),
      Promise.allSettled(cast.map((p) => TMDB.personFilms(p.id, "cast"))),
      Promise.allSettled(genrePairs.map((ids) => TMDB.discover("movie", { with_genres: ids.join(","), sort_by: "vote_average.desc", "vote_count.gte": "1500" }))),
      kws.length ? TMDB.discover("movie", { with_keywords: kws.map((x) => x.id).join("|"), sort_by: "vote_average.desc", "vote_count.gte": "400" }).catch(() => []) : [],
      studios.length ? TMDB.discover("movie", { with_companies: String(studios[0].id), sort_by: "vote_average.desc", "vote_count.gte": "300" }).catch(() => []) : [],
      TMDB.trending().catch(() => []),
      TMDB.topRated("movie").catch(() => []),
      TMDB.topRated("tv").catch(() => []),
    ]);

    const cand = new Map();
    const take = (it) => {
      if (!it || !it.poster || get(it.key)) return null;
      let c = cand.get(it.key);
      if (!c) { c = { item: it, seed: 0, seeds: [], srcDirs: [], srcCast: [] }; cand.set(it.key, c); }
      return c;
    };
    recs.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      const { e, w, ev } = seeds[i];
      for (const it of r.value) {
        const c = take(it);
        if (!c) continue;
        c.seed += w * ev * (0.4 + (it.rating || 0) / 10);
        if (!c.seeds.includes(e.title)) c.seeds.push(e.title);
      }
    });
    const byLove = (a, b) => b.rating * Math.log10(b.votes + 1) - a.rating * Math.log10(a.votes + 1);
    const personRows = (results, people, field, minVotes) => {
      const rows = [];
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        const p = people[i];
        const list = r.value.filter((x) => x.poster && x.votes >= minVotes && !get(x.key)).sort(byLove);
        for (const it of list.slice(0, 16)) {
          const c = take(it);
          if (c && !c[field].some((x) => x.name === p.name)) c[field].push({ a: p.a, name: p.name });
        }
        rows.push({ p, list: list.slice(0, 14) });
      });
      return rows;
    };
    const dirRows = personRows(dirRes, dirs, "srcDirs", 100);
    const castRows = personRows(castRes, cast, "srcCast", 300);
    const genRows = [];
    genRes.forEach((r, i) => {
      if (r.status !== "fulfilled") return;
      for (const it of r.value) take(it);
      genRows.push({ ids: genrePairs[i], list: r.value });
    });
    for (const it of [...kwList, ...coList, ...trend, ...topM, ...topT]) take(it);

    return {
      sig: libSig(), cand, names, prof, dirRows, castRows, genRows, trend, topM, topT,
      kwRow: kws.length ? { label: kws.slice(0, 2).map((x) => x.name).join(", "), list: kwList } : null,
      coRow: studios.length ? { label: studios[0].name, list: coList } : null,
    };
  }

  // --- 2) analisi a fondo dei candidati migliori (registi, temi, musiche…) ---
  async function ensureTastes(P, note) {
    const hidden = new Set(recoSaved().hidden || []);
    const pre = [];
    for (const c of reco.cand.values()) {
      const it = c.item;
      if (hidden.has(it.key) || (it.votes || 0) < P.minVotes || (recoType !== "all" && it.type !== recoType)) continue;
      pre.push({ c, s: Reco.score(c, null, reco.prof, P, reco.names).raw });
    }
    pre.sort((a, b) => b.s - a.s);
    const need = pre.slice(0, 110).map((x) => x.c.item).filter((it) => !candTaste.has(it.key));
    let ix = 0, done = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (ix < need.length) {
        const it = need[ix++];
        try { candTaste.set(it.key, (await TMDB.tasteOf(it.type, it.id)).taste); } catch (e) { /* facoltativo */ }
        done++;
        if (note) note(`Analizzo i candidati… ${done}/${need.length}`);
      }
    }));
  }

  // --- 3) punteggio e scelta finale ---
  function computeLists(P) {
    const { prof, names } = reco;
    const hidden = new Set(recoSaved().hidden || []);
    const typeOk = (it) => recoType === "all" || it.type === recoType;

    const full = [];
    for (const c of reco.cand.values()) {
      const it = c.item;
      const t = candTaste.get(it.key);
      if (!t || hidden.has(it.key) || !typeOk(it) || (it.votes || 0) < P.minVotes) continue;
      full.push({ ...Reco.score(c, t, prof, P, names), item: it, sig: Reco.sig(c, t) });
    }
    const picks = Reco.select(full, 36, P);

    const wl = [];
    for (const e of entries("watchlist")) {
      if (!e.taste || !typeOk(e)) continue;
      const c = { item: e, seed: 0, seeds: [], srcDirs: [], srcCast: [] };
      wl.push({ ...Reco.score(c, e.taste, prof, P, names), item: e, sig: Reco.sig(c, e.taste) });
    }
    const tonight = wl.length >= 3 ? Reco.select(wl, 12, { ...P, diversity: P.diversity * 0.6 }) : [];
    return { picks, tonight };
  }

  const detailOf = (r) => r.parts
    .filter((x) => Math.abs(x.contrib) >= 0.05)
    .sort((a, b) => b.contrib - a.contrib)
    .map((x) => `${SHORT[x.id] || x.id} ${x.contrib > 0 ? "+" : ""}${x.contrib.toFixed(1)}`)
    .join(" · ");

  function recoCard(r, canHide) {
    return card(r.item, r.reason || "Molto apprezzato", {
      match: r.pct,
      detail: detailOf(r),
      onHide: canHide ? (node) => {
        const s = recoSaved();
        s.hidden = [...new Set([...(s.hidden || []), r.item.key])];
        saveSettings();
        if (node) node.remove();
        toast("Non te lo riproporrò");
      } : null,
    });
  }

  // --- 4) pagina: cosa ho capito, regolazioni, liste ---
  function tasteBox(prof, names) {
    const line = (label, arr) => arr.length
      ? h("div", { class: "tasteline" }, h("span", { class: "lbl" }, label), arr.map((x) => h("span", { class: "tchip" }, x))) : null;
    const origins = [
      ...prof.top("cn", 3, 0.25).filter((x) => x.id !== "US").map((x) => regionName(x.id)),
      ...prof.top("lang", 3, 0.25).filter((x) => x.id !== "en").map((x) => langName(x.id)),
    ];
    const lines = [
      line("Generi", prof.top("g", 5).map((x) => names.genre(x.id)).filter(Boolean)),
      line("Registi", prof.top("d", 5).map((x) => x.name)),
      line("Attori", prof.top("c", 5).map((x) => x.name)),
      line("Temi", prof.top("k", 6).map((x) => x.name)),
      line("Epoche", prof.top("dec", 3, 0.25).map((x) => fmtDecade(x.id))),
      line("Origini", [...new Set(origins)].slice(0, 4)),
      prof.rt ? line("Durata", ["di solito ~ " + fmtRuntime(Math.round(prof.rt.mean / 5) * 5)]) : null,
      prof.meanStars ? line("Voti", [`media ${prof.meanStars.toFixed(1)}★`,
        prof.corr == null ? null : prof.corr > 0.45 ? "ti trovi spesso d'accordo col pubblico" : prof.corr < 0.15 ? "gusti lontani dal pubblico" : "gusti in parte diversi dal pubblico"].filter(Boolean)) : null,
    ].filter(Boolean);
    return lines.length
      ? h("div", { class: "taste" }, h("div", { class: "muted" }, `Cosa ho capito dei tuoi gusti · analizzati ${prof.count} titoli`), lines)
      : null;
  }

  const fmtVal = (d, v) => d.fmt === "int" ? String(v) : d.fmt === "years" ? (v === 0 ? "no" : v + " anni") : (d.bipolar && v > 0 ? "+" : "") + Number(v).toFixed(1);

  function critRow(d, P, onChange) {
    if (d.type === "bool") {
      const cb = h("input", { type: "checkbox" });
      cb.checked = !!P[d.id];
      cb.addEventListener("change", () => onChange(d.id, cb.checked));
      return h("label", { class: "crit bool" }, h("span", { class: "cl" }, h("b", {}, d.label), h("small", {}, d.hint)), cb);
    }
    const out = h("output", {}, fmtVal(d, P[d.id]));
    const input = h("input", { type: "range", min: d.min, max: d.max, step: d.step, value: P[d.id] });
    input.addEventListener("input", () => { out.textContent = fmtVal(d, +input.value); onChange(d.id, +input.value); });
    input.addEventListener("dblclick", () => { input.value = d.def; out.textContent = fmtVal(d, d.def); onChange(d.id, d.def); });
    return h("label", { class: "crit" + (d.bipolar ? " bi" : "") }, h("span", { class: "cl" }, h("b", {}, d.label), h("small", {}, d.hint)), input, out);
  }

  function recoPanel(onChange, onPreset) {
    const P = recoP();
    const saved = recoSaved();
    const box = h("div", { class: "panel recopanel" },
      h("h3", {}, "Regola l'analisi"),
      h("p", { class: "muted" }, "Ogni cursore è un criterio con cui giudico i film: alzalo se vuoi che conti di più, a zero lo ignoro. Doppio clic su un cursore per rimetterlo com'era. Le modifiche si vedono subito e vengono ricordate."),
      h("div", { class: "presets" }, Reco.PRESETS.map((p) =>
        h("button", { type: "button", class: "chip" + ((saved.preset || "balanced") === p.id ? " on" : ""), onclick: () => onPreset(p) }, p.label))));
    for (const [gid, glabel] of Object.entries(Reco.GROUPS)) {
      const defs = [...Reco.CRITERIA, ...Reco.PARAMS].filter((d) => d.g === gid);
      if (!defs.length) continue;
      box.append(h("div", { class: "sub" }, h("h4", {}, glabel), defs.map((d) => critRow(d, P, onChange))));
    }
    const nh = (saved.hidden || []).length;
    box.append(h("div", { class: "sub" }, h("h4", {}, "Titoli nascosti"),
      h("p", { class: "muted" }, nh ? `Hai nascosto ${nh} titoli con la ✕ sulle copertine.` : "Con la ✕ sulle copertine puoi nascondere i titoli che non ti interessano."),
      nh ? btn("Ripristina i nascosti", () => { saved.hidden = []; saveSettings(); onChange(); render(); }) : null));
    return box;
  }

  async function discoverView() {
    const ld = loadingEl("Analizzo i tuoi gusti…");
    $("#app").replaceChildren(h("div", { class: "page" }, ld));
    const note = (txt) => { if (ld.lastChild) ld.lastChild.nodeValue = txt; };
    await enrichMissing((d, t) => note(`Analizzo i tuoi film… ${d}/${t}`));
    if (!reco || reco.sig !== libSig()) reco = await gatherReco(note);

    const P0 = recoP();
    reco.prof = Reco.build(lib, P0);
    await ensureTastes(P0, note);

    const my = ++recoToken;
    const tasteSlot = h("div", {});
    const panelSlot = h("div", { hidden: !recoPanelOpen });
    const body = h("div", {});
    const rowsSlot = h("div", {});

    const fillBody = () => {
      const P = recoP();
      const { picks, tonight } = computeLists(P);
      const kids = [];
      if (tonight.length) {
        kids.push(h("section", { class: "row-section" },
          h("h3", {}, "Stasera dalla tua watchlist · i più adatti a te"),
          h("div", { class: "row" }, tonight.map((r) => recoCard(r, false)))));
      }
      if (picks.length) {
        kids.push(h("h3", { class: "grid-title" }, "Consigliati per te"),
          h("div", { class: "grid" }, picks.map((r) => recoCard(r, true))));
      } else {
        kids.push(h("div", { class: "hint" },
          "Segna qualche titolo come visto (e dagli un voto), aggiungilo alla watchlist o importa il tuo profilo Letterboxd: i consigli personalizzati compariranno qui."));
      }
      body.replaceChildren(...kids);
      tasteSlot.replaceChildren(...[tasteBox(reco.prof, reco.names)].filter(Boolean));
    };

    let busy = 0;
    const recompute = async () => {
      const token = ++busy;
      body.classList.add("busy");
      const P = recoP();
      reco.prof = Reco.build(lib, P);
      try { await ensureTastes(P); } catch (e) { /* si usa ciò che c'è */ }
      if (token !== busy || my !== recoToken) return;
      fillBody();
      body.classList.remove("busy");
    };
    let rerankTimer;
    const rerankSoon = () => { clearTimeout(rerankTimer); rerankTimer = setTimeout(recompute, 220); };

    const buildPanel = () => panelSlot.replaceChildren(recoPanel(
      (id, val) => { if (id !== undefined) { const s = recoSaved(); s.v = { ...(s.v || {}), [id]: val }; s.preset = ""; saveRecoSoon(); } rerankSoon(); },
      (p) => { const s = recoSaved(); s.v = { ...p.v }; s.preset = p.id; saveSettings(); buildPanel(); recompute(); }));
    buildPanel();

    const toolbar = [
      h("div", { class: "chips" }, [["all", "Tutti"], ["movie", "Film"], ["tv", "Serie"]].map(([v, l]) =>
        h("button", {
          class: "chip" + (recoType === v ? " on" : ""), type: "button",
          onclick: (ev) => {
            recoType = v;
            ev.currentTarget.parentNode.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === ev.currentTarget));
            recompute();
          },
        }, l))),
      btn("⚙ Regola l'analisi", () => { recoPanelOpen = !recoPanelOpen; panelSlot.hidden = !recoPanelOpen; }, "primary"),
      btn("↻", () => { reco = null; render(); }, "ghost"),
    ];
    const page = h("div", { class: "page" }, pageHead("Consigliati", "in base a voti, registi, attori, temi, generi, epoche e watchlist", toolbar),
      tasteSlot, panelSlot, body, rowsSlot);
    fillBody();

    // righe di approfondimento (non dipendono dai cursori)
    const hidden = new Set(recoSaved().hidden || []);
    const row = (title, list) => {
      const l = (list || []).filter((i) => !get(i.key) && !hidden.has(i.key) && i.poster).slice(0, 20);
      if (!l.length) return null;
      return h("section", { class: "row-section" }, h("h3", {}, title),
        h("div", { class: "row" }, l.map((i) => card(i))));
    };
    for (const r of reco.dirRows.slice(0, 3)) rowsSlot.append(row(`Altri film di ${r.p.name}`, r.list));
    for (const r of reco.castRows.slice(0, 2)) rowsSlot.append(row(`Con ${r.p.name}`, r.list));
    if (reco.kwRow) rowsSlot.append(row(`Temi che ami: ${reco.kwRow.label}`, reco.kwRow.list));
    if (reco.coRow) rowsSlot.append(row(`Prodotti da ${reco.coRow.label}`, reco.coRow.list));
    if (reco.genRows[0]) rowsSlot.append(row(reco.genRows[0].ids.map(reco.names.genre).filter(Boolean).join(" + ") + ": i più amati", reco.genRows[0].list));
    rowsSlot.append(row("Di tendenza questa settimana", reco.trend), row("Film più votati", reco.topM), row("Serie TV più votate", reco.topT));
    return page;
  }

  // ---------------------------------------------------------------
  //  Salvataggio su file: backup automatico + file collegato
  // ---------------------------------------------------------------
  let fileState = { state: "none" };
  let fsTimer;

  let pbTimer;
  function scheduleFileSync() {
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => fileSync(false), 1500);
    // se il backup va in una cartella scelta, la pagina aperta può scriverci anche lei
    clearTimeout(pbTimer);
    pbTimer = setTimeout(async () => {
      if (Backup.pickable && (await Backup.getFolder().catch(() => null))) Backup.run(false).catch(() => {});
    }, 4000);
  }

  let backupIssue = "";
  async function reactivateBackup() {
    const f = await Backup.getFolder().catch(() => null);
    if (!f) { await chrome.storage.local.set({ backupIssue: "" }); return; }
    try {
      if (await Backup.permission(f, true)) {
        const r = await Backup.run(true);
        toast(r.ok ? "Backup salvato" : "Backup non riuscito");
      }
    } catch (e) { toast("Backup non riuscito"); }
  }

  function renderSyncBar() {
    const bar = $("#syncbar");
    if (!bar) return;
    const items = [];
    if (backupIssue) {
      items.push(h("div", { class: "banner" },
        h("span", {}, backupIssue === "access"
          ? "📁 Il backup nella cartella scelta è in pausa: Chrome vuole una conferma."
          : `📁 Backup nella cartella non riuscito (${backupIssue.replace(/^error:/, "")}).`),
        btn("Riattiva", reactivateBackup, "primary")));
    }
    if (fileState.state === "needs-permission") {
      items.push(h("div", { class: "banner" },
        h("span", {}, `🔗 La sincronizzazione con il file “${fileState.name}” è in pausa: Chrome vuole una conferma.`),
        btn("Riattiva", () => fileSync(true), "primary")));
    } else if (fileState.state === "error") {
      items.push(h("div", { class: "banner" },
        h("span", {}, `🔗 Sincronizzazione file non riuscita (${fileState.error}).`),
        btn("Riprova", () => fileSync(true))));
    }
    bar.replaceChildren(...items);
  }

  // Legge il file collegato, unisce con i dati locali (vince la voce più recente) e riscrive il file.
  async function fileSync(ask) {
    if (!FileLink.supported) return fileState;
    let handle = null;
    try { handle = await FileLink.get(); } catch (e) { /* IndexedDB non disponibile */ }
    if (!handle) {
      fileState = { state: "none" };
      renderSyncBar();
      return fileState;
    }
    try {
      if (!(await FileLink.permission(handle, ask))) {
        fileState = { state: "needs-permission", name: handle.name };
        renderSyncBar();
        return fileState;
      }
      let incoming = null;
      const text = await FileLink.read(handle);
      if (text.trim()) incoming = Sync.parse(text); // se il file è illeggibile NON lo sovrascrivo
      const local = await chrome.storage.local.get(["library", "progress"]);
      const base = { library: local.library || {}, progress: local.progress || {} };
      const m = incoming ? Sync.merge(base, incoming) : { ...base, localChanged: false, fileChanged: true };
      if (m.localChanged) {
        await chrome.storage.local.set({ library: m.library });
        await writeProgressMerged(m.progress);
        lib = m.library;
        updateCounts();
        if (["watchlist", "watched", "continue"].includes(view)) render();
      }
      if (m.fileChanged) await FileLink.write(handle, JSON.stringify(Sync.snapshot(m.library, m.progress)));
      fileState = { state: "ok", name: handle.name, at: Date.now() };
      await chrome.storage.local.set({ fileSyncAt: fileState.at });
    } catch (e) {
      fileState = { state: "error", name: handle.name, error: e.message === "BAD_FORMAT" || e instanceof SyntaxError ? "il file non è un backup valido" : e.message || "errore" };
    }
    renderSyncBar();
    return fileState;
  }

  async function linkFile(mode) {
    let handle;
    try {
      handle = mode === "new" ? await FileLink.pickNew() : await FileLink.pickExisting();
    } catch (e) {
      return; // scelta annullata
    }
    await FileLink.set(handle);
    const st = await fileSync(true);
    if (st.state === "ok") toast("File collegato: i dati sono sincronizzati");
    else if (st.state === "error") { await FileLink.clear(); fileState = { state: "none" }; renderSyncBar(); toast("Il file scelto non è un backup valido"); }
    if (view === "settings") render();
  }

  // ---------------------------------------------------------------
  //  Impostazioni, setup chiave, backup
  // ---------------------------------------------------------------
  function keyForm(onDone) {
    const input = h("input", {
      type: "text", id: "keyInput", placeholder: "Incolla qui la chiave API di TMDB",
      value: settings.tmdbKey || "", spellcheck: "false", autocomplete: "off",
    });
    const msg = h("div", { class: "hint" });
    const save = async () => {
      const k = input.value.trim();
      if (!k) { msg.textContent = "Inserisci una chiave."; return; }
      msg.textContent = "Verifico…";
      TMDB.setKey(k);
      try {
        await TMDB.get("/configuration");
        settings.tmdbKey = k;
        settings.keyAt = Date.now();
        await saveSettings();
        msg.textContent = "✓ Chiave valida e salvata.";
        toast("Chiave TMDB salvata");
        if (onDone) onDone();
      } catch (e) {
        TMDB.setKey(settings.tmdbKey || "");
        msg.textContent = e.message === "BAD_KEY"
          ? "Chiave non valida: ricontrolla di averla copiata per intero."
          : "Impossibile contattare TMDB. Controlla la connessione.";
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    return h("div", {}, h("div", { class: "keyform" }, input, btn("Salva e verifica", save, "primary")), msg);
  }

  async function importText(text) {
    const incoming = Sync.parse(text);
    const local = await chrome.storage.local.get(["library", "progress"]);
    const m = Sync.merge({ library: local.library || {}, progress: local.progress || {} }, incoming);
    await chrome.storage.local.set({ library: m.library });
    await writeProgressMerged(m.progress);
    lib = m.library;
    updateCounts();
    if (["watchlist", "watched", "continue"].includes(view)) render();
  }

  async function importFile(file) {
    try {
      await importText(await file.text());
      toast("Backup importato");
    } catch (e) {
      toast("File di backup non valido");
    }
  }

  // Scelta della cartella in cui salvare il backup (idealmente quella dell'estensione)
  async function chooseBackupFolder() {
    let dir;
    try { dir = await Backup.pickFolder(); } catch (e) { return; } // annullato
    await Backup.setFolder(dir);
    const isExt = await Backup.looksLikeExtension(dir);
    const r = await Backup.run(true);
    toast(r.ok ? (isExt ? "Backup salvato nella cartella dell'estensione" : `Backup salvato in “${dir.name}”`) : "Cartella scelta, ma il backup non è riuscito");
    if (view === "settings") render();
  }

  async function restoreFromFolder() {
    let dir;
    try { dir = await Backup.pickFolder(); } catch (e) { return; }
    let text;
    try { text = await Backup.readFile(dir, Backup.FILE); } catch (e) { toast(`In “${dir.name}” non c'è il file ${Backup.FILE}`); return; }
    try {
      await importText(text);
      await Backup.setFolder(dir);
      toast("Dati ripristinati: il backup continuerà a salvarsi in quella cartella");
      if (view === "settings") render();
    } catch (e) {
      toast("File di backup non valido");
    }
  }

  // ---------------- Importazione da Letterboxd ----------------
  function applyImported(m, e) {
    const cur = get(m.key);
    const now = Date.now();
    const status = e.watched ? "watched" : "watchlist";
    if (cur) {
      // già presente: completo i dati senza toccare ciò che hai già deciso qui
      const next = { ...cur };
      let changedAny = false;
      if (status === "watched" && cur.status !== "watched") { next.status = "watched"; next.watchedAt = e.date || now; changedAny = true; }
      if (next.status === "watched") {
        if (!next.stars && e.stars) { next.stars = e.stars; changedAny = true; }
        if (e.liked && !next.liked) { next.liked = true; changedAny = true; }
      }
      if (changedAny) { next.updated = now; lib[m.key] = next; }
      return;
    }
    lib[m.key] = {
      ...pick(m),
      status,
      added: (status === "watchlist" ? e.addedAt : e.date) || now,
      watchedAt: status === "watched" ? e.date || now : undefined,
      stars: status === "watched" ? e.stars || 0 : 0,
      liked: e.liked || undefined,
      src: "letterboxd",
      updated: now,
    };
  }

  async function importLetterboxd(fileList) {
    if (!TMDB.hasKey()) { toast("Prima inserisci la chiave TMDB"); return; }
    if (job) return;
    let plan;
    try {
      const files = {};
      for (const f of fileList) {
        if (/\.zip$/i.test(f.name)) Object.assign(files, await Letterboxd.readZip(await f.arrayBuffer()));
        else if (/\.csv$/i.test(f.name)) files[f.name.toLowerCase()] = await f.text();
      }
      plan = Letterboxd.plan(files);
    } catch (e) { toast("Non riesco a leggere il file di Letterboxd"); return; }
    if (!plan.entries.length) { toast("Nessun film trovato: serve l'export di Letterboxd (zip)"); return; }

    job = { cancel: false };
    const fill = h("div", { style: "width:0%" });
    const status = h("div", { class: "muted" }, "Cerco i film su TMDB…");
    modalKey = null; modalItem = null;
    modal.replaceChildren(h("div", { class: "modal-body fixbox" },
      h("h3", {}, "Importo da Letterboxd"),
      h("p", { class: "muted" },
        `${plan.counts.watched} visti (${plan.counts.rated} con voto, ${plan.counts.liked} con cuore) · ${plan.counts.watchlist} in watchlist. Lascia aperta questa scheda.`),
      h("div", { class: "bar big" }, fill), status,
      h("div", { class: "actions big" }, btn("Interrompi", () => { job.cancel = true; status.textContent = "Interrompo…"; }, "danger"))));
    if (!modal.open) modal.showModal();

    const todo = plan.entries.slice();
    const failed = [];
    const count = todo.length;
    let done = 0, matched = 0, fatal = null;
    const worker = async () => {
      while (todo.length && !job.cancel) {
        const e = todo.shift();
        try {
          const m = await TMDB.matchFilm(e.name, e.year);
          if (m) { applyImported(m, e); matched++; } else failed.push(e);
        } catch (err) {
          if (err.message === "BAD_KEY" || err.message === "NO_KEY") { fatal = err; job.cancel = true; }
          else failed.push(e);
        }
        done++;
        fill.style.width = (done / count) * 100 + "%";
        status.textContent = `Trovati ${matched} film (${done}/${count})…`;
        if (done % 25 === 0) await saveLib();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await saveLib();
    updateCounts();

    if (fatal) { job = null; modal.close(); toast("La chiave TMDB non è valida"); return; }
    if (!job.cancel) {
      fill.style.width = "0%";
      await enrichMissing((d, t) => {
        fill.style.width = (d / t) * 100 + "%";
        status.textContent = `Analizzo registi, attori e generi per i consigli… ${d}/${t}`;
      });
    }
    const cancelled = job.cancel;
    job = null;
    scheduleFileSync();
    updateCounts();

    modal.replaceChildren(h("div", { class: "modal-body fixbox" },
      h("button", { class: "close", type: "button", "aria-label": "Chiudi", onclick: () => modal.close() }, "✕"),
      h("h3", {}, cancelled ? "Importazione interrotta" : "Importazione completata"),
      h("p", {}, `${matched} film su ${count} sono entrati nella tua libreria.`),
      failed.length
        ? h("div", {},
            h("p", { class: "muted" }, `${failed.length} ${failed.length === 1 ? "non trovato" : "non trovati"} su TMDB (di solito corti, speciali o titoli con anno diverso):`),
            h("div", { class: "faillist" },
              failed.slice(0, 60).map((f) => h("div", {}, f.name + (f.year ? ` (${f.year})` : ""))),
              failed.length > 60 ? h("div", { class: "muted" }, `…e altri ${failed.length - 60}`) : null))
        : null,
      h("div", { class: "actions big" },
        btn("Vai ai film visti", () => { modal.close(); go("watched"); }, "primary"),
        btn("Chiudi", () => modal.close()))));
    if (view === "settings") render();
  }

  function lbBox() {
    const file = h("input", { type: "file", accept: ".zip,.csv,application/zip", multiple: true, style: "display:none" });
    file.addEventListener("change", async () => { if (file.files.length) await importLetterboxd([...file.files]); file.value = ""; });
    return h("div", { class: "actions big" }, btn("⬆ Scegli lo zip di Letterboxd", () => file.click(), "primary"), file);
  }

  // "Hai già i tuoi dati?" — usato nel primo avvio e nelle impostazioni
  function restoreBox() {
    const file = h("input", { type: "file", accept: "application/json,.json", style: "display:none" });
    file.addEventListener("change", async () => { if (file.files[0]) await importFile(file.files[0]); file.value = ""; });
    return h("div", { class: "actions big" },
      Backup.pickable ? btn("📁 Ripristina dalla cartella dell'estensione", restoreFromFolder, "primary") : null,
      FileLink.supported ? btn("🔗 Collega il file di sincronizzazione", () => linkFile("existing"), Backup.pickable ? "" : "primary") : null,
      btn("⬆ Importa un backup", () => file.click()),
      file);
  }

  function setupPanel(bad) {
    return h("div", { class: "page" },
      bad ? h("div", { class: "banner" }, "La chiave TMDB non è valida o è scaduta.") : null,
      h("div", { class: "panel" },
        h("h3", {}, "Collega TMDB per copertine, trame e consigli"),
        h("p", { class: "muted" }, "I dati dei film (locandine, riassunti, cast, trailer, dove guardarli) arrivano da TMDB, un database gratuito. Serve una chiave personale, si crea in un minuto:"),
        h("ol", {},
          h("li", {}, "Crea un account gratuito su ",
            h("a", { href: "https://www.themoviedb.org/signup", target: "_blank", rel: "noopener" }, "themoviedb.org")),
          h("li", {}, "Vai in Impostazioni → API (",
            h("a", { href: "https://www.themoviedb.org/settings/api", target: "_blank", rel: "noopener" }, "link diretto"),
            ") e richiedi una chiave (uso personale)"),
          h("li", {}, "Copia la “Chiave API” (o il “Token di lettura API”) e incollala qui sotto")),
        keyForm(() => { view = "watchlist"; syncNav(); render(); }),
        h("p", { class: "muted" }, "Dopo la chiave potrai importare anche il tuo profilo Letterboxd (watchlist, film visti e voti) da Impostazioni.")),
      h("div", { class: "panel" },
        h("h3", {}, "Hai già i tuoi dati?"),
        h("p", { class: "muted" }, "Se usavi già l'estensione su un altro dispositivo o l'hai reinstallata, ripristina watchlist, voti e punti salvati dal tuo file."),
        restoreBox()));
  }

  function option(id, title, hint, defaultOn) {
    const cb = h("input", { type: "checkbox", id });
    cb.checked = settings[id] === undefined ? defaultOn : settings[id] !== false;
    cb.addEventListener("change", async () => { settings[id] = cb.checked; await saveSettings(); toast("Impostazione salvata"); });
    return h("label", { class: "opt", for: id }, cb, h("span", {}, h("b", {}, title), h("small", {}, hint)));
  }

  async function settingsView() {
    const page = h("div", { class: "page" }, pageHead("Impostazioni"));
    const info = await chrome.storage.local.get(["lastBackupAt", "fileSyncAt"]);

    page.append(h("div", { class: "panel" },
      h("h3", {}, "Chiave API di TMDB"),
      h("p", { class: "muted" }, TMDB.hasKey() ? "Chiave configurata. Puoi sostituirla qui sotto." : "Nessuna chiave configurata."),
      keyForm()));

    page.append(h("div", { class: "panel" },
      h("h3", {}, "Importa da Letterboxd"),
      h("p", { class: "muted" }, "Porta qui watchlist, film visti, voti e cuori del tuo profilo Letterboxd. I consigli useranno anche quelli."),
      h("ol", {},
        h("li", {}, "Su letterboxd.com apri Settings → Data e premi “Export your data”: scarichi uno zip"),
        h("li", {}, "Scegli quello zip qui sotto (vanno bene anche i singoli CSV: watched, ratings, watchlist, diary)")),
      h("p", { class: "muted" }, "Cosa hai già qui non viene sovrascritto: Letterboxd completa i voti mancanti e aggiunge i film nuovi. Puoi ripetere l'import quando vuoi."),
      lbBox()));

    // --- sync automatica verso Letterboxd ---
    const lb = (await chrome.storage.local.get("lbStatus")).lbStatus || {};
    const lbPanel = h("div", { class: "panel" },
      h("h3", {}, "Sync automatica con Letterboxd"),
      h("p", { class: "muted" },
        "Voti, cuori, watchlist e film visti viaggiano verso Letterboxd da soli, pochi secondi dopo che li cambi qui. Usa la sessione del browser: se hai Letterboxd aperto e sei collegato, non devi fare altro. Vale per i film (Letterboxd non ha le serie)."),
      option("lbSync", "Sincronizza in tempo reale", "Ogni modifica a voti, cuori, watchlist e visti viene inviata a Letterboxd.", true));

    let lbText = "La sync parte da sola appena cambi un voto o la watchlist.";
    let bad = false;
    if (lb.error === "LOGIN") { lbText = "Non risulti collegato a Letterboxd: apri letterboxd.com, accedi e riprova."; bad = true; }
    else if (lb.error === "NO_CSRF") { lbText = "Letterboxd non ha dato il token di sessione. Ricarica letterboxd.com e riprova."; bad = true; }
    else if (lb.error === "BLOCKED") { lbText = "Letterboxd ha bloccato la richiesta: riprova più tardi."; bad = true; }
    else if (lb.error === "NO_IMDB") { lbText = "Alcuni titoli non hanno un codice IMDb su TMDB: restano in coda."; }
    else if (lb.running) { lbText = "Sincronizzazione in corso…"; }
    else if (lb.lastRun) { lbText = `Ultima sync: ${fmtWhen(lb.lastRun)}` + (lb.user ? ` · ${lb.user}` : "") + (lb.done ? ` · ${lb.done} inviati` : ""); }
    else if (lb.error) { lbText = "Errore: " + lb.error; }

    lbPanel.append(
      h("div", { class: "statusline" + (bad ? " bad" : "") }, lbText),
      h("div", { class: "actions big" },
        btn("Sincronizza ora", async () => {
          toast("Sincronizzo con Letterboxd…");
          const r = await socSend({ type: "lbSyncNow" });
          toast(r && r.ok ? (r.done ? `Inviati ${r.done} aggiornamenti` : "Tutto già allineato") : (r && r.error === "LOGIN" ? "Accedi a Letterboxd e riprova" : "Sync non riuscita"));
          render();
        }, "primary"),
        btn("Apri Letterboxd", () => chrome.tabs.create({ url: "https://letterboxd.com/" }))),
      lb.pending ? h("p", { class: "muted" }, `${lb.pending} titoli ancora in coda.`) : null);
    page.append(lbPanel);

    page.append(h("div", { class: "panel" },
      h("h3", {}, "Mentre guardi"),
      option("autoSave", "Salva il punto automaticamente",
        "Solo quando chiudi la scheda o il browser (oltre al pulsante «Segna qui»), così il video non rallenta mentre guardi.", true)));

    // --- backup e sincronizzazione ---
    const panel = h("div", { class: "panel" }, h("h3", {}, "Salvataggio dei tuoi dati"),
      h("p", { class: "muted" }, "Watchlist, voti e punti salvati restano nel browser, ma un file di backup li protegge se reinstalli Chrome o cambi computer."));

    panel.append(option("autoBackup", "Backup automatico",
      "Tiene aggiornato il file " + Backup.FILE + " dopo ogni modifica. Nessuna sottocartella.", true));

    const folder = Backup.pickable ? await Backup.getFolder().catch(() => null) : null;
    const where = h("div", { class: "sub" }, h("h4", {}, "Dove viene salvato"));
    if (!Backup.pickable) {
      where.append(h("p", { class: "muted" }, "Direttamente nella cartella Download (questo browser non permette di sceglierne un'altra)."));
    } else if (folder) {
      const isExt = await Backup.looksLikeExtension(folder);
      where.append(
        h("div", { class: "statusline" }, "Cartella: ", h("b", {}, folder.name), isExt ? " · è la cartella dell'estensione ✓" : ""),
        h("div", { class: "actions big" },
          btn("Cambia cartella…", chooseBackupFolder),
          btn("Torna a Download", async () => { await Backup.clearFolder(); await Backup.run(true); toast("Il backup andrà direttamente in Download"); render(); })));
    } else {
      where.append(
        h("p", { class: "muted" }, "Ora: direttamente nella cartella Download. Chrome non lascia scrivere a un'estensione nella propria cartella in automatico: scegli una volta la cartella da cui l'hai caricata (quella con dentro manifest.json) e da lì in poi il file finisce sempre lì."),
        h("div", { class: "actions big" }, btn("📁 Scegli la cartella dell'estensione…", chooseBackupFolder, "primary")));
    }
    panel.append(where);

    const backupLine = h("div", { class: "statusline" }, "Ultimo backup: ", h("b", {}, fmtWhen(info.lastBackupAt)), " ");
    backupLine.append(btn("Salva ora", async () => {
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: "backupNow" }, (x) => res(x || { ok: false })));
      toast(r.ok ? "Backup salvato" : r.empty ? "Non c'è ancora nulla da salvare" : r.needsAccess ? "Serve la conferma per la cartella (banner in alto)" : "Backup non riuscito");
      render();
    }));
    panel.append(backupLine);

    const handle = FileLink.supported ? await FileLink.get().catch(() => null) : null;
    const sub = h("div", { class: "sub" }, h("h4", {}, "File di sincronizzazione (facoltativo)"),
      h("p", { class: "muted" }, "Scegli un file dentro una cartella sincronizzata (Google Drive, OneDrive, Dropbox…): i dati si aggiornano da soli e ti seguono su tutti i computer. Su un altro dispositivo basta collegare lo stesso file."));
    if (!FileLink.supported) {
      sub.append(h("div", { class: "hint" }, "Questo browser non permette di collegare un file: usa il backup manuale qui sotto."));
    } else if (handle) {
      const st = fileState.state === "ok" ? "ok" : fileState.state;
      sub.append(h("div", { class: "statusline" }, "File collegato: ", h("b", {}, handle.name), " · ",
        st === "ok" ? h("span", { class: "ok" }, "sincronizzato " + fmtWhen(info.fileSyncAt || fileState.at))
          : st === "needs-permission" ? "in attesa di conferma" : "errore"),
        h("div", { class: "actions big" },
          btn("Sincronizza ora", async () => { await fileSync(true); render(); }, "primary"),
          btn("Scollega", async () => { await FileLink.clear(); fileState = { state: "none" }; renderSyncBar(); toast("File scollegato"); render(); })));
    } else {
      sub.append(h("div", { class: "actions big" },
        btn("Crea un nuovo file…", () => linkFile("new"), "primary"),
        btn("Usa un file esistente…", () => linkFile("existing"))));
    }
    panel.append(sub);

    const exp = h("div", { class: "sub" }, h("h4", {}, "Backup manuale"),
      h("div", { class: "actions big" },
        btn("⬇ Esporta", async () => {
          const cur = await chrome.storage.local.get(["library", "progress"]);
          const blob = new Blob([JSON.stringify(Sync.snapshot(cur.library || {}, cur.progress || {}), null, 2)], { type: "application/json" });
          const a = h("a", { href: URL.createObjectURL(blob), download: "riprendi-da-qui-backup.json" });
          document.body.append(a); a.click(); a.remove();
        }),
        restoreBox()));
    panel.append(exp);
    page.append(panel);

    page.append(h("div", { class: "panel" },
      h("h3", {}, "Zona pericolosa"),
      h("div", { class: "actions big" },
        btn("Svuota watchlist e visti", async () => {
          if (!confirm("Cancellare tutta la watchlist e i film visti? Non si può annullare.")) return;
          const now = Date.now();
          const wiped = {};
          for (const [k, v] of Object.entries(lib)) wiped[k] = { key: k, title: v.title, status: "removed", updated: now };
          lib = wiped;
          await saveLib();
          updateCounts();
          scheduleFileSync();
          toast("Libreria svuotata");
        }, "danger"))));
    return page;
  }

  function errorView(e) {
    if (e && e.message === "NO_KEY") return setupPanel(false);
    if (e && e.message === "BAD_KEY") return setupPanel(true);
    return h("div", { class: "page" }, h("div", { class: "empty" },
      h("h3", {}, "Qualcosa è andato storto"),
      h("p", {}, "Non riesco a contattare TMDB. Controlla la connessione e riprova."),
      btn("Riprova", () => render(), "primary")));
  }

  // ---------------------------------------------------------------
  //  Navigazione e render
  // ---------------------------------------------------------------
  function syncNav() {
    document.querySelectorAll("#nav button").forEach((b) =>
      b.classList.toggle("active", view !== "search" && b.dataset.view === view));
  }

  async function render() {
    const token = ++renderToken;
    const app = $("#app");
    const scrollY = window.scrollY;
    let node;
    try {
      if (view === "watchlist") node = libView("watchlist");
      else if (view === "watched") node = libView("watched");
      else if (view === "continue") node = await continueView();
      else if (view === "social") node = socialView();
      else if (view === "settings") node = await settingsView();
      else {
        app.replaceChildren(h("div", { class: "page" }, loadingEl()));
        node = view === "search" ? await searchView(searchQuery) : await discoverView();
      }
    } catch (e) {
      node = errorView(e);
    }
    if (token !== renderToken) return;
    app.replaceChildren(node);
    if (view === "watchlist" || view === "watched" || view === "social") window.scrollTo(0, scrollY);
    else if (view !== "settings") window.scrollTo(0, 0);
  }

  function go(v) {
    view = v;
    searchQuery = "";
    $("#q").value = "";
    syncNav();
    render();
  }

  // ---------------------------------------------------------------
  //  Scheda di dettaglio
  // ---------------------------------------------------------------
  const modal = $("#modal");

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });
  modal.addEventListener("close", () => { if (job) job.cancel = true; modalKey = null; modalItem = null; modal.replaceChildren(); });

  function renderModalActions() {
    const slot = $("#modalActions", modal);
    if (slot && modalItem) slot.replaceChildren(...actionsEl(modalItem, true).childNodes);
  }

  async function openDetail(item) {
    modalKey = item.key;
    modalItem = item;
    modal.replaceChildren(h("div", { class: "modal-body" }, loadingEl()));
    if (!modal.open) modal.showModal();

    let d = null;
    if (TMDB.hasKey()) {
      try { d = await TMDB.details(item.type, item.id); } catch (e) { /* si usa il riepilogo salvato */ }
    }
    if (modalKey !== item.key) return;
    renderDetail(d ? { ...item, ...d } : item, !!d);

    if (d) {
      try {
        const sim = (await TMDB.recommendations(item.type, item.id)).filter((i) => i.poster).slice(0, 14);
        if (modalKey === item.key && sim.length) {
          $(".modal-body", modal).append(h("div", { class: "dsection" }, h("h4", {}, "Ti potrebbe piacere"),
            h("div", { class: "row" }, sim.map((i) => card(i)))));
        }
      } catch (e) { /* facoltativo */ }
    }
  }

  function renderDetail(d, full) {
    const facts = [
      TYPE_LABEL[d.type],
      d.runtime ? fmtRuntime(d.runtime) : "",
      d.seasons ? `${d.seasons} stagion${d.seasons > 1 ? "i" : "e"} · ${d.episodes} episodi` : "",
      ...(d.genres || []),
    ].filter(Boolean);

    const body = h("div", { class: "modal-body" },
      h("button", { class: "close", type: "button", "aria-label": "Chiudi", onclick: () => modal.close() }, "✕"),
      d.backdrop
        ? h("div", { class: "hero", style: `background-image:linear-gradient(transparent 30%, var(--panel)), url('${TMDB.img(d.backdrop, "w780")}')` })
        : h("div", { class: "hero plain" }),
      h("div", { class: "detail" },
        h("div", { class: "dposter" }, d.poster
          ? h("img", { src: TMDB.img(d.poster, "w342"), alt: d.title })
          : h("div", { class: "noimg" }, d.title)),
        h("div", { class: "dinfo" },
          h("h2", {}, d.title, d.year ? h("span", { class: "yr" }, d.year) : null),
          d.tagline ? h("div", { class: "tagline" }, d.tagline) : null,
          h("div", { class: "facts" },
            d.rating ? h("span", { class: "fact score2" }, "★ " + Number(d.rating).toFixed(1) + (d.votes ? ` (${d.votes.toLocaleString("it-IT")})` : "")) : null,
            facts.map((f) => h("span", { class: "fact" }, f))),
          d.directors && d.directors.length
            ? h("div", { class: "line" }, d.type === "tv" ? "Creato da " : "Regia di ", h("b", {}, d.directors.join(", "))) : null,
          h("p", { class: "overview" }, d.overview || "Nessuna trama disponibile in italiano."),
          h("div", { id: "modalActions" }),
          h("div", { class: "links" },
            d.trailer ? h("a", { href: d.trailer, target: "_blank", rel: "noopener" }, "▶ Guarda il trailer") : null,
            h("a", { href: `https://www.themoviedb.org/${d.type}/${d.id}`, target: "_blank", rel: "noopener" }, "Scheda su TMDB"))
        )),
      !full ? h("div", { class: "dsection" }, h("div", { class: "hint" },
        "Dettagli completi non disponibili (nessuna connessione o chiave TMDB mancante).")) : null,
      d.cast && d.cast.length
        ? h("div", { class: "dsection" }, h("h4", {}, "Cast"),
            h("div", { class: "cast" }, d.cast.map((c) =>
              h("div", { class: "person" },
                c.photo ? h("img", { src: TMDB.img(c.photo, "w185"), alt: c.name, loading: "lazy" }) : h("div", { class: "ph" }),
                h("div", {}, c.name), h("div", { class: "c" }, c.character)))))
        : null,
      provSection(d)
    );
    modal.replaceChildren(body);
    renderModalActions();
  }

  function provSection(d) {
    const p = d.providers;
    if (!p) return null;
    const groups = [["Streaming", p.flatrate], ["Noleggio", p.rent], ["Acquisto", p.buy]]
      .filter(([, l]) => l && l.length);
    if (!groups.length) return null;
    return h("div", { class: "dsection" }, h("h4", {}, "Dove guardarlo in Italia"),
      groups.map(([label, list]) =>
        h("div", { class: "prov" }, h("span", { class: "lbl" }, label),
          list.map((x) => h("img", { src: TMDB.img(x.logo_path, "w92"), alt: x.provider_name, title: x.provider_name })))),
      h("div", { class: "muted", style: "font-size:11px" }, "Dati: JustWatch"));
  }

  // ---------------------------------------------------------------
  //  Avvio
  // ---------------------------------------------------------------
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));

  const q = $("#q");
  let searchTimer;
  function runSearch() {
    const text = q.value.trim();
    if (text.length < 2) return;
    searchQuery = text;
    view = "search";
    syncNav();
    render();
  }
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    if (!q.value.trim()) { if (view === "search") go("watchlist"); return; }
    searchTimer = setTimeout(runSearch, 400);
  });
  $("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      q.focus();
    }
  });

  // se cambia qualcosa da un'altra scheda (es. il player che salva il punto)
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.library) {
      const stamp = ch.libStamp && ch.libStamp.newValue;
      if (!(stamp && ownStamps.has(stamp))) { lib = ch.library.newValue || {}; updateCounts(); }
    }
    if (ch.backupIssue) { backupIssue = ch.backupIssue.newValue || ""; renderSyncBar(); }
    if (ch.progress) {
      scheduleFileSync();
      if (view === "continue") render();
    }
    if (ch.social) {
      social = ch.social.newValue || {};
      updateCounts();
      // i dati degli amici cambiano in continuazione: ridisegno senza esagerare
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement && document.activeElement.tagName) || "");
      if (view === "social" && !typing && Date.now() - lastSocialRender > 5000) {
        lastSocialRender = Date.now();
        render();
      }
    }
  });

  // chiudendo la scheda tenta un'ultima sincronizzazione con il file
  document.addEventListener("visibilitychange", () => { if (document.hidden) fileSync(false); });

  (async function init() {
    const d = await chrome.storage.local.get(["library", "settings", "backupIssue", "social"]);
    lib = d.library || {};
    backupIssue = d.backupIssue || "";
    settings = d.settings || {};
    social = d.social || {};
    TMDB.setKey(settings.tmdbKey || "");
    updateCounts();
    view = !TMDB.hasKey() && !Object.keys(lib).length ? "settings" : "watchlist";
    syncNav();
    if (view === "settings" && !TMDB.hasKey()) {
      $("#app").replaceChildren(setupPanel(false));
    } else {
      render();
    }
    renderSyncBar();
    enrichSoon();      // completa i dati per i consigli dei titoli che ancora non li hanno
    scheduleFileSync(); // allinea backup e file collegato all'apertura
    fileSync(false); // se c'è un file collegato: allinea subito (o mostra "Riattiva")
  })();
})();
