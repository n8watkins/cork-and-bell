# Cork & Bell

A travelling fairground shooting gallery of the 1930s, at dusk.
One stall on your own, or a battle of two to four stalls side by side.

The game began from a "cork gallery" build prompt written by Nick Saraev: a stylized shooting gallery of handmade objects at toy scale, lit with baked light and seen through a real lens.
His prompt is not reproduced here.
The battle mode and all the code in this repository were made for this project.

This repository is the whole game: clone it, install, and play alone or in a battle.
The rooms (PINs, seats, reconnecting, the waiting room) come from the party kit in [n8watkins/n8-party-games](https://github.com/n8watkins/n8-party-games), which npm fetches as a development dependency.
That repository is also the party site, which hosts this game beside others through [`party.js`](party.js).

## Run it

```sh
npm install
npm run dev          # http://localhost:8791/cork-and-bell/
npm run dev:lan      # the same, reachable from phones on the same network
npm test             # the simulation, the battle rules and the deploy settings
npm run playtest     # one full solo run with scripted input, with screenshots
npm run playtest:battle   # four headless players at 150 ms, a drop and rejoin, a rematch
npm run test:room    # the room over real sockets, no browser (add -- --full=1 to time a whole round)
```

Everything is local.
Nothing is deployed; [DEPLOY.md](DEPLOY.md) is the checklist for putting this one game online.

The party kit is a git dependency.
npm 12 refuses those unless told otherwise, so [`.npmrc`](.npmrc) here sets `allow-git=root`: the one git dependency this package names itself is allowed, and no other.
While the two repositories are private, `npm install` also needs a GitHub login that can read them.

`wrangler dev` watches this repository and restarts the local server when a file in it changes.
A restart puts every room back in its lobby, so do not edit files (or save screenshots into the repository) while a battle is being played or tested.
The tools save their screenshots to the temp directory for that reason (`CAB_SHOTS` chooses another place).
They talk to `http://localhost:8791/cork-and-bell/` unless `CAB_BASE`, `PORT` or `--base=` says otherwise, and their browsers are always muted.

Phones are meant to be held sideways.
An upright phone still plays, with its own framing and a hint to turn it.

| Address | What you get |
| --- | --- |
| `/cork-and-bell/` | The stall, with the start board: play alone, battle with friends, sound. The house plays behind it; a click or a touch on a target takes the gun and fires at once. |
| `?auto=1` | The bot keeps playing (the attract mode, for a solo look). |
| `?seed=7` | A repeatable run. |
| `?t=41&auto=1&seed=7` | The picture frozen at round time 41 s. |
| `?state=last`, `end`, `jam`, `moths`, `dark` | The fast last stretch, the end card, or one attack on its own. |
| `?view=wide`, `mech`, `far`, `front`, `gun`, `board` | Other cameras (`board` looks at the high scores). |
| `?state=end&score=5120` | The end card with that score, to try the high score entry. |
| `?view=four` | Four stalls side by side with a bot in each: the battle as a shared screen shows it, with no room needed. |
| `?join=4821` | The lobby with a PIN filled in (this is what the QR code opens). |
| `?quality=low` or `high` | Lens and shadow quality (phones start on low). |
| `?grid=row` | With four stalls on a shared screen: one row of four upright stalls instead of two rows of two. |

Sound is off until you turn it on: **Sound is off** on the start board, the **Sound: off** switch at the top right during a round, or the M key.

A battle: press **Battle with friends**, then **Make a room** (you play on this device) or **Use this screen as the shared screen** (a laptop or television shows every stall; players join on their phones with the PIN or the QR code).

## The rules of the medium

Decided before any code, and kept everywhere.

- **One medium:** a real stall, built by a wheelwright and a sign-writer, photographed at dusk with a fast lens. Nothing glows that is not a lamp. Nothing floats. The HUD is paper and enamel, never glass.
- **Wood** is softwood board, hand-painted in oil enamel: oxblood, bottle green, navy, cream. Brush strokes run along the grain. Paint is chipped to the wood where corks have struck for years, most on the treads and the back board.
- **Lettering** is the sign-writer's: fat-face capitals in gold with a red drop shade, numerals in cream roundels with a gold edge. The words are the stall's own: Cork & Bell, Wren & Tolliver's Travelling Gallery, Ten a pot.
- **Targets** are cut from sheet iron and enamelled: five teapots, a chain of gilt stars, two moons on pendulums, a small star behind a shutter, a spun brass bell. Flat plates with a cut edge, painted on one side, chipped at the rim.
- **Brass** is rubbed bright where hands go (the barrel, the lever) and dull elsewhere.
- **Light** is tungsten bulbs with visible filaments against a blue dusk. The static set's light is baked in Cycles (bulbs and sky separately, so the lamps can really go out). Moving things are lit live by the same sky and lamps and cast soft shadows onto the baked set.
- **Motion** is mechanical and has one source: a flywheel on the left wall turns a belt; the belt turns a wheel for each row; a cam bar lifts the fallen front row, a chain carries the stars, the pendulums swing, the shutter opens. Everything speeds up together.
- **The lens** has shallow depth of field that racks to the row under the aim, bloom only on real lamps, a filmic shoulder and a little grain.
  At low quality the blur is made at half size with a fixed kernel (no per-pixel noise) and edges are smoothed in the last pass.

## The game

- Point and click (or drag and release on a phone). The cork flies a real arc: it is sighted in for the front row and drops beyond it, so the far row needs a higher aim.
- The lever takes half a second to cock. Seventy corks a round. A dead-centre hit earns the cork back.
- Front row teapots 10, chain stars 25, pendulum moons 50, the shutter star 100, the bell 15.
- A run of 4 hits doubles, a run of 8 trebles. A ricochet hit (the cork has already bounced off something) trebles on top of that. Dead centre is worth half as much again.
- The ticket at the bottom left shows the time and the score, with the run (and what it multiplies by) and the corks left on its stub. It keeps clear of the cork tray on every screen shape.
- Two challenges are chalked up each round (the same two for every stall in a battle), 75 to 150 extra each: five in a row, a ricochet onto a star, put out a lamp, and so on.
- Everything in the stall answers a cork, for no points: lamps go out with a tinkle, the prizes on the shelf rock and fall, the chalk board smudges, the drive rings. A cork aimed over the top flies over the top.
- The chalk board on the left wall is the high score board: everybody's ten best, kept by the server (`/api/party/scores/cork-and-bell`), with the house's own players among them. A solo score that makes it asks for three letters. Each device also keeps its own best, and the game plays on with that if the board cannot be reached.
- Hits fill the bell's ring of lamps. When it is full the bell is live: ring it for 100.
- The round is 90 seconds and the machine speeds up all the way through.

### The battle

- Three hits in a row: a cork wedges into a rival's cam and the front row stays down until they shoot it loose.
- A ricochet hit: moths drift across a rival's sights for 4 seconds.
- Ringing the live bell: a rival's lamps go out for 3 seconds.
- Attacks go to the leader, unless you tap a rival's token to pick them.
- Every attack is seen coming for 1.5 seconds. A dead-centre hit in that time blocks it and sends it back with a brass chime.
- Never more than two at once on one stall; a third fizzles.
- The round ends at 90 seconds, or when only one stall still has corks.

## How it is built

| Path | What it is |
| --- | --- |
| `index.html` | The entry file. |
| `party.js` | What a host needs: the server game definition and the manifest (name, path, players, public files). The party kit's GAME-CONTRACT.md is the contract. |
| `worker.js`, `wrangler.jsonc` | The game's own site: its files and the party kit's room API, as one Cloudflare Worker (production at the top level, `local` for play and tests). |
| `scripts/build-public.mjs` | Builds `dist/public`, the only folder served: the files `party.js` lists and the kit's browser files. |
| `game/shared/layout.js` | The stall in metres: one source for the bake, the simulation and the picture. |
| `game/shared/sim.js` | One stall, simulated in fixed steps from a seed. Runs in the room and in every browser. |
| `game/shared/battle.js` | The battle as a party kit game: inputs, bots, attacks, blocks, snapshots. |
| `game/session.js` | A round as the browser sees it: local (solo, attract) or following a room. |
| `game/party-view.js`, `game/hosted.js` | The game as a view a party room mounts over itself: see "Inside a party room". |
| `game/view/` | The picture: the lens (`render.js`), the stall (`stall.js`), hand-painted textures (`paint.js`). |
| `game/scores.js` | The high scores: the server's board, this device's own best, and what the chalk board shows. |
| `game/audio.js` | Every sound, made in WebAudio. Silent until you enable it. |
| `game/baked/` | The Cycles bake: `set.glb`, albedo, two light maps, and the environment the moving things reflect. |
| `game/vendor/` | three.js r186, local. |
| `tools/blender/build_set.py` | Builds the static set by script and bakes it (`tools/blender/run.sh build_set.py 4096 64`). |
| `tools/*.mjs` | Screenshots, the two playtests, and the real-GPU frame rate measurement. |

Rooms, PINs, the QR code, seats, reconnecting and the waiting room come from the party kit (`node_modules/n8-party-games/party-kit`, served at `/party-kit/client/`); this game adds no join flow of its own.
The kit's README there has the room rules, the API and what hosting costs.

### Netcode

The room is the authority.
A client sends only `{f: [time, aimX, aimY]}` (fire, stamped with the room's clock) and `{pick: seat}`.
The room runs every stall's simulation 0.3 s behind its clock, so inputs arrive before their time, and decides hits, scores, attacks and blocks.
Each browser runs the same deterministic simulation for an instant picture: its own stall at once, the others 0.45 s behind from the relayed inputs.
The room's snapshots (twice a second) correct any stall that drifts, and its result is the result.
Every random choice comes from the room's seed and the shot's number.

### Inside a party room

The party site has one room that holds a group while it goes from game to game.
When the group votes for Cork & Bell there, the room starts a battle for the seats it already has, and its page mounts this game over itself and takes it away at the end.
The manifest names the module for that (`lobby: { view: "game/party-view.js" }`), and the party kit's GAME-CONTRACT.md has the host's side.

```js
import { mount } from "/cork-and-bell/game/party-view.js";

const view = mount(container, { room, you, snapshot, send, now, inset });
view.events(list);             // what the room's game.tick returned
view.snapshot(s, now, full);   // the room's periodic snapshot, or a full one after a reconnect
view.unmount();                // the round is over
```

- `mount` adds one `<iframe>` to the container and nothing else to the host's page. The frame shows this game's own page in hosted mode (`?party=1`): no start board, no waiting room, no end card, no rematch.
- The page finds the host on its own frame element and calls it directly (the two are the same origin): the room's clock, the first snapshot, events and snapshots in, inputs out. Whatever the room says while the page is still loading is kept and handed over in order.
- `unmount` tells the page to let go of its WebGL context and its sound at once, and removes the frame. The page's listeners and timers belong to the frame's document and go with it, so nothing is left on the host's page.
- `you` decides the picture: a player with a stall in the round gets that stall; a big screen, or someone who came in while the round was on, gets every stall side by side.
- A party of one gets a round to itself: the same ninety seconds, with nobody to send attacks to. The high score board is not asked for in a party room; it belongs to the game's own page.
- `inset` is the corner the host keeps for a button of its own; the sound switch stands clear of it.
- `preload()` (optional) fetches the page's big files while the host's vote is still counting.
- A host must let its own pages be framed by its own pages (`frame-ancestors 'self'`, `frame-src 'self'`); the party site's headers do.

The page opened on its own, at `/cork-and-bell/`, never takes this path: without a host on its frame element `?party=1` does nothing.

### Fonts

Abril Fatface and Playfair Display SC, both under the SIL Open Font License (see `game/fonts/`).
The page makes no request outside its own origin.

## License

The code is under the [MIT License](LICENSE).

Third-party parts keep their own licenses:

- three.js, in `game/vendor/`, MIT (`LICENSE-three`).
- Abril Fatface and Playfair Display, in `game/fonts/` and `tools/fonts/`, SIL Open Font License 1.1 (the `OFL-*.txt` files beside them).
