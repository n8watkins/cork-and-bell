// Cork & Bell as a view a party room can mount over itself and take away again.
//
// A site that hosts several games in one room (the party site's lobby) starts a battle for the
// seats it already has, with no waiting room. Its page imports this module by the path the
// manifest names (party.js, `lobby.view`) and calls mount() when the round starts:
//
//   const view = mount(container, { room, you, snapshot, send, now, inset });
//   view.events(list);            // what the room's game.tick returned
//   view.snapshot(s, now, full);  // game.snapshot: the periodic one, or a full one after a reconnect
//   view.unmount();               // the round is over: everything is freed
//
// The game is drawn by its own page (../index.html) in a frame of the same origin, in hosted
// mode (?party=1). That is what makes unmount() complete: the page's listeners, timers, sound
// and WebGL context belong to the frame's document and go with it, and nothing of the game is
// ever added to the host's page but the one <iframe>. The frame talks to the host through
// plain function calls on `frame.partyHost` (same origin, so no messages are needed), and the
// game's standalone page is the same file with nothing changed for people who open it directly.

/** Where the game's page is, from wherever a host serves this module. */
const PAGE = new URL("../", import.meta.url);

/**
 * @param {HTMLElement} container  an empty box laid over the host's page; the game fills it
 * @param {object} ctx
 * @param {{members: Array<{name: string, colour: string} | null>}} ctx.room  the host's room view
 * @param {{role: "player" | "screen", seat: number}} ctx.you  who this device is; a screen, or a
 *   player whose seat is not in the round, watches every stall side by side
 * @param {object} ctx.snapshot  game.snapshot at the start (or a full one, joining mid-round)
 * @param {(data: object) => void} ctx.send  sends one input to the room's game.input
 * @param {() => number} ctx.now  the room's clock in ms (the kit client's party.now())
 * @param {{top?: number, right?: number}} [ctx.inset]  CSS pixels at the top right corner that
 *   the host keeps for a button of its own (its door); the game's switches stand clear of it
 * @param {URLSearchParams} [ctx.params]  the host page's query as it was first opened, when the
 *   host has since rewritten its address; only the cork-* switches are read from it
 * @returns {{events: (list: object[]) => void, snapshot: (s: object, now?: number, full?: boolean) => void, unmount: () => void, full: true, frame: HTMLIFrameElement}}
 */
export function mount(container, { room, you, snapshot, send, now, inset = {}, params = null }) {
  const doc = container.ownerDocument;
  const handlers = { events: new Set(), snapshot: new Set() };
  /** What the room said before the game's page had loaded: replayed, in order, when it is ready. */
  let backlog = [];
  let ready = false;
  let gone = false;

  const emit = (type, ...args) => {
    if (gone) return;
    if (!ready) return void backlog.push([type, args]);
    for (const handler of handlers[type]) handler(...args);
  };

  const frame = doc.createElement("iframe");
  /** What the game's page finds on its own frame element. Plain data and functions only. */
  frame.partyHost = {
    room,
    you,
    snapshot,
    inset: { top: inset.top ?? 0, right: inset.right ?? 0 },
    now,
    send: (data) => gone || send(data),
    on(type, handler) {
      handlers[type]?.add(handler);
      return () => handlers[type]?.delete(handler);
    },
    /** The page calls this once its round is set up from `snapshot`: everything missed follows. */
    ready() {
      ready = true;
      for (const [type, args] of backlog.splice(0)) for (const handler of handlers[type]) handler(...args);
    },
    /** Set by the page: frees the lens and the sound at once, instead of when the frame is collected. */
    dispose: null,
  };
  frame.title = "Cork & Bell";
  frame.setAttribute("allow", "autoplay; fullscreen; screen-wake-lock");
  // Set through the style object, never a style attribute: a host's Content-Security-Policy may forbid those.
  Object.assign(frame.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0", display: "block", background: "#0b1020" });
  const address = new URL(PAGE);
  address.searchParams.set("party", "1");
  // A host's test run can ask for the bot to play this seat, or for a quality, as on the game's own
  // page: ?cork-auto=1, ?cork-quality=low, ?cork-grid=row on the host's address (or in ctx.params).
  const asked = params ?? new URLSearchParams(doc.defaultView?.location.search ?? "");
  for (const key of ["auto", "quality", "grid"]) if (asked.has(`cork-${key}`)) address.searchParams.set(key, asked.get(`cork-${key}`));
  frame.src = address.href;
  container.append(frame);
  // Keys aim and fire too, and they go to whichever document has the focus.
  frame.addEventListener("load", () => gone || frame.contentWindow?.focus());

  return {
    /** The view covers the whole container: the host hides its own bars while it is up. */
    full: true,
    frame,
    events: (list) => emit("events", list),
    snapshot: (s, at, full = false) => emit("snapshot", s, at, full),
    unmount() {
      if (gone) return;
      gone = true;
      backlog = [];
      try {
        frame.partyHost.dispose?.();
      } catch {
        // The page never finished loading, or is already gone: removing the frame is enough.
      }
      handlers.events.clear();
      handlers.snapshot.clear();
      frame.partyHost = null;
      frame.remove();
    },
  };
}

/**
 * Optional, for a host that knows a round is about to start (its vote's count is running):
 * fetches the game's page and its largest files ahead of time, so the frame opens from the cache.
 * Safe to call more than once.
 */
export function preload(doc = document) {
  if (doc.head.querySelector("link[data-cork-and-bell]")) return;
  const files = [
    ["game/main.js", "modulepreload"],
    ["game/vendor/three.module.js", "modulepreload"],
    ["game/vendor/three.core.js", "modulepreload"],
    ["game/baked/set.glb", "prefetch"],
    ["game/baked/set_lit.jpg", "prefetch"],
    ["game/baked/set_albedo.jpg", "prefetch"],
    ["game/baked/set_dusk.jpg", "prefetch"],
    ["game/baked/env.hdr", "prefetch"],
  ];
  for (const [path, rel] of files) {
    const link = doc.createElement("link");
    link.rel = rel;
    link.href = new URL(path, PAGE).href;
    link.dataset.corkAndBell = "";
    doc.head.append(link);
  }
}
