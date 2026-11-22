// A test run's short round (cork-round=<s> on a party room's address, ?round=<s> on the game's own
// page): so a host's end-to-end run can play a whole battle in a third of the time. It is a test
// switch, so everything here is about where it is refused: production's `game` never takes it, a
// room made by `testGame` takes it only in the count-in, once, and within bounds, and the high
// score board never scores a short round. A full round is played exactly as before (the golden run,
// test/run.test.js, is unchanged).
import { describe, expect, it } from "vitest";
import { mount, switchesFor } from "../game/party-view.js";
import { LocalSession, NetSession } from "../game/session.js";
import { COUNT_IN, END_HOLD, TEST_ROUND_MAX, TEST_ROUND_MIN, game, roundTime, testGame, testRound } from "../game/shared/battle.js";
import { RUN_VERSION, scoreRun } from "../game/shared/run.js";
import { ROUND_SECONDS } from "../game/shared/sim.js";
import * as party from "../party.js";

const SEATS = [
  { seat: 0, name: "Ann", kind: "human" },
  { seat: 1, name: "Bo", kind: "human" },
];
/** A moment in the count-in, on the room's clock (ms), for a battle started at 0. */
const COUNTING = 500;

/** Ticks a battle to its end the way a room does, bots firing for every seat; returns every event. */
function play(definition, state, from = COUNTING) {
  const events = [];
  for (let now = from; !definition.isOver(state) && now < (ROUND_SECONDS + COUNT_IN + 10) * 1000; now += 33) {
    for (const s of state.seats) for (const input of definition.bot(state, s.seat, now)) definition.input(state, s.seat, input, now);
    events.push(...definition.tick(state, now));
  }
  return events;
}

describe("the bounds", () => {
  it("are whole seconds from 20 to the full round", () => {
    expect([TEST_ROUND_MIN, TEST_ROUND_MAX]).toEqual([20, ROUND_SECONDS]);
    for (const ok of [20, 30, 90]) expect(testRound(ok)).toBe(ok);
    for (const no of [19, 91, 20.5, -20, 0, NaN, Infinity, "20", null, undefined, [20], { s: 20 }]) expect(testRound(no)).toBeNull();
  });
});

describe("production's game", () => {
  it("is what the host's production wall runs, and never takes a short round, whatever a page sends", () => {
    expect(party.game).toBe(game);
    expect(party.testGame).not.toBe(game);
    const state = game.create({ seed: 5, seats: SEATS, now: 0, round: 1 });
    for (const data of [{ round: 20 }, { round: 30 }, { round: "20" }, { round: 20, f: [0.1, 0, 1.2] }, { round: 20, pick: 1 }]) game.input(state, 0, data, COUNTING);
    expect(state.roundSeconds).toBe(ROUND_SECONDS);
    expect(Object.values(state.stalls).every((sim) => sim.roundSeconds === ROUND_SECONDS)).toBe(true);
    expect(game.snapshot(state, COUNTING).roundSeconds).toBe(ROUND_SECONDS);
    const events = play(game, state);
    expect(events.some((e) => e.k === "round")).toBe(false);
    const time = events.find((e) => e.k === "time");
    // Two bots spend their corks before the time call, so the round may end sooner; never at 20.
    expect(time.t).toBeGreaterThan(40);
  });

  it("takes no round length from what its host hands create(), nor does the test game", () => {
    for (const definition of [game, testGame]) {
      const state = definition.create({ seed: 5, seats: SEATS, now: 0, round: 1, roundSeconds: 20 });
      expect(state.roundSeconds).toBe(ROUND_SECONDS);
      expect(state.stalls[0].roundSeconds).toBe(ROUND_SECONDS);
    }
  });
});

