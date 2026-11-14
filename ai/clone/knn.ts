// k-nearest-neighbour clone of one real player. No model, no LLM: it finds the 7 recorded moments most like
// this one and does what that player did then, by a distance-weighted vote.
import { readFileSync, readdirSync } from 'node:fs';
import { IDLE, createMatch, observe, step, type Input, type MatchFile, type Observation, type Slot } from '@rewind/engine';
import {
  AIM_OFFSETS, DECISION_TICKS, FEATURE_WEIGHTS, IDLE_ACTION, MOVES, actionFromInput, features, inputFromAction, type Action,
} from './features';
import type { Decision, Policy, TraceLine, TraceRef } from './policy';

export const K = 7;

export type Sample = { f: number[]; a: Action; ref: TraceRef };

/** Every decision one slot made in one match: replay it, and every 4 live ticks record what they saw and did. */
export function samplesFromMatch(file: MatchFile, slot: Slot): Sample[] {
  const out: Sample[] = [];
  let s = createMatch(file.seed, file.map);
  const cur: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  let prev = IDLE_ACTION;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      cur[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.tick % DECISION_TICKS === 0 && s.phase === 'live' && s.players[slot].hp > 0) {
      const o = observe(s, slot);
      const a = actionFromInput(cur[slot], o);
      out.push({ f: features(o, prev), a, ref: { match: file.id, tick: s.tick } });
      prev = a;
    }
    s = step(s, cur).next;
  }
  return out;
}

export function loadMatches(dataDir: string): MatchFile[] {
  const out: MatchFile[] = [];
  for (const name of readdirSync(dataDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const f = JSON.parse(readFileSync(dataDir + name, 'utf8')) as MatchFile;
      if (f.seed !== undefined && Array.isArray(f.inputs) && f.ticks > 0) out.push(f);
    } catch {
      /* not a match file */
    }
  }
  return out;
}

/** Every recorded match of one player, as (match, slot) pairs. A match where someone played both slots counts twice. */
export function matchesOf(files: MatchFile[], player: string): { file: MatchFile; slot: Slot }[] {
  const out: { file: MatchFile; slot: Slot }[] = [];
  for (const file of files) for (const p of file.players) if (p.name === player) out.push({ file, slot: p.slot });
  return out;
}

export function distance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - b[i];
    d += FEATURE_WEIGHTS[i] * x * x;
  }
  return Math.sqrt(d);
}

export class KnnClone implements Policy {
  readonly name: string;
  private held: Action = IDLE_ACTION;
  private heldBecause: TraceRef[] = [];
  private heldConfidence = 0;
  private lastDecision = -Infinity;
  /** Distance to the closest recorded moment at the last decision. The circuit breaker watches this. */
  nearest = Infinity;

  /** All feature vectors in one flat array, pre-multiplied by sqrt(weight), so a query is a plain squared distance. */
  private flat: Float64Array;
  private dims: number;

  constructor(readonly player: string, readonly samples: Sample[], flat?: Float64Array) {
    this.name = `clone of ${player}`;
    this.dims = FEATURE_WEIGHTS.length;
    if (flat) {
      this.flat = flat;
    } else {
      this.flat = new Float64Array(samples.length * this.dims);
      samples.forEach((s, i) => {
        for (let j = 0; j < this.dims; j++) this.flat[i * this.dims + j] = s.f[j] * Math.sqrt(FEATURE_WEIGHTS[j]);
      });
    }
  }

