// The evidence metrics. Each one replays a held-out match (data a clone never trained on) and compares a
// policy's decisions against what the real person did. Metric definitions are LOCKED in eval/METRICS.md.
//
// Everything is built from one pass that emits a per-decision RECORD tagged with its round. The point
// estimates and the bootstrap confidence intervals are both computed from those records, so the CI uses
// the exact same definition as the headline number. Resampling is BY ROUND (not by tick) because ticks
// within a round are not independent — one round is one correlated sequence of decisions.
import {
  IDLE, createMatch, observe, step,
  type Input, type MatchFile, type Policy, type Slot, type State,
} from '@rewind/engine';
import { DECISION_INTERVAL, GuardedClone, MOVE_OPTIONS } from '@rewind/clone';

/** The index 0..8 of a move direction in the 9-option space (stop + 8 dirs). */
function moveClass(mx: number, my: number): number {
  for (let i = 0; i < MOVE_OPTIONS.length; i++) if (MOVE_OPTIONS[i].x === mx && MOVE_OPTIONS[i].y === my) return i;
  return 0;
}

/** One decision tick's worth of comparison between the policy and the real person. */
export type DecisionRecord = {
  round: number; // the round this decision happened in — the bootstrap resampling unit
  moveMatch: boolean;
  fireMatch: boolean;
  realMoveClass: number;
  policyMoveClass: number;
  enemyVisible: boolean;
  realFire: boolean;
  policyFire: boolean;
  posErr: number; // 1-second position error from this moment
  realMoved: boolean; // did the real person move > eps in that second
};

/** Steps a held-out match once and emits a record per live decision tick for `slot`. */
export function collectRecords(file: MatchFile, slot: Slot, policy: Policy, horizonTicks = 32, movedEps = 0.5): DecisionRecord[] {
  const other = (1 - slot) as Slot;
  const realInputs = recordedInputMap(file, slot);
  const records: DecisionRecord[] = [];

  let s: State = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.phase === 'live' && s.players[slot].hp > 0 && s.tick % DECISION_INTERVAL === 0) {
      const o = observe(s, slot);
      const recorded = current[slot];
      const chosen = policy.act(o).input;
      const sameMove = chosen.move.x === recorded.move.x && chosen.move.y === recorded.move.y;

      // 1-second position error from here, opponent frozen (same as the locked definition).
      const start = { x: s.players[slot].x, y: s.players[slot].y };
      const truth = runFrom(s, slot, other, horizonTicks, (tick) => realInputs.get(tick) ?? lastInputBefore(realInputs, tick));
      const pol = runFrom(s, slot, other, horizonTicks, null, policy);
      const posErr = Math.hypot(pol.x - truth.x, pol.y - truth.y);
      const realMoved = Math.hypot(truth.x - start.x, truth.y - start.y) > movedEps;

      records.push({
        round: s.round,
        moveMatch: sameMove,
        fireMatch: chosen.fire === recorded.fire,
        realMoveClass: moveClass(recorded.move.x, recorded.move.y),
        policyMoveClass: moveClass(chosen.move.x, chosen.move.y),
        enemyVisible: o.enemy !== null,
        realFire: recorded.fire,
        policyFire: chosen.fire,
        posErr,
        realMoved,
      });
    }
    s = step(s, current).next;
  }
  return records;
}

// --- metric functions over a record set (locked definitions) ------------------------------------

export function moveMatchRate(rs: DecisionRecord[]): number {
  return rs.length ? rs.filter((r) => r.moveMatch).length / rs.length : 0;
}
export function fireMatchRate(rs: DecisionRecord[]): number {
  return rs.length ? rs.filter((r) => r.fireMatch).length / rs.length : 0;
}

/** Balanced move accuracy: mean over the 9 classes of per-class recall (correct in class / real in class). */
export function balancedMove(rs: DecisionRecord[]): number {
  const total = new Array(MOVE_OPTIONS.length).fill(0);
  const hit = new Array(MOVE_OPTIONS.length).fill(0);
  for (const r of rs) { total[r.realMoveClass]++; if (r.moveMatch) hit[r.realMoveClass]++; }
  let sum = 0, seen = 0;
  for (let c = 0; c < MOVE_OPTIONS.length; c++) if (total[c] > 0) { sum += hit[c] / total[c]; seen++; }
  return seen ? sum / seen : 0;
}

/** Fire precision on visible-enemy ticks (policy fired AND real fired) / (policy fired). */
export function firePrecisionVisible(rs: DecisionRecord[]): number {
  const vis = rs.filter((r) => r.enemyVisible);
  const tp = vis.filter((r) => r.policyFire && r.realFire).length;
  const fp = vis.filter((r) => r.policyFire && !r.realFire).length;
  return tp + fp > 0 ? tp / (tp + fp) : 0;
}
/** Fire recall on visible-enemy ticks (policy fired AND real fired) / (real fired). */
export function fireRecallVisible(rs: DecisionRecord[]): number {
  const vis = rs.filter((r) => r.enemyVisible);
  const tp = vis.filter((r) => r.policyFire && r.realFire).length;
  const fn = vis.filter((r) => !r.policyFire && r.realFire).length;
  return tp + fn > 0 ? tp / (tp + fn) : 0;
}
export function visibleTicks(rs: DecisionRecord[]): number {
  return rs.filter((r) => r.enemyVisible).length;
}

