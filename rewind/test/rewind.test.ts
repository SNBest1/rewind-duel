import { describe, expect, it } from 'vitest';
import {
  IDLE, createMatch, hashState, replayMatch, step,
  type Input, type MatchFile, type Slot, type State,
} from '@rewind/engine';
import { GuardedClone, KnnClone, FEATURE_DIM, type Sample } from '@rewind/clone';
import { divergenceScore, RewindSession, recordedInputs, timelineMarkers, buildSnapshots } from '@rewind/rewind';

/** Steps a match from two constant inputs and logs it as a MatchFile, for deterministic tests. */
function scriptedMatch(seed: number, a: Input, b: Input, ticks: number): MatchFile {
  let s: State = createMatch(seed, 'duel');
  for (let i = 0; i < ticks && s.phase !== 'matchEnd'; i++) s = step(s, [a, b]).next;
  return {
    id: 'test', seed, map: 'duel',
    players: [{ slot: 0, name: 'P0' }, { slot: 1, name: 'P1' }],
    inputs: [
      { tick: 0, slot: 0, input: a },
      { tick: 0, slot: 1, input: b },
    ],
    ticks: s.tick,
    finalHash: hashState(s),
  };
}

/** A guarded clone whose breaker never fires, that always drives the opponent straight toward the human. */
function chaseClone(opponent: Slot): GuardedClone {
  // One sample is enough for a KNN of k<=1-effective; the breaker limit is huge so it never trips.
  const samples: Sample[] = Array.from({ length: 8 }, (_, i) => ({
    features: Array.from({ length: FEATURE_DIM }, () => 0),
    action: { move: 1, walk: false, aimBucket: 2, fire: true, smoke: false, dash: false, use: false },
    actionId: 0,
    enemyVisible: true,
    ref: { matchId: 'synthetic', tick: i, playerName: 'synthetic', weight: 0 },
  }));
  return new GuardedClone(new KnnClone('synthetic', samples), 1e9);
}

describe('recordedInputs and timeline', () => {
  it('decodes a slot input log into a per-tick map', () => {
    const file = scriptedMatch(7, { ...IDLE, move: { x: 1, y: 0 } }, IDLE, 50);
    const m0 = recordedInputs(file, 0);
    expect(m0.get(0)).toEqual({ ...IDLE, move: { x: 1, y: 0 } });
    expect(recordedInputs(file, 1).get(0)).toEqual(IDLE);
  });

  it('timeline always starts round 1 at tick 0', () => {
    const file = scriptedMatch(7, IDLE, IDLE, 50);
    const markers = timelineMarkers(file);
    expect(markers[0]).toEqual({ tick: 0, kind: 'roundStart', round: 1 });
  });
});

describe('divergenceScore', () => {
  it('is zero when the branch equals the recording', () => {
    const s = createMatch(3, 'duel');
    const copy = replayMatch(scriptedMatch(3, IDLE, IDLE, 1), 0); // same fresh state
    expect(divergenceScore(s, copy, 1)).toBeCloseTo(0, 6);
  });

  it('grows as the branch drifts in position', () => {
    const base = createMatch(3, 'duel');
    const drift = replayMatch(scriptedMatch(3, { ...IDLE, move: { x: 1, y: 0 } }, IDLE, 32), 32);
    // base is at tick 0; drift ran 32 ticks of movement on slot 0. Compare at the same (fresh) recording.
    const near = divergenceScore(base, base, 1);
    const far = divergenceScore(base, drift, 1);
    expect(far).toBeGreaterThan(near);
  });
});

describe('RewindSession', () => {
  it('rebuilds the exact forked state', () => {
    const file = scriptedMatch(11, { ...IDLE, move: { x: 1, y: 0 } }, { ...IDLE, move: { x: -1, y: 0 } }, 100);
    const sess = new RewindSession(file, 0, 40, chaseClone(1));
    expect(hashState(sess.state)).toBe(hashState(replayMatch(file, 40)));
    expect(sess.forkTick).toBe(40);
  });

  it('stays a faithful ghost when the human replays their own recorded inputs', () => {
    // Both players stood still in the recording. Replaying slot 0 as "still" cannot diverge.
    const file = scriptedMatch(11, IDLE, IDLE, 200);
    const sess = new RewindSession(file, 0, 10, chaseClone(1));
    for (let i = 0; i < 100 && !sess.done; i++) sess.tick(IDLE);
    expect(sess.mode).toBe('ghost');
    expect(sess.handoffTick).toBeNull();
    expect(sess.trace.every((e) => e.kind === 'GHOST')).toBe(true);
  });

  it('hands off to the clone and logs HANDOFF when the human plays differently', () => {
    // Recording: both still. The human now runs hard, so position drift crosses the limit.
    const file = scriptedMatch(11, IDLE, IDLE, 400);
    const sess = new RewindSession(file, 0, 10, chaseClone(1));
    for (let i = 0; i < 200 && !sess.done; i++) sess.tick({ ...IDLE, move: { x: 1, y: 1 } });
    expect(sess.mode).toBe('clone');
    expect(sess.handoffTick).not.toBeNull();
    expect(sess.trace.some((e) => e.kind === 'HANDOFF')).toBe(true);
  });

  it('stores each retry as a branch with its own outcome', () => {
    const file = scriptedMatch(11, IDLE, IDLE, 400);
    const sess = new RewindSession(file, 0, 10, chaseClone(1));
    for (let i = 0; i < 50; i++) sess.tick(IDLE);
    const a = sess.endBranch();
    for (let i = 0; i < 50; i++) sess.tick({ ...IDLE, move: { x: 1, y: 1 } });
    const b = sess.endBranch();
    expect(sess.branches.length).toBe(2);
    expect(a.branchId).toBe(0);
    expect(b.branchId).toBe(1);
    // reset() rebuilt the fork each time, so both branches started from the same tick.
    expect(a.forkTick).toBe(b.forkTick);
  });
});

describe('buildSnapshots', () => {
  it('produces both players every tick and ends at the final tick', () => {
    const file = scriptedMatch(11, { ...IDLE, move: { x: 1, y: 0 } }, IDLE, 64);
    const snaps = buildSnapshots(file);
    expect(snaps[0].players.length).toBe(2);
    expect(snaps[snaps.length - 1].tick).toBe(file.ticks);
    // slot 0 moved right, so its x increased from the first snapshot to the last.
    expect(snaps[snaps.length - 1].players[0].x).toBeGreaterThan(snaps[0].players[0].x);
  });
});
