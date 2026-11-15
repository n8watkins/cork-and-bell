// A page's picture of a room: every cork the room counted is pictured, once, on the player's own
// page and on every page that watches the stall, however late and bunched the room's word comes
// and however often a stall is rebuilt from a snapshot. (The room and its pages: test/room.js.)
import { describe, expect, it } from "vitest";
import { game, dumpStall, loadStall } from "../game/shared/battle.js";
import { StallSim } from "../game/shared/sim.js";
import { each, hammer, makeRoom, problems, ragged, wire } from "./room.js";

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
    // The watcher's picture has gone past both corks' time: they fire in the same step.
    watcher.session.advance(0.016);
    expect(watcher.session.sims[0].t).toBeGreaterThan(1.5);
    for (const fn of watcher.handlers.events) fn(relayed);
    room.now += 16;
    const fired = watcher.session.advance(0.016).filter((e) => e.k === "fire");
    expect(fired.map((e) => e.id)).toEqual([0, 1]);
    expect(fired[0].t).toBe(fired[1].t);
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
    // The watcher is frozen 1.2 s out of every 4 s. While it is, the room's word piles up, and then
    // the whole room, as a page that reconnects is sent it: it reads them all when it comes back.
    const watcher = room.join({ frozen: (now) => now % 4000 >= 2800 });
    const mayMiss = new Set();
    let mustSee = 0;
    for (let until = 4000; until <= 16000; until += 4000) {
      room.run(until - 1200);
      const seenBefore = Math.max(-1, ...(watcher.fired[0] ?? [])) + 1;
      room.run(until - 100);
      // A cork that flew and came to rest while the page was away was never in the air on it. One
      // still in the air in the room is shown when the page comes back.
      const stall = room.state.stalls[0];
      const flying = new Set(stall.corks.map((c) => c.id));
      for (let id = seenBefore; id < stall.shots; id++) {
        if (flying.has(id)) mustSee += 1;
        else mayMiss.add(id);
      }
      room.send("snapshot", game.snapshot(room.state, room.now), room.now, true);
      room.run(until);
    }
    room.pages[0].play = () => {};
    room.run(19000);
    const counted = room.state.stalls[0].shots;
    const seen = watcher.fired[0];
    expect(mustSee).toBeGreaterThan(0);
    // No cork flies twice, none is missing but those, and the count is the room's.
    expect(new Set(seen).size).toBe(seen.length);
    expect(each(counted).filter((id) => !seen.includes(id) && !mayMiss.has(id))).toEqual([]);
    expect(seen.every((id) => id < counted)).toBe(true);
    expect(watcher.session.sims[0].shots).toBe(counted);
  });
});

