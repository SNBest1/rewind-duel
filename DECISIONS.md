# Decisions

One entry per real design choice: what we chose, the tradeoff, what we ruled out.

## Phase 1

### D1. All durations are integer ticks, not seconds
- **Chose:** reload = 64 ticks, smoke = 256 ticks, fuse = 960 ticks, and so on (`engine/constants.ts`).
- **Why:** adding `1/32` each tick accumulates float error, and "has 2.0 s passed" can flip a tick early or late. Integers cannot drift.
- **Tradeoff:** the dash is 6 ticks (0.1875 s), not the spec's 0.2 s (6.4 ticks). It still covers exactly 4 units.
- **Ruled out:** float timers with an epsilon. Works until it does not, and the failure is a silent replay mismatch.

### D2. RNG state lives inside `State`
- **Chose:** `State.rng` holds the mulberry32 state; `step` advances it only when a shot needs spread.
- **Why:** a state rebuilt at tick N carries its own random future, so a rewind fork needs nothing but the state. Phase 4 can run one plan under 5 seeds by overwriting one number.
- **Tradeoff:** the hash covers the RNG, so two states that look identical but have different RNG positions hash differently. That is what we want for replay checks.
- **Ruled out:** a module-level RNG object. Forks and parallel sims would share and corrupt it.

### D3. `step` is pure and copies the state
- **Chose:** `step` clones the (small) state, mutates the clone, returns it. A test asserts the input state is untouched.
- **Why:** rewind branches and what-if sims keep many states alive at once. Shared mutation would be the worst kind of bug to find at 4 AM.
- **Tradeoff:** one small allocation per tick. A full 2 minute match (3840 ticks) still steps in a few milliseconds.
- **Ruled out:** in-place mutation with an explicit `clone()` the caller must remember.

### D4. Fire is level-triggered: hold to shoot at 4 shots/s
- **Chose:** `input.fire === true` fires whenever the 8-tick cooldown is clear.
- **Why:** inputs are sampled once per tick and clones hold an action for 4 ticks. With edge-triggered "click" semantics a held action would fire once and never again, and a click shorter than a tick could be lost.
- **Tradeoff:** not strictly "one click, one shot". The cap is the same, so time-to-kill is identical.
- **Ruled out:** tracking the previous tick's fire bit in the state.

### D5. Both shots in a tick resolve simultaneously; a trade goes to "what would happen with nobody left"
- **Chose:** both rays are traced against post-movement positions, then damage lands. If both die: planted spike means attacker wins (it would detonate), otherwise defender wins (time would run out).
- **Why:** resolving slot 0 first would hand slot 0 every same-tick duel, and clones trained on that data would inherit the bias.
- **Tradeoff:** a trade is possible, which the spec does not mention.
- **Ruled out:** slot-order resolution; coin flip by RNG (unexplainable to a player).

### D6. Smoke lands at max range along the aim, shortened by walls
- **Chose:** the smoke centre is 8 units along the aim direction, or at the first wall if nearer.
- **Why:** the spec says "at the aim point" but `Input` has only an aim angle, no distance. Keeping `Input` exactly as specified matters more: it is the recorded format and the clone's action space.
- **Tradeoff:** you cannot drop a smoke at your feet in the open.
- **Ruled out:** adding `aimDist` to `Input` (one more continuous dimension for the clone to learn).

### D7. Move state comes from intent, not displacement
- **Chose:** spread uses still / walk / run from the input, so running into a wall still counts as running.
- **Why:** one rule, no threshold on "how far did you actually move".
- **Tradeoff:** pressing into a wall makes you inaccurate even though you are stationary.

### D8. One visibility function, `canSee`, used by everything
- **Chose:** `observe`, `visibleEvents`, `lastSeen` and (later) the clones all go through `canSee`. Line of sight is centre to centre.
- **Why:** if the server fog and the clone's knowledge used different rules, the clone could act on something the real player never saw, and the "clone only knows what the person could see" claim would be false.
- **Tradeoff:** centre-to-centre means an enemy half out from a corner is invisible until their centre clears it (pop-in).
- **Ruled out:** multi-ray body visibility. More code, and the pop-in is the same for both players.

### D9. What the fog does and does not hide
- **Hidden:** enemy position, aim and HP when not visible; enemy shot tracers and dashes when not visible (unless the shot hit you).
- **Not hidden:** all smokes, the planted spike's position and timer, the score and clock.
- **Why:** smokes and the spike are large, loud, shared facts in this genre. Filtering events matters because a tracer starts at the shooter's position.
- **Tradeoff:** a smoke appearing does reveal that the enemy used it and roughly where they aimed.

