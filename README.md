# Rewind

Rewind lets you jump back into any moment of a round you lost in **Rewind Duel**, a small top-down 1v1 tactical shooter, and replay it against a clone of your real opponent built from their own recorded games. Built for DevHacks 2026 (Riot Games Track 1, Gameplay Bots).

**Status:** Phases 1ΓÇô5 are done ΓÇö the playable two-player game with recording and replay, rewind sessions (ghost ΓåÆ clone handoff with a behavior trace), k-nearest-neighbor clones with a circuit breaker, the what-if plan ranker, and the evidence evals. Phase 6 is partly done: a first-person three.js view of any recorded match (`/fpv.html`) with running ripples; the Cloudflare Durable Object migration is deliberately deferred (see `DECISIONS.md` D33). See `spec.md` for the full plan and `DECISIONS.md` for design choices.

## Architecture

```
 browser (web/)                 Node (server/)                     disk (data/)
+----------------+  input 32/s +-------------------------------+
| canvas client  | ----------> | room: MatchRunner             |
| draws only the |             |   step(state, inputs)  <----- engine/ (pure TS, deterministic)
| Observation it | <---------- |   observe(state, slot)        |   write on match end
| is sent        |  obs+events |   input log (changes only)    | ------------------> <id>.json
+----------------+             +-------------------------------+                        |
                                                                                        v
                               npm run replay -- data/<id>.json  ->  rebuild from seed + inputs, compare hash
```

- **`engine/`** is the whole game as pure functions with no dependencies: `createMatch`, `step`, `observe`, `hashState`, `replayMatch`. It has no clock and no `Math.random`; randomness comes from a seeded mulberry32 whose state lives inside the game state. Same seed plus same inputs gives the same hash, which is what makes rewinding possible at all.
- **`server/`** owns the clock. It steps the engine 32 times a second, logs every input change with the tick it applied on, and sends each player only `observe(state, slot)`. The enemy position never leaves the server unless that player can see the enemy.
- **`web/`** sends keys and mouse, and draws what it is told. Fog of war is enforced by the server, the client only shades it. The one thing it computes is a prediction of its own movement, using the engine's `applyMovement` on inputs the server has not acknowledged yet, so your own movement does not wait for the round trip (DECISIONS D16). The prediction is never sent or recorded.
- **`data/`** holds recorded matches. A match file is a seed plus an input log, a few hundred KB, and replays to the exact final state.

## Install

Needs Node 20 or newer.

```bash
npm install
```

## Run a match

Two terminals:

```bash
npm run server
```

```bash
npm run web
```

This is the development setup (Vite hot reload on 5173, game server on 8080). Open `http://localhost:5173` in two tabs (or on two laptops on the same wifi, using the Network URL Vite prints). Enter a name and the **same room code** in both. The match starts when the second player joins. First to 5 rounds; sides swap after round 4.

| Key | Action |
| --- | --- |
| WASD | move |
| Shift | walk (quieter aim: 4 degree spread instead of 10) |
| Mouse | aim, hold left button to fire |
| R | reload (2 s) |
| Q | smoke, lands up to 8 units along your aim, once per round |
| E | dash 4 units in your move direction, once per round |
| F | hold to plant in A or B (attacker, 2 s, standing still) or defuse (defender, 4 s) |
| M | mute sound |

The strip under the arena is the round as the server records it: the red head is now, amber marks are your shots (tall ones hit), red marks are hits on you, the blue band is when you could see your rival, and diamonds are kills, deaths and the plant.

When the match ends or someone disconnects, the server writes `data/<room>-<timestamp>.json`.

## Let other people play (public URL)

The server can serve the built client itself, so the whole game is one port. Build once, start the server, then point a Cloudflare Tunnel at it:

```bash
npm run build
```

```bash
npm run server
```

