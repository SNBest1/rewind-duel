// The hand-written fallback. No data, no learning: it holds an angle toward the objective, peeks and shoots
// when it can see the enemy, and plants or defuses on its own side. It is the baseline the clone must beat
// in the evals, and the safe hands the circuit breaker falls back to when the clone is lost.
import {
  C, IDLE, getMap,
  type Input, type Observation, type Policy, type Slot, type TraceRef,
} from '@rewind/engine';

const map = getMap('duel');

/** A route from the attacker spawn through mid to each site. The bot walks it toward its objective. */
const TO_A = [{ x: 13, y: 13 }, { x: 31, y: 7 }, { x: 36, y: 6 }];
const TO_B = [{ x: 13, y: 19 }, { x: 31, y: 25 }, { x: 36, y: 26 }];

function stepTowards(from: { x: number; y: number }, to: { x: number; y: number }): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    x: Math.abs(dx) > 0.3 ? (Math.sign(dx) as 1 | -1) : 0,
    y: Math.abs(dy) > 0.3 ? (Math.sign(dy) as 1 | -1) : 0,
  };
}

function inRect(r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Hand-written baseline policy. Deterministic: no RNG, so its contribution to a replay is reproducible. */
export class BasicBot implements Policy {
  readonly name = 'basic-bot';
  private leg = 0;
  private site: 'A' | 'B' = 'A';

  because(): TraceRef[] {
    return []; // the bot cites no recording; its reason is a rule, written on the BREAKER/own line
  }

  /** Forgets route progress so the next decision is independent. Used by one-shot probes. */
  reset(): void {
    this.leg = 0;
    this.site = 'A';
  }

  act(o: Observation): { input: Input; confidence: number; because: TraceRef[] } {
    const self = o.self;
    const attacker = o.attacker === o.slot;
    const input: Input = { ...IDLE };

    // Reload when empty, always.
    if (self.ammo === 0 && self.reloadTicks === 0) input.reload = true;

    if (o.enemy) {
      // Shoot: face the enemy, stop to tighten spread, fire if loaded.
      input.aim = Math.atan2(o.enemy.y - self.y, o.enemy.x - self.x);
      input.move = { x: 0, y: 0 };
      input.walk = true;
      input.fire = self.ammo > 0 && self.reloadTicks === 0;
      return { input, confidence: 1, because: [] };
    }

    // No enemy in sight: move toward the objective and aim where we are going.
    if (attacker && o.spike.state === 'carried') {
      const route = this.site === 'A' ? TO_A : TO_B;
      const target = route[Math.min(this.leg, route.length - 1)];
      if (Math.hypot(target.x - self.x, target.y - self.y) < 0.8 && this.leg < route.length - 1) this.leg++;
      input.move = stepTowards(self, target);
      input.aim = Math.atan2(target.y - self.y, target.x - self.x);
      // Plant once on the site, standing still.
      const site = map.sites[this.site];
      if (inRect(site, self.x, self.y)) {
        input.move = { x: 0, y: 0 };
        input.use = true;
      }
    } else if (attacker && o.spike.state === 'planted') {
      // Hold near the planted spike.
      input.aim = Math.atan2(o.spike.y - self.y, o.spike.x - self.x) + Math.PI;
    } else if (!attacker && o.spike.state === 'planted') {
      // Defender: go to the spike and defuse.
      const d = Math.hypot(self.x - o.spike.x, self.y - o.spike.y);
      if (d <= C.DEFUSE_RANGE) {
        input.move = { x: 0, y: 0 };
        input.use = true;
      } else {
        input.move = stepTowards(self, o.spike);
      }
      input.aim = Math.atan2(o.spike.y - self.y, o.spike.x - self.x);
    } else {
      // Defender with no plant yet: hold an angle toward mid, watching the lane.
      const hold = o.lastSeenEnemy ?? { x: map.width / 2, y: self.y };
      input.aim = Math.atan2(hold.y - self.y, hold.x - self.x);
    }
    return { input, confidence: 1, because: [] };
  }
}
