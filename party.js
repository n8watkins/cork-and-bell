// What Cork & Bell gives a site that hosts it: its own (worker.js here) or the party site
// (n8watkins/n8-party-games). The contract is written down in the party kit: GAME-CONTRACT.md.
//
// Nothing here, or in anything it imports, names the kit: a host's bundle holds one copy of it.

/** The server game definition, for the kit's createPartyRoom(game). */
export { game } from "./game/shared/battle.js";

export const manifest = {
  id: "cork-and-bell",
  name: "Cork & Bell",
  /** Where the game lives on a site. The same everywhere, so a join link works on any host. */
  path: "/cork-and-bell/",
  players: { min: 2, max: 4, solo: true },
  devices: { phone: true, desktop: true, sharedScreen: true, sideways: "preferred" },
  /** What a browser loads, relative to this package, copied under `path` by the host's build. */
  public: [
    { from: "index.html", to: "index.html" },
    { from: "game", to: "game" },
  ],
};
