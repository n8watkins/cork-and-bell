// Deterministic sin and cos for the simulation.
//
// JavaScript's +, -, *, / and Math.sqrt are exact IEEE-754 on every engine, but Math.sin, Math.cos
// (and Math.pow, Math.exp, Math.atan2, Math.hypot) are not: the standard lets each engine round them
// its own way, and V8 (Chrome, Node, the Workers runtime), SpiderMonkey (Firefox) and JavaScriptCore
// (every browser on an iPhone) differ in the last bit. The high score board plays a solo run again in
// the Worker (run.js), and a cork that grazes a pendulum one bit differently can score differently,
// so the simulation uses these, built from the exact operations only: the same inputs give the same
// bits in the room, in Node, in Chrome, in Firefox and in Safari.
//
// Copied from n8-party-games floor/games/tin-derby/shared/dmath.js (sin and cos only). The polynomials
// are the classic fdlibm ones; they agree with Math.sin and Math.cos to about 1e-15 (test/dmath.test.js).

const TWO_OVER_PI = 0.6366197723675814;
// Half pi in two parts: the first has only 33 significant bits, so k * PIO2_1 is exact for any k the
// simulation can reach (its angles stay well under a thousand radians).
const PIO2_1 = 1.5707963267341256;
const PIO2_1T = 6.077100506506192e-11;

const S1 = -1.66666666666666324348e-1, S2 = 8.33333333332248946124e-3, S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6, S5 = -2.50507602534068634195e-8, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2, C2 = -1.38888888888741095749e-3, C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7, C5 = 2.0875723212981748279e-9, C6 = -1.13596475577881948265e-11;

/** sin on [-pi/4, pi/4]. */
function ksin(r) {
  const z = r * r;
  return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}
/** cos on [-pi/4, pi/4]. */
function kcos(r) {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
}

/** Which quarter turn x is nearest (k), and what is left over (returned): x = k * pi/2 + r. */
let quarter = 0;
function reduce(x) {
  const k = Math.round(x * TWO_OVER_PI);
  quarter = k & 3;
  return x - k * PIO2_1 - k * PIO2_1T;
}

export function sin(x) {
  const r = reduce(x);
  return quarter === 0 ? ksin(r) : quarter === 1 ? kcos(r) : quarter === 2 ? -ksin(r) : -kcos(r);
}

export function cos(x) {
  const r = reduce(x);
  return quarter === 0 ? kcos(r) : quarter === 1 ? -ksin(r) : quarter === 2 ? -kcos(r) : ksin(r);
}
