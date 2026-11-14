import { describe, expect, it } from 'vitest';
import { createMatch, observe, type Input, type State } from '@rewind/engine';
import { GuardedClone, KnnClone, FEATURE_DIM, type Sample } from '@rewind/clone';
import { PLANS, evaluatePlans } from '@rewind/rewind';

/** A guarded clone that always holds still and never shoots, so plan ranking depends on the human alone. */
function passiveClone(): GuardedClone {
  const samples: Sample[] = Array.from({ length: 8 }, (_, i) => ({
    features: Array.from({ length: FEATURE_DIM }, () => 0),
    action: { move: 0, walk: false, aimBucket: 2, fire: false, smoke: false, dash: false, use: false },
    actionId: 0,
    enemyVisible: false,
    ref: { matchId: 'passive', tick: i, playerName: 'passive', weight: 0 },
  }));
  return new GuardedClone(new KnnClone('passive', samples), 1e9);
}

/** A fork state with both players close together and facing each other, so a "shoot" plan can connect. */
function engagementFork(): State {
  let s: State = createMatch(5, 'duel');
  // Nudge the two spawns toward each other across mid so they are within range and sightline.
  s.players[0].x = 20; s.players[0].y = 16; s.players[0].aim = 0;
  s.players[1].x = 26; s.players[1].y = 16; s.players[1].aim = Math.PI;
  return s;
}

describe('whatif plans', () => {
  it('there are about twenty plans, each with a stable id and label', () => {
    expect(PLANS.length).toBeGreaterThanOrEqual(18);
    expect(PLANS.length).toBeLessThanOrEqual(24);
    const ids = new Set(PLANS.map((p) => p.id));
    expect(ids.size).toBe(PLANS.length); // ids are unique
    expect(PLANS.every((p) => p.label.length > 0)).toBe(true);
  });

  it('every plan returns a well-formed Input for a fresh observation', () => {
    const s = engagementFork();
    for (const p of PLANS) {
      const input: Input = p.act(observe(s, 0), 0);
      expect([-1, 0, 1]).toContain(input.move.x);
      expect([-1, 0, 1]).toContain(input.move.y);
      expect(Number.isFinite(input.aim)).toBe(true);
    }
  });

  it('is deterministic: evaluating the same fork twice gives identical results', () => {
    const fork = engagementFork();
    const a = evaluatePlans(fork, 0, passiveClone());
    const b = evaluatePlans(fork, 0, passiveClone());
    expect(a.map((r) => `${r.id}:${r.score.toFixed(4)}`)).toEqual(b.map((r) => `${r.id}:${r.score.toFixed(4)}`));
  });

  it('ranks the shooting plan above the back-off plan when the human can win the duel', () => {
    const fork = engagementFork();
    const ranked = evaluatePlans(fork, 0, passiveClone());
    const stopShoot = ranked.findIndex((r) => r.id === 'stop-shoot');
    const backoffWait = ranked.findIndex((r) => r.id === 'backoff-run-hold');
    expect(stopShoot).toBeGreaterThanOrEqual(0);
    expect(backoffWait).toBeGreaterThanOrEqual(0);
    // Against a passive clone standing in the open, shooting should win; backing off and waiting does not.
    expect(ranked[stopShoot].winRate).toBeGreaterThan(ranked[backoffWait].winRate);
    expect(ranked[stopShoot].score).toBeGreaterThan(ranked[backoffWait].score);
  });

  it('results are sorted best score first', () => {
    const ranked = evaluatePlans(engagementFork(), 0, passiveClone());
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });
});
