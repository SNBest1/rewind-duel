// Where is the enemy? A Bayesian occupancy grid over the map, updated every tick from the bot's own observation:
//
//   predict   probability spreads to neighbouring open cells at the enemy's top speed, weighted by where this
//             human likes to stand (the learned heat map), so it flows down their usual routes first
//   evidence  every cell the bot can see right now and the enemy is not in drops to zero (negative information);
//             footsteps pull all the mass into the heard cell; silence lowers nearby cells (they might be walking)
//   collapse  seeing the enemy puts all the mass on them
//
// No cheating: it uses only observe(). It is what makes the bot pre-aim the right corner, flash where you
// actually are, and rotate when it is sure you are stacked on the other site.
import { C, angleDiff, getMap, navGrid, nearestFree, sightBlocked, type GameMap, type Observation } from '@rewind/engine';
import { heatIndex, type MapMemory } from './brain';

const CELL = 1;
const DIFFUSE_EVERY = 3; // ticks; 1 cell per 3 ticks is ~10 units/s, a little faster than a runner, so it never under-spreads

export class Belief {
  readonly cols: number;
  readonly rows: number;
  readonly p: Float64Array;
  private free: Uint8Array;
  private prior: Float64Array;
  private neighbours: Int32Array[];
  private map: GameMap;
  private lastSeenTick = -1;
  /** Probability mass in each named site, refreshed each update. */
  siteMass: Record<string, number> = {};
  private siteCells: [string, Int32Array][] = [];
  private cx: Float64Array;
  private cy: Float64Array;
  private cachedPeak: { x: number; y: number; p: number } | null = null;
  private cachedAim: { tick: number; x: number; y: number; v: ReturnType<Belief['computeBestAim']> } | null = null;
  private tick = 0;

  constructor(mapId: string, mem: MapMemory | null, private learn: number) {
    this.map = getMap(mapId);
    this.cols = Math.round(this.map.width / CELL);
    this.rows = Math.round(this.map.height / CELL);
    const n = this.cols * this.rows;
    this.p = new Float64Array(n);
    this.free = new Uint8Array(n);
    this.prior = new Float64Array(n).fill(1);
    const g = navGrid(this.map);
    for (let c = 0; c < n; c++) {
      const { x, y } = this.center(c);
      const nc = nearestFree(g, x, y);
      const cx = ((nc % g.cols) + 0.5) * 0.5;
      const cy = (Math.floor(nc / g.cols) + 0.5) * 0.5;
      this.free[c] = Math.hypot(cx - x, cy - y) < 0.6 ? 1 : 0;
    }
    // Learned prior: cells this human often stands in pull more probability. Flat when there is no history.
    if (mem) {
      let max = 0;
      for (const v of mem.heat) max = Math.max(max, v);
      if (max > 0) {
        for (let c = 0; c < n; c++) {
          const { x, y } = this.center(c);
          this.prior[c] = 1 + 3 * this.learn * (mem.heat[heatIndex(x, y)] / max);
        }
      }
    }
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    for (let c = 0; c < n; c++) {
      const q = this.center(c);
      this.cx[c] = q.x;
      this.cy[c] = q.y;
    }
    for (const [label, r] of Object.entries(this.map.sites)) {
      const cells: number[] = [];
      for (let c = 0; c < n; c++) if (this.cx[c] >= r.x && this.cx[c] <= r.x + r.w && this.cy[c] >= r.y && this.cy[c] <= r.y + r.h) cells.push(c);
      this.siteCells.push([label, Int32Array.from(cells)]);
    }
    this.neighbours = [];
    for (let c = 0; c < n; c++) {
      const out: number[] = [];
      const cx = c % this.cols;
      const cy = Math.floor(c / this.cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const m = ny * this.cols + nx;
        if (this.free[m]) out.push(m);
      }
      this.neighbours.push(Int32Array.from(out));
    }
  }

  center(c: number): { x: number; y: number } {
    return { x: ((c % this.cols) + 0.5) * CELL, y: (Math.floor(c / this.cols) + 0.5) * CELL };
  }

