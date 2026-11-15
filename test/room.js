// A room and its pages for the tests, a millisecond at a time, and the check that every page's
// picture of every stall is the room's. Used by session.test.js and fuzz.test.js.
import { game, COUNT_IN } from "../game/shared/battle.js";
import { NetSession } from "../game/session.js";

export const wire = (v) => JSON.parse(JSON.stringify(v));
export const SEATS = [
  { seat: 0, name: "Ada", kind: "human" },
  { seat: 1, name: "Bo", kind: "human" },
];

/** What a room from before corks were numbered sends: no numbers, no word of refusals. */
function asOldRoom(name, data) {
  if (name === "events") {
    data[0] = data[0].filter((e) => e.k !== "no");
    for (const e of data[0]) delete e.q;
  }
  if (name === "snapshot") {
    for (const s of data[0].stalls) {
      delete s.heard;
      delete s.gaps;
      delete s.firedQ;
      for (const c of [...(s.pending ?? []), ...(s.flying ?? [])]) delete c.q;
    }
  }
  return data;
}

/**
 * A room and its pages. The room ticks and sends as the party kit's does (30 times a second, the
 * events and then every 15th tick a snapshot) and plays its bot seats; each page hears it
 * `down(now)` ms later, draws a frame every 16 ms unless `frozen(now)`, and its inputs take
 * `up(now)` ms to reach the room (in the order they were sent).
 *
 * A connection can fail three ways. While `dropped(now)` the page has no socket: it hears nothing
 * and `sendInput` returns false, and inputs still on their way are lost (with a bot standing in
 * meanwhile when `standIn`). While `deaf(now)` what the room sends the page is lost (a socket
 * dying from the room's side first). While `mute(now)` the page's inputs are taken and lost on
 * the way (a socket dying from the page's side first). After a drop or a deaf spell the page
 * connects again and is sent the whole room: at once (`handshake: "connect"`, the pinned party
 * kit, outside the tick) or when its first message, the hello, has reached the room
 * (`handshake: "hello"`, the newer kit).
 *
 * The room keeps its own stalls' events (`fires`), and each page what it pictured (`shown`), the
 * corks it took back, and the corks it could not have seen (`unseen`: see `problems`).
 */
export function makeRoom({ seed = 7, seats = SEATS, standIn = false, oldRoom = false, handshake = "connect" } = {}) {
  const state = game.create({ seed, seats, now: 0, round: 1 });
  state.keep = true;
  const room = { now: 0, state, pages: [], inputs: [], later: [], ticks: 0, standing: new Set(), fires: {}, refusedAtDoor: 0 };
  room.t = () => room.now / 1000 - COUNT_IN;
  room.join = ({ seat = -1, offset = 0, up = () => 20, down = () => 20, frozen = () => false, dropped = () => false, deaf = () => false, mute = () => false, oldPage = false, play = () => {} } = {}) => {
    const page = { seat, down, up, frozen, dropped, deaf, play, inbox: [], handlers: {}, fired: {}, shown: {}, aims: {}, takenBack: new Set(), unseen: {}, lastIn: 0, lastUp: 0, away: false, wasDeaf: false, lost: 0 };
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
    const sent = oldRoom ? asOldRoom(name, wire(data)) : wire(data);
    page.inbox.push({ at: page.lastIn, name, data: sent });
  };
  /** As the room sends it: to every page, in order. */
  room.send = (name, ...data) => {
    for (const page of room.pages) room.sendTo(page, name, ...data);
  };
  /** The whole room, as a page that has (re)connected is sent it. */
  room.handBack = (page) => {
    for (const fn of page.handlers.status ?? []) fn("open");
    if (handshake === "hello") room.later.push({ at: room.now + page.up(room.now), page });
    else room.sendTo(page, "snapshot", game.snapshot(room.state, room.now), room.now, true);
  };
  room.run = (until) => {
    while (room.now < until) {
      room.now += 1;
      room.inputs = room.inputs.filter((i) => {
        if (i.at > room.now) return true;
        // What was on its way when the connection dropped is lost with it.
        if (i.page.droppedSince > i.sentAt || room.standing.has(i.seat)) i.page.lost += 1;
        else game.input(room.state, i.seat, i.d, room.now);
        return false;
      });
      for (const page of room.pages) {
        const away = page.dropped(room.now);
        const deaf = page.deaf(room.now);
        if (away && !page.away) {
          page.droppedSince = room.now;
          if (page.seat >= 0 && standIn) room.standing.add(page.seat);
        }
        if (!away && page.away) room.standing.delete(page.seat);
        if ((!away && page.away) || (!deaf && page.wasDeaf && !away)) room.handBack(page);
        page.away = away;
        page.wasDeaf = deaf;
      }
      room.later = room.later.filter((l) => l.at > room.now || (room.sendTo(l.page, "snapshot", game.snapshot(room.state, room.now), room.now, true), false));
      if (room.now % 33 === 0) {
        room.ticks += 1;
        const bots = new Set(room.standing);
        for (const s of room.state.seats) if (s.kind === "bot") bots.add(s.seat);
        for (const seat of bots) for (const d of game.bot(room.state, seat, room.now)) game.input(room.state, seat, d, room.now);
        const events = game.tick(room.state, room.now);
        for (const e of room.state.simEvents.splice(0)) if (e.k === "fire") (room.fires[e.seat] ??= []).push({ id: e.id, q: e.q, aim: [e.ax, e.ay] });
        if (events.length) room.send("events", events);
        if (room.ticks % 15 === 0 || (room.state.over && !room.sentLast)) {
          room.sentLast = room.state.over;
          room.send("snapshot", game.snapshot(room.state, room.now), room.now, false);
        }
      }
      for (const page of room.pages) {
        if (page.frozen(room.now)) continue;
        while (page.inbox.length && page.inbox[0].at <= room.now) deliver(page, page.inbox.shift(), room);
        if (room.now % 16 !== 0) continue;
        page.play(page, room);
        for (const e of page.session.advance(0.016)) {
          if (e.k === "fire") {
            (page.fired[e.seat] ??= []).push(e.id);
            const k = key(page, e.seat, e);
            (page.shown[e.seat] ??= []).push(k);
            (page.aims[e.seat] ??= {})[k] ??= [e.ax, e.ay];
          }
          if (e.k === "takeback") page.takenBack.add(`q${e.q}`);
        }
      }
    }
  };
  return room;
}

