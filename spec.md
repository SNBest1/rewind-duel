# Build Rewind

You are building Rewind with me at a 24 hour hackathon (DevHacks 2026, Riot Games Track 1, Gameplay Bots). Hacking ends 11 AM Sunday. I am Nipun. I know TypeScript, Python and Node well. Work fast, but every phase has to actually run and pass its checks before you move on. Do not tell me something works unless you ran it.

## What Rewind is

Two people play a small top-down 1v1 tactical shooter inspired by games like VALORANT. The server records every input on every tick. Later a player can jump back to any moment of a round they lost and take control. The opponent first replays exactly what they did, then hands off to a clone of that real person built from their own recorded games. The clone only knows what that person could see. If the clone meets a situation it has never seen, a circuit breaker hands control to a simple bot and says so. The tool also tries about 20 alternative plans from that moment and shows the top 3 that would have won. Every bot decision is written to a behavior trace that cites the past moment it copied.

The judge will grade on a real player need, an original solution, and evidence such as comparisons against a simpler bot. He will also ask us to explain our architecture, tradeoffs and failure modes, so keep the code simple and readable.

## Hard rules

1. Use no VALORANT names, agents, maps, logos, sounds or art. The game is called Rewind Duel. Use plain shapes and colors.
2. The engine must be deterministic. No `Math.random()` and no `Date.now()` anywhere in `engine/`. Use a seeded RNG (mulberry32). Use a fixed tick. Add a script `npm run check:determinism` that fails if either call appears in `engine/`.
3. Run all replays, forks and simulations in Node, the same runtime that ran the live match.
4. Never weaken or delete a test to make it pass. If a test is wrong, tell me why before changing it.
5. Do not call any paid LLM API. There is no LLM in the decision loop. Clones are k-nearest neighbors.
6. Commit after each phase with a clear message.
7. Keep a `DECISIONS.md` file. Add one short entry per real design choice, with the tradeoff and what we ruled out. I will use it in Q&A.
8. Keep `README.md` current with how to install, run a match, run a rewind and run the evals.

## Stack

- npm workspaces monorepo, TypeScript strict, Node 20 or newer, `tsx` to run TS in Node, `vitest` for tests
- `engine/` pure TS with no dependencies, shared by everything
- `server/` Node with the `ws` package, runs matches and rewind sessions, writes match files
- `web/` Vite plus HTML canvas client
- `clone/`, `rewind/`, `eval/` Node packages that import `engine/`
- `data/` recorded matches as JSON files

## The game (Rewind Duel)

| Part | Rule |
| --- | --- |
| Tick | 32 ticks per second, fixed |
| Map | One map, 48 by 32 units. Walls are axis-aligned rectangles. Two sites, A and B, as rectangles. A mid lane. Attacker spawn on the left, defender spawn on the right. Make corners worth holding. Define it in `engine/map.ts` as data. |
| Player | Circle with radius 0.4. Run speed 5 units per second, walk speed 2.5 with Shift. Collides with walls. 100 HP. |
| Rifle | Hitscan. Click to fire, max 4 shots per second. 25 damage. 10 round magazine. R reloads in 2 seconds. Bullets stop at walls. |
| Moving inaccuracy | Spread is about 1 degree standing still, 4 degrees walking and 10 degrees running. Pick the actual offset with the seeded RNG. |
| Smoke (Q) | Places a circle of radius 2.5 at the aim point, up to 8 units away. Lasts 8 seconds. Blocks vision, not bullets. Once per round. |
| Dash (E) | Moves 4 units in the move direction over 0.2 seconds and stops at walls. Once per round. |
| Vision | A player sees an enemy only if the enemy is inside a 100 degree cone around the aim direction within 30 units, or within 3 units in any direction. Walls and smokes block line of sight. |
| Spike | Attacker holds F for 2 seconds inside a site while standing still to plant. After planting, it detonates after 30 seconds. Defender holds F for 4 seconds near it to defuse. |
| Round | 60 seconds to plant. A kill ends the round. Attacker wins on a kill or a detonation. Defender wins on a kill, a defuse, or time running out with no plant. |
| Match | First to 5 rounds. Sides swap after round 4. |

## Core API

```ts
export type Input = {
  move: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  walk: boolean; aim: number; fire: boolean; reload: boolean;
  smoke: boolean; dash: boolean; use: boolean;
};
export function createMatch(seed: number, mapId: string): State;
export function step(s: State, inputs: [Input, Input]): { next: State; events: GameEvent[] };
export function observe(s: State, slot: 0 | 1): Observation; // only what that player can see, plus last seen enemy position and how long ago
export function hashState(s: State): string; // FNV-1a over quantized state
export type MatchFile = {
  id: string; seed: number; map: string;
  players: { slot: 0 | 1; name: string }[];
  inputs: { tick: number; slot: 0 | 1; input: Input }[];
  finalHash: string;
};
```

