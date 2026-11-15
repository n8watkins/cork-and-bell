// A session is one round as the browser sees it: the stalls' simulations, the clock, and the
// way inputs leave. LocalSession runs the battle code in the page (solo stall, attract mode,
// the four-stall demo). NetSession follows a room: it sends inputs, mirrors the room's
// simulation for an instant picture, and takes the room's word for everything that matters.
import { COUNT_IN, createBattle, game, landAttacks, loadStall, roundTime, standings, WARNING } from "./shared/battle.js";
import { COCK_SECONDS, ROUND_SECONDS, StallSim } from "./shared/sim.js";

/** Other players' stalls are shown this far in the past, so their shots arrive before they are due. */
export const REMOTE_DELAY = 0.45;

const r3 = (v) => Math.round(v * 1000) / 1000;

export class LocalSession {
  /**
   * @param {{seed: number, seats: Array<{seat:number,name:string,kind:string}>, mySeat?: number, countIn?: number, botSkill?: number}} opts
   */
  constructor({ seed, seats, mySeat = 0, countIn = COUNT_IN, botSkill = 1 }) {
    this.kind = "local";
    this.now = 0;
    this.state = createBattle({ seed, seats, now: (countIn - COUNT_IN) * 1000, delay: 0, botSkill });
    this.state.keep = true;
    for (const s of seats) this.state.stalls[s.seat].t = -countIn;
    this.seats = this.state.seats;
    this.mySeat = mySeat;
    this.sims = this.state.stalls;
    this.attacks = this.state.attacks;
    this.ended = false;
    this.over = false;
  }

  time() {
    return roundTime(this.state, this.now);
  }

  seatTime() {
    return this.time();
  }

  canFire(seat = this.mySeat) {
    const sim = this.sims[seat];
    const t = this.time();
    return t >= 0 && t < ROUND_SECONDS && !sim.over && sim.corksLeft > 0 && t - sim.lastFire >= COCK_SECONDS - 0.02 && this.state.endAt === null;
  }

  fire(ax, ay) {
    if (!this.canFire()) return false;
    game.input(this.state, this.mySeat, { f: [this.time(), ax, ay] }, this.now);
    return true;
  }

  pick(seat) {
    game.input(this.state, this.mySeat, { pick: seat }, this.now);
  }

  /** For looking at one attack on its own (?state=jam and friends). */
  inflict(type, to = this.mySeat) {
    const t = this.time();
    const atk = { id: 9000 + this.attacks.length, type, from: -1, to, sent: t, at: t + WARNING, returned: false, landed: false, done: false };
    this.attacks.push(atk);
    return { k: "atk", ...atk };
  }

  /** Advances by dt seconds. Returns every event, the stalls' own and the battle's, in order. */
  advance(dt) {
    const out = [];
    const step = 1 / 60;
    let left = dt;
    while (left > 1e-6) {
      const d = Math.min(step, left);
      left -= d;
      this.now += d * 1000;
      for (const s of this.seats) {
        if (s.kind !== "bot") continue;
        for (const input of game.bot(this.state, s.seat, this.now)) game.input(this.state, s.seat, input, this.now);
      }
      const events = game.tick(this.state, this.now);
      out.push(...this.state.simEvents.splice(0), ...events);
    }
    this.ended = this.state.endAt !== null;
    this.over = this.state.over;
    return out;
  }

  result() {
    return standings(this.seats, (seat) => this.sims[seat]);
  }
}

export class NetSession {
  constructor(party, snapshot, mySeat) {
    this.kind = "net";
    this.party = party;
    this.mySeat = mySeat;
    this.queue = [];
    this.ended = false;
    this.over = false;
    this.finalResult = null;
    this.history = [];
    this.drift = {};
    /** This page's own corks the room has not relayed back yet, as they were sent: [stamp, ax, ay]. */
    this.sent = [];
    /** The stamp of this page's last cork. The room judges whether a cork was cocked by these. */
    this.lastStamp = -10;
    /** seat -> how far this screen had pictured the stall (round time) when the stall was last rebuilt. */
    this.shown = {};
    /** "fire" events for the corks a rebuild brought already in the air, which this screen never saw leave. */
    this.arrived = [];
    this.adopt(snapshot, true);
    this.off = [
      party.on("events", (events) => this.hear(events)),
      party.on("snapshot", (s, now, full) => (full ? this.adopt(s, true) : this.check(s))),
    ];
  }

