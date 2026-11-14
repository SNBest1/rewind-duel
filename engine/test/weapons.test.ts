import { describe, expect, it } from 'vitest';
import {
  BUY_TICKS, C, ECON, IDLE, NO_WEAPON, SHIELDS, SWITCH_TICKS, WEAPONS, createMatch, damageAt, hashState, observe, replayMatch, step,
  type GameEvent, type Input, type MatchFile, type Rules, type State,
} from '../index';

const inp = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const byName = (n: string) => WEAPONS.find((w) => w.name === n)!.id;
const VANDAL = byName('Vandal');
const PHANTOM = byName('Phantom');
const SHERIFF = byName('Sheriff');
const BUCKY = byName('Bucky');
const HEAVY = 101;

function setup(p0: Partial<State['players'][0]>, p1: Partial<State['players'][0]>, rules: Rules = 'classic'): State {
  const s = createMatch(1, 'duel', rules);
  Object.assign(s.players[0], p0);
  Object.assign(s.players[1], p1);
  return s;
}

function run(s: State, n: number, a: Input | ((t: number) => Input) = IDLE, b: Input | ((t: number) => Input) = IDLE) {
  const events: GameEvent[] = [];
  for (let t = 0; t < n; t++) {
    const r = step(s, [typeof a === 'function' ? a(t) : a, typeof b === 'function' ? b(t) : b]);
    s = r.next;
    events.push(...r.events);
  }
  return { s, events };
}

describe('VALORANT armory', () => {
  it('has the real lineup', () => {
    const names = WEAPONS.slice(1).map((w) => w.name);
    expect(names).toEqual(['Classic', 'Shorty', 'Frenzy', 'Ghost', 'Sheriff', 'Stinger', 'Spectre', 'Bucky', 'Judge', 'Bulldog', 'Guardian', 'Phantom', 'Vandal', 'Marshal', 'Outlaw', 'Operator', 'Ares', 'Odin']);
    expect(WEAPONS[VANDAL].price).toBe(2900);
    expect(damageAt(WEAPONS[VANDAL], 50, true)).toBe(160); // no falloff
    expect(damageAt(WEAPONS[PHANTOM], 10, true)).toBe(156);
    expect(damageAt(WEAPONS[PHANTOM], 20, true)).toBe(140);
    expect(damageAt(WEAPONS[PHANTOM], 40, true)).toBe(124);
  });

  it('fires at the real rate on average (Vandal 9.75 a second)', () => {
    let s = run(setup({ x: 3, y: 5 }, { x: 45, y: 16 }), 1, inp({ buy: VANDAL })).s;
    s = run(s, SWITCH_TICKS).s;
    const { events } = run(s, 64, inp({ fire: true }));
    const shots = events.filter((e) => e.type === 'shot').length;
    expect(shots).toBeGreaterThanOrEqual(19); // 9.75/s * 2 s = 19.5
    expect(shots).toBeLessThanOrEqual(20);
  });

  it('a perfectly aimed Vandal shot from standing is a one-tap headshot', () => {
    let s = run(setup({ x: 3, y: 14 }, { x: 13, y: 14 }), 1, inp({ buy: VANDAL })).s;
    s = run(s, SWITCH_TICKS).s;
    const { s: after, events } = run(s, 1, inp({ fire: true }));
    const shot = events.find((e) => e.type === 'shot') as { head: boolean; damage: number };
    expect(shot.head).toBe(true);
    expect(shot.damage).toBe(160);
    expect(after.players[1].hp).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'kill', head: true, weapon: VANDAL }));
  });

  it('an off-centre hit is a body shot', () => {
    let s = run(setup({ x: 3, y: 14 }, { x: 13, y: 14.3 }), 1, inp({ buy: VANDAL })).s;
    s = run(s, SWITCH_TICKS).s;
    const shot = run(s, 1, inp({ fire: true })).events.find((e) => e.type === 'shot') as { hit: boolean; head: boolean; damage: number };
    expect(shot).toMatchObject({ hit: true, head: false, damage: 40 });
  });

  it('heavy shields take damage first', () => {
    let s = run(setup({ x: 3, y: 14 }, { x: 13, y: 14.3 }), 1, inp({ buy: VANDAL }), inp({ buy: HEAVY })).s;
    expect(s.players[1].armor).toBe(SHIELDS[HEAVY].amount);
    s = run(s, SWITCH_TICKS).s;
    s = run(s, 1, inp({ fire: true })).s; // a 40 body shot
    expect(s.players[1].armor).toBe(10);
    expect(s.players[1].hp).toBe(100);
  });

  it('a shotgun fires pellets that add up up close', () => {
    let s = run(setup({ x: 3, y: 14 }, { x: 5, y: 14 }), 1, inp({ buy: BUCKY })).s;
    s = run(s, SWITCH_TICKS).s;
    const shot = run(s, 1, inp({ fire: true })).events.find((e) => e.type === 'shot') as { damage: number };
    expect(shot.damage).toBeGreaterThan(100);
  });

  it('spray blooms: later bullets of a burst spread wider', () => {
    let s = run(setup({ x: 3, y: 5 }, { x: 45, y: 16 }), 1, inp({ buy: VANDAL })).s;
    s = run(s, SWITCH_TICKS).s;
    const { events } = run(s, 80, inp({ fire: true }));
    const off = (events.filter((e) => e.type === 'shot') as { angle: number }[]).map((e) => (Math.abs(e.angle) * 180) / Math.PI);
    const w = WEAPONS[VANDAL];
    expect(Math.max(...off.slice(0, 2))).toBeLessThanOrEqual(w.spread[0] + w.bloom + 1e-9);
    expect(Math.max(...off.slice(10))).toBeGreaterThan(w.spread[0] + w.bloom);
  });

  it('a loud shot is heard through walls, a suppressed Phantom is not', () => {
    const shoot = (gun: number) => {
      let s = run(setup({ x: 3, y: 16, aim: Math.PI }, { x: 18, y: 16 }), 1, IDLE, inp({ buy: gun })).s;
      s = run(s, SWITCH_TICKS).s;
      s = run(s, 1, IDLE, inp({ fire: true, aim: 0 })).s;
      return observe(s, 0).heard;
    };
    expect(shoot(VANDAL)).toMatchObject({ kind: 'shot' });
    expect(shoot(PHANTOM)).toBeNull();
  });

  it('buys in the buy phase only', () => {
    const late = run(createMatch(1, 'duel'), BUY_TICKS + 1, (t) => (t === BUY_TICKS ? inp({ buy: VANDAL }) : IDLE)).s;
    expect(late.players[0].primary).toBe(0);
  });

  it('swapping to the secondary takes a moment and keeps both magazines', () => {
    let s = run(createMatch(1, 'duel'), 1, inp({ buy: VANDAL })).s;
    s = run(s, SWITCH_TICKS).s;
    s = run(s, 3, inp({ fire: true, aim: Math.PI })).s;
    const rifleAmmo = s.players[0].ammo;
    s = run(s, 1, inp({ equip: 1 })).s;
    expect(s.players[0].ammo).toBe(WEAPONS[1].mag);
    expect(run(s, 1, inp({ equip: 1, fire: true })).events.filter((e) => e.type === 'shot')).toHaveLength(0);
    s = run(s, SWITCH_TICKS, inp({ equip: 1 })).s;
    s = run(s, 1, inp({ equip: 0 })).s;
    expect(s.players[0].ammo).toBe(rifleAmmo);
  });
});

