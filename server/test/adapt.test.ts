import { describe, expect, it } from 'vitest';
import { C, IDLE, createMatch, hearFootsteps, observe, step, type Input } from '@rewind/engine';
import { Belief } from '../belief';
import { START_SKILL, blankBrain, nextSkill } from '../brain';

describe('adaptive difficulty', () => {
  it('starts easy', () => {
    expect(blankBrain('x').skill).toBe(START_SKILL);
    expect(START_SKILL).toBeLessThanOrEqual(0.25);
  });

  it('gets easier fast when you keep losing, and never below the floor', () => {
    const b = blankBrain('x');
    b.skill = 0.8; // high enough that the floor does not cut the first steps short
    const path = [b.skill];
    for (let i = 0; i < 6; i++) path.push((b.skill = nextSkill(b, false)));
    expect(path[1]).toBeLessThan(path[0]);
    // Each loss in a streak is a bigger step than the one before.
    expect(path[1] - path[2]).toBeGreaterThan(path[0] - path[1] - 1e-9);
    expect(b.skill).toBe(0.05);
  });

  it('gets harder when you keep winning, faster on a streak', () => {
    const b = blankBrain('x');
    const steps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = b.skill;
      b.skill = nextSkill(b, true);
      steps.push(b.skill - before);
    }
    expect(steps[3]).toBeGreaterThan(steps[0]);
    expect(b.skill).toBeGreaterThan(0.5);
  });

  it('a win after a losing streak resets the streak', () => {
    const b = blankBrain('x');
    b.skill = 0.6;
    b.skill = nextSkill(b, false);
    b.skill = nextSkill(b, false);
    expect(b.streak).toBe(-2);
    b.skill = nextSkill(b, true);
    expect(b.streak).toBe(1);
  });
});

describe('footsteps', () => {
  const RIGHT: Input = { ...IDLE, move: { x: 1, y: 0 } };
  it('a running enemy is heard through walls at a rough spot; walking is silent', () => {
    let s = createMatch(1, 'duel');
    Object.assign(s.players[0], { x: 10, y: 16, aim: Math.PI }); // looking away
    Object.assign(s.players[1], { x: 20, y: 16 }); // the mid box is between them
    s = step(s, [IDLE, RIGHT]).next;
    const heard = hearFootsteps(s, 0);
    expect(heard).not.toBeNull();
    expect(Math.abs(heard!.x - s.players[1].x)).toBeLessThanOrEqual(C.HEAR_GRID / 2);
    expect(observe(s, 0).heard).toEqual(heard);
    s = step(s, [IDLE, { ...RIGHT, walk: true }]).next;
    expect(observe(s, 0).heard).toBeNull();
  });

  it('is not heard beyond range', () => {
    let s = createMatch(1, 'duel');
    Object.assign(s.players[0], { x: 3, y: 16, aim: Math.PI });
    Object.assign(s.players[1], { x: 30, y: 16 });
    s = step(s, [IDLE, RIGHT]).next;
    expect(observe(s, 0).heard).toBeNull();
  });
});

describe('belief map', () => {
  it('starts at the enemy spawn, spreads over time, and collapses on footsteps', () => {
    const b = new Belief('duel', null, 1);
    b.reset({ x: 45, y: 16 });
    expect(b.peak().x).toBeCloseTo(45.5, 0);
    let s = createMatch(1, 'duel');
    // Slot 0 looks at the left wall and sees nothing; time passes.
    Object.assign(s.players[0], { x: 3, y: 16, aim: Math.PI });
    for (let i = 0; i < 64; i++) {
      s = step(s, [{ ...IDLE, aim: Math.PI }, IDLE]).next;
      b.update(observe(s, 0));
    }
    expect(b.peak().p).toBeLessThan(0.5); // two seconds of not knowing: spread out
    const o = { ...observe(s, 0), heard: { x: 21, y: 13 } };
    b.update(o);
    const pk = b.peak();
    expect(Math.hypot(pk.x - 21, pk.y - 13)).toBeLessThan(2);
  });

  it('rules out what it can see', () => {
    const b = new Belief('duel', null, 1);
    const s = createMatch(1, 'duel');
    Object.assign(s.players[0], { x: 3, y: 5, aim: Math.PI / 2 }); // looking down the open left column
    b.collapse(3, 20); // "they are right there"
    // Several ticks of looking straight at an empty spot: the mass there must be gone.
    for (let t = 0; t < 6; t++) b.update({ ...observe(s, 0), tick: t * 3 });
    expect(b.massNear(3, 20, 1.5)).toBeLessThan(0.05);
  });
});
