// What the AI has learned about one human, and the code that learns it.
// The trainer watches the authoritative state (like reviewing the tape after a game), so it learns the
// human's real habits. The bot that plays only ever gets `observe()`, so it cannot cheat during a round.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WEAPONS, getMap, type GameEvent, type Slot, type State } from '@rewind/engine';
import { rankOf, type Rank } from './ranks';

export const HEAT_CELL = 2;
const HEAT_COLS = 24;
const HEAT_ROWS = 16;
const HEAT_SIZE = HEAT_COLS * HEAT_ROWS;

export type MapMemory = {
  rounds: number;
  /** Where the human went when attacking: the site they planted on or got closest to. */
  attackSites: Record<string, number>;
  /** Which site the human was holding 8 seconds into a defence round. */
  defendSites: Record<string, number>;
  /** Where the human stands, sampled every quarter second. Old rounds fade. */
  heat: number[];
  /** Where the human was standing when they killed the AI. Weighted heavily when pre-aiming. */
  killSpots: number[];
};

/** Where a brand new player's adaptive AI starts: easy. It climbs only if you keep winning. */
export const START_SKILL = 0.2;

export type Brain = {
  version: 1 | 2;
  /** Rounds in a row the human won (positive) or lost (negative), against the adaptive AI. */
  streak?: number;
  name: string;
  matches: number;
  rounds: number;
  aiRoundWins: number;
  humanRoundWins: number;
  /** 0 (easy) to 1 (insane). Only moves in adaptive AI matches: up when you win rounds, down when you lose. */
  skill: number;
  /** AI flashes that popped in front of the human vs ones the human turned away from. */
  flashesFaced: number;
  flashesDodged: number;
  /** Human flashes that blinded the AI. */
  humanFlashHits: number;
  humanFlashes: number;
  maps: Record<string, MapMemory>;
  /** Skill after each adaptive AI round, oldest first (last 60). Shows the AI adapting to you. */
  skillHistory: { skill: number; humanWon: boolean }[];
  /** Rounds you played with each primary weapon id. The top ranks counter-buy against your favourite. */
  weapons?: Record<string, number>;
  /** The AI's calls on where you would go, made before it saw you, and how many came true. */
  reads?: { made: number; correct: number };
};

/** What the human actually did in the round that just ended, for checking the AI's call. */
export type RoundTruth = { humanAttacked: boolean; site: string | null };

export type BrainSummary = {
  name: string;
  matches: number;
  rounds: number;
  skill: number;
  aiWinRate: number | null;
  insights: string[];
  skillHistory: { skill: number; humanWon: boolean }[];
  /** Your rank: the AI level you are holding your own against. */
  rank: Rank;
  reads: { made: number; correct: number };
  /** Per map: how many times you attacked / defended each site, for the result screen. */
  sites: Record<string, { attack: Record<string, number>; defend: Record<string, number> }>;
};

export function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'player';
}

function blankMap(): MapMemory {
  return { rounds: 0, attackSites: {}, defendSites: {}, heat: new Array(HEAT_SIZE).fill(0), killSpots: new Array(HEAT_SIZE).fill(0) };
}

export function blankBrain(name: string): Brain {
  return {
    version: 2, name, streak: 0, matches: 0, rounds: 0, aiRoundWins: 0, humanRoundWins: 0, skill: START_SKILL,
    flashesFaced: 0, flashesDodged: 0, humanFlashHits: 0, humanFlashes: 0, maps: {}, skillHistory: [],
  };
}

export function mapMemory(b: Brain, mapId: string): MapMemory {
  return (b.maps[mapId] ??= blankMap());
}

export function heatIndex(x: number, y: number): number {
  const cx = Math.max(0, Math.min(HEAT_COLS - 1, Math.floor(x / HEAT_CELL)));
  const cy = Math.max(0, Math.min(HEAT_ROWS - 1, Math.floor(y / HEAT_CELL)));
  return cy * HEAT_COLS + cx;
}

export function heatCenter(i: number): { x: number; y: number } {
  return { x: ((i % HEAT_COLS) + 0.5) * HEAT_CELL, y: (Math.floor(i / HEAT_COLS) + 0.5) * HEAT_CELL };
}

// --- storage --------------------------------------------------------------------------------------

export class BrainStore {
  constructor(private dir: string) {}

  private path(name: string): string {
    return `${this.dir}${safeName(name)}.json`;
  }

