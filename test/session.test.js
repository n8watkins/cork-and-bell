// A page's picture of a room: every cork the room counted is pictured, once, on the player's own
// page and on every page that watches the stall, however late and bunched the room's word comes
// and however often a stall is rebuilt from a snapshot.
import { describe, expect, it } from "vitest";
import { game, dumpStall, loadStall, COUNT_IN } from "../game/shared/battle.js";
import { StallSim } from "../game/shared/sim.js";
import { NetSession } from "../game/session.js";

const wire = (v) => JSON.parse(JSON.stringify(v));
const SEATS = [
  { seat: 0, name: "Ada", kind: "human" },
  { seat: 1, name: "Bo", kind: "human" },
];

/**
 * A room and its pages, a millisecond at a time. The room ticks and sends as the party kit's
 * does (30 times a second, the events and then every 15th tick a snapshot); each page hears it
 * `down(now)` ms later, draws a frame every 16 ms unless `frozen(now)`, and its inputs take
 * `up(now)` ms to reach the room.
 */
function makeRoom({ seed = 7 } = {}) {
  const room = { now: 0, state: game.create({ seed, seats: SEATS, now: 0, round: 1 }), pages: [], inputs: [], ticks: 0 };
  room.t = () => room.now / 1000 - COUNT_IN;
  room.join = ({ seat = -1, offset = 0, up = () => 20, down = () => 20, frozen = () => false, play = () => {} } = {}) => {
    const page = { seat, down, frozen, play, inbox: [], handlers: {}, fired: {}, lastIn: 0, lastUp: 0 };
    page.party = {
      on: (name, fn) => ((page.handlers[name] ??= []).push(fn), () => {}),
      now: () => room.now + offset,
      sendInput: (d) => {
        page.lastUp = Math.max(page.lastUp, room.now + up(room.now));
        room.inputs.push({ at: page.lastUp, seat, d: wire(d) });
      },
    };
    page.session = new NetSession(page.party, wire(game.snapshot(room.state, room.now)), seat);
    room.pages.push(page);
    return page;
  };
  /** As the room sends it: to every page, in order. */
  room.send = (name, ...data) => {
    for (const page of room.pages) {
      page.lastIn = Math.max(page.lastIn, room.now + page.down(room.now));
      page.inbox.push({ at: page.lastIn, name, data: wire(data) });
    }
  };
  room.run = (until) => {
    while (room.now < until) {
      room.now += 1;
      room.inputs = room.inputs.filter((i) => i.at > room.now || (game.input(room.state, i.seat, i.d, room.now), false));
      if (room.now % 33 === 0) {
        room.ticks += 1;
        const events = game.tick(room.state, room.now);
        if (events.length) room.send("events", events);
        if (room.ticks % 15 === 0) room.send("snapshot", game.snapshot(room.state, room.now), room.now, false);
      }
      for (const page of room.pages) {
        if (page.frozen(room.now)) continue;
        while (page.inbox.length && page.inbox[0].at <= room.now) {
          const msg = page.inbox.shift();
          for (const fn of page.handlers[msg.name] ?? []) fn(...msg.data);
        }
        if (room.now % 16 !== 0) continue;
        page.play(page, room);
        for (const e of page.session.advance(0.016)) if (e.k === "fire") (page.fired[e.seat] ??= []).push(e.id);
      }
    }
  };
  return room;
}

/** The cork numbers 0 .. n-1, each once: what a page that pictured every cork of n has seen. */
const each = (n) => Array.from({ length: n }, (_, i) => i);
/**
 * A player who fires as fast as the page lets them, at one spot over the top of the stall. (Not
 * in the first half second: a page whose clock is ahead of the room's can fire before the room's
 * bell, and the room does not count that cork. That is the room's to decide, and not tested here.)
 */
