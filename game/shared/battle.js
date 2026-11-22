// The battle: two to four stalls, 90 seconds, attacks and blocks. This is the party kit "game"
// object the room runs. The same code runs in the browser for the solo stall and attract mode,
// with one seat and no delay.
//
// Inputs (never results):  {f: [at, ax, ay], q}  fire at round time `at`, aiming at (ax, ay) on the front row's plane;
//                                             `q` (optional) numbers the page's corks 1, 2, 3 ... in a round
//                          {pick: seat}       choose which rival your attacks go to (-1: the leader)
//                          {round: s}         a test run's short round, s seconds: only testGame takes it
//                                             (see takeRound); `game` ignores it
//
// A page's numbered cork is one cork from end to end: the room carries its `q` on the shot
// waiting, on the cork, in its "fire" event, in the relay ({k: "f"}) and in snapshots (the corks
// waiting and in the air, and `firedQ`, every numbered cork the stall fired). It says which
// numbers it has read (`heard`, the highest, and `gaps`, the lower ones not read yet), and when it
// will not fire a cork, at the door or when its time comes, it says so: {k: "no", seat, n, q}.
// So for every cork it sent, a page can tell from any snapshot whether the room fired it, will
// still judge it, or never will. (Pages that do not number their corks send no `q`, and are
// judged and relayed as before; pages that do not know these fields and events ignore them.)
import { ARRIVAL_SLACK, BELL_FULL, COCK_SECONDS, DT, JAM_MAX_SECONDS, RICOCHET_TIMES, ROUND_SECONDS, StallSim, TASKS, pendulumBob, predict, resetIndex } from "./sim.js";
import { PENDULUMS } from "./layout.js";

export const COUNT_IN = 3;
/** The furthest ahead of the room's clock a page's cork stamps are believed to be, in seconds. */
const MAX_AHEAD = 0.6;
/**
 * A backstop on the corks a stall keeps waiting for their time, far above any honest burst: a
 * page's corks that were held 8 s on the way (a stalled mobile link) arrive together, about 17 of
 * them, and wait together. The door's own rule (see input) already bounds what can wait to what
 * could honestly have been fired.
 */
export const MAX_WAITING = 64;
/** Numbers lower than the highest read and not read yet (`gaps`) are waited for this long, and this many. */
export const GAP_MS = 3000;
export const MAX_GAPS = 16;
export const SIM_DELAY = 0.3; // the room simulates this far behind its clock, so inputs arrive before their time
export const WARNING = 1.5;
export const MOTHS_SECONDS = 4;
export const DARK_SECONDS = 3;
export const END_HOLD = 1.2;
export const ATTACK_NAMES = { jam: "a jammed cork", moths: "a swarm of moths", dark: "a blackout" };
/**
 * A test run's short round, in whole seconds (`{round: s}`, see testRound): never shorter than
 * this, nor longer than the full round. Only a room made by `testGame` takes it.
 */
export const TEST_ROUND_MIN = 20;
export const TEST_ROUND_MAX = ROUND_SECONDS;

