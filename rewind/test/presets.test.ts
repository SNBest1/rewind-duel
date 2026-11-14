import { describe, expect, it } from 'vitest';
import { observe, replayMatch, step, IDLE, type Input, type Slot } from '@rewind/engine';
import { buildClone, loadMatches, matchesOf, isSelfMatch, HoldingPolicy } from '@rewind/clone';
import { DEMO_PRESETS, PLANS, evaluatePlans, presetByName } from '@rewind/rewind';

const all = loadMatches();

describe('demo presets', () => {
  it('there are three named presets, each pointing at a real match and a live fork', () => {
    expect(DEMO_PRESETS.length).toBe(3);
    const names = new Set(DEMO_PRESETS.map((p) => p.name));
    expect(names.size).toBe(3); // unique names
    for (const p of DEMO_PRESETS) {
      const file = all.find((m) => m.id === p.matchId);
      expect(file, `preset ${p.name} match exists`).toBeTruthy();
      expect(p.forkTick).toBeGreaterThan(0);
      expect(p.forkTick).toBeLessThan(file!.ticks);
      // the named opponent really holds the other slot
      const oppSlot = (1 - p.human) as Slot;
      expect(file!.players.find((pl) => pl.slot === oppSlot)!.name).toBe(p.opponent);
      // the fork is a live moment
      expect(replayMatch(file!, p.forkTick).phase).toBe('live');
    }
  });

  it('presetByName resolves and is undefined for unknown names', () => {
    expect(presetByName('duel-straight')?.matchId).toBe('1234-1794679679263');
    expect(presetByName('nope')).toBeUndefined();
  });

  it('at each preset fork the opponent clone SEES the player and FIRES over the best-plan rollout', () => {
    for (const p of DEMO_PRESETS) {
      const file = all.find((m) => m.id === p.matchId)!;
      const oppSlot = (1 - p.human) as Slot;
      const built = buildClone(p.opponent, {
        allMatches: all,
        holdOut: matchesOf(all, p.opponent).filter((m) => !isSelfMatch(m)).length > 1 ? [p.matchId] : [],
      });
      const fork = replayMatch(file, p.forkTick);
      const best = evaluatePlans(fork, p.human as Slot, built.guarded)[0];
      const plan = PLANS.find((x) => x.label === best.label)!;
      const held = new HoldingPolicy(built.guarded);
      held.reset();
      let s = JSON.parse(JSON.stringify(fork));
      let saw = 0, fired = 0;
      for (let t = 0; t < 96 && s.phase === 'live'; t++) {
        const o = observe(s, oppSlot);
        if (o.enemy) saw++;
        const oi = held.act(o).input;
        if (oi.fire) fired++;
        const inputs: [Input, Input] = [{ ...IDLE }, { ...IDLE }];
        inputs[p.human] = plan.act(observe(s, p.human as Slot), t);
        inputs[oppSlot] = oi;
        s = step(s, inputs).next;
      }
      // The whole point of these presets: the clone engages (sees and shoots), so the video shows a fight.
      expect(saw, `${p.name} clone sees the player`).toBeGreaterThanOrEqual(8);
      expect(fired, `${p.name} clone fires`).toBeGreaterThanOrEqual(4);
    }
  });
});
