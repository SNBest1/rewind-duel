// The majority-action baseline. It does the dumbest thing that still uses the player's data: always pick
// the single action that player chose most often across their training games. It is the floor a real clone
// must beat — if the KNN clone cannot do better than "always do your most common thing", the clone is not
// learning the situation, only the habit.
import { type Input, type Observation, type Policy, type TraceRef } from '@rewind/engine';
import { decodeAction, type Action } from './actions';
import type { Sample } from './dataset';

export class MajorityBaseline implements Policy {
  readonly name: string;
  private readonly action: Action;
  private readonly share: number; // what fraction of decisions this one action was

  constructor(playerName: string, samples: Sample[]) {
    this.name = `${playerName}-majority`;
    const count = new Map<number, { n: number; action: Action }>();
    for (const s of samples) {
      const e = count.get(s.actionId) ?? { n: 0, action: s.action };
      e.n++;
      count.set(s.actionId, e);
    }
    let best: { n: number; action: Action } | null = null;
    for (const e of count.values()) if (!best || e.n > best.n) best = e;
    // No samples: fall back to "stand still", a valid IDLE-ish action.
    this.action = best?.action ?? { move: 0, walk: false, aimBucket: 2, fire: false, smoke: false, dash: false, use: false };
    this.share = samples.length ? (best?.n ?? 0) / samples.length : 0;
  }

  /** The share of training decisions that were this one action. Reported so the baseline is legible. */
  get majorityShare(): number {
    return this.share;
  }

  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    // The stored aim offset is re-pointed at the current enemy, exactly like the clone (decodeAction),
    // so the baseline is a fair comparison: same action space, no situational choice.
    return { input: decodeAction(this.action, obs), confidence: this.share, because: [] };
  }
}