  dispose() {
    this.off.forEach((f) => f());
  }

  /** What the room decided, as it arrives. It is acted on at the next advance. */
  hear(events) {
    for (const e of events) {
      if (e.k !== "f" || e.seat !== this.mySeat) continue;
      // The room has our cork. It hears them in the order they were sent, so one sent before this
      // and never relayed was not taken at all.
      const i = this.sent.findIndex((s) => s[1] === e.ax && s[2] === e.ay);
      if (i >= 0) this.sent.splice(0, i + 1);
    }
    this.queue.push(...events);
  }

  adopt(snap, rebuild) {
    const sameRound = snap.startAt === this.startAt && snap.round === this.round;
    this.startAt = snap.startAt;
    this.seed = snap.seed;
    this.round = snap.round;
    this.seats = snap.seats;
    if (rebuild) {
      const before = sameRound ? this.sims : {};
      if (!sameRound) {
        this.sent = [];
        this.lastStamp = -10;
        this.shown = {};
        this.arrived = [];
      }
      this.sims = {};
      snap.seats.forEach((s, i) => {
        const sim = new StallSim(snap.seed, s.seat);
        if (snap.t > -COUNT_IN + 0.2) this.load(sim, snap.stalls[i], before[s.seat]?.t);
        else sim.t = -COUNT_IN - 1;
        this.sims[s.seat] = sim;
      });
      this.attacks = snap.attacks.map((a) => ({ ...a }));
      this.ended = !!snap.ended;
      this.rebuilt = true;
    }
  }

  /**
   * Makes a stall the room's, from a snapshot: its numbers, the corks in the air and the corks
   * waiting for their time. `shown` is how far this screen had pictured the stall, if it had.
   */
  load(sim, theirs, shown) {
    loadStall(sim, theirs);
    if (sim.seat === this.mySeat) {
      // Our own corks the room had not heard when it took the snapshot are not in it, and the
      // room will count them: they fly here as they did. (One the room never relays is let go.)
      const t = this.time();
      this.sent = this.sent.filter((s) => s[0] > t - 2);
      for (const [at, ax, ay] of this.sent) sim.fireCocked(at, ax, ay);
    }
    if (shown === undefined) return;
    this.shown[sim.seat] = shown;
    // The corks the room fired after the last moment this screen pictured are in the air in the
    // snapshot: this screen never saw them leave, so it is told now.
    for (const c of sim.corks) if (c.born > shown) this.arrived.push({ k: "fire", seat: sim.seat, id: c.id, t: c.born, ax: c.ax, ay: c.ay });
  }

  time() {
    return (this.party.now() - this.startAt) / 1000 - COUNT_IN;
  }

  seatTime(seat) {
    return this.time() - (seat === this.mySeat ? 0 : REMOTE_DELAY);
  }

  canFire() {
    const sim = this.sims[this.mySeat];
    if (!sim) return false;
    const t = this.time();
    // Cocked by this page's own stall, and by the stamps the room will judge (a hair over, so
    // that rounding a stamp to the millisecond cannot make the room refuse a cork that flew here).
    const cocked = t - sim.lastFire >= COCK_SECONDS - 0.02 && r3(t) - this.lastStamp >= COCK_SECONDS - 0.02 + 1e-6;
    return t >= 0 && t < ROUND_SECONDS && !this.ended && !sim.over && sim.corksLeft > 0 && cocked;
  }

  /** Aim and fire, with the room's clock. The room decides what it hit; the picture shows it at once. */
  fire(ax, ay) {
    if (!this.canFire()) return false;
    // The picture fires what the room is sent, to the millisecond and the millimetre.
    const shot = [r3(this.time()), r3(ax), r3(ay)];
    this.sims[this.mySeat].fireCocked(...shot);
    this.lastStamp = shot[0];
    this.sent.push(shot);
    this.party.sendInput({ f: shot });
    return true;
  }

