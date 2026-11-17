// The high scores: everybody's, kept by the server, and this device's own best.
//
// Nobody signs in. A score that makes the board is chalked up under three letters, arcade style.
// If the board cannot be reached the game carries on with the house's scores and the device's
// best, and says so.

/** The house's own players, chalked up before anyone else has played. */
export const HOUSE = [
  { name: "MAB", score: 4120, house: true },
  { name: "TOM", score: 3375, house: true },
  { name: "FIT", score: 2640, house: true },
  { name: "DOL", score: 1890, house: true },
  { name: "WRN", score: 1200, house: true },
];

const API = "/api/party/scores/cork-and-bell";
const BEST_KEY = "cork-and-bell:own-best";
const SERVER_ROWS = 10;
/** A ticket is used only while well within the time the board keeps it (the kit's RUN_TTL_MS, twelve hours). */
const RUN_FRESH_MS = 6 * 60 * 60 * 1000;

export class Scores {
  constructor() {
    this.top = null; // the server's rows, or null while it has not answered (or cannot be reached)
    this.minePlace = -1; // where in `top` the row this device has just chalked up is, or -1
    this.onChange = () => {};
    /** The board's ticket for the next run ({run, seed, at}), or null. */
    this.ticket = null;
    this.fetching = null;
  }

  get reachable() {
    return this.top !== null;
  }

  /** Asks the server for the board. Never throws: no answer leaves `top` as it was. */
  async load() {
    try {
      const res = await fetch(API, { headers: { Accept: "application/json" } });
      const body = res.ok ? await res.json() : null;
      if (body?.ok && Array.isArray(body.top)) {
        this.top = body.top;
        this.minePlace = -1;
        this.onChange();
      }
    } catch {
      // Offline, or a server without a board: the house's scores stand.
    }
    return this.top;
  }

  /** Would this score be chalked up? (The server decides in the end; this only saves asking for letters in vain.) */
  makesBoard(score) {
    if (!this.reachable || score <= 0) return false;
    return this.top.length < SERVER_ROWS || score > this.top[this.top.length - 1].score;
  }

  /**
   * Asks the board for a ticket for the next run: {run, seed}, the seed that run is played on. The
   * board plays a run again only from a seed it handed out, and once. Never throws: no answer
   * leaves the page without a ticket, and its next run cannot go on the board.
   */
  async fetchRun() {
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        const res = await fetch(API + "/runs", { method: "POST", headers: { Accept: "application/json" } });
        const body = res.ok ? await res.json() : null;
        if (body?.ok && typeof body.run === "string" && Number.isInteger(body.seed)) this.ticket = { run: body.run, seed: body.seed, at: Date.now() };
      } catch {
        // Offline, or a server without a board.
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }

  /** The ticket for the run starting now, or null; the next one is asked for at once. */
  takeRun() {
    const ticket = this.ticket;
    this.ticket = null;
    this.fetchRun();
    return ticket && Date.now() - ticket.at < RUN_FRESH_MS ? ticket : null;
  }

  /**
   * Sends a run to be played again and chalked up: {run, countIn, shots} (shared/run.js). Answers
   * {ok: true, place} (place -1: it did not make the board after all), {ok: false, error: "bad_name"}
   * when the letters are refused, {ok: false, error: "rate_limited"}, or {ok: false, error: "offline"}.
   */
  async submit(name, { run, countIn, shots }) {
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, run, countIn, shots }) });
      const body = await res.json().catch(() => null);
      if (body?.ok) {
        this.top = body.top;
        this.minePlace = body.place;
        this.onChange();
        return { ok: true, place: body.place };
      }
      return { ok: false, error: body?.error === "bad_name" ? "bad_name" : body?.error === "rate_limited" ? "rate_limited" : "offline" };
    } catch {
      return { ok: false, error: "offline" };
    }
  }

  /** This device's own best: {score, name} or null. */
  ownBest() {
    try {
      const saved = JSON.parse(localStorage.getItem(BEST_KEY) ?? "null");
      return saved && Number.isFinite(saved.score) ? saved : null;
    } catch {
      return null;
    }
  }

  /** Remembers a score if it is this device's best. Returns true when it is. */
  keepOwnBest(score, name = this.ownBest()?.name ?? "") {
    const best = this.ownBest();
    if (best && best.score >= score) return false;
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify({ score, name }));
    } catch {
      // Not saved; it still shows for this visit.
    }
    return true;
  }

  /** The letters this device used last, to offer again. */
  lastInitials() {
    return this.ownBest()?.name ?? "";
  }

  rememberInitials(name) {
    const best = this.ownBest();
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify({ score: best?.score ?? 0, name }));
    } catch {
      // Nothing to do.
    }
  }

  /**
   * What the chalk board shows: five rows, best first, each {rank, name, score, mine}.
   * Everybody's scores with the house's among them; with no server, the house's and this
   * device's best. If this device's row is further down than fifth, it takes the last line.
   */
  rows() {
    let all;
    if (this.reachable) all = [...this.top.map((r, i) => ({ ...r, own: i === this.minePlace })), ...HOUSE];
    else {
      const best = this.ownBest();
      all = best?.score ? [{ name: best.name || "YOU", score: best.score, own: true }, ...HOUSE] : [...HOUSE];
    }
    all = all.map((r, i) => ({ ...r, order: i })).sort((a, b) => b.score - a.score || a.order - b.order);
    const mine = all.findIndex((r) => r.own);
    const ranked = all.map((r, i) => ({ rank: i + 1, name: r.name, score: r.score, mine: i === mine }));
    const shown = ranked.slice(0, 5);
    if (mine >= 5) shown[4] = ranked[mine];
    return shown;
  }
}
