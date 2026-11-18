// A solo run as the high score board sees it: not a score, which a page could make up, but the
// run itself (its seed, the count-in, and every cork the page fired, with the page's own clock and
// aim). The board plays it again here, with the same battle code the page ran (LocalSession), and
// chalks up the score this gives, never one the page claims.
//
// What that proves: the run keeps to the game's rules (the lever, the tray, the clock, where each
// cork could go). What it cannot prove: that a person played it. A page picks its own seed, and a
// script can play a run with the game's own code as well as a page can. The board turns away the
// same run sent twice (it keeps each row's seed), a score typed into an address
// (?state=end&score=...), and anything a page could not have sent.
//
// A run is played again by the code the board runs, which may be newer than the page that played
// it. So the page sends RUN_VERSION (`v`), and a run of another version is not scored: bump it
// whenever a change to sim.js, battle.js, session.js or layout.js would score a recorded run
// differently (test/run.test.js plays a recorded run and fails until it is bumped).
import { COUNT_IN, END_HOLD, createBattle, game, roundTime } from "./battle.js";
import { COCK_SECONDS, ROUND_SECONDS } from "./sim.js";

/** The version of the rules a run is played by. The page sends it; the board scores only its own. */
export const RUN_VERSION = 1;

/**
 * The most corks a run may list: a page sends one only when the lever is cocked (and a cork is
 * left, but dead-centre hits give corks back, so the lever is the bound): one a cock for the round,
 * 90 s / 0.48 s + 1 = 189.
 */
export const MAX_RUN_SHOTS = Math.ceil(ROUND_SECONDS / (COCK_SECONDS - 0.02)) + 1;
/** The page's clock runs in milliseconds from the run's start (LocalSession.now). Nothing is fired after the time call. */
const LAST_SHOT_MS = (COUNT_IN + ROUND_SECONDS) * 1000;
const STEP_MS = 1000 / 60;

/**
 * Plays a solo run again and returns its score, or null when it is not a run a page could have sent.
 * @param {{seed: number, countIn: number, shots: Array<[number, number, number]>, v: number}} run
 *   seed: the seed the page played it on (0 to 2^32 - 1); countIn: the seconds before the opening
 *   bell the run started with (0 to COUNT_IN); shots: [now, ax, ay] per cork the page fired, in
 *   order, where `now` is the page's clock (LocalSession.now, ms) when it fired and ax, ay the aim;
 *   v: RUN_VERSION as the page knew it.
 * @returns {number | null}
 */
export function scoreRun(run) {
  const { seed, countIn, shots, v } = run ?? {};
  if (v !== RUN_VERSION) return null;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
  if (typeof countIn !== "number" || !Number.isFinite(countIn) || countIn < 0 || countIn > COUNT_IN) return null;
  if (!Array.isArray(shots) || shots.length > MAX_RUN_SHOTS) return null;
  let last = 0;
  for (const shot of shots) {
    if (!Array.isArray(shot) || shot.length !== 3 || !shot.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (shot[0] < last || shot[0] > LAST_SHOT_MS) return null;
    last = shot[0];
  }
  // As LocalSession builds a solo round: one human seat, no delay, the count-in it started with.
  const state = createBattle({ seed, seats: [{ seat: 0, name: "", kind: "human" }], now: (countIn - COUNT_IN) * 1000, delay: 0 });
  state.stalls[0].t = -countIn;
  // The stall steps in fixed steps whatever the ticks, so ticking at each cork's moment is ticking as the page did.
  for (const [now, ax, ay] of shots) {
    game.tick(state, now);
    game.input(state, 0, { f: [roundTime(state, now), ax, ay] }, now);
  }
  const end = (countIn + ROUND_SECONDS + END_HOLD + 1) * 1000;
  for (let now = last; !state.over && now < end; now += STEP_MS) game.tick(state, now);
  return state.stalls[0].score;
}
