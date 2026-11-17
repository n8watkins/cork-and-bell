// The high score board plays a solo run again from what the page sends (game/shared/run.js): it
// must come to exactly the score the page showed, for any frame rate and any count-in, and turn
// away anything a page could not have sent.
import { describe, expect, it } from "vitest";
import { LocalSession } from "../game/session.js";
import { COUNT_IN, game } from "../game/shared/battle.js";
import { MAX_RUN_SHOTS, scoreRun } from "../game/shared/run.js";
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
  return { score: session.sims[0].score, run: JSON.parse(JSON.stringify({ seed, countIn: session.countIn, shots: session.shots })) };
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
    expect(scoreRun({ seed: 1, countIn: 0, shots: [] })).toBe(0);
    // Every cork fired the moment it may be, at the same spot: the lever and the tray hold it to 35.
    const burst = Array.from({ length: MAX_RUN_SHOTS }, (_, i) => [1000 + i * 1, 0, 1.5]);
    expect(scoreRun({ seed: 1, countIn: 0, shots: burst })).toBeLessThan(5000);
  });

  it("turns away what a page could not have sent", () => {
    const ok = { seed: 5, countIn: 0, shots: [[1000, 0, 1.5]] };
    expect(scoreRun(ok)).not.toBeNull();
    for (const bad of [
      null,
      {},
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
      { ...ok, shots: Array.from({ length: MAX_RUN_SHOTS + 1 }, (_, i) => [1000 + i * 600, 0, 1.5]) },
    ])
      expect(scoreRun(bad)).toBeNull();
  });
});
