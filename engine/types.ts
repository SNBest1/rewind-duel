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
  /** Throw a flashbang along the aim. Optional so older match files (no flash key) still replay. */
  flash?: boolean;
  /** Buy this weapon id (only in the buy phase at the start of a round). */
  buy?: number;
  /** Equip the primary (0) or the secondary (1). */
  equip?: 0 | 1;
};

export const IDLE: Input = {
  move: { x: 0, y: 0 },
  walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false, flash: false,
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
  flashes: number;       // flashbang charges left this round
  flashCooldown: number; // ticks until another flash may be thrown
  blindTicks: number;    // ticks left blinded by a flash; a blind player sees nothing
  primary: number;       // weapon id (engine/weapons.ts); kept across rounds
  secondary: number;
  equipped: 0 | 1;       // 0 = primary in hand, 1 = secondary
  ammo2: number;         // magazine of the weapon not in hand (`ammo` is the one in hand)
  switchTicks: number;   // ticks left swapping weapons; cannot fire meanwhile
  spray: number;         // consecutive-shot counter for spray bloom; decays when you stop firing
  shotTick: number;      // last tick this player fired, -1 if never
  credits: number;       // VALORANT economy (unused in classic rules)
  armor: number;         // shield points, taken before hp
  moveState: MoveState;
  lastSeen: { x: number; y: number; tick: number } | null; // where this player last saw the enemy
};

export type Smoke = { x: number; y: number; ticksLeft: number };
/** A flashbang in flight. It travels in a straight line and pops where it is when ticksLeft reaches 0. */
export type FlashBang = { x: number; y: number; vx: number; vy: number; ticksLeft: number; slot: Slot };
export type Spike = { state: 'carried' | 'planted' | 'defused' | 'detonated'; x: number; y: number; ticksLeft: number };
export type Phase = 'live' | 'roundEnd' | 'matchEnd';

/** 'classic': the original rules (free buys, guns kept). 'valorant': credits, shields, lose your guns when you die. */
export type Rules = 'classic' | 'valorant';

export type State = {
  rules: Rules;
  /** Rounds lost in a row, per slot, for the loss bonus. */
  lossStreak: [number, number];
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
  flashes: FlashBang[];
  spike: Spike;
  winner: Slot | null;
};

export type RoundEndReason = 'kill' | 'time' | 'defuse' | 'detonation';

export type GameEvent =
  | { type: 'shot'; tick: number; slot: Slot; x: number; y: number; toX: number; toY: number; angle: number; hit: boolean; weapon?: number; head?: boolean; damage?: number }
  | { type: 'kill'; tick: number; killer: Slot; victim: Slot; head?: boolean; weapon?: number }
  | { type: 'buy'; tick: number; slot: Slot; weapon: number; cost?: number }
  | { type: 'credits'; tick: number; slot: Slot; amount: number; reason: 'win' | 'loss' | 'kill' | 'plant' }
  | { type: 'smoke'; tick: number; slot: Slot; x: number; y: number }
  | { type: 'dash'; tick: number; slot: Slot }
  | { type: 'flash'; tick: number; slot: Slot; x: number; y: number }
  | { type: 'flashPop'; tick: number; slot: Slot; x: number; y: number }
  /** `slot` was blinded for `ticks` by a flash thrown by `by`. */
  | { type: 'blinded'; tick: number; slot: Slot; by: Slot; ticks: number }
  /** `slot` was in range and line of sight of a pop but looking away, so it did nothing. */
  | { type: 'flashDodged'; tick: number; slot: Slot }
  | { type: 'teleport'; tick: number; slot: Slot; fromX: number; fromY: number; x: number; y: number }
  | { type: 'plant'; tick: number; slot: Slot; x: number; y: number }
  | { type: 'defuse'; tick: number; slot: Slot }
  | { type: 'detonate'; tick: number }
  | { type: 'roundStart'; tick: number; round: number; attacker: Slot }
  | { type: 'roundEnd'; tick: number; round: number; winner: Slot; reason: RoundEndReason }
  | { type: 'matchEnd'; tick: number; winner: Slot };

/** Everything one player is allowed to know. Built only by observe(). */
export type Observation = {
  rules: Rules;
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
  /** Flashbangs in flight that this player can see. */
  flashes: { x: number; y: number; ticksLeft: number; mine: boolean }[];
  /**
   * Where you hear an enemy you cannot see, snapped to a 2-unit cell: running footsteps (14 units) or an
   * unsilenced shot (30 units), through walls. Null if they are silent, far or visible.
   */
  heard: { x: number; y: number; kind?: 'steps' | 'shot' } | null;
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
  /** Missing in files recorded before VALORANT rules existed: those are classic. */
  rules?: Rules;
};
