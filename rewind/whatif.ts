// "What could I have done?" From a fork tick, play ~20 scripted micro-plans for the human against the real
// opponent (ghost, then their clone), each 5 times with different seeds, and rank them. Pure simulation in Node.
import {
  C, IDLE, cachedField, getMap, navGrid, weapon, observe, rayWalls, step, stepToward,
  type GameEvent, type Input, type MatchFile, type NavGrid, type Observation, type Slot, type State,
} from '@rewind/engine';
import type { Policy } from '../clone/policy';
import { forkState, RewindDriver } from './session';

export const PLAN_TICKS = 5 * 32; // each future runs 5 seconds (or until the round ends)
export const SEEDS = 5;

type P = { x: number; y: number };
type Ctx = { grid: NavGrid; start: State; human: Slot; t: number; mem: Record<string, unknown> };
export type Plan = { id: string; name: string; act: (o: Observation, c: Ctx) => Input };

const angleTo = (a: P, b: P) => Math.atan2(b.y - a.y, b.x - a.x);
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

function walkTo(c: Ctx, o: Observation, to: P): Input['move'] {
  return stepToward(c.grid, cachedField(c.grid, to.x, to.y), o.self.x, o.self.y);
}

/** Where the enemy is as far as the human knows: visible, last seen, or heard. */
function enemyGuess(o: Observation): P | null {
  return o.enemy ?? o.heard ?? (o.lastSeenEnemy ? { x: o.lastSeenEnemy.x, y: o.lastSeenEnemy.y } : null);
}

/** Every plan shares one reflex: if the enemy is in sight, stop and shoot (unless the plan says keep moving). */
function reflex(o: Observation, base: Input, keepMoving = false): Input {
  if (!o.enemy) return base;
  const aim = angleTo(o.self, o.enemy);
  return { ...base, aim, fire: o.self.ammo > 0, move: keepMoving ? base.move : { x: 0, y: 0 }, reload: o.self.ammo === 0 };
}

function objective(o: Observation, start: State): P {
  const map = getMap(o.mapId);
  if (o.spike.state === 'planted') return o.spike;
  // The site closest to where the human stood at the fork.
  const me = start.players[o.slot];
  let best: P = { x: 24, y: 16 };
  let bd = Infinity;
  for (const r of Object.values(map.sites)) {
    const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const d = dist(c, me);
    if (d < bd) [bd, best] = [d, c];
  }
  return best;
}

function sideStep(o: Observation, from: number, sign: 1 | -1): Input['move'] {
  const a = from + (sign * Math.PI) / 2;
  return { x: Math.round(Math.cos(a)) as -1 | 0 | 1, y: Math.round(Math.sin(a)) as -1 | 0 | 1 };
}

/** The nearest open spot about `d` units away from the enemy, behind something: where to fall back to. */
function cover(c: Ctx, o: Observation): P {
  const e = enemyGuess(o);
  const away = e ? angleTo(e, o.self) : o.self.aim + Math.PI;
  const map = getMap(o.mapId);
  let best: P = o.self;
  let bestScore = -Infinity;
  for (let k = -3; k <= 3; k++) {
    const a = away + k * 0.35;
    const reach = Math.min(5, rayWalls(map.walls, o.self.x, o.self.y, Math.cos(a), Math.sin(a)) - 0.7);
    if (reach < 1) continue;
    const p = { x: o.self.x + Math.cos(a) * reach, y: o.self.y + Math.sin(a) * reach };
    const score = reach - Math.abs(k) * 0.6;
    if (score > bestScore) [bestScore, best] = [score, p];
  }
  return best;
}