### D10. The server is authoritative and the client never simulates
- **Chose:** the client sends its latest input 32 times a second and draws the `Observation` it gets back. No client prediction.
- **Why:** on one wifi the round trip is a few ms, and prediction would mean running the engine in the browser, which breaks hard rule 3 (one runtime for all simulation).
- **Tradeoff:** own movement is delayed by the round trip plus up to one tick. Fine on a LAN, bad over the internet.
- **Ruled out:** prediction and reconciliation.

### D11. Match files store input changes, not one row per tick
- **Chose:** an entry is written only when a slot's input differs from its previous one, stamped with the server tick it first applied on. `MatchFile` gained a `ticks` field.
- **Why:** it is the same information at a fraction of the size, and `ticks` is needed because a match can end on a disconnect, with idle ticks after the last change.
- **Tradeoff:** to read the input at tick N you scan forward from the start (`replayMatch` does this anyway).
- **Ruled out:** per-tick rows (several MB per match); keyframe snapshots (not needed while a full replay takes milliseconds).

### D12. The hash is FNV-1a over state quantized to 1/1000
- **Chose:** every field of `State` is turned into an integer and fed to 32-bit FNV-1a.
- **Why:** it is a cheap divergence detector for replays, as the spec asks.
- **Tradeoff:** 32 bits is not collision-proof, and the hash only proves determinism within one runtime. We rely on rule 3 (all sims in Node) rather than on cross-engine identical `Math.sin`.

### D13. No client-side lobby, reconnect or spectators
- **Chose:** a room is two sockets. A disconnect ends the match and writes the file.
- **Why:** the spec requires the file on disconnect, and reconnect logic is hours we do not have.
- **Tradeoff:** a dropped wifi packet storm ends the match. The partial match is still saved and replayable.

### D14. Public hosting is a Cloudflare Tunnel to the Node server, not a Durable Object
- **Chose:** the Node server serves the built client and the WebSocket on one port; `cloudflared tunnel --url http://localhost:8080` gives it a public HTTPS URL.
- **Why:** it took minutes, and the simulation stays in Node, so hard rule 3 (replays and forks run in the runtime that ran the live match) still holds and match files still land in `data/` for the clones.
- **Tradeoff:** the laptop is the server. It must stay awake, the URL changes on every restart, and remote players get their full round trip as input delay.
- **Ruled out for now:** a Durable Object (spec Phase 6). It moves the engine to a different runtime and needs new storage for match files, so it waits until the evidence phases are done.

### D15. What changed when the server became reachable from the internet
- **Chose:** room codes must match `[a-z0-9-]{1,16}` (the code is part of the match file name), WebSocket messages are capped at 1 KB, at most 50 rooms are open at once, and static files are served from an in-memory map of the build output by exact path.
- **Why:** before this, a room code like `../../x` would have written a file outside `data/`. That was harmless on a trusted LAN and is not on a public URL.
- **Tradeoff:** no accounts and no rate limiting. Anyone with the URL can fill rooms and write match files to disk until the 50-room cap; fine for a demo, not for leaving up.

## Design and feel pass