describe("the test game", () => {
  it("plays a full round exactly as production's game does, when nobody asks for a short one", () => {
    const a = game.create({ seed: 77, seats: SEATS, now: 0, round: 1 });
    const b = testGame.create({ seed: 77, seats: SEATS, now: 0, round: 1 });
    const ea = play(game, a);
    const eb = play(testGame, b);
    expect(eb).toEqual(ea);
    expect(testGame.result(b)).toEqual(game.result(a));
  });

  it("takes {round: s} in the count-in, once: everyone is told, every snapshot carries it, and time is called then", () => {
    const state = testGame.create({ seed: 9, seats: SEATS, now: 0, round: 1 });
    testGame.input(state, 0, { round: 20 }, COUNTING);
    testGame.input(state, 1, { round: 30 }, COUNTING + 100); // a second ask is ignored
    expect(state.roundSeconds).toBe(20);
    expect(Object.values(state.stalls).every((sim) => sim.roundSeconds === 20)).toBe(true);
    expect(testGame.snapshot(state, COUNTING).roundSeconds).toBe(20);
    const events = play(testGame, state, COUNTING + 33);
    const said = events.filter((e) => e.k === "round");
    expect(said).toEqual([{ k: "round", s: 20 }]);
    const time = events.find((e) => e.k === "time");
    expect(time.t).toBeGreaterThanOrEqual(20);
    expect(time.t).toBeLessThan(20.05);
    // Nothing was fired at or after the time call, by the bots or anyone.
    expect(events.filter((e) => e.k === "fire").every((e) => e.t < 20)).toBe(true);
    expect(testGame.isOver(state)).toBe(true);
  });

  it("refuses a short round after the opening bell, of a length it does not allow, or from no seat", () => {
    const late = testGame.create({ seed: 9, seats: SEATS, now: 0 });
    testGame.input(late, 0, { round: 20 }, COUNT_IN * 1000 + 10);
    expect(roundTime(late, COUNT_IN * 1000 + 10)).toBeGreaterThan(0);
    for (const value of [19, 91, 20.5, "20", null, -1]) {
      const st = testGame.create({ seed: 9, seats: SEATS, now: 0 });
      testGame.input(st, 0, { round: value }, COUNTING);
      expect(st.roundSeconds).toBe(ROUND_SECONDS);
    }
    const nobody = testGame.create({ seed: 9, seats: SEATS, now: 0 });
    testGame.input(nobody, 3, { round: 20 }, COUNTING);
    expect([late.roundSeconds, nobody.roundSeconds]).toEqual([ROUND_SECONDS, ROUND_SECONDS]);
    expect([...late.out, ...nobody.out].some((e) => e.k === "round")).toBe(false);
  });

  it("still takes a cork or a pick that happens to carry a `round`, as a cork or a pick and nothing more", () => {
    const st = testGame.create({ seed: 9, seats: SEATS, now: 0 });
    testGame.input(st, 0, { round: 20, pick: 1 }, COUNTING);
    expect(st.picks[0]).toBe(1);
    expect(st.roundSeconds).toBe(ROUND_SECONDS);
  });
});

describe("a page in a short round", () => {
  /** A host that relays a room as party-view.js would, with the room's clock at `clock.now`. */
  const fakeParty = (clock) => {
    const handlers = { events: new Set(), snapshot: new Set() };
    return {
      now: () => clock.now,
      sendInput: () => {},
      on: (type, fn) => (handlers[type].add(fn), () => handlers[type].delete(fn)),
      emit: (type, ...args) => handlers[type].forEach((fn) => fn(...args)),
    };
  };

  it("runs to the room's round length: from a snapshot that carries it, or from the room's word", () => {
    const state = testGame.create({ seed: 3, seats: SEATS, now: 0 });
    const clock = { now: COUNTING };
    const host = fakeParty(clock);
    const page = new NetSession(host, testGame.snapshot(state, COUNTING), 0);
    expect(page.roundSeconds).toBe(ROUND_SECONDS);
    testGame.input(state, 0, { round: 20 }, COUNTING);
    host.emit("events", testGame.tick(state, COUNTING + 33));
    page.advance();
    expect(page.roundSeconds).toBe(20);
    expect(page.sims[0].roundSeconds).toBe(20);
    // A page that joins later, from a snapshot alone.
    const late = new NetSession(fakeParty({ now: 10_000 }), testGame.snapshot(state, 10_000), 1);
    expect([late.roundSeconds, late.sims[0].roundSeconds, late.sims[1].roundSeconds]).toEqual([20, 20, 20]);
    // Its lever is off at the room's time call.
    clock.now = (COUNT_IN + 19.5) * 1000;
    page.sims[0].lastFire = -10;
    expect(page.canFire()).toBe(true);
    clock.now = (COUNT_IN + 20) * 1000;
    expect(page.canFire()).toBe(false);
  });
});

