// The room's half of a cork's identity: every cork is numbered in its stall's line (`n`) and,
// when its page numbers it, by the page (`q`); the room refuses at the door what its stall would
// refuse, says so for every cork it will not fire, and its snapshots rebuild a stall exactly.
// Pages are not changed here: the page as it is today must work against this room no worse
// than against the room before (the last describe).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COUNT_IN, MAX_GAPS, MAX_WAITING, cockedFor, dumpStall, fromRanges, game, landAttacks, loadStall, roundTime, toRanges } from "../game/shared/battle.js";
import { LocalSession } from "../game/session.js";
import { CORKS_PER_ROUND, ROUND_SECONDS, StallSim } from "../game/shared/sim.js";
import { playRound, rng } from "./net-room.js";

const wire = (v) => JSON.parse(JSON.stringify(v));
const humans = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}`, kind: "human" }));

/** A room with human seats, ticked to round time `t`: [state, now]. */
function roomAt(t, n = 1, seed = 5) {
  const state = game.create({ seed, seats: humans(n), now: 0, round: 1 });
  let now = 0;
  while (roundTime(state, now) < t) game.tick(state, (now += 33));
  return [state, now];
}

/** Sends one input and returns what the room says of it (the relay and refusals) by the next tick. */
function send(state, seat, data, now) {
  game.input(state, seat, data, now);
  return state.out.splice(0);
}

describe("the room's verdicts", () => {
  // The same rounds give the same verdicts as the room code before corks were numbered (53c44f2):
  // every stall's score, corks fired, hits, corks left and best run, over bot rounds and
  // LocalSession rounds of one to four stalls. The digests were made by running these rounds on
  // that code with CORKS_PER_ROUND set to this one (35) and its round ending only once every
  // stall is out: when the rules change (the corks a round, say), make them again the same way,
  // from the old room code with the new rule, never from this code's own output. (That code with
  // its own early end, once no more than one stall had corks, still gives the digests these
  // replaced, 5705e43316f7286b and 17604d2e5a97925f.) The full comparison (1,200 rounds of each, and of pages with jittery
  // links) is in pull requests #8 and #9.
  const summary = (seats, stall) =>
    seats
      .map((s) => {
        const x = stall(s.seat);
        return `${s.seat}:${x.score}/${x.shots}/${x.hits}/${x.corksLeft}/${x.best}`;
      })
      .join(" ");
  const digest = (round) => {
    const h = createHash("sha256");
    for (let seed = 1; seed <= 12; seed++) for (let n = 1; n <= 4; n++) h.update(round(seed, n) + "\n");
    return h.digest("hex").slice(0, 16);
  };

  it("are main's for bots", () => {
    const bots = (seed, n) => {
      const seats = Array.from({ length: n }, (_, i) => ({ seat: i, name: `B${i}`, kind: "bot" }));
      const state = game.create({ seed, seats, now: 0, round: 1 });
      let now = 0;
      while (!game.isOver(state) && now < 100000) {
        now += 33;
        for (const s of seats) for (const d of game.bot(state, s.seat, now)) game.input(state, s.seat, d, now);
        game.tick(state, now);
      }
      return summary(seats, (s) => state.stalls[s]);
    };
    expect(CORKS_PER_ROUND).toBe(35); // the digests are for 35 corks a round
    expect(digest(bots)).toBe("831ebb17ead17a7e");
  });

  it("are main's for the solo stall and the demo (LocalSession)", () => {
    const local = (seed, n) => {
      const R = rng(seed * 13 + 1);
      const seats = Array.from({ length: n }, (_, i) => ({ seat: i, name: `L${i}`, kind: i === 0 ? "human" : "bot" }));
      const ses = new LocalSession({ seed, seats, mySeat: 0 });
      let wait = 0;
      for (let k = 0; k < 120 * 100 && !ses.over; k++) {
        const dt = 1 / 60 + (R() - 0.5) * 0.01;
        if (ses.canFire() && (wait -= dt) <= 0) {
          ses.fire((R() - 0.5) * 2.4, 0.5 + R() * 2);
          wait = R() < 0.6 ? 0 : R() * 0.8;
        }
        ses.advance(dt);
      }
      return summary(seats, (s) => ses.sims[s]);
    };
    expect(CORKS_PER_ROUND).toBe(35); // the digests are for 35 corks a round
    expect(digest(local)).toBe("afa860511226d4f0");
  });

  it("judge the corks of a page with no lag at all by their stamps, as any other page's", () => {
    // The one intended change. A page on the same machine or network as the room can stamp a
    // cork in the very millisecond the room hears it: its least lag is exactly 0, and its `want`
    // equals the cork's time. The stall used to throw such a `want` away and judge the cork by its
    // own step (1/120 s): corks fired 0.481 s apart, as the lever allows, were refused, 21 of 29
    // counted in 13.6 s. They are judged by their stamps.
    const [state, start] = roomAt(-2.9);
    const arrive = [];
    for (let t = 4000; t <= 4000 + 13600; t += 481) arrive.push(t);
    let now = start;
    let sent = 0;
    while (now < 20000) {
      now += 33;
      while (sent < arrive.length && arrive[sent] <= now) {
        game.input(state, 0, { f: [roundTime(state, arrive[sent]), 0, 2.6] }, arrive[sent]);
        sent++;
      }
      game.tick(state, now);
    }
    expect(arrive.length).toBe(29);
    // Fewer than a round's corks, so the count is the cocking rule's and not the corks running out.
    expect(arrive.length).toBeLessThan(CORKS_PER_ROUND);
    expect(state.lag[0]).toBe(0);
    expect(state.stalls[0].shots).toBe(29);
  });

  it("still let a page lower its apparent lag for faster corks no more than before (known, not fixed)", () => {
    // A page whose first stamp is 6 s old, then each one 0.15 s less old, sent every 0.34 s for
    // 6.8 s, is given the arrival slack every time: 21 corks, where an honest page firing every
    // 0.48 s gets 10. The same on the room code before corks were numbered (53c44f2, with 35 corks a
    // round: 21). Not fixed here; this keeps a later change from making it worse. (Over 13.6 s it
    // was 41 with 70 corks a round; with 35, the corks run out first, which would hide it.)
    const [state, start] = roomAt(-2.9);
    const sends = [];
    let lag = 6;
    for (let k = 0; ; k++) {
      const arrive = Math.round((4 + k * 0.34) * 1000);
      if (arrive > (4 + 6.8) * 1000) break;
      sends.push({ arrive, stamp: arrive / 1000 - COUNT_IN - lag });
      lag = Math.max(-0.6, lag - 0.15);
    }
    let now = start;
    let i = 0;
    while (now < 20000) {
      now += 33;
      while (i < sends.length && sends[i].arrive <= now) (game.input(state, 0, { f: [sends[i].stamp, 0, 2.6] }, sends[i].arrive), i++);
      game.tick(state, now);
    }
    // The stall still had corks left: the count is the exploit's, not the tray's.
    expect(sends.length).toBe(21);
    expect(state.stalls[0].corksLeft).toBeGreaterThan(0);
    expect(state.stalls[0].shots).toBeLessThanOrEqual(21);
  });
});

describe("the room's door", () => {
  it("refuses only corks the stall would refuse when their time comes", () => {
    // Random stalls with corks waiting (bunched, too close, before the bell, with slack, the stall
    // nearly out of corks) and a new cork: when the door's rule refuses it, the stall itself,
    // given the cork, refuses it too.
    let refused = 0;
    for (let trial = 0; trial < 400; trial++) {
      const R = rng(trial + 1);
      const sim = new StallSim(trial, 0);
      sim.step(-0.4 + R() * 3);
      if (R() < 0.3) sim.corksLeft = Math.floor(R() * 3);
      const t0 = sim.t;
      for (let i = 0, n = Math.floor(R() * 6); i < n; i++) {
        const at = t0 + R() * 0.4;
        sim.fire(at, 0, 2.6, at - R() * 0.6, R() < 0.3 ? R() * 0.15 : 0, i + 1);
      }
      if (R() < 0.5) sim.lastWant = t0 - R() * 0.6;
      const at = t0 + R() * 0.4;
      const want = at - R() * 0.9;
      const slack = R() < 0.3 ? R() * 0.15 : 0;
      if (want - cockedFor(sim, Math.max(at, sim.t)) >= 0.48 - slack) continue;
      refused += 1;
      const copy = loadStall(new StallSim(trial, 0), wire(dumpStall(sim)));
      copy.fire(at, 0, 2.6, want, slack, 999);
      copy.step(t0 + 2);
      expect(copy.firedQ).not.toContain(999);
    }
    expect(refused).toBeGreaterThan(100);
  });

  it("never refuses a cork the stall would fire: honest pages, stalled links and corks out of order", () => {
    // Whole rounds of one to three pages, each with its own clock offset and an uneven link that
    // stalls for 2 to 8 s twice a round, some firing faster than they may and some corks arriving
    // out of order (as from two connections). Every cork the door refuses as not cocked, a copy of
    // the stall as it was, given the cork as the room would have queued it, refuses too. And a
    // page that only ever fires cocked corks, in order, has every one of its round's corks counted.
    // (Each room has two more seats whose players never fire, so the round runs to the bell: it
    // ends early only when every stall is out of corks, and an honest page's last corks must not
    // be refused for the round's end, only by the door.)
    let checked = 0;
    let honestSeats = 0;
    let honestCorks = 0;
    let held = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const R = rng(seed);
      const n = 1 + Math.floor(R() * 3);
      const state = game.create({ seed, seats: humans(n + 2), now: 0, round: 1 });
      const inputs = [];
      const honest = {};
      for (let seat = 0; seat < n; seat++) {
        honest[seat] = R() < 0.5;
        const offset = (R() - 0.5) * 0.6;
        const base = 20 + R() * 100;
        // When the page fires: an honest page its round's corks, each cocked (0.5 to 1.7 s apart);
        // another sometimes too soon, and twice as many as it has.
        const times = [];
        for (let t = 0.3 + R(); t < 88 && times.length < (honest[seat] ? CORKS_PER_ROUND : 2 * CORKS_PER_ROUND); ) {
          times.push(t);
          t += honest[seat] ? 0.5 + R() * 1.2 : R() < 0.3 ? 0.2 + R() * 0.3 : 0.48 + R() * 0.3;
        }
        // The uplink stalls for 2 to 8 s twice while the page is firing, once in each half.
        const first = times[0];
        const span = times[times.length - 1] - first;
        const stalls = [first + R() * span * 0.4, first + span * (0.5 + R() * 0.4)].map((from) => [from, from + 2 + R() * 6]);
        let prev = 0;
        times.forEach((t, k) => {
          const stamp = Math.round((t + offset) * 1000) / 1000;
          let arrive = (t + COUNT_IN) * 1000 + base + R() * 40;
          for (const [from, to] of stalls) if (t >= from && t < to) (arrive = Math.max(arrive, (to + COUNT_IN) * 1000 + base)), (held += honest[seat] ? 1 : 0);
          arrive = Math.round(Math.max(arrive, prev));
          prev = arrive;
          inputs.push({ seat, q: k + 1, arrive, f: [stamp, Math.round((R() - 0.5) * 2400) / 1000, Math.round((0.5 + R() * 2) * 1000) / 1000] });
        });
      }
      // Out of order: now and then a later cork of a dishonest page overtakes the one before it,
      // less than a second ahead (a number more than 3 s late is refused for that: another test).
      inputs.sort((a, b) => a.arrive - b.arrive || a.seat - b.seat);
      for (let i = 1; i < inputs.length; i++) {
        const [a, b] = [inputs[i - 1], inputs[i]];
        if (a.seat === b.seat && !honest[a.seat] && b.arrive - a.arrive < 1000 && R() < 0.15) [inputs[i - 1], inputs[i]] = [{ ...b, arrive: a.arrive }, { ...a, arrive: b.arrive }];
      }
      let now = 0;
      let i = 0;
      const refusedAtDoor = [];
      while (!game.isOver(state) && now < 100000) {
        now += 33;
        while (i < inputs.length && inputs[i].arrive <= now) {
          const x = inputs[i++];
          const sim = state.stalls[x.seat];
          const before = state.lag[x.seat] ?? Infinity;
          const copy = loadStall(new StallSim(state.seed, x.seat), wire(dumpStall(sim)));
          const said = send(state, x.seat, { f: x.f, q: x.q }, x.arrive);
          const no = said.find((e) => e.k === "no" && e.q === x.q);
          if (!no) continue;
          expect(no.why).toBe("cocking");
          refusedAtDoor.push(x.seat);
          // The cork as the room would have queued it (game.input), into the stall as it was.
          const tNow = roundTime(state, x.arrive);
          const lag = state.lag[x.seat];
          const at = Math.max(tNow - 0.5, Math.min(tNow + 0.08, x.f[0]));
          copy.fire(at, x.f[1], x.f[2], Math.min(tNow, x.f[0] + lag), Number.isFinite(before) ? Math.max(0, before - lag) : 0, x.q);
          copy.step(copy.t + 3);
          expect(copy.firedQ).not.toContain(x.q);
          checked += 1;
        }
        game.tick(state, now);
      }
      // The round ran to the bell.
      expect(state.endAt).toBeGreaterThanOrEqual(ROUND_SECONDS);
      for (let seat = 0; seat < n; seat++) {
        if (!honest[seat]) continue;
        const sent = inputs.filter((x) => x.seat === seat).length;
        expect(sent).toBe(CORKS_PER_ROUND);
        expect(refusedAtDoor.filter((s) => s === seat)).toEqual([]);
        expect(state.stalls[seat].shots).toBe(sent);
        expect(state.stalls[seat].firedQ).toEqual(Array.from({ length: sent }, (_, k) => k + 1));
        honestSeats += 1;
        honestCorks += sent;
      }
    }
    // (At 35 corks a round: 895 refusals checked, 56 honest pages, 484 of their corks held back.)
    expect(checked).toBeGreaterThan(400);
    expect(honestSeats).toBeGreaterThan(40);
    expect(honestCorks).toBe(honestSeats * CORKS_PER_ROUND);
    // Honest corks held back by a stalled link, which came to the room in bursts.
    expect(held).toBeGreaterThan(honestSeats * 4);
  });

  it("refuses a stamp or an aim that is not a number, and relays the aim the stall fires", () => {
    // Text was once read with Number() and relayed raw, which every watching screen refused: a
    // page could make its corks invisible to everyone else.
    const [state, now] = roomAt(5, 2);
    let t = now;
    const sent = [
      [["0", "2.6"], 1],
      [[0.25, "1.5"], 2],
      [[null, 2], 3],
      [["x", 1], 4],
    ];
    for (const [[ax, ay], q] of sent) {
      const said = send(state, 0, { f: [roundTime(state, t), ax, ay], q }, t);
      expect(said).toEqual([{ k: "no", seat: 0, q, t: expect.any(Number), why: "aim" }]);
      t += 600;
    }
    expect(send(state, 0, { f: ["5.1", 0, 2] }, t)).toEqual([]);
    expect(state.stalls[0].pending).toEqual([]);
    // Off the stall: the relay carries the aim held to it, and all the stall will judge it by.
    const [f] = send(state, 0, { f: [roundTime(state, t), 5, -3], q: 5 }, t);
    expect(f).toEqual({ k: "f", seat: 0, n: 0, q: 5, at: expect.any(Number), want: expect.any(Number), slack: 0, ax: 1.6, ay: 0.2 });
    expect(f.want).toBe(state.stalls[0].pending[0].want);
    // A page that does not number its corks: no `q`, and nothing else changes for it.
    const [g] = send(state, 1, { f: [roundTime(state, t), 0.5, 1.5] }, t);
    expect(g).toEqual({ k: "f", seat: 1, n: 0, at: expect.any(Number), want: expect.any(Number), slack: 0, ax: 0.5, ay: 1.5 });
  });

  it("keeps the room small whatever a page sends at once", () => {
    const [state, start] = roomAt(7, 4, 3);
    let now = start;
    const quiet = JSON.stringify(game.snapshot(state, now)).length;
    // Two thousand corks in a third of a second, every one of them stamped as cocked.
    const relayed = [];
    for (let k = 0; k < 10; k++) {
      for (let i = 0; i < 200; i++) game.input(state, 0, { f: [roundTime(state, now) + 0.08, 0, 2.6], q: k * 200 + i + 1 }, now);
      relayed.push(...game.tick(state, (now += 33)).filter((e) => e.k === "f"));
    }
    // One is cocked; the door refuses the rest, and does not relay them.
    expect(state.stalls[0].pending.length + state.stalls[0].shots).toBe(1);
    expect(relayed.length).toBe(1);
    const size = JSON.stringify(game.snapshot(state, now)).length;
    expect(size).toBeLessThan(quiet + 400);
    expect(size).toBeLessThan(2600);
    // Numbers all over the place: the gaps kept stay few.
    game.input(state, 2, { f: [roundTime(state, now), 0, 2.6], q: 40 }, now);
    expect(state.heard[2]).toMatchObject({ q: 40 });
    expect(state.heard[2].gaps.map((g) => g[0])).toEqual(Array.from({ length: MAX_GAPS }, (_, i) => 40 - MAX_GAPS + i));
    expect(MAX_GAPS).toBe(16);
    const R = rng(9);
    for (let i = 0; i < 2000; i++) game.input(state, 2, { f: [roundTime(state, now), 0, 2.6], q: 1 + Math.floor(R() * 1e6) }, now);
    expect(state.heard[2].gaps.length).toBeLessThanOrEqual(MAX_GAPS);
    expect(game.snapshot(state, now).stalls[2].gaps.length).toBeLessThanOrEqual(MAX_GAPS);
    // The most that can wait: a page that fired one cork a minute ago, and now sends two thousand
    // stamped half a second apart since then (as one whose link had stalled all that while would,
    // and the room would count them). The backstop keeps 64 of them.
    const [later, t1] = roomAt(1, 4, 3);
    let t = t1;
    game.input(later, 1, { f: [roundTime(later, t), 0, 2.6], q: 1 }, t);
    while (t < 70000) game.tick(later, (t += 33));
    const from = roundTime(later, t1);
    const said = [];
    for (let i = 0; i < 2000; i++) said.push(...send(later, 1, { f: [from + 0.5 * (i + 1), 0, 2.6], q: i + 2 }, t));
    expect(later.stalls[1].pending.length).toBe(MAX_WAITING);
    expect(said.filter((e) => e.k === "no" && e.why === "full").length).toBe(2000 - MAX_WAITING);
    expect(JSON.stringify(game.snapshot(later, t)).length).toBeLessThan(quiet + 12000);
  });
});

describe("a page's numbered corks", () => {
  it("are read once: a number again is refused, and only that page's corks are locked out by a huge one", () => {
    const [state, now] = roomAt(5, 2);
    let t = now;
    const fire = (seat, q) => {
      const said = send(state, seat, { f: [roundTime(state, t), 0, 2.6], q }, t);
      for (let k = 0; k < 20; k++) game.tick(state, (t += 33));
      return said;
    };
    expect(fire(0, 1)[0]).toMatchObject({ k: "f", q: 1, n: 0 });
    // A fresh, cocked stamp with a number read before: refused, not relayed, not counted.
    expect(fire(0, 1)).toEqual([{ k: "no", seat: 0, q: 1, t: expect.any(Number), why: "again" }]);
    expect(fire(0, 2)[0]).toMatchObject({ k: "f", q: 2 });
    // A cheat sends a huge number: counted, and every later cork of its own page is refused...
    expect(fire(0, 2 ** 50)[0]).toMatchObject({ k: "f", q: 2 ** 50 });
    expect(fire(0, 3)).toEqual([expect.objectContaining({ k: "no", q: 3, why: "again" })]);
    // ...and nobody else's.
    expect(fire(1, 1)[0]).toMatchObject({ k: "f", seat: 1, q: 1 });
    expect(fire(1, 2)[0]).toMatchObject({ k: "f", seat: 1, q: 2 });
    for (let k = 0; k < 60; k++) game.tick(state, (t += 33));
    expect(state.stalls[0].firedQ).toEqual([1, 2, 2 ** 50]);
    expect(state.stalls[1].firedQ).toEqual([1, 2]);
    expect(state.stalls[0].shots).toBe(3);
    expect(state.heard[0].gaps.length).toBeLessThanOrEqual(MAX_GAPS);
  });

  it("may come out of order, but a lower number more than 3 s late is refused", () => {
    const [state, now] = roomAt(5);
    let t = now;
    const fire = (q, stamp) => send(state, 0, { f: [stamp, 0, 2.6], q }, t);
    const t0 = roundTime(state, t);
    // 2 is read before 1 (two connections): 1 is still waited for, and taken.
    expect(fire(2, t0 + 0.05)[0]).toMatchObject({ k: "f", q: 2 });
    expect(game.snapshot(state, t).stalls[0]).toMatchObject({ heard: 2, gaps: [1] });
    expect(fire(1, t0 - 0.5)[0]).toMatchObject({ k: "f", q: 1 });
    expect(game.snapshot(state, t).stalls[0]).toMatchObject({ heard: 2, gaps: [] });
    // 4 before 3, and 3 comes after the gap was given up on.
    t += 1000;
    expect(fire(4, roundTime(state, t))[0]).toMatchObject({ k: "f", q: 4 });
    t += 3100;
    expect(game.snapshot(state, t).stalls[0]).toMatchObject({ heard: 4, gaps: [] });
    expect(fire(3, roundTime(state, t))).toEqual([expect.objectContaining({ k: "no", q: 3, why: "again" })]);
  });

  it("are told of every cork the room will not fire: at the door, and when its time comes", () => {
    // In the count-in a cork passes the door (it was cocked) and the stall refuses it when its
    // time comes, before the bell: the page is told, by its number and its place in the line.
    const [state, now] = roomAt(-0.6);
    let t = now;
    expect(send(state, 0, { f: [-0.25, 0, 2.6], q: 1 }, t)[0]).toMatchObject({ k: "f", n: 0, q: 1 });
    const out = [];
    for (let k = 0; k < 40; k++) out.push(...game.tick(state, (t += 33)));
    expect(out.filter((e) => e.k === "no")).toEqual([{ k: "no", seat: 0, n: 0, q: 1, t: expect.any(Number), why: "early" }]);
    // At the door: not cocked (and not relayed).
    t = (COUNT_IN + 4) * 1000;
    while (roundTime(state, t) - state.delay > state.stalls[0].t + 0.05) game.tick(state, (t += 33));
    expect(send(state, 0, { f: [roundTime(state, t), 0, 2.6], q: 2 }, t)[0]).toMatchObject({ k: "f", q: 2, n: 1 });
    expect(send(state, 0, { f: [roundTime(state, t) + 0.05, 0, 2.6], q: 3 }, t)).toEqual([{ k: "no", seat: 0, q: 3, t: expect.any(Number), why: "cocking" }]);
    // A page without numbers is told by place in the line when its time comes, and its pages ignore it.
    const [solo, s0] = roomAt(-0.6, 1, 8);
    send(solo, 0, { f: [-0.25, 0, 2.6] }, s0);
    let s = s0;
    const said = [];
    for (let k = 0; k < 40; k++) said.push(...game.tick(solo, (s += 33)));
    expect(said.filter((e) => e.k === "no")).toEqual([{ k: "no", seat: 0, n: 0, t: expect.any(Number), why: "early" }]);
  });
});

describe("the room's snapshots", () => {
  it("carry each cork's numbers, what the room has read, and when the round ends", () => {
    const [state, now] = roomAt(5, 2);
    let t = now;
    send(state, 0, { f: [roundTime(state, t), -0.5, 1.2], q: 1 }, t);
    for (let k = 0; k < 20; k++) game.tick(state, (t += 33));
    send(state, 0, { f: [roundTime(state, t), 0.5, 1.2], q: 3 }, t);
    send(state, 1, { f: [roundTime(state, t), 0.5, 1.2] }, t);
    game.tick(state, (t += 33));
    const snap = wire(game.snapshot(state, t));
    const [a, b] = snap.stalls;
    expect(a).toMatchObject({ heard: 3, gaps: [2], firedQ: [[1, 1]], queued: 2 });
    expect(a.flying).toEqual([expect.objectContaining({ id: 0, n: 0, q: 1 })]);
    expect(a.pending).toEqual([expect.objectContaining({ n: 1, q: 3, ax: 0.5 })]);
    expect(b.heard).toBeUndefined();
    expect(b.pending).toEqual([expect.objectContaining({ n: 0 })]);
    expect(b.pending[0].q).toBeUndefined();
    expect(snap.endAt).toBeUndefined();
    expect(snap.over).toBeUndefined();
    while (!state.over) game.tick(state, (t += 33));
    const last = game.snapshot(state, t);
    expect(last).toMatchObject({ ended: true, over: true, endAt: state.endAt });
    expect(toRanges([5, 1, 2, 3, 7, 8, 2])).toEqual([[1, 3], [5, 5], [7, 8]]);
    expect(fromRanges([[1, 3], [5, 5], [7, 8]])).toEqual([1, 2, 3, 5, 7, 8]);
  });

  it("go through JSON exactly, and a stall rebuilt from one goes on exactly as the room's", () => {
    // Bots battle, four stalls with attacks; at moments through the round every stall is rebuilt
    // from the snapshot (as JSON), and the copy and the room's stall are both played on, the same
    // attacks landing on both, with corks in the air and waiting. They come out the same to the last bit.
    // The moments are taken from each round itself (a fifth of the way to its end, nearly half,
    // ... nearly the end), at the first tick from there with a cork in the air or waiting, so the
    // test means the same however many corks a round has and so however long the bots take.
    const seats = Array.from({ length: 4 }, (_, i) => ({ seat: i, name: `B${i}`, kind: "bot" }));
    const play = (state, now) => {
      for (const s of seats) for (const d of game.bot(state, s.seat, now)) game.input(state, s.seat, d, now);
      game.tick(state, now);
    };
    const seen = { waiting: 0, flying: 0 };
    const busy = (state) => seats.some((s) => state.stalls[s.seat].pending.length + state.stalls[s.seat].corks.length > 0);
    for (const [seed, part] of [[5, 0.2], [6, 0.45], [7, 0.7], [8, 0.95]]) {
      // How long this round lasts (the same seed plays the same round).
      const dry = game.create({ seed, seats, now: 0, round: 1 });
      for (let now = 33; dry.endAt === null; now += 33) play(dry, now);
      const at = dry.endAt * part;
      const state = game.create({ seed, seats, now: 0, round: 1 });
      let now = 0;
      while (roundTime(state, now) - state.delay < at || !busy(state)) play(state, (now += 33));
      expect(state.endAt).toBeNull();
      const snap = wire(game.snapshot(state, now));
      expect(wire(game.snapshot(state, now))).toEqual(snap);
      let waiting = 0;
      snap.stalls.forEach((d, i) => {
        const copy = loadStall(new StallSim(snap.seed, seats[i].seat), d);
        expect(wire(dumpStall(copy))).toEqual(d);
        const sim = state.stalls[seats[i].seat];
        // Every time that decides what a cork does is the room's own, not rounded.
        for (const k of ["t", "lastWant", "plateDown", "plateUpAt", "stunUntil", "shutterHitAt", "bellHitAt", "jamUntil", "jamAt", "mothsUntil", "darkUntil", "queued"]) expect(d[k], k).toEqual(wire(sim[k]));
        expect(d.pending).toEqual(wire(sim.pending));
        expect(d.flying).toEqual(wire(sim.corks));
        waiting += sim.pending.length + sim.corks.length;
        seen.waiting += sim.pending.length;
        seen.flying += sim.corks.length;
        const attacks = wire(state.attacks);
        const theirs = [];
        const mine = [];
        for (let t = sim.t; t < Math.min(at + 6, 89.9); t += 1 / 30) {
          landAttacks(state.attacks, sim, t);
          landAttacks(attacks, copy, t);
          sim.step(t);
          copy.step(t);
          theirs.push(...sim.events.splice(0));
          mine.push(...copy.events.splice(0));
        }
        expect(mine).toEqual(theirs);
        expect(wire(dumpStall(copy))).toEqual(wire(dumpStall(sim)));
      });
      expect(waiting).toBeGreaterThan(0);
    }
    // Over the four moments, corks both waiting and in the air were rebuilt.
    expect(seen.waiting).toBeGreaterThan(0);
    expect(seen.flying).toBeGreaterThan(0);
    // A bot's times fall on whole milliseconds, which rounding would keep; a page's need not.
    const odd = new StallSim(2, 0);
    odd.step(1);
    odd.fire(1 + 1 / 3, 0, 2.6, 1 + 1 / 7);
    odd.step(1.5);
    expect(wire(dumpStall(odd)).lastWant).toBe(1 + 1 / 7);
    expect(wire(dumpStall(odd)).t).toBe(odd.t);
  });

  it("let a page's own stall rebuilt from one judge the page's next cork by the page's own times", () => {
    // The room fired the page's cork judged by its stamp moved by the page's lag (`want`, 40 ms
    // after the stamp). A page's own stall rebuilt from the room takes that in; the page lets its
    // next cork go 0.49 s after its last, by the lever (lastFire). Judged against the room's
    // `want` it was not cocked, and the page never showed a cork the room counted.
    const sim = new StallSim(3, 0);
    sim.step(4.9);
    sim.fire(5, 0, 2.6, 5.04);
    sim.step(5.5);
    expect(sim.shots).toBe(1);
    const mine = loadStall(new StallSim(3, 0), wire(dumpStall(sim)));
    const next = sim.lastFire + 0.49;
    mine.step(next - 0.001);
    mine.fire(next, 0.4, 2.6);
    mine.step(next + 0.1);
    expect(mine.shots).toBe(2);
    expect(mine.events.filter((e) => e.k === "no")).toEqual([]);
  });

  it("keep a `want` they are given, also one equal to the cork's time", () => {
    const sim = new StallSim(1, 0);
    sim.step(2);
    // Both corks are late and fire in the same step; they were cocked, by the stamps given.
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

describe("today's page against this room", () => {
  // The page is not changed here (game/session.js is main's): it ignores the new event ("no")
  // and the new snapshot fields, and is rebuilt by the new loadStall. Whole rounds on clean,
  // jittery, freezing, dropping and stalling links: what the player's own page and a watching
  // screen picture of a stall, against what the room fired, must be no worse than against
  // the room before corks were numbered. Its numbers were made by running test/net-room.js's
  // playRound beside that room's code (53c44f2) with CORKS_PER_ROUND set to this one (35) and the
  // round ending early only once every stall is out, same seeds: when the rules change, make them
  // again that way, never from this code's own output. (Under the old early end, once no more than
  // one stall had corks, the rounds were shorter and fewer of a dropped link's spells fell inside
  // one: own extra on a dropped link was 10, now 13.)
  const MAIN = {
    clean: { own: [0, 0], watcher: [0, 0, 0] },
    jitter: { own: [0, 0], watcher: [0, 0, 0] },
    frozen: { own: [0, 0], watcher: [0, 0, 0] },
    dropped: { own: [0, 13], watcher: [1, 0, 0] },
    uplinkStall: { own: [0, 0], watcher: [7, 0, 5] },
  };
  for (const [link, main] of Object.entries(MAIN)) {
    it(`pictures corks no worse than against main's room: ${link}`, () => {
      expect(CORKS_PER_ROUND).toBe(35); // the numbers above are for 35 corks a round
      const sum = { own: [0, 0], watcher: [0, 0, 0] };
      for (let seed = 1; seed <= 8; seed++) {
        const r = playRound(link, seed);
        expect(r.errors).toEqual([]);
        // A real round: most of a round's corks fired, and most of the ninety seconds played (it
        // ends when both players are out; a frozen page fires fewer).
        expect(r.counted).toBeGreaterThanOrEqual(CORKS_PER_ROUND * 0.4);
        expect(r.endAt).toBeGreaterThan(ROUND_SECONDS * 0.6);
        sum.own[0] += r.own.missing;
        sum.own[1] += r.own.extra;
        sum.watcher[0] += r.watcher.missing;
        sum.watcher[1] += r.watcher.extra;
        sum.watcher[2] += r.watcher.leftOff;
      }
      for (const who of ["own", "watcher"]) sum[who].forEach((v, i) => expect(v, `${who} ${["missing", "extra", "corks left off"][i]}`).toBeLessThanOrEqual(main[who][i]));
    });
  }
});
