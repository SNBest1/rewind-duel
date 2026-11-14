// Which moments the AI coach reviews after a match: 3 seconds before each of the player's last 3 deaths.
import { TICK_RATE, type MatchFile, type Slot } from '@rewind/engine';
import { analyzeMatch } from './summary';

export type CoachMoment = { round: number; tick: number; deathTick: number };

export function coachMoments(file: MatchFile, human: Slot, max = 3): CoachMoment[] {
  return analyzeMatch(file, false).rounds
    .map((r) => ({ r, k: r.kills.find((k) => k.victim === human) }))
    .filter((x) => x.k)
    .slice(-max)
    // Never before the round started (a fork has to land in a live round).
    .map(({ r, k }) => ({ round: r.round, deathTick: k!.tick, tick: Math.max(r.startTick + 16, k!.tick - 3 * TICK_RATE) }));
}