export const PLANS: Plan[] = [
  { id: 'hold', name: 'Stop and hold the angle', act: (o) => reflex(o, { ...IDLE, aim: enemyGuess(o) ? angleTo(o.self, enemyGuess(o)!) : o.self.aim }) },
  { id: 'walk-hold', name: 'Walk silently and wait', act: (o, c) => reflex(o, { ...IDLE, walk: true, aim: o.self.aim, move: c.t < 40 ? walkTo(c, o, objective(o, c.start)) : { x: 0, y: 0 } }) },
  { id: 'cover', name: 'Back off to cover and hold', act: (o, c) => {
    const spot = (c.mem.cover as P) ?? (c.mem.cover = cover(c, o));
    const e = enemyGuess(o);
    return reflex(o, { ...IDLE, move: dist(o.self, spot) > 0.6 ? walkTo(c, o, spot) : { x: 0, y: 0 }, aim: e ? angleTo(o.self, e) : o.self.aim });
  } },
  { id: 'reload-cover', name: 'Reload behind cover first', act: (o, c) => {
    const spot = (c.mem.cover as P) ?? (c.mem.cover = cover(c, o));
    const e = enemyGuess(o);
    return reflex(o, { ...IDLE, reload: o.self.ammo < weapon(o.self.equipped === 0 ? o.self.primary : o.self.secondary).mag, move: dist(o.self, spot) > 0.6 ? walkTo(c, o, spot) : { x: 0, y: 0 }, aim: e ? angleTo(o.self, e) : o.self.aim });
  } },
  { id: 'push', name: 'Push where they were', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    return reflex(o, { ...IDLE, move: walkTo(c, o, e), aim: angleTo(o.self, e) });
  } },
  { id: 'push-walk', name: 'Push silently (walk)', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    return reflex(o, { ...IDLE, walk: true, move: walkTo(c, o, e), aim: angleTo(o.self, e) });
  } },
  { id: 'flash-peek', name: 'Flash them, then peek', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    if (c.t === 0 && o.self.flashes > 0) return { ...IDLE, aim: a, flash: true };
    if (c.t < 18) return { ...IDLE, aim: a + Math.PI }; // look away from your own flash
    return reflex(o, { ...IDLE, move: walkTo(c, o, e), aim: a });
  } },
  { id: 'smoke-cross', name: 'Smoke the angle, then cross', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    if (c.t === 0 && o.self.smokes > 0) return { ...IDLE, aim: a, smoke: true };
    return reflex(o, { ...IDLE, move: walkTo(c, o, objective(o, c.start)), aim: a }, true);
  } },
  { id: 'smoke-self', name: 'Smoke yourself and wait', act: (o) => {
    if (o.self.smokes > 0) return { ...IDLE, aim: o.self.aim + Math.PI, smoke: true };
    return reflex(o, { ...IDLE, aim: enemyGuess(o) ? angleTo(o.self, enemyGuess(o)!) : o.self.aim });
  } },
  { id: 'dash-out', name: 'Dash out of the line of fire', act: (o, c) => {
    const e = enemyGuess(o);
    const a = e ? angleTo(o.self, e) : o.self.aim;
    if (c.t < 2) return { ...IDLE, move: sideStep(o, a, 1), dash: true, aim: a };
    return reflex(o, { ...IDLE, aim: a });
  } },
  { id: 'dash-peek', name: 'Dash-peek and shoot', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    if (c.t < 2) return { ...IDLE, move: walkTo(c, o, e), dash: true, aim: a };
    return reflex(o, { ...IDLE, aim: a });
  } },
  { id: 'jiggle', name: 'Jiggle-peek for info', act: (o, c) => {
    const e = enemyGuess(o);
    const a = e ? angleTo(o.self, e) : o.self.aim;
    return reflex(o, { ...IDLE, aim: a, walk: true, move: sideStep(o, a, Math.floor(c.t / 10) % 2 === 0 ? 1 : -1) });
  } },
  { id: 'wide-swing', name: 'Wide swing', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    return reflex(o, { ...IDLE, aim: a, move: c.t < 24 ? sideStep(o, a, 1) : walkTo(c, o, e) });
  } },
  { id: 'wide-swing-left', name: 'Wide swing the other way', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    return reflex(o, { ...IDLE, aim: a, move: c.t < 24 ? sideStep(o, a, -1) : walkTo(c, o, e) });
  } },
  { id: 'rush', name: 'Rush the objective', act: (o, c) => {
    const g = objective(o, c.start);
    return reflex(o, { ...IDLE, move: walkTo(c, o, g), aim: angleTo(o.self, g), use: dist(o.self, g) < 1.5 }, true);
  } },
  { id: 'play-obj', name: 'Go plant or defuse now', act: (o, c) => {
    const g = objective(o, c.start);
    const near = dist(o.self, g) < (o.spike.state === 'planted' ? C.DEFUSE_RANGE - 0.2 : 1.2);
    const base: Input = { ...IDLE, move: near ? { x: 0, y: 0 } : walkTo(c, o, g), aim: angleTo(o.self, g), use: near };
    return o.enemy && !near ? reflex(o, base) : base;
  } },
  { id: 'run-gun', name: 'Run and gun', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    return reflex(o, { ...IDLE, move: walkTo(c, o, e), aim: angleTo(o.self, e) }, true);
  } },
  { id: 'fall-back', name: 'Fall back toward spawn', act: (o, c) => {
    const map = getMap(o.mapId);
    const home = map.spawns[o.attacker === o.slot ? 'attacker' : 'defender'];
    const e = enemyGuess(o);
    return reflex(o, { ...IDLE, move: walkTo(c, o, home), aim: e ? angleTo(o.self, e) : angleTo(o.self, home) });
  } },
  { id: 'off-angle', name: 'Take an off-angle and wait', act: (o, c) => {
    const e = enemyGuess(o);
    const a = e ? angleTo(o.self, e) : o.self.aim;
    const spot = (c.mem.off as P) ?? (c.mem.off = { x: o.self.x + Math.cos(a + 1.3) * 2.5, y: o.self.y + Math.sin(a + 1.3) * 2.5 });
    return reflex(o, { ...IDLE, walk: true, move: dist(o.self, spot) > 0.6 ? walkTo(c, o, spot) : { x: 0, y: 0 }, aim: a });
  } },
  { id: 'flash-hold', name: 'Flash and hold', act: (o, c) => {
    const e = enemyGuess(o) ?? objective(o, c.start);
    const a = angleTo(o.self, e);
    if (c.t === 0 && o.self.flashes > 0) return { ...IDLE, aim: a, flash: true };
    if (c.t < 18) return { ...IDLE, aim: a + Math.PI };
    return reflex(o, { ...IDLE, aim: a });
  } },
];