describe("a player's own picture of their stall", () => {
  it("fires exactly the corks the room counts, at the fastest the lever allows", () => {
    // Its corks reach the room unevenly (25 to 61 ms on the way), and its clock is off the room's by
    // a few milliseconds or by a quarter of a second. A page that judged its lever by its own stall's
    // time alone pictured a cork, now and then, that the room judged not cocked.
    for (const offset of [-30, 1, 7, 45.5, 250.5]) {
      const room = makeRoom();
      const me = room.join({ seat: 0, offset, up: (now) => 25 + (now % 5) * 9, play: hammer });
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
    expect(counted).toBeGreaterThanOrEqual(20);
    expect(me.fired[0]).toEqual(each(counted));
    expect(me.session.sims[0].shots).toBe(counted);
  });
});

/** Every page's picture of every stall is the room's (test/room.js, problems). */
const expectExact = (room) => {
  for (const page of room.pages) expect(problems(page, room)).toEqual([]);
};
/** A page that draws its stall wrong now and then, so the room's snapshots rebuild it. */
const drifting = (every, play) => (page, room) => {
  play(page, room);
  if (room.now % every === 0 && room.t() > 0.5) page.session.sims[page.seat].score += 1;
};
/**
 * The page fires the moment its own clock says the round has begun (aimed off to the left, so the
 * cork can be told from the others), then as fast as it can from 2 s.
 */
const atTheBell = (page, room) => {
  if (!page.firstGone && page.session.time() >= 0) page.firstGone = page.session.fire(-1, 2.6);
  else if (room.t() > 2) hammer(page, room);
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
      // The room heard the corks, but its word of them never came: the snapshot when the page is
      // back already has them, and they must not fly twice on the page.
      for (const handshake of ["connect", "hello"]) {
        const room = makeRoom({ handshake });
        room.join({ seat: 0, up: () => 40, down: () => 40, deaf: (now) => now >= from && now < from + ms, play: hammer });
        room.run(END);
        expect(room.state.stalls[0].corksLeft).toBe(0);
        expectExact(room);
      }
    }
  });

  it("does not picture a cork the connection did not take", () => {
    for (const standIn of [false, true]) {
      for (const from of [5000, 5011, 5023]) {
        const room = makeRoom({ standIn });
        room.join({ seat: 0, up: () => 40, down: () => 40, dropped: (now) => now >= from && now < from + 700, play: hammer });
        room.run(END);
        expectExact(room);
      }
    }
  });

  it("tells its corks apart by number, also two at one aim when the first was lost on the way", () => {
    const room = makeRoom();
    // One cork is taken by a dying socket and never reaches the room; the next, at the same aim, does.
    const me = room.join({ seat: 0, up: () => 40, down: () => 40, mute: (now) => now >= 6000 && now < 6500, play: hammer });
    room.run(END);
    // The page takes the lost cork back as soon as the room's word passes it, and fires it again later.
    expectExact(room);
    expect(me.lost).toBe(1);
    expect(me.takenBack.size).toBe(1);
    expect(room.state.stalls[0].shots).toBe(70);
  });

  it("keeps working in a room from before corks were numbered", () => {
    // Such a room relays no numbers, says nothing of refusals and keeps none in its snapshots: the
    // page falls back to telling its corks apart by their number in the stall and their aim.
    const room = makeRoom({ oldRoom: true });
    const me = room.join({ seat: 0, up: () => 40, down: () => 40, play: drifting(1700, ragged) });
    const watcher = room.join({ down: () => 60 });
    room.run(9000);
    for (const page of [me, watcher]) room.handBack(page);
    room.run(18000);
    me.play = () => {};
    room.run(21000);
    expectExact(room);
    expect(me.session.numbered).toBe(false);
  });

  it("keeps a room working for a page from before corks were numbered", () => {
    // Its inputs carry no `q`: the room judges and relays them as it always did, keeps no numbers
    // for the seat and refuses nothing more. (The old page's own code is not run here: what is
    // checked is the room, and the newer pages watching that stall.)
    const room = makeRoom();
    const seen = [];
    room.join({ seat: 0, up: () => 40, down: () => 40, oldPage: true, play: ragged });
    const watcher = room.join({ down: () => 60, play: (page, r) => r.now === 9000 && r.handBack(page) });
    const send = room.send;
    room.send = (name, ...data) => (name === "events" && seen.push(...data[0]), send(name, ...data));
    room.run(18000);
    room.pages[0].play = () => {};
    room.run(21000);
    expect(seen.filter((e) => e.k === "f" && e.seat === 0).length).toBe(room.state.stalls[0].queued);
    expect(seen.some((e) => e.q !== undefined || e.k === "no")).toBe(false);
    expect(game.snapshot(room.state, room.now).stalls[0].heard).toBeUndefined();
    expect(room.state.stalls[0].shots).toBeGreaterThanOrEqual(20);
    expect(problems(watcher, room)).toEqual([]);
  });
});