```bash
cloudflared tunnel --url http://localhost:8080
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL. Anyone who opens it and enters the same room code plays on your machine, and their matches land in your `data/`. The URL lasts until you stop `cloudflared`, and changes every time you start it. Rebuild and restart the server after changing anything in `web/`.

The game still runs in Node on your laptop, so the laptop has to stay awake and online. Your own movement is predicted, so it feels instant, but shots, hits and the enemy still arrive one round trip late. The HUD shows the current lag.

## Test with fake lag

To see prediction work on one machine, start the server with a fake delay (60 ms each way, so 120 ms round trip):

```bash
LAG_MS=60 npm run server
```

## Replay a match

```bash
npm run replay -- data/<id>.json
```

Rebuilds the match from its seed and inputs in Node and prints whether the final hash matches the live one. Exit code 0 on match, 1 on mismatch.

To record a match without two humans (server must be running):

```bash
npm run botmatch
```

## Checks

```bash
npm test
```

```bash
npm run check:determinism
```

```bash
npm run typecheck
```

`check:determinism` fails if `Math.random` or `Date.now` appears anywhere in `engine/`.

## Run a rewind

Build the client and start the server (the replay viewer is served from the same port):

```bash
npm run build
```

```bash
npm run server
```

Open `http://localhost:8080/replay.html`. Pick a recorded match, scrub the timeline (kills, plants and round starts are marked), and toggle each player's vision. Then:

- **Take control from here** opens a rewind session on the server. You drive your own slot; the opponent first replays its recorded inputs (ghost), and once your play diverges past the limit it hands off to a clone of the real opponent built from their other games. The circuit breaker drops to a basic bot when the clone hits a situation it has never seen. The behavior-trace panel logs every opponent decision; clicking a `CLONE` line shows the recorded moment(s) it copied.
- **What could I have done?** ranks about twenty scripted micro-plans (stop and shoot, back off to cover, smoke then cross, dash out, ΓÇª) by running each five times from the fork against the guarded clone, in a worker thread, and shows the top 3 with a one-line reason.
- **first-person ΓåÆ** opens `/fpv.html`, a three.js first-person view of the same recorded match ΓÇö walls extruded, the camera at one player's eye along their aim, a ripple on the floor whenever a player runs. It renders the 2D snapshots; the simulation stays 2D.

There is also a **Unity 3D viewer** of recorded matches under `unity/RewindDuel3D` (scaffolded from the `unity` CLI). Like the three.js view it is a renderer of exported snapshots, not a second engine. Build its data with `npm run export:unity`, then see `unity/README.md` to generate the scene and run it.

## Run the evals

```bash
npm run eval
```

Writes `eval/results.md`. For each player with enough data it holds out one of their matches, builds their clone from the rest, and on the held-out match reports clone accuracy (move + fire match vs the real person), 1-second position error, handoff rate, and a transfer test ΓÇö each for three policies: the player's own clone, the basic bot, and a clone of a different player. Numbers are reported as-is, including weak ones.

You can also run one what-if from the command line:

```bash
npm run whatif -- data/<id>.json <human 0|1> <forkTick>
```

## This branch: VALORANT rules and the live AI (valorant-ai-bot)

Built in parallel with main's Phases 2 to 6, then merged. Everything above still works as it does on main. This branch adds the live game: VALORANT rules (18 guns, economy, shields, ranks), an adaptive AI with a belief map that calls your play, footsteps, flashbangs, five maps, an in-game replay viewer with rewind, a what-if planner and an AI coach, a mirror mode against your own clone, and a first-person three.js view (V). Its own clone/rewind/what-if code lives in `ai/`; main's `clone/`, `rewind/` and `eval/` packages are untouched. `DECISIONS.md` D49 to D69 explain it.

Quick start: `npm install`, then `npm run server` and `npm run web`, open `http://localhost:5173`, pick **vs AI** and play.

### Play the AI

Pick **vs AI** in the lobby, choose a map and a difficulty, and play. You only need one tab and the server.

The AI plays through the same `observe()` a human gets, so it has fog of war and can be flashed like you. What it knows about *you* comes from `data/brains/<your name>.json`, which is updated after every match you play (against the AI or a friend):

- which site you attack, so it holds there on defence
- which site you defend, so it attacks the other one
- where you stand and where you kill it from, so it pre-aims those spots
- how often you turn away from its flashes

**Adaptive** difficulty (the default) gets harder each round you win and easier each round you lose, aiming for about even. Easy, Normal, Hard and Insane are fixed. The result screen tells you what the AI has learned. Delete your brain file to make it forget you.

### Maps

| Map | Sites | What's special |
| --- | --- | --- |
| Duel | A, B | The original: three lanes and a mid door |
| Bind | A, B | No mid. Two one-way teleporters on the attacker side |
| Haven | A, B, C | Three sites to guess between |
| Ascent | A, B | Open mid courtyard, each site has a main and a door |
| Split | A, B | Tight two-unit chokes and mid vents |

