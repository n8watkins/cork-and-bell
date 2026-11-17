// The game's own Worker (worker.js) with the party kit this package pins: its high score board
// chalks up only a run it played again, at the score the page showed, and never a bare score. With a
// kit that does not know `scoreRun` a bare {name, score} would go straight on the board, so this
// fails if package.json ever pins such a kit again.
import { describe, expect, it, vi } from "vitest";
import { LocalSession } from "../game/session.js";
import { game } from "../game/shared/battle.js";
import { RUN_VERSION } from "../game/shared/run.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { default: worker, ScoreBoard } = await import("../worker.js");
const { manifest } = await import("../party.js");

/** A Durable Object's storage, in memory. */
function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (keys) => [keys].flat().forEach((k) => map.delete(k)),
    list: async () => new Map(map),
  };
}

/** The Worker's environment as wrangler.jsonc gives it (production or local), with one in-memory board and a limiter that allows. */
function env(local = false) {
  const storage = memoryStorage();
  const board = new ScoreBoard({ storage }, {});
  return {
    storage,
    board,
    env: {
      PARTY_RATE_LIMIT: "on",
      PARTY_SIM_LATENCY: local ? "on" : "off",
      PARTY_TEST_GAMES: local ? "on" : "off",
      PARTY_LIMITER: { getByName: () => ({ hit: async () => true }) },
      PARTY_SCORES: { getByName: () => board },
      ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    },
  };
}

async function call(e, method, path, body) {
  const request = new Request(`https://cork.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(request, e);
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

const API = `/api/party/scores/${manifest.id}`;

/** A solo run as the page plays and records it, the game's bot at the gun. */
function played(seed) {
  const s = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn: 1.2 });
  for (let i = 0; !s.over && i < 20000; i++) {
    for (const input of game.bot(s.state, 0, s.now)) s.fire(input.f[1], input.f[2]);
    s.advance(1 / 60);
  }
  return { body: JSON.parse(JSON.stringify({ seed: s.seed, countIn: s.countIn, shots: s.shots, v: RUN_VERSION })), score: s.sims[0].score };
}

describe("the game's Worker and its high score board", () => {
  it("refuses a bare score, in production and locally", async () => {
    for (const local of [false, true]) {
      const { env: e, board } = env(local);
      expect(await call(e, "POST", API, { name: "ZZZ", score: 243300 })).toMatchObject({ status: 400, ok: false, error: "bad_request" });
      expect(await board.top()).toEqual([]);
    }
  });

  it("chalks up a run at the score the page showed, whatever score it claims, and only once", async () => {
    const { env: e } = env();
    const { body, score } = played(8675309);
    expect(score).toBeGreaterThan(0);
    expect(await call(e, "POST", API, { name: "ANN", ...body, score: 243300 })).toMatchObject({ status: 200, ok: true, score, place: 0 });
    expect(await call(e, "POST", API, { name: "BOB", ...body })).toMatchObject({ status: 409, error: "already_chalked" });
    const read = await call(e, "GET", API);
    expect(read.top).toEqual([{ name: "ANN", score, at: expect.any(Number) }]);
  });

  it("refuses a run of another version of the rules, and a made-up one", async () => {
    const { env: e } = env();
    const { body } = played(42);
    expect((await call(e, "POST", API, { name: "ANN", ...body, v: RUN_VERSION + 1 })).status).toBe(400);
    expect((await call(e, "POST", API, { name: "ANN", seed: 1, countIn: 0, shots: [[10, 0, 1], [0, 0, 1]], v: RUN_VERSION })).status).toBe(400);
    expect((await call(e, "POST", API, { name: "ANN", seed: 1, countIn: 0, shots: [], v: RUN_VERSION })).status).toBe(400);
  });

  it("has no ticket office, and its test board only where the test games are on", async () => {
    expect((await call(env().env, "POST", `${API}/runs`)).status).toBe(404);
    expect((await call(env().env, "POST", "/api/party/scores/e2e-test", { name: "ANN", score: 5 })).status).toBe(404);
    expect((await call(env(true).env, "POST", "/api/party/scores/e2e-test", { name: "ANN", score: 5 })).status).toBe(200);
  });

  it("tells a page whether the test games are on, for ?auto=1 battles", async () => {
    expect((await call(env().env, "GET", "/api/party/config")).testGames).toBe(false);
    expect((await call(env(true).env, "GET", "/api/party/config")).testGames).toBe(true);
  });
});
