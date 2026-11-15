// The AI opponent. It plays through the same door as a human: each tick it gets observe() for its own slot
// (fog of war, blindness and all) and returns an Input. What makes it yours is the Brain it reads:
// which site you favour, where you stand, where you kill it from, and how often you dodge its flashes.
import {
  BUY_TICKS, C, IDLE, NO_WEAPON, SHIELDS, WEAPONS, angleDiff, cachedField, cellCenter, distanceField, getMap, navGrid, nearestFree, sightBlocked, stepToward, weapon,
  type GameMap, type Input, type NavGrid, type Observation, type Slot,
} from '@rewind/engine';
import type { Decision, Policy, TraceLine } from '../ai/clone/policy';
import { Belief } from './belief';
import { heatCenter, mapMemory, type Brain, type MapMemory } from './brain';
import { RANK_STEPS, rankOf, skillOfRank } from './ranks';

/** 'adaptive' (ranked: follows you), a named level, or a fixed rank step like 'rank:9' (Gold 1). */
export type Difficulty = 'adaptive' | 'easy' | 'normal' | 'hard' | 'insane' | `rank:${number}`;
export const DIFFICULTIES: Difficulty[] = ['adaptive', 'easy', 'normal', 'hard', 'insane'];
const FIXED_SKILL: Record<'easy' | 'normal' | 'hard' | 'insane', number> = { easy: 0.1, normal: 0.4, hard: 0.7, insane: 1 };

/** Reads a difficulty from untrusted input. Anything unknown is adaptive. */
export function parseDifficulty(raw: unknown): Difficulty {
  if (typeof raw !== 'string') return 'adaptive';
  if ((DIFFICULTIES as string[]).includes(raw)) return raw as Difficulty;
  const m = /^rank:(\d{1,2})$/.exec(raw);
  if (m && Number(m[1]) < RANK_STEPS) return `rank:${Number(m[1])}`;
  return 'adaptive';
}

const gunId = (name: string) => WEAPONS.findIndex((w) => w.name === name);
const [GHOST, SHERIFF, SPECTRE, JUDGE, BULLDOG, PHANTOM, VANDAL, OPERATOR] =
  ['Ghost', 'Sheriff', 'Spectre', 'Judge', 'Bulldog', 'Phantom', 'Vandal', 'Operator'].map(gunId);
const LIGHT = 100;
const HEAVY = 101;

function skillFor(d: Difficulty, brain: Brain): number {
  if (d === 'adaptive') return brain.skill;
  if (d.startsWith('rank:')) return skillOfRank(Number(d.slice(5)));
  return FIXED_SKILL[d as keyof typeof FIXED_SKILL];
}

type P = { x: number; y: number };

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const angleTo = (a: P, b: P) => Math.atan2(b.y - a.y, b.x - a.x);
/** A source of numbers in [0, 1). Math.random in play; a seeded one in tests, so a bot match is repeatable. */
export type Rng = () => number;

