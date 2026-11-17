// A solo run as the high score board sees it: not a score, which a page could make up, but the
// run itself (the seed the board handed out, the count-in, and every cork the page fired, with
// the page's own clock and aim). The board plays it again here, with the same battle code the
// page ran (LocalSession), and chalks up the score this gives, never one the page claims.
//
// So a run that was never played (an address's ?state=end&score=...), a run on a seed the board
// did not hand out (?seed=7), or a run sent twice cannot reach the board: the board hands out
// each seed once, and only a seed it handed out is played again (party kit, "scores").
import { COUNT_IN, END_HOLD, createBattle, game, roundTime } from "./battle.js";
import { CORKS_PER_ROUND, ROUND_SECONDS } from "./sim.js";

/** The most corks a run may list: a page sends a cork only when the lever is cocked and a cork is left. */
export const MAX_RUN_SHOTS = CORKS_PER_ROUND * 2;
/** The page's clock runs in milliseconds from the run's start (LocalSession.now). Nothing is fired after the time call. */
const LAST_SHOT_MS = (COUNT_IN + ROUND_SECONDS) * 1000;
const STEP_MS = 1000 / 60;

/**
 * Plays a solo run again and returns its score, or null when it is not a run a page could have sent.
 * @param {{seed: number, countIn: number, shots: Array<[number, number, number]>}} run
 *   seed: as the board handed it out; countIn: the seconds before the opening bell the run
 *   started with (0 to COUNT_IN); shots: [now, ax, ay] per cork the page fired, in order, where
 *   `now` is the page's clock (LocalSession.now, ms) when it fired and ax, ay the aim.
 * @returns {number | null}
 */
export function scoreRun(run) {
  const { seed, countIn, shots } = run ?? {};
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
  if (typeof countIn !== "number" || !Number.isFinite(countIn) || countIn < 0 || countIn > COUNT_IN) return null;
  if (!Array.isArray(shots) || shots.length > MAX_RUN_SHOTS) return null;
  let last = 0;
  for (const shot of shots) {
    if (!Array.isArray(shot) || shot.length !== 3 || !shot.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
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
