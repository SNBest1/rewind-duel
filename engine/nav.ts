// Navigation grid and distance fields. Pure and deterministic, but not part of the game state:
// bots use it to find their way, tests use it to prove every map is playable.
import { C } from './constants';
import type { GameMap } from './map';

export const NAV_CELL = 0.5;

/**
 * Distance fields keyed by map and a target rounded to 1 unit, shared by every bot and planner in the process.
 * Each is ~50 KB; the cap keeps the cache under ~15 MB. Insertion order makes it a simple LRU.
 */
const fieldCache = new Map<string, Float64Array>();
const FIELD_CACHE_MAX = 300;
export function cachedField(g: NavGrid, x: number, y: number): Float64Array {
  const key = `${g.map.id}:${Math.round(x)},${Math.round(y)}`;
  let f = fieldCache.get(key);
  if (f) {
    fieldCache.delete(key);
    fieldCache.set(key, f);
    return f;
  }
  f = distanceField(g, Math.round(x), Math.round(y));
  fieldCache.set(key, f);
  if (fieldCache.size > FIELD_CACHE_MAX) fieldCache.delete(fieldCache.keys().next().value!);
  return f;
}
/** A little more than the player radius, so paths keep bots off wall corners. */
const CLEARANCE = C.RADIUS + 0.15;

export type NavGrid = {
  cols: number;
  rows: number;
  free: Uint8Array; // 1 = a player can stand at this cell's centre
  map: GameMap;
};

const grids = new Map<string, NavGrid>();

export function navGrid(map: GameMap): NavGrid {
  const cached = grids.get(map.id);
  if (cached) return cached;
  const cols = Math.round(map.width / NAV_CELL);
  const rows = Math.round(map.height / NAV_CELL);
  const free = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL;
      const y = (cy + 0.5) * NAV_CELL;
      let ok = true;
      for (const w of map.walls) {
        const nx = Math.min(Math.max(x, w.x), w.x + w.w);
        const ny = Math.min(Math.max(y, w.y), w.y + w.h);
        if ((x - nx) ** 2 + (y - ny) ** 2 < CLEARANCE * CLEARANCE) {
          ok = false;
          break;
        }
      }
      free[cy * cols + cx] = ok ? 1 : 0;
    }
  }
  const g = { cols, rows, free, map };
  grids.set(map.id, g);
  return g;
}

export function cellOf(g: NavGrid, x: number, y: number): number {
  const cx = Math.max(0, Math.min(g.cols - 1, Math.floor(x / NAV_CELL)));
  const cy = Math.max(0, Math.min(g.rows - 1, Math.floor(y / NAV_CELL)));
  return cy * g.cols + cx;
}

export function cellCenter(g: NavGrid, c: number): { x: number; y: number } {
  return { x: ((c % g.cols) + 0.5) * NAV_CELL, y: (Math.floor(c / g.cols) + 0.5) * NAV_CELL };
}

/** The nearest free cell to a point (the point's own cell if it is free). */
export function nearestFree(g: NavGrid, x: number, y: number): number {
  const start = cellOf(g, x, y);
  if (g.free[start]) return start;
  let best = -1;
  let bestD = Infinity;
  for (let c = 0; c < g.free.length; c++) {
    if (!g.free[c]) continue;
    const p = cellCenter(g, c);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Distance (in cells) from every cell to `target`, walking. Teleporters are followed:
 * a pad cell costs the exit's distance plus one, so a path through a teleporter is found
 * when it is shorter. Unreachable cells are Infinity.
 */
export function distanceField(g: NavGrid, tx: number, ty: number): Float64Array {
  const dist = new Float64Array(g.free.length).fill(Infinity);
  const goal = nearestFree(g, tx, ty);
  if (goal < 0) return dist;
  // Dijkstra with a simple binary heap.
  const heap: [number, number][] = [];
  const push = (d: number, c: number) => {
    heap.push([d, c]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  // Reverse teleporter edges: from an exit cell, the pad cells reach it at cost 1.
  const padsByExit = new Map<number, number[]>();
  for (const tp of g.map.teleporters) {
    const exit = cellOf(g, tp.exit.x, tp.exit.y);
    const pads: number[] = [];
    for (let c = 0; c < g.free.length; c++) {
      if (!g.free[c]) continue;
      const p = cellCenter(g, c);
      if (p.x >= tp.pad.x && p.x <= tp.pad.x + tp.pad.w && p.y >= tp.pad.y && p.y <= tp.pad.y + tp.pad.h) pads.push(c);
    }
    padsByExit.set(exit, [...(padsByExit.get(exit) ?? []), ...pads]);
  }
  dist[goal] = 0;
  push(0, goal);
  while (heap.length) {
    const [d, c] = pop();
    if (d > dist[c]) continue;
    const cx = c % g.cols;
    const cy = Math.floor(c / g.cols);
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
      const n = ny * g.cols + nx;
      if (!g.free[n]) continue;
      // No corner cutting: a diagonal needs both orthogonal neighbours free.
      if (dx !== 0 && dy !== 0 && (!g.free[cy * g.cols + nx] || !g.free[ny * g.cols + cx])) continue;
      if (d + cost < dist[n]) {
        dist[n] = d + cost;
        push(dist[n], n);
      }
    }
    for (const pad of padsByExit.get(c) ?? []) {
      if (d + 1 < dist[pad]) {
        dist[pad] = d + 1;
        push(dist[pad], pad);
      }
    }
  }
  return dist;
}

/**
 * Which way to step from (x, y) to go downhill on a distance field, as move axes.
 * Returns zeros at the goal or where nothing is reachable.
 */
export function stepToward(g: NavGrid, field: Float64Array, x: number, y: number): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const here = nearestFree(g, x, y);
  if (here < 0 || field[here] === 0 || field[here] === Infinity) return { x: 0, y: 0 };
  const cx = here % g.cols;
  const cy = Math.floor(here / g.cols);
  let best = field[here];
  let bx = 0;
  let by = 0;
  for (const [dx, dy] of DIRS) {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
    const n = ny * g.cols + nx;
    if (!g.free[n]) continue;
    if (dx !== 0 && dy !== 0 && (!g.free[cy * g.cols + nx] || !g.free[ny * g.cols + cx])) continue;
    if (field[n] < best) {
      best = field[n];
      bx = dx;
      by = dy;
    }
  }
  // Standing on a pad whose exit is downhill: just stay put on it, the engine teleports.
  return { x: bx as -1 | 0 | 1, y: by as -1 | 0 | 1 };
}
