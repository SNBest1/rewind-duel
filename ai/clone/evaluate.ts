import { IDLE, createMatch, observe, step, type Input, type MatchFile, type Slot } from '@rewind/engine';
import { moveIndex } from './features';
import { samplesFromMatch, type Sample } from './knn';
import type { Policy } from './policy';

export type Agreement = { move: number; fire: number; n: number };

/**
 * Plays back a recorded match and, at every recorded decision of `slot`, asks `policy` what it would do in that exact
 * situation. Returns the share of decisions where it picks the same move direction / fire choice as the real player.
 * A fresh policy is made each round, the way a rewind session starts one.
 */
export function agreement(makePolicy: () => Policy, file: MatchFile, slot: Slot): Agreement {
  const samples = new Map<number, Sample>(samplesFromMatch(file, slot).map((s) => [s.ref.tick, s]));
  let s = createMatch(file.seed, file.map, file.rules ?? 'classic'); // the rules it was played under, or it replays differently
  const cur: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  let p = makePolicy();
  let round = s.round;
  let move = 0;
  let fire = 0;
  let n = 0;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      cur[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.round !== round) {
      round = s.round;
      p = makePolicy();
    }
    if (s.phase === 'live' && s.players[slot].hp > 0) {
      const guess = p.act(observe(s, slot)).input;
      const truth = samples.get(s.tick);
      if (truth) {
        n++;
        if (moveIndex(guess.move) === truth.a.move) move++;
        if (guess.fire === truth.a.fire) fire++;
      }
    }
    s = step(s, cur).next;
  }
  return { move: n ? move / n : 0, fire: n ? fire / n : 0, n };
}
