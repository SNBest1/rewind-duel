import { describe, expect, it } from 'vitest';
import {
  C, IDLE, canSee, createMatch, hashState, observe, rand, replayMatch, step,
  type GameEvent, type Input, type MatchFile, type State,
} from '../index';

const inp = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });

/** Steps n ticks with fixed inputs and returns the final state plus every event. */
function run(s: State, n: number, a: Input = IDLE, b: Input = IDLE): { s: State; events: GameEvent[] } {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    const r = step(s, [a, b]);
    s = r.next;
    events.push(...r.events);
  }
  return { s, events };
}

/** A fresh match with both players teleported. Slot 0 attacks in round 1. */
function setup(p0: { x: number; y: number }, p1: { x: number; y: number }): State {
  const s = createMatch(1, 'duel');
  Object.assign(s.players[0], p0);
  Object.assign(s.players[1], p1);
  return s;
}

const RIGHT = { x: 1, y: 0 } as const;
const LEFT = { x: -1, y: 0 } as const;
const DOWN = Math.PI / 2;

describe('movement', () => {
  it('runs 5 units per second and walks 2.5', () => {
    const start = createMatch(1, 'duel');
    expect(run(start, 32, inp({ move: RIGHT })).s.players[0].x).toBeCloseTo(start.players[0].x + 5, 6);
    expect(run(start, 32, inp({ move: RIGHT, walk: true })).s.players[0].x).toBeCloseTo(start.players[0].x + 2.5, 6);
  });

  it('normalizes diagonal movement', () => {
    const start = createMatch(1, 'duel');
    const p = run(start, 32, inp({ move: { x: 1, y: 1 } })).s.players[0];
    expect(Math.hypot(p.x - start.players[0].x, p.y - start.players[0].y)).toBeCloseTo(5, 6);
  });

  it('stops at a wall', () => {
    // The mid cover box spans x 15-17, y 15-17.
    const { s } = run(setup({ x: 10, y: 16 }, { x: 45, y: 16 }), 64, inp({ move: RIGHT }));
    expect(s.players[0].x).toBeCloseTo(15 - C.RADIUS, 6);
    expect(s.players[0].y).toBeCloseTo(16, 6);
  });

  it('dashes 4 units once per round and stops at walls', () => {
    const start = setup({ x: 3, y: 5 }, { x: 45, y: 16 });
    const dashed = run(start, C.DASH_TICKS, inp({ move: { x: 0, y: 1 }, dash: true })).s.players[0];
    expect(dashed.y).toBeCloseTo(9, 6);
    expect(dashed.dashes).toBe(0);
    const again = run(start, 64, inp({ move: { x: 0, y: 1 }, dash: true })).s.players[0];
    expect(again.y).toBeCloseTo(5 + 4 + (64 - C.DASH_TICKS) * C.RUN, 6); // second dash never happens

    const blocked = run(setup({ x: 13, y: 16 }, { x: 45, y: 16 }), C.DASH_TICKS, inp({ move: RIGHT, dash: true })).s;
    expect(blocked.players[0].x).toBeCloseTo(15 - C.RADIUS, 6);
  });
});

