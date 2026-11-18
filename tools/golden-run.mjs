// Records the golden run for the current RUN_VERSION (test/golden-runs.json): a solo run played as
// the page plays it, and the exact score it came to. test/run.test.js plays it again on every test
// run, so a change to the simulation that would score a recorded run differently fails until
// RUN_VERSION is bumped (game/shared/run.js) and this is run once for the new version.
//
//   node tools/golden-run.mjs
//
// It never overwrites the run of a version already recorded: the old ones stay, as a record.
import { readFileSync, writeFileSync } from "node:fs";
import { LocalSession } from "../game/session.js";
import { game } from "../game/shared/battle.js";
import { RUN_VERSION, scoreRun } from "../game/shared/run.js";

const FILE = new URL("../test/golden-runs.json", import.meta.url);

/** A small seeded random number source, so the run is the same each time it is recorded. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
}

/**
 * The page's own session on uneven frames; the game's bot aims, and now and then a cork goes
 * anywhere (lamps, prizes, the back board, the pendulums), so the run touches most of the rules.
 */
export function playGolden(seed = 2026111601) {
  const random = rng(seed);
  const session = new LocalSession({ seed, seats: [{ seat: 0, name: "You", kind: "human" }], mySeat: 0, countIn: 1.2 });
  for (let n = 0; !session.over && n < 40000; n++) {
    for (const input of game.bot(session.state, 0, session.now)) session.fire(input.f[1], input.f[2]);
    if (random() < 0.012) session.fire(random() * 3.4 - 1.7, random() * 3.2);
    session.advance(Math.min(0.05, 0.004 + random() * 0.03));
  }
  return { run: JSON.parse(JSON.stringify({ seed, countIn: session.countIn, shots: session.shots, v: RUN_VERSION })), score: session.sims[0].score };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = JSON.parse(readFileSync(FILE, "utf8").trim() || "{}");
  if (all[RUN_VERSION]) {
    console.error(`Version ${RUN_VERSION} is recorded already. Bump RUN_VERSION in game/shared/run.js first.`);
    process.exit(1);
  }
  const { run, score } = playGolden();
  if (scoreRun(run) !== score) throw new Error(`played again it scores ${scoreRun(run)}, not ${score}`);
  all[RUN_VERSION] = { score, run };
  writeFileSync(FILE, JSON.stringify(all) + "\n");
  console.log(`Recorded version ${RUN_VERSION}: ${run.shots.length} corks, score ${score}.`);
}
