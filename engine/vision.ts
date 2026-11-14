import { C } from './constants';
import { sightBlocked } from './geometry';
import { getMap } from './map';
import type { GameEvent, Observation, Slot, State } from './types';
import { SHOT_HEAR_RANGE, weapon } from './weapons';

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Whether player `from` can see the point (x, y): alive, not blinded, in range and cone (or very near), clear line. */
export function canSeePoint(s: State, from: Slot, x: number, y: number): boolean {
  const a = s.players[from];
  if (a.hp <= 0 || a.blindTicks > 0) return false;
  const dx = x - a.x;
  const dy = y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > C.NEAR_RANGE) {
    if (dist > C.VISION_RANGE) return false;
    if (Math.abs(angleDiff(Math.atan2(dy, dx), a.aim)) > C.VISION_HALF_CONE) return false;
  }
  return !sightBlocked(getMap(s.mapId).walls, s.smokes, a.x, a.y, x, y);
}

/** The one visibility rule. Server fog, clone knowledge and lastSeen all go through here. A blind player sees nothing. */
export function canSee(s: State, from: Slot, to: Slot): boolean {
  const b = s.players[to];
  if (b.hp <= 0) return false;
  return canSeePoint(s, from, b.x, b.y);
}

/** Only what that player can see, plus the last seen enemy position and how long ago. */
export function observe(s: State, slot: Slot): Observation {
  const other = (1 - slot) as Slot;
  const { lastSeen, ...self } = s.players[slot];
  const e = s.players[other];
  return {
    rules: s.rules,
    tick: s.tick,
    slot,
    mapId: s.mapId,
    round: s.round,
    score: [s.score[0], s.score[1]],
    attacker: s.attacker,
    phase: s.phase,
    roundTicksLeft: C.ROUND_TICKS - s.roundTicks,
    winner: s.winner,
    self,
    enemy: canSee(s, slot, other) ? { x: e.x, y: e.y, aim: e.aim, hp: e.hp } : null,
    lastSeenEnemy: lastSeen && { x: lastSeen.x, y: lastSeen.y, ticksAgo: s.tick - lastSeen.tick },
    smokes: s.smokes.map((k) => ({ ...k })),
    // Your own flashes always; the enemy's only while you can see the grenade itself.
    flashes: s.flashes
      .filter((f) => f.slot === slot || canSeePoint(s, slot, f.x, f.y))
      .map((f) => ({ x: f.x, y: f.y, ticksLeft: f.ticksLeft, mine: f.slot === slot })),
    heard: hearFootsteps(s, slot),
    spike: { ...s.spike },
  };
}

/**
 * What `slot` hears of an enemy it cannot see: an unsilenced shot fired last tick (within 30 units), else
 * running footsteps (within 14). Both come through walls, snapped to a 2-unit cell.
 */
export function hearFootsteps(s: State, slot: Slot): { x: number; y: number; kind: 'steps' | 'shot' } | null {
  const me = s.players[slot];
  const e = s.players[(1 - slot) as Slot];
  if (me.hp <= 0 || e.hp <= 0) return null;
  if (canSee(s, slot, (1 - slot) as Slot)) return null;
  const d = Math.hypot(e.x - me.x, e.y - me.y);
  const g = C.HEAR_GRID;
  const at = { x: (Math.floor(e.x / g) + 0.5) * g, y: (Math.floor(e.y / g) + 0.5) * g };
  const gun = weapon(e.equipped === 0 ? e.primary : e.secondary);
  // `s.tick` has already advanced past the tick the shot was fired on.
  if (e.shotTick === s.tick - 1 && !gun.silenced && d <= SHOT_HEAR_RANGE) return { ...at, kind: 'shot' };
  if (e.moveState === 2 && d <= C.HEAR_RANGE) return { ...at, kind: 'steps' };
  return null;
}

/**
 * Events one player may receive. Enemy shots and dashes would leak the enemy position,
 * so they pass only if the enemy is visible or the shot landed on this player.
 */
export function visibleEvents(s: State, slot: Slot, events: GameEvent[]): GameEvent[] {
  const other = (1 - slot) as Slot;
  return events.filter((e) => {
    if (e.type === 'shot') return e.slot === slot || e.hit || canSee(s, slot, other);
    if (e.type === 'dash' || e.type === 'flash' || e.type === 'teleport') return e.slot === slot || canSee(s, slot, other);
    // A pop is loud: everyone hears where it went off. Who it blinded is told only to the two people involved.
    if (e.type === 'blinded') return e.slot === slot || e.by === slot;
    if (e.type === 'flashDodged') return e.slot === slot;
    return true;
  });
}
