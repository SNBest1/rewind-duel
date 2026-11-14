// What a clone looks at, and what it can do. Built from observe() only, so a clone never knows more
// than the person it copies could see at that moment.
import { C, angleDiff, getMap, rayWalls, weapon, type Input, type Observation } from '@rewind/engine';

/** One decision is sampled every DECISION_TICKS ticks; the policy holds it in between. */
export const DECISION_TICKS = 4;

/** The 9 move options: index = (y + 1) * 3 + (x + 1). Index 4 is standing still. */
export const MOVES: Input['move'][] = [];
for (const y of [-1, 0, 1] as const) for (const x of [-1, 0, 1] as const) MOVES.push({ x, y });
export const moveIndex = (m: Input['move']) => (m.y + 1) * 3 + (m.x + 1);

/** Aim offsets from the enemy direction (or last seen direction), in radians. */
export const AIM_OFFSETS = [-0.5, -0.2, -0.07, 0, 0.07, 0.2, 0.5];
/** With no idea where the enemy is, aim is one of 8 compass directions instead. */
export const COMPASS = 8;

export type Action = {
  move: number; // index into MOVES
  walk: boolean;
  /** 0..6 = AIM_OFFSETS relative to the enemy direction; 7..14 = compass direction (when no enemy direction is known) */
  aim: number;
  fire: boolean;
  reload: boolean;
  smoke: boolean;
  dash: boolean;
  use: boolean;
  flash: boolean;
};

export const IDLE_ACTION: Action = { move: 4, walk: false, aim: 7, fire: false, reload: false, smoke: false, dash: false, use: false, flash: false };

/** Direction to the enemy as this player knows it: where they are now if visible, else where they were last seen. */
export function enemyDirection(o: Observation): number | null {
  const e = o.enemy ?? o.lastSeenEnemy;
  if (!e) return null;
  return Math.atan2(e.y - o.self.y, e.x - o.self.x);
}

function nearestBucket(values: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (Math.abs(values[i] - v) < Math.abs(values[best] - v)) best = i;
  return best;
}

/** Turns a recorded input into the discrete action the clone learns. */
export function actionFromInput(input: Input, o: Observation): Action {
  const dir = enemyDirection(o);
  const aim = dir === null
    ? AIM_OFFSETS.length + ((Math.round(input.aim / ((2 * Math.PI) / COMPASS)) % COMPASS) + COMPASS) % COMPASS
    : nearestBucket(AIM_OFFSETS, angleDiff(input.aim, dir));
  return {
    move: moveIndex(input.move), walk: input.walk, aim, fire: input.fire, reload: input.reload,
    smoke: input.smoke, dash: input.dash, use: input.use, flash: input.flash === true,
  };
}

/** Turns a clone's action back into an input for this tick. The aim is recomputed every tick against the current enemy direction. */
export function inputFromAction(a: Action, o: Observation): Input {
  const dir = enemyDirection(o);
  // A relative bucket with no enemy direction known (the neighbours knew one, this moment does not) keeps the current aim.
  const aim = a.aim < AIM_OFFSETS.length
    ? (dir ?? o.self.aim) + AIM_OFFSETS[a.aim]
    : ((a.aim - AIM_OFFSETS.length) * 2 * Math.PI) / COMPASS;
  return {
    move: MOVES[a.move], walk: a.walk, aim, fire: a.fire, reload: a.reload,
    smoke: a.smoke, dash: a.dash, use: a.use, flash: a.flash,
  };
}

export type Zone = 'site' | 'spawn' | 'mid';

export function zoneOf(o: Observation): Zone {
  const map = getMap(o.mapId);
  const { x, y } = o.self;
  for (const r of Object.values(map.sites)) if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return 'site';
  for (const s of [map.spawns.attacker, map.spawns.defender]) if (Math.hypot(x - s.x, y - s.y) < 6) return 'spawn';
  return 'mid';
}

const clip = (v: number) => Math.max(0, Math.min(1, v));

/** Names of each feature, for debugging and the trace panel. */
export const FEATURE_NAMES = [
  'x', 'y', 'hp', 'ammo', 'reloading', 'smoke', 'dash', 'flashes', 'attacking', 'timeLeft', 'planted',
  'spikeDx', 'spikeDy', 'enemyVisible', 'enemyDx', 'enemyDy', 'secondsSinceSeen',
  'wallE', 'wallSE', 'wallS', 'wallSW', 'wallW', 'wallNW', 'wallN', 'wallNE',
  'zoneSite', 'zoneSpawn', 'zoneMid', 'prevMoveX', 'prevMoveY', 'prevFire', 'blind',
];

/**
 * Weights per feature. Distance in feature space should mean "a different situation". The enemy is what
 * changes a decision most, so its features weigh more than, say, ability charges.
 */
export const FEATURE_WEIGHTS = [
  1.5, 1.5, 0.8, 0.6, 0.6, 0.3, 0.3, 0.3, 1, 0.5, 1,
  0.8, 0.8, 2, 1.6, 1.6, 1.2,
  0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4,
  0.6, 0.6, 0.6, 0.7, 0.7, 0.7, 1.5,
];

/** The feature vector for one moment, each value roughly 0 to 1. `prev` is the action held before this decision. */
export function features(o: Observation, prev: Action): number[] {
  const map = getMap(o.mapId);
  const s = o.self;
  const planted = o.spike.state === 'planted';
  const e = o.enemy ?? o.lastSeenEnemy;
  const walls: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    walls.push(clip(rayWalls(map.walls, s.x, s.y, Math.cos(a), Math.sin(a)) / 10));
  }
  const zone = zoneOf(o);
  const pm = MOVES[prev.move];
  return [
    s.x / map.width, s.y / map.height, s.hp / C.MAX_HP, clip(s.ammo / weapon(s.equipped === 0 ? s.primary : s.secondary).mag), s.reloadTicks > 0 ? 1 : 0,
    s.smokes, s.dashes, s.flashes / C.FLASHES, o.attacker === o.slot ? 1 : 0, clip(o.roundTicksLeft / C.ROUND_TICKS),
    planted ? 1 : 0,
    planted ? clip(0.5 + (o.spike.x - s.x) / (2 * map.width)) : 0.5,
    planted ? clip(0.5 + (o.spike.y - s.y) / (2 * map.height)) : 0.5,
    o.enemy ? 1 : 0,
    e ? clip(0.5 + (e.x - s.x) / 60) : 0.5,
    e ? clip(0.5 + (e.y - s.y) / 60) : 0.5,
    o.enemy ? 0 : o.lastSeenEnemy ? clip(o.lastSeenEnemy.ticksAgo / (10 * 32)) : 1,
    ...walls,
    zone === 'site' ? 1 : 0, zone === 'spawn' ? 1 : 0, zone === 'mid' ? 1 : 0,
    (pm.x + 1) / 2, (pm.y + 1) / 2, prev.fire ? 1 : 0,
    s.blindTicks > 0 ? 1 : 0,
  ];
}
