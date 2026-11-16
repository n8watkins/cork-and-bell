// A session is one round as the browser sees it: the stalls' simulations, the clock, and the
// way inputs leave. LocalSession runs the battle code in the page (solo stall, attract mode,
// the four-stall demo). NetSession follows a room: it sends inputs, mirrors the room's
// simulation for an instant picture, and takes the room's word for everything that matters.
import { COUNT_IN, createBattle, END_HOLD, fromRanges, game, landAttacks, loadStall, roundTime, standings, WARNING } from "./shared/battle.js";
import { COCK_SECONDS, DT, ROUND_SECONDS, StallSim } from "./shared/sim.js";

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
    // This page's own corks are known by their number, `q` (1, 2, 3 ... in a round), from end to
    // end (see the top of game/shared/battle.js). Every cork this page sent is open until the
    // room settles it: fired (the room counted it), or never (refused, or never read). The picture
    // shows each cork once by its number, and takes back from its counts one that never was.
    /** The number of this page's last cork this round. */
    this.q = 0;
    /** This page's own corks the room has not settled yet: q -> [stamp, ax, ay], as sent. */
    this.open = new Map();
    /** The numbers of this page's own corks this screen has pictured leaving its stall. */
    this.shownQ = new Set();
    /** Whether the room numbers corks (newer room code than some pages): its snapshots then say what became of each. */
    this.numbered = false;
    /** The stamp of this page's last cork. The room judges whether a cork was cocked by these. */
    this.lastStamp = -10;
    /**
     * seat -> the number after the last cork this screen pictured leaving that stall: how the
     * corks that carry no `q` are told apart (every stall but this page's own, and on its own,
     * corks a stand-in bot fired, or all of them in a room that numbers nothing).
     */
    this.pictured = {};
    /** "fire" events for the corks a rebuild brought already in the air, which this screen never saw leave. */
    this.arrived = [];
    /**
     * seat -> the room's last word on the stall, when the round is over: the room plays it no
     * further, and nor does this screen. Its picture, behind the room's, goes on to that moment
     * and the stall is then made the room's (advance), whatever it made of the corks on the way.
     */
    this.final = {};
    this.adopt(snapshot, true);
    this.off = [party.on("events", (events) => this.hear(events)), party.on("snapshot", (s, now, full) => (full ? this.adopt(s, true) : this.check(s)))];
  }

  dispose() {
    this.off.forEach((f) => f());
  }

  /** What the room decided, as it arrives. It is acted on at the next advance. */
  hear(events) {
    for (const e of events) {
      if (e.k !== "f" || e.seat !== this.mySeat || this.numbered || e.q !== undefined) continue;
      // A room that numbers nothing (older code) has our cork. It hears them in the order they
      // were sent, so one sent before this and never relayed was not taken at all. Matched by the
      // aim, which cannot tell two corks at one aim apart: only in such a room.
      const qs = [...this.open.keys()];
      const i = qs.findIndex((q) => this.open.get(q)[1] === e.ax && this.open.get(q)[2] === e.ay);
      for (let k = 0; k <= i; k++) this.open.delete(qs[k]);
    }
    this.queue.push(...events);
  }

  /**
   * What became of this page's open corks, by a snapshot of the room's own stall (a room that
   * numbers corks). One the room fired is settled; one waiting there is still the room's to judge;
   * one the room has read (up to `heard`, and not in `gaps`) and neither fired nor kept never was:
   * it is taken back from `sim`, which shows it no more. One not read yet is still on its way: a
   * stall just rebuilt from the snapshot (`rebuilt`) fires it as it did.
   */
  settle(sim, theirs, rebuilt, over = false) {
    const fired = new Set(fromRanges(theirs.firedQ));
    const waiting = new Set((theirs.pending ?? []).map((shot) => shot.q));
    const gaps = new Set(theirs.gaps ?? []);
    const heard = theirs.heard ?? 0;
    for (const [q, f] of this.open) {
      if (fired.has(q)) this.open.delete(q);
      // A room that is over reads and fires nothing more.
      else if (over) this.never(sim, q);
      else if (waiting.has(q)) continue;
      else if (q <= heard && !gaps.has(q)) this.never(sim, q);
      else if (rebuilt) sim.fireCocked(...f, q);
    }
  }

  /**
   * A stall of another player made the room's last word: the corks this screen pictured past the
   * room's count never were (a page whose clock runs ahead, or that missed the room's word that
   * the round was ending, goes past the room's end), and are taken back.
   */
  unpicture(sim) {
    if (sim.seat === this.mySeat) return;
    for (let id = sim.shots; id < (this.pictured[sim.seat] ?? 0); id++) this.arrived.push({ k: "takeback", seat: sim.seat, id, t: sim.t });
    if ((this.pictured[sim.seat] ?? 0) > sim.shots) this.pictured[sim.seat] = sim.shots;
  }

  /** A numbered cork of ours the room will not fire ({k: "no"}): it never was. */
  refused(q) {
    if (this.open.has(q)) this.never(this.sims[this.mySeat], q);
  }

  /**
   * One of our corks never was: it is taken back from our stall's counts, and one already in the
   * air there flies on as a ghost (StallSim.unfire). A "takeback" event says so, for one this
   * screen had pictured.
   */
  never(sim, q) {
    this.open.delete(q);
    sim?.unfire(q);
    if (this.shownQ.has(q)) this.arrived.push({ k: "takeback", seat: this.mySeat, q, t: sim?.t });
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
        this.q = 0;
        this.open.clear();
        this.shownQ.clear();
        this.lastStamp = -10;
        this.pictured = {};
        this.arrived = [];
        this.final = {};
        this.endBy = undefined;
      }
      this.sims = {};
      snap.seats.forEach((s, i) => {
        const sim = new StallSim(snap.seed, s.seat);
        if (snap.t > -COUNT_IN + 0.2) this.load(sim, snap.stalls[i], !!before[s.seat], !!snap.over);
        else sim.t = -COUNT_IN - 1;
        this.sims[s.seat] = sim;
        if (snap.over) {
          this.final[s.seat] = { stall: snap.stalls[i], done: true };
          this.unpicture(sim);
        }
      });
      this.attacks = snap.attacks.map((a) => ({ ...a }));
      this.ended = !!snap.ended;
      if (Number.isFinite(snap.endAt)) this.endBy = snap.endAt + END_HOLD;
      this.rebuilt = true;
    }
  }

  /**
   * Makes a stall the room's, from a snapshot: its numbers, the corks in the air and the corks
   * waiting for their time. `known`: this screen had pictured the stall before; `over`: the round is
   * over, and the room will fire nothing more.
   *
   * The rebuilt stall plays again the moments from the snapshot's time to this screen's, and fires
   * again the corks of them: the ones this screen has pictured are not shown again (advance). Our
   * own corks are told apart by their `q`; any other cork by its number in the stall (`pictured`),
   * not by its time, since a cork the room's word of which came late (or was read and not yet
   * acted on) is pictured late, or by the rebuilt stall.
   */
  load(sim, theirs, known, over = false) {
    loadStall(sim, theirs);
    if (sim.seat === this.mySeat) {
      this.numbered = Array.isArray(theirs.firedQ);
      if (this.numbered) {
        // A page that has just come back to the round (a reload) numbers on from the room's.
        this.q = Math.max(this.q, theirs.heard ?? 0);
        this.settle(sim, theirs, true, over);
      } else {
        // A room that numbers nothing (older code): our corks it has not relayed back are not in
        // its snapshot, and it will count them. They fly here again, for two seconds after they
        // were sent; one it has not relayed by then was lost on the way.
        const t = this.time();
        for (const [q, f] of this.open) {
          if (f[0] > t - 2) sim.fireCocked(...f, q);
          else this.open.delete(q);
        }
      }
    }
    if (!known) {
      // A screen that has just come to the round: what flew before it came is not news.
      this.pictured[sim.seat] = sim.shots;
      return;
    }
    // The snapshot's corks in the air that this screen never saw leave (the room's word of them
    // was still on its way, or still unread): it is told of them now.
    for (const c of sim.corks) {
      if (sim.seat === this.mySeat && c.q !== undefined) {
        if (this.shownQ.has(c.q)) continue;
        this.shownQ.add(c.q);
      } else {
        if (c.id < (this.pictured[sim.seat] ?? 0)) continue;
        this.pictured[sim.seat] = c.id + 1;
      }
      this.arrived.push({ k: "fire", seat: sim.seat, id: c.id, t: c.born, ax: c.ax, ay: c.ay, ...(c.q !== undefined && { q: c.q }) });
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
    this.open.set(q, shot);
    this.sims[this.mySeat].fireCocked(...shot, q);
    this.lastStamp = shot[0];
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
        sim.fire(e.at, e.ax, e.ay, e.want, e.slack, e.q, true);
        continue;
      }
      if (e.k === "no") {
        if (e.seat === this.mySeat) this.refused(e.q);
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
      } else if (e.k === "time") {
        this.ended = true;
        // The room plays END_HOLD more and is over: no stall here goes past that until its last word.
        this.endBy = e.t + END_HOLD;
      }
      out.push(e);
    }
    for (const s of this.seats) {
      let sim = this.sims[s.seat];
      const end = this.final[s.seat];
      // When the round is over the stall goes no further than the room's did (see this.final), and
      // once its end is on (endBy), no further than the room can have gone.
      const t = Math.min(this.seatTime(s.seat), end ? end.stall.t : (this.endBy ?? Infinity));
      landAttacks(this.attacks, sim, t);
      sim.step(t);
      if (end && !end.done && sim.t + DT > end.stall.t) {
        // Its events up to here are this screen's; then the stall is the room's last word.
        end.done = true;
        const before = sim.events.splice(0);
        this.load(sim, end.stall, true, true);
        sim.events.unshift(...before);
        this.unpicture(sim);
      }
      for (const e of sim.events) {
        // A rebuilt stall plays again the moments since the room's snapshot (see load): a cork it
        // fires again that this screen has pictured is not shown twice. Our own by its `q`; any
        // other by its number in the stall. (In a room that numbers nothing, the rebuilt stall's
        // corks carry no `q`, so ours count towards the number too.)
        if (e.k === "fire") {
          if (s.seat === this.mySeat && e.q !== undefined) {
            if (this.shownQ.has(e.q)) continue;
            this.shownQ.add(e.q);
            if (!this.numbered) this.pictured[s.seat] = Math.max(this.pictured[s.seat] ?? 0, e.id + 1);
          } else {
            if (e.id < (this.pictured[s.seat] ?? 0)) continue;
            this.pictured[s.seat] = e.id + 1;
          }
        }
        // A screen's own stall says what it would not fire; what counts is what the room says.
        if (e.k === "no") continue;
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
    if (Number.isFinite(snap.endAt)) this.endBy ??= snap.endAt + END_HOLD;
    snap.seats.forEach((s, i) => {
      const sim = this.sims[s.seat];
      const theirs = snap.stalls[i];
      if (!sim) return;
      if (s.seat === this.mySeat && Array.isArray(theirs.firedQ)) {
        this.numbered = true;
        this.settle(sim, theirs, false, !!snap.over);
      }
      if (snap.over) {
        this.final[s.seat] ??= { stall: theirs, done: false };
        return;
      }
      let mineScore = sim.score;
      if (s.seat === this.mySeat) {
        // Our own stall runs ahead of the room: compare with where we were at the room's time.
        const past = this.history.find((h) => h[0] >= theirs.t);
        if (past) mineScore = past[1];
      } else if (Math.abs(sim.t - theirs.t) > 0.3) return;
      // Another player's stall is wrong too when it has given back other corks than the room's
      // (dead-centre hits): it would refuse a cork as the last, or fire one more, where the room did not.
      const given = (x) => x.corksLeft + x.shots;
      const wrong = mineScore !== theirs.score || (s.seat !== this.mySeat && given(sim) !== theirs.corks + theirs.shots);
      this.drift[s.seat] = wrong ? (this.drift[s.seat] ?? 0) + 1 : 0;
      if (this.drift[s.seat] >= 4) {
        this.load(sim, theirs, true);
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
    // The round is over: a cork of ours the room has still not read never reached it.
    if (this.numbered) for (const q of this.open.keys()) this.refused(q);
    for (const r of result ?? []) {
      const sim = this.sims[r.seat];
      // A stall still on its way to the room's last word is made the room's when it gets there
      // (advance): its numbers now would number its last corks wrong.
      if (sim && !(this.final[r.seat] && !this.final[r.seat].done)) {
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
