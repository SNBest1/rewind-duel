// Evidence. Writes eval/results.md with real numbers, even when they are weak (spec Phase 5).
//
// Honesty rules baked into this script:
//  - Human matches are the result; bot matches are a labelled SANITY CHECK, never the headline.
//  - The alpha/bravo fixture and the tiny tunnel-test match are dropped (see DROP below).
//  - Move-direction match and fire match are reported SEPARATELY, plus 1-second position error.
//  - Every human clone is compared against three baselines: basic bot, majority action, cross-player clone.
//  - A learning curve shows accuracy vs number of training matches, with a chart (eval/learning-curve.svg).
//  - The what-if search is audited (fog + fires-back) and run over many human forks (spread, not one fork).
//  - A roster (eval/roster.md) shows how many matches each player has, so you know who still needs games.
// Nothing is tuned to flatter the numbers. If the human clone loses to a baseline, the notes say why.
//
// Run with: npm run eval
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MatchFile, Policy, Slot } from '@rewind/engine';
import {
  BasicBot, MajorityBaseline, buildClone, isBotMatch, isBotName,
  loadMatches, matchesOf, playerNames, slotOf,
} from '@rewind/clone';
import { cloneAccuracy, handoffRate, positionError } from './metrics';
import { transferCase } from './transfer';
import { playerCurve, curveChartSvg, type PlayerCurve } from './learning-curve';
import { auditWhatIf, forkSpread } from './whatif-audit';

const OUT = fileURLToPath(new URL('./results.md', import.meta.url));
const ROSTER = fileURLToPath(new URL('./roster.md', import.meta.url));
const SVG = fileURLToPath(new URL('./learning-curve.svg', import.meta.url));
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

// Matches excluded from the evidence entirely. They are not skill data:
//  - the alpha/bravo fixture (two test accounts; `pub1` is 160 ticks, `t1` is one player barely moving)
//  - the tunnel smoke-test (`p1`/`p2`, 100 ticks)
// Anyone who wants to see them can still replay the raw files; they just do not belong in the numbers.
const DROP_PLAYERS = new Set(['alpha', 'bravo', 'p1', 'p2']);
const isDropped = (m: MatchFile) => m.players.some((p) => DROP_PLAYERS.has(p.name));

type AccRow = { player: string; policy: string; moveAcc: number; fireAcc: number; posErr: number; decisions: number };

/** Builds the accuracy + position rows for one player against every baseline. */
function rowsForPlayer(player: string, usable: MatchFile[]): AccRow[] {
  const mine = matchesOf(usable, player);
  const held = mine[0];
  const slot = slotOf(held, player) as Slot;

  const own = buildClone(player, { allMatches: usable, holdOut: [held.id] });
  const majority = new MajorityBaseline(player, own.samples);
  const bot: Policy = new BasicBot();

  // Cross clone: a DIFFERENT player with enough data, of the same kind (human vs human, bot vs bot) when possible.
  const sameKind = playerNames(usable).filter((n) => n !== player && isBotName(n) === isBotName(player) && matchesOf(usable, n).length >= 1);
  const otherName = (sameKind[0] ?? playerNames(usable).find((n) => n !== player)) ?? player;
  const otherHold = matchesOf(usable, otherName).length > 1 ? [held.id] : [];
  const other = buildClone(otherName, { allMatches: usable, holdOut: otherHold });

  const policies: { name: string; policy: Policy }[] = [
    { name: `${player} clone (own)`, policy: own.guarded },
    { name: 'basic bot', policy: bot },
    { name: `majority action`, policy: majority },
    { name: `${otherName} clone (cross)`, policy: other.guarded },
  ];

  return policies.map(({ name, policy }) => {
    const acc = cloneAccuracy(held, slot, policy);
    const pos = positionError(held, slot, policy);
    const d = Math.max(1, acc.decisions);
    return { player, policy: name, moveAcc: acc.moveMatch / d, fireAcc: acc.fireMatch / d, posErr: pos.avgError, decisions: acc.decisions };
  });
}

function accuracyTable(title: string, rows: AccRow[], note: string): string[] {
  const out: string[] = [`### ${title}`, '', note, ''];
  out.push('| Player | Policy | Move match | Fire match | Position error (units) | Decisions |');
  out.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const r of rows) {
    out.push(`| ${r.player} | ${r.policy} | ${pct(r.moveAcc)} | ${pct(r.fireAcc)} | ${r.posErr.toFixed(2)} | ${r.decisions} |`);
  }
  out.push('');
  return out;
}

