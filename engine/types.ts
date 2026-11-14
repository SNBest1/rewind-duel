export type Slot = 0 | 1;

export type Input = {
  move: { x: -1 | 0 | 1; y: -1 | 0 | 1 };
  walk: boolean;
  aim: number;
  fire: boolean;
  reload: boolean;
  smoke: boolean;
  dash: boolean;
  use: boolean;
};

export const IDLE: Input = {
  move: { x: 0, y: 0 },
  walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false,
};

export type Rect = { x: number; y: number; w: number; h: number };

/** 0 = standing still, 1 = walking, 2 = running or dashing. Indexes SPREAD_DEG. */
export type MoveState = 0 | 1 | 2;

export type PlayerState = {
  x: number; y: number; aim: number; hp: number;
  ammo: number;
  reloadTicks: number;   // ticks left on the reload, 0 = not reloading
  fireCooldown: number;  // ticks until the next shot is allowed
  smokes: number;        // charges left this round
  dashes: number;
  dashTicks: number;     // ticks left in the current dash
  dashX: number; dashY: number; // per-tick dash displacement
  useTicks: number;      // plant or defuse progress
  moveState: MoveState;
  lastSeen: { x: number; y: number; tick: number } | null; // where this player last saw the enemy
};

export type Smoke = { x: number; y: number; ticksLeft: number };
export type Spike = { state: 'carried' | 'planted' | 'defused' | 'detonated'; x: number; y: number; ticksLeft: number };
export type Phase = 'live' | 'roundEnd' | 'matchEnd';

export type State = {
  tick: number;
  rng: number; // mulberry32 state, so a forked state carries its own random future
  mapId: string;
  round: number; // 1-based
  score: [number, number]; // by slot
  attacker: Slot;
  phase: Phase;
  phaseTicks: number; // intermission ticks left while phase is roundEnd
  roundTicks: number; // live ticks elapsed this round
  players: [PlayerState, PlayerState];
  smokes: Smoke[];
  spike: Spike;
  winner: Slot | null;
};

export type RoundEndReason = 'kill' | 'time' | 'defuse' | 'detonation';

export type GameEvent =
  | { type: 'shot'; tick: number; slot: Slot; x: number; y: number; toX: number; toY: number; angle: number; hit: boolean }
  | { type: 'kill'; tick: number; killer: Slot; victim: Slot }
  | { type: 'smoke'; tick: number; slot: Slot; x: number; y: number }
  | { type: 'dash'; tick: number; slot: Slot }
  | { type: 'plant'; tick: number; slot: Slot; x: number; y: number }
  | { type: 'defuse'; tick: number; slot: Slot }
  | { type: 'detonate'; tick: number }
  | { type: 'roundStart'; tick: number; round: number; attacker: Slot }
  | { type: 'roundEnd'; tick: number; round: number; winner: Slot; reason: RoundEndReason }
  | { type: 'matchEnd'; tick: number; winner: Slot };

/** Everything one player is allowed to know. Built only by observe(). */
export type Observation = {
  tick: number;
  slot: Slot;
  mapId: string;
  round: number;
  score: [number, number];
  attacker: Slot;
  phase: Phase;
  roundTicksLeft: number;
  winner: Slot | null;
  self: Omit<PlayerState, 'lastSeen'>;
  enemy: { x: number; y: number; aim: number; hp: number } | null; // null whenever the enemy is not visible
  lastSeenEnemy: { x: number; y: number; ticksAgo: number } | null;
  smokes: Smoke[];
  spike: Spike;
};

// Policy lives in the engine so the server (rewind), clone/ and eval/ all share one type,
// and so a Policy can never import anything non-deterministic. Its TraceRef/TraceEvent are in trace.ts.
export type { TraceRef, TraceEvent } from './trace';
import type { TraceRef } from './trace';

/**
 * Anything that can drive a slot from what that slot is allowed to see.
 * `act` gets an Observation (never the full State) so a Policy physically cannot cheat the fog.
 */
export interface Policy {
  name: string;
  act(obs: Observation): { input: Input; confidence: number; because: TraceRef[] };
}

export type MatchFile = {
  id: string;
  seed: number;
  map: string;
  players: { slot: Slot; name: string }[];
  /** Delta-encoded: an entry means "from this tick on, this slot's input is this". Sorted by tick. */
  inputs: { tick: number; slot: Slot; input: Input }[];
  ticks: number; // total ticks stepped; replay stops here
  finalHash: string;
};
