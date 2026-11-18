// Solo runs played as a page plays them, for tools/engines.mjs: the same module runs in Node and in
// each browser engine, so a run played in one can be scored in another.
//
// Each run is the page's own LocalSession on frames like a real device's (60, 120 and 30 a second,
// janky frames up to the page's 50 ms cap, tiny frames), with hands of four kinds: the game's bot,
// random aims anywhere (lamps, prizes, walls, the back board, the wheels), a mix, and a click every
// frame (spam fire). Every run is recorded as the board receives it ({seed, countIn, shots, v}).
import { LocalSession } from "../game/session.js";
import { game } from "../game/shared/battle.js";
import { RUN_VERSION, scoreRun } from "../game/shared/run.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
}

/** The run number i: always the same seed, count-in, frames and hands. Returns {run, score}: what the page sends, and the score it showed. */
export function playRun(i) {
  const r = rng(i * 104729 + 7);
  const seed = Math.floor(r() * 2 ** 32);
  const countIn = [0, 1.2, 1, 3, r() * 3][i % 5];
  const s = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn });
  const hands = Math.floor(i / 5) % 4; // 0 bot, 1 random everywhere, 2 mixed, 3 a click every frame
  const frames = i % 5; // 0: 60 Hz, 1: 120 Hz, 2: 30 Hz, 3: jank, 4: mostly short with spikes
  const frame = () => {
    if (frames === 0) return 1 / 60;
    if (frames === 1) return 1 / 120;
    if (frames === 2) return 1 / 30;
    if (frames === 3) return Math.min(0.05, 0.001 + r() * 0.08);
    return r() < 0.1 ? 0.05 : 0.004 + r() * 0.02;
  };
  for (let n = 0; !s.over && n < 40000; n++) {
    if (hands === 0 || (hands === 2 && r() < 0.5)) for (const input of game.bot(s.state, 0, s.now)) s.fire(input.f[1], input.f[2]);
    if ((hands === 1 || hands === 2) && r() < 0.08) s.fire(r() * 3.4 - 1.7, r() * 3.2);
    if (hands === 3) s.fire(r() * 2.4 - 1.2, 0.3 + r() * 2.6);
    s.advance(frame());
  }
  return { run: JSON.parse(JSON.stringify({ seed, countIn: s.countIn, shots: s.shots, v: RUN_VERSION })), score: s.sims[0].score };
}

/** Plays runs from..to-1 here and scores each again here: {runs: [{run, score}], mismatches: [i, ...]}. */
export function playRuns(from, to) {
  const runs = [];
  const mismatches = [];
  for (let i = from; i < to; i++) {
    const played = playRun(i);
    if (scoreRun(played.run) !== played.score) mismatches.push(i);
    runs.push(played);
  }
  return { runs, mismatches };
}

/** Scores runs played elsewhere: the indexes whose score here differs from the one the page there showed. */
export function scoreRuns(runs) {
  const mismatches = [];
  runs.forEach(({ run, score }, i) => scoreRun(run) !== score && mismatches.push(i));
  return mismatches;
}
