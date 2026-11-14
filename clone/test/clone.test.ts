import { beforeAll, describe, expect, it, vi } from 'vitest';

// These replay whole recorded matches, which takes a few seconds, more than vitest's 5 s default allows.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { IDLE, createMatch, observe, step, type MatchFile } from '@rewind/engine';
import { BasicBot, seededRng } from '../../server/ai';
import { agreement } from '../evaluate';
import { FEATURE_NAMES, FEATURE_WEIGHTS, IDLE_ACTION, MOVES, actionFromInput, features, inputFromAction } from '../features';
import { GuardedClone, buildClone, samplesFromMatch, type Sample } from '../knn';
import type { Policy, TraceLine } from '../policy';
import { recordedMatch } from './fixtures';

let train: MatchFile[];
let heldOut: MatchFile;

beforeAll(() => {
  train = [recordedMatch('m1', 101), recordedMatch('m2', 202), recordedMatch('m3', 303)];
  heldOut = recordedMatch('m4', 404);
});

describe('features and actions', () => {
  it('has one name and one weight per feature, all roughly 0 to 1', () => {
    const o = observe(createMatch(1, 'duel'), 0);
    const f = features(o, IDLE_ACTION);
    expect(f).toHaveLength(FEATURE_NAMES.length);
    expect(FEATURE_WEIGHTS).toHaveLength(FEATURE_NAMES.length);
    for (const v of f) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips a move and a compass aim through an action', () => {
    const o = observe(createMatch(1, 'duel'), 0);
    const a = actionFromInput({ ...IDLE, move: { x: 1, y: -1 }, aim: Math.PI / 2, fire: true }, o);
    const back = inputFromAction(a, o);
    expect(back.move).toEqual({ x: 1, y: -1 });
    expect(back.aim).toBeCloseTo(Math.PI / 2, 6);
    expect(back.fire).toBe(true);
    expect(MOVES[4]).toEqual({ x: 0, y: 0 });
  });
});

describe('KnnClone', () => {
  it('samples one decision every 4 live ticks, each citing its match and tick', () => {
    const samples = samplesFromMatch(train[0], 0);
    expect(samples.length).toBeGreaterThan(200);
    for (const s of samples.slice(0, 50)) {
      expect(s.ref.match).toBe('m1');
      expect(s.ref.tick % 4).toBe(0);
    }
  });

  it('copies its own player better than the basic bot and better than a clone of someone else', () => {
    const alice = buildClone('alice', train);
    const bob = buildClone('bob', train);
    const own = agreement(() => alice.clone.fresh(), heldOut, 0);
    const basic = agreement(() => new BasicBot(0, heldOut.map, seededRng(1)), heldOut, 0);
    const other = agreement(() => bob.clone.fresh(), heldOut, 0);
    // eslint-disable-next-line no-console
    console.log('held-out agreement with alice', { own, basic, other });
    expect(own.move).toBeGreaterThan(basic.move);
    expect(own.move).toBeGreaterThan(other.move);
    expect(own.fire).toBeGreaterThan(basic.fire);
  });

  it('builds a breaker limit from held-out data', () => {
    const built = buildClone('alice', [...train, heldOut], { holdOut: ['m4'] });
    expect(built.matches).not.toContain('m4');
    expect(built.heldOutSamples).toBeGreaterThan(0);
    expect(built.limit).toBeGreaterThan(0);
    expect(built.limit).toBeLessThan(Infinity);
  });
});

describe('GuardedClone', () => {
  it('hands to the basic bot and says so when the situation is unknown', () => {
    const b = buildClone('alice', train);
    const trace: TraceLine[] = [];
    const g = new GuardedClone(b.clone, new BasicBot(0, 'duel', seededRng(2)), 0.0001, (t) => trace.push(t)); // nothing is that close
    let s = createMatch(5, 'duel');
    // A spot and state alice never recorded (spawn would match a recorded moment exactly, distance 0).
    Object.assign(s.players[0], { x: 24, y: 30.5, hp: 25, ammo: 1 });
    for (let t = 0; t < 40; t++) s = step(s, [g.act(observe(s, 0)).input, IDLE]).next;
    expect(g.breakerOn).toBe(true);
    expect(trace[0]).toMatchObject({ type: 'BREAKER', actor: 'BOT' });
  });

  it('stays on the clone, citing past moments, when the limit is generous', () => {
    const b = buildClone('alice', train);
    const trace: TraceLine[] = [];
    const g = new GuardedClone(b.clone, new BasicBot(0, 'duel', seededRng(2)), 1e9, (t) => trace.push(t));
    let s = createMatch(5, 'duel');
    for (let t = 0; t < 64; t++) s = step(s, [g.act(observe(s, 0)).input, IDLE]).next;
    expect(g.breakerOn).toBe(false);
    const copy = trace.find((t) => t.type === 'COPY');
    expect(copy?.ref?.match).toMatch(/^m[123]$/);
  });
});
