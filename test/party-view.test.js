// The view a party room mounts (game/party-view.js) and the page's side of it (game/hosted.js),
// with a document made of plain objects: what the frame is given, that nothing the room says is
// lost while the game's page loads, and that unmount leaves nothing behind.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HostedParty, findHost } from "../game/hosted.js";
import { mount, preload } from "../game/party-view.js";
import { COUNT_IN, game } from "../game/shared/battle.js";
import { ROUND_SECONDS } from "../game/shared/sim.js";
import { manifest } from "../party.js";

/** A document just big enough for mount(): elements that can be appended, removed and listened to. */
function fakeDocument(search = "") {
  const element = (tag) => ({
    tag,
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    parent: null,
    listeners: {},
    ownerDocument: null,
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    append(child) {
      child.parent = this;
      this.children.push(child);
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    querySelector(selector) {
      return this.children.find((c) => selector.includes("data-cork-and-bell") && "corkAndBell" in c.dataset) ?? null;
    },
  });
  const doc = { createElement: (tag) => Object.assign(element(tag), { ownerDocument: doc }), defaultView: { location: { search } } };
  doc.head = doc.createElement("head");
  return doc;
}

function mounted(overrides = {}, search = "") {
  const doc = fakeDocument(search);
  const container = doc.createElement("div");
  const sent = [];
  const ctx = { room: { members: [] }, you: { role: "player", seat: 1 }, snapshot: { seats: [{ seat: 0 }, { seat: 1 }], t: -3 }, send: (d) => sent.push(d), now: () => 5000, ...overrides };
  const view = mount(container, ctx);
  return { doc, container, view, sent, ctx, frame: container.children[0] };
}

describe("the manifest, for a party room", () => {
  it("names the view module among the files a host serves", () => {
    expect(manifest.lobby.view).toBe("game/party-view.js");
    expect(existsSync(new URL(`../${manifest.lobby.view}`, import.meta.url))).toBe(true);
    expect(manifest.public.some((entry) => manifest.lobby.view.startsWith(entry.from + "/"))).toBe(true);
  });

  it("says a battle is two to four and that one plays alone, so a room's sign reads 1-4", () => {
    expect(manifest.players).toEqual({ min: 2, max: 4, solo: true });
    expect(manifest.blurb.length).toBeGreaterThan(5);
  });
});

describe("mounting the view", () => {
  it("adds one frame, on the game's own page in hosted mode, with the host on it", () => {
    const { container, frame, view, ctx } = mounted({ inset: { right: 56 } });
    expect(container.children).toHaveLength(1);
    expect(frame.tag).toBe("iframe");
    expect(view.frame).toBe(frame);
    expect(view.full).toBe(true);
    const address = new URL(frame.src);
    expect(address.pathname.endsWith("/game/party-view.js")).toBe(false);
    expect(address.pathname.endsWith("/")).toBe(true);
    expect(address.searchParams.get("party")).toBe("1");
    expect(frame.partyHost).toMatchObject({ room: ctx.room, you: ctx.you, snapshot: ctx.snapshot, inset: { top: 0, right: 56 } });
    expect(frame.partyHost.now()).toBe(5000);
    // Laid out through the style object, never a style attribute (a host's CSP may forbid those).
    expect(frame.attrs.style).toBeUndefined();
    expect(frame.style).toMatchObject({ position: "absolute", width: "100%", height: "100%" });
  });

  it("passes a test run's cork-auto and cork-quality on to the game's page, and nothing else", () => {
    const { frame } = mounted({}, "?cork-auto=1&cork-quality=low&join=1234&auto=0");
    // A host that has rewritten its own address hands over the query it was opened with.
    const later = mounted({ params: new URLSearchParams("cork-auto=1") }, "");
    expect(new URL(later.frame.src).searchParams.get("auto")).toBe("1");
    const q = new URL(frame.src).searchParams;
    expect([q.get("auto"), q.get("quality"), q.get("join")]).toEqual(["1", "low", null]);
  });

  it("keeps what the room says until the page is ready, then hands it over in order", () => {
    const { frame, view } = mounted();
    const heard = [];
    frame.partyHost.on("events", (list) => heard.push(["events", list]));
    frame.partyHost.on("snapshot", (s, now, full) => heard.push(["snapshot", s.n, now, full]));
    view.events([{ k: "f", seat: 0 }]);
    view.snapshot({ n: 1 }, 6000);
    view.events([{ k: "hit" }]);
    expect(heard).toEqual([]);
    frame.partyHost.ready();
    expect(heard).toEqual([["events", [{ k: "f", seat: 0 }]], ["snapshot", 1, 6000, false], ["events", [{ k: "hit" }]]]);
    view.snapshot({ n: 2 }, 7000, true);
    expect(heard.at(-1)).toEqual(["snapshot", 2, 7000, true]);
  });

  it("sends the page's inputs to the room", () => {
    const { frame, sent } = mounted();
    frame.partyHost.send({ f: [1, 0, 1.2] });
    expect(sent).toEqual([{ f: [1, 0, 1.2] }]);
  });

  it("unmounts completely: the page is told to let go, the frame is gone, and nothing is passed on after", () => {
    const { container, frame, view, sent } = mounted();
    const host = frame.partyHost;
    const heard = [];
    host.on("events", (list) => heard.push(list));
    host.ready();
    let disposed = 0;
    host.dispose = () => disposed++;
    view.unmount();
    expect(disposed).toBe(1);
    expect(container.children).toHaveLength(0);
    expect(frame.partyHost).toBeNull();
    view.events([{ k: "late" }]);
    host.send({ f: [2, 0, 1] });
    expect(heard).toEqual([]);
    expect(sent).toEqual([]);
    view.unmount(); // twice is harmless
    expect(disposed).toBe(1);
  });

  it("unmounts a page that never loaded, or whose dispose throws", () => {
    const first = mounted();
    first.view.events([{ k: "f" }]);
    first.view.unmount();
    expect(first.container.children).toHaveLength(0);
    const second = mounted();
    second.frame.partyHost.dispose = () => {
      throw new Error("already gone");
    };
    expect(() => second.view.unmount()).not.toThrow();
    expect(second.container.children).toHaveLength(0);
  });

  it("can fetch the game's big files ahead of time, once", () => {
    const doc = fakeDocument();
    preload(doc);
    const n = doc.head.children.length;
    expect(n).toBeGreaterThan(4);
    expect(doc.head.children.every((link) => /\/game\//.test(link.href) && ["modulepreload", "prefetch"].includes(link.rel))).toBe(true);
    preload(doc);
    expect(doc.head.children).toHaveLength(n);
  });
});

describe("the page's side", () => {
  it("is hosted only with ?party=1 inside a frame that carries a host", () => {
    const host = { you: { role: "player", seat: 0 } };
    expect(findHost(new URLSearchParams("party=1"), { frameElement: { partyHost: host } })).toBe(host);
    expect(findHost(new URLSearchParams(""), { frameElement: { partyHost: host } })).toBeNull();
    expect(findHost(new URLSearchParams("party=1"), { frameElement: null })).toBeNull();
    const foreign = {
      get frameElement() {
        throw new Error("cross-origin");
      },
    };
    expect(findHost(new URLSearchParams("party=1"), foreign)).toBeNull();
  });

  it("answers the round's needs from the host: the clock, inputs, events and snapshots", () => {
    const { frame, sent } = mounted();
    const party = new HostedParty(frame.partyHost);
    expect(party.you).toEqual({ role: "player", seat: 1 });
    expect(party.now()).toBe(5000);
    party.sendInput({ pick: 0 });
    expect(sent).toEqual([{ pick: 0 }]);
    const heard = [];
    const off = party.on("events", (list) => heard.push(list));
    expect(party.on("room", () => heard.push("room"))()).toBeUndefined();
    frame.partyHost.ready();
    frame.partyHost.on("events", () => {});
    expect(party.resume()).toBe(false);
    off();
  });
});

describe("a round started by a party room", () => {
  it("plays one seat alone to the end and gives it a result row", () => {
    const state = game.create({ seed: 11, seats: [{ seat: 2, name: "Ann", kind: "human", colour: "#d9a02a" }], now: 0, round: 1 });
    let now = 0;
    while (!game.isOver(state) && now < (ROUND_SECONDS + COUNT_IN + 5) * 1000) {
      now += 33;
      for (const input of game.bot(state, 2, now)) game.input(state, 2, input, now);
      game.tick(state, now);
    }
    expect(game.isOver(state)).toBe(true);
    const rows = game.result(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seat: 2, name: "Ann" });
    expect(rows[0].score).toBeGreaterThan(0);
    // The whole round, and no longer: the count-in, ninety seconds, and the hold at the end.
    expect(now / 1000).toBeGreaterThan(ROUND_SECONDS + COUNT_IN);
    expect(now / 1000).toBeLessThan(ROUND_SECONDS + COUNT_IN + 3);
  });
});