These are small 1v1 top-down layouts built around each map's signature idea, not copies of the real maps. Their internal ids (`relay`, `trident`, `courtyard`, `fault`) stay the same so recordings and AI memories keep working.

In a friend match each player votes for a map in the lobby. Same vote: that map. One votes Random: the other vote wins. Two different maps: a coin flip between them.

The strip under the arena is the round as the server records it: the red head is now, amber marks are your shots (tall ones hit), red marks are hits on you, the blue band is when you could see your rival, and diamonds are kills, deaths and the plant.

When the match ends or someone disconnects, the server writes `data/<room>-<timestamp>.json`.

### More keys

| Key | Action |
| --- | --- |
| C | flashbang, two per round. Only blinds a player looking at the pop; turning away dodges it |
| V | first person 3D (click to lock the mouse; W walks where you look). The 2D map becomes a minimap. V again for top-down |
| T | show or hide the trace panel: what the AI or clone decided, and why |
| I | show the AI's mind on the map: where it believes you are |
| Buy phase (first 4 s) | the buy menu opens: click any gun or shield, or quick keys 1 Vandal, 2 Phantom, 3 Operator, 4 Spectre, 5 Sheriff, 6 Ghost, 7 Light Shields, 8 Heavy Shields. B hides/shows it |
| 1 / 2 | after the buy phase: primary / sidearm |

### VALORANT rules, guns and economy

Live matches use VALORANT's rules (with the permission given to hackathon attendees): you start each half with a Classic and 800 credits; a round win pays 3000, a loss 1900 / 2400 / 2900 on a losing streak, a kill 200, a plant 300, capped at 9000; you keep your guns and shields only if you survive the round. The economy resets at the side swap.

All 18 guns, with their in-game damage (head / body), fire rate, magazine, reload and price, including Phantom/Spectre/Classic/Ghost/Sheriff/Frenzy/Stinger/Ares/Odin range falloff and shotgun pellets: Classic, Shorty, Frenzy, Ghost, Sheriff, Stinger, Spectre, Bucky, Judge, Bulldog, Guardian, Phantom, Vandal, Marshal, Outlaw, Operator, Ares, Odin. Light Shields (+25, 400) and Heavy Shields (+50, 1000) take damage before health. The stats are in `engine/weapons.ts` and were written from memory of recent patches: check them against the current patch notes before quoting an exact number.

A hit is a **headshot** when the bullet's line passes within 0.13 units of the target's centre, so headshots are aim, not luck (a Vandal tapped at the centre one-taps at any range). Holding the trigger blooms the spread. Suppressed guns (Phantom, Spectre, Ghost) are not heard through walls; everything else is heard within 30 units, by you and the AI. Legs are not modelled (top-down).

Older recordings and the tests use the original "classic" rules (free buys, the original 25-damage rifle), and replay exactly as before.

### Ranks

VALORANT's ranks: Iron, Bronze, Silver, Gold, Platinum, Diamond, Ascendant, Immortal (3 divisions each), Radiant. **Ranked** play starts the AI low; it climbs when you win rounds and drops when you lose (faster on streaks). Your rank is the level you are currently holding your own against, with RR as progress through the division. You can also pick a fixed rank in the lobby. Higher ranks react faster, wobble less, wait for the head before shooting, burst at range, swap to the pistol instead of reloading mid-fight, flash and dodge flashes, trust the belief map, manage the economy (pistol rounds, full buys at 3900, force buys, ecos), counter-buy your favourite gun, and at the very top prefire the corner they are sure you are behind.

Evidence, `npm run eval:ranks` (VALORANT rules, economy included): every tier beats the tier below it (last run: 59, 56, 63, 53, 56, 62, 60, 71% of rounds to the higher tier).

### The AI calls your play

Before it has seen you, the AI says where you are going (`CALL calling it: you are hitting B, 64%`), from its belief map and your history on that side. When the round ends the server checks it (`CALLED` or `MISREAD`), and the HUD keeps score (`AI READS 5/7`). `npm run eval:reads`: against a player who always hits A, its calls went 0/1, 2/3, 3/3, 5/5 over four matches as it learned them.

### Fight yourself

