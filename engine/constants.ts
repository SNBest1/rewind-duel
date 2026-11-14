export const TICK_RATE = 32;

/** All durations are integer ticks so replays never depend on float time accumulation. */
export const C = {
  RADIUS: 0.4,
  RUN: 5 / TICK_RATE,        // units per tick
  WALK: 2.5 / TICK_RATE,
  MAX_HP: 100,
  FIRE_COOLDOWN: 8,          // 4 shots per second
  DAMAGE: 25,
  MAG: 10,
  RELOAD_TICKS: 64,
  SPREAD_DEG: [1, 4, 10],    // indexed by MoveState: still, walk, run
  SMOKE_RADIUS: 2.5,
  SMOKE_RANGE: 8,
  SMOKE_TICKS: 256,
  DASH_TICKS: 6,             // 0.1875 s; the spec's 0.2 s is 6.4 ticks
  DASH_DIST: 4,
  PLANT_TICKS: 64,
  DEFUSE_TICKS: 128,
  DEFUSE_RANGE: 1.5,
  FUSE_TICKS: 960,
  ROUND_TICKS: 1920,
  INTERMISSION_TICKS: 96,
  WIN_SCORE: 5,
  SWAP_AFTER_ROUND: 4,
  VISION_RANGE: 30,
  VISION_HALF_CONE: (50 * Math.PI) / 180,
  NEAR_RANGE: 3,
} as const;
