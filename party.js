// What Cork & Bell gives a site that hosts it: its own (worker.js here) or the party site
// (n8watkins/n8-party-games). The contract is written down in the party kit: GAME-CONTRACT.md.
//
// Nothing here, or in anything it imports, names the kit: a host's bundle holds one copy of it.

import { MAX_ROUND_SCORE } from "./game/shared/battle.js";

/** The server game definition, for the kit's createPartyRoom(game). */
export { game } from "./game/shared/battle.js";

/**
 * For the host's high score board: plays a solo run again and gives its score, or null. The board
 * hands each run its seed and chalks up only what this gives (the kit's "scores", `scoreRun`), so
 * a score a page makes up, or a run on a seed of its own choosing, never reaches the board.
 */
export { scoreRun } from "./game/shared/run.js";

export const manifest = {
  id: "cork-and-bell",
  name: "Cork & Bell",
  /** Where the game lives on a site. The same everywhere, so a join link works on any host. */
  path: "/cork-and-bell/",
  /** One line for the game's box on a party room's wall. */
  blurb: "Pop the targets, ring the bell",
  /**
   * A battle is two to four stalls, and one player plays alone (`solo`). So in a party room the
   * game takes one to four: its sign there reads "1-4 players", and a party of one gets a round
   * to itself.
   */
  players: { min: 2, max: 4, solo: true },
  /**
   * For a party room (one room, many games): the module, under `path`, whose mount() shows a
   * round the room has already started for its own seats, and takes it away again.
   */
  lobby: { view: "game/party-view.js" },
  devices: { phone: true, desktop: true, sharedScreen: true, sideways: "preferred" },
  /** The chalk board is a high score board: the host keeps it (the kit's ScoreBoard), and no round can score more than this. */
  scores: { max: MAX_ROUND_SCORE },
  /** What a browser loads, relative to this package, copied under `path` by the host's build. */
  public: [
    { from: "index.html", to: "index.html" },
    { from: "game", to: "game" },
  ],
};