export function posErrorRaw(rs: DecisionRecord[]): number {
  return rs.length ? rs.reduce((a, r) => a + r.posErr, 0) / rs.length : 0;
}
export function posErrorMoved(rs: DecisionRecord[]): number {
  const m = rs.filter((r) => r.realMoved);
  return m.length ? m.reduce((a, r) => a + r.posErr, 0) / m.length : 0;
}
export function movedCount(rs: DecisionRecord[]): number {
  return rs.filter((r) => r.realMoved).length;
}

// --- bootstrap confidence intervals, resampling BY ROUND ----------------------------------------

export type CI = { point: number; lo: number; hi: number };

/** Groups records by their round. */
function byRound(rs: DecisionRecord[]): DecisionRecord[][] {
  const m = new Map<number, DecisionRecord[]>();
  for (const r of rs) {
    const list = m.get(r.round) ?? [];
    list.push(r);
    m.set(r.round, list);
  }
  return [...m.values()];
}

/** A small deterministic RNG (mulberry32) so the CIs are reproducible run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 95% bootstrap CI for a metric, resampling ROUNDS with replacement. The point estimate is the metric on
 * the real records; each of B resamples draws (number-of-rounds) rounds with replacement, concatenates
 * their records, and recomputes the metric. lo/hi are the 2.5 and 97.5 percentiles of the resamples.
 */
export function bootstrapByRound(rs: DecisionRecord[], metric: (rs: DecisionRecord[]) => number, B = 1000, seed = 1): CI {
  const point = metric(rs);
  const rounds = byRound(rs);
  if (rounds.length < 2) return { point, lo: point, hi: point }; // one round: no between-round spread to resample
  const rand = rng(seed);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: DecisionRecord[] = [];
    for (let k = 0; k < rounds.length; k++) sample.push(...rounds[Math.floor(rand() * rounds.length)]);
    stats.push(metric(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(p * (stats.length - 1))))];
  return { point, lo: q(0.025), hi: q(0.975) };
}

// --- back-compat aggregate results (used by the learning curve and handoff) ---------------------

export type AccuracyResult = {
  decisions: number;
  moveMatch: number;
  fireMatch: number;
  bothMatch: number;
  balancedMoveAcc: number;
  fireVisible: { precision: number; recall: number; ticks: number };
};

/** Convenience: all accuracy numbers from one record pass. */
export function cloneAccuracy(file: MatchFile, slot: Slot, policy: Policy): AccuracyResult {
  const rs = collectRecords(file, slot, policy);
  const d = Math.max(1, rs.length);
  return {
    decisions: rs.length,
    moveMatch: rs.filter((r) => r.moveMatch).length / d,
    fireMatch: rs.filter((r) => r.fireMatch).length / d,
    bothMatch: rs.filter((r) => r.moveMatch && r.fireMatch).length / d,
    balancedMoveAcc: balancedMove(rs),
    fireVisible: { precision: firePrecisionVisible(rs), recall: fireRecallVisible(rs), ticks: visibleTicks(rs) },
  };
}

export type PositionResult = { starts: number; avgError: number; movedStarts: number; avgErrorMoved: number };

export function positionError(file: MatchFile, slot: Slot, policy: Policy): PositionResult {
  const rs = collectRecords(file, slot, policy);
  return { starts: rs.length, avgError: posErrorRaw(rs), movedStarts: movedCount(rs), avgErrorMoved: posErrorMoved(rs) };
}

/** Runs `horizon` ticks from a start state, driving `slot` from a recorded-input getter or a policy,
 *  with the other slot frozen. Returns the slot's final position. */
function runFrom(start: State, slot: Slot, other: Slot, horizon: number, recorded: ((tick: number) => Input) | null, policy?: Policy): { x: number; y: number } {
  let s = cloneState(start);
  for (let t = 0; t < horizon && s.phase === 'live'; t++) {
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[slot] = recorded ? recorded(s.tick) : policy!.act(observe(s, slot)).input;
    inputs[other] = IDLE;
    s = step(s, inputs).next;
  }
  return { x: s.players[slot].x, y: s.players[slot].y };
}

/** Handoff rate: the share of rewind decision ticks the guarded clone spends under the circuit breaker. */
export function handoffRate(file: MatchFile, slot: Slot, guarded: GuardedClone): { ticks: number; broke: number; rate: number } {
  let ticks = 0, broke = 0;
  let s: State = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) { current[file.inputs[i].slot] = file.inputs[i].input; i++; }
    if (s.phase === 'live' && s.players[slot].hp > 0 && s.tick % DECISION_INTERVAL === 0) {
      ticks++;
      if (guarded.wouldBreak(observe(s, slot))) broke++;
    }
    s = step(s, current).next;
  }
  return { ticks, broke, rate: ticks ? broke / ticks : 0 };
}

// --- small helpers ------------------------------------------------------------------------------

function cloneState(s: State): State { return JSON.parse(JSON.stringify(s)) as State; }

function recordedInputMap(file: MatchFile, slot: Slot): Map<number, Input> {
  const m = new Map<number, Input>();
  for (const e of file.inputs) if (e.slot === slot) m.set(e.tick, e.input);
  return m;
}

function lastInputBefore(m: Map<number, Input>, tick: number): Input {
  let best = IDLE, bestTick = -1;
  for (const [t, inp] of m) if (t <= tick && t > bestTick) { bestTick = t; best = inp; }
  return best;
}
