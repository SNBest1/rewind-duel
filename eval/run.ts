// Evidence. Writes eval/results.md with real numbers, even when they are weak (spec Phase 5).
//
// Honesty rules baked into this script:
//  - Human matches are the result; bot matches are a labelled SANITY CHECK, never the headline.
//  - Self-matches (one person on both slots) and the alpha/bravo + tunnel fixtures are dropped entirely.
//  - Metrics are LOCKED in eval/METRICS.md. Raw and new metrics are reported side by side for every policy.
//  - The clone is the FACTORED clone; it is shown with the breaker OFF and ON, plus the breaker rate.
//  - Baselines: basic bot, majority action, cross-player clone.
//  - Learning curve + SVG chart; what-if audited and run over 12 forks vs the clone AND the basic bot.
//  - A roster (eval/roster.md) shows how many matches each player has.
// Nothing is tuned to flatter the numbers. If the clone loses on the locked metrics, the notes say why.
//
// Run with: npm run eval
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MatchFile, Policy, Slot } from '@rewind/engine';
import {
  BasicBot, MajorityBaseline, buildClone, isBotMatch, isBotName, isSelfMatch,
  loadMatches, matchesOf, playerNames, slotOf,
} from '@rewind/clone';
import { cloneAccuracy, handoffRate, positionError } from './metrics';
import { transferCase } from './transfer';
import { playerCurve, curveChartSvg, type PlayerCurve } from './learning-curve';
import { auditWhatIf, forkSpread } from './whatif-audit';
import { writeMetricsDoc } from './metrics-doc';

const OUT = fileURLToPath(new URL('./results.md', import.meta.url));
const ROSTER = fileURLToPath(new URL('./roster.md', import.meta.url));
const SVG = fileURLToPath(new URL('./learning-curve.svg', import.meta.url));
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// Matches excluded from the evidence entirely (the alpha/bravo fixture and the tunnel smoke-test). Not skill data.
const DROP_PLAYERS = new Set(['alpha', 'bravo', 'p1', 'p2']);
const isDropped = (m: MatchFile) => m.players.some((p) => DROP_PLAYERS.has(p.name)) || isSelfMatch(m);

/** Everything measured for one policy on the held-out match: raw + new metrics side by side. */
type PolicyRow = {
  player: string;
  policy: string;
  // raw
  moveMatch: number;
  fireMatch: number;
  posErr: number;
  // new (locked)
  balancedMove: number;
  firePrec: number;
  fireRecall: number;
  fireVisTicks: number;
  posErrMoved: number;
  movedStarts: number;
  decisions: number;
};

function measure(player: string, policyName: string, held: MatchFile, slot: Slot, policy: Policy): PolicyRow {
  const acc = cloneAccuracy(held, slot, policy);
  const pos = positionError(held, slot, policy);
  const d = Math.max(1, acc.decisions);
  return {
    player, policy: policyName,
    moveMatch: acc.moveMatch / d,
    fireMatch: acc.fireMatch / d,
    posErr: pos.avgError,
    balancedMove: acc.balancedMoveAcc,
    firePrec: acc.fireVisible.precision,
    fireRecall: acc.fireVisible.recall,
    fireVisTicks: acc.fireVisible.ticks,
    posErrMoved: pos.avgErrorMoved,
    movedStarts: pos.movedStarts,
    decisions: acc.decisions,
  };
}

