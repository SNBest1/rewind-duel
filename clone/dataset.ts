// Turns recorded matches into (features, action) samples for one player, one per 4 ticks of live play.
// Samples carry a TraceRef back to the exact match and tick they came from, so a clone decision is auditable.
import {
  IDLE, createMatch, observe, step,
  type Input, type MatchFile, type Observation, type Slot, type State, type TraceRef,
} from '@rewind/engine';
import { type Action, encodeAction, actionId, NUM_ACTIONS } from './actions';
import { extractFeatures, FEATURE_DIM } from './features';

/** The decision interval: the clone samples (and holds) one action every 4 ticks (spec Phase 3). */
export const DECISION_INTERVAL = 4;

export type Sample = {
  features: number[];
  action: Action;
  actionId: number;
  enemyVisible: boolean; // was the enemy in sight when this was recorded? the factored fire vote needs it
  ref: TraceRef; // matchId, tick, playerName — the moment this was copied from
};

/** The slot a named player holds in a match file, or -1 if they are not in it. */
export function slotOf(file: MatchFile, playerName: string): Slot | -1 {
  const p = file.players.find((p) => p.name === playerName);
  return p ? p.slot : -1;
}

/** True when the same name holds both slots — one person played themselves. Such a match is not a real
 *  duel, so it is excluded from training and eval (and flagged), per the user's instruction. */
export function isSelfMatch(file: MatchFile): boolean {
  return file.players.length === 2 && file.players[0].name === file.players[1].name;
}

/**
 * Replays a match and samples one slot's decisions every DECISION_INTERVAL live ticks.
 * Only live, alive moments produce samples: a dead or intermission tick is not a decision.
 */
export function samplesFromMatch(file: MatchFile, slot: Slot, playerName: string): Sample[] {
  const samples: Sample[] = [];
  let s: State = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  let prevAction = -1;

  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.phase === 'live' && s.players[slot].hp > 0 && s.tick % DECISION_INTERVAL === 0) {
      const o: Observation = observe(s, slot);
      const action = encodeAction(current[slot], o);
      const id = actionId(action);
      samples.push({
        features: extractFeatures(o, prevAction, NUM_ACTIONS),
        action,
        actionId: id,
        enemyVisible: o.enemy !== null,
        ref: { matchId: file.id, tick: s.tick, playerName, weight: 0 },
      });
      prevAction = id;
    }
    s = step(s, current).next;
  }
  return samples;
}

/** Sanity: every sample vector is the agreed width. Cheap guard against a features.ts/dataset.ts drift. */
export function assertShape(samples: Sample[]): void {
  for (const s of samples) {
    if (s.features.length !== FEATURE_DIM) {
      throw new Error(`feature vector width ${s.features.length} != FEATURE_DIM ${FEATURE_DIM}`);
    }
  }
}
