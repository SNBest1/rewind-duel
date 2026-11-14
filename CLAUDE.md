# Rewind — notes for the next Claude session

Hackathon project (DevHacks 2026, hacking ends 11 AM Sunday). `spec.md` is the source of truth for scope and phases. `DECISIONS.md` logs every design choice with its tradeoff; add an entry for each new one. Phases 1 to 5 are built; phase 6 has the 3D view and footsteps. See README "Status".

## Hard rules (from spec.md)

- No `Math.random()` or `Date.now()` in `engine/`. `npm run check:determinism` enforces it.
- All replays, forks and sims run in Node. The browser never calls `step`. It may only predict its own movement with `applyMovement`, for display (DECISIONS D16).
- Never weaken or delete a test to make it pass. Tell Nipun why first.
- No LLM calls anywhere. Clones are k-NN.
- VALORANT names are now allowed: the hackathon granted attendees permission to copy from the game (DECISIONS D36). `spec.md` rule 1 still says otherwise; the team should update it.
- Commit after each phase. Do not claim something works unless it was run.

## Added since phase 1

- `engine/weapons.ts` — the 18 VALORANT guns, shields, economy constants. `State.rules` is 'classic' (old matches, tests) or 'valorant' (all new live matches); it is saved in the match file so replays stay exact (D37). `fireCooldown` is in 1/100 ticks (D38).
- `engine/nav.ts` — navigation grid and distance fields (`cachedField` is a shared bounded cache).
- `server/ai.ts` — the AI (`AiPlayer`), `BasicBot` (the clone's fallback), ranks via `difficulty`. `server/belief.ts` is its probability map of the enemy; `server/brain.ts` what it learns about each player; `server/ranks.ts` the rank ladder.
- `clone/` — k-NN clone (`knn.ts`), features from `observe()` only (`features.ts`), `GuardedClone` circuit breaker.
- `rewind/` — rewind sessions (ghost, then clone), divergence, match summaries for the viewer, the what-if planner and coach moments. The planner runs in `server/whatif-worker.ts`.
- `eval/` — evidence scripts: `npm run eval`, `eval:belief`, `eval:ranks`, `eval:reads`.
- `web/view3d.ts` — first-person three.js view, loaded on V. It only draws; logic stays 2D.

## Where things live

- `engine/engine.ts` — `createMatch`, `step`, `hashState`. The order of operations inside a live tick is documented on `step` and matters for determinism: move both, timers, smokes, shots (simultaneous), deaths, spike, clock, then `lastSeen`.
- `engine/vision.ts` — `canSee` is the single visibility rule. `observe` and `visibleEvents` are built on it. Anything a clone is allowed to know must come from `observe`, never from `State`.
- `engine/constants.ts` — every tunable, in integer ticks.
- `engine/map.ts` — the one map as data. Border walls sit just outside the 48x32 area so `rayWalls` is always finite.
- `engine/replay.ts` — `replayMatch(file, untilTick)` rebuilds any tick. Phase 2 rewinds start here.
- `server/match.ts` — `MatchRunner`: engine plus input log, no sockets and no clock, so it is unit-testable.
- `server/index.ts` — HTTP + WebSocket on one port: serves `web/dist` (if built) and runs rooms and the 32 Hz loop. The only place that touches wall-clock time. It may be exposed publicly through a Cloudflare Tunnel, so treat every client message as hostile (see DECISIONS D15).
- `web/main.ts` — canvas client and DOM HUD. Input in, `Observation` out to pixels. Drawn positions chase their targets (`chase`) so 32 Hz updates look smooth.
- `web/predict.ts` — `Predictor`: own-movement prediction from seq/ack. `server/match.ts` must apply exactly one queued input per tick or the prediction drifts (D17); `web/test/predict.test.ts` checks this against a real `MatchRunner`.
- `web/audio.ts` — synthesized WebAudio cues, no asset files. `web/index.html` holds the palette tokens; `main.ts` repeats them as constants for the canvas.

## Non-obvious things

- `State` is plain JSON-safe data and `step` never mutates its argument. Tests set up scenarios by teleporting players on a fresh `createMatch` state.
- Match files are **delta-encoded**: an input entry means "from this tick on". Do not assume one entry per tick.
- `State.rng` is part of the state and of the hash. To re-run a fork with different luck, change `state.rng` only.
- `Input` has no aim distance, so smokes land at max range along the aim (DECISIONS D6).
- Workspace packages point `main` at TypeScript source (`engine/index.ts`); there is no build step. `tsx` runs Node code, Vite serves the client.
- Editing anything under `web/` hot-reloads the page and drops a live match (a disconnect ends the match).

## Commands

- `npm run server` (http + ws on 8080), `npm run web` (Vite on 5173, dev only), `npm run build` (client into `web/dist`, which the server serves)
- Public URL: `cloudflared tunnel --url http://localhost:8080` after build + server. The client picks its WebSocket URL from the page origin unless it is on port 5173.
- `npm test`, `npm run typecheck`, `npm run check:determinism`
- `npm run replay -- data/<id>.json`
- `LAG_MS=60 npm run server` fakes a 120 ms round trip to test prediction.
- `npm run botmatch` — two scripted bots play a full match through the real server; `TICK_MS=2` on the server fast-forwards it.
