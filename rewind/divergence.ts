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

  // TODO(human): combine position drift (both players), HP drift (both players) and the
  // visibility flip (sawThen !== seesNow) into one number, and return it.
  return 0;
}
