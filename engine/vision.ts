import { C } from './constants';
import { sightBlocked } from './geometry';
import { getMap } from './map';
import type { GameEvent, Observation, Slot, State } from './types';

/** Smallest signed difference between two angles, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** The one visibility rule. Server fog, clone knowledge and lastSeen all go through here. */
export function canSee(s: State, from: Slot, to: Slot): boolean {
  const a = s.players[from];
  const b = s.players[to];
  if (a.hp <= 0 || b.hp <= 0) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > C.NEAR_RANGE) {
    if (dist > C.VISION_RANGE) return false;
    if (Math.abs(angleDiff(Math.atan2(dy, dx), a.aim)) > C.VISION_HALF_CONE) return false;
  }
  return !sightBlocked(getMap(s.mapId).walls, s.smokes, a.x, a.y, b.x, b.y);
}

/** Only what that player can see, plus the last seen enemy position and how long ago. */
export function observe(s: State, slot: Slot): Observation {
  const other = (1 - slot) as Slot;
  const { lastSeen, ...self } = s.players[slot];
  const e = s.players[other];
  return {
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
    spike: { ...s.spike },
  };
}

/**
 * Events one player may receive. Enemy shots and dashes would leak the enemy position,
 * so they pass only if the enemy is visible or the shot landed on this player.
 */
export function visibleEvents(s: State, slot: Slot, events: GameEvent[]): GameEvent[] {
  const other = (1 - slot) as Slot;
  return events.filter((e) => {
    if (e.type === 'shot') return e.slot === slot || e.hit || canSee(s, slot, other);
    if (e.type === 'dash') return e.slot === slot || canSee(s, slot, other);
    return true;
  });
}
