// Does every page picture every cork the room counted? A two-player room (two ?auto=1 pages), one
// full round, optionally with the guest's main thread frozen now and then (a busy phone, a tab
// that was in the background). Each page counts the corks its own picture of each stall fired
// (the stall's "fire" events, by cork number), and the end is compared with the room's last word
// (the result's shots).
//
// Run the local server first (npm run dev), then:
//   node tools/watch-corks.mjs [--freeze=1200] [--every=4000] [--lag=40] [--win=0] [--base=...]
//     --freeze=<ms>  how long the guest's main thread is frozen each time (0: never)
//     --every=<ms>   how often
// Exits 1 when a page pictured fewer or more corks than the room counted.
//
// The measure, and why not a simpler one: `corksLeft` is no count of corks fired (a dead-centre
// hit earns the cork back), and a stall's `shots` is overwritten by the room's numbers at the end
// of the round and at every rebuild. A cork was pictured when the page's stall fired it, so that
// is what is counted: the distinct cork numbers 0 .. shots-1 among the "fire" events.
import { BASE, openBrowser, opt } from "./browser.mjs";

const args = process.argv.slice(2);
const freeze = Number(opt(args, "freeze", 1200));
const every = Number(opt(args, "every", 4000));
const lag = opt(args, "lag", "40");
const base = opt(args, "base", BASE);
const b = await openBrowser({ win: opt(args, "win", "0") === "1", width: 900, height: 700 });

/** Runs in the page before its own code: follows each net session and counts what it pictures. */
function instrument() {
  const log = (window.__corks = { fired: {}, events: {}, relayed: {}, refused: {}, rebuilds: {}, sessions: 0 });
  let hooked = null;
  let proto = null;
  setInterval(() => {
    const session = window.__cab?.session;
    if (!session || session.kind !== "net" || session === hooked) return;
    hooked = session;
    log.sessions += 1;
    for (const k of ["fired", "events", "relayed", "refused", "rebuilds"]) log[k] = {};
    const sim = Object.values(session.sims)[0];
    if (sim && Object.getPrototypeOf(sim) !== proto) {
      // Corks the page's own stalls would not fire (not cocked, by the page's judgment).
      proto = Object.getPrototypeOf(sim);
      const doFire = proto.doFire;
      proto.doFire = function (shot) {
        const before = this.shots;
        doFire.call(this, shot);
        if (this.shots === before && this.t >= 0 && this.t < 90 && !this.over) log.refused[this.seat] = (log.refused[this.seat] ?? 0) + 1;
      };
    }
    const advance = session.advance.bind(session);
    session.advance = (dt) => {
      for (const e of session.queue) if (e.k === "f") log.relayed[e.seat] = (log.relayed[e.seat] ?? 0) + 1;
      const out = advance(dt);
      for (const e of out) {
        if (e.k !== "fire") continue;
        (log.fired[e.seat] ??= {})[e.id] = 1;
        log.events[e.seat] = (log.events[e.seat] ?? 0) + 1;
      }
      return out;
    };
    const check = session.check.bind(session);
    session.check = (snap) => {
      const sims = snap.seats.map((s) => [s.seat, session.sims[s.seat], session.sims[s.seat]?.corks]);
      check(snap);
      // A rebuilt stall has a new list of corks in flight (or is a new stall altogether).
      for (const [seat, sim, corks] of sims) if (session.sims[seat] !== sim || session.sims[seat]?.corks !== corks) log.rebuilds[seat] = (log.rebuilds[seat] ?? 0) + 1;
    };
  }, 20);
}

let failed = false;
try {
  const open = async (query) => {
    const context = await b.newContext({ viewport: { width: 420, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.log("PAGE ERROR", String(e)));
    await page.addInitScript(instrument);
    await page.goto(base + "?" + query);
    await page.waitForFunction(() => window.__cab, null, { timeout: 90000 });
    return page;
  };
  const host = await open("auto=1&quality=low&host=1&seats=2&name=Ann&lag=" + lag);
  await host.waitForFunction(() => window.__cab.party.session?.pin, null, { timeout: 30000 });
  const pin = await host.evaluate(() => window.__cab.party.session.pin);
  const guest = await open("auto=1&quality=low&join=" + pin + "&name=Bo&lag=" + lag);
  await guest.waitForFunction(() => window.__cab.mode === "battle" && window.__corks.sessions > 0, null, { timeout: 60000 });
  console.log("round started; guest frozen", freeze ? freeze + " ms every " + every + " ms" : "never", "| lag", lag, "ms each way");

  const t0 = Date.now();
  let freezes = 0;
  let lastFreeze = Date.now();
  for (;;) {
    const over = await guest.evaluate(() => window.__cab.session?.over).catch(() => false);
    const hostOver = await host.evaluate(() => window.__cab.session?.over).catch(() => false);
    if (over && hostOver) break;
    if (Date.now() - t0 > 150000) throw new Error("the round did not end");
    if (freeze && !over && Date.now() - lastFreeze >= every) {
      lastFreeze = Date.now();
      freezes += 1;
      await guest.evaluate((ms) => {
        const end = performance.now() + ms;
        while (performance.now() < end);
      }, freeze);
    } else await new Promise((r) => setTimeout(r, 200));
  }
  // The round is over. Nothing more is fired; read each page before a rematch replaces the session.
  await new Promise((r) => setTimeout(r, 300));
  const read = (page) =>
    page.evaluate(() => {
      const c = window.__cab;
      const log = window.__corks;
      return {
        mySeat: c.session.mySeat,
        rtt: Math.round(c.party.rtt ?? 0),
        seats: c.session.result().map((r) => {
          const ids = Object.keys(log.fired[r.seat] ?? {}).map(Number);
          return {
            seat: r.seat,
            name: r.name,
            counted: r.shots,
            pictured: ids.filter((id) => id < r.shots).length,
            beyond: ids.filter((id) => id >= r.shots).length,
            twice: (log.events[r.seat] ?? 0) - ids.length,
            relayed: log.relayed[r.seat] ?? 0,
            refused: log.refused[r.seat] ?? 0,
            rebuilds: log.rebuilds[r.seat] ?? 0,
          };
        }),
      };
    });
  console.log("freezes:", freezes);
  for (const [name, page] of [["host", host], ["guest", guest]]) {
    const r = await read(page);
    console.log(name + " page (seat " + r.mySeat + ", round trip " + r.rtt + " ms):");
    for (const s of r.seats.sort((a, c) => a.seat - c.seat)) {
      const ok = s.pictured === s.counted && s.beyond === 0 && s.twice === 0;
      if (!ok) failed = true;
      console.log(
        "  " + (s.seat === r.mySeat ? "own    " : "watched") + " stall " + s.seat + " (" + s.name + "): room counted " + s.counted + ", pictured " + s.pictured +
          (s.beyond ? ", " + s.beyond + " the room never counted" : "") + (s.twice ? ", " + s.twice + " pictured twice" : "") +
          " | relayed " + s.relayed + ", refused by the page " + s.refused + ", rebuilds " + s.rebuilds + (ok ? "" : "   <-- WRONG"),
      );
    }
  }
  console.log(failed ? "FAILED: a page did not picture exactly the corks the room counted" : "PASSED: every page pictured every cork the room counted");
} catch (err) {
  failed = true;
  console.error("FAILED:", err?.message ?? err);
} finally {
  await b.close();
}
process.exit(failed ? 1 : 0);