function hash(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function roundTime(state, now) {
  return (now - state.startAt) / 1000 - COUNT_IN;
}

/**
 * `roundSeconds` is when time is called: ROUND_SECONDS but in a test run's short round (a
 * LocalSession on the game's own page with ?round=, which is always a practice run, or a room made
 * by testGame that took `{round: s}`). The room's battle code never takes it from ctx: a room
 * made by the production `game` is always ROUND_SECONDS.
 */
export function createBattle({ seed, seats, now, round = 1, delay = SIM_DELAY, botSkill = 0.75, roundSeconds = ROUND_SECONDS }) {
  const state = {
    seed: seed >>> 0,
    round,
    startAt: now,
    delay,
    roundSeconds,
    seats: seats.map((s) => ({ seat: s.seat, name: s.name, kind: s.kind })),
    stalls: {},
    picks: {},
    /** seat -> the least lag its cork stamps have shown, in seconds of round time (input). */
    lag: {},
    /** seat -> the numbers (`q`) read from its page: {q: the highest, gaps: [[q, when], ...] lower ones not read yet}. */
    heard: {},
    bots: {},
    botSkill,
    attacks: [],
    rest: {},
    nextAttack: 1,
    out: [],
    over: false,
    endAt: null,
    keep: false, // the browser keeps the stalls' own events (for the picture and the sound)
    simEvents: [],
  };
  for (const s of seats) {
    const sim = new StallSim(state.seed, s.seat);
    sim.t = -COUNT_IN - delay;
    sim.roundSeconds = roundSeconds;
    state.stalls[s.seat] = sim;
  }
  return state;
}

/** A round length a test run may ask for: a whole number of seconds from TEST_ROUND_MIN to TEST_ROUND_MAX, or null. */
export function testRound(value) {
  return Number.isInteger(value) && value >= TEST_ROUND_MIN && value <= TEST_ROUND_MAX ? value : null;
}

/** Gaps waited for longer than GAP_MS, or beyond MAX_GAPS, are given up: a cork that comes after that is refused. */
function closeGaps(read, now) {
  while (read.gaps.length && (read.gaps.length > MAX_GAPS || now - read.gaps[0][1] > GAP_MS)) read.gaps.shift();
}

/**
 * Notes that the room has read cork `q` from this seat's page. False when the number was read
 * before or given up on. A page's corks are read in the order they were sent, on one connection;
 * one that skips numbers leaves gaps, which a cork still on its way on an older connection fills.
 */
function readCork(state, seat, q, now) {
  const read = (state.heard[seat] ??= { q: 0, gaps: [] });
  closeGaps(read, now);
  if (q <= read.q) {
    const i = read.gaps.findIndex((g) => g[0] === q);
    if (i < 0) return false;
    read.gaps.splice(i, 1);
    return true;
  }
  for (let g = Math.max(read.q + 1, q - MAX_GAPS); g < q; g++) read.gaps.push([g, now]);
  read.q = q;
  closeGaps(read, now);
  return true;
}

/**
 * What a cork due at `at` will be judged cocked against when its time comes: the `want` of the last
 * cork the stall fires before it. The stall fires its waiting corks step by step, those due at a
 * step in the order they came (StallSim.step), each if it is cocked (doFire): that is played
 * through here, for the corks waiting that fire at or before this one's step. A waiting cork is
 * counted as fired only when it surely will be; one that might be refused for its time or for want
 * of corks is counted as not (a cork given back meanwhile could let it fire). So this is never
 * later than the truth, and a cork the door refuses by it the stall would refuse too.
 */
export function cockedFor(sim, at) {
  const stepOf = (a) => Math.max(1, Math.ceil((a - sim.t) / DT - 1e-9));
  const mine = stepOf(at);
  const order = sim.pending
    .map((shot, i) => ({ shot, i, k: stepOf(shot.at) }))
    .filter((x) => x.k <= mine)
    .sort((a, b) => a.k - b.k || a.i - b.i);
  let last = sim.lastWant;
  let left = sim.corksLeft;
  for (const { shot, k } of order) {
    const t = sim.t + k * DT;
    if (sim.over || t < 0 || t >= sim.roundSeconds || left <= 0) continue;
    const want = shot.want ?? t;
    if (want - last < COCK_SECONDS - 0.02 - (shot.slack ?? 0)) continue;
    last = want;
    left -= 1;
  }
  return last;
}

/** How many attacks are on their way to, or at work on, this stall. */
function load(state, seat, t) {
  const sim = state.stalls[seat];
  let n = 0;
  for (const a of state.attacks) if (a.to === seat && !a.done && !a.landed) n++;
  if (t < sim.jamUntil) n++;
  if (t < sim.mothsUntil) n++;
  if (t < sim.darkUntil) n++;
  return n;
}

function rivalOf(state, seat) {
  const pick = state.picks[seat];
  if (pick !== undefined && pick !== seat && state.stalls[pick] && !state.stalls[pick].over) return pick;
  let best = -1;
  for (const s of state.seats) {
    if (s.seat === seat || state.stalls[s.seat].over) continue;
    if (best === -1 || state.stalls[s.seat].score > state.stalls[best].score) best = s.seat;
  }
  return best;
}

/** One player cannot rain the same attack: each kind rests a while after it is sent. */
const REST = { jam: 7, moths: 9, dark: 0 };

function sendAttack(state, type, from, to, t, returned = false) {
  if (to < 0) return;
  if (!returned) {
    const key = `${from}:${type}`;
    if (t < (state.rest[key] ?? -99)) return;
    state.rest[key] = t + REST[type];
  }
  if (load(state, to, t) >= 2) {
    // Never more than two at once: the third one fizzles.
    state.out.push({ k: "fizz", type, from, to, t });
    return;
  }
  const atk = { id: state.nextAttack++, type, from, to, sent: t, at: t + WARNING + state.delay * 1.6, returned, landed: false, done: false };
  state.attacks.push(atk);
  state.out.push({ k: "atk", ...atk });
}

function applyAttack(sim, atk) {
  if (atk.type === "jam") sim.jam(atk.at);
  else if (atk.type === "moths") sim.mothsUntil = atk.at + MOTHS_SECONDS;
  else if (atk.type === "dark") sim.darkUntil = atk.at + DARK_SECONDS;
}

/** Shared by the room and the browsers: land the attacks whose time has come on this stall. */
export function landAttacks(attacks, sim, upTo) {
  for (const a of attacks) {
    if (a.to !== sim.seat || a.landed || a.done || a.at > upTo) continue;
    a.landed = true;
    applyAttack(sim, a);
  }
}

/** What a room's create() passes on: everything but a round length, which a room only takes as a test run's {round: s}. */
function roomCtx(ctx) {
  const { roundSeconds, ...rest } = ctx ?? {};
  return rest;
}

export const game = {
  id: "cork-and-bell",
  minSeats: 2,
  maxSeats: 4,
  tickHz: 30,
  snapshotEvery: 15,

  create(ctx) {
    return createBattle(roomCtx(ctx));
  },

  input(state, seat, data, now) {
    const sim = state.stalls[seat];
    if (!sim || !data || typeof data !== "object") return;
    if (Array.isArray(data.f) && data.f.length === 3) {
      // A page numbers its corks (older pages do not). The number tells the page what became of
      // each of its corks (see the top of this file); nothing is judged by it. A number read
      // before, or given up on (a gap waited for too long), is refused: one number, one cork.
      const q = Number.isSafeInteger(data.q) && data.q > 0 ? data.q : undefined;
      const no = (why) => {
        if (q !== undefined) state.out.push({ k: "no", seat, q, t: roundTime(state, now) - state.delay, why });
      };
      if (q !== undefined && !readCork(state, seat, q, now)) return no("again");
      // A stamp and an aim are numbers, or the cork is refused: what a page sends is relayed to
      // every screen, which must make the same of it as the room. (Text was once read with
      // Number() and relayed raw, and every watching screen refused it.)
      if (!data.f.every(Number.isFinite)) return no("aim");
      const tNow = roundTime(state, now);
      const stamp = data.f[0];
      // The client's own timestamp is used when it is believable, so its picture and the room agree.
      const at = Math.max(tNow - 0.5, Math.min(tNow + 0.08, stamp));
      // Whether the cork was cocked is judged by when the page fired it, in the room's time: its
      // stamp moved by the least lag this player's stamps have shown (state.lag). A page's idea of
      // the room's clock can be off by a second or more (it was 0.25 s ahead and 1 s behind in two
      // runs of the party room's test:cork), and judging by when corks arrived dropped corks the
      // player saw fly. The least lag only falls, so a stamp can never be judged later than it
      // arrived: sending corks faster than they were stamped gains nothing.
      // (A page more than MAX_AHEAD ahead is not believed: corks stamped faster than they are sent
      // cannot buy more than a few, once.)
      const before = state.lag[seat] ?? Infinity;
      const lag = (state.lag[seat] = Math.max(-MAX_AHEAD, Math.min(before, tNow - stamp)));
      const want = Math.min(tNow, stamp + lag);
      // When the least lag has just fallen, the last cork was judged that much late: allow it.
      const slack = Number.isFinite(before) ? Math.max(0, before - lag) : 0;
      // The door refuses a cork the stall will refuse when its time comes, as not cocked: so what
      // waits is no more than could honestly have been fired, however many corks come at once.
      // (See cockedFor: it never refuses a cork the stall would have counted.) A refused cork is
      // not relayed.
      const shotSlack = Math.min(ARRIVAL_SLACK, slack);
      if (want - cockedFor(sim, Math.max(at, sim.t)) < COCK_SECONDS - 0.02 - shotSlack) return no("cocking");
      if (sim.pending.length >= MAX_WAITING) return no("full");
      sim.fire(at, data.f[1], data.f[2], want, slack, q);
      // Every screen mirrors this stall from what is relayed here, and the stall has not judged the
      // cork yet (it does when the cork's time comes). So a screen is sent all the stall will judge
      // it by, `want` and `slack`, and the cork's place in the stall's line (`n`), which tells a
      // screen rebuilt from a snapshot whether the snapshot already had this cork. The page's own
      // number for it (`q`) goes too. The aim is the one the stall will fire (held to the stall),
      // not what the page sent.
      const shot = sim.pending[sim.pending.length - 1];
      state.out.push({ k: "f", seat, n: shot.n, ...(q !== undefined && { q }), at: shot.at, want: shot.want, slack: shot.slack, ax: shot.ax, ay: shot.ay });
    } else if (Number.isInteger(data.pick)) {
      if (data.pick === -1) delete state.picks[seat];
      else if (state.stalls[data.pick] && data.pick !== seat) state.picks[seat] = data.pick;
      state.out.push({ k: "pick", seat, to: state.picks[seat] ?? -1 });
    }
  },

  /** A simple bot: it picks something worth hitting, leads it, holds over for the drop, and is a little off. */
  bot(state, seat, now) {
    const sim = state.stalls[seat];
    const t = roundTime(state, now) - state.delay;
    if (!sim || t < 0.4 || t >= (state.roundSeconds ?? ROUND_SECONDS) || sim.over || sim.corksLeft <= 0) return [];
    const b = (state.bots[seat] ??= { next: 0.5 + hash(state.seed, seat * 977) * 0.8, n: 0 });
    if (t < b.next) return [];
    const r = (k) => hash(state.seed ^ (seat * 7919), b.n * 16 + k);
    b.n += 1;
    const skill = state.botSkill;
    b.next = t + COCK_SECONDS + 0.2 + r(0) * (0.9 / skill);
    const options = sim.targets(t).filter((o) => o.id !== "bell" || sim.bell >= BELL_FULL || r(5) < 0.12);
    if (!options.length) return [];
    // Worth more: the jam (it frees the row), a full bell, then by points and by how near the row is.
    let choice = options[0];
    let bestW = -1;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      let w = o.id === "jam" ? 6 : o.id === "bell" && sim.bell >= BELL_FULL ? 5 : o.row === 0 ? 2.2 : o.row === 1 ? 1.5 : o.id === "sh" ? 1.6 : 1.0;
      if (t < 12 && o.row === 0) w *= 2;
      w *= 0.4 + hash(state.seed ^ (seat * 31 + i), b.n);
      if (w > bestW) {
        bestW = w;
        choice = o;
      }
    }
    // Lead it: where will it be when the cork gets there?
    let tx = choice.x;
    let ty = choice.y;
    let ax = tx;
    let ay = ty;
    for (let i = 0; i < 3; i++) {
      const p = predict(ax, ay, choice.z);
      if (choice.swing !== undefined) {
        const bob = pendulumBob(PENDULUMS[choice.swing], t + 0.03 + p.time);
        tx = bob.x;
        ty = bob.y;
      } else tx = choice.x + choice.vx * (p.time + 0.03);
      ax += tx - p.x;
      ay += ty - p.y;
    }
    let err = (0.062 + choice.row * 0.022) / skill;
    if (t < sim.mothsUntil) err += 0.05;
    if (t < sim.darkUntil) err += 0.07;
    const gx = (r(1) + r(2) + r(3) - 1.5) * 1.4;
    const gy = (r(4) + r(6) + r(7) - 1.5) * 1.4;
    return [{ f: [t + state.delay + 0.02, ax + gx * err, ay + gy * err] }];
  },

  tick(state, now) {
    const t = roundTime(state, now) - state.delay;
    for (const s of state.seats) {
      const sim = state.stalls[s.seat];
      landAttacks(state.attacks, sim, t);
      sim.step(t);
      for (const e of sim.events) {
        // A cork the stall would not fire: its page is told.
        if (e.k === "no") state.out.push(e);
        if (e.k !== "hit") continue;
        if (state.seats.length < 2) continue;
        // Defence: a dead-centre hit inside the warning sends the attack back.
        if (e.perfect) {
          const atk = state.attacks.find((a) => a.to === s.seat && !a.landed && !a.done && !a.returned && e.t < a.at && e.t >= a.sent);
          if (atk) {
            atk.done = true;
            state.out.push({ k: "block", id: atk.id, by: s.seat, t: e.t });
            sendAttack(state, atk.type, s.seat, atk.from, e.t, true);
          }
        }
        if (e.target === "jam") continue;
        if (e.rung) sendAttack(state, "dark", s.seat, rivalOf(state, s.seat), e.t);
        else if (e.ricochet) sendAttack(state, "moths", s.seat, rivalOf(state, s.seat), e.t);
        if (e.streak > 0 && e.streak % 3 === 0) sendAttack(state, "jam", s.seat, rivalOf(state, s.seat), e.t);
      }
      if (state.keep) for (const e of sim.events) state.simEvents.push(e);
      sim.events.length = 0;
      // Out of corks, and the last one has come to rest: this stall has stopped scoring.
      if (!sim.over && sim.corksLeft <= 0 && sim.corks.length === 0 && sim.pending.length === 0 && t < state.roundSeconds) {
        sim.over = true;
        state.out.push({ k: "out", seat: s.seat, t });
      }
    }
    for (const a of state.attacks) if (a.landed && !a.done && t > a.at + JAM_MAX_SECONDS + 1) a.done = true;
    if (state.endAt === null) {
      // The round ends at the time call, or sooner once every stall is out: each has fired its
      // last cork and seen it come to rest (above), so no cork still in the air is cut off and no
      // dead-centre hit can still give a cork back. A stall that never fires its corks (an idle
      // or gone player) is not out, and the round runs to the time call for it.
      const allOut = state.seats.every((s) => state.stalls[s.seat].over);
      if (t >= state.roundSeconds || allOut) {
        state.endAt = t;
        state.out.push({ k: "time", t });
      }
    } else if (!state.over && t >= state.endAt + END_HOLD) {
      state.over = true;
    }
    return state.out.splice(0);
  },

  snapshot(state, now) {
    const t = roundTime(state, now) - state.delay;
    return {
      t,
      startAt: state.startAt,
      seed: state.seed,
      round: state.round,
      delay: state.delay,
      // When time is called (ROUND_SECONDS, or a test run's short round): every page, its bot and
      // the room run to the same clock. In every snapshot, the first included.
      roundSeconds: state.roundSeconds,
      seats: state.seats,
      picks: state.picks,
      ended: state.endAt !== null,
      ...(state.endAt !== null && { endAt: state.endAt }),
      // The round is over: the room fires nothing more.
      ...(state.over && { over: true }),
      stalls: state.seats.map((s) => {
        const read = state.heard[s.seat];
        if (read) closeGaps(read, now);
        return dumpStall(state.stalls[s.seat], read);
      }),
      attacks: state.attacks.filter((a) => !a.done),
    };
  },

  isOver(state) {
    return state.over;
  },

  result(state) {
    return standings(state.seats, (seat) => state.stalls[seat]);
  },
};

