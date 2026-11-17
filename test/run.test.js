// The high score board plays a solo run again from what the page sends (game/shared/run.js): it
// must come to exactly the score the page showed, for any frame rate and any count-in, and turn
// away anything a page could not have sent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LocalSession } from "../game/session.js";
import { COUNT_IN, game } from "../game/shared/battle.js";
import { MAX_RUN_SHOTS, RUN_VERSION, scoreRun } from "../game/shared/run.js";
import { COCK_SECONDS, ROUND_SECONDS } from "../game/shared/sim.js";
import { scoreRun as exported } from "../party.js";

/** A small seeded random number source, so each test's frames are the same on every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
}

/**
 * Plays a solo run as the page does (main.js): frames of uneven length, each firing first when the
 * player wants to and then moving the round on. The game's bot stands in for the player's hands.
 */
function playSolo({ seed, countIn, frames = 7, skill = 1, takeOver = false }) {
  const random = rng(frames * 7919 + seed);
  const session = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn, botSkill: skill });
  // A click on the house's stall takes the gun and fires at once, before the round has moved at all.
  if (takeOver) expect(session.fire(0.2, 1.4)).toBe(true);
  let n = 0;
  while (!session.over && n++ < 20000) {
    for (const input of game.bot(session.state, 0, session.now)) session.fire(input.f[1], input.f[2]);
    // Sometimes a second, too soon: the lever refuses it, and nothing is recorded.
    if (random() < 0.05) session.fire(random() * 2 - 1, 1 + random());
    session.advance(Math.min(0.05, 0.004 + random() * 0.05));
  }
  expect(session.over).toBe(true);
  return { score: session.sims[0].score, run: JSON.parse(JSON.stringify({ seed, countIn: session.countIn, shots: session.shots, v: RUN_VERSION })) };
}

describe("a solo run played again", () => {
  it("comes to the score the page showed, whatever its frames and count-in", () => {
    for (const [seed, countIn, frames] of [[7, 0, 1], [11, 1.2, 2], [123456789, 1, 3], [4294967295, COUNT_IN, 4], [42, 0, 5]]) {
      const { score, run } = playSolo({ seed, countIn, frames });
      expect(score).toBeGreaterThan(0);
      expect(run.shots.length).toBeGreaterThan(10);
      expect(scoreRun(run)).toBe(score);
    }
  });

  it("comes to the score the page showed over many seeds, also when dead-centre hits gave corks back", () => {
    const random = rng(2026);
    let given = 0;
    for (let i = 0; i < 60; i++) {
      const seed = Math.floor(random() * 2 ** 32);
      const { score, run } = playSolo({ seed, countIn: [0, 1, 1.2, COUNT_IN][i % 4], frames: i });
      if (run.shots.length > 35) given++;
      expect(run.shots.length).toBeLessThanOrEqual(MAX_RUN_SHOTS);
      expect(scoreRun(run), `seed ${seed}`).toBe(score);
    }
    // Runs that fired more than a round's corks are common: the bound is the lever, not the tray.
    expect(given).toBeGreaterThan(0);
  });

  it("comes to the score of a run begun by taking the gun from the house", () => {
    const { score, run } = playSolo({ seed: 31337, countIn: 0, takeOver: true });
    expect(run.shots[0][0]).toBe(0);
    expect(scoreRun(run)).toBe(score);
  });

  it("is what the package gives a host", () => {
    expect(exported).toBe(scoreRun);
  });

  it("counts the corks as fired, not what the page claims: another seed or other aims score otherwise", () => {
    const { score, run } = playSolo({ seed: 99, countIn: 0 });
    expect(scoreRun({ ...run, seed: 100 })).not.toBe(score);
    expect(scoreRun({ ...run, shots: run.shots.map(([now]) => [now, 0, 0.3]) })).toBeLessThan(score);
    expect(scoreRun({ ...run, score: 999999 })).toBe(score);
  });

  it("gives nothing for a run with no corks, and no more corks than a round has", () => {
    expect(scoreRun({ seed: 1, countIn: 0, shots: [], v: RUN_VERSION })).toBe(0);
    // Every cork fired the moment it may be, at the same spot: the lever and the tray hold it to 35.
    const burst = Array.from({ length: MAX_RUN_SHOTS }, (_, i) => [1000 + i * 1, 0, 1.5]);
    expect(scoreRun({ seed: 1, countIn: 0, shots: burst, v: RUN_VERSION })).toBeLessThan(5000);
  });

  it("allows one cork per cock of the lever for the whole round, and no more: 90 s / 0.48 s + 1", () => {
    expect(MAX_RUN_SHOTS).toBe(189);
    expect(MAX_RUN_SHOTS).toBe(Math.ceil(ROUND_SECONDS / (COCK_SECONDS - 0.02)) + 1);
  });

  it("turns away what a page could not have sent, and a run of another version of the rules", () => {
    const ok = { seed: 5, countIn: 0, shots: [[1000, 0, 1.5]], v: RUN_VERSION };
    expect(scoreRun(ok)).not.toBeNull();
    for (const bad of [
      null,
      {},
      { ...ok, v: undefined },
      { ...ok, v: RUN_VERSION - 1 },
      { ...ok, v: RUN_VERSION + 1 },
      { ...ok, v: String(RUN_VERSION) },
      { ...ok, seed: -1 },
      { ...ok, seed: 1.5 },
      { ...ok, seed: 2 ** 32 },
      { ...ok, seed: "5" },
      { ...ok, countIn: -0.1 },
      { ...ok, countIn: COUNT_IN + 0.1 },
      { ...ok, countIn: Number.NaN },
      { ...ok, shots: "x" },
      { ...ok, shots: [[1000, 0]] },
      { ...ok, shots: [[1000, 0, "1"]] },
      { ...ok, shots: [[1000, 0, Infinity]] },
      { ...ok, shots: [[2000, 0, 1], [1000, 0, 1]] },
      { ...ok, shots: [[-1, 0, 1]] },
      { ...ok, shots: [[(COUNT_IN + 91) * 1000, 0, 1]] },
      { ...ok, shots: Array.from({ length: MAX_RUN_SHOTS + 1 }, (_, i) => [1000 + i * 400, 0, 1.5]) },
    ])
      expect(scoreRun(bad)).toBeNull();
  });
});

