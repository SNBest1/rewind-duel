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
- **Why:** hard rule 5 ΓÇö no LLM, clones are KNN. Building features from `observe` is what makes "the clone only knows what the person could see" true by construction, not by discipline (DECISIONS D8).
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
- **Why:** hard rule 3 ΓÇö every replay, fork and sim runs in the runtime that ran the live match. Running the fork in the browser would need the enemy's full state (which the fog forbids) and a second engine.
- **Tradeoff:** a rewind tick costs one round trip of input delay, unlike the live game which predicts own movement. Acceptable: a rewind is a deliberate, slow "what if", not a reflex duel.
- **Ruled out:** predicting the rewind in the browser (breaks rule 3, needs enemy state).

### D24. The replay viewer may see both sides; live fog is untouched
- **Chose:** `buildSnapshots` exposes both players' positions for the replay viewer, and the rewind stream includes the opponent's position. The live server's `observe` fog is unchanged.
- **Why:** a replay is the player reviewing their own finished match after the fact ΓÇö hiding the enemy from a post-match review would make it useless. The clone still only ever acts on `observe` (D21), so "the clone only knows what the person could see" stays true even though the viewer shows everything.
- **Tradeoff:** the both-sides snapshot is a separate, wider payload than a live `Observation`. Only the replay/rewind path uses it, never a live match.

### D25. Each retry from the fork is a stored branch; the opponent clone holds out this very match
- **Chose:** `RewindSession.endBranch()` records the outcome (winner, whether the human won, the handoff tick, the full trace) and resets to the fork for another attempt. `openSession` builds the opponent's clone from all of their matches except the one being relived, when they have more than one.
- **Why:** the branches are the raw material for the Phase 4 "what you could have done" and the Phase 5 transfer test. Holding out the relived match stops the clone from simply replaying the exact game back at the player.
- **Tradeoff:** a player with only one recorded match gets a clone trained on that match (no hold-out available), so its first branch can look suspiciously like the recording until the human diverges.

## Phase 4 (what you could have done)

### D26. Micro-plans are scripted named policies, not a search
- **Chose:** about twenty hand-written plans (`rewind/plans.ts`), each a tiny function from the human's `Observation` to an `Input`: stop-and-shoot, back off to the nearest cover corner and hold or trade, smoke the angle then cross, dash out of the line four ways, walk quiet and hold an angle, rush the last-seen, fall back and reload. Each has a readable label.
- **Why:** the spec names these exact ideas, and the point is advice a human can act on ("back off to cover and wait"), not an opaque optimum. Scripted plans also run in milliseconds, so 20 plans ├ù 5 seeds is cheap.
- **Tradeoff:** the plans are a fixed menu, so the tool can only suggest what is on it. A plan that would have worked but is not scripted is never found.
- **Ruled out:** a tree search or RL rollout over the raw action space (slow, and the result is not nameable advice); using the clone of the human as the plan (that is "what you did", not "what you could have done").

