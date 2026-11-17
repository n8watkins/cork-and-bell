// Do the page's engines and the board's agree to the last bit? The high score board plays a solo run
// again in the Worker (V8, as Node), and the page that played it may be Chrome, Firefox or Safari.
//
//   node tools/engines.mjs [runs=400]      (npm run test:engines)
//
// 1. Node plays the runs (tools/fuzz-play.mjs: 30, 60 and 120 Hz, janky frames, spam fire) and
//    scores each again: every score must be the one the page showed.
// 2. Chromium, Firefox and WebKit (Playwright, headless) each play the same runs with the page's
//    own session, and Node scores what they recorded: the board must chalk up what each showed.
//    Each engine also scores Node's runs.
// 3. The pendulums' positions over a round, every coordinate compared bit for bit with Node's.
// Any difference fails (exit 1).
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { playRuns, scoreRuns } from "./fuzz-play.mjs";
import { PENDULUMS } from "../game/shared/layout.js";
import { pendulumBob } from "../game/shared/sim.js";

const ROOT = new URL("..", import.meta.url).pathname;
const N = Number(process.argv[2] ?? 400);
const STEPS = 12000; // round time -3 .. 97 s at the simulation's 1/120 s steps

function pendulums(bob, list) {
  const out = [];
  for (let i = 0; i < STEPS; i++) {
    const t = -3 + i / 120;
    for (const p of list) {
      const b = bob(p, t);
      out.push(b.x, b.y);
    }
  }
  return out;
}

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path === "/") return res.end("<!doctype html><title>engines</title>");
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file) || !/^\/(game|tools)\//.test(path)) return (res.statusCode = 404), res.end();
  res.setHeader("Content-Type", [".js", ".mjs"].includes(extname(file)) ? "text/javascript" : "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = false;
const t0 = Date.now();
const node = playRuns(0, N);
const shots = node.runs.map((r) => r.run.shots.length);
console.log(`node: ${N} runs played and scored again, ${node.mismatches.length} mismatches (shots ${Math.min(...shots)}..${Math.max(...shots)}, scores ${Math.min(...node.runs.map((r) => r.score))}..${Math.max(...node.runs.map((r) => r.score))}, ${Date.now() - t0} ms)`);
if (node.mismatches.length) failed = true;
const nodeBobs = pendulums(pendulumBob, PENDULUMS);

for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await type.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base + "/");
    const started = Date.now();
    const there = await page.evaluate(
      async ({ N, nodeRuns, STEPS }) => {
        const fuzz = await import("/tools/fuzz-play.mjs");
        const { pendulumBob } = await import("/game/shared/sim.js");
        const { PENDULUMS } = await import("/game/shared/layout.js");
        const played = fuzz.playRuns(0, N);
        const bobs = [];
        for (let i = 0; i < STEPS; i++) {
          const t = -3 + i / 120;
          for (const p of PENDULUMS) {
            const b = pendulumBob(p, t);
            bobs.push(b.x, b.y);
          }
        }
        return { runs: played.runs, ownMismatches: played.mismatches, nodeMismatches: fuzz.scoreRuns(nodeRuns), bobs, ua: navigator.userAgent };
      },
      { N, nodeRuns: node.runs, STEPS },
    );
    // What the board would chalk up for the runs this engine's page played.
    const boardMismatches = scoreRuns(there.runs);
    // The same run number must be the very same run in every engine (same shots, same score).
    const differentRuns = there.runs.filter((r, i) => JSON.stringify(r) !== JSON.stringify(node.runs[i])).length;
    let bobDiff = 0;
    for (let i = 0; i < nodeBobs.length; i++) if (!Object.is(there.bobs[i], nodeBobs[i])) bobDiff++;
    console.log(
      `${name}: played ${there.runs.length} runs (${Date.now() - started} ms); the board (Node) scores ${boardMismatches.length} differently; ` +
        `it scores Node's runs ${there.nodeMismatches.length} differently and its own ${there.ownMismatches.length}; ` +
        `${differentRuns} runs differ from Node's; ${bobDiff} of ${nodeBobs.length} pendulum coordinates differ`,
    );
    if (boardMismatches.length || there.nodeMismatches.length || there.ownMismatches.length || differentRuns || bobDiff) failed = true;
  } finally {
    await browser.close();
  }
}
server.close();
console.log(failed ? "ENGINES DISAGREE" : "All engines agree, bit for bit.");
process.exit(failed ? 1 : 0);
