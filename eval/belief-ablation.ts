// Does the belief map make the bot smarter? Same skill, same seeds, belief on vs off, across every map,
// with sides swapped so neither slot has an edge. Run with: npm run eval:belief
import { MAP_IDS, observe } from '@rewind/engine';
import { AiPlayer, seededRng } from '../server/ai';
import { blankBrain } from '../server/brain';
import { MatchRunner } from '../server/match';

export function ablation(matchesPerMap: number, skill = 0.75) {
  let beliefRounds = 0;
  let plainRounds = 0;
  let beliefMatches = 0;
  let matches = 0;
  const perMap: Record<string, [number, number]> = {};
  for (const mapId of MAP_IDS) {
    perMap[mapId] = [0, 0];
    for (let m = 0; m < matchesPerMap; m++) {
      const beliefSlot = (m % 2) as 0 | 1; // swap sides every match
      const runner = new MatchRunner('ab', 9000 + m, ['a', 'b'], mapId);
      const bots = [0, 1].map((slot) => {
        const brain = blankBrain('x');
        brain.skill = skill;
        const b = new AiPlayer(slot as 0 | 1, mapId, brain, 'adaptive', seededRng(500 + m * 2 + slot));
        b.useBelief = slot === beliefSlot;
        return b;
      });
      for (let t = 0; t < 40000 && runner.state.phase !== 'matchEnd'; t++) {
        for (const b of bots) runner.setInput(b.slot, b.think(observe(runner.state, b.slot)));
        runner.tick();
      }
      const s = runner.state.score;
      beliefRounds += s[beliefSlot];
      plainRounds += s[1 - beliefSlot];
      perMap[mapId][0] += s[beliefSlot];
      perMap[mapId][1] += s[1 - beliefSlot];
      if (runner.state.winner === beliefSlot) beliefMatches++;
      matches++;
    }
  }
  return { beliefRounds, plainRounds, beliefMatches, matches, perMap };
}

if (process.argv[1]?.includes('belief-ablation')) {
  const n = Number(process.argv[2] ?? 4);
  const r = ablation(n);
  console.log(`belief vs no belief, ${r.matches} matches at skill 75:`);
  console.log(`  rounds ${r.beliefRounds}-${r.plainRounds} (${Math.round((100 * r.beliefRounds) / (r.beliefRounds + r.plainRounds))}%), matches ${r.beliefMatches}/${r.matches}`);
  for (const [m, [a, b]] of Object.entries(r.perMap)) console.log(`  ${m}: ${a}-${b}`);
}
