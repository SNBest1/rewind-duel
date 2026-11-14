// What-if CLI: from a fork tick of a recorded match, print the top plans the human could have run.
// Usage: npm run whatif -- data/<id>.json <human 0|1> <forkTick>
import { readFileSync } from 'node:fs';
import type { MatchFile } from '@rewind/engine';
import { runWhatIf } from './whatif-run';

const [path, humanArg, forkArg] = process.argv.slice(2);
if (!path) {
  console.error('usage: npm run whatif -- data/<id>.json <human 0|1> <forkTick>');
  process.exit(2);
}
const file: MatchFile = JSON.parse(readFileSync(path, 'utf8'));
const human = (humanArg === '1' ? 1 : 0) as 0 | 1;
const forkTick = Number(forkArg ?? 0) | 0;

const { results, ranInWorker } = await runWhatIf(file, human, forkTick, 3);
const oppName = file.players.find((p) => p.slot === (1 - human))?.name ?? 'opponent';
console.log(`What ${file.players.find((p) => p.slot === human)?.name ?? 'you'} could have done from tick ${forkTick}, against a clone of ${oppName}:`);
console.log(ranInWorker ? '(evaluated in a worker thread)' : '(worker unavailable; ran inline)');
console.log('');
results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.label}`);
  console.log(`   win ${(r.winRate * 100).toFixed(0)}%  ·  survive ${(r.survivalRate * 100).toFixed(0)}%  ·  ${r.avgShotsLanded.toFixed(1)} shots landed`);
  console.log(`   ${r.reason}`);
});