/** How a cork is known: a page's own corks by their number `q`, any other by its number in the stall. */
function key(page, seat, c) {
  return seat === page.seat && c.q !== undefined ? `q${c.q}` : `id${c.id}`;
}

/**
 * A page reads one message from the room. When a snapshot rebuilds a stall, the corks of it that
 * had already come to rest in the room and that this screen never pictured cannot be pictured any
 * more (they were fired and fell while the page heard nothing of them): they are `unseen`.
 */
function deliver(page, msg, room) {
  const before = page.session.sims;
  const was = {};
  for (const [seat, sim] of Object.entries(before ?? {})) was[seat] = [sim, sim.corks];
  for (const fn of page.handlers[msg.name] ?? []) fn(...msg.data);
  if (msg.name !== "snapshot") return;
  const snap = msg.data[0];
  snap.seats.forEach((s, i) => {
    const sim = page.session.sims[s.seat];
    if (was[s.seat] && was[s.seat][0] === sim && was[s.seat][1] === sim.corks) return;
    const theirs = snap.stalls[i];
    const flying = new Set((theirs.flying ?? []).map((c) => c.id));
    const shown = new Set(page.shown[s.seat] ?? []);
    for (const c of room.fires[s.seat] ?? []) {
      // (Not a page's own numbered corks: it fired those itself, and must have pictured them.)
      if (c.id >= theirs.shots || flying.has(c.id) || (s.seat === page.seat && c.q !== undefined)) continue;
      const k = key(page, s.seat, c);
      if (!shown.has(k)) (page.unseen[s.seat] ??= new Set()).add(k);
    }
  });
}

/**
 * Everything wrong with a page's picture of the stalls, against the room (an empty list when it is
 * exact): for every stall it shows, the corks it pictured are the corks the room fired, none twice,
 * each with the room's aim, and the corks left are the room's. A page's own corks are matched by `q`; one it pictured and
 * took back (the room never fired it) is not counted. The only corks it may miss are those it could
 * not have seen (`unseen`).
 */
export function problems(page, room, seats = room.state.seats.map((s) => s.seat)) {
  const out = [];
  for (const seat of seats) {
    const name = `${seat === page.seat ? "own" : "watched"} stall ${seat}`;
    const shown = page.shown[seat] ?? [];
    const twice = shown.filter((k, i) => shown.indexOf(k) !== i);
    if (twice.length) out.push(`${name}: pictured twice ${twice.join(" ")}`);
    const fired = new Set((room.fires[seat] ?? []).map((c) => key(page, seat, c)));
    const kept = new Set(shown.filter((k) => !page.takenBack.has(k) || seat !== page.seat));
    if (seat === page.seat) for (const k of page.takenBack) if (fired.has(k)) out.push(`${name}: took back ${k}, which the room fired`);
    const unseen = page.unseen[seat] ?? new Set();
    const missing = [...fired].filter((k) => !kept.has(k) && !unseen.has(k));
    const extra = [...kept].filter((k) => !fired.has(k));
    if (missing.length) out.push(`${name}: never pictured ${missing.join(" ")}`);
    if (extra.length) out.push(`${name}: pictured but never fired ${extra.join(" ")}`);
    // And each is the room's cork of that number: it flew where the room's did.
    const aimOff = (room.fires[seat] ?? []).filter((c) => {
      const mine = page.aims[seat]?.[key(page, seat, c)];
      return mine && kept.has(key(page, seat, c)) && (mine[0] !== c.aim[0] || mine[1] !== c.aim[1]);
    });
    if (aimOff.length) out.push(`${name}: another aim than the room's for ${aimOff.map((c) => key(page, seat, c)).join(" ")}`);
    const mine = page.session.sims[seat];
    const theirs = room.state.stalls[seat];
    if (mine.corksLeft !== theirs.corksLeft) out.push(`${name}: ${mine.corksLeft} corks left, room ${theirs.corksLeft}`);
    if (mine.shots !== theirs.shots) out.push(`${name}: ${mine.shots} shots, room ${theirs.shots}`);
  }
  return out;
}

/** The cork numbers 0 .. n-1, each once: what a page that pictured every cork of n has seen. */
export const each = (n) => Array.from({ length: n }, (_, i) => i);
/**
 * A player who fires as fast as the page lets them, at one spot over the top of the stall. (Not
 * in the first half second, unless a test asks: a page whose clock is ahead of the room's can fire
 * before the room's bell, and the room refuses that cork.)
 */
export const hammer = (page, room) => room.t() > 0.5 && page.session.fire(0, 2.6);
/** A player a little slower and uneven, so the corks fall anywhere between the room's snapshots. */
export const ragged = (page, room) => (room.now * 7919) % 100 < 25 && hammer(page, room);
