// The rewind opponent as a cross between the real person and the AI (DECISIONS D75).
//
// The k-NN clone alone copies what the person did in similar moments, which is good at their habits (where
// they go, when they walk, when they flash) and bad at the parts a vote over past moments cannot do well:
// it aims by snapping to one of a few offsets, fires when most neighbours fired, and freezes or wanders in a
// moment it has never seen. The AI is the opposite: it fights, paths and tracks you well, but plays nobody.
//
// The persona runs both every tick and takes each part of the input from whichever knows it better:
//   - from the person (the clone): where they go, how they move, when they use utility and where they look
//     while nobody is in sight, whenever the clone is on known ground (nearest recorded moment within its
//     limit) and its neighbours agree;
//   - from the AI: the fight itself (aim, trigger and footwork) at the person's own measured skill, so its
//     reaction time, aim wobble and tracking are theirs; its belief map of where you are and what it learned
//     about you; buying, reloading and switching guns; and everything when the clone is off known ground.
import { IDLE, type Input, type Observation, type Slot } from '@rewind/engine';
import { DECISION_TICKS, MOVES } from '../ai/clone/features';
import type { KnnClone } from '../ai/clone/knn';
import type { Decision, Policy, TraceLine } from '../ai/clone/policy';
import { AiPlayer, type Rng } from './ai';
import type { Brain } from './brain';
import { rankOf } from './ranks';

/** How much the clone's neighbours must agree on a move before the person's choice wins over the AI's. */
export const CALM_AGREE = 0.4;

export class PersonaPolicy implements Policy {
  readonly name: string;
  readonly ai: AiPlayer;
  /** Ticks the person's habits drove the movement, of all ticks played: the share that is really "them". */
  personTicks = 0;
  ticks = 0;
  /** Ticks with the clone off known ground, so the AI played alone (the old circuit breaker). */
  ticksOnBreaker = 0;
  private lastSay = -Infinity;
  private lastSide: 'person' | 'ai' | null = null;

  /**
   * @param clone the person's clone (a fresh one per session)
   * @param limit the clone's known-ground limit (p95 nearest distance on held-out data)
   * @param skill the person's skill, 0 to 1: the AI's aim and reactions are set to it
   * @param knowsYou what the AI has learned about the player it faces (their Brain), for its belief map
   */
  constructor(
    readonly clone: KnnClone, readonly limit: number, readonly skill: number, slot: Slot, mapId: string, knowsYou: Brain,
    rnd: Rng = Math.random, private trace: (t: TraceLine) => void = () => {}, cheap = false,
  ) {
    const rank = rankOf(skill);
    this.ai = new AiPlayer(slot, mapId, knowsYou, `rank:${rank.index}`, rnd);
    // The what-if planner plays 100 futures; the belief map is the costly part, and it adds least in 5 seconds.
    if (cheap) this.ai.useBelief = false;
    this.ai.onTrace = trace;
    this.name = `${clone.player} (their habits) + AI at ${rank.label}`;
  }

  act(o: Observation): Decision {
    // The AI's aim must start each tick where the body really looks, since the person may have turned it.
    this.ai.syncAim(o.self.aim);
    const ai = this.ai.think(o);
    const me = this.clone.act(o);
    this.ticks++;
    const known = this.clone.nearest <= this.limit;
    if (!known) this.ticksOnBreaker++;
    const agree = known ? me.confidence : 0;
    const input: Input = { ...IDLE, ...ai };
    let side: 'person' | 'ai' = 'ai';
    if (o.phase === 'live' && o.self.hp > 0 && o.self.blindTicks === 0) {
      if (!o.enemy && agree >= CALM_AGREE) {
        // Nobody in sight: go where they would go, the way they would, and look where they would look.
        side = 'person';
        input.move = me.input.move;
        input.walk = me.input.walk;
        input.aim = me.input.aim;
        input.smoke = me.input.smoke;
        input.flash = me.input.flash;
        input.dash = me.input.dash;
        input.use = me.input.use;
      }
      // In a fight the AI plays the whole input, at the person's rank. Letting the person's recorded footwork move
      // the body mid-fight was measured and lost most duels (eval/persona-eval.ts, DECISIONS D75).
    }
    if (side === 'person') this.personTicks++;
    this.explain(o, side, known, agree);
    return { input, confidence: side === 'person' ? agree : 1, because: side === 'person' ? me.because : [] };
  }

  /** A trace line when control changes hands, and at most once a second while the person drives. */
  private explain(o: Observation, side: 'person' | 'ai', known: boolean, agree: number): void {
    if (o.tick % DECISION_TICKS !== 0) return;
    const changed = side !== this.lastSide;
    if (!changed && (side === 'ai' || o.tick - this.lastSay < 32)) return;
    this.lastSide = side;
    this.lastSay = o.tick;
    const who = this.clone.player;
    if (side === 'person') {
      const a = this.clone.action;
      const what = MOVES[a.move].x || MOVES[a.move].y ? (a.walk ? 'walks' : 'runs') : 'holds';
      this.trace({
        tick: o.tick, actor: 'CLONE', type: 'MIX',
        reason: `${what} like ${who} (${Math.round(agree * 100)}% of their similar moments agree)`,
      });
    } else {
      this.trace({
        tick: o.tick, actor: 'AI', type: 'MIX',
        reason: o.enemy
          ? `in a fight: the AI aims, shoots and moves at ${who}'s rank (${rankOf(this.skill).label})`
          : known
          ? `${who}'s similar moments disagree (${Math.round(agree * 100)}%), the AI decides at ${rankOf(this.skill).label}`
          : `${who} never showed this situation, the AI plays it at their rank (${rankOf(this.skill).label})`,
      });
    }
  }
}

/** For a person with too few recordings for a clone: the AI alone, at their rank, knowing what it learned about you. */
export class AiAlonePolicy implements Policy {
  readonly name: string;
  readonly ai: AiPlayer;
  constructor(slot: Slot, mapId: string, skill: number, knowsYou: Brain, trace: (t: TraceLine) => void = () => {}, rnd: Rng = Math.random, cheap = false) {
    this.ai = new AiPlayer(slot, mapId, knowsYou, `rank:${rankOf(skill).index}`, rnd);
    if (cheap) this.ai.useBelief = false;
    this.ai.onTrace = trace;
    this.name = `the AI at ${rankOf(skill).label}`;
  }
  act(o: Observation): Decision {
    return { input: this.ai.think(o), confidence: 1, because: [] };
  }
}

/** The person's skill for the persona: their brain's measured level once it has seen a few of their matches. */
export function personSkill(brain: Brain | null): number {
  return brain && brain.matches >= 3 ? brain.skill : 0.45;
}