### D16. The client predicts its own movement, for display only (replaces D10's "no prediction")
- **Chose:** the engine's movement rule is exported as `applyMovement` (it reads and writes only position and dash fields). The browser runs it on inputs the server has not acknowledged yet and draws you there. Every input carries a sequence number; each observation carries the number of the input applied (`ack`). On each observation the prediction is rebuilt from the server's position plus the unacknowledged inputs (`web/predict.ts`).
- **Why:** over the tunnel, players were feeling the full round trip on every keypress. With 120 ms of round trip your dot now moves within one frame and one send tick of the key.
- **Why it keeps hard rule 3:** nothing the browser computes is sent, logged or replayed. The match of record, replays and every future fork still run in Node. The browser still never calls `step`, and only predicts movement: shots, damage, smokes, plant and the enemy are all exactly what the server says.
- **Tradeoff:** your vision cone is drawn from the predicted position, so it can run a few ticks ahead of the server's visibility check. For that moment the fog looks open where the enemy is still hidden.
- **Ruled out:** predicting shots or hits (the server would have to roll back a kill, which feels worse than delay); running full `step` in the browser (needs the enemy's state, which the client is not allowed to know).

### D17. The server applies inputs one per tick from a short queue
- **Chose:** each slot's inputs queue on arrival and one is applied per tick. With nothing new the last input stays in force. If more than 2 are waiting the oldest are dropped.
- **Why:** prediction assumes one input equals one tick. With "latest wins", two inputs arriving in the same tick meant one was never applied, and the prediction visibly snapped back. In the browser at 120 ms round trip, that showed up as several backward jumps per second of running; with the queue there were none in 4 runs. `web/test/predict.test.ts` covers bunched arrival.
- **Tradeoff:** a queued input adds up to one tick (31 ms) of delay. A dropped input can lose a single-tick press when the network bursts badly.
- **Ruled out:** an unbounded queue (a burst becomes permanent lag); a cap of 4 (in the browser, the lag readout settled about 60 ms higher).

### D18. The game rules did not change in the design pass
- **Chose:** every gameplay improvement is in what the client shows and plays: a crosshair whose gap is the real spread for how you are moving, a direction marker towards whoever hit you, reload and plant/defuse rings, the last-seen marker with its age, the defuse range, a spike beep that speeds up, and synthesized sound cues panned left or right.
- **Why:** recordings, tests and the clones planned for Phase 3 all depend on the rules. Changing them now would cost more than it gains.
- **Tradeoff:** the client only reveals what the server already sent it. Sound plays only for events this player is allowed to see, so there are no footsteps.
- **Open:** audible footsteps (a running enemy within some range is "heard") would make walking matter beyond accuracy. It needs an engine change to `observe`, and it would change the fog-leak test's property, so it waits for a decision.

## Phase 2 and 3

### D19. The divergence score adds position drift, HP drift and a visibility flip, all in map units
- **Chose:** `divergenceScore` = sum over both players of distance from the recorded position, plus sum of HP difference / 25, plus 2 if the opponent's sightline onto the human flipped vs the recording (`rewind/divergence.ts`). Limit 2.5.
- **Why:** the three things the spec lists are on different scales, so each is converted to "map units": one bullet of HP (25) is worth ~1 unit, and a sightline flip is worth 2 because the recorded inputs were an answer to the old sightline and are now stale.
- **Tradeoff:** the weights are hand-picked, not learned. They are readable and defensible in Q&A, which matters more here than being optimal.
- **Ruled out:** a learned metric (no labels for "diverged"); normalizing by map diagonal (makes the number abstract and hard to explain).

### D20. The clone copies a small discrete Action, not a raw Input
- **Chose:** a decision is `{ move: 0..8, walk, aimBucket: 0..4, fire, smoke, dash, use }` (`clone/actions.ts`). The aim is stored as an offset from the enemy direction, in a few buckets, and rebuilt relative to the current enemy direction on replay.
- **Why:** k neighbors come from different moments facing different ways. A relative, bucketed aim lets a decision recorded facing north be reused facing east, so neighbors actually combine instead of averaging to a meaningless angle.
- **Tradeoff:** the clone cannot aim at a precise absolute angle, only at the enemy plus a coarse offset. With no enemy it holds its current aim.
- **Ruled out:** copying the raw `Input.aim` (absolute angles from different moments average to nonsense); a continuous aim regression (that is a model, and the spec says clones are KNN).

### D21. Features come only from `observe`, and the clone votes over k=7 distance-weighted neighbors
- **Chose:** `extractFeatures` reads an `Observation` and nothing else (own state, visible-or-last-seen enemy relative position, 8 wall distances, zone one-hot, previous action). `KnnClone` takes the 7 nearest recorded moments and votes on an action weighted by `1/(dist+eps)` (`clone/features.ts`, `clone/knn.ts`).
- **Why:** hard rule 5 — no LLM, clones are KNN. Building features from `observe` is what makes "the clone only knows what the person could see" true by construction, not by discipline (DECISIONS D8).
- **Tradeoff:** a flat scan of a few thousand samples per decision. At 32 ticks/s sampling every 4 ticks that is 8 lookups/s per clone, fast enough; a kd-tree would help only at much larger data.
- **Ruled out:** a trained classifier (not KNN, and a black box in Q&A); features that peek at the full `State` (would cheat the fog).

### D22. The circuit-breaker limit is the p95 of nearest-neighbor distances on held-out data
- **Chose:** `buildClone(name, { holdOut })` trains on every match of that player except the held-out ids, then sets the breaker to the 95th percentile of nearest-neighbor distances measured while replaying the held-out matches (`clone/build.ts`). Over the limit, `GuardedClone` hands off to `BasicBot` and logs a `BREAKER` line; under it, a `CLONE` line cites the neighbors.
- **Why:** it is the spec's definition, and it is self-calibrating: a player with varied play has a looser limit than a repetitive one, measured on data the clone never saw so it reflects genuinely novel situations.
- **Tradeoff:** needs at least one held-out match to be meaningful; with none held out it falls back to the p95 of the training data itself (tighter, but still a sane default for a standalone clone).
- **Ruled out:** a fixed distance limit (meaningless across players and feature scalings); a confidence threshold on the vote (confidence can be high on a lone far neighbor, which is exactly the case the breaker must catch).

## Phase 2 (rewind sessions, continued)

### D23. The rewind session runs on the server; the browser never simulates it
- **Chose:** `openSession` rebuilds the fork state in Node, drives the opponent (ghost -> clone), and streams back the human's fogged `Observation` plus a both-sides snapshot and the trace (`server/rewind.ts`, `server/index.ts`). The replay viewer draws snapshots fetched from `/api/replay`; the rewind draws the server's observation. A rewind tick is a clean WebSocket round trip, no client prediction.
- **Why:** hard rule 3 — every replay, fork and sim runs in the runtime that ran the live match. Running the fork in the browser would need the enemy's full state (which the fog forbids) and a second engine.
- **Tradeoff:** a rewind tick costs one round trip of input delay, unlike the live game which predicts own movement. Acceptable: a rewind is a deliberate, slow "what if", not a reflex duel.
- **Ruled out:** predicting the rewind in the browser (breaks rule 3, needs enemy state).

### D24. The replay viewer may see both sides; live fog is untouched
- **Chose:** `buildSnapshots` exposes both players' positions for the replay viewer, and the rewind stream includes the opponent's position. The live server's `observe` fog is unchanged.
- **Why:** a replay is the player reviewing their own finished match after the fact — hiding the enemy from a post-match review would make it useless. The clone still only ever acts on `observe` (D21), so "the clone only knows what the person could see" stays true even though the viewer shows everything.
- **Tradeoff:** the both-sides snapshot is a separate, wider payload than a live `Observation`. Only the replay/rewind path uses it, never a live match.

### D25. Each retry from the fork is a stored branch; the opponent clone holds out this very match
- **Chose:** `RewindSession.endBranch()` records the outcome (winner, whether the human won, the handoff tick, the full trace) and resets to the fork for another attempt. `openSession` builds the opponent's clone from all of their matches except the one being relived, when they have more than one.
- **Why:** the branches are the raw material for the Phase 4 "what you could have done" and the Phase 5 transfer test. Holding out the relived match stops the clone from simply replaying the exact game back at the player.
- **Tradeoff:** a player with only one recorded match gets a clone trained on that match (no hold-out available), so its first branch can look suspiciously like the recording until the human diverges.

## Phase 4 (what you could have done)

### D26. Micro-plans are scripted named policies, not a search
- **Chose:** about twenty hand-written plans (`rewind/plans.ts`), each a tiny function from the human's `Observation` to an `Input`: stop-and-shoot, back off to the nearest cover corner and hold or trade, smoke the angle then cross, dash out of the line four ways, walk quiet and hold an angle, rush the last-seen, fall back and reload. Each has a readable label.
- **Why:** the spec names these exact ideas, and the point is advice a human can act on ("back off to cover and wait"), not an opaque optimum. Scripted plans also run in milliseconds, so 20 plans × 5 seeds is cheap.
- **Tradeoff:** the plans are a fixed menu, so the tool can only suggest what is on it. A plan that would have worked but is not scripted is never found.
- **Ruled out:** a tree search or RL rollout over the raw action space (slow, and the result is not nameable advice); using the clone of the human as the plan (that is "what you did", not "what you could have done").

### D27. Rank by fight wins first, survival second, with shots landed as a tiebreak
- **Chose:** each plan runs 5 times from the fork under different seeds (overwriting `State.rng`, D2) for 3 seconds against the opponent's guarded clone. `score = winRate + 0.3·survivalRate + 0.02·avgShotsLanded` (`rewind/whatif.ts`). The top 3 come back with a one-line reason read off the events ("won the fight every time, landing 3.0 shots").
- **Why:** winning the duel is the goal; surviving without the kill is second best; shots landed separates two plans that both merely survive. Five seeds smooth out a single lucky spread roll without being slow.
- **Tradeoff:** 3 seconds and 5 runs are short and few, so a plan whose payoff comes later (a slow rotate) is undervalued. The weights are hand-picked for readability over optimality.

### D28. The what-if runs in a Node worker thread, with an inline fallback
- **Chose:** `runWhatIf` builds the clone, then evaluates the plans in a `worker_thread` (`rewind/whatif-worker.ts`, `rewind/whatif-run.ts`). A `GuardedClone` cannot cross the thread boundary, so the worker is handed the raw samples plus the breaker limit and rebuilds it. If the worker cannot start, it runs inline and reports `ranInWorker: false`.
- **Why:** the spec requires it off the live loop so a what-if (tens of thousands of ticks) never stalls a rewind session on the same server. The inline fallback means a demo never silently fails if the worker loader is unavailable.
- **Tradeoff:** passing the full sample set into the worker is a copy of a few thousand vectors per request. Acceptable for an on-demand action; a long-lived pool would avoid it if this were hot.

## Phase 5 (evidence)

### D29. Every metric is measured on held-out matches, and weak numbers are reported
- **Chose:** `npm run eval` holds out one match per player, builds the clone from the rest, and reports clone accuracy, 1-second position error, handoff rate and a transfer test on the held-out match for three policies: the player's own clone, the basic bot, and a clone of a different player (`eval/run.ts`, `eval/metrics.ts`). Results go to `eval/results.md` as-is.
- **Why:** the judge grades on evidence against a simpler baseline. Measuring on training data would be meaningless; the three-policy comparison is what shows the own clone is actually capturing the person, not just producing plausible inputs. The spec explicitly says report real numbers even if weak.
- **What the numbers say (small dataset):** the bot clones reproduce their own player's move+fire choice 77–84% of the time vs 31% for the basic bot and ~43% for a cross-player clone, and land 1.1 units from the real path vs ~2.7 for the bot. The human (Nipun) clone is much weaker (23% both-match) — reported honestly; human play is noisier and the dataset is tiny.
- **Tradeoff:** fire-choice accuracy is inflated by the common "not firing" case, so move and fire are shown separately and "both" (the spec's measure) is the headline. Position error freezes the opponent so it measures the player's own path, not a diverging fight.

### D30. Position error freezes the opponent; the transfer test reconstructs "first / retries / fresh" from recordings
- **Chose:** `positionError` runs the policy and the real inputs from the same start with the opponent held still, so the only difference is this player's own decisions (`eval/metrics.ts`). `transferCase` finds a round the player lost, forks ~3 s before it ended, and reports the recorded loss (first attempt), the player's own clone vs the opponent clone over N seeds (retries), and the best what-if plan (fresh attempt) (`eval/transfer.ts`).
- **Why:** a fair position metric must isolate one player's movement from the fight's chaos. The transfer test maps the spec's "first attempt / retries / fresh attempt" onto what the recordings can actually support without new play sessions.
- **Tradeoff:** freezing the opponent makes position error ignore how the real fight pushed the player around. The transfer "fresh attempt" is only as good as the scripted plan menu (D26), and at forks where no enemy is visible it shows survive-100%/win-0%.

## Phase 6 (stretch)

### D31. The first-person view reads the same 2D snapshots; it holds no game logic
- **Chose:** `web/fpv.html` + `web/fpv.ts` fetch a match's snapshots from `/api/replay` and draw them with three.js — walls extruded into boxes, players as cylinders, the camera at one player's eye along their aim (map x,y become world x,z). It scrubs and plays the recorded snapshots; it never calls `step` or `observe` (`web/fpv.ts`).
- **Why:** the spec says logic stays 2D. Reusing the replay payload means the 3D view is a pure renderer of the authoritative simulation, so it can never disagree with the 2D game or the clones.
- **Tradeoff:** three.js adds ~530 KB to that page's bundle, so it is a separate entry loaded only when visited; the live game and replay viewer are unaffected.
- **Not pixel-verified:** the WebGL render needs a real browser, which the sandbox could not open against localhost; the page serves, typechecks, bundles three.js, and the data pipeline (match list + snapshots) was confirmed over HTTP.

### D32. "Sound ripples when running" is drawn as a floor ripple in the 3D view
- **Chose:** a running player (moveState 2) spawns an expanding, fading ring at their feet in the FPV; walking and standing do not (`web/fpv.ts`).
- **Why:** it makes the existing rule "running is loud and inaccurate, walking is quiet" legible without touching the engine. Audible footsteps would need an `observe` change (D18 left this open) and would change the fog-leak test's property, which is not worth it in the stretch window.
- **Tradeoff:** the ripple is visual only and only in the FPV, not an audio cue in the live 2D client.

### D33. The Cloudflare Durable Object migration stays deferred
- **Chose:** left the server as the Node process behind a Cloudflare Tunnel (D14), not a Durable Object.
- **Why:** a DO moves the engine to the Workers runtime, which risks hard rule 3 (every replay, fork and sim must run in the runtime that ran the live match) unless the whole pipeline moves with it, and it needs new storage for match files. That is a deploy-shaped project, not a final-hour change, and the evidence phases are the higher-value work.
- **Ruled out for now:** doing it under time pressure and risking the determinism guarantee that the clones and replays depend on.

## Phase 5 revision (honest evidence)

### D34. Human matches are the result; bot matches are a labelled sanity check; fixtures are dropped
- **Chose:** `eval/run.ts` splits the dataset with `isBotMatch` (both players `bot-*`). Human clones are the headline table; bot clones are a separate table labelled "sanity check only — NOT the main result". The alpha/bravo and p1/p2 fixtures are dropped (`DROP_PLAYERS`): pub1 is 160 ticks, t1 is one player barely moving, tunneltest is 100 ticks — none are skill data.
- **Why:** scripted bots are perfectly repeatable, so their clones score 77–84% and would flatter the result if mixed in. The judge grades on cloning a real person, so that number must stand alone and be honest about being thin.
- **Tradeoff:** after dropping fixtures, only one human (Nipun) has two or more matches, and one of those is a self-match. The eval says so plainly rather than padding the table.

### D35. Majority-action baseline, and move/fire reported separately
- **Chose:** added `MajorityBaseline` (always that player's single most common action) beside the basic bot and cross clone. Accuracy reports move-direction match and fire match as separate columns, plus 1-second position error.
- **Why:** fire is dominated by "not firing" (both the person and any policy mostly hold fire), so a combined score hides whether the clone captures *movement*. Move match is the discriminating signal. The majority baseline is the real floor: a clone that cannot beat "always do your most common thing" is only learning the habit, not the situation.
- **What it showed (honest):** Nipun's own clone did NOT beat the baselines — majority action matched moves 31% vs the clone's 29%, and landed closer in position. Reported as-is; the "Honest read" section says why (tiny, noisy human data; few neighbors; a mostly-still player is easy to match).

### D36. Learning curve plus an SVG chart, on the same held-out match as the table
- **Chose:** `eval/learning-curve.ts` trains on 1, 2, 3, ... of a player's matches (holding out the FIRST match, the same one section 1 uses) and plots move-match accuracy, as a self-contained SVG (`eval/learning-curve.svg`) for the video.
- **Why:** the curve is the argument that more games help, which matters when the current human numbers are weak. Holding out the same match keeps the curve's endpoint consistent with the accuracy table.
- **What it showed:** bots climb with data (bot-two 43% -> 58% -> 78% move match); Nipun is flat at ~30% across 1–2 matches — the honest signal that he needs more, varied games.

### D37. The what-if search is audited and reported as a spread with a clone-fire caveat
- **Chose:** `eval/whatif-audit.ts` proves fog holds by moving the hidden enemy off-sightline and checking every plan's and the clone's decision is unchanged (they see only `observe`). It confirms the clone CAN fire head-on. It then runs the what-if on 12 forks across the human matches and reports the spread (min/median/max), not one fork, plus the clone's fire rate when it could see the human.
- **Why:** a single fork is cherry-picking. And a plan "winning" against a clone that never shoots is not evidence the plan is good — so the clone's fire-when-seen rate is reported as the caveat it is.
- **What it showed (honest):** best-plan win rate median 100%, but the clone fired on only ~32% of ticks it could see the human. The per-fork table shows forks where the clone saw the human 20+ ticks and fired zero. The win rate is partly the clone's passivity (its training data had little firing), not plan quality. More recorded human games where the person shoots would fix it; the breaker's basic bot does shoot, so the head-on audit still passes.

### D38. A roster page shows who still needs games
- **Chose:** `eval/roster.md` lists every player, their match count, kind (human/bot), and status (ok / testable, needs more / cannot test yet / dropped fixture).
- **Why:** the honest bottleneck is data, so the first actionable output is "who needs to play more". Nipun is the only testable human; Supra, Pratul, nipun and Pratul Saini each have one match and cannot be tested until they play again.