**vs yourself** in the lobby: your opponent is the k-nearest-neighbour clone of you, built from every decision you have recorded under your name, carrying your favourite guns. Play a match or two first.

### AI coach

After a match against the AI or your clone, the result screen reviews your last 3 deaths: from 3 seconds before each, the what-if planner plays 20 plans ├ù 5 seeds and tells you what would have won the fight ("Flash them, then peek: won the fight 5/5"). Click one to watch it. Takes about 10 to 15 seconds in the background.

Footsteps: running (not walking) within 14 units is heard through walls, as a rough 2 by 2 spot. You see it as blue rings; the AI uses it too.

### How the AI works

The AI only ever gets `observe()`, the same fogged view a player gets.

1. **Belief map** (`server/belief.ts`). A 48 by 32 grid of "how likely is the player here". Every tick: probability spreads along open floor at running speed (faster along the routes you usually take); every cell the AI can see right now goes to zero, because you would be visible there; footsteps put everything in the heard cell; seeing you puts everything on you. It pre-aims the angle with the most probability, flashes where you probably are, and rotates sites when it is confident (`ROTATE 78% sure you are on B`).
2. **Learning you** (`server/brain.ts`). After each match it saves `data/brains/<name>.json`: which sites you attack and defend, where you stand (the belief map's prior), where you kill it from, how often you dodge its flashes.
3. **Adaptive skill**. Starts at 20 (slow, wobbly, rarely flashes). Each round you win: harder. Each round you lose: easier, a bit more than a win. Streaks make the steps bigger. The HUD shows `AI LV`.

Evidence: `npm run eval:belief` plays the AI with the belief map against itself without it (same skill, sides swapped). Last run: belief won 93 rounds to 64, and 16 of 20 matches.

### What could I have done? (in the live game's viewer)

In the replay viewer, pick a moment and press **What could I have done?** The server plays 20 different plans (hold, walk and wait, back off to cover, flash and peek, smoke and cross, dash out, wide swing, off-angle, ...) 5 times each with different random seeds, against the opponent's ghost and then their clone, in a worker thread (~10 s). You get what you actually did plus the top 3, each with how often it won the fight. Click a card to watch that future.

### Rewind from the live game (Replays & rewind in the lobby)

1. Play at least one match (vs a friend, or vs the AI). Each match is saved to `data/`.
2. In the lobby press **Replays & rewind**, pick the match, and pick **You are** (your name).
3. Click a round chip (it jumps to 5 s before that round's first kill), or drag the timeline, or click the strip.
4. Press **Rewind from here**. You control your slot from that exact tick.
5. Your opponent is a **ghost** at first: it presses exactly what they pressed. As soon as you change the fight
   (divergence score over 2.5, from both positions, both HP values and whether they can see you), a **clone** of
   that real player takes over and the trace says `HANDOFF` with the number.
6. The clone is k-nearest-neighbours (k = 7) over every recorded decision that player made in every match in `data/`.
   Each `COPY` line in the trace panel (T) cites the match and tick it copied: click it to watch that moment.
   If the situation is new to the clone (nearest recorded moment past the 95th percentile of held-out distances),
   the circuit breaker hands it to the basic bot and says `BREAKER`.
7. When the round ends you see the result and how many attempts from that moment you have won. **Try again** makes
   a new branch from the same tick. Branches are stored in `data/branches/<match>.json` and replay exactly.

No real recordings yet? `npm run demo:data` writes three matches between two scripted players, `demo-alice` and
`demo-bob`, with fixed habits. They are scripted, not people: say so if you demo with them.

### This branch's evals

```bash
npm run eval:live-clones
```

Writes `eval/results-live.md` from what is in `data/`:

1. Clone accuracy on each player's held-out (newest) match: share of decisions where the move direction and the
   fire choice match the real person, for the player's own clone, the basic bot, and a clone of someone else.
2. Rewind sessions: attempts, handoffs, and the share of clone time spent under the circuit breaker.
3. Adaptation: the adaptive AI's skill round by round, and your round win rate early vs late.

Needs 2+ matches under the same name for part 1.

## Environment

See `.env.example`. `PORT` (default 8080), `TICK_MS` (default 31.25) and `LAG_MS` (default 0) are read from the process environment by the server; nothing loads a `.env` file automatically. Under `npm run web` the client assumes the server is on port 8080; the built client uses whatever origin served it.
