import { beforeAll, describe, expect, it, vi } from 'vitest';
import { replayMatch, type MatchFile } from '@rewind/engine';
import { buildClone, GuardedClone } from '../../clone/knn';
import { recordedMatch } from '../../clone/test/fixtures';
import { BasicBot, seededRng } from '../../server/ai';
import { coachMoments } from '../coach';
import { forkState } from '../session';
import { analyzeMatch } from '../summary';
import { PLANS, whatIf } from '../whatif';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let file: MatchFile;
let makePolicy: (seed: number) => GuardedClone;
let FORK = 0;

beforeAll(() => {
  file = recordedMatch('live', 77);
  // 3 seconds before the first kill of a round alice lost: a moment worth asking "what else could I have done?"
  const lost = analyzeMatch(file, false).rounds.find((r) => r.winner === 1 && r.kills.length)!;
  FORK = Math.max(lost.startTick + 16, lost.kills[0].tick - 3 * 32);
  const built = buildClone('bob', [recordedMatch('h1', 11), recordedMatch('h2', 22)]);
  makePolicy = (seed) => new GuardedClone(built.clone.fresh(), new BasicBot(1, 'duel', seededRng(seed)), built.limit);
});

describe('what-if planner', () => {
  it('plays every plan 5 times and returns the top 3, best first', () => {
    const r = whatIf(file, FORK, 0, makePolicy);
    // eslint-disable-next-line no-console
    console.log(`what-if: ${r.futures} futures in ${r.ms} ms; top: ${r.top.map((t) => `${t.name} (${t.score.toFixed(2)})`).join(', ')}; baseline ${r.baseline.score.toFixed(2)}`);
    expect(r.futures).toBe(PLANS.length * 5);
    expect(r.top).toHaveLength(3);
    expect(r.top[0].score).toBeGreaterThanOrEqual(r.top[1].score);
    expect(r.top[1].score).toBeGreaterThanOrEqual(r.top[2].score);
    expect(r.top[0].frames.length).toBeGreaterThan(10);
    expect(r.top[0].reason.length).toBeGreaterThan(5);
    // Right before a fight, the plans really do lead to different futures.
    expect(new Set(r.all.map((a) => a.score)).size).toBeGreaterThan(3);
    // The baseline is what really happened: alice lost this fight.
    expect(r.baseline.fightsWon).toBe(0);
  });

  it('is deterministic: the same fork gives the same ranking', () => {
    const plans = PLANS.slice(0, 4);
    const a = whatIf(file, FORK, 0, makePolicy, plans);
    const b = whatIf(file, FORK, 0, makePolicy, plans);
    expect(a.all).toEqual(b.all);
  });

  it('the coach picks 3 s before each of your last deaths, all inside live rounds', () => {
    const moments = coachMoments(file, 0);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments.length).toBeLessThanOrEqual(3);
    for (const m of moments) {
      expect(m.deathTick - m.tick).toBeLessThanOrEqual(3 * 32);
      expect(forkState(file, m.tick).phase).toBe('live');
      expect(forkState(file, m.tick).players[0].hp).toBeGreaterThan(0);
    }
  });

  it('the baseline replays what really happened', () => {
    const r = whatIf(file, FORK, 0, makePolicy, []);
    const last = r.baseline.frames[r.baseline.frames.length - 1];
    const real = replayMatch(file, last[0]);
    expect(last[1]).toBeCloseTo(real.players[0].x, 1);
    expect(last[6]).toBeCloseTo(real.players[1].x, 1);
  });
});
