import { createMatch, step } from './engine';
import { IDLE, type Input, type MatchFile, type State } from './types';

/** Rebuilds the state at `untilTick` (default: the end) from a match file's seed and input log. */
export function replayMatch(file: MatchFile, untilTick: number = file.ticks): State {
  let s = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  while (s.tick < untilTick) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    s = step(s, current).next;
  }
  return s;
}
