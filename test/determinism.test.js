// The simulation gives the same bits on every engine, so the high score board (the Worker, V8)
// plays a run to the very score the page showed in Chrome, Firefox or Safari. Each engine rounds
// Math.sin, cos, tan, pow, exp, log, hypot and atan2 its own way, so the simulation's files use
// none of them (dmath.js's sin and cos instead), nor `**`. Math.sqrt and + - * / are exact
// everywhere. tools/engines.mjs plays the same runs in Chromium, Firefox and WebKit and compares.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cos, sin } from "../game/shared/dmath.js";
import { PENDULUMS } from "../game/shared/layout.js";
import { pendulumBob } from "../game/shared/sim.js";

/** Every file the board's replay runs (run.js and what it imports), the page's session, and the layout the simulation reads. */
const SIMULATION = ["game/shared/sim.js", "game/shared/battle.js", "game/shared/run.js", "game/shared/layout.js", "game/shared/dmath.js", "game/session.js"];
const INEXACT = /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|pow|exp|expm1|log|log1p|log2|log10|hypot|cbrt|random)\b|\*\*/;

/** A file's code without its comments, so prose may name what the code may not use. */
function code(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("the simulation's arithmetic", () => {
  it("uses no Math function an engine may round its own way, nor `**`, nor Math.random", () => {
    for (const path of SIMULATION) {
      const lines = code(path).split("\n");
      const bad = lines.map((line, i) => [i + 1, line]).filter(([, line]) => INEXACT.test(line));
      expect(bad, path).toEqual([]);
    }
  });

  it("has a sin and cos that agree with Math's to within 2e-16 over the angles it meets", () => {
    let worst = 0;
    for (let x = -200; x <= 200; x += 0.000731) {
      worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worst).toBeLessThan(2e-16 * 8);
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
  });

  it("puts the pendulums exactly where a recorded fingerprint says (the same number in every engine: tools/engines.mjs)", () => {
    expect(pendulumFingerprint(pendulumBob, PENDULUMS)).toBe(PENDULUM_FINGERPRINT);
  });
});

/** The pendulum's bob over a whole round and more at the simulation's step, folded into one 32-bit number. */
function pendulumFingerprint(bob, pendulums) {
  let h = 0;
  const buf = new Float64Array(1);
  const u32 = new Uint32Array(buf.buffer);
  for (let i = 0; i < 12000; i++) {
    const t = -3 + i / 120;
    for (const p of pendulums) {
      const b = bob(p, t);
      for (const v of [b.x, b.y]) {
        buf[0] = v;
        h = (Math.imul(h ^ u32[0], 0x9e3779b1) ^ u32[1]) >>> 0;
      }
    }
  }
  return h;
}

/** Recorded once in Node; tools/engines.mjs checks Chromium, Firefox and WebKit come to it too. */
const PENDULUM_FINGERPRINT = 2474062969;
