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

## Phases 2 and 3: rewind and clones

### D19. Two different "AIs", on purpose
- **Chose:** the **adaptive AI** (`server/ai.ts` + `server/brain.ts`) plays *against* you and learns your habits to counter them (sites you favour, spots you kill it from, skill that moves +6 / −4.5 per round you win / lose). The **clone** (`clone/knn.ts`) plays *as* someone: it copies one real player's recorded decisions.
- **Why:** they answer different questions. "Can I beat a bot that adapts to me?" vs "What if I had played that round differently against *that person*?"
- **Tradeoff:** two systems to explain. The clone's fallback (`BasicBot`) is the adaptive AI with its learning switched off, so there is only one hand-written bot.
- **Ruled out:** a single learned model for both. Spec rule 5 says kNN, and a kNN of you cannot also be tuned to beat you.

### D20. The adaptive AI learns from the authoritative state, but plays from `observe()`
- **Chose:** the `Trainer` watches the full server state after each tick (like a coach watching tape); the bot decides only from its own fogged observation.
- **Why:** learning where you really stood is fair game after the fact; using it live would be wallhacks.
- **Ruled out:** learning only from what the bot saw. Rounds where it never saw you would teach it nothing.

### D21. Ghost first, clone after a divergence limit
- **Chose:** `rewind/session.ts` replays the opponent's recorded inputs and steps the recorded match alongside; when `divergenceScore` passes 2.5 (or the recording runs out) a `GuardedClone` takes over and a `HANDOFF` line is logged with the number.
- **Why:** for the first moments after a fork, the real recorded inputs are the most faithful opponent there is. They stop being faithful the moment you do something different.
- **Tradeoff:** the score's weights (position/2, HP/25, +1.5 for a visibility flip) are a placeholder for the `TODO(human)` in `rewind/divergence.ts`.

### D22. Breaker limit from held-out *blocks*, not single samples
- **Chose:** the 95th-percentile limit is computed on a whole held-out match, or on whole 8-second blocks when there is only one match.
- **Why:** decisions 4 ticks apart are nearly identical. Holding out every 10th sample gave a limit of 0.08 (each held-out moment had its twin in training), and the live breaker then tripped 67% of the time. Holding out whole blocks gave 0.23 and about 20%.
- **Ruled out:** a hand-picked limit.

### D23. Aim is learned relative to the enemy
- **Chose:** the clone's aim action is an offset bucket from the direction to the enemy (or last seen position), or a compass direction when it has no idea; it is re-pointed every tick.
- **Why:** absolute angles do not transfer between situations; "aim slightly left of where they are" does.

### D24. Replay viewer frames are computed in Node
- **Chose:** `GET /api/matches/:id` replays the match on the server and sends a frame every 2 ticks (~250 KB per match).
- **Why:** spec rule 3, all replays run in Node. The browser only draws.

### D25. No VALORANT map names
- **Chose:** the extra maps are called Relay, Trident, Courtyard and Fault.
- **Why:** spec hard rule 1. Their layouts are generic tactical-shooter ideas (no mid + teleporters, three sites, open courtyard, tight chokes).

## Round 3: smarter AI, what-if, 3D