describe("the view's cork-round switch", () => {
  const fakeDoc = () => {
    const el = (tag) => ({ tag, style: {}, dataset: {}, attrs: {}, children: [], setAttribute() {}, addEventListener() {}, append(c) { this.children.push(c); }, remove() {} });
    const doc = { createElement: (tag) => Object.assign(el(tag), { ownerDocument: doc }), defaultView: { location: { search: "" } } };
    return doc;
  };
  const TEST_ROOM = { members: [], boxes: [{ id: "cork-and-bell" }, { id: "coin-flip", test: true }] };
  const PROD_ROOM = { members: [], boxes: [{ id: "cork-and-bell" }, { id: "tin-derby" }] };
  const mountWith = (room, you, query) => {
    const doc = fakeDoc();
    const container = doc.createElement("div");
    container.ownerDocument = doc;
    const sent = [];
    const view = mount(container, { room, you, snapshot: { seats: [], t: -3 }, send: (d) => sent.push(d), now: () => 0, params: new URLSearchParams(query) });
    return { sent, switches: view.frame.partyHost.switches, src: view.frame.src };
  };

  it("where the room has test games on: a player's view asks the room for the round as it mounts; a screen never does", () => {
    const player = mountWith(TEST_ROOM, { role: "player", seat: 0 }, "join=1234&cork-round=20");
    expect(player.sent).toEqual([{ round: 20 }]);
    expect(player.switches).toBe("round=20");
    expect(new URL(player.src).search).toBe("?party=1");
    expect(mountWith(TEST_ROOM, { role: "screen", seat: -1 }, "cork-round=20").sent).toEqual([]);
    expect(mountWith(TEST_ROOM, { role: "player", seat: 0 }, "cork-round=soon").sent).toEqual([]);
  });

  it("where the room has no test games (production): the switch is never handed over and nothing is asked", () => {
    for (const room of [PROD_ROOM, { members: [] }, null]) {
      const m = mountWith(room, { role: "player", seat: 0 }, "join=1234&cork-round=20&round=20");
      expect(m.sent).toEqual([]);
      expect(m.switches).toBe("");
      expect(new URL(m.src).search).toBe("?party=1");
      expect(switchesFor(room, new URLSearchParams("cork-round=20"))).toBe("");
    }
  });
});

describe("the high score board and a short round", () => {
  /** A solo round on the page with ?round=, played by the game's bot. */
  function shortSolo(seed, roundSeconds) {
    const s = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn: 1, roundSeconds });
    for (let n = 0; !s.over && n < 20000; n++) {
      for (const input of game.bot(s.state, 0, s.now)) s.fire(input.f[1], input.f[2]);
      s.advance(1 / 60);
    }
    return s;
  }

  it("a short solo round on the page ends at its time call (the page also marks it a practice run, main.js)", () => {
    const s = shortSolo(21, 20);
    expect(s.over).toBe(true);
    expect(s.state.endAt).toBeGreaterThanOrEqual(20);
    expect(s.state.endAt).toBeLessThan(20.05);
    expect(s.time()).toBeLessThan(20 + END_HOLD + 0.1);
    expect(s.shots.every(([now]) => now / 1000 - 1 < 20)).toBe(true);
  });

  it("refuses a run that names a round length, full or short, and plays any other on the full round", () => {
    const s = shortSolo(21, 20);
    const run = { seed: 21, countIn: 1, shots: JSON.parse(JSON.stringify(s.shots)), v: RUN_VERSION };
    for (const extra of [{ round: 20 }, { roundSeconds: 20 }, { roundSeconds: ROUND_SECONDS }, { round: 1 }]) expect(scoreRun({ ...run, ...extra })).toBeNull();
    // The same corks with no round length named (which the page never sends: it is a practice run)
    // are played on the full round, where the stall runs on after twenty seconds and the corks in
    // the air at the short time call still land: a full round with few corks, never a short round.
    expect(scoreRun(run)).toBeGreaterThanOrEqual(s.sims[0].score);
  });
});