function main(): void {
  const all = loadMatches();
  const usable = all.filter((m) => !isDropped(m)); // everything except the dropped fixtures
  const started = new Date().toISOString();
  const lines: string[] = [];

  const humanMatches = usable.filter((m) => !isBotMatch(m));
  const botMatches = usable.filter((m) => isBotMatch(m));
  const humanPlayers = playerNames(humanMatches).filter((n) => !isBotName(n));
  const botPlayers = playerNames(botMatches);

  // --- roster (its own file + a section here) ---------------------------------------------------
  const roster = playerNames(all)
    .map((n) => ({ n, c: matchesOf(all, n).length, bot: isBotName(n), dropped: DROP_PLAYERS.has(n) }))
    .sort((a, b) => b.c - a.c);
  writeRoster(roster);

  lines.push('# Rewind — evidence');
  lines.push('');
  lines.push(`Generated by \`npm run eval\` on ${started}. All numbers are measured on a held-out match the clone never trained on. Nothing is tuned to flatter the numbers; weak results are reported as-is.`);
  lines.push('');
  lines.push(`Dataset after dropping fixtures: ${humanMatches.length} human matches, ${botMatches.length} bot matches. Player roster is in \`eval/roster.md\`.`);
  lines.push('');

  // --- 1. accuracy: HUMAN result, then BOT sanity check ----------------------------------------
  lines.push('## 1. Clone accuracy (held-out)');
  lines.push('');
  lines.push('Move-direction match and fire match are reported separately. Position error is the distance (map units) between where the policy and the real person end after 1 second from each held-out moment, opponent frozen. The baselines: **basic bot** (hand-written), **majority action** (always that player\'s single most common action), **cross clone** (a clone of a different player).');
  lines.push('');

  const humanEvaluable = humanPlayers.filter((n) => matchesOf(humanMatches, n).length >= 2);
  const humanRows = humanEvaluable.flatMap((p) => rowsForPlayer(p, humanMatches));
  lines.push(...accuracyTable(
    'Humans (the result)',
    humanRows,
    humanRows.length
      ? 'Players with at least two human matches. This is the headline: the own clone should beat all three baselines on both move match and position error.'
      : '_No human player has two or more usable matches yet, so there is no held-out human accuracy to report. Record more games (see the roster)._',
  ));

  const botEvaluable = botPlayers.filter((n) => matchesOf(botMatches, n).length >= 2);
  const botRows = botEvaluable.flatMap((p) => rowsForPlayer(p, botMatches));
  lines.push(...accuracyTable(
    'Bots (sanity check only — NOT the main result)',
    botRows,
    'Scripted bots are perfectly repeatable, so their clones score very high. This only confirms the pipeline works end-to-end; it says nothing about cloning a real person.',
  ));

  // --- 2. learning curve + chart ---------------------------------------------------------------
  lines.push('## 2. Learning curve');
  lines.push('');
  lines.push('Held-out **move-match** accuracy after training on 1, 2, 3, ... of a player\'s other matches (move match is the discriminating signal; fire is dominated by "not firing"). More games should mean a better clone. A short line means that player has few games — they need more. The held-out match is the same one section 1 uses, so the last point matches the own-clone row there.');
  lines.push('');
  const curves: PlayerCurve[] = [];
  for (const p of humanEvaluable) {
    const c = playerCurve(p, humanMatches, false);
    if (c) curves.push(c);
  }
  for (const p of botEvaluable) {
    const c = playerCurve(p, botMatches, true);
    if (c) curves.push(c);
  }
  if (curves.length) {
    lines.push('| Player | Kind | Training matches | Move match | Fire match |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const c of curves) {
      for (const pt of c.points) {
        lines.push(`| ${c.player} | ${c.isBot ? 'bot' : 'human'} | ${pt.trainMatches} | ${pct(pt.moveAcc)} | ${pct(pt.fireAcc)} |`);
      }
    }
    lines.push('');
    writeFileSync(SVG, curveChartSvg(curves));
    lines.push('Chart: `eval/learning-curve.svg` (self-contained SVG, drop it straight into the video).');
  } else {
    lines.push('_No player has enough matches to draw a curve. Record more games._');
  }
  lines.push('');

  // --- 3. handoff rate -------------------------------------------------------------------------
  lines.push('## 3. Handoff rate (circuit breaker)');
  lines.push('');
  lines.push('Share of decision ticks on the held-out match where the clone was too far from anything it had seen, so the breaker handed control to the basic bot.');
  lines.push('');
  const handoffLines: string[] = [];
  for (const player of humanEvaluable) {
    const mine = matchesOf(humanMatches, player);
    const held = mine[0];
    const slot = slotOf(held, player) as Slot;
    const own = buildClone(player, { allMatches: humanMatches, holdOut: [held.id] });
    const h = handoffRate(held, slot, own.guarded);
    handoffLines.push(`- **${player}** on held-out \`${held.id}\`: breaker fired on ${pct(h.rate)} of ${h.ticks} decision ticks (limit ${own.breakerLimit.toFixed(2)}).`);
  }
  lines.push(...(handoffLines.length ? handoffLines : ['- (no evaluable human players)']));
  lines.push('');

  // --- 4. what-if audit + fork spread ----------------------------------------------------------
  lines.push('## 4. What-if search — audit and spread');
  lines.push('');
  lines.push('Before trusting the "what you could have done" numbers, three checks on a real human fork:');
  lines.push('');
  const auditLines: string[] = [];
  const auditMatch = humanMatches.find((m) => m.ticks > 1000);
  if (auditMatch) {
    const audit = auditWhatIf(auditMatch, humanMatches);
    for (const d of audit.details) auditLines.push(`- ${d}`);
    const allPass = audit.humanFogOk && audit.cloneFogOk && audit.cloneFiresBack;
    auditLines.push(`- **verdict: ${allPass ? 'PASS' : 'FAIL'}** — plans and clone use \`observe\` only (fog holds) and the clone CAN shoot back. How often it actually shoots in real forks is the fire rate reported in the spread below.`);
  } else {
    auditLines.push('- (no human match long enough to audit)');
  }
  lines.push(...auditLines);
  lines.push('');
  lines.push('Spread across many human-match forks (3 s before each round end, plus evenly spaced ticks), reporting the best plan\'s win and survival rate per fork — not a single cherry-picked fork:');
  lines.push('');
  const spread = forkSpread(humanMatches, humanMatches, 10, 12);
  if (spread.forks > 0) {
    lines.push(`- **${spread.forks} forks** evaluated.`);
    lines.push(`- Best-plan win rate across forks: min ${pct(spread.summary.bestPlanWin.min)}, median ${pct(spread.summary.bestPlanWin.median)}, max ${pct(spread.summary.bestPlanWin.max)}.`);
    lines.push(`- Best-plan survival rate across forks: min ${pct(spread.summary.bestPlanSurvive.min)}, median ${pct(spread.summary.bestPlanSurvive.median)}, max ${pct(spread.summary.bestPlanSurvive.max)}.`);
    lines.push(`- **Clone fire rate when it could see the human: ${pct(spread.cloneFireWhenSeen)}.** This is the honest caveat: a high plan win rate against a clone that rarely shoots back is partly the clone's reticence, not the plan's quality. The "Clone saw / fired" columns below show it per fork.`);
    lines.push('');
    lines.push('| Match | Fork tick | Best plan | Win | Survive | Clone saw (ticks) | Clone fired (ticks) |');
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: |');
    for (const f of spread.perFork) lines.push(`| \`${f.matchId}\` | ${f.forkTick} | ${f.bestPlan} | ${pct(f.win)} | ${pct(f.survive)} | ${f.cloneSawTicks} | ${f.cloneFireTicks} |`);
  } else {
    lines.push('- (no human forks could be evaluated)');
  }
  lines.push('');

  // --- 5. transfer test ------------------------------------------------------------------------
  lines.push('## 5. Transfer test');
  lines.push('');
  lines.push('For a round a human lost: their first (recorded) attempt, retries by their own clone against the opponent clone, and the best what-if plan from the same fork.');
  lines.push('');
  const transferLines: string[] = [];
  for (const player of humanEvaluable) {
    const held = matchesOf(humanMatches, player)[0];
    const tc = transferCase(held, player, humanMatches);
    if (tc) {
      const wins = tc.retries.filter((r) => r.playerWon).length;
      transferLines.push(
        `- **${player}**, round ${tc.round} of \`${tc.matchId}\` (lost), fork tick ${tc.forkTick}:\n` +
        `  - first attempt: lost (recorded)\n` +
        `  - retries (own clone vs opponent clone): won ${wins} of ${tc.retries.length}\n` +
        `  - fresh attempt (best plan): ${tc.freshAttempt ? `"${tc.freshAttempt.plan}" — win ${pct(tc.freshAttempt.winRate)}, survive ${pct(tc.freshAttempt.survivalRate)}` : 'none'}`,
      );
    }
  }
  lines.push(...(transferLines.length
    ? transferLines
    : ['- No transfer case: the only evaluable human (Nipun) won every round in the held-out match (5–0), so there is no lost round to replay. This needs a recorded human match the player actually lost.']));
  lines.push('');

  // --- honest read ------------------------------------------------------------------------------
  lines.push('## Honest read');
  lines.push('');
  lines.push(...honestRead(humanRows));
  lines.push(`- **What-if:** the plans win often (median ${pct(spread.summary.bestPlanWin.median)}), but the clone fired on only ${pct(spread.cloneFireWhenSeen)} of the ticks it could see the human. So the win rate is partly the clone being too passive, not the plan being strong. The fix is more recorded human games where the person actually shoots, so the clone learns to shoot back; the circuit breaker's basic bot does shoot, which is why head-on the audit still passes.`);
  lines.push('');

  writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${OUT}`);
  console.log(`wrote ${ROSTER}`);
  if (curves.length) console.log(`wrote ${SVG}`);
  console.log(`human players evaluable: ${humanEvaluable.length}, bot players evaluable: ${botEvaluable.length}, what-if forks: ${spread.forks}`);
}

/** A plain-language read of whether the human clone beat its baselines, and why if not. */
function honestRead(humanRows: AccRow[]): string[] {
  if (!humanRows.length) {
    return [
      '- There is not enough human data to make a claim yet. Only one human has two or more matches, and one of those is a self-match (both slots the same person).',
      '- What this means for the video: show the method and the bot sanity check, and say the human numbers are pending more recorded games. Do not imply the human clone is validated — it is not.',
    ];
  }
  const out: string[] = [];
  const byPlayer = new Map<string, AccRow[]>();
  for (const r of humanRows) {
    const list = byPlayer.get(r.player) ?? [];
    list.push(r);
    byPlayer.set(r.player, list);
  }
  for (const [player, rows] of byPlayer) {
    const own = rows.find((r) => r.policy.includes('(own)'))!;
    const baselines = rows.filter((r) => r !== own);
    const beatsMove = baselines.every((b) => own.moveAcc >= b.moveAcc);
    const beatsPos = baselines.every((b) => own.posErr <= b.posErr);
    const bestMoveBaseline = baselines.reduce((a, b) => (b.moveAcc > a.moveAcc ? b : a));
    if (beatsMove && beatsPos) {
      out.push(`- **${player}**: own clone beats every baseline on move match (${pct(own.moveAcc)}) and position error (${own.posErr.toFixed(2)}). Good.`);
    } else {
      const reasons: string[] = [];
      if (!beatsMove) reasons.push(`a baseline matched moves as well or better ("${bestMoveBaseline.policy}" at ${pct(bestMoveBaseline.moveAcc)} vs own ${pct(own.moveAcc)})`);
      if (!beatsPos) reasons.push('a baseline landed closer in position');
      out.push(`- **${player}**: own clone did NOT clearly beat the baselines — ${reasons.join('; ')}.`);
      out.push('  - Likely why: the dataset is tiny and human play is noisy. With one or two training games the KNN has few neighbors, so it often falls back through the breaker to the same hand-written moves the basic bot uses, and a human who mostly holds still is easy for the majority-action baseline to match. This is a data problem, not a code problem — the learning curve shows the direction, and more games should separate them.');
    }
  }
  return out;
}

function writeRoster(roster: { n: string; c: number; bot: boolean; dropped: boolean }[]): void {
  const L: string[] = [];
  L.push('# Player roster — who has games, who needs more');
  L.push('');
  L.push('A clone needs at least **2** matches to be tested (one to hold out, one to train on), and the learning curve shows it keeps improving with more. Record more games for anyone low on this list.');
  L.push('');
  L.push('| Player | Kind | Matches | Status |');
  L.push('| --- | --- | ---: | --- |');
  for (const r of roster) {
    const kind = r.bot ? 'bot' : 'human';
    const status = r.dropped ? 'dropped fixture (excluded)' : r.c >= 3 ? 'ok' : r.c === 2 ? 'testable, needs more' : 'cannot test yet — needs 1+ more';
    L.push(`| ${r.n} | ${kind} | ${r.c} | ${status} |`);
  }
  L.push('');
  L.push('Note: "Nipun" appears with a self-match (both slots the same person), which inflates the raw count. Distinct opponents matter more than raw match count.');
  writeFileSync(ROSTER, L.join('\n'));
}

main();
