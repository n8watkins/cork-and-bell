// Builds dist/public, the only folder the Worker serves as static files.
//
// The work is done by the party kit's build helper: the game's public files (party.js lists
// them) are copied under the game's path, the kit's browser files under /party-kit/client/,
// and nothing else in the repository can reach the public site.
// Wrangler runs this before `wrangler dev` and `wrangler deploy` (the "build" key in
// wrangler.jsonc) and again whenever a watched folder changes.
//
//   node scripts/build-public.mjs          build, print a one-line summary
//   node scripts/build-public.mjs --list   build and list every file that will be served
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_CLIENT_PATH, buildPublic, kitClientEntry, report } from "n8-party-games/kit/build";
import { manifest } from "../party.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "dist", "public");

const under = manifest.path.replace(/^\/|\/$/g, "");
const entries = [kitClientEntry(), ...manifest.public.map(({ from, to }) => ({ from: join(ROOT, from), to: `${under}/${to}` }))];

/** Every site path that is served: the game's public files and the kit's browser files. */
export const SERVED = [KIT_CLIENT_PATH, ...manifest.public.map(({ to }) => `${under}/${to}`)];

export function build() {
  return buildPublic({ out: OUT, entries });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) report(build(), OUT);
