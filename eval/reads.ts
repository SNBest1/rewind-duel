// Does the AI get better at reading a player the more it plays them? A scripted player with fixed habits
// (always site A, top lane) plays the AI for several matches. The AI's brain carries over between matches,
// like a real player's file does. We count how often its blind call ("you are hitting A") was right.
// Run with: npm run eval:reads
import { observe } from '@rewind/engine';
import { ALICE, StylePlayer } from '../ai/clone/test/fixtures';
import { AiPlayer, seededRng } from '../server/ai';
import { Trainer, blankBrain } from '../server/brain';
import { MatchRunner } from '../server/match';

export function readsOverMatches(matches: number, rank = 18) {
  const brain = blankBrain('alice'); // what the AI knows about alice, kept across matches
  const out: { match: number; calls: number; right: number }[] = [];
  for (let m = 0; m < matches; m++) {
    const runner = new MatchRunner('r', 300 + m, ['alice', 'ai'], 'duel');
    const human = new StylePlayer(0, 'duel', ALICE, seededRng(900 + m));
    const ai = new AiPlayer(1, 'duel', brain, `rank:${rank}`, seededRng(700 + m));
    const trainer = new Trainer(brain, 0, 1, false);
    let calls = 0;
    let right = 0;
    for (let t = 0; t < 40000 && runner.state.phase !== 'matchEnd'; t++) {
      runner.setInput(0, human.think(observe(runner.state, 0)));
      runner.setInput(1, ai.think(observe(runner.state, 1)));
      const events = runner.tick();
      trainer.observe(runner.state, events);
      if (events.some((e) => e.type === 'roundEnd')) {
        const call = ai.prediction;
        const truth = trainer.lastRound;
        if (call && truth?.site && call.attacking === truth.humanAttacked) {
          calls++;
          if (call.site === truth.site) right++;
        }
        ai.prediction = null;
      }
    }
    trainer.finishMatch();
    out.push({ match: m + 1, calls, right });
  }
  return out;
}

if (process.argv[1]?.includes('reads')) {
  const r = readsOverMatches(Number(process.argv[2] ?? 4));
  console.log('AI reads of a player who always plays site A (chance is 50%):');
  for (const x of r) console.log(`  match ${x.match}: ${x.right}/${x.calls} calls right${x.calls ? ` (${Math.round((100 * x.right) / x.calls)}%)` : ''}`);
}