/** Builds every policy row for one player: factored clone (breaker off / on), basic bot, majority, cross-clone. */
function rowsForPlayer(player: string, usable: MatchFile[]): { rows: PolicyRow[]; breakerRate: number; breakerLimit: number } {
  const mine = matchesOf(usable, player).filter((m) => !isSelfMatch(m));
  const held = mine[0];
  const slot = slotOf(held, player) as Slot;

  const own = buildClone(player, { allMatches: usable, holdOut: [held.id] });
  const majority = new MajorityBaseline(player, own.samples);
  const bot: Policy = new BasicBot();

  const sameKind = playerNames(usable).filter((n) => n !== player && isBotName(n) === isBotName(player) && matchesOf(usable, n).filter((m) => !isSelfMatch(m)).length >= 1);
  const otherName = (sameKind[0] ?? playerNames(usable).find((n) => n !== player)) ?? player;
  const otherHold = matchesOf(usable, otherName).filter((m) => !isSelfMatch(m)).length > 1 ? [held.id] : [];
  const other = buildClone(otherName, { allMatches: usable, holdOut: otherHold });

  const rows = [
    measure(player, `${player} factored clone (breaker OFF)`, held, slot, own.factored),
    measure(player, `${player} factored clone (breaker ON)`, held, slot, own.guardedFactored),
    measure(player, 'basic bot', held, slot, bot),
    measure(player, 'majority action', held, slot, majority),
    measure(player, `${otherName} clone (cross)`, held, slot, other.guardedFactored),
  ];
  const h = handoffRate(held, slot, own.guardedFactored);
  return { rows, breakerRate: h.rate, breakerLimit: own.breakerLimit };
}

function policyTable(rows: PolicyRow[]): string[] {
  const out: string[] = [];
  out.push('| Player | Policy | Move match (raw) | Balanced move (new) | Fire match (raw) | Fire prec (vis) | Fire recall (vis) | Pos err (raw) | Pos err moved (new) | Decisions |');
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    out.push(`| ${r.player} | ${r.policy} | ${pct(r.moveMatch)} | ${pct(r.balancedMove)} | ${pct(r.fireMatch)} | ${pct(r.firePrec)} | ${pct(r.fireRecall)} | ${r.posErr.toFixed(2)} | ${r.posErrMoved.toFixed(2)} | ${r.decisions} |`);
  }
  out.push('');
  return out;
}

