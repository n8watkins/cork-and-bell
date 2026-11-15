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
    /** This page's own corks the room has not relayed back yet, as they were sent: {q, f: [stamp, ax, ay]}. */
    this.sent = [];
    /** The number of this page's last cork this round (each input carries its number, `q`). */
    this.q = 0;
    /** The number of the last cork sent before the connection last opened. */
    this.opened = 0;
    /** The stamp of this page's last cork. The room judges whether a cork was cocked by these. */
    this.lastStamp = -10;
    /** seat -> the number after the last cork this screen pictured leaving that stall. */
    this.pictured = {};
    /** This page's own corks that flew here and that the room never heard, since its stall was last rebuilt. */
    this.lost = 0;
    /** "fire" events for the corks a rebuild brought already in the air, which this screen never saw leave. */
    this.arrived = [];
    this.adopt(snapshot, true);
    this.off = [
      party.on("events", (events) => this.hear(events)),
      party.on("snapshot", (s, now, full) => (full ? this.adopt(s, true, true) : this.check(s))),
      // The room sends the whole of itself (a full snapshot) as soon as a connection opens, before
      // it reads anything sent on it. So of the corks sent before, the ones it had not heard by
      // then were lost with the old connection.
      party.on("status", (status) => {
        if (status === "open") this.opened = this.q;
      }),
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
      // and never relayed was not taken at all. A room that numbers nothing (older code) is
      // matched by the aim, which cannot tell two corks at one aim apart.
      if (Number.isInteger(e.q)) {
        this.lost += this.sent.filter((s) => s.q < e.q).length;
        this.sent = this.sent.filter((s) => s.q > e.q);
      } else {
        const i = this.sent.findIndex((s) => s.f[1] === e.ax && s.f[2] === e.ay);
        if (i >= 0) this.lost += this.sent.splice(0, i + 1).length - 1;
      }
    }
    this.queue.push(...events);
  }

  /** `fresh`: the snapshot a connection opens with. */
  adopt(snap, rebuild, fresh = false) {
    const sameRound = snap.startAt === this.startAt && snap.round === this.round;
    this.startAt = snap.startAt;
    this.seed = snap.seed;
    this.round = snap.round;
    this.seats = snap.seats;
    if (rebuild) {
      const before = sameRound ? this.sims : {};
      if (!sameRound) {
        this.sent = [];
        this.q = 0;
        this.opened = 0;
        this.lastStamp = -10;
        this.pictured = {};
        this.lost = 0;
        this.arrived = [];
      }
      this.sims = {};
      snap.seats.forEach((s, i) => {
        const sim = new StallSim(snap.seed, s.seat);
        if (snap.t > -COUNT_IN + 0.2) this.load(sim, snap.stalls[i], !!before[s.seat], fresh);
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
   * waiting for their time. `known`: this screen had pictured the stall before; `fresh`: the
   * snapshot is the one a connection opens with.
   *
   * The rebuilt stall plays again the moments from the snapshot's time to this screen's, and fires
   * again the corks of them: the ones this screen has pictured are not shown again (advance), told
   * apart by their number (`pictured`), not by their time, since a cork the room's word of which
   * came late (or was read and not yet acted on) is pictured late, or by the rebuilt stall.
   */
  load(sim, theirs, known, fresh) {
    loadStall(sim, theirs);
    if (sim.seat === this.mySeat) {
      // Our own corks the room had not heard when it took the snapshot are not in it, and the
      // room will count them: they fly here as they did. The room says the number of the last
      // cork it heard (`heard`); the corks up to it are in the snapshot already, fired or waiting,
      // or were refused. A room that says nothing (older code) leaves it to the time.
      if (Number.isInteger(theirs.heard)) {
        this.sent = this.sent.filter((s) => s.q > theirs.heard);
        // A page that has just come back to the round (a reload) numbers on from the room's count.
        this.q = Math.max(this.q, theirs.heard);
      }
      // The corks sent on a connection that has closed and not heard by now never will be. (So is
      // one the room has still not heard two seconds on, where the page is not told of connections.)
      const t = this.time();
      const kept = this.sent.filter((s) => (!fresh || s.q > this.opened) && s.f[0] > t - 2);
      this.lost += this.sent.length - kept.length;
      this.sent = kept;
      for (const s of this.sent) sim.fireCocked(...s.f);
      // The corks that flew here and never reached the room are not in the room's count: the
      // room's next corks have their numbers, and are new to this screen.
      if (known) this.pictured[sim.seat] = Math.max(0, (this.pictured[sim.seat] ?? 0) - this.lost);
      this.lost = 0;
    }
    if (!known) {
      // A screen that has just come to the round: what flew before it came is not news.
      this.pictured[sim.seat] = sim.shots;
      return;
    }
    // The snapshot's corks in the air that this screen never saw leave (the room's word of them
    // was still on its way, or still unread): it is told of them now.
    for (const c of sim.corks) {
      if (c.id < (this.pictured[sim.seat] ?? 0)) continue;
      this.pictured[sim.seat] = c.id + 1;
      this.arrived.push({ k: "fire", seat: sim.seat, id: c.id, t: c.born, ax: c.ax, ay: c.ay });
    }
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

  /**
   * Aim and fire, with the room's clock. The room decides what it hit; the picture shows it at once.
   * A cork the connection does not take (no socket open: `sendInput` returns false) never leaves:
   * nothing flies, the lever stays cocked, and the page answers as it does to a trigger pulled
   * too soon (main.js plays the empty click), under the "Connection lost" notice.
   */
  fire(ax, ay) {
    if (!this.canFire()) return false;
    // The picture fires what the room is sent, to the millisecond and the millimetre.
    const shot = [r3(this.time()), r3(ax), r3(ay)];
    const q = this.q + 1;
    if (this.party.sendInput({ f: shot, q }) === false) return false;
    this.q = q;
    this.sims[this.mySeat].fireCocked(...shot);
    this.lastStamp = shot[0];
    this.sent.push({ q, f: shot });
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
        // A rebuilt stall plays again the moments since the room's snapshot (see load): a cork it
        // fires again that this screen has pictured is not shown twice.
        if (e.k === "fire") {
          if (e.id < (this.pictured[s.seat] ?? 0)) continue;
          this.pictured[s.seat] = e.id + 1;
        }
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
        this.load(sim, theirs, true, false);
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
