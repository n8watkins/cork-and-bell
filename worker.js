// Cork & Bell on its own: one Worker that serves the game's files and the party kit's room API.
// Run it locally with `npm run dev`. The kit comes from n8watkins/n8-party-games (a development
// dependency); the party site hosts this same game through party.js instead of this file.
import { createPartyRoom, PinDirectory, RateLimiter, RoomBudget, handlePartyApi } from "n8-party-games/kit";
import { game, manifest } from "./party.js";

export const PartyRoom = createPartyRoom(game);
export { PinDirectory, RateLimiter, RoomBudget };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return Response.redirect(new URL(manifest.path + url.search, url), 302);
    return (await handlePartyApi(request, env)) ?? env.ASSETS.fetch(request);
  },
};