export type Outcome = {
  survived: boolean;
  killed: boolean; // the human killed the opponent
  roundWon: boolean | null; // null if the round did not end inside the window
  hpLost: number;
  damageDealt: number;
  ticks: number;
};

/** One number to rank futures by: winning the round > winning the fight > surviving > trading damage well. */
export function score(r: Outcome): number {
  // Tie-break: a faster kill beats a slower one.
  const speed = r.killed ? (PLAN_TICKS - r.ticks) / PLAN_TICKS : 0;
  return (r.roundWon === true ? 6 : r.roundWon === false ? -6 : 0) + (r.killed ? 3 : 0) + (r.survived ? 2 : 0) + (r.damageDealt - r.hpLost) / 50 + speed;
}

export type Frame = number[]; // [tick, x0, y0, aim0, hp0, blind0, x1, y1, aim1, hp1, blind1]

function frameOf(s: State): Frame {
  const r = (v: number) => Math.round(v * 100) / 100;
  const [a, b] = s.players;
  return [s.tick, r(a.x), r(a.y), r(a.aim), a.hp, a.blindTicks, r(b.x), r(b.y), r(b.aim), b.hp, b.blindTicks];
}

function outcomeOf(start: State, s: State, human: Slot, events: GameEvent[]): Outcome {
  const opp = (1 - human) as Slot;
  const end = events.find((e) => e.type === 'roundEnd') as { winner: Slot } | undefined;
  return {
    survived: s.players[human].hp > 0,
    killed: events.some((e) => e.type === 'kill' && e.killer === human),
    roundWon: end ? end.winner === human : null,
    hpLost: start.players[human].hp - s.players[human].hp,
    damageDealt: start.players[opp].hp - s.players[opp].hp,
    ticks: s.tick - start.tick,
  };
}

/** Runs one future: `plan` drives the human from the fork; the opponent is the rewind driver (ghost, then clone). */
export function runFuture(
  file: MatchFile, forkTick: number, human: Slot, plan: Plan | null, makePolicy: () => Policy, seed: number, keepFrames: boolean,
  start: State = forkState(file, forkTick),
): { outcome: Outcome; frames: Frame[]; events: GameEvent[] } {
  let s = structuredClone(start);
  // A different random future: spread rolls differ (DECISIONS D2). The baseline keeps the real one, so it is what happened.
  if (plan) s.rng = seed | 0;
  const driver = new RewindDriver(file, forkTick, human, makePolicy, () => {}, undefined, start);
  const ctx: Ctx = { grid: navGrid(getMap(file.map)), start, human, t: 0, mem: {} };
  // With no plan this replays what the human really pressed: the baseline to beat.
  const recorded = plan ? null : recordedHuman(file, forkTick, human);
  const frames: Frame[] = [];
  const events: GameEvent[] = [];
  for (ctx.t = 0; ctx.t < PLAN_TICKS && s.phase === 'live'; ctx.t++) {
    if (keepFrames && ctx.t % 2 === 0) frames.push(frameOf(s));
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[human] = recorded ? recorded(s.tick) : plan!.act(observe(s, human), ctx);
    inputs[driver.opponent] = driver.opponentInput(s);
    const r = step(s, inputs);
    s = r.next;
    events.push(...r.events.filter((e) => e.type !== 'shot' || keepFrames));
  }
  if (keepFrames) frames.push(frameOf(s));
  return { outcome: outcomeOf(start, s, human, events), frames, events: keepFrames ? events.filter((e) => e.type === 'shot' || e.type === 'kill' || e.type === 'flashPop' || e.type === 'smoke') : [] };
}

