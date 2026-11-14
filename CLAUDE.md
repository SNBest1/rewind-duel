# Rewind — notes for the next Claude session

Hackathon project (DevHacks 2026, hacking ends 11 AM Sunday). `spec.md` is the source of truth for scope and phases. `DECISIONS.md` logs every design choice with its tradeoff; add an entry for each new one. Phases 1 to 5 are done and the model is frozen (D47). Phase 6 is partly done: the three.js first-person view and a Unity viewer exist, and the Durable Object migration is deferred (D33).

## Hard rules (from spec.md)

- No `Math.random()` or `Date.now()` in `engine/`. `npm run check:determinism` enforces it.
- All replays, forks and sims run in Node. The browser never calls `step`. It may only predict its own movement with `applyMovement`, for display (DECISIONS D16).
- Never weaken or delete a test to make it pass. Tell Nipun why first.
- No LLM calls anywhere. Clones are k-NN.
- No VALORANT names or assets. The game is "Rewind Duel".
- Commit after each phase. Do not claim something works unless it was run.

## Where things live

- `engine/engine.ts` — `createMatch`, `step`, `hashState`. The order of operations inside a live tick is documented on `step` and matters for determinism: move both, timers, smokes, shots (simultaneous), deaths, spike, clock, then `lastSeen`.
- `engine/vision.ts` — `canSee` is the single visibility rule. `observe` and `visibleEvents` are built on it. Anything a clone is allowed to know must come from `observe`, never from `State`.
- `engine/constants.ts` — every tunable, in integer ticks.
- `engine/map.ts` — the one map as data. Border walls sit just outside the 48x32 area so `rayWalls` is always finite.
- `engine/replay.ts` — `replayMatch(file, untilTick)` rebuilds any tick. Rewind sessions, what-ifs and evals all fork from here.
- `server/match.ts` — `MatchRunner`: engine plus input log, no sockets and no clock, so it is unit-testable.
- `server/index.ts` — HTTP + WebSocket on one port: serves `web/dist` (if built) and runs rooms and the 32 Hz loop. The only place that touches wall-clock time. It may be exposed publicly through a Cloudflare Tunnel, so treat every client message as hostile (see DECISIONS D15).
- `web/main.ts` — canvas client and DOM HUD. Input in, `Observation` out to pixels. Drawn positions chase their targets (`chase`) so 32 Hz updates look smooth.
- `web/predict.ts` — `Predictor`: own-movement prediction from seq/ack. `server/match.ts` must apply exactly one queued input per tick or the prediction drifts (D17); `web/test/predict.test.ts` checks this against a real `MatchRunner`.
- `web/audio.ts` — synthesized WebAudio cues, no asset files. `web/index.html` holds the palette tokens; `main.ts` repeats them as constants for the canvas.
- `server/rewind.ts` — HTTP to list and fetch recorded matches, plus the WebSocket for rewind sessions. Mounted on the same port as the game.
- `web/replay.ts` (`/replay.html`) — replay viewer, rewind controls and the what-if panel. `web/fpv.ts` (`/fpv.html`) is the three.js first-person view. `web/roster.html` shows who still needs games. All of them only draw server snapshots.

### Clones (`clone/`)

- `features.ts` builds feature vectors from an `Observation` only (D8, D21). `actions.ts` maps a raw `Input` to a small discrete Action and back, relative to the current situation (D20).
- `dataset.ts` turns matches into samples, one every 4 ticks, each with a `TraceRef` to its match and tick. `knn.ts` is the joint k-NN clone; `factored.ts` (the one in use, D41) runs separate move, aim and fire votes over the same neighbors.
- `guarded.ts` is the circuit breaker: when the nearest neighbor is past the limit (p95 on held-out data, D22), `bot.ts` (the hand-written basic bot) takes over. `build.ts` builds a guarded clone for one player with matches held out.
- `holding.ts`: the live paths (rewind, what-if) step every tick, so they must wrap the clone in `HoldingPolicy` to decide once every 4 ticks and hold. Without it, fire decisions never persist (D44).
- `majority.ts` is the most-common-action baseline for the evals.

### Rewind (`rewind/`)

- `session.ts` runs a rewind on the server. The opponent replays recorded inputs (ghost) until `divergence.ts`'s score passes `DIVERGENCE_LIMIT` (2.5 map units, D19), then the clone takes over. Each retry is a stored branch, and the opponent's clone holds out this very match (D25).
- `snapshot.ts` and `timeline.ts` build both-sides snapshots and markers for the replay viewer. Only post-match views use them; live fog never does (D24).
- `whatif.ts` and `plans.ts` run each scripted micro-plan five times from the fork against the guarded clone and rank the results (D26, D27). `whatif-run.ts` puts this in a worker thread (`whatif-worker.ts`, loaded under tsx) and falls back to running inline (D28). `presets.ts` names fixed demo forks (D46).

### Evals (`eval/`)

- `run.ts` writes `eval/results.md`. Human matches are the result and bot matches are only a sanity check; fixtures and self-matches are dropped (D34, D39).
- `metrics.ts` implements the definitions locked in `eval/METRICS.md`, which `metrics-doc.ts` generates. Do not change a definition without renaming the metric (D40). The confidence intervals resample by round, not tick (D45).
- `learning-curve.ts`, `transfer.ts` and `whatif-audit.ts` are the extra evidence sections.

### Unity (`unity/RewindDuel3D`)

- A renderer of JSON exported by `scripts/export-unity.ts`. It has no game logic (D48). See `unity/README.md`. The Editor rewrites `Packages/` and `ProjectSettings/` when it opens the project, so check those diffs before committing them.

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
- `npm run eval` (writes `eval/results.md`), `npm run whatif -- data/<id>.json <human 0|1> <forkTick>`, `npm run export:unity`
- Replay viewer: `http://localhost:8080/replay.html` after `npm run build` + `npm run server`.
