// Writes eval/METRICS.md — the LOCKED definitions of every evaluation metric. These are fixed now, before
// new data arrives, so the numbers mean the same thing match after match. Do not change a definition here
// without renaming the metric; a silent redefinition makes old and new runs incomparable.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METRICS = fileURLToPath(new URL('./METRICS.md', import.meta.url));

export function writeMetricsDoc(): void {
  const md = `# Rewind — locked metric definitions

These definitions are fixed as of 2026-11-14 and must not change. Every number in \`eval/results.md\`
is computed exactly as written here. Raw metrics (kept from the first version) and new metrics are
reported side by side so old runs stay comparable.

## Data rules (apply to every metric)

- **Held-out:** a clone is always tested on a match it did NOT train on.
- **Self-matches excluded:** a match where one person holds both slots is not a real duel. It is flagged
  and removed from training and eval (\`isSelfMatch\`).
- **Fixtures excluded:** the alpha/bravo and tunnel smoke-test matches are dropped.
- **Decision tick:** one every 4 engine ticks (8/s), only while the slot is alive and the round is live.
- **Observe only:** every policy decides from \`observe(state, slot)\` — the fogged view. It never sees the
  full state, so it cannot cheat the fog.

## Move metrics

- **Move match (raw):** share of decision ticks where the policy's move direction (one of 9: stop + 8)
  equals the person's. Simple agreement; dominated by the most common direction (usually "stop").
- **Balanced move accuracy (new, headline):** mean over the 9 move classes of per-class recall —
  for each direction the person used, the share of those ticks the policy also chose it, then averaged
  over the directions that occurred. A policy that always picks the majority direction scores about
  1/9. This is the move metric that cannot be gamed by standing still, so it is the headline.

## Fire metrics

- **Fire match (raw):** share of decision ticks where the policy's fire bit equals the person's. Inflated
  by the many ticks where neither fires.
- **Fire precision / recall on VISIBLE-enemy ticks (new):** computed only on ticks where the enemy was in
  sight (firing is a real choice there). Of those ticks:
  - precision = (policy fired AND person fired) / (policy fired)
  - recall    = (policy fired AND person fired) / (person fired)
  Recall is the honest "does it shoot when the person shot" number.

## Position metrics

- **Position error (raw):** from each held-out decision moment, run the policy 1 second (32 ticks) with
  the opponent frozen, and measure the distance in map units between the policy's end point and where the
  person actually ended. Averaged over all moments. Flattered by moments where the person did not move.
- **Position error on moved moments (new):** the same, but only over moments where the person actually
  moved (ended more than 0.5 units from the start). The honest test of copying real movement.

## Breaker and what-if

- **Breaker rate:** share of decision ticks where the clone's nearest recorded neighbor is farther than
  the novelty limit (p95 of held-out nearest-neighbor distances), so control hands to the basic bot.
  Reported with the clone shown both breaker OFF (raw clone) and breaker ON.
- **What-if win / survive:** for a fork, each micro-plan is run 5x (different seeds) for 3 s against an
  opponent; win = human killed the opponent and lived, survive = human still alive at the end. Reported as
  the best plan's rate per fork, as a spread over 12 forks, against BOTH the clone and the basic bot.
- **Fire-when-seen:** over a fork rollout, the share of ticks the opponent could see the human on which it
  chose to fire. Low fire-when-seen means a "win" is partly the opponent's passivity, not the plan.

## The clone being measured

The clone is the **factored k-NN clone**: one k-NN neighborhood, then separate distance-weighted votes for
move, aim, and fire. The fire vote uses only neighbors whose recorded enemy-visibility matches the current
tick. It is still pure k-NN (no training, no LLM).
`;
  writeFileSync(METRICS, md);
}
