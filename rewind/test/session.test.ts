import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDLE, hashState, observe, replayMatch, type Input, type MatchFile, type State } from '@rewind/engine';
import { buildClone, GuardedClone } from '../../clone/knn';
import { recordedMatch } from '../../clone/test/fixtures';
import { BasicBot, seededRng } from '../../server/ai';
import { MatchRunner } from '../../server/match';
import { DIVERGENCE_LIMIT, divergenceScore } from '../divergence';
import { forkState, inputsAt, replayBranch, runBranch, RewindDriver, type BranchFile } from '../session';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let file: MatchFile;
let history: MatchFile[];
const FORK = 200; // 6 seconds into round 1

beforeAll(() => {
  file = recordedMatch('live', 77);
  history = [recordedMatch('h1', 11), recordedMatch('h2', 22)];
});

/** The human (alice, slot 0) presses exactly what she pressed in the recording. */
function asRecorded(f: MatchFile) {
  const cur = inputsAt(f, FORK);
  let i = f.inputs.findIndex((e) => e.tick > FORK);
  return (s: State): Input => {
    while (i >= 0 && i < f.inputs.length && f.inputs[i].tick === s.tick) {
      cur[f.inputs[i].slot] = f.inputs[i].input;
      i++;
    }
    return cur[0];
  };
}

const cloneOfBob = () => {
  const built = buildClone('bob', history);
  return () => new GuardedClone(built.clone.fresh(), new BasicBot(1, 'duel', seededRng(3)), built.limit);
};

describe('divergence', () => {
  it('is zero for identical states and grows with distance', () => {
    const s = forkState(file, FORK);
    expect(divergenceScore(s, s, 1)).toBe(0);
    const moved = structuredClone(s);
    moved.players[0].x += 4;
    expect(divergenceScore(s, moved, 1)).toBeGreaterThanOrEqual(2);
  });
});

describe('rewind session', () => {
  it('ghost replays the recording exactly while you play it the same way', () => {
    const { state, driver, trace } = runBranch(file, FORK, 0, asRecorded(file), cloneOfBob());
    expect(driver.mode).toBe('ghost');
    expect(driver.handoffTick).toBeNull();
    expect(trace.map((t) => t.type)).toEqual(['START']);
    // Same moment, same state as the original match.
    expect(hashState(state)).toBe(hashState(replayMatch(file, state.tick)));
  });

  it('hands the opponent to the clone once you change the fight', () => {
    // Alice just stands still this time.
    const { driver, trace } = runBranch(file, FORK, 0, (s) => ({ ...IDLE, aim: s.players[0].aim }), cloneOfBob());
    expect(driver.mode).toBe('clone');
    const handoff = trace.find((t) => t.type === 'HANDOFF');
    expect(handoff?.reason).toMatch(/divergence \d+\.\d+ > 2\.5/);
    expect(driver.lastScore).toBeGreaterThan(DIVERGENCE_LIMIT);
  });

  it('writes a branch that replays to its own final hash', () => {
    const start = forkState(file, FORK);
    const runner = new MatchRunner('b', file.seed, ['alice', 'bob'], file.map, start);
    const driver = new RewindDriver(file, FORK, 0, cloneOfBob());
    for (let n = 0; n < 1500 && runner.state.phase === 'live' && runner.state.round === start.round; n++) {
      const o = observe(runner.state, 0);
      runner.setInput(0, { ...IDLE, move: { x: 1, y: 0 }, aim: o.self.aim, fire: !!o.enemy });
      runner.setInput(1, driver.opponentInput(runner.state));
      runner.tick();
    }
    const branch: BranchFile = {
      match: file.id, forkTick: FORK, human: 0, opponent: 'bob', inputs: JSON.parse(JSON.stringify(runner.inputLog)),
      ticks: runner.state.tick, finalHash: hashState(runner.state), outcome: 'lost', reason: '', handoffTick: driver.handoffTick,
      breakerTicks: 0, at: '',
    };
    expect(hashState(replayBranch(file, branch))).toBe(branch.finalHash);
  });
});
