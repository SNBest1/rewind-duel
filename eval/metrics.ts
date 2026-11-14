// The evidence metrics. Each one replays held-out matches (data a clone never trained on) and compares
// a policy's decisions against what the real person did, so the numbers mean something. Three policies are
// compared everywhere: the player's own clone, the basic bot, and a clone of a DIFFERENT player.
import {
  IDLE, createMatch, observe, step,
  type Input, type MatchFile, type Observation, type Policy, type Slot, type State,
} from '@rewind/engine';
import { DECISION_INTERVAL, GuardedClone } from '@rewind/clone';

/** Steps a held-out match, calling `visit` on every live decision tick for the given slot. */
function walkDecisions(file: MatchFile, slot: Slot, visit: (s: State, recorded: Input) => void): void {
  let s: State = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.phase === 'live' && s.players[slot].hp > 0 && s.tick % DECISION_INTERVAL === 0) {
      visit(s, current[slot]);
    }
    s = step(s, current).next;
  }
}

export type AccuracyResult = { decisions: number; moveMatch: number; fireMatch: number; bothMatch: number };

/**
 * Share of decisions where the policy's move direction AND fire choice match the real person.
 * The policy sees only the slot's Observation, so this is a fair "does it decide like them" measure.
 */
export function cloneAccuracy(file: MatchFile, slot: Slot, policy: Policy): AccuracyResult {
  let decisions = 0, moveMatch = 0, fireMatch = 0, bothMatch = 0;
  walkDecisions(file, slot, (s, recorded) => {
    const o: Observation = observe(s, slot);
    const chosen = policy.act(o).input;
    const sameMove = chosen.move.x === recorded.move.x && chosen.move.y === recorded.move.y;
    const sameFire = chosen.fire === recorded.fire;
    decisions++;
    if (sameMove) moveMatch++;
    if (sameFire) fireMatch++;
    if (sameMove && sameFire) bothMatch++;
  });
  return { decisions, moveMatch, fireMatch, bothMatch };
}

export type PositionResult = { starts: number; avgError: number; medianError: number };

/**
 * Position error: from each held-out decision moment, run the policy for 1 second and measure how far it
 * ends from where the real person actually ended. Both the policy and the "truth" run in the engine, so
 * the only difference is the inputs. The opponent is frozen (held still) so the comparison is about this
 * player's own movement, not a diverging fight.
 */
export function positionError(file: MatchFile, slot: Slot, policy: Policy, horizonTicks = 32): PositionResult {
  const other = (1 - slot) as Slot;
  const errors: number[] = [];

  // Precompute the real per-tick inputs for this slot, so "truth" replays exactly what they did.
  const realInputs = recordedInputMap(file, slot);

  walkDecisions(file, slot, (s) => {
    // Truth: run the real inputs for 1 second from here.
    const truth = runFrom(s, slot, other, horizonTicks, (tick) => realInputs.get(tick) ?? lastInputBefore(realInputs, tick));
    // Policy: run the policy's choices for 1 second from the same start.
    const pol = runFrom(s, slot, other, horizonTicks, null, policy);
    errors.push(Math.hypot(pol.x - truth.x, pol.y - truth.y));
  });

  errors.sort((a, b) => a - b);
  const avg = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
  const median = errors.length ? errors[Math.floor(errors.length / 2)] : 0;
  return { starts: errors.length, avgError: avg, medianError: median };
}

/** Runs `horizon` ticks from a start state, driving `slot` either from a recorded-input getter or a policy,
 *  with the other slot held still. Returns the slot's final position. */
function runFrom(
  start: State, slot: Slot, other: Slot, horizon: number,
  recorded: ((tick: number) => Input) | null,
  policy?: Policy,
): { x: number; y: number } {
  let s = cloneState(start);
  for (let t = 0; t < horizon && s.phase === 'live'; t++) {
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[slot] = recorded ? recorded(s.tick) : policy!.act(observe(s, slot)).input;
    inputs[other] = IDLE; // freeze the opponent: this measures the player's own path, not a fight
    s = step(s, inputs).next;
  }
  return { x: s.players[slot].x, y: s.players[slot].y };
}

/** Handoff rate: the share of rewind decision ticks the guarded clone spends under the circuit breaker. */
export function handoffRate(file: MatchFile, slot: Slot, guarded: GuardedClone): { ticks: number; broke: number; rate: number } {
  let ticks = 0, broke = 0;
  walkDecisions(file, slot, (s) => {
    const o = observe(s, slot);
    ticks++;
    if (guarded.wouldBreak(o)) broke++;
  });
  return { ticks, broke, rate: ticks ? broke / ticks : 0 };
}

// --- small helpers ------------------------------------------------------------------------------

function cloneState(s: State): State {
  return JSON.parse(JSON.stringify(s)) as State;
}

function recordedInputMap(file: MatchFile, slot: Slot): Map<number, Input> {
  const m = new Map<number, Input>();
  for (const e of file.inputs) if (e.slot === slot) m.set(e.tick, e.input);
  return m;
}

function lastInputBefore(m: Map<number, Input>, tick: number): Input {
  let best = IDLE;
  let bestTick = -1;
  for (const [t, inp] of m) {
    if (t <= tick && t > bestTick) { bestTick = t; best = inp; }
  }
  return best;
}
