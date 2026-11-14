// Scripted micro-plans for the human side: "what you could have done" from the fork tick. Each plan is a
// tiny policy that reads the human's Observation and returns an Input, run for 3 seconds against the
// opponent's guarded clone. They are deliberately simple and nameable so the result reads as advice.
import { C, getMap, type Input, type Observation } from '@rewind/engine';

const map = getMap('duel');
const IDLE_INPUT: Input = { move: { x: 0, y: 0 }, walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false };

/** A plan is a named function from the human's observation (and ticks since the fork) to an input. */
export type Plan = {
  id: string;
  label: string;
  act(o: Observation, sinceFork: number): Input;
};

/** Aim straight at the enemy (visible or last seen), else hold the current aim. */
function aimAtEnemy(o: Observation): number {
  const e = o.enemy ?? o.lastSeenEnemy;
  return e ? Math.atan2(e.y - o.self.y, e.x - o.self.x) : o.self.aim;
}

/** A unit step from a to b as a move axis pair. */
function toward(ax: number, ay: number, bx: number, by: number): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  return {
    x: Math.abs(bx - ax) > 0.3 ? (Math.sign(bx - ax) as 1 | -1) : 0,
    y: Math.abs(by - ay) > 0.3 ? (Math.sign(by - ay) as 1 | -1) : 0,
  };
}

/** The nearest cover box corner to back off to. The map's small boxes make decent holds. */
const CORNERS = [
  { x: 23, y: 5 }, { x: 16, y: 16 }, { x: 25, y: 26 }, { x: 37, y: 6 }, { x: 37, y: 26 },
];
function nearestCorner(o: Observation): { x: number; y: number } {
  let best = CORNERS[0];
  let bestD = Infinity;
  for (const c of CORNERS) {
    const d = Math.hypot(c.x - o.self.x, c.y - o.self.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** The fixed set of micro-plans. About twenty variations on a handful of ideas, as the spec asks. */
export const PLANS: Plan[] = buildPlans();

function buildPlans(): Plan[] {
  const plans: Plan[] = [];

  // 1-2. Stop then shoot: plant your feet and fire. Walk variant tightens the spread further.
  for (const walk of [false, true]) {
    plans.push({
      id: `stop-shoot${walk ? '-walk' : ''}`,
      label: `Stop${walk ? ' and settle' : ''}, then shoot`,
      act: (o) => ({ ...IDLE_INPUT, walk, aim: aimAtEnemy(o), fire: o.self.ammo > 0 && o.self.reloadTicks === 0, reload: o.self.ammo === 0 }),
    });
  }

  // 3-7. Back off to the nearest corner and hold, aiming back where the enemy is. Walk and strafe variants.
  for (const walk of [false, true]) {
    for (const holdFire of [true, false]) {
      plans.push({
        id: `backoff-${walk ? 'walk' : 'run'}-${holdFire ? 'hold' : 'shoot'}`,
        label: `Back off to cover${walk ? ' quietly' : ''} and ${holdFire ? 'wait' : 'trade'}`,
        act: (o, t) => {
          const c = nearestCorner(o);
          const arrived = Math.hypot(c.x - o.self.x, c.y - o.self.y) < 1;
          return {
            ...IDLE_INPUT,
            move: arrived ? { x: 0, y: 0 } : toward(o.self.x, o.self.y, c.x, c.y),
            walk,
            aim: aimAtEnemy(o),
            fire: !holdFire && o.enemy !== null && o.self.ammo > 0 && o.self.reloadTicks === 0,
            reload: o.self.ammo === 0,
          };
        },
      });
    }
  }
  // one extra back-off that smokes the corner as it arrives
  plans.push({
    id: 'backoff-smoke',
    label: 'Back off and smoke the angle',
    act: (o) => {
      const c = nearestCorner(o);
      const arrived = Math.hypot(c.x - o.self.x, c.y - o.self.y) < 1.2;
      return { ...IDLE_INPUT, move: arrived ? { x: 0, y: 0 } : toward(o.self.x, o.self.y, c.x, c.y), aim: aimAtEnemy(o), smoke: arrived && o.self.smokes > 0 };
    },
  });

  // 8-10. Smoke the angle then cross: drop smoke toward the enemy early, then push across it.
  for (const dir of [{ x: 1 as const, y: 0 as const }, { x: 1 as const, y: 1 as const }, { x: 1 as const, y: -1 as const }]) {
    plans.push({
      id: `smoke-cross-${dir.y}`,
      label: `Smoke the angle, then cross ${dir.y === 0 ? 'straight' : dir.y > 0 ? 'low' : 'high'}`,
      act: (o, t) => {
        if (t < 8) return { ...IDLE_INPUT, aim: aimAtEnemy(o), smoke: o.self.smokes > 0 };
        return { ...IDLE_INPUT, move: dir, aim: aimAtEnemy(o), fire: o.enemy !== null && o.self.ammo > 0 && o.self.reloadTicks === 0 };
      },
    });
  }

  // 11-14. Dash out of the line of fire, four directions, then shoot.
  const dashDirs = [{ x: 0 as const, y: 1 as const }, { x: 0 as const, y: -1 as const }, { x: 1 as const, y: 1 as const }, { x: -1 as const, y: 1 as const }];
  for (const d of dashDirs) {
    plans.push({
      id: `dash-${d.x}-${d.y}`,
      label: `Dash ${d.y > 0 ? 'down' : d.y < 0 ? 'up' : ''}${d.x > 0 ? ' forward' : d.x < 0 ? ' back' : ''}, then shoot`,
      act: (o, t) => {
        if (t < 2) return { ...IDLE_INPUT, move: d, dash: o.self.dashes > 0, aim: aimAtEnemy(o) };
        return { ...IDLE_INPUT, aim: aimAtEnemy(o), fire: o.enemy !== null && o.self.ammo > 0 && o.self.reloadTicks === 0 };
      },
    });
  }

  // 15-18. Walk silently and wait, then peek, in four facings. Walking keeps the spread tight on the peek.
  for (const face of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    plans.push({
      id: `wait-peek-${face.toFixed(2)}`,
      label: `Walk quiet, hold the angle (${face === 0 ? 'east' : face === Math.PI ? 'west' : face > 0 ? 'south' : 'north'})`,
      act: (o) => ({ ...IDLE_INPUT, walk: true, aim: o.enemy ? aimAtEnemy(o) : face, fire: o.enemy !== null && o.self.ammo > 0 && o.self.reloadTicks === 0, reload: o.self.ammo === 0 }),
    });
  }

  // 19. Rush the enemy's last seen position.
  plans.push({
    id: 'rush-last-seen',
    label: 'Rush the last-seen angle',
    act: (o) => {
      const e = o.enemy ?? o.lastSeenEnemy;
      if (!e) return { ...IDLE_INPUT, aim: o.self.aim };
      return { ...IDLE_INPUT, move: toward(o.self.x, o.self.y, e.x, e.y), aim: aimAtEnemy(o), fire: o.enemy !== null && o.self.ammo > 0 && o.self.reloadTicks === 0 };
    },
  });

  // 20. Reset: reload behind cover, then re-aim. Good when you fired dry.
  plans.push({
    id: 'reload-reset',
    label: 'Fall back and reload',
    act: (o) => {
      const c = nearestCorner(o);
      const arrived = Math.hypot(c.x - o.self.x, c.y - o.self.y) < 1;
      return { ...IDLE_INPUT, move: arrived ? { x: 0, y: 0 } : toward(o.self.x, o.self.y, c.x, c.y), walk: true, aim: aimAtEnemy(o), reload: o.self.ammo < C.MAG };
    },
  });

  return plans;
}
