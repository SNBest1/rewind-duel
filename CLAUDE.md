# Rewind — notes for the next Claude session

Hackathon project (DevHacks 2026, hacking ends 11 AM Sunday). `spec.md` is the source of truth for scope and phases. `DECISIONS.md` logs every design choice with its tradeoff; add an entry for each new one. Phase 1 is done; Phases 2 to 6 are not started.

## Hard rules (from spec.md)

- No `Math.random()` or `Date.now()` in `engine/`. `npm run check:determinism` enforces it.
- All replays, forks and sims run in Node. The browser never calls `step`.
- Never weaken or delete a test to make it pass. Tell Nipun why first.
- No LLM calls anywhere. Clones are k-NN.
- No VALORANT names or assets. The game is "Rewind Duel".
- Commit after each phase. Do not claim something works unless it was run.

## Where things live

- `engine/engine.ts` — `createMatch`, `step`, `hashState`. The order of operations inside a live tick is documented on `step` and matters for determinism: move both, timers, smokes, shots (simultaneous), deaths, spike, clock, then `lastSeen`.
- `engine/vision.ts` — `canSee` is the single visibility rule. `observe` and `visibleEvents` are built on it. Anything a clone is allowed to know must come from `observe`, never from `State`.
- `engine/constants.ts` — every tunable, in integer ticks.
- `engine/map.ts` — the one map as data. Border walls sit just outside the 48x32 area so `rayWalls` is always finite.
- `engine/replay.ts` — `replayMatch(file, untilTick)` rebuilds any tick. Phase 2 rewinds start here.
- `server/match.ts` — `MatchRunner`: engine plus input log, no sockets and no clock, so it is unit-testable.
- `server/index.ts` — WebSocket rooms and the 32 Hz loop. The only place that touches wall-clock time.
- `web/main.ts` — canvas client. Input in, `Observation` out to pixels.

## Non-obvious things

- `State` is plain JSON-safe data and `step` never mutates its argument. Tests set up scenarios by teleporting players on a fresh `createMatch` state.
- Match files are **delta-encoded**: an input entry means "from this tick on". Do not assume one entry per tick.
- `State.rng` is part of the state and of the hash. To re-run a fork with different luck, change `state.rng` only.
- `Input` has no aim distance, so smokes land at max range along the aim (DECISIONS D6).
- Workspace packages point `main` at TypeScript source (`engine/index.ts`); there is no build step. `tsx` runs Node code, Vite serves the client.
- Editing anything under `web/` hot-reloads the page and drops a live match (a disconnect ends the match).

## Commands

- `npm run server` (ws on 8080), `npm run web` (Vite on 5173)
- `npm test`, `npm run typecheck`, `npm run check:determinism`
- `npm run replay -- data/<id>.json`
- `npm run botmatch` — two scripted bots play a full match through the real server; `TICK_MS=2` on the server fast-forwards it.