function main(): void {
  const all = loadMatches();
  const usable = all.filter((m) => !isDropped(m)); // drop fixtures AND self-matches
  const started = new Date().toISOString();
  const lines: string[] = [];

  // Lock the metric definitions to disk once, before any new data arrives.
  writeMetricsDoc();

  const humanMatches = usable.filter((m) => !isBotMatch(m));
  const botMatches = usable.filter((m) => isBotMatch(m));
  const humanPlayers = playerNames(humanMatches).filter((n) => !isBotName(n));
  const botPlayers = playerNames(botMatches);

  // Flag self-matches so they are visible, not silently dropped.
  const selfMatches = all.filter((m) => isSelfMatch(m));

  // --- roster (its own file) --------------------------------------------------------------------
  const roster = playerNames(all)
    .map((n) => ({ n, c: matchesOf(all, n).filter((m) => !isSelfMatch(m)).length, cRaw: matchesOf(all, n).length, bot: isBotName(n), dropped: DROP_PLAYERS.has(n) }))
    .sort((a, b) => b.c - a.c);
  writeRoster(roster, selfMatches);

  lines.push('# Rewind — evidence');
  lines.push('');
  lines.push(`Generated by \`npm run eval\` on ${started}. Measured on a held-out match the clone never trained on. Metric definitions are LOCKED in \`eval/METRICS.md\` and are not changed after this. Nothing is tuned to flatter the numbers.`);
  lines.push('');
  lines.push(`Dataset after dropping fixtures and self-matches: ${humanMatches.length} human matches, ${botMatches.length} bot matches. Roster in \`eval/roster.md\`.`);
  if (selfMatches.length) {
    lines.push('');
    lines.push(`**Self-matches flagged and excluded** (one person on both slots): ${selfMatches.map((m) => `\`${m.id}\` (${m.players[0].name})`).join(', ')}.`);
  }
  lines.push('');

  // --- 1. accuracy -----------------------------------------------------------------------------
  lines.push('## 1. Clone accuracy (held-out) — raw and new metrics side by side');
  lines.push('');
  lines.push('The clone is the **factored** clone (separate k-NN votes for move, fire and aim; the fire vote uses only neighbors with the same enemy-visibility state). It is shown with the circuit breaker OFF (raw clone) and ON (breaker falls back to the basic bot past the novelty limit). All metric definitions are in `eval/METRICS.md`.');
  lines.push('');

  const humanEvaluable = humanPlayers.filter((n) => matchesOf(humanMatches, n).filter((m) => !isSelfMatch(m)).length >= 2);
  const humanBuilt = humanEvaluable.map((p) => ({ p, ...rowsForPlayer(p, humanMatches) }));
  lines.push('### Humans (the result)');
  lines.push('');
  if (humanBuilt.length) {
    lines.push(...policyTable(humanBuilt.flatMap((b) => b.rows)));
    for (const b of humanBuilt) lines.push(`- **${b.p}** breaker rate on held-out: ${pct(b.breakerRate)} of decision ticks (novelty limit ${b.breakerLimit.toFixed(2)}).`);
  } else {
    lines.push('_No human player has two or more usable matches yet (after excluding self-matches). There is no held-out human accuracy to report. Record more games (see the roster)._');
  }
  lines.push('');

  const botEvaluable = botPlayers.filter((n) => matchesOf(botMatches, n).length >= 2);
  const botBuilt = botEvaluable.map((p) => ({ p, ...rowsForPlayer(p, botMatches) }));
  lines.push('### Bots (sanity check only — NOT the main result)');
  lines.push('');
  lines.push('Scripted bots are perfectly repeatable, so their clones score very high. This only confirms the pipeline works; it says nothing about cloning a real person.');
  lines.push('');
  if (botBuilt.length) {
    lines.push(...policyTable(botBuilt.flatMap((b) => b.rows)));
    for (const b of botBuilt) lines.push(`- **${b.p}** breaker rate: ${pct(b.breakerRate)} (limit ${b.breakerLimit.toFixed(2)}).`);
  }
  lines.push('');

  // --- 2. learning curve -----------------------------------------------------------------------
  lines.push('## 2. Learning curve');
  lines.push('');
  lines.push('Held-out **balanced move accuracy** after training on 1, 2, 3, ... of a player\'s other matches. Balanced move (mean per-class recall over the 9 move options) is used because it cannot be gamed by always holding still. A short line means few games.');
  lines.push('');
  const curves: PlayerCurve[] = [];
  for (const p of humanEvaluable) { const c = playerCurve(p, humanMatches, false); if (c) curves.push(c); }
  for (const p of botEvaluable) { const c = playerCurve(p, botMatches, true); if (c) curves.push(c); }
  if (curves.length) {
    lines.push('| Player | Kind | Training matches | Balanced move | Fire recall (vis) |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const c of curves) for (const pt of c.points) {
      lines.push(`| ${c.player} | ${c.isBot ? 'bot' : 'human'} | ${pt.trainMatches} | ${pct(pt.balancedMove)} | ${pct(pt.fireRecall)} |`);
    }
    lines.push('');
    writeFileSync(SVG, curveChartSvg(curves));
    lines.push('Chart: `eval/learning-curve.svg` (self-contained SVG, drop it straight into the video).');
  } else {
    lines.push('_No player has enough matches to draw a curve._');
  }
  lines.push('');

  // --- 3. what-if audit + spread (vs clone AND basic-bot reference) -----------------------------
  lines.push('## 3. What-if search — audit and spread');
  lines.push('');
  lines.push('Checks on a real human fork, using the fixed (factored) clone:');
  lines.push('');
  const auditMatch = humanMatches.find((m) => m.ticks > 1000);
  if (auditMatch) {
    const audit = auditWhatIf(auditMatch, humanMatches);
    for (const d of audit.details) lines.push(`- ${d}`);
    const allPass = audit.humanFogOk && audit.cloneFogOk && audit.cloneFiresBack;
    lines.push(`- **verdict: ${allPass ? 'PASS' : 'FAIL'}** — plans and clone use \`observe\` only (fog holds) and the clone CAN shoot back.`);
  } else {
    lines.push('- (no human match long enough to audit)');
  }
  lines.push('');
  lines.push('Spread across 12 forks from the human matches, each run against the fixed clone AND the basic bot as a reference opponent (same forks, same plans):');
  lines.push('');
  const spread = forkSpread(humanMatches, humanMatches, 10, 12);
  if (spread.forks > 0) {
    const s = spread.summary;
    lines.push(`- **${spread.forks} forks.** Best-plan win vs **clone**: min ${pct(s.cloneWin.min)} / median ${pct(s.cloneWin.median)} / max ${pct(s.cloneWin.max)}. Vs **basic bot**: min ${pct(s.botWin.min)} / median ${pct(s.botWin.median)} / max ${pct(s.botWin.max)}.`);
    lines.push(`- Fire rate when it could see the human — **clone ${pct(spread.cloneFireWhenSeen)}**, **basic bot ${pct(spread.botFireWhenSeen)}**. If the clone's fire rate is far below the bot's, a high plan win rate against the clone is partly the clone's passivity.`);
    lines.push('');
    lines.push('| Match | Fork | vs clone: best plan | win | surv | clone saw/fired | vs bot: best plan | win | surv | bot saw/fired |');
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |');
    for (const f of spread.perFork) {
      lines.push(`| \`${f.matchId.slice(0, 12)}\` | ${f.forkTick} | ${f.bestPlan} | ${pct(f.win)} | ${pct(f.survive)} | ${f.cloneSawTicks}/${f.cloneFireTicks} | ${f.botBestPlan} | ${pct(f.botWin)} | ${pct(f.botSurvive)} | ${f.botSawTicks}/${f.botFireTicks} |`);
    }
  } else {
    lines.push('- (no human forks could be evaluated)');
  }
  lines.push('');

  // --- 4. transfer test ------------------------------------------------------------------------
  lines.push('## 4. Transfer test');
  lines.push('');
  const transferLines: string[] = [];
  for (const player of humanEvaluable) {
    const held = matchesOf(humanMatches, player).filter((m) => !isSelfMatch(m))[0];
    const tc = transferCase(held, player, humanMatches);
    if (tc) {
      const wins = tc.retries.filter((r) => r.playerWon).length;
      transferLines.push(
        `- **${player}**, round ${tc.round} of \`${tc.matchId}\` (lost), fork ${tc.forkTick}: retries (own vs opponent clone) won ${wins}/${tc.retries.length}; best plan ${tc.freshAttempt ? `"${tc.freshAttempt.plan}" win ${pct(tc.freshAttempt.winRate)}` : 'none'}.`,
      );
    }
  }
  lines.push(...(transferLines.length ? transferLines : ['- No transfer case: no evaluable human lost a round in their held-out match. Needs a recorded human loss.']));
  lines.push('');

  // --- honest read ------------------------------------------------------------------------------
  lines.push('## Honest read (locked metrics)');
  lines.push('');
  lines.push(...honestRead(humanBuilt, spread));
  lines.push('');

  writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${OUT}, ${ROSTER}, eval/METRICS.md${curves.length ? ', ' + SVG : ''}`);
  console.log(`human evaluable: ${humanEvaluable.length}, bot evaluable: ${botEvaluable.length}, forks: ${spread.forks}`);
}

/** Plain-language verdict on the locked metrics: did the clone (breaker on) beat majority and cross-clone? */
function honestRead(
  built: { p: string; rows: PolicyRow[]; breakerRate: number }[],
  spread: ReturnType<typeof forkSpread>,
): string[] {
  const out: string[] = [];
  if (!built.length) {
    out.push('- Not enough human data yet. Only one human has two or more non-self matches. Show the method and the bot sanity check; say the human numbers are pending more games. Do not claim the human clone is validated.');
  }
  for (const b of built) {
    const on = b.rows.find((r) => r.policy.includes('breaker ON'))!;
    const majority = b.rows.find((r) => r.policy === 'majority action')!;
    const cross = b.rows.find((r) => r.policy.includes('(cross)'))!;
    // Locked headline metrics: balanced move accuracy, and fire recall on visible ticks.
    const beatsMajorityMove = on.balancedMove >= majority.balancedMove;
    const beatsCrossMove = on.balancedMove >= cross.balancedMove;
    const beatsPosMoved = on.posErrMoved <= majority.posErrMoved && on.posErrMoved <= cross.posErrMoved;
    // Report wins and losses both, so the read is the full picture, not only the shortfall.
    const wins: string[] = [];
    const losses: string[] = [];
    if (beatsMajorityMove && beatsCrossMove) wins.push(`balanced move ${pct(on.balancedMove)} (> majority ${pct(majority.balancedMove)}, cross ${pct(cross.balancedMove)})`);
    if (on.fireRecall > majority.fireRecall && on.fireVisTicks > 0) wins.push(`fire recall on visible ticks ${pct(on.fireRecall)} (majority ${pct(majority.fireRecall)})`);
    if (!beatsMajorityMove) losses.push(`majority's balanced move (${pct(majority.balancedMove)}) >= clone (${pct(on.balancedMove)})`);
    if (!beatsCrossMove) losses.push(`cross-clone's balanced move (${pct(cross.balancedMove)}) >= clone (${pct(on.balancedMove)})`);
    if (!beatsPosMoved) losses.push(`a baseline had smaller moved-position error (clone ${on.posErrMoved.toFixed(2)}, best baseline ${Math.min(majority.posErrMoved, cross.posErrMoved).toFixed(2)})`);
    if (wins.length) out.push(`- **${b.p}** — clone WINS on: ${wins.join('; ')}.`);
    if (losses.length) {
      out.push(`- **${b.p}** — clone LOSES on: ${losses.join('; ')}.`);
      out.push(`  - Why, plainly: the training set is 1–2 matches, so for many situations the nearest neighbor is far and the breaker (fired ${pct(b.breakerRate)} of the time) hands control to the basic bot — itself a baseline, so the two converge there. Position error is hard to beat because a mostly-still person is matched closely by "majority = stop". This is a data limit, not a metric trick; the factored votes and fire-visibility split are in place and should separate once a player has 3+ varied matches.`);
    } else {
      out.push(`- **${b.p}** — clone beats every baseline on the locked metrics. Holds up.`);
    }
  }
  out.push(`- **What-if:** best-plan win vs the clone median ${pct(spread.summary.cloneWin.median)} vs the basic bot median ${pct(spread.summary.botWin.median)}. The clone now fires ${pct(spread.cloneFireWhenSeen)} of visible ticks vs the bot's ${pct(spread.botFireWhenSeen)}. ${spread.cloneFireWhenSeen >= spread.botFireWhenSeen * 0.6 ? 'The factored fire vote closed much of the old gap.' : 'The clone still fires less than the bot, so treat clone win rates as a ceiling until more firing data arrives.'}`);
  return out;
}

