# Rewind

Rewind lets you jump back into any moment of a round you lost in **Rewind Duel**, a small top-down 1v1 tactical shooter, and replay it against a clone of your real opponent built from their own recorded games. Built for DevHacks 2026 (Riot Games Track 1, Gameplay Bots).

**Status:** Phase 1 (playable two-player game with recording and replay) is done. Rewind sessions, clones, what-if plans and evals are next. See `spec.md` for the full plan and `DECISIONS.md` for design choices.

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
- **`web/`** never simulates. It sends keys and mouse, and draws what it is told. Fog of war is enforced by the server, the client only shades it.
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

The game still runs in Node on your laptop, so the laptop has to stay awake and online. Players far away will feel their own latency, since there is no client prediction (DECISIONS D10).

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

## Run a rewind / run the evals

Not built yet (Phases 2 to 5).

## Environment

See `.env.example`. `PORT` (default 8080) and `TICK_MS` (default 31.25) are read from the process environment by the server; nothing loads a `.env` file automatically. Under `npm run web` the client assumes the server is on port 8080; the built client uses whatever origin served it.
