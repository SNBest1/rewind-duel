import { canSee, type Slot, type State } from '@rewind/engine';

/**
 * Ghost mode hands the opponent over to the clone once this score passes DIVERGENCE_LIMIT.
 * Both are in "units of distance": 1.0 means roughly "one map unit of drift".
 */
export const DIVERGENCE_LIMIT = 2.5;

/**
 * How far a rewind branch has drifted from the recorded match at the same tick.
 * 0 means the recorded opponent inputs are still a faithful answer to what the human is doing.
 *
 * @param recorded the original match rebuilt at this tick
 * @param branch   the rewind session's state at this tick
 * @param opponent the slot being replayed as a ghost (the human is the other slot)
 */
export function divergenceScore(recorded: State, branch: State, opponent: Slot): number {
  const human = (1 - opponent) as Slot;
  const sawThen = canSee(recorded, opponent, human);
  const seesNow = canSee(branch, opponent, human);

  // Everything is in map units so the pieces add up to one comparable number.
  // Position drift: how far each player has moved from where the recording had them at this tick.
  let pos = 0;
  for (const slot of [0, 1] as const) {
    const r = recorded.players[slot];
    const b = branch.players[slot];
    pos += Math.hypot(b.x - r.x, b.y - r.y);
  }

  // HP drift: a different fight is unfolding. 25 HP (one bullet) is worth ~1 unit, so /25.
  let hp = 0;
  for (const slot of [0, 1] as const) {
    hp += Math.abs(branch.players[slot].hp - recorded.players[slot].hp) / 25;
  }

  // Visibility flip: the opponent now sees (or no longer sees) the human when the recording had it the other way.
  // The recorded inputs were an answer to the old sightline, so a flip makes them stale. Worth 2 units (near the limit).
  const flip = sawThen !== seesNow ? 2 : 0;

  return pos + hp + flip;
}
