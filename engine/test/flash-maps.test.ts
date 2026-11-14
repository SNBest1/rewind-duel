import { describe, expect, it } from 'vitest';
import {
  C, IDLE, MAP_IDS, canSee, createMatch, distanceField, getMap, hashState, nearestFree, navGrid,
  observe, rand, replayMatch, step, visibleEvents,
  type GameEvent, type Input, type MatchFile, type State,
} from '../index';

const inp = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const DOWN = Math.PI / 2;
const UP = -Math.PI / 2;

function setup(p0: { x: number; y: number }, p1: { x: number; y: number }, map = 'duel'): State {
  const s = createMatch(1, map);
  Object.assign(s.players[0], p0);
  Object.assign(s.players[1], p1);
  return s;
}

/** Runs `n` ticks; `a` and `b` may be functions of the tick so a key can be tapped once. */
function run(s: State, n: number, a: Input | ((t: number) => Input) = IDLE, b: Input | ((t: number) => Input) = IDLE) {
  const events: GameEvent[] = [];
  for (let t = 0; t < n; t++) {
    const r = step(s, [typeof a === 'function' ? a(t) : a, typeof b === 'function' ? b(t) : b]);
    s = r.next;
    events.push(...r.events);
  }
  return { s, events };
}

/** Slot 1 at (3, 25) taps flash once looking up; it pops 8 units out, at (3, 17). Slot 0 stands at (3, 5). */
function flashAt(p0Aim: number, extra?: (s: State) => void) {
  const s = setup({ x: 3, y: 5 }, { x: 3, y: 25 });
  extra?.(s);
  return run(s, C.FLASH_FUSE, inp({ aim: p0Aim }), (t) => inp({ aim: UP, flash: t === 0 }));
}

describe('flashbang', () => {
  it('flies 8 units and pops after half a second', () => {
    const { events } = flashAt(DOWN);
    const pop = events.find((e) => e.type === 'flashPop') as { x: number; y: number; tick: number };
    expect(pop.x).toBeCloseTo(3, 6);
    expect(pop.y).toBeCloseTo(17, 6);
    expect(pop.tick).toBe(C.FLASH_FUSE - 1);
  });

  it('blinds a player looking at the pop', () => {
    const { s, events } = flashAt(DOWN);
    expect(s.players[0].blindTicks).toBe(C.FLASH_BLIND_FULL);
    expect(events).toContainEqual(expect.objectContaining({ type: 'blinded', slot: 0, by: 1 }));
  });

  it('is one-sided: looking away means it misses', () => {
    const { s, events } = flashAt(UP);
    expect(s.players[0].blindTicks).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'flashDodged', slot: 0 }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'blinded', slot: 0 }));
  });

  it('only half-blinds at the edge of the view cone', () => {
    const { s } = flashAt(DOWN + (45 * Math.PI) / 180);
    expect(s.players[0].blindTicks).toBe(C.FLASH_BLIND_EDGE);
  });

  it('also blinds the thrower if they keep looking at it', () => {
    const { s } = flashAt(DOWN);
    expect(s.players[1].blindTicks).toBe(C.FLASH_BLIND_FULL);
  });

  it('is blocked by smoke: no blind and no dodge', () => {
    const { s, events } = flashAt(DOWN, (st) => st.smokes.push({ x: 3, y: 11, ticksLeft: 200 }));
    expect(s.players[0].blindTicks).toBe(0);
    expect(events.filter((e) => e.type === 'blinded' && e.slot === 0)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'flashDodged' && e.slot === 0)).toHaveLength(0);
  });

  it('stops at a wall instead of passing through', () => {
    // Throwing right from (10, 16) runs into the mid box at x 15.
    const s = setup({ x: 10, y: 16 }, { x: 45, y: 16 });
    const { events } = run(s, C.FLASH_FUSE, (t) => inp({ aim: 0, flash: t === 0 }));
    const pop = events.find((e) => e.type === 'flashPop') as { x: number };
    expect(pop.x).toBeLessThan(15);
    expect(pop.x).toBeGreaterThan(14);
  });

  it('a blind player sees nothing and does not update last seen', () => {
    const { s } = flashAt(DOWN);
    expect(canSee(s, 0, 1)).toBe(false); // the enemy is right in front, 20 units away
    expect(observe(s, 0).enemy).toBeNull();
    const later = run(s, C.FLASH_BLIND_FULL, inp({ aim: DOWN }), inp({ aim: UP })).s;
    expect(later.players[0].blindTicks).toBe(0);
    expect(canSee(later, 0, 1)).toBe(true);
  });

  it('two charges a round, one at a time while the key is held', () => {
    const s = setup({ x: 3, y: 5 }, { x: 45, y: 16 });
    const { s: after, events } = run(s, 64, inp({ aim: 0, flash: true }));
    expect(events.filter((e) => e.type === 'flash')).toHaveLength(C.FLASHES);
    expect(after.players[0].flashes).toBe(0);
  });

  it('tells the blinded player and the thrower, nobody gets the other side of a dodge', () => {
    const { s, events } = flashAt(DOWN);
    const blind = events.filter((e) => e.type === 'blinded' && e.slot === 0);
    expect(visibleEvents(s, 0, blind)).toHaveLength(1);
    expect(visibleEvents(s, 1, blind)).toHaveLength(1);
    const dodge = flashAt(UP).events.filter((e) => e.type === 'flashDodged');
    expect(visibleEvents(s, 1, dodge.filter((e) => e.type === 'flashDodged' && e.slot === 0))).toHaveLength(0);
  });

  it('hides an enemy flash you cannot see', () => {
    // Slot 1 throws, slot 0 looks the other way: the grenade in flight is not in slot 0's observation.
    let s = setup({ x: 3, y: 5 }, { x: 3, y: 25 });
    s = run(s, 4, inp({ aim: UP }), (t) => inp({ aim: UP, flash: t === 0 })).s;
    expect(s.flashes).toHaveLength(1);
    expect(observe(s, 0).flashes).toHaveLength(0);
    expect(observe(s, 1).flashes).toHaveLength(1);
  });
});

