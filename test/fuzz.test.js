// Random rounds (test/fuzz.js): one to four seats with bots, page clocks up to a second off, uneven
// links with spikes, uplink stalls up to 8 s, lost words, drops and reconnects (both handshakes),
// frozen pages, and rebuilds at any moment. After each round every page's picture of every stall
// is the room's (test/room.js, problems). More seeds: node tools/fuzz-corks.mjs --count=2000.
import { describe, expect, it } from "vitest";
import { playRound } from "./fuzz.js";

/** Seeds that found a fault while this was built, and what it was. */
const FOUND = [
  [20, "the test room played on after the round was over (a bot fired corks no page could see)"],
  [173, "a watcher whose clock runs ahead passed the room's end and fired corks the room never did"],
  [154, "the same, the room's last snapshot after the watcher had gone past the end"],
  [118, "finish() set a watched stall's count before its picture got there: its last cork had the wrong number"],
  [113, "a late word of a cork before the bell: the watcher judged it by its own time and fired it"],
  [21, "a cork due exactly at the bell judged early by a hair (rounding)"],
  [49, "a page away when the round ended kept a cork the room never read"],
  [81, "the same, on another page"],
  [168, "the newer kit's handshake: words of corks before the snapshot that opens a connection"],
  [131, "a watcher fired late corks late: they hit other things and it ran out of corks before the room"],
  [270, "the same, with every word late (a page clock ahead of the room's)"],
  [190, "a watched stall rebuilt from rounded times went another way (exact times now)"],
  [10, "a watcher's last cork, after its corks given back drifted from the room's"],
  [50, "the same"],
  [266, "the same"],
  [285, "the same"],
  [306, "the same"],
  [387, "the same"],
];

describe("every page's picture of every stall, in random rounds", () => {
  for (const [seed, what] of FOUND) {
    it(`seed ${seed}: ${what}`, () => {
      expect(playRound(seed).problems).toEqual([]);
    });
  }

  // And more, to make 50 in all: a fixed list, so a failure here is a seed to replay.
  for (let seed = 1000; seed < 1000 + 50 - FOUND.length; seed++) {
    it(`seed ${seed}`, () => {
      expect(playRound(seed).problems).toEqual([]);
    });
  }
});