### D26. A belief map instead of "last seen"
- **Chose:** a Bayesian occupancy grid (`server/belief.ts`): predict (spread at run speed, weighted by the player's learned heat map), update (visible cells to zero, footsteps collapse, silence nearby lowers), collapse on sight.
- **Why:** "last seen" forgets everything 3 seconds later. The grid keeps reasoning: you were not in the 60% of the map it just looked at, so you are in the other 40%.
- **Evidence:** `npm run eval:belief`, belief on vs off at equal skill: 93-64 rounds, 16/20 matches.
- **Tradeoff:** ~0.3 ms per bot per tick. The basic bot (the clone's fallback) has it switched off, so it stays the "simple bot" the spec asks for.

### D27. Footsteps are an engine rule, not a client effect
- **Chose:** `observe()` reports a running enemy within 14 units, snapped to a 2 by 2 cell, through walls.
- **Why:** if only the client played a sound, the AI could not use it, and the human would have information the AI does not. Putting it in the observation keeps both sides fair and the fog rule in one place.

### D28. Adaptive difficulty starts at 20 and moves on streaks
- **Chose:** start 0.2; +0.07 per round won, −0.09 per round lost, ×1.5 per extra round of a streak (cap ×2.5). Saved brains from the old scheme keep what they learned but restart at 0.2.
- **Why:** the first version started at 0.45 and moved 0.045 per round, so a new player lost several rounds before it eased off. Losing steps are bigger than winning ones so struggling players are helped first.

### D29. What-if runs in a worker, shares the fork state
- **Chose:** `rewind/whatif.ts` plays 20 scripted plans × 5 seeds (plus what really happened) in `server/whatif-worker.ts`. The fork state is replayed once and shared; path fields are cached process-wide.
- **Why:** 100 futures took 14 s; replaying to the fork per future was most of it. Now ~5 s of simulation (~10 s with worker start-up and clone building), and a live match on the same server never stalls.
- **Tradeoff:** plans are scripted, not learned; ranking ties break on kill speed.

### D30. 3D is a view, not a new game
- **Chose:** three.js renders the client's existing state from the player's eyes (`web/view3d.ts`), loaded only when V is pressed. W/A/S/D are turned relative to the view and snapped to the engine's 8 directions.
- **Why:** spec phase 6: logic stays 2D. Replays, the AI and the server needed no change.
- **Tradeoff:** movement snaps to 45 degrees in first person. `@types/three` is not installed, so three is typed loosely in one file.

## Round 4: guns, ranks, reads, mirror, coach

### D31. Weapons live in the engine, the old rifle is weapon 0
- **Chose:** `engine/weapons.ts` with six guns; weapon 0 ("Standard") keeps the original numbers, so every old test and recording means the same thing. Buying is an input (`buy`) honoured only in the first 4 s of a round, so loadouts are recorded and replayed like any other input.
- **Ruled out:** loadouts in the match file header. A second source of truth for replays.

### D32. Headshots by geometry
- **Chose:** a hit is a headshot when the bullet's line passes within 0.13 units of the centre (perpendicular distance). Spread and bloom push shots off centre.
- **Why:** in top-down there is no head height; the centre is the only honest equivalent, and it makes aim quality (and the AI's rank) visible in damage.

### D33. Your rank is where the adaptive AI settles
- **Chose:** 25 rank steps over skill 0 to 1. The adaptive AI moves toward the level where you win about half your rounds, so its current level is your rank.
- **Why:** no separate rating system to tune, and the rank means something concrete: "the AI at this level is your equal".
- **Evidence:** `eval/rank-ladder.ts`. It caught two real bugs: burst control halved the fire rate (Platinum lost to Gold 40%), and the fix (burst only past 12 units, ~1.5° bloom budget) made every tier beat the one below.

### D34. Calls are checked by the server, not claimed by the bot
- **Chose:** the bot states one call per round from belief mass + side history; the server compares it to what the trainer saw the human do and logs `CALLED`/`MISREAD` with a running score.
- **Why:** a bot grading itself would be meaningless. `eval/reads.ts` shows calls improving 0/1 → 5/5 over four matches against a habit-bound player.

### D35. Mirror mode reuses the clone; the coach reuses the planner
- **Chose:** "vs yourself" is `GuardedClone` of the human with their favourite loadout; the coach is the what-if worker run on the 3 seconds before each death, one job at a time.
- **Tradeoff:** the coach's opponent is a clone of the AI built from its recorded games, not the live AI itself; with one match recorded that is a few hundred decisions and the breaker hands much of it to the basic bot.

## Round 5: VALORANT names, armory and economy

### D36. VALORANT names, with permission (supersedes D25 and spec hard rule 1)
- **Chose:** real gun names and stats, rank names (Ascendant, Immortal, Radiant) and map names (Bind, Haven, Ascent, Split), because the hackathon grants attendees permission to copy from the game.
- **Note:** `spec.md` still says "no VALORANT names"; update it if the team agrees, so the rule and the code match.
- **Kept:** map ids (`relay`, `trident`, ...) so recordings and brains keep working; the layouts are our own small 1v1 versions.

### D37. Rules are part of the match, not a server setting
- **Chose:** `State.rules` ('classic' | 'valorant'), written to the match file (`rules`); files without it replay as classic. New live matches are VALORANT.
- **Why:** an old recording must replay under the rules it was played with, or the hash breaks.

### D38. Fire rate in 1/100 ticks
- **Chose:** `fireCooldown` counts hundredths of a tick (Vandal 9.75/s = 328), carrying the remainder into the next shot only when you keep firing.
- **Why:** at 32 ticks/s whole ticks can only give 10.7/s or 8/s for a Vandal. The legacy rifle (800) behaves exactly as before.

### D39. The AI plays the economy
- **Chose:** pistol rounds (Sheriff / Ghost + shields by rank), keep-and-top-up when it survived, full buy at 3900 (rifle + heavy shields, Operator sometimes on defence), force buy with 2000+, eco otherwise.
- **Measured:** the first version saved at 2000-3900 like a real team would. In a first-to-5 match that threw rounds, and the rank ladder went flat (Bronze vs Iron 50%). Forcing, plus a steeper aim curve at the low end (`sqrt(skill)`), restored a clear ladder (53-71% for every step).