describe('VALORANT economy', () => {
  it('starts on a pistol round with 800 credits and a Classic', () => {
    const s = createMatch(1, 'duel', 'valorant');
    expect(s.players[0]).toMatchObject({ credits: ECON.START, primary: NO_WEAPON, secondary: 1, equipped: 1, armor: 0 });
  });

  it('cannot buy what it cannot afford', () => {
    const s = run(createMatch(1, 'duel', 'valorant'), 1, inp({ buy: VANDAL })).s;
    expect(s.players[0].primary).toBe(NO_WEAPON);
    const sheriff = run(createMatch(1, 'duel', 'valorant'), 1, inp({ buy: SHERIFF })).s;
    expect(sheriff.players[0]).toMatchObject({ secondary: SHERIFF, credits: 0 });
  });

  it('pays 3000 to the winner, 1900 then 2400 to a loser on a streak, 200 a kill', () => {
    // Round 1: slot 0 kills slot 1 point blank with the Classic.
    let s = setup({ x: 3, y: 14 }, { x: 4.5, y: 14 }, 'valorant');
    s = run(s, 64, inp({ fire: true })).s;
    expect(s.score).toEqual([1, 0]);
    expect(s.players[0].credits).toBe(ECON.START + ECON.KILL + ECON.WIN);
    expect(s.players[1].credits).toBe(ECON.START + ECON.LOSS[0]);
    // Round 2 ends on time: the defender (slot 1) wins, slot 0 loses its first.
    s = run(s, C.INTERMISSION_TICKS + C.ROUND_TICKS).s;
    expect(s.score).toEqual([1, 1]);
    expect(s.lossStreak).toEqual([1, 0]);
  });

  it('you lose your guns when you die, and keep them when you survive', () => {
    let s = setup({ x: 3, y: 14 }, { x: 4.5, y: 14 }, 'valorant');
    s.players[0].credits = 9000;
    s.players[1].credits = 9000;
    s = run(s, 1, inp({ buy: VANDAL }), inp({ buy: VANDAL })).s;
    s = run(s, 80, inp({ fire: true })).s; // slot 0 kills slot 1
    s = run(s, C.INTERMISSION_TICKS).s;
    expect(s.round).toBe(2);
    expect(s.players[0].primary).toBe(VANDAL);
    expect(s.players[1].primary).toBe(NO_WEAPON);
  });

  it('replays a VALORANT match with buys to the same hash', () => {
    const file: MatchFile = { id: 'v', seed: 5, map: 'duel', players: [], inputs: [], ticks: 900, finalHash: '', rules: 'valorant' };
    let s = createMatch(5, 'duel', 'valorant');
    for (let t = 0; t < 900; t++) {
      const a = inp({ buy: t === 2 ? SHERIFF : t === 3 ? 100 : undefined, fire: t % 3 === 0, move: { x: 1, y: 0 } });
      const b = inp({ buy: t === 5 ? 4 : undefined, fire: t % 2 === 0, aim: Math.PI, move: { x: -1, y: 0 } });
      file.inputs.push({ tick: t, slot: 0, input: a }, { tick: t, slot: 1, input: b });
      s = step(s, [a, b]).next;
    }
    expect(hashState(replayMatch(JSON.parse(JSON.stringify(file))))).toBe(hashState(s));
  });
});
