// The behavior trace. Every bot decision writes one line that cites the past moment it copied,
// so the trace panel can answer "why did the clone do that" with a real recorded tick.

import type { Input, Slot } from './types';

/** A pointer into recorded data: this decision came from this match at this tick. */
export type TraceRef = { matchId: string; tick: number; playerName: string; weight: number };

/**
 * One line of the behavior trace. `tick` is the rewind-session tick it happened on, `actor` the slot it drove.
 * The reason is always something a human can read back and check against the recording.
 */
export type TraceEvent =
  // The clone acted by copying its nearest neighbors. `because` names the matches and ticks it averaged.
  | { kind: 'CLONE'; tick: number; actor: Slot; nnDist: number; confidence: number; because: TraceRef[]; action: string }
  // Ghost replay handed control to the clone because the branch drifted too far from the recording.
  | { kind: 'HANDOFF'; tick: number; actor: Slot; score: number; limit: number }
  // The circuit breaker fired: the nearest neighbor was too far away, so a hand-written bot took over.
  | { kind: 'BREAKER'; tick: number; actor: Slot; nnDist: number; limit: number; reason: string }
  // The ghost is still replaying the recorded inputs faithfully.
  | { kind: 'GHOST'; tick: number; actor: Slot; score: number };

/** A short human-readable summary of an Input, for the trace line's `action` field. */
export function describeAction(input: Input): string {
  const dir = input.move.x === 0 && input.move.y === 0 ? 'hold' : `move ${input.move.x},${input.move.y}`;
  const parts = [input.walk ? 'walk' : 'run', dir];
  if (input.fire) parts.push('fire');
  if (input.reload) parts.push('reload');
  if (input.smoke) parts.push('smoke');
  if (input.dash) parts.push('dash');
  if (input.use) parts.push('use');
  return parts.join(' ');
}
