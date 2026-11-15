# Rewind ΓÇö notes for the next Claude session

Hackathon project (DevHacks 2026, hacking ends 11 AM Sunday). `spec.md` is the source of truth for scope and phases. `DECISIONS.md` logs every design choice with its tradeoff; add an entry for each new one. Phases 1 to 5 are done and the model is frozen (D47). Phase 6 is partly done: the three.js first-person view and a Unity viewer exist, and the Durable Object migration is deferred (D33).

## Hard rules (from spec.md)

- No `Math.random()` or `Date.now()` in `engine/`. `npm run check:determinism` enforces it.
- All replays, forks and sims run in Node. The browser never calls `step`. It may only predict its own movement with `applyMovement`, for display (DECISIONS D16).
- Never weaken or delete a test to make it pass. Tell Nipun why first.
- No LLM calls anywhere. Clones are k-NN.
- VALORANT names are allowed on branch valorant-ai-bot: the hackathon granted attendees permission to copy from the game (DECISIONS D66). `spec.md` rule 1 still says otherwise; the team should settle it.
- Commit after each phase. Do not claim something works unless it was run.

## Where things live

- `engine/engine.ts` ΓÇö `createMatch`, `step`, `hashState`. The order of operations inside a live tick is documented on `step` and matters for determinism: move both, timers, smokes, shots (simultaneous), deaths, spike, clock, then `lastSeen`.
- `engine/vision.ts` ΓÇö `canSee` is the single visibility rule. `observe` and `visibleEvents` are built on it. Anything a clone is allowed to know must come from `observe`, never from `State`.
- `engine/constants.ts` ΓÇö every tunable, in integer ticks.
- `engine/map.ts` ΓÇö the one map as data. Border walls sit just outside the 48x32 area so `rayWalls` is always finite.
- `engine/replay.ts` ΓÇö `replayMatch(file, untilTick)` rebuilds any tick. Rewind sessions, what-ifs and evals all fork from here.
- `server/match.ts` ΓÇö `MatchRunner`: engine plus input log, no sockets and no clock, so it is unit-testable.
- `server/index.ts` ΓÇö HTTP + WebSocket on one port: serves `web/dist` (if built) and runs rooms and the 32 Hz loop. The only place that touches wall-clock time. It may be exposed publicly through a Cloudflare Tunnel, so treat every client message as hostile (see DECISIONS D15).
- `web/main.ts` ΓÇö canvas client and DOM HUD. Input in, `Observation` out to pixels. Drawn positions chase their targets (`chase`) so 32 Hz updates look smooth.
- `web/predict.ts` ΓÇö `Predictor`: own-movement prediction from seq/ack. `server/match.ts` must apply exactly one queued input per tick or the prediction drifts (D17); `web/test/predict.test.ts` checks this against a real `MatchRunner`.
- `web/audio.ts` ΓÇö synthesized WebAudio cues, no asset files. `web/index.html` holds the palette tokens; `main.ts` repeats them as constants for the canvas.
- `server/rewind.ts` ΓÇö HTTP to list and fetch recorded matches, plus the WebSocket for rewind sessions. Mounted on the same port as the game.
- `web/replay.ts` (`/replay.html`) ΓÇö replay viewer, rewind controls and the what-if panel. `web/fpv.ts` (`/fpv.html`) is the three.js first-person view. `web/roster.html` shows who still needs games. All of them only draw server snapshots.

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

## Branch valorant-ai-bot: the live game and its AI

Merged from a branch built in parallel with Phases 2 to 6. It does not replace main's `clone/`, `rewind/` or `eval/`; it sits beside them.

- `engine/weapons.ts` — the 18 VALORANT guns, shields, economy constants. `State.rules` is 'classic' (every older recording, and the tests) or 'valorant' (new live matches); it is saved in the match file so replays stay exact (D67). `fireCooldown` is in 1/100 ticks (D68). `hashState` only adds the new fields when a state uses them, so classic recordings keep their old hashes.
- `engine/map.ts` now holds five maps (ids `duel`, `relay`, `trident`, `courtyard`, `fault`; display names Duel, Bind, Haven, Ascent, Split). `engine/nav.ts` is the navigation grid (`cachedField` is a shared bounded cache). Flashbangs, teleporters and footsteps/gunshots (`Observation.heard`) are engine rules.
- `server/persona.ts` — the opponent after a rewind handoff, in the coach's futures and in VS YOURSELF: the person's clone out of fights, the AI (at the person's rank) in fights and off known ground (D75). `eval/persona-eval.ts` measures it.
- `server/ai.ts` — the live AI (`AiPlayer`) and `BasicBot`. `server/belief.ts` is its probability map of the enemy, `server/brain.ts` what it learns about each player (`data/brains/`), `server/ranks.ts` the rank ladder.
- `ai/clone/`, `ai/rewind/` — this branch's own k-NN clone, ghost-then-clone rewind driver, match summaries, what-if planner (run in `server/whatif-worker.ts`) and coach moments. They use main's `rewind/divergence.ts`.
- `server/index.ts` serves both: main's `/api/matches`, `/api/replay`, `/api/roster`, `/api/presets` and its `rewind`/`rwinput`/`retry`/`whatif` socket messages; this branch's `/api/viewer/*`, `/api/whatif`, `/api/coach/*`, `/api/version` and `join` modes `ai`, `mirror`, `rewind`. `/api/catalog` and the `mapData` field of `start` exist for the Unity client (D70): keep them in step with any change to maps or weapons. The Unity client lives in `unity/RewindDuelLive` (its WebGL build in `Build/WebGL` is served at `/play/`, D71). Replays there read `/api/viewer/matches/:id` and take control with a `join` in mode `rewind`.
- Every replay of a recorded match must create it with `file.rules` (`createMatch(seed, map, file.rules ?? 'classic')`), or economy-rules matches rebuild differently (D72; `ai/rewind/test/rules.test.ts`).
- `eval/belief-ablation.ts`, `rank-ladder.ts`, `reads.ts`, `clone-eval.ts` — this branch's evidence (`npm run eval:belief`, `eval:ranks`, `eval:reads`, `eval:live-clones`).
- `unity/RewindDuelLive/.../DuelDemo.cs` (editor-only) records the demo video's footage; `scripts/demo-video.py` cuts it. See README "Record the demo video".
- `web/view3d.ts` — first-person three.js view inside the live game, loaded on V.

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
- `npm run botmatch` ΓÇö two scripted bots play a full match through the real server; `TICK_MS=2` on the server fast-forwards it.
- `npm run eval` (writes `eval/results.md`), `npm run whatif -- data/<id>.json <human 0|1> <forkTick>`, `npm run export:unity`
- Replay viewer: `http://localhost:8080/replay.html` after `npm run build` + `npm run server`.
