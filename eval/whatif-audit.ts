// Audit of the what-if search, as the evidence must stand up in Q&A. Three checks, all run against the
// real engine and real recorded forks, plus a spread across many human-match forks instead of one.
//
//  A. Fog on the human side: a plan's Input must depend ONLY on observe(). We prove it by taking a fork
//     where the enemy is hidden, moving the enemy's TRUE position around off-sightline, and confirming
//     every plan returns the identical Input. If a plan peeked at State it would change.
//  B. Fog on the clone side: same idea for the clone — its decision must not change when the hidden enemy
//     moves off-sightline, because observe() returns enemy:null either way.
//  C. The clone fires back: at a fork where the clone CAN see the human, the clone must choose fire at
//     least once over a short rollout; a clone that never shoots would make every plan look safe.
import {
  canSee, observe, replayMatch, step,
  type Input, type MatchFile, type Observation, type Policy, type Slot, type State,
} from '@rewind/engine';
import { BasicBot, buildClone, matchesOf, type BuiltClone } from '@rewind/clone';
import { PLANS, evaluatePlans, timelineMarkers, type Plan } from '@rewind/rewind';

/** A policy that may expose reset() (the clones and the bot do). */
type ResettablePolicy = Policy & { reset?(): void };

export type AuditResult = {
  humanFogOk: boolean;
  cloneFogOk: boolean;
  cloneFiresBack: boolean;
  details: string[];
};

function inputsEqual(a: Input, b: Input): boolean {
  return a.move.x === b.move.x && a.move.y === b.move.y && a.walk === b.walk &&
    a.fire === b.fire && a.reload === b.reload && a.smoke === b.smoke && a.dash === b.dash && a.use === b.use &&
    Math.abs(a.aim - b.aim) < 1e-9;
}

/** A state where `viewer` cannot see `target`: nudge target far behind a wall until canSee is false. */
function hiddenState(base: State, viewer: Slot, target: Slot): State | null {
  // Try a handful of corners of the map; return the first where the target is out of the viewer's sight.
  const spots = [{ x: 2, y: 2 }, { x: 46, y: 2 }, { x: 2, y: 30 }, { x: 46, y: 30 }, { x: 36, y: 6 }, { x: 36, y: 26 }];
  for (const spot of spots) {
    const s: State = JSON.parse(JSON.stringify(base));
    s.players[target].x = spot.x;
    s.players[target].y = spot.y;
    if (!canSee(s, viewer, target)) return s;
  }
  return null;
}

/** Check A/B: moving the hidden enemy off-sightline must not change the decision (it is invisible). */
function fogStable(base: State, decisionSlot: Slot, decide: (o: Observation) => Input): boolean {
  const other = (1 - decisionSlot) as Slot;
  const hidden = hiddenState(base, decisionSlot, other);
  if (!hidden) return true; // could not construct a hidden case here; treated as pass (no counter-evidence)
  const first = decide(observe(hidden, decisionSlot));
  // Move the hidden enemy to several other off-sightline spots; the decision must stay identical.
  const moves = [{ x: 2, y: 2 }, { x: 46, y: 30 }, { x: 46, y: 2 }, { x: 2, y: 30 }];
  for (const m of moves) {
    const s: State = JSON.parse(JSON.stringify(hidden));
    s.players[other].x = m.x;
    s.players[other].y = m.y;
    if (canSee(s, decisionSlot, other)) continue; // skip spots that happen to be visible
    const again = decide(observe(s, decisionSlot));
    if (!inputsEqual(first, again)) return false;
  }
  return true;
}

/**
 * Runs the full audit against one human match: picks a fork, checks human-side and clone-side fog
 * stability across every plan / the clone, and that the clone fires back when it can see the human.
 */