/** Seeded mulberry32, for repeatable bots. */
export function seededRng(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal noise in [-3, 3] standard deviations. */
const gauss = (rnd: Rng) => (rnd() + rnd() + rnd() - 1.5) * 2;

function weightedPick<T>(rnd: Rng, items: T[], weight: (t: T) => number): T {
  const ws = items.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export class AiPlayer {
  skill: number;
  private map: GameMap;
  private grid: NavGrid;
  private mem: MapMemory;

  // Tuning derived from skill.
  private reactTicks: number;
  private aimErr: number; // radians, standard deviation
  private track: number; // fraction of the aim error closed per tick
  private dodgeChance: number;
  private learn: number; // how hard it leans on what it learned about you

  // Per-round plan.
  private round = -1;
  private targetSite = 'A';
  private holdSpot: P | null = null;
  private watchPoint: P | null = null;
  private plantSpot: P | null = null;
  private postPlantSpot: P | null = null;
  private siteFlashUsed = false;

  // Per-tick memory.
  private aim = 0;
  private errOffset = 0;
  private sawEnemyLastTick = false;
  private reaction = 0;
  private lastKnown: (P & { tick: number }) | null = null;
  private lastFlashTick = -999;
  private dodgeFor = new Set<string>(); // enemy flashes this bot decided to turn away from (keyed by rough origin)
  private ignoreFor = new Set<string>();
  private lastPos: P = { x: 0, y: 0 };
  private stuckTicks = 0;
  /** Where it thinks you are: a probability map updated every tick from its own observation. */
  readonly belief: Belief;
  private rotations = 0;
  private prevEnemy: (P & { tick: number }) | null = null;
  private lastHearSay = -999;
  private lastBeliefSay = -999;
  private unstick: { x: -1 | 0 | 1; y: -1 | 0 | 1; ticks: number } | null = null;

  /** Switch off the belief map (tracking, belief pre-aim, belief flashes, rotates) to measure what it adds. */
  useBelief = true;

  constructor(readonly slot: Slot, mapId: string, readonly brain: Brain, readonly difficulty: Difficulty, private rnd: Rng = Math.random) {
    this.map = getMap(mapId);
    this.grid = navGrid(this.map);
    this.mem = mapMemory(brain, mapId);
    this.skill = 0;
    this.reactTicks = this.aimErr = this.track = this.dodgeChance = this.learn = 0;
    this.tune();
    this.belief = new Belief(mapId, this.mem, this.learn);
  }

  /** Sets reaction, aim and judgement from the current skill. Adaptive bots re-tune every round. */
  private tune(): void {
    const s = skillFor(this.difficulty, this.brain);
    this.skill = s;
    // At the bottom it is genuinely beatable: almost a second to react, 9 degrees of wobble, slow to track, rarely
    // dodges. Aim improves on a curve that is steeper at the low end, so Iron vs Bronze is a real difference too.
    // Even the top rank waits 375 ms after first seeing you before it may fire: a human-speed reaction plus the
    // network round trip, so the player always has a window to react (DECISIONS D73).
    const a = Math.sqrt(s);
    this.reactTicks = Math.round(30 - 18 * a); // 940 ms down to 375 ms
    this.aimErr = ((10 - 9.2 * a) * Math.PI) / 180;
    this.track = 0.12 + 0.7 * a;
    this.dodgeChance = 0.05 + 0.8 * s;
    this.learn = 0.3 + 0.7 * s;
  }

  private field(to: P): Float64Array {
    // Shared across every bot in the process (a bounded cache in the engine), so a new bot costs no path searches.
    return cachedField(this.grid, to.x, to.y);
  }

  private clear(a: P, b: P, smokes: Observation['smokes'] = []): boolean {
    return !sightBlocked(this.map.walls, smokes, a.x, a.y, b.x, b.y);
  }

  /** Free nav cells inside a rect, grown by `margin`. */
  private cellsIn(r: { x: number; y: number; w: number; h: number }, margin = 0): P[] {
    const out: P[] = [];
    for (let c = 0; c < this.grid.free.length; c++) {
      if (!this.grid.free[c]) continue;
      const p = cellCenter(this.grid, c);
      if (p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin) out.push(p);
    }
    return out;
  }

  /** Walk back from `site` toward the attacker spawn and return the point where the attacker comes in. */
  private entranceOf(site: P): P {
    const f = this.field(this.map.spawns.attacker);
    let p = cellCenter(this.grid, nearestFree(this.grid, site.x, site.y));
    for (let i = 0; i < 80; i++) {
      const m = stepToward(this.grid, f, p.x, p.y);
      if (m.x === 0 && m.y === 0) break;
      p = { x: p.x + m.x * 0.5, y: p.y + m.y * 0.5 };
      if (dist(p, site) > 8) break;
    }
    return p;
  }

  private siteCenter(label: string): P {
    const r = this.map.sites[label];
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** Receives one line every time the bot makes a decision worth explaining. */
  onTrace: (t: TraceLine) => void = () => {};
  private say(o: Observation, type: string, reason: string): void {
    this.onTrace({ tick: o.tick, actor: 'AI', type, reason });
  }

  private planRound(o: Observation): void {
    this.round = o.round;
    const before = this.skill;
    this.tune();
    if (this.difficulty === 'adaptive' && o.round > 1 && Math.abs(this.skill - before) > 0.001) {
      const a = rankOf(before).label;
      const b = rankOf(this.skill).label;
      this.say(o, 'SKILL', `${a === b ? b : `${a} → ${b}`} (${Math.round(before * 100)} → ${Math.round(this.skill * 100)}): ${this.skill > before ? 'you won that round, I sharpen up' : 'you lost that round, I ease off'}`);
    }
    this.planBuy(o);
    this.prediction = null;
    this.predicted = false;
    this.holdSpot = this.watchPoint = this.plantSpot = this.postPlantSpot = null;
    this.siteFlashUsed = false;
    this.lastKnown = null;
    this.dodgeFor.clear();
    this.ignoreFor.clear();
    this.rotations = 0;
    this.prevEnemy = null;
    const labels = Object.keys(this.map.sites);
    const attacking = o.attacker === this.slot;
    this.belief.reset(this.map.spawns[attacking ? 'defender' : 'attacker']);
    if (attacking) {
      // Hit the site you defend least. Without data, or at low skill, it is closer to a coin flip.
      this.setAttackSite(weightedPick(this.rnd, labels, (l) => 1 / Math.pow(1 + (this.mem.defendSites[l] ?? 0), this.learn)));
      const seen = labels.reduce((a, l) => a + (this.mem.defendSites[l] ?? 0), 0);
      this.say(o, 'PLAN', seen
        ? `attack ${this.targetSite}: you defended ${labels.map((l) => `${l} ${this.mem.defendSites[l] ?? 0}x`).join(', ')}`
        : `attack ${this.targetSite}: no data on your defence yet, so a guess`);
    } else {
      // Hold the site you attack most.
      this.setDefendSite(o, weightedPick(this.rnd, labels, (l) => Math.pow(1 + (this.mem.attackSites[l] ?? 0), 1 + 2 * this.learn)));
      const seen = labels.reduce((a, l) => a + (this.mem.attackSites[l] ?? 0), 0);
      this.say(o, 'PLAN', seen
        ? `hold ${this.targetSite}: you attacked ${labels.map((l) => `${l} ${this.mem.attackSites[l] ?? 0}x`).join(', ')}`
        : `hold ${this.targetSite}: no data on your attacks yet, so a guess`);
    }
  }

  // --- guns -----------------------------------------------------------------------------------------

  /** What to buy this round. Better ranks buy better guns, and the top ranks counter what you use. */
  private buyQueue: number[] = [];
  private lastSwapSay = -999;
  private lastPrefire = -999;

  /** The rifle it prefers this round, counter-buying your favourite gun at the higher ranks. */
  private pickRifle(o: Observation): { id: number; why: string } {
    const s = this.skill;
    const yours = Object.entries(this.brain.weapons ?? {}).sort((a, b) => b[1] - a[1])[0];
    const favourite = yours && yours[1] >= 2 ? Number(yours[0]) : null;
    if (s > 0.55 && favourite === OPERATOR) return { id: PHANTOM, why: 'you keep using the Operator, so I go silent with the Phantom and close the distance' };
    if (s > 0.55 && favourite === PHANTOM) return { id: VANDAL, why: 'you love the Phantom up close, so I take the Vandal and fight you at range' };
    if (s > 0.55 && (favourite === SPECTRE || favourite === JUDGE)) return { id: VANDAL, why: 'you rush with close-range guns, so I hold long angles with a Vandal' };
    void o;
    return { id: this.rnd() < 0.5 ? PHANTOM : VANDAL, why: '' };
  }

  /**
   * What to buy this round. Classic rules are free. VALORANT rules follow the economy the way players do:
   * pistol rounds, full buys (rifle + heavy shields at 3900), force buys, and saving when broke.
   */
  private planBuy(o: Observation): void {
    const s = this.skill;
    if (o.rules === 'classic') {
      const r = s < 0.15 ? { id: 0, why: '' } : this.pickRifle(o);
      this.buyQueue = [r.id, s > 0.5 ? SHERIFF : 1];
      if (r.why) this.say(o, 'BUY', `${WEAPONS[r.id].name}: ${r.why}`);
      return;
    }
    let c = o.self.credits;
    const queue: number[] = [];
    const buy = (id: number) => {
      const price = id in SHIELDS ? SHIELDS[id].price : WEAPONS[id].price;
      if (price > c) return false;
      queue.push(id);
      c -= price;
      return true;
    };
    const hasRifle = o.self.primary !== NO_WEAPON;
    const pistolRound = o.round === 1 || o.round === C.SWAP_AFTER_ROUND + 1;
    let plan: string;
    if (pistolRound) {
      // 800 credits. Better players take a Ghost or Sheriff; others shields and the Classic.
      if (s > 0.7) buy(SHERIFF);
      else if (s > 0.35) buy(GHOST), buy(LIGHT);
      else buy(LIGHT);
      plan = 'pistol round';
    } else if (hasRifle) {
      // Survived with a gun: top up shields and keep the rest.
      buy(HEAVY) || buy(LIGHT);
      plan = `kept my ${WEAPONS[o.self.primary].name}`;
    } else if (c >= 3900) {
      const op = s > 0.6 && o.attacker !== this.slot && c >= 5700 && this.rnd() < 0.25;
      const r = op ? { id: OPERATOR, why: 'holding this site with an Operator' } : this.pickRifle(o);
      buy(r.id);
      buy(HEAVY);
      if (s > 0.5 && c >= 800) buy(SHERIFF);
      plan = `full buy (${WEAPONS[r.id].name})`;
      if (r.why) this.say(o, 'BUY', `${WEAPONS[r.id].name}: ${r.why}`);
    } else if (c >= 2000) {
      // Matches here are first to 5, so a saved round is a lost round: everyone forces. Better players pick
      // the gun that wins this fight (a Bulldog to fight at range, a Spectre to run and gun up close).
      buy(c >= 2450 && s > 0.3 ? BULLDOG : SPECTRE);
      buy(LIGHT);
      plan = 'force buy';
    } else {
      // Broke: an eco round. Good players still take a pistol that can one-tap, and some shields.
      if (s > 0.5) buy(SHERIFF) || buy(GHOST);
      else if (s > 0.25) buy(GHOST);
      buy(LIGHT);
      plan = 'eco';
    }
    this.buyQueue = queue;
    this.say(o, 'ECON', `${o.self.credits} credits: ${plan}${queue.length ? ` (${queue.map((id) => (id in SHIELDS ? SHIELDS[id].name : WEAPONS[id].name)).join(', ')})` : ''}`);
  }

  /** The gun in hand. */
  private gun(o: Observation) {
    return weapon(o.self.equipped === 0 && o.self.primary !== NO_WEAPON ? o.self.primary : o.self.secondary);
  }

  // --- reads: calling your play before you make it ------------------------------------------------

  /** This round's call, made once from the belief map, checked by the server when the round ends. */
  prediction: { site: string; p: number; attacking: boolean; tick: number } | null = null;
  private predicted = false;

  /**
   * A read blends two things: live evidence (where the belief map puts you right now) and history (which site
   * you usually pick on this side). With no history it is belief alone. It calls once it is fairly sure, or at
   * 8 seconds with its best guess, and never after it has seen you: the point is calling it blind.
   */
  private considerCall(o: Observation): void {
    if (this.predicted || !this.useBelief || o.enemy || o.spike.state !== 'carried') return;
    const elapsed = C.ROUND_TICKS - o.roundTicksLeft;
    if (elapsed < 96) return;
    const humanAttacking = o.attacker !== this.slot;
    const labels = Object.keys(this.map.sites);
    const hist = humanAttacking ? this.mem.attackSites : this.mem.defendSites;
    const histTotal = labels.reduce((a, l) => a + (hist[l] ?? 0), 0);
    const massTotal = labels.reduce((a, l) => a + (this.belief.siteMass[l] ?? 0), 0) || 1;
    const w = histTotal >= 2 ? 0.4 : 0;
    const score = labels.map((l) => [l, (1 - w) * ((this.belief.siteMass[l] ?? 0) / massTotal) + w * ((hist[l] ?? 0) / Math.max(1, histTotal))] as const)
      .sort((a, b) => b[1] - a[1]);
    const [site, p] = score[0];
    const sureEnough = p >= 0.55 || (elapsed >= 256 && p > 1 / labels.length + 0.08);
    if (!sureEnough) return;
    this.predicted = true;
    this.prediction = { site, p, attacking: humanAttacking, tick: o.tick };
    const why = w ? `from where I think you are and ${histTotal} past rounds` : 'from where I think you are';
    this.say(o, 'CALL', humanAttacking
      ? `calling it: you are hitting ${site}, ${Math.round(p * 100)}% (${why}), before I have seen you`
      : `calling it: you are holding ${site}, ${Math.round(p * 100)}% (${why})`);
  }

  private setAttackSite(label: string): void {
    this.targetSite = label;
    this.postPlantSpot = null;
    const cells = this.cellsIn(this.map.sites[label], -0.5);
    const center = this.siteCenter(label);
    // Plant somewhere deep in the site but not dead centre, so it is not a free pre-aim.
    this.plantSpot = cells.length ? weightedPick(this.rnd, cells, (p) => 1 / (1 + Math.abs(dist(p, center) - 2))) : center;
  }

  private setDefendSite(o: Observation, label: string): void {
    this.targetSite = label;
    const center = this.siteCenter(label);
    const entrance = this.entranceOf(center);
    // Learned pre-aim: if you have killed it from near this site before, watch that spot instead.
    const learned = this.learnedAngle(center, 14);
    this.watchPoint = learned ?? entrance;
    if (learned) this.say(o, 'PREAIM', `watching (${learned.x}, ${learned.y}): you have killed me from there before`);
    const candidates = this.cellsIn(this.map.sites[label], 2).filter((p) => {
      const d = dist(p, this.watchPoint!);
      return d >= 5 && d <= 16 && this.clear(p, this.watchPoint!);
    });
    this.holdSpot = candidates.length
      ? weightedPick(this.rnd, candidates, (p) => {
          // Prefer off-angles: far from the entrance, tucked against cover.
          const cover = this.nearWall(p) ? 2 : 1;
          return cover * Math.pow(dist(p, this.watchPoint!), 1.5);
        })
      : center;
  }

  /**
   * Reads the belief map for a rotate. Defender: if it is confident you are hitting another site, go there.
   * Attacker: if it is confident you are sitting on its target, hit the other one instead.
   */
  private considerRotate(o: Observation, attacking: boolean): void {
    if (!this.useBelief || this.rotations >= 2 || this.skill < 0.3 || o.spike.state !== 'carried') return;
    if (o.tick % 16 !== 0) return;
    const mass = this.belief.siteMass;
    const labels = Object.keys(mass);
    if (labels.length < 2) return;
    const sure = 0.75 - 0.15 * this.skill; // a sharper bot acts on less certainty
    if (!attacking) {
      const [best, p] = labels.map((l) => [l, mass[l]] as const).sort((a, b) => b[1] - a[1])[0];
      if (best !== this.targetSite && p > sure) {
        this.rotations++;
        const from = this.targetSite;
        this.setDefendSite(o, best);
        this.say(o, 'ROTATE', `${Math.round(p * 100)}% sure you are on ${best}, leaving ${from}`);
      }
    } else if (o.roundTicksLeft > 30 * 32 && mass[this.targetSite] > sure) {
      const others = labels.filter((l) => l !== this.targetSite).sort((a, b) => mass[a] - mass[b]);
      this.rotations++;
      const from = this.targetSite;
      this.setAttackSite(others[0]);
      this.say(o, 'ROTATE', `${Math.round(mass[from] * 100)}% sure you are holding ${from}, hitting ${others[0]} instead`);
    }
  }

  private nearWall(p: P): boolean {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = nearestFree(this.grid, p.x + dx * 0.9, p.y + dy * 0.9);
      const q = cellCenter(this.grid, c);
      if (dist(q, { x: p.x + dx * 0.9, y: p.y + dy * 0.9 }) > 0.3) return true;
    }
    return false;
  }

  /** The hottest spot you have killed it from (or stood a lot) within `radius` of `around`, if any. */
  private learnedAngle(around: P, radius: number): P | null {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < this.mem.heat.length; i++) {
      const score = this.mem.killSpots[i] * 4 + this.mem.heat[i] * 0.15;
      if (score <= bestScore) continue;
      if (dist(heatCenter(i), around) > radius) continue;
      best = i;
      bestScore = score;
    }
    if (best < 0 || bestScore < 1.5 * (1.2 - this.learn)) return null;
    return heatCenter(best);
  }

  /** Moves the bot's aim toward `target` the way a hand would: partly each tick, with a wobble. */
  private aimAt(target: number, now: number): void {
    if (now % 8 === 0) this.errOffset = gauss(this.rnd) * this.aimErr;
    this.aim += angleDiff(target + this.errOffset, this.aim) * this.track;
  }

  private walkTo(o: Observation, to: P): Input['move'] {
    return stepToward(this.grid, this.field(to), o.self.x, o.self.y);
  }

  think(o: Observation): Input {
    const input: Input = { ...IDLE, move: { x: 0, y: 0 }, aim: this.aim };
    if (o.round !== this.round) {
      this.planRound(o);
      this.aim = o.self.aim;
    }
    if (o.phase !== 'live' || o.self.hp <= 0) {
      this.sawEnemyLastTick = false;
      input.aim = this.aim = o.self.aim;
      return input;
    }
    // Buy phase: one purchase per tick, then the primary in hand.
    if (C.ROUND_TICKS - o.roundTicksLeft < BUY_TICKS && this.buyQueue.length) {
      input.buy = this.buyQueue.shift();
      if (!this.buyQueue.length) this.buyQueue = [];
    } else if (C.ROUND_TICKS - o.roundTicksLeft === BUY_TICKS && o.self.equipped !== 0) {
      input.equip = 0;
    }
    const me: P = { x: o.self.x, y: o.self.y };
    const attacking = o.attacker === this.slot;
    const planted = o.spike.state === 'planted';

    // --- where it thinks you are ---
    if (this.useBelief) this.belief.update(o);
    if (this.useBelief && o.heard && o.tick - this.lastHearSay > 64) {
      this.lastHearSay = o.tick;
      this.say(o, 'HEAR', `footsteps around (${o.heard.x}, ${o.heard.y}): you are running`);
    }
    if (this.useBelief && !o.enemy && o.tick - this.lastBeliefSay > 160) {
      const pk = this.belief.peak();
      if (pk.p > 0.25) {
        this.lastBeliefSay = o.tick;
        const site = Object.entries(this.belief.siteMass).sort((a, b) => b[1] - a[1])[0];
        this.say(o, 'THINK', `you are probably near (${pk.x.toFixed(0)}, ${pk.y.toFixed(0)}), ${Math.round(pk.p * 100)}%; ${site[0]} site ${Math.round(site[1] * 100)}%`);
      }
    }

    // --- what it knows about you ---
    if (o.enemy) {
      if (!this.sawEnemyLastTick) this.reaction = this.reactTicks + Math.floor(this.rnd() * 3);
      this.lastKnown = { x: o.enemy.x, y: o.enemy.y, tick: o.tick };
    } else if (o.lastSeenEnemy && (!this.lastKnown || o.tick - o.lastSeenEnemy.ticksAgo > this.lastKnown.tick)) {
      this.lastKnown = { x: o.lastSeenEnemy.x, y: o.lastSeenEnemy.y, tick: o.tick - o.lastSeenEnemy.ticksAgo };
    }
    this.sawEnemyLastTick = o.enemy !== null;
    const infoAge = this.lastKnown ? o.tick - this.lastKnown.tick : Infinity;

    // --- flashes: turn away from yours, and maybe from mine ---
    let lookAway: number | null = null;
    for (const f of o.flashes) {
      if (f.mine) {
        // Pop-flash discipline: never watch your own flash.
        if (f.ticksLeft <= 10) lookAway = angleTo(f, me);
        continue;
      }
      const key = `${Math.round(f.x / 4)},${Math.round(f.y / 4)}`;
      if (!this.dodgeFor.has(key) && !this.ignoreFor.has(key)) {
        // You dodge my flashes a lot? Then I assume you flash smart too, and I respect yours more.
        const respect = this.brain.humanFlashes >= 3 ? Math.min(0.15, this.brain.humanFlashHits / this.brain.humanFlashes / 4) : 0;
        const dodge = this.rnd() < this.dodgeChance + respect;
        (dodge ? this.dodgeFor : this.ignoreFor).add(key);
        if (dodge) this.say(o, 'DODGE', 'saw your flash coming, turning away');
      }
      if (this.dodgeFor.has(key)) lookAway = angleTo(f, me);
    }

    // --- stuck? wiggle out ---
    if (this.unstick) {
      input.move = { x: this.unstick.x, y: this.unstick.y };
      if (--this.unstick.ticks <= 0) this.unstick = null;
    }

    // --- blind: back off and spray where you were ---
    if (o.self.blindTicks > 0) {
      if (this.lastKnown && infoAge < 48 && dist(me, this.lastKnown) < 12) {
        this.aimAt(angleTo(me, this.lastKnown), o.tick);
        input.fire = o.self.ammo > 0 && this.skill > 0.3;
      }
      // Fall back toward its own spawn: a fixed target, so this costs no new path search.
      input.move = this.walkTo(o, this.map.spawns[attacking ? 'attacker' : 'defender']);
      input.aim = this.aim;
      return input;
    }

    if (o.enemy) {
      // --- fight ---
      const enemy: P = o.enemy;
      // Lead: its aim trails a moving target by about (1 - track) / track ticks, so a good bot aims that far ahead.
      let target: P = enemy;
      if (this.prevEnemy && o.tick - this.prevEnemy.tick <= 2) {
        const dt = o.tick - this.prevEnemy.tick;
        const lead = ((1 - this.track) / this.track) * this.skill;
        target = { x: enemy.x + ((enemy.x - this.prevEnemy.x) / dt) * lead, y: enemy.y + ((enemy.y - this.prevEnemy.y) / dt) * lead };
      }
      this.prevEnemy = { x: enemy.x, y: enemy.y, tick: o.tick };
      if (lookAway === null) this.aimAt(angleTo(me, target), o.tick);
      if (this.reaction > 0) {
        this.reaction--;
        // Still reacting: keep doing what it was doing.
        input.move = this.walkTo(o, this.goal(o, attacking, planted));
      } else {
        // How close to their centre it waits to be before pulling the trigger. Low ranks spray at anything
        // near you (~17 degrees); the top ranks wait for the head (the head is ~0.13 units wide at range).
        const de0 = Math.max(2, dist(me, enemy));
        const tolerance = (0.3 - 0.27 * this.skill) + (0.6 - 0.45 * this.skill) / de0;
        const onTarget = Math.abs(angleDiff(angleTo(me, enemy), this.aim)) < tolerance;
        // Good bots stop to shoot; weaker ones run and gun.
        const runAndGun = this.rnd() < 0.7 * (1 - this.skill);
        if (runAndGun) input.move = this.walkTo(o, enemy);
        input.fire = onTarget && o.self.ammo > 0 && o.self.reloadTicks === 0 && lookAway === null;
        if (o.self.ammo === 0 && o.self.reloadTicks === 0) input.reload = true;
        const gun = this.gun(o);
        const de = dist(me, enemy);
        // Burst control: at range a good player taps or bursts so the spray never blooms. Close up, spray.
        // Only at long range, and only once the bloom would cost more than ~1.5 degrees: an earlier, stricter
        // version halved the fire rate and made Platinum lose to Gold (eval/rank-ladder.ts).
        if (this.skill > 0.4 && gun.bloom > 0 && de > 12) {
          const burst = Math.max(1, Math.floor(1.5 / gun.bloom));
          if (o.self.spray >= burst) input.fire = false;
        }
        // A sniper stands still and waits for the crosshair to settle on you.
        if (gun.cls === 'sniper') {
          input.move = { x: 0, y: 0 };
          if (Math.abs(angleDiff(angleTo(me, target), this.aim)) > 0.03) input.fire = false;
        }
        // Empty mid-fight: drawing the pistol is faster than reloading.
        if (o.self.ammo === 0 && o.self.equipped === 0 && this.skill > 0.55) {
          input.reload = false;
          input.equip = 1;
          if (o.tick - this.lastSwapSay > 96) {
            this.lastSwapSay = o.tick;
            this.say(o, 'SWAP', `out of ${gun.name} ammo: pistol out instead of reloading in your face`);
          }
        }
        if (o.self.ammo === 0 || (o.self.hp <= 25 && o.self.dashes > 0)) {
          // Out of bullets or nearly dead: get out of the line of fire, dash if it can.
          const side = angleTo(me, enemy) + Math.PI / 2;
          input.move = { x: Math.sign(Math.round(Math.cos(side))) as -1 | 0 | 1, y: Math.sign(Math.round(Math.sin(side))) as -1 | 0 | 1 };
          input.dash = o.self.dashes > 0 && this.rnd() < 0.3;
        }
        // Defuse under fire only if it would finish soon.
        if (!attacking && planted && dist(me, o.spike) <= C.DEFUSE_RANGE && o.self.useTicks > C.DEFUSE_TICKS * 0.75) {
          input.use = true;
          input.fire = false;
        }
      }
    } else if (this.lastKnown && infoAge < 96 && !(attacking && !planted && this.inSite(me) && o.self.useTicks > 0)) {
      // --- you were just here: flash it, then clear it ---
      const lk: P = this.lastKnown;
      const d = dist(me, lk);
      const canFlash = o.self.flashes > 0 && o.tick - this.lastFlashTick > 64 && d > 5 && d < 18 && this.skill > 0.35;
      if (canFlash && this.rnd() < 0.08 + 0.2 * this.skill) {
        this.aim = angleTo(me, lk);
        input.flash = true;
        this.lastFlashTick = o.tick;
        this.say(o, 'FLASH', `flashing where I last saw you ${(infoAge / 32).toFixed(1)}s ago, then looking away`);
      } else if (lookAway === null) {
        this.aimAt(angleTo(me, lk), o.tick);
      }
      // Defenders hold their spot if you might be peeking it; attackers and planted-spike defenders push.
      const hold = !attacking && !planted && this.holdSpot && dist(me, this.holdSpot) < 3;
      if (!hold) input.move = this.walkTo(o, lk);
      input.walk = d < 8 && this.skill > 0.4;
      if (d < 0.8) this.lastKnown = null; // reached it, nobody home
    } else {
      // --- no info: play the round plan, steered by the belief map ---
      this.considerCall(o);
      this.considerRotate(o, attacking);
      const goal = this.goal(o, attacking, planted);
      const d = dist(me, goal);
      input.move = this.walkTo(o, goal);
      if (lookAway === null) {
        const watch = this.watchFor(o, me, attacking, planted, goal);
        this.aimAt(angleTo(me, watch), o.tick);
      }
      // Flash where you probably are, when it is fairly sure and it is close enough to land.
      const pk = this.belief.peak();
      const dPk = dist(me, pk);
      if (this.useBelief && lookAway === null && o.self.flashes > 0 && this.skill > 0.35 && pk.p > 0.45 && dPk > 5 && dPk < 14 && o.tick - this.lastFlashTick > 96) {
        const toward = angleTo(me, pk);
        const landing = { x: me.x + Math.cos(toward) * Math.min(8, dPk), y: me.y + Math.sin(toward) * Math.min(8, dPk) };
        if (this.clear(landing, pk, o.smokes) && this.rnd() < 0.15) {
          this.aim = toward;
          input.flash = true;
          this.lastFlashTick = o.tick;
          this.say(o, 'FLASH', `you are probably at (${pk.x.toFixed(0)}, ${pk.y.toFixed(0)}) (${Math.round(pk.p * 100)}%): flashing it, then looking away`);
        }
      }
      if (attacking && !planted) {
        const site = this.siteCenter(this.targetSite);
        const toSite = dist(me, site);
        // Flash the site from the approach before swinging in.
        if (!this.siteFlashUsed && o.self.flashes > 0 && toSite < 13 && toSite > 6 && this.skill > 0.35 && this.clear(me, site, o.smokes)) {
          this.aim = angleTo(me, site);
          input.flash = true;
          this.siteFlashUsed = true;
          this.lastFlashTick = o.tick;
        }
        // Walking in quietly only pays off when your aim can punish whoever is waiting (measured: below
        // ~Master the slower approach lost more fights than the silence won).
        input.walk = toSite < 12 && this.skill > 0.8 && !this.inSite(me);
        if (this.inSite(me) && d < 1.2) {
          input.move = { x: 0, y: 0 };
          input.use = true;
        }
      } else if (!attacking && planted) {
        const toSpike = dist(me, o.spike);
        if (o.self.flashes > 0 && toSpike < 14 && toSpike > 6 && o.tick - this.lastFlashTick > 96 && this.clear(me, o.spike, o.smokes)) {
          this.aim = angleTo(me, o.spike);
          input.flash = true;
          this.lastFlashTick = o.tick;
        }
        if (toSpike <= C.DEFUSE_RANGE - 0.2) {
          input.move = { x: 0, y: 0 };
          input.use = true;
        }
      } else if (d < 0.6) {
        input.move = { x: 0, y: 0 };
      }
      // Between fights: back to the rifle, and top up.
      if (o.self.equipped === 1 && o.self.primary !== NO_WEAPON && infoAge > 64 && C.ROUND_TICKS - o.roundTicksLeft > BUY_TICKS) input.equip = 0;
      else if (o.self.ammo < this.gun(o).mag / 2 && o.self.reloadTicks === 0 && infoAge > 64) input.reload = true;
      // The top ranks prefire the corner they are almost sure you are behind.
      if (this.useBelief && this.skill > 0.8 && o.tick - this.lastPrefire > 96 && lookAway === null) {
        const best = this.belief.bestAim(me.x, me.y, o.smokes);
        if (best.mass > 0.7 && dist(me, best.at) < 9 && Math.abs(angleDiff(best.angle, this.aim)) < 0.06) {
          this.lastPrefire = o.tick;
          input.fire = o.self.ammo > 0;
          this.say(o, 'PREFIRE', `${Math.round(best.mass * 100)}% sure you are right there: shooting before I see you`);
        }
      }
    }

    if (lookAway !== null) {
      this.aim += angleDiff(lookAway, this.aim) * 0.6;
      input.fire = false;
    }

    // Stuck detection: trying to move but going nowhere for half a second.
    const moving = input.move.x !== 0 || input.move.y !== 0;
    if (moving && dist(me, this.lastPos) < 0.02) {
      if (++this.stuckTicks > 16 && !this.unstick) {
        this.unstick = { x: (Math.floor(this.rnd() * 3) - 1) as -1 | 0 | 1, y: (Math.floor(this.rnd() * 3) - 1) as -1 | 0 | 1, ticks: 10 };
        this.stuckTicks = 0;
      }
    } else {
      this.stuckTicks = 0;
    }
    this.lastPos = me;

    input.aim = this.aim;
    return input;
  }

  private inSite(p: P): boolean {
    return Object.values(this.map.sites).some((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  }

  /** Where the round plan wants the bot to be right now. */
  private goal(o: Observation, attacking: boolean, planted: boolean): P {
    if (attacking) {
      if (!planted) return this.plantSpot ?? this.siteCenter(this.targetSite);
      if (!this.postPlantSpot) {
        // Post-plant: back off to a spot with a clear look at the spike, 5 to 11 units away.
        const spike: P = o.spike;
        const cells = this.cellsIn({ x: spike.x - 11, y: spike.y - 11, w: 22, h: 22 }).filter((p) => {
          const d = dist(p, spike);
          return d >= 5 && d <= 11 && this.clear(p, spike);
        });
        this.postPlantSpot = cells.length ? weightedPick(this.rnd, cells, (p) => (this.nearWall(p) ? 3 : 1)) : spike;
      }
      return this.postPlantSpot;
    }
    if (planted) return o.spike;
    return this.holdSpot ?? this.siteCenter(this.targetSite);
  }

  /** Where to look when nothing is visible. */
  private watchFor(o: Observation, me: P, attacking: boolean, planted: boolean, goal: P): P {
    // Belief pre-aim: point at the angle that holds the most probability of you, if it holds enough.
    // A weaker bot trusts it less and falls back to the plan's angles more often.
    if (this.useBelief && this.skill > 0.25) {
      const best = this.belief.bestAim(me.x, me.y, o.smokes);
      if (best.mass > 0.35 - 0.2 * this.skill) return best.at;
    }
    if (!attacking && !planted && this.watchPoint && dist(me, goal) < 3) return this.watchPoint;
    if (attacking && planted) return o.spike;
    // Learned pre-aim on the way: look at a spot you like, if it is in front and in sight.
    const learned = this.learnedAngle(me, 16);
    if (learned && this.clear(me, learned, o.smokes)) return learned;
    // Otherwise look a few steps ahead along the path.
    const f = this.field(goal);
    let p = me;
    for (let i = 0; i < 8; i++) {
      const m = stepToward(this.grid, f, p.x, p.y);
      if (m.x === 0 && m.y === 0) break;
      p = { x: p.x + m.x * 0.5, y: p.y + m.y * 0.5 };
    }
    return dist(p, me) < 0.5 ? goal : p;
  }
}

/**
 * The hand-written bot as a Policy: the clone's fallback when the circuit breaker trips, and the
 * "simpler bot" the evals compare the clone against. Plays at fixed Normal skill with no learned data.
 */
export class BasicBot implements Policy {
  readonly name = 'basic bot';
  private ai: AiPlayer;

  constructor(slot: Slot, mapId: string, rnd: Rng = Math.random) {
    const knowsNothing: Brain = {
      version: 1, name: 'nobody', matches: 0, rounds: 0, aiRoundWins: 0, humanRoundWins: 0, skill: 0.45,
      flashesFaced: 0, flashesDodged: 0, humanFlashHits: 0, humanFlashes: 0, maps: {}, skillHistory: [],
    };
    this.ai = new AiPlayer(slot, mapId, knowsNothing, 'normal', rnd);
    // The fallback stays simple on purpose (spec: a hand-written bot), and cheap enough for the what-if planner.
    this.ai.useBelief = false;
  }

  act(o: Observation): Decision {
    return { input: this.ai.think(o), confidence: 1, because: [] };
  }
}
