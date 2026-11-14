import type { Rect, Smoke } from './types';
import { C } from './constants';

/** Distance along a unit-direction ray to where it enters the rect, or Infinity. */
export function rayRect(ox: number, oy: number, dx: number, dy: number, r: Rect): number {
  let tmin = 0;
  let tmax = Infinity;
  if (dx === 0) {
    if (ox < r.x || ox > r.x + r.w) return Infinity;
  } else {
    const t1 = (r.x - ox) / dx;
    const t2 = (r.x + r.w - ox) / dx;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  if (dy === 0) {
    if (oy < r.y || oy > r.y + r.h) return Infinity;
  } else {
    const t1 = (r.y - oy) / dy;
    const t2 = (r.y + r.h - oy) / dy;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  }
  return tmin <= tmax ? tmin : Infinity;
}

/** Distance along a unit-direction ray to a circle, 0 if the origin is inside it, or Infinity. */
export function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, rad: number): number {
  const ex = cx - ox;
  const ey = cy - oy;
  const d2 = ex * ex + ey * ey;
  if (d2 <= rad * rad) return 0;
  const proj = ex * dx + ey * dy;
  if (proj < 0) return Infinity;
  const perp2 = d2 - proj * proj;
  if (perp2 > rad * rad) return Infinity;
  return proj - Math.sqrt(rad * rad - perp2);
}

/** Distance to the nearest wall along a unit-direction ray. Border walls make this always finite inside the map. */
export function rayWalls(walls: Rect[], ox: number, oy: number, dx: number, dy: number): number {
  let best = Infinity;
  for (const w of walls) {
    const t = rayRect(ox, oy, dx, dy, w);
    if (t < best) best = t;
  }
  return best;
}

/** True if a wall or smoke lies on the straight segment between two points. */
export function sightBlocked(walls: Rect[], smokes: Smoke[], ax: number, ay: number, bx: number, by: number): boolean {
  const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
  if (len === 0) return false;
  const dx = (bx - ax) / len;
  const dy = (by - ay) / len;
  if (rayWalls(walls, ax, ay, dx, dy) < len) return true;
  for (const k of smokes) {
    if (rayCircle(ax, ay, dx, dy, k.x, k.y, C.SMOKE_RADIUS) < len) return true;
  }
  return false;
}
