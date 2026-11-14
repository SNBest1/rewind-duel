// Writes three recorded matches between two SCRIPTED players, "demo-alice" and "demo-bob", into data/.
// They have fixed habits (alice: top lane, site A, strafes; bob: bottom lane, site B, pushes), so the clone
// has something clear to copy. Use for a demo when there are no real recordings yet, and say that they are scripted.
// Run with: npm run demo:data
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALICE, BOB, recordedMatch } from '../ai/clone/test/fixtures';

const DATA = process.env.DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(DATA, { recursive: true });
const base = Date.now();
for (let i = 0; i < 3; i++) {
  const id = `demo-${base + i}`;
  const file = recordedMatch(id, 1000 + i, [ALICE, BOB], ['demo-alice', 'demo-bob']);
  writeFileSync(`${DATA}/${id}.json`, JSON.stringify(file));
  console.log(`wrote data/${id}.json: ${file.ticks} ticks, ${file.inputs.length} input changes`);
}
