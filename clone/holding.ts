// A decision-holding wrapper. The clones sample ONE decision every DECISION_INTERVAL ticks and hold that
// action between decisions (spec Phase 3: "Sample one decision every 4 ticks. The policy holds its action
// between decisions."). The eval measures the clone exactly at those decision ticks. The live paths
// (what-if, rewind) step every tick, so if they called the clone every tick they would (a) decide 4x too
// often and (b) never let a fire decision persist across its window. This wrapper fixes both: it decides
// on tick t where (t % interval == phase) and replays the held Input on the ticks in between.
//
// Holding also matches how the engine spaces shots: FIRE_COOLDOWN is 8 ticks, so a "fire" held across a
// 4-tick window fires at most once per window, exactly like a person holding the mouse button.
import { type Input, type Observation, type Policy, type TraceRef } from '@rewind/engine';
import { DECISION_INTERVAL } from './dataset';

export class HoldingPolicy implements Policy {
  readonly name: string;
  private held: { input: Input; confidence: number; because: TraceRef[] } | null = null;

  /**
   * @param inner the real policy (factored clone, guarded clone, bot, ...)
   * @param interval decide every this many ticks; between decisions the last input is replayed
   */
  constructor(private readonly inner: Policy, private readonly interval = DECISION_INTERVAL) {
    this.name = `${inner.name}-held`;
  }

  /**
   * Decide only on decision ticks; otherwise replay the held action. Uses the Observation's own tick to
   * phase the decisions, so two wrappers stepping the same match stay aligned with the eval's sampling.
   */
  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    if (this.held === null || obs.tick % this.interval === 0) {
      this.held = this.inner.act(obs);
    }
    return this.held;
  }

  reset(): void {
    this.held = null;
    (this.inner as Policy & { reset?(): void }).reset?.();
  }
}

/** True on a decision tick for the given interval (default 4). */
export function isDecisionTick(tick: number, interval = DECISION_INTERVAL): boolean {
  return tick % interval === 0;
}
