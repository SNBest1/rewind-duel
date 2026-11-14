// Rebuilds a recorded match from its seed and inputs and checks the final hash.
// Run with: npm run replay -- data/<id>.json
import { readFileSync } from 'node:fs';
import { hashState, replayMatch, type MatchFile } from '@rewind/engine';

const path = process.argv[2];
if (!path) {
  console.error('usage: npm run replay -- data/<id>.json');
  process.exit(2);
}
const file: MatchFile = JSON.parse(readFileSync(path, 'utf8'));
const final = replayMatch(file);
const hash = hashState(final);
const ok = hash === file.finalHash;
console.log(`${file.id}: ${file.players.map((p) => p.name).join(' vs ')}, ${file.ticks} ticks, ${file.inputs.length} input changes`);
console.log(`score ${final.score.join('-')}, recorded hash ${file.finalHash}, replayed hash ${hash}`);
console.log(ok ? 'MATCH - replay is identical to the live match' : 'MISMATCH - replay diverged from the live match');
process.exit(ok ? 0 : 1);
