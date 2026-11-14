import { describe, expect, it } from 'vitest';
import { hashState, rand, replayMatch } from '@rewind/engine';
import { MatchRunner, sanitizeInput } from '../match';

describe('MatchRunner', () => {
  it('writes a match file that replays to the live hash', () => {
    const runner = new MatchRunner('t', 777, ['a', 'b']);
    const r = { rng: 5 };
    for (let t = 0; t < 3000; t++) {
      // Inputs change at irregular ticks, as they do from real clients, and go through JSON like the file does.
      if (rand(r) < 0.2) {
        const slot = rand(r) < 0.5 ? 0 : 1;
        runner.setInput(slot, {
          move: { x: Math.floor(rand(r) * 3) - 1, y: Math.floor(rand(r) * 3) - 1 },
          walk: rand(r) < 0.3, aim: rand(r) * 6 - 3, fire: rand(r) < 0.5,
          reload: rand(r) < 0.1, smoke: rand(r) < 0.1, dash: rand(r) < 0.1, use: rand(r) < 0.2,
        });
      }
      runner.tick();
    }
    const file = JSON.parse(JSON.stringify(runner.toFile()));
    expect(file.ticks).toBe(3000);
    expect(file.inputs.length).toBeLessThan(3000); // delta-encoded, not one entry per tick
    expect(hashState(replayMatch(file))).toBe(file.finalHash);
  });

  it('sanitizes malformed input', () => {
    expect(sanitizeInput({ move: { x: 9, y: 'a' }, aim: 'NaN', fire: 1 })).toEqual({
      move: { x: 0, y: 0 }, walk: false, aim: 0, fire: false, reload: false, smoke: false, dash: false, use: false, flash: false,
    });
    expect(sanitizeInput(null).move).toEqual({ x: 0, y: 0 });
  });
});
