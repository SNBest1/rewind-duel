// K-nearest-neighbor clone. No training, no LLM (hard rule 5): the "model" is the sample set, and a
// decision is a distance-weighted vote of the k closest recorded moments. `because` names those moments.
import { type Input, type Observation, type Policy, type TraceRef } from '@rewind/engine';
import { actionId, decodeAction, NUM_ACTIONS, type Action } from './actions';
import { extractFeatures } from './features';
import type { Sample } from './dataset';

const K = 7;

/** Squared Euclidean distance between two equal-length vectors. Squared is fine: we only rank. */
function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** The result of a lookup: the chosen action, the k neighbors that voted, and the nearest distance. */
export type Neighborhood = {
  action: Action;
  nnDist: number; // Euclidean distance to the single nearest neighbor (feeds the circuit breaker)
  confidence: number; // winning action's share of the weighted vote, 0..1
  because: TraceRef[]; // the neighbors, each weighted by its vote share
};

/** Finds the k nearest samples to a feature vector and votes on an action, distance-weighted. */
export function query(samples: Sample[], features: number[]): Neighborhood {
  // Partial selection of the k smallest distances. samples is a few thousand, so a full scan is fine.
  const scored = samples.map((s, idx) => ({ idx, d2: dist2(features, s.features) }));
  scored.sort((a, b) => a.d2 - b.d2);
  const top = scored.slice(0, Math.min(K, scored.length));

  const nnDist = Math.sqrt(top[0]?.d2 ?? Infinity);

  // Distance-weighted vote. Weight 1/(d+eps) so a near neighbor counts more; group by action id.
  const voteByAction = new Map<number, number>();
  const sampleByAction = new Map<number, Sample>();
  let total = 0;
  for (const { idx, d2 } of top) {
    const s = samples[idx];
    const w = 1 / (Math.sqrt(d2) + 0.1);
    voteByAction.set(s.actionId, (voteByAction.get(s.actionId) ?? 0) + w);
    if (!sampleByAction.has(s.actionId)) sampleByAction.set(s.actionId, s);
    total += w;
  }

  let winner = -1;
  let winVote = -1;
  for (const [id, v] of voteByAction) {
    if (v > winVote) {
      winVote = v;
      winner = id;
    }
  }

  const action = sampleByAction.get(winner)!.action;
  const confidence = total > 0 ? winVote / total : 0;

  // because: the top neighbors, each weighted by its vote share of the total.
  const because: TraceRef[] = top.map(({ idx, d2 }) => ({
    ...samples[idx].ref,
    weight: (1 / (Math.sqrt(d2) + 0.1)) / total,
  }));

  return { action, nnDist, confidence, because };
}

/**
 * A pure KNN clone of one player. Holds its action between decisions in the caller (the server/eval loop);
 * every call is a fresh independent vote. Confidence and nnDist are exposed for the circuit breaker.
 */
export class KnnClone implements Policy {
  readonly name: string;
  private prevAction = -1;

  constructor(playerName: string, private readonly samples: Sample[]) {
    this.name = `${playerName}-clone`;
  }

  /** The nearest-neighbor distance for an observation, without committing to the action. Used to set the breaker. */
  nnDistance(obs: Observation): number {
    return query(this.samples, extractFeatures(obs, this.prevAction, NUM_ACTIONS)).nnDist;
  }

  /** The full vote for an observation. The guard wrapper calls this so it needs no second query. */
  neighborhood(obs: Observation): Neighborhood {
    return query(this.samples, extractFeatures(obs, this.prevAction, NUM_ACTIONS));
  }

  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    const n = this.neighborhood(obs);
    this.prevAction = actionId(n.action); // next feature vector remembers what we just chose
    const input = decodeAction(n.action, obs);
    return { input, confidence: n.confidence, because: n.because };
  }
}