`observe` matters most. The server uses it to decide what to send each player, and the clones use it to decide what they are allowed to know. A client must never receive the enemy position when the enemy is not visible.

## Phase 1. Playable two-player game (top priority, needed by 3 PM)

Build the engine, the server and the web client so two people on two laptops on the same wifi can play a full match.

- Server is authoritative. Each client sends its latest input every tick. The server runs a fixed-step loop at 32 ticks per second, steps the engine, and sends each player its own `observe` snapshot. Log each input with the server tick it took effect on.
- Players join with a name and a room code. When both slots are filled the match starts.
- When a match ends or a player disconnects, write `data/<id>.json` with the match file and final hash.
- Client draws top-down with fog of war (darken what you cannot see), the HUD (HP, ammo, reload, round, timer, score, ability charges, spike state) and simple hit and kill feedback.
- Add `npm run replay -- data/<id>.json`. It rebuilds the match from the seed and inputs and prints whether the final hash matches.

Phase 1 is done when
- Two browser tabs can play a full match to 5 rounds
- `vitest` covers movement and wall collision, hit and miss, spread by movement state, vision through walls and smokes, plant, defuse and round end
- A test runs a scripted 2 minute match twice and gets the same hash, and `npm run replay` matches the live hash on a real recorded match
- `npm run check:determinism` passes

Stop and tell me when Phase 1 is done so I can start collecting games, then continue.

## Phase 2. Rewind sessions

- A replay viewer in the web client. Load a match file, scrub a timeline with kills, plants and round starts marked, and show both players with an option to show each player's vision.
- "Take control from here" opens a rewind session that runs on the Node server. The server rebuilds the state at that tick, the human controls their own slot, and the other slot is driven by a `Policy`.
- Ghost mode first. The opponent replays its recorded inputs while the divergence score stays under a limit. The score is built from both positions, both HP values and whether the opponent can see the human. Once over the limit, hand off to the clone and log a `HANDOFF` trace event with the number that crossed the limit.
- Each retry from the same tick is a branch. Store branches and their outcomes.

## Phase 3. Clones

- Feature extraction from `observe` only. Use own position, HP, ammo, ability charges, side, round time left and spike state. Add the enemy position relative to you if visible, otherwise the last seen position and seconds since. Add distance to the nearest wall in 8 directions, the current zone (A, B, mid, spawn), and the previous action. Normalize everything to roughly 0 to 1.
- Actions are 9 move options, walk or run, an aim offset relative to the enemy direction in a few buckets, fire or not, smoke, dash and use.
- Sample one decision every 4 ticks. The policy holds its action between decisions.

```ts
export interface Policy {
  name: string;
  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] };
}
```

- `KnnClone` uses k = 7 with a distance-weighted vote over one player's recorded decisions, and `because` points to the match and tick of the neighbors.
- `BasicBot` is a hand-written fallback that holds an angle, peeks and shoots when the enemy is visible, and plants or defuses on its side.
- `GuardedClone` wraps the clone with a circuit breaker. If the nearest neighbor distance passes the limit, use `BasicBot` and log a `BREAKER` trace event. The limit is the 95th percentile of nearest neighbor distances on held-out data.
- `buildClone(playerName, { holdOut })` builds from every match of that player except the held-out ones.
- The trace panel in the web client shows every line as tick, actor, event type and reason. Clicking a CLONE line plays the copied past moment beside the current one.

## Phase 4. What you could have done

- From the fork tick, simulate about 20 scripted micro-plans for the human side, 3 seconds each, against the guarded clone. Examples are stop then shoot, back off to the nearest corner and hold, smoke the angle then cross, dash out of the line of fire, and walk silently and wait.
- Run each plan 5 times with different seeds. Rank by survival and fight wins. Show the top 3 as short replays with a one-line reason built from the events.
- Run this in a Node worker thread so it does not block live sessions.

## Phase 5. Evidence

Scripts in `eval/` write `eval/results.md`.

- Clone accuracy on each player's held-out match. Report the share of decisions where move direction and fire choice match the real person, for three policies. Those are the player's own clone, the basic bot, and a clone of a different player.
- Position error. Start from held-out moments, run 1 second, and measure the distance to where the real person went, for the same three policies.
- Handoff rate. The share of rewind time spent under the circuit breaker.
- Transfer test helper. Log each person's first attempt at a lost fight, their retries, and a fresh attempt at the same situation, then summarize.
- Report the real numbers even if they are weak.

## Phase 6. Stretch, only after Phase 5

- A first-person view in three.js that renders the same 2D simulation, with walls extruded and the camera at the player's position facing the aim angle. Logic stays 2D.
- Sound ripples when running.
- Moving the server to a Cloudflare Durable Object.

## How I want you to work

- Start with Phase 1 and get to a playable match as fast as possible. Ugly is fine. Polish later.
- After each phase, run the tests and the checks, show me the output, and list anything that is fake, stubbed or not yet verified.
- If something in this spec is unclear or will not work, say so and suggest the simplest fix instead of guessing.