  load(name: string): Brain {
    const p = this.path(name);
    if (existsSync(p)) {
      try {
        const b = JSON.parse(readFileSync(p, 'utf8')) as Brain;
        b.skillHistory ??= []; // brains saved before skill history existed
        b.streak ??= 0;
        if (b.version === 1) {
          // Version 1 started everyone at 0.45, which was too hard. Keep what it learned, restart the difficulty low.
          b.version = 2;
          b.skill = Math.min(b.skill, START_SKILL);
          b.skillHistory = [];
        }
        if (b.version === 2) return b;
      } catch {
        /* corrupt file: start fresh rather than crash the server */
      }
    }
    return blankBrain(safeName(name));
  }

  save(b: Brain): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(b.name), JSON.stringify(b));
  }
}

// --- learning -------------------------------------------------------------------------------------

/** Watches one human through a match and writes what it saw into their brain. */
export class Trainer {
  private minSiteDist: Record<string, number> = {};
  private plantedSite: string | null = null;
  private defendSample: string | null = null;
  private roundOpen = false;
  /** Set when a round closes: where the human really went. */
  lastRound: RoundTruth | null = null;

  /**
   * @param human the slot of the human being studied
   * @param ai the AI's slot, or null in a human vs human match (the trainer still learns habits, and skill stays put)
   * @param adaptive whether round results move the brain's skill
   */
  constructor(readonly brain: Brain, readonly human: Slot, readonly ai: Slot | null, readonly adaptive: boolean) {}

  observe(s: State, events: GameEvent[]): void {
    const map = getMap(s.mapId);
    const mem = mapMemory(this.brain, s.mapId);
    const h = s.players[this.human];

    if (s.phase === 'live') {
      this.roundOpen = true;
      if (h.hp > 0) {
        if (s.tick % 8 === 0) mem.heat[heatIndex(h.x, h.y)] += 1;
        if (s.attacker === this.human) {
          for (const [label, r] of Object.entries(map.sites)) {
            const d = Math.hypot(h.x - (r.x + r.w / 2), h.y - (r.y + r.h / 2));
            this.minSiteDist[label] = Math.min(this.minSiteDist[label] ?? Infinity, d);
          }
        } else if (s.roundTicks === 256) {
          this.defendSample = nearestSite(map.sites, h.x, h.y);
        }
      }
    }

    const popsByAi = new Set<number>();
    for (const e of events) {
      if (e.type === 'flashPop' && e.slot === this.ai) popsByAi.add(e.tick);
      if (e.type === 'flashPop' && e.slot === this.human) this.brain.humanFlashes++;
    }
    for (const e of events) {
      if (e.type === 'plant' && e.slot === this.human) this.plantedSite = nearestSite(map.sites, e.x, e.y);
      if (e.type === 'kill' && e.killer === this.human) mem.killSpots[heatIndex(h.x, h.y)] += 1;
      if (e.type === 'blinded' && e.slot === this.ai && e.by === this.human) this.brain.humanFlashHits++;
      if (this.ai !== null && popsByAi.has(e.tick)) {
        if (e.type === 'blinded' && e.slot === this.human && e.by === this.ai) this.brain.flashesFaced++;
        if (e.type === 'flashDodged' && e.slot === this.human) {
          this.brain.flashesFaced++;
          this.brain.flashesDodged++;
        }
      }
      if (e.type === 'roundEnd') this.closeRound(s, e.winner);
    }
  }

  private closeRound(s: State, winner: Slot): void {
    if (!this.roundOpen) return;
    this.roundOpen = false;
    const mem = mapMemory(this.brain, s.mapId);
    mem.rounds++;
    this.brain.rounds++;
    // The attacker is whoever attacked the round that just ended. `s.attacker` still holds it: the swap happens at round start.
    if (s.attacker === this.human) {
      let site = this.plantedSite;
      if (!site) {
        let best = Infinity;
        for (const [label, d] of Object.entries(this.minSiteDist)) {
          if (d < best && d < 7) {
            best = d;
            site = label;
          }
        }
      }
      if (site) mem.attackSites[site] = (mem.attackSites[site] ?? 0) + 1;
      this.lastRound = { humanAttacked: true, site };
    } else {
      if (this.defendSample) mem.defendSites[this.defendSample] = (mem.defendSites[this.defendSample] ?? 0) + 1;
      this.lastRound = { humanAttacked: false, site: this.defendSample };
    }
    const gun = String(s.players[this.human].primary);
    this.brain.weapons ??= {};
    this.brain.weapons[gun] = (this.brain.weapons[gun] ?? 0) + 1;
    // Fade old habits a little each round, so the AI follows you when you change.
    for (let i = 0; i < HEAT_SIZE; i++) {
      mem.heat[i] *= 0.97;
      mem.killSpots[i] *= 0.985;
    }
    if (winner === this.human) this.brain.humanRoundWins++;
    else if (this.ai !== null) this.brain.aiRoundWins++;
    if (this.adaptive && this.ai !== null) {
      this.brain.skill = nextSkill(this.brain, winner === this.human);
      this.brain.skillHistory.push({ skill: Math.round(this.brain.skill * 100) / 100, humanWon: winner === this.human });
      if (this.brain.skillHistory.length > 60) this.brain.skillHistory.shift();
    }
    this.minSiteDist = {};
    this.plantedSite = null;
    this.defendSample = null;
  }

