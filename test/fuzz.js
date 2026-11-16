// One random round, from a seed: a room of one to four seats (some of them bots) and its pages,
// over connections that go wrong in every way the tests know, and the check of every page's
// picture of every stall against the room (test/room.js, problems). The same seed is the same
// round, so a failing seed can be played again: `node tools/fuzz-corks.mjs --seed=<n>`.
import { makeRoom, problems } from "./room.js";

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

/** A whole number from a hash of `now` and a salt: per-millisecond jitter that does not use up the rng. */
const noise = (now, salt) => ((Math.imul(now ^ salt, 2654435761) >>> 0) % 1000) / 1000;

/** Spells of something, as [from, to) in room ms: `n` of them, each up to `long` ms, anywhere in the round. */
function spells(R, n, long, { from = 0, to = 96000 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // Now and then at the count-in or the closing bell, where rebuilds and refusals are touchy.
    const at = R() < 0.15 ? 2500 + R() * 1500 : R() < 0.15 ? 91500 + R() * 3000 : from + R() * (to - from);
    out.push([Math.round(at), Math.round(at + 100 + R() * long)]);
  }
  return out;
}
const inside = (list, now) => list.some(([a, b]) => now >= a && now < b);

/** What a player does at the trigger. */
function player(R) {
  const style = ["hammer", "ragged", "targets", "bell"][Math.floor(R() * 4)];
  let k = 0;
  return (page, room) => {
    const s = page.session;
    if (style === "bell") {
      // Fires the moment its own clock says the round has begun (before the room's bell, when it
      // runs ahead), then as fast as it can.
      if (!page.first && s.time() >= 0) page.first = s.fire(-1, 2.6) || s.time() > 0.2;
      else if (page.first) s.fire(0, 2.6);
    } else if (style === "hammer") {
      if (room.t() > 0.3) s.fire(0, 2.6);
    } else if (style === "ragged") {
      if (room.t() > 0.3 && noise(room.now, page.salt) < 0.08) s.fire(0.5, 2.6);
    } else if (room.t() > 0.3 && noise(room.now, page.salt + 1) < 0.2) {
      // At the targets: corks hit things, so a cork pictured wrongly can change the score.
      k += 1;
      s.fire(((k * 0.37) % 2.4) - 1.2, 0.9 + ((k * 0.53) % 1.2));
    }
  };
}

/** A link one way: a base delay with jitter, spikes, and (uplink) stalls that hold everything back. */
function link(R, { stalls = [] } = {}) {
  const base = 5 + Math.floor(R() * 140);
  const jitter = Math.floor(R() * 60);
  const spikes = spells(R, Math.floor(R() * 4), 500);
  const salt = Math.floor(R() * 1e6);
  return (now) => {
    for (const [a, b] of stalls) if (now >= a && now < b) return b - now + base;
    return base + Math.floor(noise(now, salt) * jitter) + (inside(spikes, now) ? 200 + Math.floor(noise(now, salt + 7) * 400) : 0);
  };
}

/** Plays the round of `seed` and returns what is wrong with every page's picture (nothing, when all is well). */
export function playRound(seed) {
  const R = rng(seed);
  const n = 1 + Math.floor(R() * 4);
  const seats = Array.from({ length: n }, (_, i) => ({ seat: i, name: `S${i}`, kind: i > 0 && R() < 0.35 ? "bot" : "human" }));
  const room = makeRoom({ seed, seats, standIn: R() < 0.5, handshake: R() < 0.5 ? "connect" : "hello" });
  const watchers = R() < 0.5 ? 1 : 0;
  const pages = [];
  for (const s of [...seats.filter((x) => x.kind === "human"), ...Array.from({ length: watchers }, () => ({ seat: -1 }))]) {
    // The page's clock: right, a little off, or up to a second ahead or behind (sometimes by a
    // fraction of a millisecond).
    const offset = R() < 0.2 ? 0 : (R() * 2 - 1) * (R() < 0.4 ? 1000 : 150) + (R() < 0.3 ? 0.5 : 0);
    const stalls = R() < 0.4 ? spells(R, 1 + Math.floor(R() * 2), 8000, { from: 3000, to: 85000 }) : [];
    const dropped = R() < 0.35 ? spells(R, 1 + Math.floor(R() * 2), 3000) : [];
    const deaf = R() < 0.35 ? spells(R, 1 + Math.floor(R() * 2), 1500) : [];
    const frozen = R() < 0.3 ? spells(R, 1 + Math.floor(R() * 2), 2000) : [];
    // Moments at which the page's picture of a stall is made wrong (a rebuild follows), and at
    // which it is handed the whole room (as on a reconnect).
    const drifts = Array.from({ length: Math.floor(R() * 5) }, () => [Math.round(R() * 95000), Math.floor(R() * n)]);
    const handed = spells(R, Math.floor(R() * 3), 1).map(([a]) => a);
    const play = s.seat >= 0 ? player(R) : () => {};
    const page = room.join({
      seat: s.seat,
      offset,
      up: link(R, { stalls }),
      down: link(R),
      dropped: (now) => inside(dropped, now),
      deaf: (now) => inside(deaf, now),
      frozen: (now) => inside(frozen, now),
      play: (p, r) => {
        play(p, r);
        for (const [at, seat] of drifts) if (r.now >= at && r.now < at + 16 && p.session.sims[seat]) p.session.sims[seat].score += 1;
        for (const at of handed) if (r.now >= at && r.now < at + 16) r.handBack(p);
      },
    });
    page.salt = Math.floor(R() * 1e6);
    pages.push(page);
  }
  // The round, then long enough for the slowest picture to catch up with the room's last word.
  for (let until = 1000; !room.state.over && until < 110000; until += 1000) room.run(until);
  room.run(room.now + 9000);
  const out = [];
  for (const page of pages) for (const p of problems(page, room)) out.push(`page ${pages.indexOf(page)} (seat ${page.seat}): ${p}`);
  return { seed, seats: n, pages: pages.length, shots: seats.map((s) => room.state.stalls[s.seat].shots), problems: out, room };
}
