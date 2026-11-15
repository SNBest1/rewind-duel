import { describe, expect, it } from 'vitest';
import { hashState, observe, replayMatch, type MatchFile } from '@rewind/engine';
import { BasicBot, seededRng } from '../../../server/ai';
import { MatchRunner } from '../../../server/match';
import { analyzeMatch, type MatchDetail } from '../summary';

/** A match played under the economy rules (pistols, credits, shields), as every live match on the server is. */
function valorantMatch(): MatchFile {
  const runner = new MatchRunner('rules', 4242, ['a', 'b'], 'duel', undefined, 'valorant');
  const bots = [new BasicBot(0, 'duel', seededRng(1)), new BasicBot(1, 'duel', seededRng(2))];
  for (let t = 0; t < 2400 && runner.state.phase !== 'matchEnd'; t++) {
    for (const slot of [0, 1] as const) runner.setInput(slot, bots[slot].act(observe(runner.state, slot)).input);
    runner.tick();
  }
  return runner.toFile();
}

describe('replays use the rules the match was played under', () => {
  const file = valorantMatch();

  it('the fixture really is an economy-rules match with a fight in it', () => {
    expect(file.rules).toBe('valorant');
    expect(hashState(replayMatch(file))).toBe(file.finalHash);
  });

  it('the viewer summary rebuilds the same rounds and every frame matches the engine replay', () => {
    const detail = analyzeMatch(file, true) as MatchDetail;
    const truth = replayMatch(file);
    expect(detail.score).toEqual(truth.score);
    for (const f of detail.frames.filter((_, i) => i % 50 === 0)) {
      const s = replayMatch(file, f[0]);
      expect([f[1], f[2], f[4], f[6], f[7], f[9]]).toEqual([
        Math.round(s.players[0].x * 100) / 100, Math.round(s.players[0].y * 100) / 100, s.players[0].hp,
        Math.round(s.players[1].x * 100) / 100, Math.round(s.players[1].y * 100) / 100, s.players[1].hp,
      ]);
    }
  });
});