/** How far ahead of the room's clock a test run's time call must be when it is asked for, in seconds. */
export const TEST_ROUND_AHEAD = 1;

/**
 * A test run asks for a short round ({round: s}: from party-view.js's cork-round switch as the
 * view mounts, or from a test's own socket once what it checks mid-round is done). Taken only by a
 * room made by testGame (`state.tests`), only a length testRound allows, only shorter than the
 * round is now, only before time is called, and only at least TEST_ROUND_AHEAD seconds ahead of the
 * room's clock (so no page, nor the room's stalls, has passed it yet). Everyone is told
 * ({k: "round", s}), and every snapshot carries it (`roundSeconds`).
 */
function takeRound(state, value, now) {
  const s = testRound(value);
  if (state.tests !== true || s === null || s >= state.roundSeconds || state.endAt !== null || s < roundTime(state, now) + TEST_ROUND_AHEAD) return;
  state.roundSeconds = s;
  for (const seat of state.seats) state.stalls[seat.seat].roundSeconds = s;
  state.out.push({ k: "round", s });
}

/**
 * The same game for a party site's test runs only: a room whose test games are on (the party
 * site's test wall, where PARTY_TEST_GAMES is "on") runs this, and only this takes a test run's
 * short round ({round: s}, takeRound). Production's wall runs `game`, whose input never reads it.
 */