const hammer = (page, room) => room.t() > 0.5 && page.session.fire(0, 2.6);
/** A player a little slower and uneven, so the corks fall anywhere between the room's snapshots. */
const ragged = (page, room) => (room.now * 7919) % 100 < 25 && hammer(page, room);

describe("a watcher's picture of a stall", () => {
  it("fires every cork the room fired when the room's word comes late and bunched", () => {
    const room = makeRoom();
    // The player's page is a quarter of a second ahead of the room's clock, and its corks reach
    // the room unevenly: the room fires them by when they arrive, closer together than they were.
    const jitter = [30, 110, 20, 90, 40, 120, 25];
    room.join({ seat: 0, offset: 250, up: (now) => jitter[Math.floor(now / 500) % jitter.length], play: hammer });
    // The watcher hears nothing for 0.7 s out of every 1.5 s, then all of it at once.
    const watcher = room.join({ down: (now) => (now % 1500 < 700 ? 700 - (now % 1500) : 0) + 20 });
    room.run(14000);
    room.pages[0].play = () => {};
    room.run(17000);
    const counted = room.state.stalls[0].shots;
    expect(counted).toBeGreaterThanOrEqual(18);
    expect(watcher.fired[0]).toEqual(each(counted));
    expect(watcher.session.sims[0].shots).toBe(counted);
  });

  it("judges a relayed cork by the room's own stamp, also when two come in the same step", () => {
    const room = makeRoom();
    const watcher = room.join();
    room.run(4000);
    // Two corks half a second apart by the player's clock; the room's word of both reaches the
    // watcher together, after both were due on its picture.
    const events = [];
    game.input(room.state, 0, { f: [1.0, 0, 2.6] }, room.now);
    for (let i = 0; i < 15; i++) events.push(...game.tick(room.state, (room.now += 33)));
    game.input(room.state, 0, { f: [1.5, 0, 2.6] }, room.now);
    for (let i = 0; i < 40; i++) events.push(...game.tick(room.state, (room.now += 33)));
    expect(room.state.stalls[0].shots).toBe(2);
    const relayed = wire(events.filter((e) => e.k === "f"));
    expect(relayed.length).toBe(2);
    for (const e of relayed) expect(e).toMatchObject({ seat: 0, n: expect.any(Number), want: expect.any(Number), slack: expect.any(Number) });
    for (const fn of watcher.handlers.events) fn(relayed);
    const fired = watcher.session.advance(0.016).filter((e) => e.k === "fire");
    expect(fired.map((e) => e.id)).toEqual([0, 1]);
  });

  it("still fires each cork once when its stall is rebuilt from the room's snapshots", () => {
    const room = makeRoom();
    room.join({ seat: 0, up: (now) => 20 + (now % 7) * 10, play: ragged });
    // Every so often the watcher's picture is made to drift, so the room's snapshots replace it:
    // some of them catch a cork waiting for its time in the room, and corks in the air.
    let rebuilds = 0;
    const watcher = room.join({
      down: () => 60,
      play: (page) => {
        if (room.now % 1600 === 0 && room.t() > 0.5) page.session.sims[0].score += 1;
        if (page.session.rebuilt) rebuilds += 1;
        page.session.rebuilt = false;
      },
    });
    room.run(18000);
    room.pages[0].play = () => {};
    room.run(21000);
    const counted = room.state.stalls[0].shots;
    expect(rebuilds).toBeGreaterThanOrEqual(5);
    expect(counted).toBeGreaterThanOrEqual(25);
    expect(watcher.fired[0]).toEqual(each(counted));
    expect(watcher.session.sims[0].shots).toBe(counted);
  });

  it("fires each cork once after a frozen page comes back and is handed the whole room again", () => {
    const room = makeRoom();
    room.join({ seat: 0, play: hammer });
    const watcher = room.join({ frozen: (now) => now % 4000 >= 2800 });
    for (let until = 4000; until <= 16000; until += 4000) {
      room.run(until - 1300);
      // As a page that reconnects is sent it: the full snapshot, after the events already on their way.
      room.send("snapshot", game.snapshot(room.state, room.now), room.now, true);
      room.run(until);
    }
    room.pages[0].play = () => {};
    room.run(19000);
    const counted = room.state.stalls[0].shots;
    const seen = watcher.fired[0];
    // A cork that came to rest while the page was away was never in the air on it; no cork flies twice,
    // and the count is the room's.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.every((id) => id < counted)).toBe(true);
    expect(watcher.session.sims[0].shots).toBe(counted);
  });
});