describe('rifle', () => {
  it('hits a visible enemy for 25', () => {
    const { s, events } = run(setup({ x: 3, y: 14 }, { x: 7, y: 14 }), 1, inp({ fire: true }));
    expect(s.players[1].hp).toBe(75);
    expect(s.players[0].ammo).toBe(9);
    expect(events).toContainEqual(expect.objectContaining({ type: 'shot', slot: 0, hit: true }));
  });

  it('misses when aimed away', () => {
    const { s } = run(setup({ x: 3, y: 14 }, { x: 7, y: 14 }), 1, inp({ fire: true, aim: DOWN }));
    expect(s.players[1].hp).toBe(100);
  });

  it('is stopped by walls', () => {
    const { s, events } = run(setup({ x: 10, y: 16 }, { x: 20, y: 16 }), 1, inp({ fire: true }));
    expect(s.players[1].hp).toBe(100);
    const shot = events.find((e) => e.type === 'shot');
    expect(shot).toMatchObject({ hit: false });
    expect((shot as { toX: number }).toX).toBeCloseTo(15, 1);
  });

  it('fires at most 4 shots per second', () => {
    const { events } = run(setup({ x: 3, y: 14 }, { x: 3, y: 28 }), 32, inp({ fire: true }));
    expect(events.filter((e) => e.type === 'shot')).toHaveLength(4);
  });

  it('holds 10 rounds and reloads in 2 seconds', () => {
    let s = run(setup({ x: 3, y: 14 }, { x: 3, y: 28 }), 200, inp({ fire: true })).s;
    expect(s.players[0].ammo).toBe(0);
    s = run(s, C.RELOAD_TICKS, inp({ reload: true })).s;
    expect(s.players[0].ammo).toBe(0);
    s = run(s, 1).s;
    expect(s.players[0].ammo).toBe(10);
  });

  it('spreads about 1 degree still, 4 walking, 10 running', () => {
    // Holding left against the border wall keeps the position fixed while the move state changes.
    const maxOffsetDeg = (a: Input) => {
      const { events } = run(setup({ x: C.RADIUS, y: 5 }, { x: 45, y: 16 }), 80, a);
      const shots = events.filter((e) => e.type === 'shot') as { angle: number }[];
      expect(shots).toHaveLength(10);
      return Math.max(...shots.map((e) => (Math.abs(e.angle) * 180) / Math.PI));
    };
    const still = maxOffsetDeg(inp({ fire: true }));
    const walk = maxOffsetDeg(inp({ fire: true, move: LEFT, walk: true }));
    const runSpread = maxOffsetDeg(inp({ fire: true, move: LEFT }));
    expect(still).toBeLessThanOrEqual(1);
    expect(walk).toBeGreaterThan(1);
    expect(walk).toBeLessThanOrEqual(4);
    expect(runSpread).toBeGreaterThan(4);
    expect(runSpread).toBeLessThanOrEqual(10);
  });
});

describe('vision', () => {
  it('is blocked by walls', () => {
    const s = setup({ x: 10, y: 16 }, { x: 20, y: 16 });
    expect(canSee(s, 0, 1)).toBe(false);
    expect(observe(s, 0).enemy).toBeNull();
  });

  it('sees inside the 100 degree cone only', () => {
    const s = setup({ x: 3, y: 5 }, { x: 3, y: 25 });
    s.players[0].aim = DOWN;
    expect(observe(s, 0).enemy).toMatchObject({ x: 3, y: 25 });
    s.players[0].aim = DOWN + (49 * Math.PI) / 180;
    expect(canSee(s, 0, 1)).toBe(true);
    s.players[0].aim = DOWN + (51 * Math.PI) / 180;
    expect(canSee(s, 0, 1)).toBe(false);
  });

  it('sees within 3 units in any direction', () => {
    const s = setup({ x: 3, y: 5 }, { x: 3, y: 7.5 });
    s.players[0].aim = -DOWN;
    expect(canSee(s, 0, 1)).toBe(true);
    s.players[1].y = 8.5;
    expect(canSee(s, 0, 1)).toBe(false);
  });

  it('is blocked by smoke, which does not block bullets', () => {
    let s = setup({ x: 3, y: 5 }, { x: 3, y: 25 });
    s.players[0].aim = DOWN;
    s.smokes.push({ x: 3, y: 15, ticksLeft: 100 });
    expect(canSee(s, 0, 1)).toBe(false);
    s = run(s, 1, inp({ fire: true, aim: DOWN })).s;
    expect(s.players[1].hp).toBe(75);
  });

  it('places a smoke up to 8 units along the aim that lasts 8 seconds', () => {
    let s = run(setup({ x: 3, y: 5 }, { x: 45, y: 16 }), 1, inp({ smoke: true, aim: DOWN })).s;
    expect(s.smokes).toHaveLength(1);
    expect(s.smokes[0].y).toBeCloseTo(13, 6);
    expect(s.players[0].smokes).toBe(0);
    s = run(s, C.SMOKE_TICKS - 1, inp({ smoke: true, aim: DOWN })).s;
    expect(s.smokes).toHaveLength(1);
    expect(run(s, 1).s.smokes).toHaveLength(0);
  });

  it('remembers where the enemy was last seen', () => {
    let s = setup({ x: 3, y: 5 }, { x: 3, y: 25 });
    s = run(s, 1, inp({ aim: DOWN })).s;
    expect(observe(s, 0).lastSeenEnemy).toEqual({ x: 3, y: 25, ticksAgo: 0 });
    s = run(s, 32, inp({ aim: -DOWN }), inp({ move: RIGHT })).s;
    const o = observe(s, 0);
    expect(o.enemy).toBeNull();
    expect(o.lastSeenEnemy).toEqual({ x: 3, y: 25, ticksAgo: 32 });
  });
});

