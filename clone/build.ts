// buildClone(playerName, { holdOut }) — builds a guarded clone from every match of that player except the
// held-out ones, and sets the circuit-breaker limit to the 95th percentile of nearest-neighbor distances
// measured on the held-out matches (data the clone never trained on). That is the spec's definition.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { observe, createMatch, step, IDLE, type Input, type MatchFile, type Observation, type State } from '@rewind/engine';
import { DECISION_INTERVAL, samplesFromMatch, slotOf, assertShape, type Sample } from './dataset';
import { KnnClone } from './knn';
import { GuardedClone } from './guarded';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

/** Reads every match file in data/. Skips files that are not a MatchFile. */
export function loadMatches(dir: string = DATA_DIR): MatchFile[] {
  const out: MatchFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const f = JSON.parse(readFileSync(dir + name, 'utf8')) as MatchFile;
      if (f.id && Array.isArray(f.inputs) && Array.isArray(f.players)) out.push(f);
    } catch { /* not a match file */ }
  }
  return out;
}

/** The distinct player names across a set of matches. */
export function playerNames(matches: MatchFile[]): string[] {
  const set = new Set<string>();
  for (const m of matches) for (const p of m.players) set.add(p.name);
  return [...set];
}

/** The matches a player appears in. */
export function matchesOf(matches: MatchFile[], playerName: string): MatchFile[] {
  return matches.filter((m) => m.players.some((p) => p.name === playerName));
}

/** True when both slots of a match were the scripted bot (names bot-one / bot-two). Bot games are a sanity
 *  check, not the human-skill result, so the eval splits on this. */
export function isBotMatch(m: MatchFile): boolean {
  return m.players.every((p) => /^bot-/.test(p.name));
}

/** True when a player's name is a scripted bot. */
export function isBotName(name: string): boolean {
  return /^bot-/.test(name);
}

export type BuildOptions = {
  holdOut?: string[]; // match ids to exclude from training (used to measure the breaker limit and for evals)
  trainOnly?: string[]; // if set, train on EXACTLY these match ids (used by the learning curve)
  allMatches?: MatchFile[]; // pass a preloaded set to avoid re-reading disk
};

export type BuiltClone = {
  guarded: GuardedClone;
  clone: KnnClone;
  samples: Sample[];
  breakerLimit: number;
  trainMatchIds: string[];
  holdOutMatchIds: string[];
};

/** Every nearest-neighbor distance the clone would see replaying the held-out matches as this player. */
export function nnDistancesOnMatches(clone: KnnClone, files: MatchFile[], playerName: string): number[] {
  const ds: number[] = [];
  for (const file of files) {
    const slot = slotOf(file, playerName);
    if (slot === -1) continue;
    let s: State = createMatch(file.seed, file.map);
    const current: [Input, Input] = [IDLE, IDLE];
    let i = 0;
    while (s.tick < file.ticks) {
      while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
        current[file.inputs[i].slot] = file.inputs[i].input;
        i++;
      }
      if (s.phase === 'live' && s.players[slot].hp > 0 && s.tick % DECISION_INTERVAL === 0) {
        ds.push(clone.nnDistance(observe(s, slot)));
      }
      s = step(s, current).next;
    }
  }
  return ds;
}

/** The p-th percentile (0..1) of a numeric array. Linear interpolation. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Builds a guarded KNN clone of one player.
 * Training set = every match of that player not in holdOut. Breaker limit = p95 of NN distances on the
 * held-out matches, or (if none held out) p95 measured on the training data itself as a fallback.
 */
export function buildClone(playerName: string, opts: BuildOptions = {}): BuiltClone {
  const all = opts.allMatches ?? loadMatches();
  const mine = matchesOf(all, playerName);
  const holdOut = new Set(opts.holdOut ?? []);
  const trainOnly = opts.trainOnly ? new Set(opts.trainOnly) : null;
  // trainOnly pins the exact training set (learning curve); otherwise train on everything not held out.
  const train = mine.filter((m) => (trainOnly ? trainOnly.has(m.id) : !holdOut.has(m.id)));
  const held = mine.filter((m) => holdOut.has(m.id));
  if (train.length === 0) throw new Error(`no training matches for "${playerName}" (have ${mine.length}, held out ${held.length})`);

  const samples: Sample[] = [];
  for (const file of train) {
    const slot = slotOf(file, playerName);
    if (slot === -1) continue;
    samples.push(...samplesFromMatch(file, slot, playerName));
  }
  assertShape(samples);

  const clone = new KnnClone(playerName, samples);

  // Breaker: p95 of nearest-neighbor distances on held-out data the clone never saw.
  const basis = held.length > 0 ? held : train;
  const breakerLimit = percentile(nnDistancesOnMatches(clone, basis, playerName), 0.95);

  const guarded = new GuardedClone(clone, breakerLimit);
  return {
    guarded, clone, samples, breakerLimit,
    trainMatchIds: train.map((m) => m.id),
    holdOutMatchIds: held.map((m) => m.id),
  };
}
