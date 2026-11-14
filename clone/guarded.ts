// The circuit breaker. Wraps a KnnClone: if the nearest recorded moment is farther than the breaker
// limit, the clone is facing a situation it has never seen, so a hand-written BasicBot takes over and a
// BREAKER line is written. Otherwise the clone acts and a CLONE line cites the neighbors it copied.
import { describeAction, type Input, type Observation, type Policy, type Slot, type TraceEvent, type TraceRef } from '@rewind/engine';
import { BasicBot } from './bot';
import { KnnClone } from './knn';

/** Where a GuardedClone writes its trace. The server and eval pass a sink; a lone clone can ignore it. */
export type TraceSink = (e: TraceEvent) => void;

export class GuardedClone implements Policy {
  readonly name: string;
  private readonly bot = new BasicBot();
  private actor: Slot = 0;
  private sink: TraceSink | null = null;

  /**
   * @param clone the player's KNN clone
   * @param breakerLimit the nearest-neighbor distance above which the bot takes over
   *        (the 95th percentile of held-out nearest-neighbor distances; see build.ts)
   */
  constructor(private readonly clone: KnnClone, readonly breakerLimit: number) {
    this.name = `${clone.name}-guarded`;
  }

  /** Point the trace somewhere and say which slot this policy drives, so lines are attributable. */
  attach(sink: TraceSink, actor: Slot): void {
    this.sink = sink;
    this.actor = actor;
  }

  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    const n = this.clone.neighborhood(obs);
    if (n.nnDist > this.breakerLimit) {
      const r = this.bot.act(obs);
      this.sink?.({
        kind: 'BREAKER', tick: obs.tick, actor: this.actor,
        nnDist: n.nnDist, limit: this.breakerLimit,
        reason: `nearest recorded moment ${n.nnDist.toFixed(2)} > limit ${this.breakerLimit.toFixed(2)}; using ${this.bot.name}`,
      });
      return r;
    }
    // Within range: copy the clone. Keep its prevAction in step by calling act (it returns the same vote).
    const r = this.clone.act(obs);
    this.sink?.({
      kind: 'CLONE', tick: obs.tick, actor: this.actor,
      nnDist: n.nnDist, confidence: r.confidence, because: r.because,
      action: describeAction(r.input),
    });
    return r;
  }

  /** True when the breaker would fire for this observation. Lets eval measure the handoff rate without acting. */
  wouldBreak(obs: Observation): boolean {
    return this.clone.neighborhood(obs).nnDist > this.breakerLimit;
  }
}
