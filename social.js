// Stanza degli amici (documento offscreen).
// Trystero gestisce signaling + WebRTC diretto tra le estensioni: qui teniamo due
// stanze, una per la cerchia (presenza, inviti) e una per la visione insieme
// (stato del player), e parliamo solo col service worker.
(() => {
  "use strict";
  const T = window.Trystero;
  const APP = "riprendi-da-qui-social-v1";
  const PRESENCE_MS = 6000;
  const STALE_MS = 45000;

  let me = { id: "", name: "" };
  let myWatch = null;
  let circle = null;   // { code, room, sendPresence, sendInvite, sendHello }
  let party = null;    // { code, role, room, sendState, sendEvent, sendHello, timer }
  let peers = new Map();
  let publishTimer = null;
  let presenceTimer = null;
  let pruneTimer = null;

  const send = (msg) => {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
  };

  async function hashId(prefix, value) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    return prefix + hex.slice(0, 28);
  }

  function myPresence() {
    return {
      id: me.id || "",
      name: me.name || "Amico",
      watching: myWatch || null,
      party: party ? { code: party.code, role: party.role } : null,
      at: Date.now(),
    };
  }

  function publishPeers() {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      send({
        type: "soc:peers",
        peers: Array.from(peers.values()).map((p) => ({
          peerId: p.peerId, id: p.id, name: p.name, watching: p.watching, party: p.party || null,
        })),
      });
    }, 200);
  }

  function prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of peers) {
      if (now - p.at > STALE_MS) { peers.delete(id); changed = true; }
    }
    if (changed) publishPeers();
  }

  function sendPresence(peerId) {
    if (!circle) return;
    try { circle.presence.send(myPresence(), peerId ? { target: peerId } : undefined); } catch (e) {}
  }

  // ---------- cerchia ----------
  function leaveCircle() {
    clearInterval(presenceTimer); clearInterval(pruneTimer);
    presenceTimer = pruneTimer = null;
    if (circle) {
      try { circle.room.leave(); } catch (e) {}
    }
    circle = null;
    peers.clear();
    publishPeers();
  }

  async function joinCircle(code) {
    code = String(code || "").toLowerCase();
    if (!code) { leaveCircle(); return; }
    if (circle && circle.code === code) { sendPresence(); return; }
    leaveCircle();
    const roomId = await hashId("rq-c-", code);
    const room = T.joinRoom({ appId: APP }, roomId);
    // API trystero: makeAction(name) → { send(data, { target }), onMessage(data, { peerId }) }
    const presenceAct = room.makeAction("p");
    const inviteAct = room.makeAction("i");
    const helloAct = room.makeAction("h");
    circle = { code, room, presence: presenceAct, invite: inviteAct };

    presenceAct.onMessage = (data, meta) => {
      const peerId = meta && meta.peerId;
      if (!peerId || !data || typeof data !== "object") return;
      peers.set(peerId, {
        peerId,
        id: data.id || "",
        name: data.name || "Amico",
        watching: data.watching || null,
        party: data.party || null,
        at: Date.now(),
      });
      publishPeers();
    };
    inviteAct.onMessage = (data, meta) => {
      const peerId = meta && meta.peerId;
      if (!peerId || !data || typeof data !== "object") return;
      if (data.accept) {
        send({ type: "soc:notice", text: (data.from && data.from.name ? data.from.name : "Un amico") + " si è unito alla visione" });
        return;
      }
      send({ type: "soc:invite", invite: { ...data, peerId } });
    };
    helloAct.onMessage = (_data, meta) => sendPresence(meta && meta.peerId);
    // anche gli eventi stanza sono proprietà da assegnare (non metodi da chiamare)
    room.onPeerJoin = (peerId) => { sendPresence(peerId); publishPeers(); };
    room.onPeerLeave = (peerId) => { peers.delete(peerId); publishPeers(); };

    presenceTimer = setInterval(() => { sendPresence(); }, PRESENCE_MS);
    pruneTimer = setInterval(prunePeers, 15000);
    sendPresence();
    send({ type: "soc:circle", joined: true, code, selfId: T.selfId || "" });
  }

  // ---------- visione insieme ----------
  function leaveParty() {
    if (party) {
      clearInterval(party.timer);
      try { party.room.leave(); } catch (e) {}
    }
    party = null;
    send({ type: "soc:partyPeers", count: 0 });
    sendPresence();
  }

  async function joinParty(code, role) {
    code = String(code || "").toLowerCase();
    if (!code) { leaveParty(); return; }
    leaveParty();
    const roomId = await hashId("rq-p-", code);
    const room = T.joinRoom({ appId: APP }, roomId);
    const stateAct = room.makeAction("st");
    const eventAct = room.makeAction("ev");
    const helloAct = room.makeAction("hi");
    party = { code, role: role === "host" ? "host" : "guest", room, sendState: stateAct, sendEvent: eventAct, sendHello: helloAct, timer: null, count: 0 };

    stateAct.onMessage = (data) => {
      if (!data || typeof data !== "object") return;
      send({ type: "soc:event", event: { ...data, kind: "state" } });
    };
    eventAct.onMessage = (data) => {
      if (!data || typeof data !== "object") return;
      send({ type: "soc:event", event: { ...data, kind: data.kind || "sync" } });
    };
    helloAct.onMessage = () => {
      if (!party || party.role !== "host") return;
      // chi entra chiede subito lo stato: il player lo manda al prossimo giro
      send({ type: "soc:needBeat" });
    };
    room.onPeerJoin = () => publishPartyPeers();
    room.onPeerLeave = () => publishPartyPeers();
    // il padrone della festa manda lo stato; se il player tace (scheda chiusa) si ferma
    party.timer = setInterval(() => {
      if (party && party.role === "host") send({ type: "soc:needBeat" });
    }, 2600);

    publishPartyPeers();
    try { helloAct.send({ at: Date.now() }); } catch (e) {}
    sendPresence();
    send({ type: "soc:notice", text: role === "host" ? "Visione insieme avviata" : "Ti sei unito alla visione insieme" });
  }

  function publishPartyPeers() {
    if (!party) return;
    let n = 0;
    try { n = Object.keys(party.room.getPeers() || {}).length; } catch (e) { n = 0; }
    party.count = n;
    send({ type: "soc:partyPeers", count: n });
  }

  // ---------- messaggi dal service worker ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type || !String(msg.type).startsWith("soc:")) return;

    if (msg.type === "soc:state") {
      if (msg.me) me = msg.me;
      if (msg.watching !== undefined) myWatch = msg.watching || null;
      const code = msg.circle && msg.circle.code;
      if (code) joinCircle(code);
      else leaveCircle();
      sendPresence();
      return;
    }
    if (msg.type === "soc:watching") {
      myWatch = msg.watching || null;
      sendPresence();
      return;
    }
    if (msg.type === "soc:profile") {
      if (msg.me) me = { ...me, ...msg.me };
      sendPresence();
      return;
    }
    if (msg.type === "soc:party") {
      if (msg.action === "leave") leaveParty();
      else if (msg.action === "join") joinParty(msg.code, msg.role);
      return;
    }
    if (msg.type === "soc:beat") {
      if (party && party.role === "host" && msg.beat) {
        try { party.sendState.send({ ...msg.beat, at: Date.now() }); } catch (e) {}
      }
      return;
    }
    if (msg.type === "soc:event") {
      if (party && msg.event) { try { party.sendEvent.send({ ...msg.event, at: Date.now() }); } catch (e) {} }
      return;
    }
    if (msg.type === "soc:invite") {
      if (!circle || !msg.peer) return;
      try { circle.invite.send({ ...(msg.info || {}), at: Date.now() }, { target: msg.peer }); } catch (e) {}
      return;
    }
    if (msg.type === "soc:inviteReply") {
      if (!circle || !msg.peer) return;
      try { circle.invite.send({ ...(msg.info || {}), accept: true, at: Date.now() }, { target: msg.peer }); } catch (e) {}
      return;
    }
  });

  // ---------- avvio ----------
  (async function boot() {
    if (!T) { send({ type: "soc:error", error: "NO_LIB" }); return; }
    const { social = {}, settings = {} } = await chrome.storage.local.get(["social", "settings"]);
    me = social.me || me;
    myWatch = (social.me && social.me.watching) || null;
    const code = social.circle && social.circle.code;
    if (code && settings.socialOn !== false) await joinCircle(code);
    if (social.party && social.party.code) await joinParty(social.party.code, social.party.role);
    send({ type: "soc:ready" });
  })();
})();
