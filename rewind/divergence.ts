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

  // Was TODO(human). Placeholder so the demo runs; replace with your own weighting.
  // Position drift of both players in map units, averaged so one player walking a unit away scores 0.5.
  let pos = 0;
  let hp = 0;
  for (const slot of [0, 1] as const) {
    const a = recorded.players[slot];
    const b = branch.players[slot];
    pos += Math.hypot(a.x - b.x, a.y - b.y) / 2;
    // One rifle hit (25 HP) of difference counts as one unit.
    hp += Math.abs(a.hp - b.hp) / 25;
  }
  // The ghost's recorded inputs assume it could (or could not) see you. If that flipped, they are answering a different fight.
  const flip = sawThen !== seesNow ? 1.5 : 0;
  return pos + hp + flip;
}
