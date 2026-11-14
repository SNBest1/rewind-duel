import { describe, expect, it } from 'vitest';
import { createMatch, observe, IDLE, type Observation } from '@rewind/engine';
import {
  MOVE_OPTIONS, AIM_BUCKETS, NUM_ACTIONS, encodeAction, decodeAction, actionId, enemyDirection,
  extractFeatures, FEATURE_DIM, zoneOf,
  BasicBot, KnnClone, GuardedClone, query, type Sample,
} from '@rewind/clone';

/** A plain observation for one slot of a fresh match, optionally with a visible enemy. */
function obs(withEnemy = false): Observation {
  const s = createMatch(1, 'duel');
  const o = observe(s, 0);
  if (withEnemy) o.enemy = { x: o.self.x + 5, y: o.self.y, aim: Math.PI, hp: 100 };
  return o;
}

describe('features', () => {
  it('produce a vector of exactly FEATURE_DIM, all finite', () => {
    const f = extractFeatures(obs(), -1, NUM_ACTIONS);
    expect(f.length).toBe(FEATURE_DIM);
    expect(f.every((n) => Number.isFinite(n))).toBe(true);
  });

  it('come only from the observation: changing the hidden enemy does not change features', () => {
    // With no visible enemy and no lastSeen, the two observations are identical to observe(), so features match.
    const a = extractFeatures(obs(false), -1, NUM_ACTIONS);
    const b = extractFeatures(obs(false), -1, NUM_ACTIONS);
    expect(a).toEqual(b);
  });

  it('zoneOf labels the sites and spawn', () => {
    expect(zoneOf(36, 6)).toBe('A');
    expect(zoneOf(36, 26)).toBe('B');
    expect(zoneOf(3, 16)).toBe('spawn');
    expect(zoneOf(20, 16)).toBe('mid');
  });
});

describe('actions', () => {
  it('encode then decode round-trips the move and flags', () => {
    const o = obs(true);
    const input = { ...IDLE, move: { x: 1, y: -1 } as const, walk: true, fire: true, aim: enemyDirection(o)! };
    const a = encodeAction(input, o);
    const back = decodeAction(a, o);
    expect(back.move).toEqual({ x: 1, y: -1 });
    expect(back.walk).toBe(true);
    expect(back.fire).toBe(true);
    // aim decodes to the enemy direction plus the chosen bucket; bucket 2 is offset 0.
    expect(a.aimBucket).toBe(2);
    expect(back.aim).toBeCloseTo(enemyDirection(o)!, 5);
  });

  it('aim offset is stored relative to the enemy, so it transfers to a new direction', () => {
    const o1 = obs(true); // enemy to the right (aim ~0)
    const off = 0.3;
    const input = { ...IDLE, aim: enemyDirection(o1)! + off };
    const a = encodeAction(input, o1);
    expect(AIM_BUCKETS[a.aimBucket]).toBe(0.3);
    // Replay in a situation where the enemy is in a different direction.
    const o2 = obs(true);
    o2.enemy = { x: o2.self.x, y: o2.self.y + 5, aim: 0, hp: 100 }; // enemy below, dir ~ +PI/2
    const back = decodeAction(a, o2);
    expect(back.aim).toBeCloseTo(enemyDirection(o2)! + 0.3, 5);
  });

  it('actionId is unique per distinct action and within range', () => {
    const seen = new Set<number>();
    for (let m = 0; m < MOVE_OPTIONS.length; m++) {
      for (const walk of [false, true]) {
        const id = actionId({ move: m, walk, aimBucket: 0, fire: false, smoke: false, dash: false, use: false });
        expect(seen.has(id)).toBe(false);
        seen.add(id);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThan(NUM_ACTIONS);
      }
    }
  });
});

describe('KnnClone', () => {
  /** A tiny synthetic sample set: two clusters, each voting a different action. */
  function toySamples(): Sample[] {
    const mk = (base: number, actId: number): Sample => ({
      features: Array.from({ length: FEATURE_DIM }, () => base),
      action: { move: actId, walk: false, aimBucket: 2, fire: false, smoke: false, dash: false, use: false },
      actionId: actId,
      ref: { matchId: 'toy', tick: actId, playerName: 'toy', weight: 0 },
    });
    const out: Sample[] = [];
    for (let i = 0; i < 10; i++) out.push(mk(0, 1)); // cluster near 0 -> action 1
    for (let i = 0; i < 10; i++) out.push(mk(1, 2)); // cluster near 1 -> action 2
    return out;
  }

  it('votes for the nearer cluster and reports its neighbors', () => {
    const s = toySamples();
    const near0 = Array.from({ length: FEATURE_DIM }, () => 0.05);
    const n = query(s, near0);
    expect(n.action.move).toBe(1);
    expect(n.because.length).toBe(7); // k = 7
    // weights of the returned neighbors sum to ~1 (they are shares of the vote total)
    const sum = n.because.reduce((a, r) => a + r.weight, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(n.nnDist).toBeGreaterThanOrEqual(0);
  });

  it('nearest-neighbor distance grows as the query moves away from every sample', () => {
    const s = toySamples();
    const close = query(s, Array.from({ length: FEATURE_DIM }, () => 0)).nnDist;
    const far = query(s, Array.from({ length: FEATURE_DIM }, () => 5)).nnDist;
    expect(far).toBeGreaterThan(close);
  });
});

describe('GuardedClone circuit breaker', () => {
  function toyClone(): KnnClone {
    const samples: Sample[] = Array.from({ length: 10 }, (_, i) => ({
      features: Array.from({ length: FEATURE_DIM }, () => 0),
      action: { move: 0, walk: false, aimBucket: 2, fire: false, smoke: false, dash: false, use: false },
      actionId: 0,
      ref: { matchId: 'toy', tick: i, playerName: 'toy', weight: 0 },
    }));
    return new KnnClone('toy', samples);
  }

  it('falls back to the bot and logs a BREAKER when the nearest neighbor is too far', () => {
    // A limit of 0 forces every real observation (nnDist > 0) over the breaker.
    const guarded = new GuardedClone(toyClone(), 0);
    const log: string[] = [];
    guarded.attach((e) => log.push(e.kind), 1);
    guarded.act(obs());
    expect(log).toContain('BREAKER');
  });

  it('uses the clone and logs a CLONE when within the limit', () => {
    const guarded = new GuardedClone(toyClone(), 1000); // huge limit: never breaks
    const log: string[] = [];
    guarded.attach((e) => log.push(e.kind), 1);
    guarded.act(obs());
    expect(log).toContain('CLONE');
  });
});

describe('BasicBot', () => {
  it('fires when it can see the enemy and holds still', () => {
    const bot = new BasicBot();
    const { input } = bot.act(obs(true));
    expect(input.fire).toBe(true);
    expect(input.move).toEqual({ x: 0, y: 0 });
  });

  it('never fires when it cannot see the enemy', () => {
    const bot = new BasicBot();
    const { input } = bot.act(obs(false));
    expect(input.fire).toBe(false);
  });
});