describe("what the page records", () => {
  it("holds only corks the stall took: a click while a cork waits for its step is refused, not recorded", () => {
    // The worst honest case: three clicks every frame, at 30 and at 120 frames a second.
    for (const hz of [30, 120]) {
      for (let i = 0; i < 20; i++) {
        const seed = i * 7919 + 1;
        const s = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn: 0 });
        let refused = 0;
        for (let n = 0; !s.over && n < 40000; n++) {
          const b = game.bot(s.state, 0, s.now);
          const aim = b.length ? b[0].f.slice(1) : [((n * 37) % 240) / 100 - 1.2, 0.8 + ((n * 13) % 180) / 100];
          for (let k = 0; k < 3; k++) if (!s.fire(aim[0], aim[1])) refused++;
          expect(s.sims[0].pending.length).toBeLessThanOrEqual(1);
          s.advance(1 / hz);
        }
        expect(refused).toBeGreaterThan(0);
        expect(s.shots.length).toBeLessThanOrEqual(MAX_RUN_SHOTS);
        // Every cork recorded was fired by the stall (none waits, none was turned away at the door).
        expect(s.sims[0].shots).toBe(s.shots.length);
        expect(scoreRun({ seed, countIn: 0, shots: JSON.parse(JSON.stringify(s.shots)), v: RUN_VERSION })).toBe(s.sims[0].score);
      }
    }
  });
});

describe("the golden runs (test/golden-runs.json)", () => {
  const golden = JSON.parse(readFileSync(new URL("./golden-runs.json", import.meta.url), "utf8"));

  it("has one recorded for this version of the rules (record it with: node tools/golden-run.mjs)", () => {
    expect(golden[RUN_VERSION], `no golden run for RUN_VERSION ${RUN_VERSION}: run node tools/golden-run.mjs`).toBeDefined();
    expect(golden[RUN_VERSION].run.v).toBe(RUN_VERSION);
  });

  it("plays this version's run to exactly its recorded score: if this fails, the rules score a recorded run differently, so bump RUN_VERSION (game/shared/run.js) and record a new golden run", () => {
    const { run, score } = golden[RUN_VERSION];
    expect(run.shots.length).toBeGreaterThan(35);
    expect(score).toBeGreaterThan(1000);
    expect(scoreRun(run)).toBe(score);
  });

  it("turns away every older version's run", () => {
    for (const [v, { run }] of Object.entries(golden)) if (Number(v) !== RUN_VERSION) expect(scoreRun(run)).toBeNull();
  });
});