  /** The k most similar recorded moments, closest first. Brute force: a few thousand moments is fast enough. */
  neighbours(f: number[], k = K): { s: Sample; d: number }[] {
    const D = this.dims;
    const q = new Float64Array(D);
    for (let j = 0; j < D; j++) q[j] = f[j] * Math.sqrt(FEATURE_WEIGHTS[j]);
    const idx: number[] = [];
    const d2: number[] = [];
    for (let i = 0; i < this.samples.length; i++) {
      let d = 0;
      const base = i * D;
      const worst = d2.length === k ? d2[k - 1] : Infinity;
      for (let j = 0; j < D && d < worst; j++) {
        const x = q[j] - this.flat[base + j];
        d += x * x;
      }
      if (d >= worst) continue;
      // Insert into the sorted top-k.
      let p = d2.length;
      while (p > 0 && d2[p - 1] > d) p--;
      d2.splice(p, 0, d);
      idx.splice(p, 0, i);
      if (d2.length > k) {
        d2.pop();
        idx.pop();
      }
    }
    return idx.map((i, n) => ({ s: this.samples[i], d: Math.sqrt(d2[n]) }));
  }

  /** The action k neighbours vote for. Each vote is weighted by 1 / distance. */
  decide(f: number[]): { action: Action; confidence: number; because: TraceRef[]; nearest: number } {
    const nb = this.neighbours(f);
    if (nb.length === 0) return { action: IDLE_ACTION, confidence: 0, because: [], nearest: Infinity };
    const w = nb.map((n) => 1 / (n.d + 0.05));
    const total = w.reduce((a, b) => a + b, 0);
    const vote = (pick: (a: Action) => number, size: number) => {
      const tally = new Array(size).fill(0);
      nb.forEach((n, i) => (tally[pick(n.s.a)] += w[i]));
      let top = 0;
      for (let i = 1; i < size; i++) if (tally[i] > tally[top]) top = i;
      return { top, share: tally[top] / total };
    };
    const yes = (pick: (a: Action) => boolean) => nb.reduce((acc, n, i) => acc + (pick(n.s.a) ? w[i] : 0), 0) / total > 0.5;
    const move = vote((a) => a.move, MOVES.length);
    const aim = vote((a) => a.aim, AIM_OFFSETS.length + 8);
    const action: Action = {
      move: move.top, aim: aim.top, walk: yes((a) => a.walk), fire: yes((a) => a.fire), reload: yes((a) => a.reload),
      smoke: yes((a) => a.smoke), dash: yes((a) => a.dash), use: yes((a) => a.use), flash: yes((a) => a.flash),
    };
    return { action, confidence: move.share, because: nb.slice(0, 3).map((n) => n.s.ref), nearest: nb[0].d };
  }

  act(o: Observation): Decision {
    // One decision every 4 ticks, held in between. The aim is re-pointed at the enemy every tick.
    if (o.tick - this.lastDecision >= DECISION_TICKS) {
      const d = this.decide(features(o, this.held));
      this.held = d.action;
      this.heldBecause = d.because;
      this.heldConfidence = d.confidence;
      this.nearest = d.nearest;
      this.lastDecision = o.tick;
    }
    return { input: inputFromAction(this.held, o), confidence: this.heldConfidence, because: this.heldBecause };
  }

  get action(): Action {
    return this.held;
  }

  /** A new clone over the same recorded moments, with nothing held. One per rewind session or eval run. */
  fresh(): KnnClone {
    return new KnnClone(this.player, this.samples, this.flat);
  }
}

/** The 95th percentile of `values`. */
export function p95(values: number[]): number {
  if (values.length === 0) return Infinity;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
}

export type BuiltClone = { clone: KnnClone; limit: number; matches: string[]; trainSamples: number; heldOutSamples: number };

/**
 * Builds a clone of `player` from every recorded match of theirs except `holdOut`.
 * The breaker limit is the 95th percentile of nearest-neighbour distances on held-out moments: from the held-out
 * matches if there are any, otherwise from every 10th sample left out of training.
 */