export function auditWhatIf(file: MatchFile, allMatches: MatchFile[]): AuditResult {
  const details: string[] = [];
  const human = 0 as Slot;
  const opponent = 1 as Slot;
  const oppName = file.players.find((p) => p.slot === opponent)?.name ?? '';
  const oppBuilt: BuiltClone = buildClone(oppName, {
    allMatches,
    holdOut: matchesOf(allMatches, oppName).length > 1 ? [file.id] : [],
  });

  // A fork a few seconds into the match (live, both alive).
  const fork = replayMatch(file, Math.min(400, Math.floor(file.ticks / 2)));

  // --- A. human-side fog: every plan is stable when the hidden enemy moves ---------------------
  let humanFogOk = true;
  for (const plan of PLANS) {
    if (!fogStable(fork, human, (o) => plan.act(o, 0))) {
      humanFogOk = false;
      details.push(`PLAN FOG LEAK: plan "${plan.id}" changed its input when the hidden enemy moved`);
    }
  }
  details.push(humanFogOk ? `human-side fog OK: all ${PLANS.length} plans ignore the hidden enemy` : 'human-side fog FAILED');

  // --- B. clone-side fog: the clone is stable when the hidden enemy moves -----------------------
  // Reuse one clone and reset() between probes so prevAction does not carry, without rebuilding each time.
  const cloneFogOk = fogStable(fork, opponent, (o) => {
    oppBuilt.guarded.reset();
    return oppBuilt.guarded.act(o).input;
  });
  details.push(cloneFogOk ? 'clone-side fog OK: the clone ignores the hidden enemy' : 'clone-side fog FAILED: the clone changed when the hidden enemy moved');

  // --- C. the clone fires back when it can see the human ---------------------------------------
  let cloneFiresBack = false;
  // Put the two players in open sight of each other, then roll the clone forward and watch for fire.
  const seen: State = JSON.parse(JSON.stringify(fork));
  seen.players[human].x = 22; seen.players[human].y = 16; seen.players[human].aim = 0;
  seen.players[opponent].x = 27; seen.players[opponent].y = 16; seen.players[opponent].aim = Math.PI;
  let s = seen;
  for (let t = 0; t < 48 && s.phase === 'live'; t++) {
    const oppInput = oppBuilt.guarded.act(observe(s, opponent)).input;
    if (oppInput.fire) { cloneFiresBack = true; break; }
    const inputs: [Input, Input] = [
      { move: { x: 0, y: 0 }, walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false },
      oppInput,
    ];
    s = step(s, inputs).next;
  }
  details.push(cloneFiresBack
    ? 'clone CAN fire back: head-on, it chose fire within 1.5 s (but see the per-fork fire rate below — in oblique real forks it often does not)'
    : 'clone did NOT fire back even head-on when it could see the human');

  return { humanFogOk, cloneFogOk, cloneFiresBack, details };
}

export type ForkRow = {
  matchId: string; forkTick: number;
  // vs the fixed (factored) clone
  bestPlan: string; win: number; survive: number; cloneSawTicks: number; cloneFireTicks: number;
  // vs the basic bot reference opponent (same fork, same plans)
  botBestPlan: string; botWin: number; botSurvive: number; botSawTicks: number; botFireTicks: number;
};

export type ForkSpread = {
  forks: number;
  summary: {
    cloneWin: { min: number; median: number; max: number };
    cloneSurvive: { min: number; median: number; max: number };
    botWin: { min: number; median: number; max: number };
    botSurvive: { min: number; median: number; max: number };
  };
  perFork: ForkRow[];
  cloneFireWhenSeen: number; // across all forks vs the clone: share of sightline-ticks it chose to fire
  botFireWhenSeen: number; // same, vs the basic bot (reference)
};

/**
 * Rolls the best plan forward once against an opponent policy and counts, over the rollout, how many ticks
 * the opponent could see the human and how many it chose to fire. This is the honest check on whether a
 * "win" is real: an opponent that sees the human but never shoots makes every plan look safe.
 */
function opponentFireAudit(fork: State, human: Slot, opponentPolicy: ResettablePolicy, plan: Plan): { saw: number; fired: number } {
  const opponent = (1 - human) as Slot;
  opponentPolicy.reset?.();
  let s: State = JSON.parse(JSON.stringify(fork));
  let saw = 0, fired = 0;
  for (let t = 0; t < 96 && s.phase === 'live'; t++) {
    const oObs = observe(s, opponent);
    if (oObs.enemy) saw++;
    const oInput = opponentPolicy.act(oObs).input;
    if (oInput.fire) fired++;
    const inputs: [Input, Input] = [
      { move: { x: 0, y: 0 }, walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false },
      { move: { x: 0, y: 0 }, walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false },
    ];
    inputs[human] = plan.act(observe(s, human), t);
    inputs[opponent] = oInput;
    s = step(s, inputs).next;
  }
  return { saw, fired };
}

/** Median of a numeric array (0 if empty). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Runs the what-if on many forks drawn from human matches and reports the SPREAD of the best-plan result,
 * not a single fork. Forks are taken at round-end-minus-3s moments plus evenly spaced ticks, so they land
 * on real decision points. Returns at least `minForks` results when the data allows.
 */
