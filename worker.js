// Cork & Bell on its own: one Worker that serves the game's files and the party kit's room API.
// Run it locally with `npm run dev`. The kit comes from n8watkins/n8-party-games (a development
// dependency); the party site hosts this same game through party.js instead of this file.
import { createPartyRoom, PinDirectory, RateLimiter, RoomBudget, ScoreBoard, handlePartyApi } from "n8-party-games/kit";
import { game, manifest } from "./party.js";

export const PartyRoom = createPartyRoom(game);
export { PinDirectory, RateLimiter, RoomBudget, ScoreBoard };

/** The high score board: this game's, with the most a round can score. */
const SCORES = { [manifest.id]: { max: manifest.scores.max } };
/** Local test runs (the "local" environment) get a board of their own, so they never chalk up on the game's. */
const TEST_SCORES = { ...SCORES, "e2e-test": { max: 1000 } };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(new URL(manifest.path + url.search, url), 302);
    const scores = env.PARTY_SIM_LATENCY === "on" ? TEST_SCORES : SCORES;
    return (await handlePartyApi(request, env, { scores })) ?? env.ASSETS.fetch(request);
  },
};
