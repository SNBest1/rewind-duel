// A rewind session: jump into a recorded match at any tick, take your own slot, and the opponent
// first replays exactly what they did (ghost) and then, once the fight has drifted, is handed to a clone.
import {
  IDLE, observe, replayMatch, step,
  type GameEvent, type Input, type MatchFile, type Slot, type State,
} from '@rewind/engine';
import type { Policy, TraceLine } from '../clone/policy';
import { DIVERGENCE_LIMIT, divergenceScore } from '../../rewind/divergence';

export type BranchOutcome = 'won' | 'lost';

/** A retry from a fork tick, stored so it can be replayed: the original match up to `forkTick`, then these inputs. */
export type BranchFile = {
  match: string;
  forkTick: number;
  human: Slot;
  opponent: string;
  inputs: MatchFile['inputs'];
  ticks: number; // tick the branch ended on
  finalHash: string;
  outcome: BranchOutcome;
  reason: string;
  handoffTick: number | null;
  breakerTicks: number;
  at: string;
};

/** The state of the original match at `tick`, which is where a branch starts. */
export function forkState(file: MatchFile, tick: number): State {
  return replayMatch(file, tick);
}

/** Rebuilds a branch's final state from the original match and the branch's own inputs. */
export function replayBranch(file: MatchFile, branch: BranchFile): State {
  let s = forkState(file, branch.forkTick);
  // The inputs in force at the fork carry over until the branch log changes them.
  const cur = inputsAt(file, branch.forkTick);
  let i = 0;
  while (s.tick < branch.ticks) {
    while (i < branch.inputs.length && branch.inputs[i].tick === s.tick) {
      cur[branch.inputs[i].slot] = branch.inputs[i].input;
      i++;
    }
    s = step(s, cur).next;
  }
  return s;
}

/** The input each slot had in force at `tick` in a recorded match (the last change at or before it). */
export function inputsAt(file: MatchFile, tick: number): [Input, Input] {
  const cur: [Input, Input] = [IDLE, IDLE];
  for (const e of file.inputs) {
    if (e.tick > tick) break;
    cur[e.slot] = e.input;
  }
  return cur;
}

/**
 * Drives the opponent slot of a branch. Call `opponentInput(branch)` before each branch tick and
 * `afterTick(events)` after it. The recorded match is stepped alongside, so the ghost can be compared against it.
 */
export class RewindDriver {
  readonly opponent: Slot;
  mode: 'ghost' | 'clone' = 'ghost';
  handoffTick: number | null = null;
  lastScore = 0;
  private recorded: State;
  private recordedInputs: [Input, Input];
  private cursor: number;
  private policy: Policy | null = null;

  constructor(
    readonly file: MatchFile,
    readonly forkTick: number,
    readonly human: Slot,
    private makePolicy: () => Policy,
    private trace: (t: TraceLine) => void = () => {},
    readonly limit = DIVERGENCE_LIMIT,
    /** The recorded state at forkTick, if the caller already has it (replaying to it costs a full replay). */
    start?: State,
  ) {
    this.opponent = (1 - human) as Slot;
    this.recorded = start ? structuredClone(start) : forkState(file, forkTick);
    this.recordedInputs = inputsAt(file, forkTick);
    this.cursor = file.inputs.findIndex((e) => e.tick > forkTick);
    if (this.cursor < 0) this.cursor = file.inputs.length;
    this.trace({ tick: forkTick, actor: 'GHOST', type: 'START', reason: `${this.opponentName} replays exactly what they did at this moment` });
  }

  get opponentName(): string {
    return this.file.players.find((p) => p.slot === this.opponent)?.name ?? 'opponent';
  }

  /** The opponent's input for the branch's next tick. */
  opponentInput(branch: State): Input {
    if (this.mode === 'ghost') {
      // The recorded inputs for this tick.
      while (this.cursor < this.file.inputs.length && this.file.inputs[this.cursor].tick === this.recorded.tick) {
        const e = this.file.inputs[this.cursor];
        this.recordedInputs[e.slot] = e.input;
        this.cursor++;
      }
      const recordedLive = this.recorded.phase === 'live' && this.recorded.round === branch.round && this.recorded.tick < this.file.ticks;
      this.lastScore = recordedLive ? divergenceScore(this.recorded, branch, this.opponent) : Infinity;
      if (this.lastScore > this.limit) {
        this.mode = 'clone';
        this.handoffTick = branch.tick;
        this.policy = this.makePolicy();
        this.trace({
          tick: branch.tick, actor: 'CLONE', type: 'HANDOFF',
          reason: recordedLive
            ? `divergence ${this.lastScore.toFixed(2)} > ${this.limit}: you changed the fight, ${this.policy.name} takes over`
            : `the recording has no more of this round, ${this.policy.name} takes over`,
        });
      } else {
        const input = this.recordedInputs[this.opponent];
        this.recorded = step(this.recorded, this.recordedInputs).next;
        return input;
      }
    }
    return this.policy!.act(observe(branch, this.opponent)).input;
  }
}

/** Plays a whole branch headlessly with a scripted human. Used by tests and evals. */
export function runBranch(
  file: MatchFile, forkTick: number, human: Slot, humanInput: (s: State) => Input, makePolicy: () => Policy, maxTicks = 3000,
): { state: State; driver: RewindDriver; events: GameEvent[]; trace: TraceLine[] } {
  const trace: TraceLine[] = [];
  const driver = new RewindDriver(file, forkTick, human, makePolicy, (t) => trace.push(t));
  let s = forkState(file, forkTick);
  const startRound = s.round;
  const events: GameEvent[] = [];
  for (let n = 0; n < maxTicks && s.phase === 'live' && s.round === startRound; n++) {
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[human] = humanInput(s);
    inputs[driver.opponent] = driver.opponentInput(s);
    const r = step(s, inputs);
    s = r.next;
    events.push(...r.events);
  }
  return { state: s, driver, events, trace };
}
