// The fire-gap test the user asked for: run the FACTORED clone live through a scripted engagement where
// the enemy stays in sight, and assert its fire-when-seen rate is close to its eval fire recall. This
// guards the fix for the 79%-eval / 19%-what-if discrepancy: in a head-on fight (the same kind of context
// the eval measures), the clone must actually shoot, not re-roll a no-fire every tick.
//
// The remaining what-if gap is NOT a bug — it is the clone driven into off-distribution positions by the
// dodging plans, where it has few same-visibility neighbors. This test isolates the engagement case so a
// real regression in the live fire path (no hold, breaker blocking fire, reload loop) would fail it.
import { describe, expect, it } from 'vitest';
import { createMatch, observe, step, IDLE, type Input, type Slot } from '@rewind/engine';
import {
  buildClone, loadMatches, matchesOf, isSelfMatch, HoldingPolicy, slotOf,
} from '@rewind/clone';
import { cloneAccuracy } from '../metrics';

/** Puts the two players in open sight of each other in mid, then runs the opponent policy for `ticks`. */
function liveFireWhenSeen(seed: number, map: string, policy: { act(o: any): { input: Input }; reset?(): void }, ticks = 96): { saw: number; fired: number; rate: number } {
  let s = createMatch(seed, map);
  s.players[0].x = 22; s.players[0].y = 16; s.players[0].aim = 0;
  s.players[1].x = 27; s.players[1].y = 16; s.players[1].aim = Math.PI;
  policy.reset?.();
  let saw = 0, fired = 0;
  for (let t = 0; t < ticks && s.phase === 'live'; t++) {
    const o = observe(s, 1);
    if (o.enemy) saw++;
    const inp = policy.act(o).input;
    if (inp.fire) fired++;
    const inputs: [Input, Input] = [{ ...IDLE }, inp];
    s = step(s, inputs).next;
  }
  return { saw, fired, rate: saw ? fired / saw : 0 };
}

describe('fire gap — live engagement vs eval recall', () => {
  const all = loadMatches().filter((m) => !m.players.some((p) => ['alpha', 'bravo', 'p1', 'p2'].includes(p.name)) && !isSelfMatch(m));

  // Use a player whose clone has real firing data. Bots fire a lot, so bot-one is the stable fixture here;
  // a human with little firing data would make the bound meaningless (that is the data problem, not a bug).
  const player = 'bot-one';
  const mine = matchesOf(all, player).filter((m) => !isSelfMatch(m));

  it('the clone fires live at a rate close to its eval fire recall (within 25 points)', () => {
    expect(mine.length).toBeGreaterThanOrEqual(2);
    const held = mine[0];
    const built = buildClone(player, { allMatches: all, holdOut: [held.id] });
    const slot = slotOf(held, player) as Slot;

    const acc = cloneAccuracy(held, slot, built.guardedFactored);
    const evalRecall = acc.fireVisible.recall;

    const live = liveFireWhenSeen(held.seed, held.map, new HoldingPolicy(built.guardedFactored));

    // The clone must actually shoot in a head-on fight: not near zero, and in the ballpark of eval recall.
    expect(live.saw).toBeGreaterThan(10); // the engagement really did keep the enemy visible
    expect(live.rate).toBeGreaterThan(0.3); // it is NOT passive when it can see the enemy
    expect(Math.abs(live.rate - evalRecall)).toBeLessThan(0.25); // close to its eval recall
  });

  it('holding changes how often fire persists but never makes a firing clone silent', () => {
    const held = mine[0];
    const built = buildClone(player, { allMatches: all, holdOut: [held.id] });
    const heldRate = liveFireWhenSeen(held.seed, held.map, new HoldingPolicy(built.guardedFactored)).rate;
    const rawRate = liveFireWhenSeen(held.seed, held.map, built.guardedFactored).rate;
    expect(heldRate).toBeGreaterThan(0.3);
    expect(rawRate).toBeGreaterThan(0.3);
  });
});
