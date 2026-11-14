import {
  IDLE, distanceField, getMap, navGrid, observe, stepToward,
  type Input, type MatchFile, type Observation, type Slot,
} from '@rewind/engine';
import { seededRng, type Rng } from '../../server/ai';
import { MatchRunner } from '../../server/match';

/**
 * A scripted stand-in for a human with habits of their own. It is deliberately NOT built on the AI bot,
 * so that "the clone copies this player better than the basic bot does" means something.
 */
export type Style = {
  lane: { x: number; y: number }; // waypoint they always rotate through
  site: 'A' | 'B'; // the site they always attack and defend
  hold: { x: number; y: number }; // where they hold on defence
  fight: 'strafe' | 'push' | 'stand';
  walkNearSite: boolean;
};

export const ALICE: Style = { lane: { x: 14, y: 5 }, site: 'A', hold: { x: 38, y: 8.5 }, fight: 'strafe', walkNearSite: true };
export const BOB: Style = { lane: { x: 14, y: 27 }, site: 'B', hold: { x: 33.5, y: 23.5 }, fight: 'push', walkNearSite: false };

export class StylePlayer {
  private grid;
  private fields = new Map<string, Float64Array>();
  private leg = 0;
  private round = 0;
  private strafe: -1 | 1 = 1;

  constructor(readonly slot: Slot, mapId: string, readonly style: Style, private rnd: Rng) {
    this.grid = navGrid(getMap(mapId));
  }

  private toward(o: Observation, p: { x: number; y: number }): Input['move'] {
    const key = `${p.x},${p.y}`;
    let f = this.fields.get(key);
    if (!f) this.fields.set(key, (f = distanceField(this.grid, p.x, p.y)));
    return stepToward(this.grid, f, o.self.x, o.self.y);
  }

  think(o: Observation): Input {
    const input: Input = { ...IDLE, move: { x: 0, y: 0 }, aim: o.self.aim };
    if (o.phase !== 'live' || o.self.hp <= 0) return input;
    if (o.round !== this.round) {
      this.round = o.round;
      this.leg = 0;
    }
    const map = getMap(o.mapId);
    const r = map.sites[this.style.site];
    const site = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (o.enemy) {
      input.aim = Math.atan2(o.enemy.y - o.self.y, o.enemy.x - o.self.x) + (this.rnd() - 0.5) * 0.08;
      input.fire = o.self.ammo > 0;
      input.reload = o.self.ammo === 0;
      if (this.style.fight === 'strafe') {
        if (o.tick % 12 === 0) this.strafe = this.strafe === 1 ? -1 : 1;
        input.move = { x: 0, y: this.strafe };
        input.walk = true;
      } else if (this.style.fight === 'push') {
        input.move = this.toward(o, o.enemy);
      }
      return input;
    }
    const attacking = o.attacker === o.slot;
    let goal: { x: number; y: number };
    if (attacking) {
      if (o.spike.state === 'planted') goal = { x: o.spike.x - 4, y: o.spike.y };
      else goal = this.leg === 0 ? this.style.lane : site;
      if (this.leg === 0 && Math.hypot(o.self.x - this.style.lane.x, o.self.y - this.style.lane.y) < 1) this.leg = 1;
    } else {
      goal = o.spike.state === 'planted' ? o.spike : this.style.hold;
    }
    input.move = this.toward(o, goal);
    input.aim = Math.atan2(goal.y - o.self.y, goal.x - o.self.x);
    const nearSite = Math.hypot(o.self.x - site.x, o.self.y - site.y) < 10;
    input.walk = this.style.walkNearSite && nearSite;
    const inSite = o.self.x >= r.x && o.self.x <= r.x + r.w && o.self.y >= r.y && o.self.y <= r.y + r.h;
    if (attacking && o.spike.state === 'carried' && inSite && Math.hypot(o.self.x - site.x, o.self.y - site.y) < 2) {
      input.move = { x: 0, y: 0 };
      input.use = true;
    }
    if (!attacking && o.spike.state === 'planted' && Math.hypot(o.self.x - o.spike.x, o.self.y - o.spike.y) < 1.2) {
      input.move = { x: 0, y: 0 };
      input.use = true;
    }
    if (!attacking && o.spike.state !== 'planted' && Math.hypot(o.self.x - goal.x, o.self.y - goal.y) < 0.7) {
      input.move = { x: 0, y: 0 };
      // Hold the angle toward where attackers come from.
      input.aim = Math.atan2(16 - o.self.y, 20 - o.self.x);
    }
    // A little human noise: a random step now and then.
    if (this.rnd() < 0.06) input.move = { x: (Math.floor(this.rnd() * 3) - 1) as -1 | 0 | 1, y: (Math.floor(this.rnd() * 3) - 1) as -1 | 0 | 1 };
    return input;
  }
}

/** A recorded match between two scripted players with their own habits, standing in for two humans. */
export function recordedMatch(id: string, seed: number, styles: [Style, Style] = [ALICE, BOB], names: [string, string] = ['alice', 'bob']): MatchFile {
  const mapId = 'duel';
  const runner = new MatchRunner(id, seed, names, mapId);
  const players = [0, 1].map((slot) => new StylePlayer(slot as Slot, mapId, styles[slot], seededRng(seed * 7 + slot)));
  for (let t = 0; t < 40000 && runner.state.phase !== 'matchEnd'; t++) {
    for (const p of players) runner.setInput(p.slot, p.think(observe(runner.state, p.slot)));
    runner.tick();
  }
  // Through JSON, like a file on disk.
  return JSON.parse(JSON.stringify(runner.toFile()));
}
