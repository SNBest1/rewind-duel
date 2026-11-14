import { describe, expect, it } from 'vitest';
import { IDLE, createMatch, hashState, step, type Input, type MatchFile, type Policy, type State } from '@rewind/engine';
import { cloneAccuracy, positionError } from '../metrics';

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
  it('is 100% both when the policy exactly reproduces the recorded input', () => {
    const a: Input = { ...IDLE, move: { x: 1, y: 0 }, fire: false };
    const file = scripted(3, a, 200);
    const acc = cloneAccuracy(file, 0, constPolicy(a));
    expect(acc.decisions).toBeGreaterThan(0);
    expect(acc.bothMatch).toBe(acc.decisions);
    expect(acc.moveMatch).toBe(acc.decisions);
    expect(acc.fireMatch).toBe(acc.decisions);
  });

  it('counts move and fire mismatches separately', () => {
    const recorded: Input = { ...IDLE, move: { x: 1, y: 0 }, fire: false };
    const file = scripted(3, recorded, 200);
    // Policy moves the wrong way but matches the (false) fire choice.
    const acc = cloneAccuracy(file, 0, constPolicy({ ...IDLE, move: { x: -1, y: 0 }, fire: false }));
    expect(acc.moveMatch).toBe(0);
    expect(acc.fireMatch).toBe(acc.decisions);
    expect(acc.bothMatch).toBe(0);
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
