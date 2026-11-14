import { describe, expect, it, vi } from 'vitest';
import { MAP_IDS, hashState, observe, replayMatch, type GameEvent } from '@rewind/engine';
import { AiPlayer, seededRng } from '../ai';
import { Trainer, blankBrain, summarize } from '../brain';
import { MatchRunner } from '../match';
import type { TraceLine } from '../../clone/policy';

// Each test plays one or more full matches with two thinking bots: seconds, not milliseconds.
vi.setConfig({ testTimeout: 60_000 });

/** Two bots play a whole match through the real MatchRunner. Slot 0 is studied as if it were the human. */
function botMatch(mapId: string, skill0 = 0.75, skill1 = 0.75) {
  const runner = new MatchRunner('t', 4242, ['a', 'b'], mapId);
  // A brain is what one bot knows about its opponent, and its skill is that bot's skill.
  const brain1 = blankBrain('one'); // slot 0's knowledge of slot 1
  brain1.skill = skill0;
  const brain0 = blankBrain('zero'); // slot 1's knowledge of slot 0, trained live below
  brain0.skill = skill1;
  // Seeded, so every run of this test plays the exact same match.
  const bots = [new AiPlayer(0, mapId, brain1, 'adaptive', seededRng(11)), new AiPlayer(1, mapId, brain0, 'adaptive', seededRng(22))];
  const trainer = new Trainer(brain0, 0, 1, false);
  const trace: TraceLine[] = [];
  bots[1].onTrace = (t) => trace.push(t);
  const events: GameEvent[] = [];
  let ticks = 0;
  while (runner.state.phase !== 'matchEnd' && ticks < 40000) {
    for (const b of bots) runner.setInput(b.slot, b.think(observe(runner.state, b.slot)));
    const ev = runner.tick();
    trainer.observe(runner.state, ev);
    events.push(...ev);
    ticks++;
  }
  return { runner, events, brain0, trace };
}

describe('AI', () => {
  // A 1v1 round ends at the first kill, so on a map where the bots meet in mid (Trident's B lane) a whole match
  // can go by without a plant. Plants are therefore checked across all maps, not per map.
  let totalPlants = 0;
  let totalFlashes = 0;
  for (const mapId of MAP_IDS) {
    it(`plays a full match on ${mapId}: fights and flashes`, () => {
      const { runner, events, brain0 } = botMatch(mapId);
      expect(runner.state.phase).toBe('matchEnd');
      const reasons = events.filter((e) => e.type === 'roundEnd').map((e) => (e as { reason: string }).reason);
      const kills = events.filter((e) => e.type === 'kill').length;
      const flashes = events.filter((e) => e.type === 'flash').length;
      const plants = events.filter((e) => e.type === 'plant').length;
      // eslint-disable-next-line no-console
      console.log(mapId, { rounds: reasons.length, reasons: reasons.join(','), kills, plants, flashes, blinded: events.filter((e) => e.type === 'blinded').length });
      expect(kills).toBeGreaterThan(reasons.length / 2); // most rounds have a real fight
      // With one-tap rifles some maps' fights end before anyone needs a flash, so flashes are counted across maps.
      totalFlashes += flashes;
      totalPlants += plants;
      expect(brain0.rounds).toBe(reasons.length);
      // The bot's inputs went through the log like a human's: the match still replays exactly.
      const file = JSON.parse(JSON.stringify(runner.toFile()));
      expect(hashState(replayMatch(file))).toBe(file.finalHash);
    });
  }

  it('plants the spike on some maps', () => {
    expect(totalPlants).toBeGreaterThan(MAP_IDS.length);
  });

  it('throws flashes across the maps', () => {
    expect(totalFlashes).toBeGreaterThan(MAP_IDS.length);
  });

  it('buys guns, lands headshots, and calls the human\'s play', () => {
    const { events, trace } = botMatch('duel');
    expect(events.some((e) => e.type === 'buy')).toBe(true);
    expect(events.some((e) => e.type === 'shot' && e.head)).toBe(true);
    expect(trace.some((t) => t.type === 'CALL')).toBe(true);
  });

  it('learns which site you attack, and says what it planned each round', () => {
    const { brain0, trace, events } = botMatch('trident');
    const sites = brain0.maps.trident.attackSites;
    expect(Object.values(sites).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(summarize(brain0).rounds).toBe(brain0.rounds);
    const rounds = events.filter((e) => e.type === 'roundStart').length + 1;
    expect(trace.filter((t) => t.type === 'PLAN')).toHaveLength(rounds);
    // Once it has seen you attack, the defence plan cites the counts.
    expect(trace.some((t) => t.type === 'PLAN' && /you attacked [ABC] \d+x/.test(t.reason))).toBe(true);
  });

  it('a strong bot beats a weak one', () => {
    let strong = 0;
    let weak = 0;
    for (const mapId of ['duel', 'courtyard']) {
      const { runner } = botMatch(mapId, 1, 0.1);
      strong += runner.state.score[0];
      weak += runner.state.score[1];
    }
    expect(strong).toBeGreaterThan(weak);
  });
});