export const testGame = {
  ...game,
  create(ctx) {
    const state = createBattle(roomCtx(ctx));
    state.tests = true;
    return state;
  },
  input(state, seat, data, now) {
    if (data && typeof data === "object" && "round" in data && !("f" in data) && !("pick" in data)) {
      if (state.stalls[seat]) takeRound(state, data.round, now);
      return;
    }
    return game.input(state, seat, data, now);
  },
};

/**
 * No round can score more than this: a shot every time the lever cocks, each one the dearest hit
 * there is (the shutter star, on a run of eight, off a ricochet, dead centre), and both of the
 * dearest challenges. Nobody will come near it; a score above it was not played.
 */
export const MAX_ROUND_SCORE = Math.floor(ROUND_SECONDS / COCK_SECONDS) * Math.round(100 * 3 * RICOCHET_TIMES * 1.5) + 2 * Math.max(...TASKS.map((task) => task.bonus));

export function standings(seats, stallOf) {
  return seats
    .map((s) => {
      const sim = stallOf(s.seat);
      return { seat: s.seat, name: s.name, kind: s.kind, score: sim.score, hits: sim.hits, shots: sim.shots, best: sim.best };
    })
    .sort((a, b) => b.score - a.score || a.seat - b.seat);
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Everything needed to rebuild a stall on a screen that has just (re)joined, or whose picture of
 * it has drifted. What decides which corks fly is sent exactly, not rounded: the stall's time (its
 * steps then fall where the room's do), when the last cork was fired, the corks waiting for their
 * time and the corks in the air. A rebuilt stall goes on to fire the corks the room's will.
 * `read` is what the room has read of the page's numbered corks (see readCork): `heard` and
 * `gaps` go with `firedQ` (as ranges), and the corks waiting and in the air carry their `q`.
 */
export function dumpStall(sim, read) {
  return {
    ...sim.summary(),
    ...(read && { heard: read.q, gaps: read.gaps.map((g) => g[0]) }),
    firedQ: toRanges(sim.firedQ),
    t: sim.t,
    lastFire: r3(sim.lastFire),
    lastWant: sim.lastWant,
    queued: sim.queued,
    pending: sim.pending.map((shot) => ({ ...shot })),
    flying: sim.corks.map((c) => ({ ...c, p: c.p.slice(), v: c.v.slice() })),
    // Everything that decides what a cork hits is sent exactly too: a stall rebuilt from rounded
    // times can see a plate up, or a pendulum stunned, where the room's did not, and its corks go
    // another way from then on. (Only where the corks lie, which decides nothing, is rounded.)
    plateDown: sim.plateDown,
    plateUpAt: sim.plateUpAt,
    starLap: sim.starLap,
    stunUntil: sim.stunUntil,
    shutterHitAt: sim.shutterHitAt,
    bellHitAt: sim.bellHitAt,
    jamUntil: sim.jamUntil,
    jamAt: sim.jamAt,
    mothsUntil: sim.mothsUntil,
    darkUntil: sim.darkUntil,
    rested: sim.rested.map((c) => c.map(r3)),
    // Only the lamps that are out and the prizes that have been knocked: most rounds, nothing.
    lamps: sim.lampOut.flatMap((until, i) => (until > sim.t ? [[i, until]] : [])),
    vases: sim.vaseKnocks.flatMap((n, i) => (n ? [[i, n, sim.vaseDown[i]]] : [])),
    tasks: [sim.taskDone, sim.taskMoons, sim.taskCentres],
  };
}

export function loadStall(sim, d) {
  sim.score = d.score;
  sim.streak = d.streak;
  sim.best = d.best;
  sim.bell = d.bell;
  sim.corksLeft = d.corks;
  sim.shots = d.shots;
  sim.hits = d.hits;
  sim.over = !!d.over;
  sim.t = d.t;
  sim.lastFire = d.lastFire;
  sim.lastWant = d.lastWant ?? d.lastFire;
  sim.plateDown = d.plateDown.slice();
  sim.plateUpAt = d.plateUpAt.slice();
  sim.starLap = d.starLap.slice();
  sim.stunUntil = d.stunUntil.slice();
  sim.shutterHitAt = d.shutterHitAt;
  if (d.bellHitAt !== undefined) sim.bellHitAt = d.bellHitAt;
  sim.jamUntil = d.jamUntil;
  sim.jamAt = d.jamAt;
  sim.mothsUntil = d.mothsUntil;
  sim.darkUntil = d.darkUntil;
  sim.rested = d.rested.map((c) => c.slice());
  sim.lampOut.fill(-10);
  for (const [i, until] of d.lamps ?? []) sim.lampOut[i] = until;
  if (d.tasks) {
    sim.taskDone = d.tasks[0].slice();
    sim.taskMoons = d.tasks[1];
    sim.taskCentres = d.tasks[2];
  }
  sim.vaseKnocks.fill(0);
  sim.vaseDown.fill(-1);
  for (const [i, n, down] of d.vases ?? []) {
    sim.vaseKnocks[i] = n;
    sim.vaseDown[i] = down;
  }
  sim.corks = (d.flying ?? []).map((c) => ({ ...c, p: c.p.slice(), v: c.v.slice() }));
  sim.pending = (d.pending ?? []).map((shot) => ({ ...shot }));
  sim.queued = d.queued ?? 0;
  sim.firedQ = fromRanges(d.firedQ ?? []);
  sim.lastReset = resetIndex(d.t);
  return sim;
}

/** [1, 2, 3, 5, 7, 8] -> [[1, 3], [5, 5], [7, 8]]: a round's numbers run mostly in a line. */
export function toRanges(list) {
  const out = [];
  for (const q of [...list].sort((a, b) => a - b)) {
    const r = out[out.length - 1];
    if (r && q === r[1] + 1) r[1] = q;
    else if (!r || q > r[1]) out.push([q, q]);
  }
  return out;
}

/** The numbers of a list of ranges (toRanges), at most a thousand: a stall fires at most a round's corks. */
export function fromRanges(ranges) {
  const out = [];
  for (const [a, b] of ranges) for (let q = a; q <= b && out.length < 1000; q++) out.push(q);
  return out;
}
