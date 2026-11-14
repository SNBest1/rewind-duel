// Do higher ranks really play better? Each tier plays the tier above it, sides swapped, on every map.
// Also reports headshot rate per rank, since aim is what changes most. Run with: npm run eval:ranks
import { MAP_IDS, observe, type GameEvent } from '@rewind/engine';
import { AiPlayer, seededRng } from '../server/ai';
import { blankBrain } from '../server/brain';
import { MatchRunner } from '../server/match';
import { TIERS, skillOfRank } from '../server/ranks';

function play(mapId: string, ranks: [number, number], seed: number) {
  // Live matches use the VALORANT rules (economy, shields, armory), so the ladder does too.
  const runner = new MatchRunner('r', seed, ['a', 'b'], mapId, undefined, 'valorant');
  const bots = [0, 1].map((slot) => new AiPlayer(slot as 0 | 1, mapId, blankBrain('x'), `rank:${ranks[slot]}`, seededRng(seed * 3 + slot)));
  const events: GameEvent[] = [];
  for (let t = 0; t < 40000 && runner.state.phase !== 'matchEnd'; t++) {
    for (const b of bots) runner.setInput(b.slot, b.think(observe(runner.state, b.slot)));
    events.push(...runner.tick());
  }
  return { score: runner.state.score, events };
}

const perMatchup = Number(process.argv[2] ?? 1);
const rows: string[] = [];
const head: Record<number, { hits: number; heads: number }> = {};
for (let tier = 0; tier < TIERS.length - 1; tier++) {
  const lo = tier * 3;
  const hi = Math.min(lo + 3, (TIERS.length - 1) * 3);
  let loR = 0;
  let hiR = 0;
  for (const mapId of MAP_IDS) {
    for (let m = 0; m < perMatchup * 2; m++) {
      const hiSlot = (m % 2) as 0 | 1;
      const ranks: [number, number] = hiSlot === 0 ? [hi, lo] : [lo, hi];
      const { score, events } = play(mapId, ranks, 100 + tier * 10 + m);
      hiR += score[hiSlot];
      loR += score[1 - hiSlot];
      for (const e of events) {
        if (e.type !== 'shot' || !e.hit) continue;
        const r = ranks[e.slot];
        head[r] ??= { hits: 0, heads: 0 };
        head[r].hits++;
        if (e.head) head[r].heads++;
      }
    }
  }
  rows.push(`  ${TIERS[tier + 1].name.padEnd(11)} vs ${TIERS[tier].name.padEnd(11)} rounds ${hiR}-${loR} (${Math.round((100 * hiR) / (hiR + loR))}% to the higher rank)`);
}
console.log(`Rank ladder: each tier vs the one below (skill ${skillOfRank(0).toFixed(2)} to ${skillOfRank(24).toFixed(2)}), ${perMatchup * 2} matches per map:`);
console.log(rows.join('\n'));
console.log('Headshot share of hits by rank step:');
console.log(Object.entries(head).sort((a, b) => Number(a[0]) - Number(b[0])).map(([r, v]) => `  rank ${r}: ${Math.round((100 * v.heads) / Math.max(1, v.hits))}% of ${v.hits} hits`).join('\n'));
