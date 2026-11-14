# Two Sites

A round-based tactical shooter in the browser: two teams of five, a bomb, a buy menu, and gunplay
where stopping to aim beats running and spraying. Built with three.js, no build step, no network at
runtime. Entry for make.fun's `threejs-fps-01`.

## Run it

```
node serve.ts          # serves game/ on http://localhost:8080
```

Or any static server pointed at `game/`. Everything is plain ES modules; `game/index.html` opens in
desktop Chrome and plays single-player against bots with no network request.

To hand it in:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` copies `game/` and `screenshots/` to the output and writes `dossier.json` with the vendored
`buildDossier`, which is byte-for-byte what the scorer rebuilds.

## What is in it

**A complete game, not a range.** Ten fighters, five a side, in ten rounds. The player is on the
attack side for the first half and defends after the swap. A round ends when the bomb detonates, when
it is defused, when one side is eliminated, or when the clock runs out.

**Gunplay tied to movement.** Every weapon has a spread cone that opens with speed and closes when
you stop or crouch — a rifle standing still lands inside 0.35°, the same rifle running lands inside
7.5°. Recoil kicks the view up and sideways, and the cone widens with each round of a burst, so a
spray has to be fought. Head shots multiply damage by 2.8 to 3.8 depending on the weapon; legs take
three quarters.

**Tactics beyond killing.** Attackers carry a bomb that must be planted on site A or B with a 3.2
second hold and defused by defenders with a 5 second hold. Money is paid per round (3250 for a win,
1400 for a loss, 300 per kill) and spent in a buy menu that only opens during the freeze — four
weapons and two grenades. Bots walk routes through two lanes and a mid connector, take hold points,
turn toward gunfire they did not see, and lose their target behind cover.

**An original map.** Two sites, two lanes, a covered connector, staggered crates, raised platforms.
No name, character or art comes from an existing game: the palette is a cool grey with one warm
accent, and the sites are marked by amber pads and their own light.

**Code kept apart.** `state.js` is the only place game state lives. The simulation runs on a fixed
60 Hz step in `main.js`, and rendering is a separate pass. Bots and the player share movement,
collision and weapon code — a bot obeys the same spread rules as the player. Nothing builds geometry
in a frame: every mesh, material and geometry is made once at load.

| file | job |
|---|---|
| `state.js` | the one state object, and the economy constants |
| `world.js` | the map, its colliders, lights, spawns, bot routes and hold points |
| `player.js` | movement with acceleration, crouch, gravity, collision, camera |
| `bots.js` | perception, pathing, aim, burst fire, line of sight |
| `roster.js` | the ten bots: sides, routes, holds, names, skill |
| `weapons.js` | the weapon catalogue, spread, recoil, scatter, damage |
| `round.js` | rounds, economy, win conditions, side swap |
| `bomb.js` | carrying, planting, the fuse, defusing |
| `buy.js` | the buy menu and its rules |
| `input.js` | pointer lock, key set, one-shot presses |
| `hud.js` | every DOM write, diffed so the loop does not touch the document |

## Screenshots

`tools/shots.py` re-renders `screenshots/` from the real game with Playwright, waiting for each frame
to settle and failing on any console or page error. The four images are a live round at site A, a
planted bomb on its fuse, the buy menu during a freeze, and the freeze at the attacker spawn.

## Licence

MIT.
