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
 *
 * A connection can fail three ways. While `dropped(now)` the page has no socket: it hears
 * nothing and `sendInput` returns false, and when it is back the room sends it a full snapshot at
 * once, outside the tick, as the party kit's room does on a connect (with a bot standing in
 * meanwhile when `standIn`). While `deaf(now)` what the room sends the page is lost (a socket
 * dying from the room's side first). While `mute(now)` the page's inputs are taken and lost on
 * the way (a socket dying from the page's side first).
 */
function makeRoom({ seed = 7, standIn = false, oldRoom = false } = {}) {
  const room = { now: 0, state: game.create({ seed, seats: SEATS, now: 0, round: 1 }), pages: [], inputs: [], ticks: 0, standing: new Set() };
  room.t = () => room.now / 1000 - COUNT_IN;
  room.join = ({ seat = -1, offset = 0, up = () => 20, down = () => 20, frozen = () => false, dropped = () => false, deaf = () => false, mute = () => false, oldPage = false, play = () => {} } = {}) => {
    const page = { seat, down, frozen, dropped, deaf, play, inbox: [], handlers: {}, fired: {}, lastIn: 0, lastUp: 0, away: false, lost: 0 };
    page.party = {
      on: (name, fn) => ((page.handlers[name] ??= []).push(fn), () => {}),
      now: () => room.now + offset,
      sendInput: (d) => {
        if (page.dropped(room.now)) return false;
        page.lastUp = Math.max(page.lastUp, room.now + up(room.now));
        // A page from before corks were numbered sends none.
        const sent = wire(d);
        if (oldPage) delete sent.q;
        if (mute(room.now)) page.lost += 1;
        else room.inputs.push({ at: page.lastUp, sentAt: room.now, seat, d: sent, page });
        return true;
      },
    };
    page.session = new NetSession(page.party, wire(game.snapshot(room.state, room.now)), seat);
    room.pages.push(page);
    return page;
  };
  /** As the room sends it to one page. */
  room.sendTo = (page, name, ...data) => {
    if (page.dropped(room.now) || page.deaf(room.now)) return;
    page.lastIn = Math.max(page.lastIn, room.now + page.down(room.now));
    const sent = wire(data);
    if (oldRoom) {
      // A room from before corks were numbered relays no number and keeps none.
      if (name === "events") for (const e of sent[0]) delete e.q;
      if (name === "snapshot") for (const s of sent[0].stalls) delete s.heard;
    }
    page.inbox.push({ at: page.lastIn, name, data: sent });
  };
  /** As the room sends it: to every page, in order. */
  room.send = (name, ...data) => {
    for (const page of room.pages) room.sendTo(page, name, ...data);
  };
  room.run = (until) => {
    while (room.now < until) {
      room.now += 1;
      room.inputs = room.inputs.filter((i) => {
        if (i.at > room.now) return true;
        // What was on its way when the connection dropped is lost with it.
        if (i.page.droppedSince > i.sentAt) i.page.lost += 1;
        else game.input(room.state, i.seat, i.d, room.now);
        return false;
      });
      for (const page of room.pages) {
        const away = page.dropped(room.now);
        if (away && !page.away) {
          page.droppedSince = room.now;
          if (page.seat >= 0 && standIn) room.standing.add(page.seat);
        }
        if (!away && page.away) {
          room.standing.delete(page.seat);
          for (const fn of page.handlers.status ?? []) fn("open");
          room.sendTo(page, "snapshot", game.snapshot(room.state, room.now), room.now, true);
        }
        page.away = away;
      }
      if (room.now % 33 === 0) {
        room.ticks += 1;
        for (const seat of room.standing) for (const d of game.bot(room.state, seat, room.now)) game.input(room.state, seat, d, room.now);
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

  it("pictures a cork whose word came late, when a rebuild got there first", () => {
    const room = makeRoom();
    const watcher = room.join();
    room.run(5000);
    const seen = [];
    const frame = () => seen.push(...watcher.session.advance(0.016).filter((e) => e.k === "fire").map((e) => e.id));
    // A cork the room fires a tenth of a second from now. Its word is a third of a second on the
    // way: by then the watcher's picture is past the cork's time, and the cork is in the air in the room.
    game.input(room.state, 0, { f: [room.t() - 0.2, 0, 2.6] }, room.now);
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push(...game.tick(room.state, (room.now += 33)));
      frame();
      frame();
    }
    expect(room.state.stalls[0].corks.length).toBe(1);
    expect(seen).toEqual([]);
    // The word arrives, and before the next frame reads it a snapshot rebuilds the stall.
    for (const fn of watcher.handlers.events) fn(wire(events));
    watcher.session.sims[0].score += 1;
    watcher.session.drift[0] = 3;
    for (const fn of watcher.handlers.snapshot) fn(wire(game.snapshot(room.state, room.now)), room.now, false);
    expect(watcher.session.rebuilt).toBe(true);
    for (let i = 0; i < 30; i++) {
      room.now += 16;
      frame();
    }
    expect(seen).toEqual([0]);
  });

  it("pictures a cork whose word was read but not yet acted on, when a rebuild from an older snapshot came first", () => {
    const room = makeRoom();
    const watcher = room.join();
    room.run(5000);
    const seen = [];
    const frame = () => {
      room.now += 16;
      seen.push(...watcher.session.advance(0.016).filter((e) => e.k === "fire").map((e) => e.id));
    };
    // The room hears a cork and takes a snapshot while the cork waits for its time there.
    game.input(room.state, 0, { f: [room.t(), 0, 2.6] }, room.now);
    const snap = wire(game.snapshot(room.state, room.now));
    const events = wire(game.tick(room.state, (room.now += 1)));
    // Both are slow to come: the watcher's picture goes past the cork's time meanwhile.
    for (let i = 0; i < 35; i++) frame();
    expect(seen).toEqual([]);
    // The word is read, and before the next frame acts on it the snapshot rebuilds the stall: the
    // cork is waiting in it, for a time this screen's picture had passed.
    for (const fn of watcher.handlers.events) fn(events);
    for (const fn of watcher.handlers.snapshot) fn(snap, room.now, true);
    for (let i = 0; i < 10; i++) frame();
    expect(seen).toEqual([0]);
  });

  it("pictures every cork the room counts, whatever a page sends for its aim", () => {
    const room = makeRoom();
    const watcher = room.join({ down: () => 40 });
    room.run(4000);
    // Aims as text, off the stall, and not numbers at all: the room fires what it makes of them.
    const aims = [["0", "2.6"], [5, -3], [0.25, "1.5"], [-0.4, 1.1], [null, 2], ["x", 1]];
    for (const [ax, ay] of aims) {
      room.inputs.push({ at: room.now + 1, sentAt: room.now, seat: 0, d: { f: [room.t(), ax, ay] }, page: { lost: 0 } });
      room.run(room.now + 600);
    }
    room.run(room.now + 2000);
    const counted = room.state.stalls[0].shots;
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(watcher.fired[0]).toEqual(each(counted));
    expect(watcher.session.sims[0].shots).toBe(counted);
    // And they flew where the room's did.
    expect(watcher.session.sims[0].rested).toEqual(room.state.stalls[0].rested);
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

/**
 * A page's picture of a stall against the room's: every cork pictured once, and the same corks
 * left. A cork of the page's own that the connection took and lost on the way flew on the page
 * when it was fired, and the room never counted it: the page pictures one more for each of those,
 * and the room's next cork, which has the lost one's number, is pictured as well.
 */
function expectTheRooms(page, room, seat = 0) {
  const theirs = room.state.stalls[seat];
  const mine = page.session.sims[seat];
  const fired = page.fired[seat] ?? [];
  const lost = seat === page.seat ? page.lost : 0;
  if (lost === 0) expect(fired).toEqual(each(theirs.shots));
  else {
    expect([...new Set(fired)].sort((a, b) => a - b)).toEqual(each(theirs.shots));
    expect(fired.length).toBe(theirs.shots + lost);
  }
  expect({ shots: mine.shots, corksLeft: mine.corksLeft }).toEqual({ shots: theirs.shots, corksLeft: theirs.corksLeft });
}

/** Sends the page the whole room again at `at`, as the room does when its socket comes back. */
const handBack = (at, play) => {
  let done = false;
  return (page, room) => {
    play(page, room);
    if (done || room.now < at) return;
    done = true;
    room.sendTo(page, "snapshot", game.snapshot(room.state, room.now), room.now, true);
  };
};

describe("a player's own picture after the connection fails", () => {
  // Fired as fast as the lever allows, the 70 corks are gone a little after 37 s.
  const END = 42000;

  it("comes back with the room's corks when the room's word to it was lost", () => {
    for (const [from, ms] of [
      [6000, 400],
      [6007, 400],
      [6019, 700],
    ]) {
      const room = makeRoom();
      // The room heard the corks, but its word of them never came: the snapshot when the page is
      // back already has them, and they must not fly twice on the page.
      const me = room.join({ seat: 0, up: () => 40, down: () => 40, deaf: (now) => now >= from && now < from + ms, play: handBack(from + ms, hammer) });
      room.run(END);
      expect(room.state.stalls[0].corksLeft).toBe(0);
      expectTheRooms(me, room);
    }
  });

  it("does not picture a cork the connection did not take", () => {
    for (const standIn of [false, true]) {
      for (const from of [5000, 5011, 5023]) {
        const room = makeRoom({ standIn });
        const me = room.join({ seat: 0, up: () => 40, down: () => 40, dropped: (now) => now >= from && now < from + 700, play: hammer });
        room.run(END);
        expectTheRooms(me, room);
      }
    }
  });

  it("tells its corks apart by number, also two at one aim when the first was lost on the way", () => {
    const room = makeRoom();
    // One cork is taken by a dying socket and never reaches the room; the next, at the same aim, does.
    const me = room.join({ seat: 0, up: () => 40, down: () => 40, mute: (now) => now >= 6000 && now < 6500, play: handBack(7300, hammer) });
    room.run(END);
    // Back in step with the room, the page fires the cork that was lost again later.
    expect(room.state.stalls[0].shots).toBe(70);
    expectTheRooms(me, room);
  });

  it("keeps working with a room or a page from before corks were numbered", () => {
    for (const [oldRoom, oldPage] of [
      [true, false],
      [false, true],
    ]) {
      const room = makeRoom({ oldRoom });
      const me = room.join({ seat: 0, up: () => 40, down: () => 40, oldPage, play: handBack(9000, ragged) });
      const watcher = room.join({ down: () => 60, play: handBack(9000, () => {}) });
      room.run(18000);
      me.play = () => {};
      room.run(21000);
      expectTheRooms(me, room);
      expectTheRooms(watcher, room);
    }
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