  pick(seat) {
    this.party.sendInput({ pick: seat });
  }

  advance() {
    const out = this.arrived.splice(0);
    for (const e of this.queue.splice(0)) {
      if (e.k === "f") {
        const sim = this.sims[e.seat];
        // Our own corks flew when we fired them. And a stall rebuilt from a snapshot has every
        // cork the room had queued by then (fired, or waiting): one relayed before the snapshot
        // and read after it must not fly twice.
        if (!sim || e.seat === this.mySeat || e.n < sim.queued) continue;
        if (e.n !== undefined) sim.queued = e.n;
        // The room's own `want` and `slack`: this stall comes to the room's verdict on the cork,
        // however late it got here and however many came with it.
        sim.fire(e.at, e.ax, e.ay, e.want, e.slack);
        continue;
      }
      if (e.k === "atk") {
        if (!this.attacks.some((a) => a.id === e.id)) this.attacks.push({ ...e });
      } else if (e.k === "block") {
        const atk = this.attacks.find((a) => a.id === e.id);
        if (atk) {
          if (atk.done) continue; // this screen had already seen its own block
          atk.done = true;
        }
      } else if (e.k === "time") this.ended = true;
      out.push(e);
    }
    for (const s of this.seats) {
      const sim = this.sims[s.seat];
      const t = this.seatTime(s.seat);
      landAttacks(this.attacks, sim, t);
      sim.step(t);
      for (const e of sim.events) {
        // A rebuilt stall of our own plays again the moments since the room's snapshot: the corks
        // it fires again are corks this screen has pictured.
        if (e.k === "fire" && e.t <= (this.shown[s.seat] ?? -Infinity)) continue;
        // A dead-centre hit inside a warning is a block: show it now, the room will confirm it.
        if (e.k === "hit" && e.perfect && s.seat === this.mySeat) {
          const atk = this.attacks.find((a) => a.to === s.seat && !a.landed && !a.done && !a.returned && e.t < a.at && e.t >= a.sent);
          if (atk) {
            atk.done = true;
            out.push({ k: "block", id: atk.id, by: s.seat, t: e.t });
          }
        }
        out.push(e);
      }
      sim.events.length = 0;
    }
    const mine = this.sims[this.mySeat];
    if (mine) {
      this.history.push([mine.t, mine.score]);
      if (this.history.length > 240) this.history.shift();
    }
    return out;
  }

  /** The room's periodic word. A stall that has drifted from it for two seconds running is rebuilt from it. */
  check(snap) {
    if (snap.round !== this.round || snap.startAt !== this.startAt) return this.adopt(snap, true);
    if (snap.ended) this.ended = true;
    snap.seats.forEach((s, i) => {
      const sim = this.sims[s.seat];
      const theirs = snap.stalls[i];
      if (!sim) return;
      let mineScore = sim.score;
      if (s.seat === this.mySeat) {
        // Our own stall runs ahead of the room: compare with where we were at the room's time.
        const past = this.history.find((h) => h[0] >= theirs.t);
        if (past) mineScore = past[1];
      } else if (Math.abs(sim.t - theirs.t) > 0.3) return;
      const wrong = mineScore !== theirs.score;
      this.drift[s.seat] = wrong ? (this.drift[s.seat] ?? 0) + 1 : 0;
      if (this.drift[s.seat] >= 4) {
        this.load(sim, theirs, sim.t);
        this.drift[s.seat] = 0;
        this.rebuilt = true;
      }
    });
  }

  /** The room's final word on the round. */
  finish(result) {
    this.over = true;
    this.ended = true;
    this.finalResult = result;
    for (const r of result ?? []) {
      const sim = this.sims[r.seat];
      if (sim) {
        sim.score = r.score;
        sim.hits = r.hits;
        sim.shots = r.shots;
      }
    }
  }

  result() {
    return this.finalResult ?? standings(this.seats, (seat) => this.sims[seat]);
  }
}