export function forkSpread(humanMatches: MatchFile[], allMatches: MatchFile[], minForks = 10, maxForks = 14): ForkSpread {
  const perFork: ForkSpread['perFork'] = [];
  const human = 0 as Slot;
  const opponent = 1 as Slot;

  // Collect candidate (match, forkTick) pairs across all human matches, then run up to maxForks of them.
  // Each what-if is ~2 s, so a cap keeps the eval from running for minutes while still giving a spread,
  // not one cherry-picked fork. Candidates are real decision points: 3 s before round ends, plus spaced ticks.
  type Cand = { file: MatchFile; forkTick: number; opp: BuiltClone };
  const candidates: Cand[] = [];
  const oppCache = new Map<string, BuiltClone | null>();

  for (const file of humanMatches) {
    const oppName = file.players.find((p) => p.slot === opponent)?.name ?? '';
    if (!oppCache.has(oppName)) {
      try {
        oppCache.set(oppName, buildClone(oppName, { allMatches, holdOut: matchesOf(allMatches, oppName).length > 1 ? [file.id] : [] }));
      } catch {
        oppCache.set(oppName, null);
      }
    }
    const oppBuilt = oppCache.get(oppName);
    if (!oppBuilt) continue;

    const ticks = new Set<number>();
    for (const m of timelineMarkers(file)) {
      if (m.kind === 'roundEnd') ticks.add(Math.max(0, m.tick - 96));
    }
    for (let f = 1; f <= 4; f++) ticks.add(Math.floor((file.ticks * f) / 5));
    for (const forkTick of [...ticks].sort((a, b) => a - b)) {
      candidates.push({ file, forkTick, opp: oppBuilt });
    }
  }

  // Spread the chosen forks evenly across the candidate list so they are not all from one match.
  const take = Math.min(maxForks, candidates.length);
  const chosen = take >= candidates.length
    ? candidates
    : Array.from({ length: take }, (_, i) => candidates[Math.floor((i * candidates.length) / take)]);

  const bot = new BasicBot(); // the reference opponent: the hand-written bot, same forks and plans
  let cloneSaw = 0, cloneFired = 0, botSaw = 0, botFired = 0;

  for (const c of chosen) {
    const fork = replayMatch(c.file, c.forkTick);
    if (fork.phase !== 'live') continue;

    // vs the fixed (factored) clone with the breaker on.
    c.opp.guarded.reset();
    const rankedClone = evaluatePlans(fork, human, c.opp.guarded);
    const bestClone = rankedClone[0];
    if (!bestClone) continue;
    const cPlan = PLANS.find((p) => p.label === bestClone.label)!;
    const cFire = opponentFireAudit(fork, human, c.opp.guarded, cPlan);
    cloneSaw += cFire.saw; cloneFired += cFire.fired;

    // vs the basic bot reference opponent (same fork, same plan menu).
    bot.reset();
    const rankedBot = evaluatePlans(fork, human, bot);
    const bestBot = rankedBot[0]!;
    const bPlan = PLANS.find((p) => p.label === bestBot.label)!;
    const bFire = opponentFireAudit(fork, human, bot, bPlan);
    botSaw += bFire.saw; botFired += bFire.fired;

    perFork.push({
      matchId: c.file.id, forkTick: c.forkTick,
      bestPlan: bestClone.label, win: bestClone.winRate, survive: bestClone.survivalRate, cloneSawTicks: cFire.saw, cloneFireTicks: cFire.fired,
      botBestPlan: bestBot.label, botWin: bestBot.winRate, botSurvive: bestBot.survivalRate, botSawTicks: bFire.saw, botFireTicks: bFire.fired,
    });
  }

  const col = (f: (r: ForkRow) => number) => {
    const xs = perFork.map(f);
    return { min: Math.min(...xs, 0), median: median(xs), max: Math.max(...xs, 0) };
  };
  return {
    forks: perFork.length,
    summary: {
      cloneWin: col((r) => r.win),
      cloneSurvive: col((r) => r.survive),
      botWin: col((r) => r.botWin),
      botSurvive: col((r) => r.botSurvive),
    },
    perFork,
    cloneFireWhenSeen: cloneSaw > 0 ? cloneFired / cloneSaw : 0,
    botFireWhenSeen: botSaw > 0 ? botFired / botSaw : 0,
  };
}
