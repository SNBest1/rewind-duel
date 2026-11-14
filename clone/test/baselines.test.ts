import { describe, expect, it } from 'vitest';
import { createMatch, observe, type MatchFile, type Observation } from '@rewind/engine';
import { FEATURE_DIM, MajorityBaseline, isBotMatch, isBotName, type Sample } from '@rewind/clone';

function obs(): Observation {
  return observe(createMatch(1, 'duel'), 0);
}

/** Samples where one action id dominates, so the majority is predictable. */
function skewedSamples(): Sample[] {
  const mk = (id: number, move: number): Sample => ({
    features: Array.from({ length: FEATURE_DIM }, () => 0),
    action: { move, walk: false, aimBucket: 2, fire: false, smoke: false, dash: false, use: false },
    actionId: id,
    ref: { matchId: 'm', tick: id, playerName: 'p', weight: 0 },
  });
  const out: Sample[] = [];
  for (let i = 0; i < 7; i++) out.push(mk(10, 1)); // 7 of action 10 (move right)
  for (let i = 0; i < 3; i++) out.push(mk(20, 3)); // 3 of action 20 (move down)
  return out;
}

describe('MajorityBaseline', () => {
  it('always returns the single most common action and reports its share', () => {
    const b = new MajorityBaseline('p', skewedSamples());
    expect(b.majorityShare).toBeCloseTo(7 / 10, 6);
    // 10 identical observations -> 10 identical inputs, all the majority move (right).
    const first = b.act(obs()).input;
    for (let i = 0; i < 5; i++) expect(b.act(obs()).input).toEqual(first);
    expect(first.move).toEqual({ x: 1, y: 0 });
  });

  it('falls back to standing still with no samples', () => {
    const b = new MajorityBaseline('p', []);
    expect(b.majorityShare).toBe(0);
    expect(b.act(obs()).input.move).toEqual({ x: 0, y: 0 });
  });
});

describe('bot / human classification', () => {
  const mk = (a: string, b: string): MatchFile => ({
    id: 'x', seed: 1, map: 'duel',
    players: [{ slot: 0, name: a }, { slot: 1, name: b }],
    inputs: [], ticks: 0, finalHash: '',
  });

  it('isBotMatch is true only when both players are bots', () => {
    expect(isBotMatch(mk('bot-one', 'bot-two'))).toBe(true);
    expect(isBotMatch(mk('bot-one', 'Nipun'))).toBe(false);
    expect(isBotMatch(mk('Nipun', 'Supra'))).toBe(false);
  });

  it('isBotName matches the bot- prefix only', () => {
    expect(isBotName('bot-one')).toBe(true);
    expect(isBotName('Nipun')).toBe(false);
    expect(isBotName('robot')).toBe(false);
  });
});