  cellAt(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x / CELL)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y / CELL)));
    return cy * this.cols + cx;
  }

  /** All the mass on (x, y), spread over that cell and its neighbours. */
  collapse(x: number, y: number): void {
    this.p.fill(0);
    const c = this.cellAt(x, y);
    this.p[c] = 0.6;
    for (const n of this.neighbours[c]) this.p[n] = 0.4 / Math.max(1, this.neighbours[c].length);
    this.normalize();
  }

  /** Start of round: the enemy is at their spawn. */
  reset(enemySpawn: { x: number; y: number }): void {
    this.collapse(enemySpawn.x, enemySpawn.y);
    this.lastSeenTick = -1;
  }

  private normalize(): void {
    let sum = 0;
    for (let c = 0; c < this.p.length; c++) sum += this.p[c];
    if (sum < 1e-12) {
      // Every cell ruled out: our model was wrong somewhere. Fall back to the learned prior everywhere unseen.
      for (let c = 0; c < this.p.length; c++) this.p[c] = this.free[c] ? this.prior[c] : 0;
      sum = this.p.reduce((a, b) => a + b, 0);
    }
    for (let c = 0; c < this.p.length; c++) this.p[c] /= sum;
  }

  private scratch: Float64Array | null = null;

  private diffuse(): void {
    const next = (this.scratch ??= new Float64Array(this.p.length));
    next.fill(0);
    for (let c = 0; c < this.p.length; c++) {
      const v = this.p[c];
      if (v === 0) continue;
      const nb = this.neighbours[c];
      let w = 0;
      for (const n of nb) w += this.prior[n];
      const stay = 0.4;
      next[c] += v * (nb.length ? stay : 1);
      if (!nb.length) continue;
      for (const n of nb) next[n] += (v * (1 - stay) * this.prior[n]) / w;
    }
    this.p.set(next);
  }

  /** One tick of tracking from the bot's observation. */
  update(o: Observation): void {
    this.tick = o.tick;
    this.cachedPeak = null;
    if (o.enemy) {
      this.collapse(o.enemy.x, o.enemy.y);
      this.lastSeenTick = o.tick;
    } else {
      // A fresher last-seen than we had (e.g. the enemy crossed our view between ticks) restarts from there.
      if (o.lastSeenEnemy) {
        const at = o.tick - o.lastSeenEnemy.ticksAgo;
        if (at > this.lastSeenTick) {
          this.collapse(o.lastSeenEnemy.x, o.lastSeenEnemy.y);
          this.lastSeenTick = at;
          for (let i = 0; i < Math.floor(o.lastSeenEnemy.ticksAgo / DIFFUSE_EVERY); i++) this.diffuse();
        }
      }
      if (o.tick % DIFFUSE_EVERY === 0) this.diffuse();
      const { p, cx, cy } = this;
      if (o.heard) {
        // Footsteps are certain (the engine only reports them when the enemy really is in that 2 by 2 cell),
        // so everything outside the cell goes to zero. If our belief had nothing there, it was wrong: start
        // over evenly inside the cell.
        const hx = o.heard.x;
        const hy = o.heard.y;
        const half = C.HEAR_GRID / 2 + 0.6; // belief cells are 1 unit, centred on half units
        let inside = 0;
        for (let c = 0; c < p.length; c++) {
          if (Math.abs(cx[c] - hx) > half || Math.abs(cy[c] - hy) > half) p[c] = 0;
          else inside += p[c];
        }
        if (inside < 1e-9) {
          for (let c = 0; c < p.length; c++) if (this.free[c] && Math.abs(cx[c] - hx) <= half && Math.abs(cy[c] - hy) <= half) p[c] = 1;
        }
      } else {
        // Silence within hearing range: they are there only if walking. Mild evidence against.
        const r2 = C.HEAR_RANGE * C.HEAR_RANGE;
        const sx = o.self.x;
        const sy = o.self.y;
        for (let c = 0; c < p.length; c++) {
          if (!p[c]) continue;
          const dx = cx[c] - sx;
          const dy = cy[c] - sy;
          if (dx * dx + dy * dy < r2) p[c] *= 0.97;
        }
      }
      if (o.self.blindTicks === 0 && o.self.hp > 0 && o.tick % 3 === 0) this.clearVisible(o);
    }
    this.normalize();
    for (const [label, cells] of this.siteCells) {
      let m = 0;
      for (const c of cells) m += this.p[c];
      this.siteMass[label] = m;
    }
  }

  /** Negative information: cells in view right now hold nobody, or we would be seeing them. */
  private clearVisible(o: Observation): void {
    const { x: sx, y: sy, aim } = o.self;
    for (let c = 0; c < this.p.length; c++) {
      if (this.p[c] < 1e-7) {
        this.p[c] = 0;
        continue;
      }
      const x = this.cx[c];
      const y = this.cy[c];
      const d = Math.hypot(x - sx, y - sy);
      if (d > C.NEAR_RANGE) {
        if (d > C.VISION_RANGE) continue;
        if (Math.abs(angleDiff(Math.atan2(y - sy, x - sx), aim)) > C.VISION_HALF_CONE - 0.05) continue;
      }
      if (!sightBlocked(this.map.walls, o.smokes, sx, sy, x, y)) this.p[c] = 0;
    }
  }

  /** The single most likely cell, and its probability (with neighbours). Cached per tick. */
  peak(): { x: number; y: number; p: number } {
    if (this.cachedPeak) return this.cachedPeak;
    let best = 0;
    for (let c = 1; c < this.p.length; c++) if (this.p[c] > this.p[best]) best = c;
    let mass = this.p[best];
    for (const n of this.neighbours[best]) mass += this.p[n];
    return (this.cachedPeak = { ...this.center(best), p: mass });
  }

  /** Probability mass within `r` of a point. */
  massNear(x: number, y: number, r: number): number {
    let m = 0;
    for (let c = 0; c < this.p.length; c++) {
      if (!this.p[c]) continue;
      const q = this.center(c);
      if (Math.hypot(q.x - x, q.y - y) <= r) m += this.p[c];
    }
    return m;
  }

  /**
   * The aim direction that covers the most probability: of 36 directions from (x, y), the one whose 20-degree
   * wedge holds the most mass that is in line of sight. Pre-aiming this is aiming where you most likely are.
   */
  bestAim(x: number, y: number, smokes: Observation['smokes']): { angle: number; mass: number; at: { x: number; y: number } } {
    // Recomputed every 4 ticks or after moving half a unit; aim is smoothed anyway.
    const c = this.cachedAim;
    if (c && this.tick - c.tick < 4 && Math.hypot(c.x - x, c.y - y) < 0.5) return c.v;
    const v = this.computeBestAim(x, y, smokes);
    this.cachedAim = { tick: this.tick, x, y, v };
    return v;
  }

  private computeBestAim(x: number, y: number, smokes: Observation['smokes']): { angle: number; mass: number; at: { x: number; y: number } } {
    const BUCKETS = 36;
    const mass = new Float64Array(BUCKETS);
    const far = new Float64Array(BUCKETS);
    for (let c = 0; c < this.p.length; c++) {
      const v = this.p[c];
      if (v < 1e-5) continue;
      const q = this.center(c);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d > C.VISION_RANGE || d < 0.5) continue;
      if (sightBlocked(this.map.walls, smokes, x, y, q.x, q.y)) continue;
      const b = Math.floor(((Math.atan2(q.y - y, q.x - x) + Math.PI) / (2 * Math.PI)) * BUCKETS) % BUCKETS;
      mass[b] += v;
      far[b] += v * d;
    }
    let best = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const w = mass[(b + BUCKETS - 1) % BUCKETS] * 0.5 + mass[b] + mass[(b + 1) % BUCKETS] * 0.5;
      const bw = mass[(best + BUCKETS - 1) % BUCKETS] * 0.5 + mass[best] + mass[(best + 1) % BUCKETS] * 0.5;
      if (w > bw) best = b;
    }
    const angle = ((best + 0.5) / BUCKETS) * 2 * Math.PI - Math.PI;
    const d = mass[best] > 0 ? far[best] / mass[best] : 8;
    return { angle, mass: mass[best], at: { x: x + Math.cos(angle) * d, y: y + Math.sin(angle) * d } };
  }

  /** The grid as bytes 0-255 (relative to the peak), for drawing "what the AI thinks" on screen. */
  snapshot(): { cols: number; rows: number; data: string } {
    let max = 0;
    for (const v of this.p) max = Math.max(max, v);
    const bytes = new Uint8Array(this.p.length);
    for (let c = 0; c < this.p.length; c++) bytes[c] = max > 0 ? Math.round((255 * this.p[c]) / max) : 0;
    return { cols: this.cols, rows: this.rows, data: Buffer.from(bytes).toString('base64') };
  }
}