describe('spike and rounds', () => {
  const SITE = { x: 34, y: 4 }; // inside site A
  const USE = inp({ use: true });

  it('plants after 2 seconds standing still in a site', () => {
    let s = run(setup(SITE, { x: 45, y: 16 }), C.PLANT_TICKS - 1, USE).s;
    expect(s.spike.state).toBe('carried');
    const r = run(s, 1, USE);
    expect(r.s.spike).toMatchObject({ state: 'planted', x: 34, y: 4 });
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'plant', slot: 0 }));
  });

  it('does not plant outside a site or while moving', () => {
    expect(run(setup({ x: 3, y: 16 }, { x: 45, y: 16 }), 100, USE).s.spike.state).toBe('carried');
    let s = run(setup(SITE, { x: 45, y: 16 }), 40, USE).s;
    s = run(s, 1, inp({ use: true, move: LEFT, walk: true })).s;
    s = run(s, 40, USE).s;
    expect(s.spike.state).toBe('carried');
  });

  it('detonates 30 seconds after the plant and the attacker wins', () => {
    const planted = run(setup(SITE, { x: 45, y: 16 }), C.PLANT_TICKS, USE).s;
    const { s, events } = run(planted, C.FUSE_TICKS);
    expect(s.score).toEqual([1, 0]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'roundEnd', winner: 0, reason: 'detonation' }));
  });

  it('defuses after 4 seconds near the spike and the defender wins', () => {
    let s = run(setup(SITE, { x: 45, y: 16 }), C.PLANT_TICKS, USE).s;
    Object.assign(s.players[1], { x: 35, y: 4 });
    s = run(s, C.DEFUSE_TICKS - 1, IDLE, USE).s;
    expect(s.phase).toBe('live');
    const r = run(s, 1, IDLE, USE);
    expect(r.s.score).toEqual([0, 1]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'roundEnd', winner: 1, reason: 'defuse' }));
  });

  it('cannot defuse from out of range', () => {
    let s = run(setup(SITE, { x: 45, y: 16 }), C.PLANT_TICKS, USE).s;
    Object.assign(s.players[1], { x: 34, y: 8 });
    s = run(s, C.DEFUSE_TICKS + 10, IDLE, USE).s;
    expect(s.phase).toBe('live');
  });

  it('gives the defender the round when time runs out with no plant', () => {
    const { s, events } = run(createMatch(1, 'duel'), C.ROUND_TICKS);
    expect(s.score).toEqual([0, 1]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'roundEnd', winner: 1, reason: 'time' }));
  });

  it('ends the round on a kill, for either side', () => {
    const a = run(setup({ x: 3, y: 14 }, { x: 7, y: 14 }), 25, inp({ fire: true }));
    expect(a.s.score).toEqual([1, 0]);
    expect(a.events).toContainEqual(expect.objectContaining({ type: 'kill', killer: 0, victim: 1 }));
    const d = run(setup({ x: 3, y: 14 }, { x: 7, y: 14 }), 25, IDLE, inp({ fire: true, aim: Math.PI }));
    expect(d.s.score).toEqual([0, 1]);
  });

  it('resolves a same-tick trade for the defender when no spike is planted', () => {
    const s = setup({ x: 3, y: 14 }, { x: 7, y: 14 });
    s.players[0].hp = 25;
    s.players[1].hp = 25;
    const r = run(s, 1, inp({ fire: true }), inp({ fire: true, aim: Math.PI }));
    expect(r.s.players.map((p) => p.hp)).toEqual([0, 0]);
    expect(r.s.score).toEqual([0, 1]);
  });

  it('respawns both players after the intermission', () => {
    let s = run(createMatch(1, 'duel'), C.ROUND_TICKS, inp({ move: RIGHT })).s;
    expect(s.phase).toBe('roundEnd');
    const r = run(s, C.INTERMISSION_TICKS, inp({ move: RIGHT }));
    expect(r.s).toMatchObject({ phase: 'live', round: 2 });
    expect(r.s.players[0].x).toBe(3);
    expect(r.events).toContainEqual(expect.objectContaining({ type: 'roundStart', round: 2 }));
  });

  it('plays first to 5 and swaps sides after round 4', () => {
    // Nobody acts, so the defender wins every round on time.
    let s = createMatch(1, 'duel');
    const attackerByRound: number[] = [];
    while (s.phase !== 'matchEnd') {
      if (s.roundTicks === 0 && s.phase === 'live') attackerByRound[s.round] = s.attacker;
      s = step(s, [IDLE, IDLE]).next;
    }
    expect(attackerByRound.slice(1)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1]);
    expect(s.score).toEqual([5, 4]);
    expect(s.winner).toBe(0);
    expect(hashState(step(s, [IDLE, IDLE]).next)).toBe(hashState(s)); // a finished match is frozen
  });
});

