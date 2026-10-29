function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function render() {
  const listEl = document.getElementById("list");
  listEl.innerHTML = "";
  const data = await chrome.storage.local.get("progress");
  const items = Object.values(data.progress || {})
    .filter((r) => r && !r.deleted)
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 8);

  if (!items.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent =
      "Nessun film in corso. Mentre guardi, il punto viene salvato da solo; puoi anche premere “📌 Segna qui” sul player.";
    listEl.appendChild(d);
    return;
  }

  for (const rec of items) {
    const item = document.createElement("div");
    item.className = "item";

    const title = document.createElement("div");
    title.className = "title";
    const name = rec.tmdb ? rec.tmdb.title : rec.title;
    const ep = rec.season || rec.episode ? ` · ${rec.season ? "S" + rec.season : ""}${rec.episode ? "E" + rec.episode : ""}` : "";
    title.textContent = name + ep;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = rec.finished
      ? "Finito"
      : rec.duration
        ? `${fmt(rec.time)} / ${fmt(rec.duration)}`
        : fmt(rec.time);

    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.style.width = rec.duration ? Math.min(100, (rec.time / rec.duration) * 100) + "%" : "0%";
    bar.appendChild(fill);

    const actions = document.createElement("div");
    actions.className = "actions";

    const open = document.createElement("button");
    open.className = "primary";
    open.textContent = rec.finished ? "▶ Apri" : "▶ Apri e riprendi";
    open.addEventListener("click", async () => {
      if (!rec.finished) await chrome.storage.local.set({ autoResume: rec.key });
      chrome.tabs.create({ url: rec.url });
      window.close();
    });

    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Elimina";
    del.addEventListener("click", () => {
      // la scrittura la fa il background (unico scrittore dei progressi): la
      // cancellazione resta una "lapide" e si propaga al backup
      chrome.runtime.sendMessage({ type: "deleteProgress", key: rec.key }, () => {
        void chrome.runtime.lastError;
        render();
      });
    });

    actions.append(open, del);
    item.append(title, meta, bar, actions);
    listEl.appendChild(item);
  }
}

document.getElementById("openDash").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
});

render();