describe("a player's own cork the room never fires", () => {
  it("is taken back at once when it went before the room's bell, and the room's next corks are all shown", () => {
    // Second review, finding 1: a page whose clock is ahead fires at its own t of 0; the room
    // refuses that cork when its time comes. It stayed pictured and counted on the page, and after
    // the next rebuild the room's next real cork had a number the page had used, and was hidden.
    for (const offset of [150, 300]) {
      const room = makeRoom();
      const me = room.join({ seat: 0, offset, up: () => 30, down: () => 30, play: drifting(2400, atTheBell) });
      room.run(16000);
      me.play = () => {};
      room.run(19000);
      expectExact(room);
      expect(me.takenBack).toEqual(new Set(["q1"]));
      expect(room.fires[0][0].q).toBe(2);
    }
  });

  it("is taken back when the door refuses it, also when the room's word of the refusal is lost", () => {
    // Second review, finding 3: a cork refused at the door was dropped from the page's books
    // without its count being taken back. The page here lets a second cork go at once (its lever
    // forced), which the room's door refuses as not cocked.
    for (const deaf of [false, true]) {
      const room = makeRoom();
      const me = room.join({
        seat: 0,
        up: () => 30,
        down: () => 30,
        // The refusal comes 60 ms later: with `deaf`, the room's word for those 200 ms is lost, and
        // the page is handed the whole room when it hears again.
        deaf: (now) => deaf && now >= 6000 && now < 6200,
        play: (page, r) => {
          if (r.now === 5984) {
            page.session.fire(0, 2.6);
            page.session.sims[0].lastFire = -10;
            page.session.lastStamp = -10;
            page.session.fire(0.4, 2.6);
          } else if (r.now > 7000) hammer(page, r);
        },
      });
      room.run(42000);
      expectExact(room);
      expect(me.takenBack.size).toBe(1);
    }
  });

  it("is not refused at the door when an honest page's corks come all at once after its link stalled", () => {
    // Second review, finding 2: a cap of 8 corks waiting refused corks the room would have counted,
    // after an uplink stall of about 4.5 s or more. Every cork an honest page sends is counted.
    for (const stall of [2000, 4500, 6000, 8000]) {
      const room = makeRoom();
      const from = 6000;
      const me = room.join({ seat: 0, up: (now) => (now >= from && now < from + stall ? from + stall - now + 30 : 30), down: () => 30, play: drifting(1900, hammer) });
      room.run(42000);
      expect(room.state.stalls[0].shots).toBe(me.session.q);
      expectExact(room);
      expect(me.takenBack.size).toBe(0);
    }
  });

  it("is still counted when it was sent on the old connection and read after the new one's snapshot", () => {
    // Second review, finding 4: such a cork was let go on the page (it was sent before the new
    // connection opened) and counted by the room: one cork pictured twice, one missing.
    for (const handshake of ["connect", "hello"]) {
      const room = makeRoom({ handshake });
      const me = room.join({ seat: 0, up: () => 30, down: () => 30, play: hammer });
      room.run(6000);
      me.play = () => {};
      room.run(6600);
      // A cork on a slow path (a half-open old socket), then the page is handed the whole room.
      const send = me.party.sendInput;
      me.party.sendInput = (d) => (room.inputs.push({ at: room.now + 400, sentAt: room.now, seat: 0, d: wire(d), page: me }), true);
      expect(me.session.fire(0, 2.6)).toBe(true);
      me.party.sendInput = send;
      room.run(6620);
      room.handBack(me);
      me.play = hammer;
      room.run(42000);
      expectExact(room);
      expect(me.takenBack.size).toBe(0);
    }
  });
});

describe("a stall rebuilt from a snapshot", () => {
  it("goes on exactly as the room's does: corks in the air, corks waiting, and the count", () => {
    const sim = new StallSim(11, 0);
    sim.step(1);
    for (let i = 0; i < 6; i++) sim.fire(1.2 + i * 0.5, -0.6 + i * 0.25, 1.2 + (i % 3) * 0.3, 1.2 + i * 0.5, 0, i + 1);
    sim.step(2.9);
    expect(sim.corks.length).toBeGreaterThan(0);
    expect(sim.pending.length).toBeGreaterThan(0);
    const copy = loadStall(new StallSim(11, 0), wire(dumpStall(sim)));
    sim.events.length = 0;
    sim.step(9);
    copy.step(9);
    expect(copy.shots).toBe(6);
    expect(copy.events.filter((e) => e.k === "fire").map((e) => e.id)).toEqual(sim.events.filter((e) => e.k === "fire").map((e) => e.id));
    expect([copy.shots, copy.hits, copy.score, copy.corksLeft, copy.queued, copy.firedQ]).toEqual([sim.shots, sim.hits, sim.score, sim.corksLeft, sim.queued, sim.firedQ]);
    expect(copy.firedQ).toEqual([1, 2, 3, 4, 5, 6]);
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