describe('teleporters', () => {
  it('moves you from the pad to the exit on Relay', () => {
    const bind = getMap('relay');
    const tp = bind.teleporters[0];
    const s = setup({ x: tp.pad.x + 1, y: tp.pad.y + 1 }, { x: 45, y: 16 }, 'relay');
    const { s: after, events } = run(s, 1);
    expect(after.players[0].x).toBeCloseTo(tp.exit.x, 6);
    expect(after.players[0].y).toBeCloseTo(tp.exit.y, 6);
    expect(events).toContainEqual(expect.objectContaining({ type: 'teleport', slot: 0 }));
  });
});

describe('maps', () => {
  for (const id of MAP_IDS) {
    describe(id, () => {
      const map = getMap(id);
      const g = navGrid(map);
      const free = (x: number, y: number) => g.free[nearestFree(g, x, y)] === 1 && nearestFree(g, x, y) === (Math.floor(y / 0.5) * g.cols + Math.floor(x / 0.5));

      it('spawns on open floor', () => {
        expect(free(map.spawns.attacker.x, map.spawns.attacker.y)).toBe(true);
        expect(free(map.spawns.defender.x, map.spawns.defender.y)).toBe(true);
      });

      it('has every site reachable from both spawns, and the spawns reach each other', () => {
        const fromAtk = distanceField(g, map.spawns.attacker.x, map.spawns.attacker.y);
        const fromDef = distanceField(g, map.spawns.defender.x, map.spawns.defender.y);
        expect(fromAtk[nearestFree(g, map.spawns.defender.x, map.spawns.defender.y)]).toBeLessThan(Infinity);
        for (const site of Object.values(map.sites)) {
          // Some open cell inside the site must be reachable.
          let reached = false;
          for (let c = 0; c < g.free.length; c++) {
            if (!g.free[c]) continue;
            const x = ((c % g.cols) + 0.5) * 0.5;
            const y = (Math.floor(c / g.cols) + 0.5) * 0.5;
            if (x > site.x && x < site.x + site.w && y > site.y && y < site.y + site.h && fromAtk[c] < Infinity && fromDef[c] < Infinity) {
              reached = true;
              break;
            }
          }
          expect(reached).toBe(true);
        }
      });

      it('has teleporter exits on open floor outside every pad', () => {
        for (const tp of map.teleporters) {
          expect(free(tp.exit.x, tp.exit.y)).toBe(true);
          for (const other of map.teleporters) {
            const p = other.pad;
            expect(tp.exit.x >= p.x && tp.exit.x <= p.x + p.w && tp.exit.y >= p.y && tp.exit.y <= p.y + p.h).toBe(false);
          }
        }
      });

      it('replays deterministically with flashes', () => {
        const r = { rng: 3 };
        const pick = () => (Math.floor(rand(r) * 3) - 1) as -1 | 0 | 1;
        const file: MatchFile = { id: 't', seed: 9, map: id, players: [], inputs: [], ticks: 2400, finalHash: '' };
        let s = createMatch(9, id);
        let cur: [Input, Input] = [IDLE, IDLE];
        for (let t = 0; t < 2400; t++) {
          if (t % 16 === 0) {
            cur = [0, 1].map(() => inp({
              move: { x: pick(), y: pick() }, walk: rand(r) < 0.3, aim: rand(r) * 6 - 3,
              fire: rand(r) < 0.4, reload: rand(r) < 0.1, smoke: rand(r) < 0.05, dash: rand(r) < 0.05,
              use: rand(r) < 0.2, flash: rand(r) < 0.1,
            })) as [Input, Input];
            file.inputs.push({ tick: t, slot: 0, input: cur[0] }, { tick: t, slot: 1, input: cur[1] });
          }
          s = step(s, cur).next;
        }
        expect(hashState(replayMatch(JSON.parse(JSON.stringify(file))))).toBe(hashState(s));
      });
    });
  }
});
