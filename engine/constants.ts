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
  // Flashbang. One-sided: it only blinds a player whose view cone the pop lands in, with a clear line to it.
  FLASHES: 2,                // charges per round
  FLASH_COOLDOWN: 16,        // ticks between throws, so a held key throws one at a time
  FLASH_SPEED: 0.5,          // units per tick in flight (16 units/s)
  FLASH_FUSE: 16,            // ticks from throw to pop (0.5 s), so it lands at most 8 units out
  FLASH_RANGE: 20,           // a pop further away than this does nothing
  FLASH_FULL_CONE: (35 * Math.PI) / 180, // looking near the pop: full blind
  FLASH_BLIND_FULL: 72,      // 2.25 s
  FLASH_BLIND_EDGE: 36,      // pop at the edge of the view cone: 1.1 s
  FLASH_FAR: 12,             // beyond this distance blind time is cut to FLASH_FAR_FACTOR
  FLASH_FAR_FACTOR: 0.65,
  // Footsteps. A running (or dashing) enemy within this range is heard through walls, at a rough position.
  // Walking with Shift is silent. This is the only information that crosses walls.
  HEAR_RANGE: 14,
  HEAR_GRID: 2,              // heard positions snap to the centre of a 2 by 2 unit cell
} as const;