function recordedHuman(file: MatchFile, forkTick: number, human: Slot): (tick: number) => Input {
  let cur: Input = IDLE;
  let i = 0;
  while (i < file.inputs.length && file.inputs[i].tick <= forkTick) {
    if (file.inputs[i].slot === human) cur = file.inputs[i].input;
    i++;
  }
  return (tick) => {
    while (i < file.inputs.length && file.inputs[i].tick <= tick) {
      if (file.inputs[i].slot === human) cur = file.inputs[i].input;
      i++;
    }
    return cur;
  };
}

export type PlanResult = {
  id: string;
  name: string;
  score: number;
  fightsWon: number; // seeds where the human killed the opponent
  survived: number;
  roundsWon: number;
  runs: number;
  reason: string;
  /** The best seed's 5 seconds, for a mini replay. */
  frames: Frame[];
  events: GameEvent[];
};

export type WhatIf = {
  match: string;
  forkTick: number;
  human: Slot;
  futures: number;
  ms: number;
  baseline: PlanResult;
  top: PlanResult[];
  all: { id: string; name: string; score: number; fightsWon: number; survived: number; runs: number }[];
};

function describe(o: Outcome, opponent: string): string {
  const secs = (o.ticks / 32).toFixed(1);
  if (o.killed) return `killed ${opponent} ${secs}s in${o.hpLost ? `, took ${o.hpLost} damage` : ' without a scratch'}`;
  if (!o.survived) return `died after ${secs}s${o.damageDealt ? `, dealt ${o.damageDealt}` : ''}`;
  if (o.damageDealt || o.hpLost) return `alive after ${secs}s, dealt ${o.damageDealt}, took ${o.hpLost}`;
  return `alive and unseen after ${secs}s`;
}

/** Plays every plan SEEDS times and ranks them. `makePolicy` must return a fresh opponent policy each call. */
export function whatIf(
  file: MatchFile, forkTick: number, human: Slot, makePolicy: (seed: number) => Policy, plans: Plan[] = PLANS,
  onProgress: (done: number, total: number, best: string) => void = () => {},
): WhatIf {
  const t0 = performance.now();
  const opponent = file.players.find((p) => p.slot !== human)?.name ?? 'them';
  const start = forkState(file, forkTick); // once, shared by every future
  const jobs = plans.length * (SEEDS + 1) + 2;
  let done = 0;
  let bestSoFar = '';
  let bestScore = -Infinity;
  const evalPlan = (plan: Plan | null, id: string, name: string): PlanResult => {
    let best: { o: Outcome; seed: number } | null = null;
    let total = 0;
    let fights = 0;
    let alive = 0;
    let rounds = 0;
    const runs = plan ? SEEDS : 1;
    for (let k = 0; k < runs; k++) {
      const seed = 7919 * (k + 1) + forkTick;
      const { outcome } = runFuture(file, forkTick, human, plan, () => makePolicy(seed), seed, false, start);
      onProgress(++done, jobs, bestSoFar);
      const sc = score(outcome);
      total += sc;
      if (outcome.killed) fights++;
      if (outcome.survived) alive++;
      if (outcome.roundWon) rounds++;
      if (!best || sc > score(best.o)) best = { o: outcome, seed };
    }
    // Re-run the best seed with frames for the mini replay (same seed: same future).
    const replay = runFuture(file, forkTick, human, plan, () => makePolicy(best!.seed), best!.seed, true, start);
    onProgress(++done, jobs, bestSoFar);
    if (plan && total / runs > bestScore) {
      bestScore = total / runs;
      bestSoFar = name;
    }
    return { id, name, score: total / runs, fightsWon: fights, survived: alive, roundsWon: rounds, runs, reason: describe(best!.o, opponent), frames: replay.frames, events: replay.events };
  };
  const baseline = evalPlan(null, 'actual', 'What you actually did');
  const results = plans.map((p) => evalPlan(p, p.id, p.name)).sort((a, b) => b.score - a.score);
  return {
    match: file.id, forkTick, human, futures: plans.length * SEEDS, ms: Math.round(performance.now() - t0),
    baseline,
    top: results.slice(0, 3),
    all: results.map(({ id, name, score: sc, fightsWon, survived, runs }) => ({ id, name, score: Math.round(sc * 100) / 100, fightsWon, survived, runs })),
  };
}
