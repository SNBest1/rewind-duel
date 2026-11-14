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
