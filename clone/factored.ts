// Factored k-NN clone. The joint clone (knn.ts) votes on ONE action id, so a rare combination (this exact
// move + this exact aim + fire) splits the k neighbors into singletons and the vote is noisy. The factored
// clone finds the k nearest moments once, then runs THREE separate votes over those neighbors:
//   - move: distance-weighted vote over the 9 move options
//   - aim : distance-weighted vote over the aim-offset buckets
//   - fire: distance-weighted vote over fire/no-fire, but ONLY over neighbors whose enemy-visibility state
//           matches the current one — because "do I shoot" depends entirely on whether an enemy is in sight,
//           and mixing visible and hidden neighbors is what made the joint clone almost never fire.
// It is still pure k-NN (hard rule 5): no training, no LLM. The model is the sample set.
import { type Input, type Observation, type Policy, type TraceRef } from '@rewind/engine';
import { AIM_BUCKETS, MOVE_OPTIONS, NUM_ACTIONS, enemyDirection } from './actions';
import { extractFeatures } from './features';
import type { Sample } from './dataset';

const K = 7;

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/** The winning value of a distance-weighted vote, plus its share of the total weight (confidence). */
function voteWinner<T>(entries: { value: T; weight: number }[]): { value: T | null; confidence: number } {
  const tally = new Map<string, { value: T; w: number }>();
  let total = 0;
  for (const e of entries) {
    const key = JSON.stringify(e.value);
    const t = tally.get(key) ?? { value: e.value, w: 0 };
    t.w += e.weight;
    tally.set(key, t);
    total += e.weight;
  }
  let best: { value: T; w: number } | null = null;
  for (const t of tally.values()) if (!best || t.w > best.w) best = t;
  return { value: best ? best.value : null, confidence: total > 0 && best ? best.w / total : 0 };
}

export type FactoredDecision = {
  input: Input;
  nnDist: number;
  moveConfidence: number;
  fireConfidence: number;
  aimConfidence: number;
  fireNeighbors: number; // how many of the k neighbors shared the current visibility state (fed the fire vote)
  because: TraceRef[];
};

/**
 * A factored k-NN clone. `act` returns an Input; the extra per-field confidences are available via
 * `decision()` for the trace and the eval. Holds no state between calls except the previous action id,
 * which is a feature; `reset()` clears it.
 */
export class FactoredClone implements Policy {
  readonly name: string;
  private prevAction = -1;

  constructor(playerName: string, private readonly samples: Sample[]) {
    this.name = `${playerName}-factored`;
  }

  /** Nearest-neighbor distance only, for the circuit breaker. */
  nnDistance(obs: Observation): number {
    const f = extractFeatures(obs, this.prevAction, NUM_ACTIONS);
    let best = Infinity;
    for (const s of this.samples) {
      const d = dist2(f, s.features);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** The full factored decision for an observation, without advancing prevAction. */
  decision(obs: Observation): FactoredDecision {
    const f = extractFeatures(obs, this.prevAction, NUM_ACTIONS);
    const scored = this.samples.map((s, idx) => ({ idx, d2: dist2(f, s.features) }));
    scored.sort((a, b) => a.d2 - b.d2);
    const top = scored.slice(0, Math.min(K, scored.length));
    const nnDist = Math.sqrt(top[0]?.d2 ?? Infinity);
    const w = (d2: number) => 1 / (Math.sqrt(d2) + 0.1);

    // Move vote: over all k neighbors.
    const move = voteWinner(top.map(({ idx, d2 }) => ({ value: this.samples[idx].action.move, weight: w(d2) })));
    // Aim vote: over all k neighbors.
    const aim = voteWinner(top.map(({ idx, d2 }) => ({ value: this.samples[idx].action.aimBucket, weight: w(d2) })));
    // Fire vote: ONLY neighbors whose recorded visibility matches the current one.
    const enemyVisible = obs.enemy !== null;
    const fireNeighbors = top.filter(({ idx }) => this.samples[idx].enemyVisible === enemyVisible);
    const fire = voteWinner(fireNeighbors.map(({ idx, d2 }) => ({ value: this.samples[idx].action.fire, weight: w(d2) })));

    const moveIdx = move.value ?? 0;
    const aimIdx = aim.value ?? 2; // bucket 2 is offset 0
    // With no same-visibility neighbor, default to not firing (safer than guessing from mismatched context).
    const willFire = fire.value === true;

    const dir = enemyDirection(obs);
    const aimAngle = dir === null ? obs.self.aim : angleWrap(dir + AIM_BUCKETS[aimIdx]);
    const input: Input = {
      move: MOVE_OPTIONS[moveIdx],
      walk: false, // the factored clone does not model walk/run separately; running is the common case
      aim: aimAngle,
      fire: willFire,
      reload: obs.self.ammo === 0 && obs.self.reloadTicks === 0,
      smoke: false,
      dash: false,
      use: false,
    };

    const because: TraceRef[] = top.map(({ idx, d2 }) => ({ ...this.samples[idx].ref, weight: w(d2) }));
    return {
      input, nnDist,
      moveConfidence: move.confidence,
      fireConfidence: fire.confidence,
      aimConfidence: aim.confidence,
      fireNeighbors: fireNeighbors.length,
      because,
    };
  }

  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    const d = this.decision(obs);
    // prevAction uses the move vote as a coarse previous-action signal (joint id is not formed here).
    this.prevAction = d.input.move.x * 3 + d.input.move.y; // small stable integer; feature normalizes it
    return { input: d.input, confidence: d.moveConfidence, because: d.because };
  }

  reset(): void {
    this.prevAction = -1;
  }
}

function angleWrap(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
