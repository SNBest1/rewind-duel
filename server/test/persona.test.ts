import { describe, expect, it } from 'vitest';
import { observe, type MatchFile } from '@rewind/engine';
import { buildClone } from '../../ai/clone/knn';
import type { TraceLine } from '../../ai/clone/policy';
import { BasicBot, seededRng } from '../ai';
import { blankBrain } from '../brain';
import { MatchRunner } from '../match';
import { PersonaPolicy } from '../persona';

/** A recorded match of a player called "pat", for the clone to learn from. */
function recording(seed: number): MatchFile {
  const runner = new MatchRunner(`pat-${seed}`, seed, ['pat', 'other'], 'duel', undefined, 'valorant');
  const bots = [new BasicBot(0, 'duel', seededRng(seed)), new BasicBot(1, 'duel', seededRng(seed + 1))];
  for (let t = 0; t < 4000 && runner.state.phase !== 'matchEnd'; t++) {
    for (const slot of [0, 1] as const) runner.setInput(slot, bots[slot].act(observe(runner.state, slot)).input);
    runner.tick();
  }
  return runner.toFile();
}

describe('the person + AI hybrid', () => {
  const built = buildClone('pat', [recording(11), recording(12)]);

  it('takes moves from the person out of fights and leaves every fight to the AI', () => {
    const lines: TraceLine[] = [];
    const persona = new PersonaPolicy(built.clone.fresh(), built.limit, 0.5, 0, 'duel', blankBrain('you'), seededRng(3), (t) => lines.push(t));
    const runner = new MatchRunner('t', 77, ['pat', 'you'], 'duel', undefined, 'valorant');
    const rival = new BasicBot(1, 'duel', seededRng(4));
    let personMoves = 0;
    let fights = 0;
    for (let t = 0; t < 3000 && runner.state.phase !== 'matchEnd'; t++) {
      const o = observe(runner.state, 0);
      const d = persona.act(o);
      // A decision copied from the person cites the recorded moments it came from; the AI's cites none.
      if (o.enemy && o.phase === 'live') {
        fights++;
        expect(d.because).toEqual([]);
      } else if (d.because.length) personMoves++;
      runner.setInput(0, d.input);
      runner.setInput(1, rival.act(observe(runner.state, 1)).input);
      runner.tick();
    }
    expect(fights).toBeGreaterThan(0);
    expect(personMoves).toBeGreaterThan(0);
    expect(persona.personTicks).toBe(personMoves);
    // The trace says which half decided, and a copied move names the recorded moment it came from.
    const copied = lines.filter((t) => t.type === 'MIX' && t.actor === 'CLONE');
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((t) => t.ref && t.ref.match.startsWith('pat-'))).toBe(true);
  });

  it('is named for both halves', () => {
    const persona = new PersonaPolicy(built.clone.fresh(), built.limit, 0.5, 0, 'duel', blankBrain('you'));
    expect(persona.name).toMatch(/^pat \(their habits\) \+ AI at /);
  });
});