export function buildClone(player: string, files: MatchFile[], opts: { holdOut?: string[] } = {}): BuiltClone {
  const holdOut = new Set(opts.holdOut ?? []);
  const mine = matchesOf(files, player);
  const train: Sample[] = [];
  const held: Sample[] = [];
  for (const { file, slot } of mine) (holdOut.has(file.id) ? held : train).push(...samplesFromMatch(file, slot));
  let trainSet = train;
  let heldSet = held;
  if (heldSet.length === 0 && train.length >= 20) {
    // Held-out moments must be genuinely unseen. Neighbouring decisions are only 4 ticks apart and nearly identical,
    // so leaving out single samples would make the limit far too tight. Leave out a whole match if there are
    // several, otherwise whole 8 second blocks.
    const ids = [...new Set(train.map((s) => s.ref.match))].sort();
    if (ids.length >= 2) {
      const last = ids[ids.length - 1];
      trainSet = train.filter((s) => s.ref.match !== last);
      heldSet = train.filter((s) => s.ref.match === last);
    } else {
      const block = (i: number) => Math.floor(i / 64) % 4 === 3;
      trainSet = train.filter((_, i) => !block(i));
      heldSet = train.filter((_, i) => block(i));
    }
  }
  const probe = new KnnClone(player, trainSet);
  const nn = heldSet.slice(0, 600).map((s) => probe.neighbours(s.f, 1)[0]?.d ?? Infinity);
  // The final clone trains on everything that was not explicitly held out.
  return {
    clone: new KnnClone(player, train),
    limit: p95(nn),
    matches: [...new Set(mine.filter((m) => !holdOut.has(m.file.id)).map((m) => m.file.id))],
    trainSamples: train.length,
    heldOutSamples: heldSet.length,
  };
}

/**
 * The clone with a circuit breaker. When the clone's closest recorded moment is further away than `limit`,
 * the situation is one the player never showed us, so a simple bot takes over until the clone is back on known ground.
 */
export class GuardedClone implements Policy {
  readonly name: string;
  breakerOn = false;
  ticksOnBreaker = 0;
  ticks = 0;
  private lastCopyTrace = -Infinity;

  constructor(readonly clone: KnnClone, readonly fallback: Policy, readonly limit: number, private trace: (t: TraceLine) => void = () => {}) {
    this.name = `guarded ${clone.name}`;
  }

  act(o: Observation): Decision {
    // The fallback always runs, so its memory (last seen, plan) is current if it has to take over.
    const bot = this.fallback.act(o);
    const mine = this.clone.act(o);
    this.ticks++;
    if (o.tick % DECISION_TICKS === 0) {
      const off = this.clone.nearest > this.limit;
      if (off !== this.breakerOn) {
        this.breakerOn = off;
        this.trace({
          tick: o.tick, actor: off ? 'BOT' : 'CLONE', type: 'BREAKER',
          reason: off
            ? `nearest known moment ${this.clone.nearest.toFixed(2)} > limit ${this.limit.toFixed(2)}: never seen this, ${this.fallback.name} takes over`
            : `back on known ground (${this.clone.nearest.toFixed(2)} <= ${this.limit.toFixed(2)}), clone resumes`,
        });
      }
    }
    if (this.breakerOn) {
      this.ticksOnBreaker++;
      return bot;
    }
    // A COPY line whenever the clone picks something new, at most every half second, citing the moment it copied.
    if (mine.because.length && o.tick - this.lastCopyTrace >= 16 && o.tick % DECISION_TICKS === 0) {
      this.lastCopyTrace = o.tick;
      const a = this.clone.action;
      const what = [a.fire ? 'fire' : '', MOVES[a.move].x || MOVES[a.move].y ? (a.walk ? 'walk' : 'run') : 'hold', a.use ? 'use' : '', a.flash ? 'flash' : '']
        .filter(Boolean).join(' + ');
      this.trace({
        tick: o.tick, actor: 'CLONE', type: 'COPY',
        reason: `${what}, like ${this.clone.player} did (${Math.round(mine.confidence * 100)}% of neighbours agree)`,
        ref: mine.because[0],
      });
    }
    return mine;
  }
}