describe("a player's own picture of their stall", () => {
  it("fires exactly the corks the room counts, at the fastest the lever allows", () => {
    for (const offset of [-400, -30, 0, 45, 250]) {
      const room = makeRoom();
      const me = room.join({ seat: 0, offset, up: (now) => 25 + (now % 5) * 4, play: hammer });
      room.run(16000);
      me.play = () => {};
      room.run(19000);
      const counted = room.state.stalls[0].shots;
      expect(counted).toBeGreaterThanOrEqual(20);
      expect(me.fired[0]).toEqual(each(counted));
    }
  });

  it("keeps its corks through a rebuild: the ones the room has not fired yet, and the ones it has not heard", () => {
    const room = makeRoom();
    let rebuilds = 0;
    const me = room.join({
      seat: 0,
      up: () => 90,
      down: () => 90,
      play: (page) => {
        ragged(page, room);
        if (room.now % 1700 === 0 && room.t() > 0.5) page.session.sims[0].score += 1;
        if (page.session.rebuilt) rebuilds += 1;
        page.session.rebuilt = false;
      },
    });
    room.run(18000);
    me.play = () => {};
    room.run(21000);
    const counted = room.state.stalls[0].shots;
    expect(rebuilds).toBeGreaterThanOrEqual(3);
    expect(counted).toBeGreaterThanOrEqual(25);
    expect(me.fired[0]).toEqual(each(counted));
    expect(me.session.sims[0].shots).toBe(counted);
  });
});

describe("a stall rebuilt from a snapshot", () => {
  it("goes on exactly as the room's does: corks in the air, corks waiting, and the count", () => {
    const sim = new StallSim(11, 0);
    sim.step(1);
    for (let i = 0; i < 6; i++) sim.fire(1.2 + i * 0.5, -0.6 + i * 0.25, 1.2 + (i % 3) * 0.3, 1.2 + i * 0.5);
    sim.step(2.9);
    expect(sim.corks.length).toBeGreaterThan(0);
    expect(sim.pending.length).toBeGreaterThan(0);
    const copy = loadStall(new StallSim(11, 0), wire(dumpStall(sim)));
    sim.events.length = 0;
    sim.step(9);
    copy.step(9);
    expect(copy.shots).toBe(6);
    expect(copy.events.filter((e) => e.k === "fire").map((e) => e.id)).toEqual(sim.events.filter((e) => e.k === "fire").map((e) => e.id));
    expect([copy.shots, copy.hits, copy.score, copy.corksLeft, copy.queued]).toEqual([sim.shots, sim.hits, sim.score, sim.corksLeft, sim.queued]);
    expect(copy.rested.length).toBe(sim.rested.length);
  });

  it("keeps a `want` it is given, also one equal to the cork's time", () => {
    const sim = new StallSim(1, 0);
    sim.step(2);
    // Both corks are an hour late and fire in the same step; they were cocked, by the stamps given.
    sim.fire(1.0, 0, 2.6, 1.0);
    sim.fire(1.5, 0, 2.6, 1.5);
    sim.step(2.1);
    expect(sim.shots).toBe(2);
    // And without a stamp, a stall judges by its own time: the second is not cocked.
    const own = new StallSim(1, 0);
    own.step(2);
    own.fire(1.0, 0, 2.6);
    own.fire(1.5, 0, 2.6);
    own.step(2.1);
    expect(own.shots).toBe(1);
  });
});