### D27. Rank by fight wins first, survival second, with shots landed as a tiebreak
- **Chose:** each plan runs 5 times from the fork under different seeds (overwriting `State.rng`, D2) for 3 seconds against the opponent's guarded clone. `score = winRate + 0.3┬╖survivalRate + 0.02┬╖avgShotsLanded` (`rewind/whatif.ts`). The top 3 come back with a one-line reason read off the events ("won the fight every time, landing 3.0 shots").
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
- **What the numbers say (small dataset):** the bot clones reproduce their own player's move+fire choice 77ΓÇô84% of the time vs 31% for the basic bot and ~43% for a cross-player clone, and land 1.1 units from the real path vs ~2.7 for the bot. The human (Nipun) clone is much weaker (23% both-match) ΓÇö reported honestly; human play is noisier and the dataset is tiny.
- **Tradeoff:** fire-choice accuracy is inflated by the common "not firing" case, so move and fire are shown separately and "both" (the spec's measure) is the headline. Position error freezes the opponent so it measures the player's own path, not a diverging fight.

### D30. Position error freezes the opponent; the transfer test reconstructs "first / retries / fresh" from recordings
- **Chose:** `positionError` runs the policy and the real inputs from the same start with the opponent held still, so the only difference is this player's own decisions (`eval/metrics.ts`). `transferCase` finds a round the player lost, forks ~3 s before it ended, and reports the recorded loss (first attempt), the player's own clone vs the opponent clone over N seeds (retries), and the best what-if plan (fresh attempt) (`eval/transfer.ts`).
- **Why:** a fair position metric must isolate one player's movement from the fight's chaos. The transfer test maps the spec's "first attempt / retries / fresh attempt" onto what the recordings can actually support without new play sessions.
- **Tradeoff:** freezing the opponent makes position error ignore how the real fight pushed the player around. The transfer "fresh attempt" is only as good as the scripted plan menu (D26), and at forks where no enemy is visible it shows survive-100%/win-0%.

## Phase 6 (stretch)

### D31. The first-person view reads the same 2D snapshots; it holds no game logic
- **Chose:** `web/fpv.html` + `web/fpv.ts` fetch a match's snapshots from `/api/replay` and draw them with three.js ΓÇö walls extruded into boxes, players as cylinders, the camera at one player's eye along their aim (map x,y become world x,z). It scrubs and plays the recorded snapshots; it never calls `step` or `observe` (`web/fpv.ts`).
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
- **Chose:** `eval/run.ts` splits the dataset with `isBotMatch` (both players `bot-*`). Human clones are the headline table; bot clones are a separate table labelled "sanity check only ΓÇö NOT the main result". The alpha/bravo and p1/p2 fixtures are dropped (`DROP_PLAYERS`): pub1 is 160 ticks, t1 is one player barely moving, tunneltest is 100 ticks ΓÇö none are skill data.
- **Why:** scripted bots are perfectly repeatable, so their clones score 77ΓÇô84% and would flatter the result if mixed in. The judge grades on cloning a real person, so that number must stand alone and be honest about being thin.
- **Tradeoff:** after dropping fixtures, only one human (Nipun) has two or more matches, and one of those is a self-match. The eval says so plainly rather than padding the table.

### D35. Majority-action baseline, and move/fire reported separately
- **Chose:** added `MajorityBaseline` (always that player's single most common action) beside the basic bot and cross clone. Accuracy reports move-direction match and fire match as separate columns, plus 1-second position error.
- **Why:** fire is dominated by "not firing" (both the person and any policy mostly hold fire), so a combined score hides whether the clone captures *movement*. Move match is the discriminating signal. The majority baseline is the real floor: a clone that cannot beat "always do your most common thing" is only learning the habit, not the situation.
- **What it showed (honest):** Nipun's own clone did NOT beat the baselines ΓÇö majority action matched moves 31% vs the clone's 29%, and landed closer in position. Reported as-is; the "Honest read" section says why (tiny, noisy human data; few neighbors; a mostly-still player is easy to match).

### D36. Learning curve plus an SVG chart, on the same held-out match as the table
- **Chose:** `eval/learning-curve.ts` trains on 1, 2, 3, ... of a player's matches (holding out the FIRST match, the same one section 1 uses) and plots move-match accuracy, as a self-contained SVG (`eval/learning-curve.svg`) for the video.
- **Why:** the curve is the argument that more games help, which matters when the current human numbers are weak. Holding out the same match keeps the curve's endpoint consistent with the accuracy table.
- **What it showed:** bots climb with data (bot-two 43% -> 58% -> 78% move match); Nipun is flat at ~30% across 1ΓÇô2 matches ΓÇö the honest signal that he needs more, varied games.

### D37. The what-if search is audited and reported as a spread with a clone-fire caveat
- **Chose:** `eval/whatif-audit.ts` proves fog holds by moving the hidden enemy off-sightline and checking every plan's and the clone's decision is unchanged (they see only `observe`). It confirms the clone CAN fire head-on. It then runs the what-if on 12 forks across the human matches and reports the spread (min/median/max), not one fork, plus the clone's fire rate when it could see the human.
- **Why:** a single fork is cherry-picking. And a plan "winning" against a clone that never shoots is not evidence the plan is good ΓÇö so the clone's fire-when-seen rate is reported as the caveat it is.
- **What it showed (honest):** best-plan win rate median 100%, but the clone fired on only ~32% of ticks it could see the human. The per-fork table shows forks where the clone saw the human 20+ ticks and fired zero. The win rate is partly the clone's passivity (its training data had little firing), not plan quality. More recorded human games where the person shoots would fix it; the breaker's basic bot does shoot, so the head-on audit still passes.

### D38. A roster page shows who still needs games
- **Chose:** `eval/roster.md` lists every player, their match count, kind (human/bot), and status (ok / testable, needs more / cannot test yet / dropped fixture).
- **Why:** the honest bottleneck is data, so the first actionable output is "who needs to play more". Nipun is the only testable human; Supra, Pratul, nipun and Pratul Saini each have one match and cannot be tested until they play again.

## Phase 5 revision 2 (locked metrics, factored clone, self-match exclusion)

### D39. Self-matches are excluded from training and eval, and flagged
- **Chose:** `isSelfMatch` (same name on both slots) marks a match as not a real duel. `buildClone` never trains on one; the eval drops them from the usable set and prints which were excluded; the roster counts real duels and shows "(+N self excluded)".
- **Why:** a self-match is one person controlling both sides ΓÇö it is not opponent data and would teach a clone to play against itself. Nipun's third "match" was a self-match, which had been inflating his count.
- **Effect:** after exclusion, Nipun has 2 real matches (not 3); the headline honestly rests on 2.

### D40. Metrics are locked in eval/METRICS.md before new data arrives
- **Chose:** `eval/metrics-doc.ts` writes `eval/METRICS.md` with the fixed definition of every metric, and the eval computes exactly those. Raw metrics (move match, fire match, position error) are kept; new metrics are added beside them, never replacing them.
- **Why:** the user asked to lock definitions so numbers mean the same thing as more games arrive. A silent redefinition would make old and new runs incomparable.
- **New metrics:** balanced move accuracy (mean per-class recall over the 9 move options ΓÇö cannot be gamed by holding still); fire precision and recall on VISIBLE-enemy ticks only (where firing is a real choice); position error on moved-only moments (where the person actually moved).

### D41. The clone is factored: separate move / aim / fire votes, fire restricted to same-visibility neighbors
- **Chose:** `FactoredClone` runs one k-NN neighborhood, then three distance-weighted votes ΓÇö move (9 classes), aim bucket, and fire. The fire vote uses only neighbors whose recorded enemy-visibility matches the current tick; with none, it defaults to not firing.
- **Why:** the joint clone voted on one combined action id, so rare combinations split the k neighbors into singletons and fire almost never won. Separating the votes lets each field draw on all k neighbors, and conditioning fire on visibility is the honest model: "do I shoot" depends on whether an enemy is in sight.
- **Effect (held-out, real):** fire recall on visible ticks rose to 79% (majority baseline fires 0%), and balanced move 14% now edges the baselines (majority 11%, cross 12%). It is still pure k-NN (hard rule 5). The clone is shown breaker OFF and ON; the breaker fired on 5% of ticks.
- **Honest caveat it exposed:** in the what-if rollout the clone drives its own movement into positions unlike its training, so its fire-when-seen there is only ~19% (vs the basic bot's 85%). Reported, not hidden.

### D42. The what-if spread now runs against the basic bot as a reference opponent
- **Chose:** `forkSpread` evaluates all 12 forks against BOTH the factored clone and the basic bot, side by side, and reports each opponent's fire-when-seen rate.
- **Why:** a plan "winning" only tells you something relative to a baseline opponent. The bot shoots 85% of visible ticks, so beating the bot (win median 60%) is the real bar; beating the passive clone (median 100%) is inflated by the clone's reticence. Showing both makes the inflation visible.

### D43. The roster page refreshes live from the server
- **Chose:** `GET /api/roster` recomputes match-per-player counts from `data/` on every request (no cache); `web/roster.html` polls it every 4 s and draws bars. `eval/roster.md` remains the static snapshot written each eval run.
- **Why:** the user wants to watch counts climb as people play. The live page needs no eval re-run; a finished match lands in `data/` and shows up within one poll.

## Phase 5 revision 3 (fire gap, bootstrap CIs, demo presets) ΓÇö MODEL FROZEN after this

### D44. The fire gap was a missing decision-hold in the live paths, not a passive clone
- **Diagnosis:** the eval measures the clone at decision ticks (every 4) on the real replayed positions and got 79% fire recall; the what-if and rewind called the clone EVERY tick and on self-driven positions, so a fire decision never persisted across its 4-tick window and the clone drifted off-distribution. Checked all three of the user's hypotheses: (a) both live paths do use the factored clone (confirmed); (b) the fire action did NOT hold across the 4 ticks (the bug); (c) aim/reload/breaker do not block firing ΓÇö reload only triggers at ammo 0, the breaker fires on 5% of ticks, and a head-on engagement shows the clone firing 60% of visible ticks.
- **Fix:** `HoldingPolicy` (clone/holding.ts) wraps any policy, decides every `DECISION_INTERVAL` ticks and replays the held input between, phased on `obs.tick` so it matches the eval's sampling. Wired into the what-if (`simulateOnce`), the rewind session, and the audit's fire counter.
- **Honest result:** head-on fire-when-seen ~60% (close to the 79% eval recall); the aggregate what-if rose 19% -> 22%. The remaining gap is NOT a bug ΓÇö the dodging micro-plans pull the clone into oblique, off-distribution positions where it has few same-visibility neighbors. A live test (`eval/test/fire-gap.test.ts`) runs the clone through a scripted engagement and asserts its fire rate is within 25 points of its eval recall, so a real regression in the live fire path fails CI.

### D45. 95% bootstrap confidence intervals, resampling by ROUND not by tick
- **Chose:** metrics are rebuilt from a per-decision `DecisionRecord` tagged with its round. `bootstrapByRound` resamples whole rounds with replacement (1000x, seeded for reproducibility) and takes the 2.5/97.5 percentiles. Every metric in results.md shows `point [loΓÇôhi]`.
- **Why by round:** ticks inside a round are one correlated sequence (the same positions, the same fight), so resampling ticks would pretend there is far more independent data than there is and give fake-tight intervals. A round is the independent unit.
- **What it showed:** with 5 rounds the human CIs are wide and mostly overlap. The honest read now states, per comparison, whether two CIs separate: Nipun's balanced-move win over majority separates (majority has zero variance), the win over cross-clone OVERLAPS, and the fire-recall win over majority separates. So only the fire-recall improvement is statistically real at this sample size; the rest is directional until 3+ matches.

### D46. Three named demo presets for repeatable video takes
- **Chose:** `rewind/presets.ts` defines three fixed forks from three different human matches against three different opponents (Supra, Pratul, Pratul Saini), each chosen (an offline scan) because the opponent clone sees the player >= ~8 ticks and fires >= ~4 over the best plan's rollout. `GET /api/presets` serves them; the replay viewer has a preset dropdown that loads the match, seeks the fork and sets the control slot. A test asserts each preset is a live fork and that its clone sees+fires.
- **Why:** the video must play the same engagement every take; nothing random.

### D47. MODEL FROZEN
- From here: no new features and no metric redefinitions. Only bug fixes and re-running `npm run eval` as new human matches arrive. The locked metric definitions live in `eval/METRICS.md`. If the frozen clone still loses to majority or cross-clone on the locked metrics once more humans have 3+ matches, that gets reported plainly rather than patched around.

## Unity 3D viewer

### D48. Unity is a renderer of exported snapshots, built from the CLI ΓÇö not a second engine
- **Chose:** a Unity project (`unity/RewindDuel3D`, URP, editor `6000.6.9f1`) scaffolded and driven entirely from the `unity` CLI. `npm run export:unity` writes `map.json` (walls/sites from `engine/map.ts`) and `match.json` (`buildSnapshots` of a recorded match) into `Assets/StreamingAssets/`. C# (`MapBuilder`, `MatchReplay`) builds the 3D world and animates both players + a first-person camera from those snapshots. An editor script (`SceneBuilder`) generates the scene headless via `unity run -- -executeMethod`.
- **Why:** same reasoning as the three.js FPV (D31) and hard rule 3 ΓÇö the Node engine is the one deterministic source of truth. Re-implementing movement/vision/clone in C# would be a second engine that could drift from the recordings and the evals. Unity consumes the exact same snapshot payload the replay viewer uses, so it can never disagree.
- **Verified in-session, headless:** the scene built with zero `error CS`, and a `StandaloneOSX` player built successfully (77 MB app, `map.json`+`match.json` shipped in `Contents/Resources/Data/StreamingAssets`). Could NOT screenshot the live render ΓÇö the sandbox has no display ΓÇö so the visual frame is unverified; the user presses Play to see it.
- **Tradeoff / ruled out:** no live WebSocket link and no clone in Unity. Driving a live rewind stays in Node (`server/` + `web/replay.html`); Unity is for 3D replay/presentation. The CLI lists five editor versions but only `6000.6.9f1` is installed on disk, so the project is pinned to it.

## Branch valorant-ai-bot (merged with main)

Built in parallel with main's Phases 2 to 6 from the Phase 2 scaffold, then merged. These modules live in `ai/` (live AI, its own clone/rewind/what-if/coach) and `server/` (ai, belief, brain, ranks); main's `clone/`, `rewind/` and `eval/` packages are unchanged. The divergence score is main's (D19).

### Rewind and clones (this branch)

### D49. Two different "AIs", on purpose
- **Chose:** the **adaptive AI** (`server/ai.ts` + `server/brain.ts`) plays *against* you and learns your habits to counter them (sites you favour, spots you kill it from, skill that moves +6 / ΓêÆ4.5 per round you win / lose). The **clone** (`clone/knn.ts`) plays *as* someone: it copies one real player's recorded decisions.
- **Why:** they answer different questions. "Can I beat a bot that adapts to me?" vs "What if I had played that round differently against *that person*?"
- **Tradeoff:** two systems to explain. The clone's fallback (`BasicBot`) is the adaptive AI with its learning switched off, so there is only one hand-written bot.
- **Ruled out:** a single learned model for both. Spec rule 5 says kNN, and a kNN of you cannot also be tuned to beat you.

### D50. The adaptive AI learns from the authoritative state, but plays from `observe()`
- **Chose:** the `Trainer` watches the full server state after each tick (like a coach watching tape); the bot decides only from its own fogged observation.
- **Why:** learning where you really stood is fair game after the fact; using it live would be wallhacks.
- **Ruled out:** learning only from what the bot saw. Rounds where it never saw you would teach it nothing.

### D51. Ghost first, clone after a divergence limit
- **Chose:** `rewind/session.ts` replays the opponent's recorded inputs and steps the recorded match alongside; when `divergenceScore` passes 2.5 (or the recording runs out) a `GuardedClone` takes over and a `HANDOFF` line is logged with the number.
- **Why:** for the first moments after a fork, the real recorded inputs are the most faithful opponent there is. They stop being faithful the moment you do something different.
- **Tradeoff:** the score's weights (position/2, HP/25, +1.5 for a visibility flip) are a placeholder for the `TODO(human)` in `rewind/divergence.ts`.

### D52. Breaker limit from held-out *blocks*, not single samples
- **Chose:** the 95th-percentile limit is computed on a whole held-out match, or on whole 8-second blocks when there is only one match.
- **Why:** decisions 4 ticks apart are nearly identical. Holding out every 10th sample gave a limit of 0.08 (each held-out moment had its twin in training), and the live breaker then tripped 67% of the time. Holding out whole blocks gave 0.23 and about 20%.
- **Ruled out:** a hand-picked limit.

### D53. Aim is learned relative to the enemy
- **Chose:** the clone's aim action is an offset bucket from the direction to the enemy (or last seen position), or a compass direction when it has no idea; it is re-pointed every tick.
- **Why:** absolute angles do not transfer between situations; "aim slightly left of where they are" does.

### D54. Replay viewer frames are computed in Node
- **Chose:** `GET /api/matches/:id` replays the match on the server and sends a frame every 2 ticks (~250 KB per match).
- **Why:** spec rule 3, all replays run in Node. The browser only draws.

### D55. No VALORANT map names
- **Chose:** the extra maps are called Relay, Trident, Courtyard and Fault.
- **Why:** spec hard rule 1. Their layouts are generic tactical-shooter ideas (no mid + teleporters, three sites, open courtyard, tight chokes).

## Round 3: smarter AI, what-if, 3D

### D56. A belief map instead of "last seen"
- **Chose:** a Bayesian occupancy grid (`server/belief.ts`): predict (spread at run speed, weighted by the player's learned heat map), update (visible cells to zero, footsteps collapse, silence nearby lowers), collapse on sight.
- **Why:** "last seen" forgets everything 3 seconds later. The grid keeps reasoning: you were not in the 60% of the map it just looked at, so you are in the other 40%.
- **Evidence:** `npm run eval:belief`, belief on vs off at equal skill: 93-64 rounds, 16/20 matches.
- **Tradeoff:** ~0.3 ms per bot per tick. The basic bot (the clone's fallback) has it switched off, so it stays the "simple bot" the spec asks for.

### D57. Footsteps are an engine rule, not a client effect
- **Chose:** `observe()` reports a running enemy within 14 units, snapped to a 2 by 2 cell, through walls.
- **Why:** if only the client played a sound, the AI could not use it, and the human would have information the AI does not. Putting it in the observation keeps both sides fair and the fog rule in one place.

### D58. Adaptive difficulty starts at 20 and moves on streaks
- **Chose:** start 0.2; +0.07 per round won, ΓêÆ0.09 per round lost, ├ù1.5 per extra round of a streak (cap ├ù2.5). Saved brains from the old scheme keep what they learned but restart at 0.2.
- **Why:** the first version started at 0.45 and moved 0.045 per round, so a new player lost several rounds before it eased off. Losing steps are bigger than winning ones so struggling players are helped first.

### D59. What-if runs in a worker, shares the fork state
- **Chose:** `rewind/whatif.ts` plays 20 scripted plans ├ù 5 seeds (plus what really happened) in `server/whatif-worker.ts`. The fork state is replayed once and shared; path fields are cached process-wide.
- **Why:** 100 futures took 14 s; replaying to the fork per future was most of it. Now ~5 s of simulation (~10 s with worker start-up and clone building), and a live match on the same server never stalls.
- **Tradeoff:** plans are scripted, not learned; ranking ties break on kill speed.

### D60. 3D is a view, not a new game
- **Chose:** three.js renders the client's existing state from the player's eyes (`web/view3d.ts`), loaded only when V is pressed. W/A/S/D are turned relative to the view and snapped to the engine's 8 directions.
- **Why:** spec phase 6: logic stays 2D. Replays, the AI and the server needed no change.
- **Tradeoff:** movement snaps to 45 degrees in first person. `@types/three` is not installed, so three is typed loosely in one file.

## Round 4: guns, ranks, reads, mirror, coach

### D61. Weapons live in the engine, the old rifle is weapon 0
- **Chose:** `engine/weapons.ts` with six guns; weapon 0 ("Standard") keeps the original numbers, so every old test and recording means the same thing. Buying is an input (`buy`) honoured only in the first 4 s of a round, so loadouts are recorded and replayed like any other input.
- **Ruled out:** loadouts in the match file header. A second source of truth for replays.

### D62. Headshots by geometry
- **Chose:** a hit is a headshot when the bullet's line passes within 0.13 units of the centre (perpendicular distance). Spread and bloom push shots off centre.
- **Why:** in top-down there is no head height; the centre is the only honest equivalent, and it makes aim quality (and the AI's rank) visible in damage.

### D63. Your rank is where the adaptive AI settles
- **Chose:** 25 rank steps over skill 0 to 1. The adaptive AI moves toward the level where you win about half your rounds, so its current level is your rank.
- **Why:** no separate rating system to tune, and the rank means something concrete: "the AI at this level is your equal".
- **Evidence:** `eval/rank-ladder.ts`. It caught two real bugs: burst control halved the fire rate (Platinum lost to Gold 40%), and the fix (burst only past 12 units, ~1.5┬░ bloom budget) made every tier beat the one below.

### D64. Calls are checked by the server, not claimed by the bot
- **Chose:** the bot states one call per round from belief mass + side history; the server compares it to what the trainer saw the human do and logs `CALLED`/`MISREAD` with a running score.
- **Why:** a bot grading itself would be meaningless. `eval/reads.ts` shows calls improving 0/1 ΓåÆ 5/5 over four matches against a habit-bound player.

### D65. Mirror mode reuses the clone; the coach reuses the planner
- **Chose:** "vs yourself" is `GuardedClone` of the human with their favourite loadout; the coach is the what-if worker run on the 3 seconds before each death, one job at a time.
- **Tradeoff:** the coach's opponent is a clone of the AI built from its recorded games, not the live AI itself; with one match recorded that is a few hundred decisions and the breaker hands much of it to the basic bot.

## Round 5: VALORANT names, armory and economy

### D66. VALORANT names, with permission (supersedes spec hard rule 1)
- **Chose:** real gun names and stats, rank names (Ascendant, Immortal, Radiant) and map names (Bind, Haven, Ascent, Split), because the hackathon grants attendees permission to copy from the game.
- **Note:** `spec.md` still says "no VALORANT names"; update it if the team agrees, so the rule and the code match.
- **Kept:** map ids (`relay`, `trident`, ...) so recordings and brains keep working; the layouts are our own small 1v1 versions.

### D67. Rules are part of the match, not a server setting
- **Chose:** `State.rules` ('classic' | 'valorant'), written to the match file (`rules`); files without it replay as classic. New live matches are VALORANT.
- **Why:** an old recording must replay under the rules it was played with, or the hash breaks.

### D68. Fire rate in 1/100 ticks
- **Chose:** `fireCooldown` counts hundredths of a tick (Vandal 9.75/s = 328), carrying the remainder into the next shot only when you keep firing.
- **Why:** at 32 ticks/s whole ticks can only give 10.7/s or 8/s for a Vandal. The legacy rifle (800) behaves exactly as before.

### D69. The AI plays the economy
- **Chose:** pistol rounds (Sheriff / Ghost + shields by rank), keep-and-top-up when it survived, full buy at 3900 (rifle + heavy shields, Operator sometimes on defence), force buy with 2000+, eco otherwise.
- **Measured:** the first version saved at 2000-3900 like a real team would. In a first-to-5 match that threw rounds, and the rank ladder went flat (Bronze vs Iron 50%). Forcing, plus a steeper aim curve at the low end (`sqrt(skill)`), restored a clear ladder (53-71% for every step).

## Unity client for the live game

### D70. The Unity first-person client reads the game from the server, never from a C# copy
- **Chose:** two additive server changes. The `start` message now carries `mapData` (the full map) next to the existing `map` id. A new read-only `GET /api/catalog` returns every map with its geometry, the difficulties, the ranks, the armory, the shields, the buy window and the round length. The Unity client (`~/My project (1)`, `Assets/RewindDuel/`) builds its lobby, buy menu, minimap and arena from these. The browser client ignores both.
- **Why:** the Unity client cannot import the TypeScript engine. Copying maps or the armory into C# would drift the first time either changes, and would put weapon and map names in a second codebase. Now they live only in `engine/`.
- **What Unity covers:** all four lobby modes (AI by difficulty or fixed rank, mirror, friend room with map vote, rewind of a recorded round), the buy phase and economy, both weapon slots, shields, flashes (thrown orbs, pops and a white-out driven by the server's own blind countdown), smokes, teleporters (with movement prediction that teleports exactly like the server), three-site maps, heard footsteps and shots, the AI's level, rank and reads, its belief map (on the minimap and, with I, painted onto the floor), its trace, and the end screen's insights and coach.
- **Verified in play against this server:** full AI matches on Bind (buys, teleports every round, kills, a side swap) and Haven (a headshot, a flash that blinded the thrower), plus friend, mirror and rewind sessions. The movement port matches the engine bit for bit (D49).
