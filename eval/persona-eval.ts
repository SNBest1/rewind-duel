// Does the person + AI hybrid (server/persona.ts) still play like the person, and does it fight better than
// the plain clone? Run with: npm run eval:persona [matches per policy]. Writes eval/results-persona.md.
//
// 1. Habits: on each player's newest match (held out), every recorded decision is replayed and each policy is
//    asked what it would do; agreement = same move direction (of 9) as the real person.
// 2. Fighting: each policy plays whole matches against the AI at the same rank as the person, on the map of their
//    held-out match. A good recreation of a person should hold its own against an opponent of their level.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { observe, type Slot } from '@rewind/engine';
import { agreement } from '../ai/clone/evaluate';
import { GuardedClone, buildClone, loadMatches, matchesOf } from '../ai/clone/knn';
import type { Policy } from '../ai/clone/policy';
import { AiPlayer, BasicBot, seededRng } from '../server/ai';
import { BrainStore, blankBrain } from '../server/brain';
import { MatchRunner } from '../server/match';
import { AiAlonePolicy, PersonaPolicy, personSkill } from '../server/persona';
import { rankOf } from '../server/ranks';

const DATA = fileURLToPath(new URL('../data/', import.meta.url));
const OUT = fileURLToPath(new URL('./results-persona.md', import.meta.url));
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const perPolicy = Number(process.argv[2] ?? 6);

const files = loadMatches(DATA);
const brains = new BrainStore(`${DATA}brains/`);
const players = [...new Set(files.flatMap((f) => f.players.map((p) => p.name)))];

/** Plays one whole match: `make(slot)` against the AI at `rank`. Returns rounds won by the policy and by the AI. */
function duel(make: (slot: Slot, seed: number) => Policy, mapId: string, rank: number, seed: number): [number, number] {
  const mine = (seed % 2) as Slot;
  const runner = new MatchRunner('e', seed, ['p', 'ai'], mapId, undefined, 'valorant');
  const p = make(mine, seed);
  const ai = new AiPlayer((1 - mine) as Slot, mapId, blankBrain('x'), `rank:${rank}`, seededRng(seed * 7 + 1));
  for (let t = 0; t < 40000 && runner.state.phase !== 'matchEnd'; t++) {
    runner.setInput(mine, p.act(observe(runner.state, mine)).input);
    runner.setInput(ai.slot, ai.think(observe(runner.state, ai.slot)));
    runner.tick();
  }
  return [runner.state.score[mine], runner.state.score[1 - mine]];
}

const lines = ['# Person + AI hybrid vs the plain clone', '', `Generated ${new Date().toISOString()} from ${files.length} recorded matches in \`data/\`, ${perPolicy} matches per policy in part 2.`, ''];
lines.push('| Player | Rank used | Decisions | Move agreement: clone | hybrid | AI alone | Hybrid moves as the person | Rounds won vs AI at their rank: clone | hybrid | AI alone |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
let rows = 0;
for (const player of players) {
  const mine = matchesOf(files, player);
  const ids = [...new Set(mine.map((m) => m.file.id))].sort();
  if (ids.length < 2) continue;
  const heldId = ids[ids.length - 1];
  const held = mine.find((m) => m.file.id === heldId)!;
  const built = buildClone(player, files, { holdOut: [heldId] });
  if (built.trainSamples < 60) continue;
  const skill = personSkill(brains.load(player));
  const rank = rankOf(skill);
  const map = held.file.map;
  let lastPersona: PersonaPolicy | null = null;
  const clone = (slot: Slot, seed: number): Policy => new GuardedClone(built.clone.fresh(), new BasicBot(slot, map, seededRng(seed)), built.limit);
  const hybrid = (slot: Slot, seed: number): Policy =>
    (lastPersona = new PersonaPolicy(built.clone.fresh(), built.limit, skill, slot, map, blankBrain('x'), seededRng(seed)));
  const alone = (slot: Slot, seed: number): Policy => new AiAlonePolicy(slot, map, skill, blankBrain('x'), undefined, seededRng(seed));

  const agree = [clone, hybrid, alone].map((make) => agreement(() => make(held.slot, 1), held.file, held.slot));
  let personTicks = 0;
  let ticks = 0;
  const rounds = [clone, hybrid, alone].map((make, k) => {
    let won = 0;
    let lost = 0;
    for (let m = 0; m < perPolicy; m++) {
      const [w, l] = duel(make, map, rank.index, 500 + m);
      won += w;
      lost += l;
      if (k === 1 && lastPersona) {
        personTicks += (lastPersona as PersonaPolicy).personTicks;
        ticks += (lastPersona as PersonaPolicy).ticks;
      }
    }
    return won / Math.max(1, won + lost);
  });
  lines.push(`| ${player} | ${rank.label} | ${agree[0].n} | ${pct(agree[0].move)} | **${pct(agree[1].move)}** | ${pct(agree[2].move)} | ${ticks ? pct(personTicks / ticks) : '-'} | ${pct(rounds[0])} | **${pct(rounds[1])}** | ${pct(rounds[2])} |`);
  console.log(lines[lines.length - 1]);
  rows++;
}
if (!rows) lines.push('| (no player has 2+ matches with enough recorded decisions) | | | | | | | | | |');
lines.push('', '"Hybrid moves as the person" is the share of live ticks in part 2 where the person\'s habits drove the movement; the rest the AI decided.');
writeFileSync(OUT, `${lines.join('\n')}\n`);
console.log(`wrote ${OUT}`);
