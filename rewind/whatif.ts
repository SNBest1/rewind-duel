// "What you could have done." From the fork tick, run each scripted micro-plan for 3 seconds against the
// opponent's guarded clone, five times under different seeds, and rank by how often the human survives and
// wins the fight. The top plans come back with a one-line reason built from the events that actually happened.
import {
  IDLE, observe, replayMatch, step,
  type GameEvent, type Input, type MatchFile, type Slot, type State,
} from '@rewind/engine';
import { GuardedClone } from '@rewind/clone';
import { PLANS, type Plan } from './plans';

const SIM_TICKS = 96; // 3 seconds at 32 ticks/s
const RUNS_PER_PLAN = 5;

/** The outcome of one 3-second simulation of a plan under one seed. */
type RunResult = {
  humanSurvived: boolean;
  humanWonFight: boolean; // the human killed the opponent and lived
  humanDied: boolean;
  shotsLanded: number; // hits the human scored on the opponent
  endTick: number;
};

export type PlanResult = {
  id: string;
  label: string;
  survivalRate: number; // share of runs the human was still alive at the end
  winRate: number; // share of runs the human won the fight (killed and survived)
  avgShotsLanded: number;
  reason: string; // one line summarizing what happened, built from events
  score: number; // the rank key: wins dominate, survival breaks ties
};

/** Overwrites the RNG state of a cloned fork so the same plan runs under a different random future (D2). */
function reseed(s: State, seed: number): State {
  return { ...s, rng: seed | 0 };
}

/** Runs one plan once from the fork state under a seed, returns what happened to the human. */
function simulateOnce(fork: State, human: Slot, plan: Plan, clone: GuardedClone, seed: number): { result: RunResult; events: GameEvent[] } {
  const opponent = (1 - human) as Slot;
  let s = reseed(fork, seed);
  let shotsLanded = 0;
  const allEvents: GameEvent[] = [];

  for (let t = 0; t < SIM_TICKS && s.phase === 'live'; t++) {
    const humanInput: Input = plan.act(observe(s, human), t);
    const oppInput: Input = clone.act(observe(s, opponent)).input;
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[human] = humanInput;
    inputs[opponent] = oppInput;
    const r = step(s, inputs);
    s = r.next;
    for (const e of r.events) {
      allEvents.push(e);
      if (e.type === 'shot' && e.slot === human && e.hit) shotsLanded++;
    }
  }

  const humanAlive = s.players[human].hp > 0;
  const oppAlive = s.players[opponent].hp > 0;
  return {
    result: {
      humanSurvived: humanAlive,
      humanWonFight: humanAlive && !oppAlive,
      humanDied: !humanAlive,
      shotsLanded,
      endTick: s.tick,
    },
    events: allEvents,
  };
}

/** A short human-readable reason from a plan's runs: what usually happened. */
function reasonFor(plan: Plan, runs: RunResult[]): string {
  const n = runs.length;
  const wins = runs.filter((r) => r.humanWonFight).length;
  const deaths = runs.filter((r) => r.humanDied).length;
  const avgHits = runs.reduce((a, r) => a + r.shotsLanded, 0) / n;
  if (wins >= n) return `won the fight every time, landing ${avgHits.toFixed(1)} shots on average`;
  if (wins > n / 2) return `won ${wins} of ${n} fights with this line`;
  if (deaths === 0) return `survived all ${n} runs, ${avgHits.toFixed(1)} shots landed, but did not finish the kill`;
  if (deaths >= n) return `died every time — this line does not work here`;
  return `survived ${n - deaths} of ${n}, won ${wins}`;
}

/**
 * Runs every plan RUNS_PER_PLAN times from the fork and returns them ranked best first.
 * Score = winRate (dominant) + 0.3 * survivalRate + small bonus for shots landed, so a plan that
 * wins the fight outranks one that merely survives.
 */
export function evaluatePlans(fork: State, human: Slot, clone: GuardedClone, plans: Plan[] = PLANS): PlanResult[] {
  const results: PlanResult[] = [];
  for (const plan of plans) {
    const runs: RunResult[] = [];
    for (let i = 0; i < RUNS_PER_PLAN; i++) {
      // Distinct seeds derived from the plan id so a plan's five runs are reproducible but differ from each other.
      const seed = hashSeed(plan.id) + i * 2654435761;
      runs.push(simulateOnce(fork, human, plan, clone, seed).result);
    }
    const survivalRate = runs.filter((r) => r.humanSurvived).length / runs.length;
    const winRate = runs.filter((r) => r.humanWonFight).length / runs.length;
    const avgShotsLanded = runs.reduce((a, r) => a + r.shotsLanded, 0) / runs.length;
    const score = winRate + 0.3 * survivalRate + 0.02 * avgShotsLanded;
    results.push({ id: plan.id, label: plan.label, survivalRate, winRate, avgShotsLanded, reason: reasonFor(plan, runs), score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/** Builds the opponent clone, forks the match, and returns the top-N plans. Used by the CLI and the worker. */
export function whatIf(file: MatchFile, human: Slot, forkTick: number, clone: GuardedClone, topN = 3): PlanResult[] {
  const fork = replayMatch(file, forkTick);
  return evaluatePlans(fork, human, clone).slice(0, topN);
}

/** A tiny string hash for deriving a stable seed from a plan id. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
