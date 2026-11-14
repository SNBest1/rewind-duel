// Evidence for the judges, from real recorded data. Run with: npm run eval
// Writes eval/results.md. Reports the real numbers, weak or not.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agreement, type Agreement } from '../clone/evaluate';
import { buildClone, loadMatches, matchesOf } from '../clone/knn';
import type { BranchFile } from '../rewind/session';
import { BasicBot, seededRng } from '../server/ai';
import type { Brain } from '../server/brain';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const OUT = fileURLToPath(new URL('./results.md', import.meta.url));
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const files = loadMatches(DATA);
const players = [...new Set(files.flatMap((f) => f.players.map((p) => p.name)))];
const lines: string[] = ['# Rewind evals', '', `Generated ${new Date().toISOString()} from ${files.length} recorded matches in \`data/\`.`, ''];

// --- 1. Clone accuracy on held-out matches --------------------------------------------------------------
lines.push('## 1. Does the clone play like the person it copies?', '');
lines.push('For each player with 2+ recorded matches, the newest match is held out. The clone is built from the rest, then asked what it would do at every recorded decision of the held-out match. Agreement = same move direction (of 9) / same fire choice as the real person.', '');
lines.push('| Player | Held-out decisions | Own clone: move | Basic bot: move | Other player\'s clone: move | Own clone: fire | Basic bot: fire |', '| --- | --- | --- | --- | --- | --- | --- |');
let rows = 0;
for (const player of players) {
  const mine = matchesOf(files, player);
  const ids = [...new Set(mine.map((m) => m.file.id))].sort();
  if (ids.length < 2) continue;
  const heldId = ids[ids.length - 1];
  const held = mine.find((m) => m.file.id === heldId)!;
  const own = buildClone(player, files, { holdOut: [heldId] });
  if (own.trainSamples < 50) continue;
  const other = players
    .filter((p) => p !== player)
    .map((p) => buildClone(p, files.filter((f) => f.id !== heldId)))
    .sort((a, b) => b.trainSamples - a.trainSamples)[0];
  const a: Agreement = agreement(() => own.clone.fresh(), held.file, held.slot);
  const b: Agreement = agreement(() => new BasicBot(held.slot, held.file.map, seededRng(1)), held.file, held.slot);
  const c: Agreement | null = other && other.trainSamples >= 50 ? agreement(() => other.clone.fresh(), held.file, held.slot) : null;
  lines.push(`| ${player} | ${a.n} | **${pct(a.move)}** | ${pct(b.move)} | ${c ? `${pct(c.move)} (${other.clone.player})` : 'n/a'} | **${pct(a.fire)}** | ${pct(b.fire)} |`);
  rows++;
}
if (!rows) lines.push('| (no player has 2+ matches yet: play more matches under the same name) | | | | | | |');
lines.push('', 'Fire agreement is high for every policy because most of the time nobody is firing; move agreement is the harder test.', '');

// --- 2. Handoff and breaker -------------------------------------------------------------------------------
lines.push('## 2. Rewind sessions', '');
const branchDir = `${DATA}branches/`;
const branches: BranchFile[] = existsSync(branchDir)
  ? readdirSync(branchDir).filter((n) => n.endsWith('.json')).flatMap((n) => JSON.parse(readFileSync(branchDir + n, 'utf8')) as BranchFile[])
  : [];
if (branches.length) {
  const handed = branches.filter((b) => b.handoffTick !== null);
  const ghostSecs = handed.map((b) => (b.handoffTick! - b.forkTick) / 32);
  const cloneTicks = handed.reduce((a, b) => a + (b.ticks - b.handoffTick!), 0);
  const breakerTicks = branches.reduce((a, b) => a + b.breakerTicks, 0);
  const byFork = new Map<string, BranchFile[]>();
  for (const b of branches) byFork.set(`${b.match}@${b.forkTick}/${b.human}`, [...(byFork.get(`${b.match}@${b.forkTick}/${b.human}`) ?? []), b]);
  lines.push(`- ${branches.length} rewind attempts from ${byFork.size} moments. ${branches.filter((b) => b.outcome === 'won').length} won.`);
  lines.push(`- Handed from ghost to clone in ${handed.length} of ${branches.length}, after ${ghostSecs.length ? (ghostSecs.reduce((a, b) => a + b, 0) / ghostSecs.length).toFixed(1) : '-'} s of ghost on average.`);
  lines.push(`- Handoff rate (share of clone time under the circuit breaker, i.e. played by the basic bot): **${cloneTicks ? pct(breakerTicks / cloneTicks) : 'n/a'}**.`);
  lines.push('', '| Moment | Attempts | Won | First attempt | Last attempt |', '| --- | --- | --- | --- | --- |');
  for (const [k, bs] of byFork) lines.push(`| ${k} | ${bs.length} | ${bs.filter((b) => b.outcome === 'won').length} | ${bs[0].outcome} | ${bs[bs.length - 1].outcome} |`);
} else {
  lines.push('No rewind attempts recorded yet.');
}
lines.push('');

// --- 3. Adaptation ----------------------------------------------------------------------------------------
lines.push('## 3. Does the AI adapt to the player?', '');
const brainDir = `${DATA}brains/`;
const brains: Brain[] = existsSync(brainDir) ? readdirSync(brainDir).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(brainDir + n, 'utf8'))) : [];
if (brains.length) {
  lines.push('| Player | Rounds studied | Adaptive rounds | AI skill after first round → now | Player round wins, first half vs second half |', '| --- | --- | --- | --- | --- |');
  for (const b of brains) {
    const h = b.skillHistory ?? [];
    const half = Math.floor(h.length / 2);
    const wr = (xs: typeof h) => (xs.length ? pct(xs.filter((x) => x.humanWon).length / xs.length) : '-');
    lines.push(`| ${b.name} | ${b.rounds} | ${h.length} | ${h.length ? `${Math.round(h[0].skill * 100)} → ${Math.round(h[h.length - 1].skill * 100)}` : '-'} | ${wr(h.slice(0, half))} vs ${wr(h.slice(half))} |`);
  }
  lines.push('', 'Adaptive skill starts at 20, moves +7 after a round the player wins and −9 after one they lose, and each step grows ×1.5 per extra round of a streak (capped at ×2.5).');
} else {
  lines.push('No player brains yet.');
}
lines.push('', '## Not measured yet', '', '- Position error (run each policy 1 s from held-out moments and measure distance to where the person went).', '- Transfer test (first attempt vs retries vs a fresh attempt at the same situation).', '');

writeFileSync(OUT, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\nwrote ${OUT}`);