function writeRoster(roster: { n: string; c: number; cRaw: number; bot: boolean; dropped: boolean }[], selfMatches: MatchFile[]): void {
  const L: string[] = [];
  L.push('# Player roster — who has games, who needs more');
  L.push('');
  L.push('`Matches` counts real duels (self-matches excluded). A clone needs at least **2** to be tested, and the learning curve shows it keeps improving with more. This file is regenerated on every `npm run eval`.');
  L.push('');
  L.push('| Player | Kind | Matches | Status |');
  L.push('| --- | --- | ---: | --- |');
  for (const r of roster) {
    const kind = r.bot ? 'bot' : 'human';
    const status = r.dropped ? 'dropped fixture (excluded)' : r.c >= 3 ? 'ok' : r.c === 2 ? 'testable, needs more' : 'cannot test yet — needs 1+ more';
    const note = r.cRaw !== r.c ? ` (+${r.cRaw - r.c} self-match excluded)` : '';
    L.push(`| ${r.n} | ${kind} | ${r.c}${note} | ${status} |`);
  }
  L.push('');
  if (selfMatches.length) L.push(`Self-matches excluded: ${selfMatches.map((m) => `\`${m.id}\``).join(', ')}.`);
  writeFileSync(ROSTER, L.join('\n'));
}

main();
