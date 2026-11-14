// The evidence metrics. Each one replays held-out matches (data a clone never trained on) and compares
// a policy's decisions against what the real person did, so the numbers mean something. Three policies are
// compared everywhere: the player's own clone, the basic bot, and a clone of a DIFFERENT player.
import {
  IDLE, createMatch, observe, step,
  type Input, type MatchFile, type Observation, type Policy, type Slot, type State,
} from '@rewind/engine';
import { DECISION_INTERVAL, GuardedClone, MOVE_OPTIONS } from '@rewind/clone';

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

export type AccuracyResult = {
  decisions: number;
  // RAW metrics (kept for comparison; locked in METRICS.md).
  moveMatch: number; // count of ticks the move direction matched
  fireMatch: number; // count of ticks the fire choice matched
  bothMatch: number;
  // NEW metrics (locked in METRICS.md).
  balancedMoveAcc: number; // mean over the 9 move classes of (correct in class / real occurrences of class)
  fireVisible: { precision: number; recall: number; tp: number; fp: number; fn: number; ticks: number }; // fire, only on visible-enemy ticks
};

/** The index 0..8 of a move direction in the 9-option space (stop + 8 dirs). */
function moveClass(mx: number, my: number): number {
  const opts = MOVE_OPTIONS;
  for (let i = 0; i < opts.length; i++) if (opts[i].x === mx && opts[i].y === my) return i;
  return 0;
}

/**
 * Raw and new accuracy together, so they sit side by side.
 *  - raw move/fire/both match: plain agreement counts.
 *  - balanced move accuracy: mean per-class recall over the 9 move options, so standing still (the
 *    common class) cannot dominate. A policy that always picks the majority move scores ~1/9 here.
 *  - fire precision/recall on VISIBLE-enemy ticks: of the ticks the enemy was in sight, how often the
 *    policy fired when the person did (recall) and how often its fires matched a real fire (precision).
 *    Fire off visible ticks is almost always "no", which is why it is measured only where it is a choice.
 */
export function cloneAccuracy(file: MatchFile, slot: Slot, policy: Policy): AccuracyResult {
  let decisions = 0, moveMatch = 0, fireMatch = 0, bothMatch = 0;
  // Per-move-class counts for balanced accuracy.
  const classTotal = new Array(MOVE_OPTIONS.length).fill(0);
  const classHit = new Array(MOVE_OPTIONS.length).fill(0);
  // Fire confusion on visible-enemy ticks.
  let visTicks = 0, tp = 0, fp = 0, fn = 0;

  walkDecisions(file, slot, (s, recorded) => {
    const o: Observation = observe(s, slot);
    const chosen = policy.act(o).input;
    const sameMove = chosen.move.x === recorded.move.x && chosen.move.y === recorded.move.y;
    const sameFire = chosen.fire === recorded.fire;
    decisions++;
    if (sameMove) moveMatch++;
    if (sameFire) fireMatch++;
    if (sameMove && sameFire) bothMatch++;

    const cls = moveClass(recorded.move.x, recorded.move.y);
    classTotal[cls]++;
    if (sameMove) classHit[cls]++;

    if (o.enemy) {
      visTicks++;
      const real = recorded.fire, pred = chosen.fire;
      if (real && pred) tp++;
      else if (!real && pred) fp++;
      else if (real && !pred) fn++;
    }
  });

  // Balanced move accuracy: average recall over classes that actually occurred.
  let recallSum = 0, classesSeen = 0;
  for (let c = 0; c < MOVE_OPTIONS.length; c++) {
    if (classTotal[c] > 0) { recallSum += classHit[c] / classTotal[c]; classesSeen++; }
  }
  const balancedMoveAcc = classesSeen ? recallSum / classesSeen : 0;

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

  return {
    decisions, moveMatch, fireMatch, bothMatch,
    balancedMoveAcc,
    fireVisible: { precision, recall, tp, fp, fn, ticks: visTicks },
  };
}

export type PositionResult = {
  starts: number;
  avgError: number; // RAW: over all held-out moments
  medianError: number;
  movedStarts: number; // NEW: moments where the person actually moved in the next second
  avgErrorMoved: number; // NEW: position error over only those moved moments
  medianErrorMoved: number;
};

/**
 * Position error: from each held-out decision moment, run the policy for 1 second and measure how far it
 * ends from where the real person actually ended. Both the policy and the "truth" run in the engine, so
 * the only difference is the inputs. The opponent is frozen (held still) so the comparison is about this
 * player's own movement, not a diverging fight.
 *
 * RAW = over all moments. NEW = over only moments where the person actually MOVED (ended > `movedEps`
 * units from where they started). On a mostly-still player the raw number is flattered by all the "did not
 * move, trivially 0 error" moments; the moved-only number is the honest test of copying real movement.
 */
export function positionError(file: MatchFile, slot: Slot, policy: Policy, horizonTicks = 32, movedEps = 0.5): PositionResult {
  const other = (1 - slot) as Slot;
  const errors: number[] = [];
  const movedErrors: number[] = [];

  // Precompute the real per-tick inputs for this slot, so "truth" replays exactly what they did.
  const realInputs = recordedInputMap(file, slot);

  walkDecisions(file, slot, (s) => {
    const start = { x: s.players[slot].x, y: s.players[slot].y };
    // Truth: run the real inputs for 1 second from here.
    const truth = runFrom(s, slot, other, horizonTicks, (tick) => realInputs.get(tick) ?? lastInputBefore(realInputs, tick));
    // Policy: run the policy's choices for 1 second from the same start.
    const pol = runFrom(s, slot, other, horizonTicks, null, policy);
    const err = Math.hypot(pol.x - truth.x, pol.y - truth.y);
    errors.push(err);
    // Did the real person move meaningfully this second?
    if (Math.hypot(truth.x - start.x, truth.y - start.y) > movedEps) movedErrors.push(err);
  });

  const stat = (xs: number[]) => {
    if (!xs.length) return { avg: 0, median: 0 };
    const sorted = [...xs].sort((a, b) => a - b);
    return { avg: xs.reduce((a, b) => a + b, 0) / xs.length, median: sorted[Math.floor(sorted.length / 2)] };
  };
  const all = stat(errors);
  const moved = stat(movedErrors);
  return {
    starts: errors.length, avgError: all.avg, medianError: all.median,
    movedStarts: movedErrors.length, avgErrorMoved: moved.avg, medianErrorMoved: moved.median,
  };
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