  finishMatch(): void {
    this.brain.matches++;
  }
}

/**
 * The adaptive difficulty step. Win a round: it gets harder. Lose one: easier. A streak makes each step bigger
 * (x1.5 per extra round, capped), so it reacts in 2 to 3 rounds instead of a whole match. Losing steps are a
 * little bigger than winning ones, so a struggling player is helped first. Updates the streak on the brain.
 */
export function nextSkill(b: Brain, humanWon: boolean): number {
  const s = b.streak ?? 0;
  const streak = humanWon ? (s > 0 ? s + 1 : 1) : s < 0 ? s - 1 : -1;
  b.streak = streak;
  const boost = Math.min(2.5, 1 + 0.5 * (Math.abs(streak) - 1));
  const delta = humanWon ? 0.07 * boost : -0.09 * boost;
  return Math.round(Math.max(0.05, Math.min(1, b.skill + delta)) * 1000) / 1000;
}

function nearestSite(sites: Record<string, { x: number; y: number; w: number; h: number }>, x: number, y: number): string {
  let best = '';
  let bestD = Infinity;
  for (const [label, r] of Object.entries(sites)) {
    const d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
    if (d < bestD) {
      bestD = d;
      best = label;
    }
  }
  return best;
}

// --- what the AI tells you it learned -----------------------------------------------------------

const pct = (a: number, b: number) => Math.round((100 * a) / Math.max(1, b));

function topShare(counts: Record<string, number>): { label: string; share: number; total: number } | null {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 2) return null;
  const [label, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { label, share: pct(n, total), total };
}

export function summarize(b: Brain): BrainSummary {
  const insights: string[] = [];
  for (const [mapId, mem] of Object.entries(b.maps)) {
    const name = getMap(mapId).name;
    const atk = topShare(mem.attackSites);
    if (atk && atk.share >= 55) insights.push(`On ${name} you hit ${atk.label} ${atk.share}% of the time. I'll be waiting there.`);
    const def = topShare(mem.defendSites);
    if (def && def.share >= 55) insights.push(`On ${name} you defend ${def.label} ${def.share}% of the time, so I attack elsewhere.`);
    const hotKill = mem.killSpots.reduce((best, v, i) => (v > mem.killSpots[best] ? i : best), 0);
    if (mem.killSpots[hotKill] >= 2) {
      const p = heatCenter(hotKill);
      insights.push(`On ${name} you keep killing me from around (${p.x}, ${p.y}). I pre-aim it now.`);
    }
  }
  if (b.reads && b.reads.made >= 2) insights.unshift(`I called your play ${b.reads.correct} of ${b.reads.made} times (${pct(b.reads.correct, b.reads.made)}%) before I ever saw you.`);
  const fav = Object.entries(b.weapons ?? {}).sort((x, y) => y[1] - x[1])[0];
  if (fav && fav[1] >= 3) insights.push(`Your gun is the ${WEAPONS[Number(fav[0])]?.name ?? 'Standard'} (${fav[1]} rounds). At high ranks I buy to counter it.`);
  if (b.flashesFaced >= 3) insights.push(`You turn away from ${pct(b.flashesDodged, b.flashesFaced)}% of my flashes.`);
  if (b.humanFlashes >= 3) insights.push(`${pct(b.humanFlashHits, b.humanFlashes)}% of your flashes blind me.`);
  const played = b.aiRoundWins + b.humanRoundWins;
  return {
    name: b.name,
    matches: b.matches,
    rounds: b.rounds,
    skill: Math.round(b.skill * 100) / 100,
    aiWinRate: played ? pct(b.aiRoundWins, played) : null,
    insights: insights.slice(0, 6),
    skillHistory: b.skillHistory.slice(-30),
    rank: rankOf(b.skill),
    reads: b.reads ?? { made: 0, correct: 0 },
    sites: Object.fromEntries(Object.entries(b.maps).map(([id, m]) => [id, { attack: m.attackSites, defend: m.defendSites }])),
  };
}
