// Fails if engine/ uses a non-deterministic call. Run with: npm run check:determinism
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BANNED = ['Math.random', 'Date.now'];
// fileURLToPath handles Windows drive letters; `.pathname` leaves a leading
// slash ("/C:/...") that breaks path joins on Windows.
const root = fileURLToPath(new URL('../engine/', import.meta.url));
const bad = [];

for (const name of readdirSync(root, { recursive: true })) {
  if (!name.endsWith('.ts')) continue;
  readFileSync(join(root, name), 'utf8').split('\n').forEach((line, i) => {
    for (const call of BANNED) {
      if (line.includes(call)) bad.push(`engine/${name}:${i + 1}: ${call}`);
    }
  });
}

if (bad.length) {
  console.error('Non-deterministic calls in engine/:\n' + bad.join('\n'));
  process.exit(1);
}
console.log('check:determinism OK - no Math.random or Date.now in engine/');
