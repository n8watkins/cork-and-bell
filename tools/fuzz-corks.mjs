// Plays random rounds (test/fuzz.js) and says which seeds leave a page's picture of a stall unlike
// the room's: corks pictured or missed, twice, with another aim, or another count of corks left.
//   node tools/fuzz-corks.mjs [--from=1] [--count=2000] [--seed=<n>]
//     --seed=<n>   one round, with every problem it has
// Exits 1 when any round has a problem.
import { playRound } from "../test/fuzz.js";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const one = arg("seed", "");
const from = Number(one || arg("from", 1));
const count = one ? 1 : Number(arg("count", 2000));
const t0 = Date.now();
const bad = [];
let shots = 0;
for (let seed = from; seed < from + count; seed++) {
  const r = playRound(seed);
  shots += r.shots.reduce((a, b) => a + b, 0);
  if (r.problems.length) {
    bad.push(seed);
    console.log(`seed ${seed} (${r.seats} seats, ${r.pages} pages):\n  ${r.problems.slice(0, one ? 99 : 4).join("\n  ")}`);
  }
}
console.log(`${count} rounds from seed ${from}, ${shots} corks fired, ${bad.length} with problems${bad.length ? ": " + bad.join(",") : ""} (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(bad.length ? 1 : 0);
