// A room and its pages in one process, for the tests: the room's game code ticks and sends as the
// party kit does (events every tick, a snapshot every 15, a full snapshot to a page that comes
// back), and each page is this repo's NetSession (game/session.js) on a link that can be slow,
// uneven, frozen or dropped. Used to check that the page as it is today pictures a room's corks
// no worse than it did against main's room (test/room-corks.test.js).
import { COUNT_IN, game } from "../game/shared/battle.js";
import { NetSession } from "../game/session.js";

const wire = (v) => JSON.parse(JSON.stringify(v));

/** A small seeded random number generator (xorshift32): [0, 1). */
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function makeRoom({ seed, seats, tick = 33, snapEvery = 15 }) {
  const room = { now: 0, state: game.create({ seed, seats, now: 0, round: 1 }), pages: [], inputs: [], ticks: 0, errors: [], aims: {} };
  // The room's own stall events, to know every cork it fired and with what aim.
  room.state.keep = true;
  room.t = () => room.now / 1000 - COUNT_IN;
  room.join = ({ seat = -1, up = () => 20, down = () => 20, frozen = () => false, dropped = () => false, play = () => {} } = {}) => {
    const page = { seat, down, frozen, dropped, play, inbox: [], handlers: {}, aims: {}, lastIn: 0, lastUp: 0, wasDropped: false };
    page.party = {
      on: (name, fn) => ((page.handlers[name] ??= []).push(fn), () => {}),
      now: () => room.now,
      sendInput: (d) => {
        // Lost with the socket: the page cannot tell.
        if (page.dropped(room.now)) return true;
        page.lastUp = Math.max(page.lastUp, room.now + up(room.now));
        room.inputs.push({ at: page.lastUp, seat, d: wire(d) });
        return true;
      },
    };
    page.session = new NetSession(page.party, wire(game.snapshot(room.state, room.now)), seat);
    room.pages.push(page);
    return page;
  };
  const deliver = (page, name, data) => {
    page.lastIn = Math.max(page.lastIn, room.now + page.down(room.now));
    page.inbox.push({ at: page.lastIn, name, data: wire(data) });
  };
  room.send = (name, ...data) => {
    for (const page of room.pages) if (!page.dropped(room.now)) deliver(page, name, data);
  };
  room.run = (until) => {
    while (room.now < until) {
      room.now += 1;
      room.inputs = room.inputs.filter((i) => i.at > room.now || (game.input(room.state, i.seat, i.d, room.now), false));
      for (const page of room.pages) {
        const d = page.dropped(room.now);
        // A page that comes back is handed the whole room at once.
        if (page.wasDropped && !d) deliver(page, "snapshot", [game.snapshot(room.state, room.now), room.now, true]);
        page.wasDropped = d;
      }
      if (room.now % tick === 0 && !room.state.over) {
        room.ticks += 1;
        const events = game.tick(room.state, room.now);
        for (const e of room.state.simEvents.splice(0)) if (e.k === "fire") (room.aims[e.seat] ??= []).push(`${e.ax},${e.ay}`);
        if (events.length) room.send("events", events);
        if (room.ticks % snapEvery === 0 || room.state.over) room.send("snapshot", game.snapshot(room.state, room.now), room.now, false);
        if (room.state.over) room.send("end", game.result(room.state));
      }
      for (const page of room.pages) {
        if (page.frozen(room.now)) continue;
        while (page.inbox.length && page.inbox[0].at <= room.now) {
          const msg = page.inbox.shift();
          try {
            if (msg.name === "end") page.session.finish(...msg.data);
            else for (const fn of page.handlers[msg.name] ?? []) fn(...msg.data);
          } catch (e) {
            room.errors.push(String(e));
          }
        }
        if (room.now % 16 !== 0) continue;
        try {
          page.play(page, room);
          for (const e of page.session.advance(0.016)) if (e.k === "fire") (page.aims[e.seat] ??= []).push(`${e.ax},${e.ay}`);
        } catch (e) {
          room.errors.push(String(e));
        }
      }
    }
  };
  return room;
}

/** The links the old-page check plays over: a page's link, for the player and for a watcher. */
export const LINKS = {
  clean: () => ({ up: () => 40, down: () => 40 }),
  jitter: () => ({ up: (now) => 30 + ((now * 7919) % 97), down: (now) => 30 + ((now * 104729) % 131) }),
  // Frozen 1.2 s every 4 s (a busy phone, a tab in the background).
  frozen: () => ({ up: () => 40, down: () => 40, frozen: (now) => now % 4000 < 1200 && now > 4000 }),
  // Three drops of 0.3 to 2.8 s: what the page sends meanwhile is lost; it is handed the room back.
  dropped: (R) => {
    const spells = Array.from({ length: 3 }, () => {
      const a = 6000 + Math.floor(R() * 80000);
      return [a, a + 300 + Math.floor(R() * 2500)];
    });
    return { up: () => 40, down: () => 40, dropped: (now) => spells.some(([a, b]) => now >= a && now < b) };
  },
  // The uplink stalls 2 to 8 s (a mobile link): the page's corks arrive together afterwards.
  uplinkStall: (R) => {
    const from = 10000 + Math.floor(R() * 60000);
    const len = 2000 + Math.floor(R() * 6000);
    return { up: (now) => (now >= from && now < from + len ? from + len - now + 40 : 40), down: () => 40 };
  },
};

/**
 * The room's corks of a stall (by aim, as a multiset) against a page's pictured "fire" events:
 * `missing`, room corks the page never pictured, and `extra`, pictures of corks the room never
 * fired (or pictured twice). The aims in these rounds are random to the millisecond, so an aim
 * names a cork.
 */
export function compare(pageAims = [], roomAims = []) {
  const left = new Map();
  for (const a of roomAims) left.set(a, (left.get(a) ?? 0) + 1);
  let extra = 0;
  for (const a of pageAims) {
    const n = left.get(a) ?? 0;
    if (n > 0) left.set(a, n - 1);
    else extra++;
  }
  let missing = 0;
  for (const n of left.values()) missing += n;
  return { missing, extra };
}

/**
 * One whole round: seat 0 (on `link`) and seat 1 fire at random aims whenever their page lets
 * them, and a big screen (on `link` too) watches. What the player's own page and the watcher
 * pictured of stall 0, against the room.
 */
export function playRound(link, seed) {
  const R = rng(seed);
  const seats = [
    { seat: 0, name: "A", kind: "human" },
    { seat: 1, name: "B", kind: "human" },
  ];
  const room = makeRoom({ seed, seats });
  const lk = LINKS[link](R);
  const aim = rng(seed * 31 + 7);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const play = (page, r) => r.t() >= 0.2 && aim() < 0.3 && page.session.fire(r3((aim() - 0.5) * 2.4), r3(0.5 + aim() * 2));
  const me = room.join({ seat: 0, ...lk, play });
  room.join({ seat: 1, up: () => 50, down: () => 50, play });
  const watcher = room.join({ seat: -1, ...lk });
  room.run(98000);
  const stall = room.state.stalls[0];
  const of = (page) => ({ ...compare(page.aims[0], room.aims[0]), leftOff: Math.abs(page.session.sims[0].corksLeft - stall.corksLeft) });
  return { errors: room.errors, counted: stall.shots, own: of(me), watcher: of(watcher) };
}
