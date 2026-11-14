// Feature extraction from an Observation ONLY. A clone that trained on anything the real player
// could not see would be cheating the fog, so every number here comes from `observe` (DECISIONS D8).
import { C, TICK_RATE, getMap, rayWalls, type Observation } from '@rewind/engine';

const map = getMap('duel');

/** The eight ray directions for "distance to nearest wall", clockwise from +x. */
const RAY_DIRS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * 2 * Math.PI;
  return { dx: Math.cos(a), dy: Math.sin(a) };
});

/** The zones a position can be in. One-hot encoded so the clone treats them as unrelated, not ordered. */
export const ZONES = ['A', 'B', 'mid', 'spawn'] as const;
export type Zone = (typeof ZONES)[number];

/** Which coarse area of the map a point is in. Used as a feature and shown in the trace. */
export function zoneOf(x: number, y: number): Zone {
  if (x >= map.sites.A.x && y <= map.sites.A.y + map.sites.A.h) return 'A';
  if (x >= map.sites.B.x && y >= map.sites.B.y) return 'B';
  if (x < 10) return 'spawn';
  return 'mid';
}

/** The width of a feature vector. Kept in one place so dataset, knn and tests agree. */
export const FEATURE_DIM =
  2 + // own x, y
  1 + // hp
  1 + // ammo
  1 + // smokes charge
  1 + // dashes charge
  1 + // side (attacker?)
  1 + // round time left
  3 + // spike state one-hot (carried, planted, defused/detonated)
  1 + // enemy visible?
  2 + // enemy relative x, y (last seen if not visible)
  1 + // seconds since last seen (0 if visible, 1 if never)
  8 + // distance to nearest wall in 8 directions
  ZONES.length + // zone one-hot
  1; // previous action bucket, normalized

/**
 * Turns an Observation plus the previous action index into a vector roughly in [0, 1].
 * `prevAction` is the action id the policy chose last decision (see actions.ts); -1 for none.
 */
export function extractFeatures(o: Observation, prevAction: number, numActions: number): number[] {
  const self = o.self;
  const f: number[] = [];

  // Own position, normalized to the map.
  f.push(self.x / map.width, self.y / map.height);
  f.push(self.hp / C.MAX_HP);
  f.push(self.ammo / C.MAG);
  f.push(self.smokes); // already 0 or 1
  f.push(self.dashes);
  f.push(o.attacker === o.slot ? 1 : 0);
  f.push(Math.max(0, o.roundTicksLeft) / C.ROUND_TICKS);

  // Spike: carried / planted / resolved.
  f.push(o.spike.state === 'carried' ? 1 : 0);
  f.push(o.spike.state === 'planted' ? 1 : 0);
  f.push(o.spike.state === 'defused' || o.spike.state === 'detonated' ? 1 : 0);

  // Enemy: relative position if visible, else last-seen, else nothing. Relative so it generalizes across the map.
  const rel = o.enemy
    ? { x: o.enemy.x - self.x, y: o.enemy.y - self.y, ago: 0, known: 1 }
    : o.lastSeenEnemy
      ? { x: o.lastSeenEnemy.x - self.x, y: o.lastSeenEnemy.y - self.y, ago: o.lastSeenEnemy.ticksAgo, known: 1 }
      : { x: 0, y: 0, ago: 0, known: 0 };
  f.push(o.enemy ? 1 : 0);
  f.push(clamp01((rel.x + map.width) / (2 * map.width)), clamp01((rel.y + map.height) / (2 * map.height)));
  f.push(rel.known ? clamp01(rel.ago / (10 * TICK_RATE)) : 1);

  // Distance to the nearest wall in 8 directions. Caps the sight range so an open lane maxes out.
  for (const { dx, dy } of RAY_DIRS) {
    f.push(clamp01(rayWalls(map.walls, self.x, self.y, dx, dy) / C.VISION_RANGE));
  }

  // Zone one-hot.
  const z = zoneOf(self.x, self.y);
  for (const zone of ZONES) f.push(z === zone ? 1 : 0);

  // Previous action, normalized. -1 (none) maps to 0.
  f.push(prevAction < 0 ? 0 : prevAction / Math.max(1, numActions - 1));

  return f;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
