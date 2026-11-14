// A rewind session runs on the Node server (hard rule 3: same runtime as the live match). It rebuilds the
// match state at a fork tick, lets the human drive their own slot, and drives the opponent slot like this:
//
//   GHOST   -> replay the opponent's recorded inputs, while the branch still matches the recording
//   HANDOFF -> once divergence crosses the limit, hand the opponent to its guarded clone
//   CLONE   -> the clone acts from what the opponent could see; its circuit breaker may drop to BasicBot
//
// Every opponent decision writes one trace line citing the recorded moment (or rule) it came from. Each
// retry from the same fork tick is a branch; branches and their outcomes are stored.
import {
  IDLE, createMatch, replayMatch, step,
  observe, type GameEvent, type Input, type MatchFile, type Observation, type Policy, type Slot, type State, type TraceEvent,
} from '@rewind/engine';
import { GuardedClone } from '@rewind/clone';
import { DIVERGENCE_LIMIT, divergenceScore } from './divergence';

export type SessionMode = 'ghost' | 'clone';

/** Decodes a match file's delta-encoded input log into a per-tick lookup for one slot. */
export function recordedInputs(file: MatchFile, slot: Slot): Map<number, Input> {
  const m = new Map<number, Input>();
  for (const e of file.inputs) if (e.slot === slot) m.set(e.tick, e.input);
  return m;
}

/** The result of a branch once it ends. */
export type BranchOutcome = {
  branchId: number;
  forkTick: number;
  endTick: number;
  winner: Slot | null;
  humanWon: boolean;
  modeAtEnd: SessionMode;
  handoffTick: number | null; // the tick the ghost handed off to the clone, or null if it never did
  trace: TraceEvent[];
};

/**
 * One rewind session anchored at a fork tick. The caller feeds the human's input each tick and reads back
 * the human's Observation plus the visible events; everything else (ghost, handoff, clone) is internal.
 */
export class RewindSession {
  readonly human: Slot;
  readonly opponent: Slot;
  readonly forkTick: number;
  state: State;
  mode: SessionMode = 'ghost';
  handoffTick: number | null = null;
  readonly trace: TraceEvent[] = [];
  private readonly oppInputs: Map<number, Input>;
  private lastOppInput: Input = IDLE;
  private branchId = 0;
  readonly branches: BranchOutcome[] = [];

  /**
   * @param file the recorded match to fork from
   * @param human the slot the person will control (they are reliving their own side)
   * @param forkTick the tick to rebuild the match at
   * @param clone the opponent's guarded clone, taken over once the ghost diverges
   */
  constructor(
    private readonly file: MatchFile,
    human: Slot,
    forkTick: number,
    private readonly clone: GuardedClone,
    readonly limit: number = DIVERGENCE_LIMIT,
  ) {
    this.human = human;
    this.opponent = (1 - human) as Slot;
    this.forkTick = forkTick;
    this.oppInputs = recordedInputs(file, this.opponent);
    this.clone.attach((e) => this.trace.push(e), this.opponent);
    this.state = replayMatch(file, forkTick);
    // Seed the opponent's "held" input with whatever was in force at the fork tick.
    this.lastOppInput = this.inputAt(forkTick);
  }

  /** The opponent's recorded input in force at a tick: the latest change at or before it. */
  private inputAt(tick: number): Input {
    let inp = IDLE;
    for (const e of this.file.inputs) {
      if (e.slot !== this.opponent) continue;
      if (e.tick <= tick) inp = e.input;
      else break;
    }
    return inp;
  }

  /** The observation the human is allowed to see right now. The client draws only this. */
  humanObs(): Observation {
    return observe(this.state, this.human);
  }

  /** The recorded state at the current tick, for the divergence comparison and the side-by-side trace view. */
  recordedAt(tick: number): State {
    return replayMatch(this.file, tick);
  }

  /**
   * Advances the session one tick with the human's input. Returns the events the human may see.
   * Picks the opponent's input: recorded (ghost) until divergence crosses the limit, then the clone.
   */
  tick(humanInput: Input): GameEvent[] {
    const tick = this.state.tick;

    if (this.mode === 'ghost') {
      const recorded = this.recordedAt(tick);
      const score = divergenceScore(recorded, this.state, this.opponent);
      if (score > this.limit) {
        this.mode = 'clone';
        this.handoffTick = tick;
        this.trace.push({ kind: 'HANDOFF', tick, actor: this.opponent, score, limit: this.limit });
      } else {
        this.trace.push({ kind: 'GHOST', tick, actor: this.opponent, score });
        if (this.oppInputs.has(tick)) this.lastOppInput = this.oppInputs.get(tick)!;
      }
    }

    let oppInput: Input;
    if (this.mode === 'ghost') {
      oppInput = this.lastOppInput;
    } else {
      // The clone (and its breaker) decides from the opponent's observation only.
      oppInput = this.clone.act(observe(this.state, this.opponent)).input;
    }

    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[this.human] = humanInput;
    inputs[this.opponent] = oppInput;
    const { next, events } = step(this.state, inputs);
    this.state = next;
    return events.filter((e) => this.visibleToHuman(e));
  }

  /** Same fog rule the live server uses: an enemy shot/dash only reaches the human if they can see it. */
  private visibleToHuman(e: GameEvent): boolean {
    if (e.type === 'shot') return e.slot === this.human || e.hit;
    if (e.type === 'dash') return e.slot === this.human;
    return true;
  }

  /** True once the round or match this branch is in has ended. */
  get done(): boolean {
    return this.state.phase !== 'live';
  }

  /** Records this branch's outcome and resets to the fork tick for another retry. Returns the outcome. */
  endBranch(): BranchOutcome {
    const winner = this.state.winner ?? this.roundWinner();
    const outcome: BranchOutcome = {
      branchId: this.branchId++,
      forkTick: this.forkTick,
      endTick: this.state.tick,
      winner,
      humanWon: winner === this.human,
      modeAtEnd: this.mode,
      handoffTick: this.handoffTick,
      trace: [...this.trace],
    };
    this.branches.push(outcome);
    this.reset();
    return outcome;
  }

  /** Who won the round that just ended (the score delta from the fork), or null if still live. */
  private roundWinner(): Slot | null {
    const atFork = replayMatch(this.file, this.forkTick);
    for (const slot of [0, 1] as const) {
      if (this.state.score[slot] > atFork.score[slot]) return slot;
    }
    return null;
  }

  /** Rebuilds the fork state for another attempt, clearing the per-branch trace and mode. */
  reset(): void {
    this.state = replayMatch(this.file, this.forkTick);
    this.mode = 'ghost';
    this.handoffTick = null;
    this.trace.length = 0;
    this.lastOppInput = this.inputAt(this.forkTick);
  }
}
