import { describe, expect, it } from 'vitest';
import { IDLE, createMatch, hashState, step, type Input, type MatchFile, type Policy, type State } from '@rewind/engine';
import { cloneAccuracy, positionError, bootstrapByRound, type DecisionRecord } from '../metrics';

/** Builds a MatchFile where slot 0 holds a fixed input and slot 1 is idle. */
function scripted(seed: number, a: Input, ticks: number): MatchFile {
  let s: State = createMatch(seed, 'duel');
  for (let i = 0; i < ticks && s.phase !== 'matchEnd'; i++) s = step(s, [a, IDLE]).next;
  return {
    id: 'm', seed, map: 'duel',
    players: [{ slot: 0, name: 'A' }, { slot: 1, name: 'B' }],
    inputs: [{ tick: 0, slot: 0, input: a }, { tick: 0, slot: 1, input: IDLE }],
    ticks: s.tick, finalHash: hashState(s),
  };
}

/** A policy that always returns the same input, so we can predict the accuracy exactly. */
function constPolicy(input: Input): Policy {
  return { name: 'const', act: () => ({ input, confidence: 1, because: [] }) };
}

describe('cloneAccuracy', () => {
  // NOTE: moveMatch/fireMatch/bothMatch are now RATES in [0,1] (were raw counts before the record-based
  // refactor that enabled bootstrap CIs). The assertions test the same truth against the new contract.
  it('is 100% both when the policy exactly reproduces the recorded input', () => {
    const a: Input = { ...IDLE, move: { x: 1, y: 0 }, fire: false };
    const file = scripted(3, a, 200);
    const acc = cloneAccuracy(file, 0, constPolicy(a));
    expect(acc.decisions).toBeGreaterThan(0);
    expect(acc.bothMatch).toBe(1);
    expect(acc.moveMatch).toBe(1);
    expect(acc.fireMatch).toBe(1);
  });

  it('counts move and fire mismatches separately', () => {
    const recorded: Input = { ...IDLE, move: { x: 1, y: 0 }, fire: false };
    const file = scripted(3, recorded, 200);
    // Policy moves the wrong way but matches the (false) fire choice.
    const acc = cloneAccuracy(file, 0, constPolicy({ ...IDLE, move: { x: -1, y: 0 }, fire: false }));
    expect(acc.moveMatch).toBe(0);
    expect(acc.fireMatch).toBe(1);
    expect(acc.bothMatch).toBe(0);
  });
});

describe('bootstrapByRound', () => {
  it('brackets the point estimate and resamples by round', () => {
    // Build records across 4 rounds; half the rounds all-true, half all-false, so the metric is ~0.5
    // but each resample of rounds can swing between 0 and 1 -> a wide, bracketing CI.
    const rec = (round: number, v: boolean): DecisionRecord => ({
      round, moveMatch: v, fireMatch: v, realMoveClass: 0, policyMoveClass: 0,
      enemyVisible: false, realFire: false, policyFire: false, posErr: 0, realMoved: false,
    });
    const rs: DecisionRecord[] = [];
    for (const r of [1, 2]) for (let i = 0; i < 20; i++) rs.push(rec(r, true));
    for (const r of [3, 4]) for (let i = 0; i < 20; i++) rs.push(rec(r, false));
    const ci = bootstrapByRound(rs, (x) => x.filter((r) => r.moveMatch).length / x.length, 500, 1);
    expect(ci.point).toBeCloseTo(0.5, 6);
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(ci.lo).toBeLessThan(ci.point);
    expect(ci.hi).toBeGreaterThan(ci.point);
  });

  it('collapses to a point when there is only one round (no between-round spread)', () => {
    const rs: DecisionRecord[] = Array.from({ length: 10 }, () => ({
      round: 1, moveMatch: true, fireMatch: true, realMoveClass: 0, policyMoveClass: 0,
      enemyVisible: false, realFire: false, policyFire: false, posErr: 0, realMoved: false,
    }));
    const ci = bootstrapByRound(rs, (x) => x.filter((r) => r.moveMatch).length / x.length, 500, 1);
    expect(ci.lo).toBe(ci.point);
    expect(ci.hi).toBe(ci.point);
  });
});

describe('positionError', () => {
  it('is zero when the policy replays the exact recorded movement', () => {
    const a: Input = { ...IDLE, move: { x: 1, y: 0 } };
    const file = scripted(3, a, 200);
    // The policy always moves the same way the recording did, so after 1 s it lands where truth lands.
    const pos = positionError(file, 0, constPolicy(a));
    expect(pos.starts).toBeGreaterThan(0);
    expect(pos.avgError).toBeCloseTo(0, 6);
  });

  it('grows when the policy moves differently from the recording', () => {
    const a: Input = { ...IDLE, move: { x: 1, y: 0 } };
    const file = scripted(3, a, 200);
    const pos = positionError(file, 0, constPolicy({ ...IDLE, move: { x: 0, y: 1 } }));
    expect(pos.avgError).toBeGreaterThan(1);
  });
});
