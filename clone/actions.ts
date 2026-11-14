// The clone's action space. The clone does not copy a raw Input; it copies a small discrete Action,
// then turns it back into an Input relative to the current situation. That is what lets a decision
// recorded facing one way be replayed facing another, so k neighbors from different moments combine.
import { type Input, type Observation } from '@rewind/engine';

/** 9 move options: stop, plus the 8 grid directions. Index 0 is stop. */
export const MOVE_OPTIONS: { x: -1 | 0 | 1; y: -1 | 0 | 1 }[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];

/** Aim offset buckets, radians, relative to the enemy direction. A few buckets as the spec asks. */
export const AIM_BUCKETS = [-0.3, -0.1, 0, 0.1, 0.3];

/** One discrete decision. Everything the clone chooses lives here. */
export type Action = {
  move: number; // index into MOVE_OPTIONS
  walk: boolean;
  aimBucket: number; // index into AIM_BUCKETS, applied to the enemy direction (or kept absolute if no enemy)
  fire: boolean;
  smoke: boolean;
  dash: boolean;
  use: boolean;
};

/** A stable id for an Action, so KNN can vote over ids and the trace can name the winner. */
export function actionId(a: Action): number {
  let id = a.move;
  id = id * 2 + (a.walk ? 1 : 0);
  id = id * AIM_BUCKETS.length + a.aimBucket;
  id = id * 2 + (a.fire ? 1 : 0);
  id = id * 2 + (a.smoke ? 1 : 0);
  id = id * 2 + (a.dash ? 1 : 0);
  id = id * 2 + (a.use ? 1 : 0);
  return id;
}

export const NUM_ACTIONS = MOVE_OPTIONS.length * 2 * AIM_BUCKETS.length * 2 * 2 * 2 * 2;

/** The angle this player would aim at to point straight at the enemy (last seen if not visible), or null. */
export function enemyDirection(o: Observation): number | null {
  const e = o.enemy ?? o.lastSeenEnemy;
  if (!e) return null;
  return Math.atan2(e.y - o.self.y, e.x - o.self.x);
}

/**
 * Reads a recorded Input back into an Action, given the Observation it was made in.
 * The aim is stored as an offset from the enemy direction so it transfers; with no enemy the nearest bucket to 0.
 */
export function encodeAction(input: Input, o: Observation): Action {
  const move = MOVE_OPTIONS.findIndex((m) => m.x === input.move.x && m.y === input.move.y);
  const dir = enemyDirection(o);
  let aimBucket = 2; // the 0 bucket
  if (dir !== null) {
    let off = angleWrap(input.aim - dir);
    aimBucket = nearest(AIM_BUCKETS, off);
  }
  return {
    move: move < 0 ? 0 : move,
    walk: input.walk,
    aimBucket,
    fire: input.fire,
    smoke: input.smoke,
    dash: input.dash,
    use: input.use,
  };
}

/** Turns an Action back into an Input for the current Observation. Aim points at the enemy plus the bucket offset. */
export function decodeAction(a: Action, o: Observation): Input {
  const dir = enemyDirection(o);
  const aim = dir === null ? o.self.aim : angleWrap(dir + AIM_BUCKETS[a.aimBucket]);
  return {
    move: MOVE_OPTIONS[a.move],
    walk: a.walk,
    aim,
    fire: a.fire,
    // The engine auto-reloads nothing: a clone reloads when empty, independent of the copied action.
    reload: o.self.ammo === 0 && o.self.reloadTicks === 0,
    smoke: a.smoke && o.self.smokes > 0,
    dash: a.dash && o.self.dashes > 0,
    use: a.use,
  };
}

function angleWrap(a: number): number {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function nearest(arr: number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