/** Random but reproducible inputs: each slot picks a new action every 16 ticks. */
function scriptedInputs(seed: number, ticks: number): [Input, Input][] {
  const r = { rng: seed };
  const pick = () => (Math.floor(rand(r) * 3) - 1) as -1 | 0 | 1;
  const out: [Input, Input][] = [];
  let cur: [Input, Input] = [IDLE, IDLE];
  for (let t = 0; t < ticks; t++) {
    if (t % 16 === 0) {
      cur = [0, 1].map(() => ({
        move: { x: pick(), y: pick() },
        walk: rand(r) < 0.3,
        aim: rand(r) * 2 * Math.PI - Math.PI,
        fire: rand(r) < 0.4,
        reload: rand(r) < 0.1,
        smoke: rand(r) < 0.05,
        dash: rand(r) < 0.05,
        use: rand(r) < 0.2,
      })) as [Input, Input];
    }
    out.push(cur);
  }
  return out;
}

describe('determinism', () => {
  const TICKS = 120 * 32; // a 2 minute match
  const play = (seed: number) => {
    let s = createMatch(seed, 'duel');
    for (const pair of scriptedInputs(99, TICKS)) s = step(s, pair).next;
    return s;
  };

  it('gives the same hash for the same seed and inputs', () => {
    const a = play(1234);
    expect(a.tick).toBe(TICKS);
    expect(hashState(a)).toBe(hashState(play(1234)));
  });

  it('gives a different hash for a different seed', () => {
    expect(hashState(play(1234))).not.toBe(hashState(play(1235)));
  });

  it('does not mutate the state passed to step', () => {
    const s = createMatch(5, 'duel');
    const before = JSON.stringify(s);
    step(s, [inp({ move: RIGHT, fire: true, smoke: true }), inp({ move: LEFT })]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('replays a match file to the same hash, and to any earlier tick', () => {
    const script = scriptedInputs(7, TICKS);
    const file: MatchFile = { id: 't', seed: 42, map: 'duel', players: [], inputs: [], ticks: TICKS, finalHash: '' };
    let s = createMatch(42, 'duel');
    let mid = '';
    script.forEach((pair, t) => {
      if (t === 1000) mid = hashState(s);
      if (t % 16 === 0) file.inputs.push({ tick: t, slot: 0, input: pair[0] }, { tick: t, slot: 1, input: pair[1] });
      s = step(s, pair).next;
    });
    expect(hashState(replayMatch(file))).toBe(hashState(s));
    expect(hashState(replayMatch(file, 1000))).toBe(mid);
  });

  it('never puts the enemy in an observation when the enemy is not visible', () => {
    let s = createMatch(3, 'duel');
    let seen = 0;
    for (const pair of scriptedInputs(11, TICKS)) {
      s = step(s, pair).next;
      for (const slot of [0, 1] as const) {
        const visible = canSee(s, slot, (1 - slot) as 0 | 1);
        expect(observe(s, slot).enemy !== null).toBe(visible);
        if (visible) seen++;
      }
    }
    expect(seen).toBeGreaterThan(0); // the script must exercise both branches
  });
});
