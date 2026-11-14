// Server-side rewind: HTTP to browse recorded matches and a WebSocket to take control from a fork tick.
// All of it runs in Node, the same runtime that ran the live match (hard rule 3). The browser only ever
// draws snapshots and the human's own live Observation; it never simulates.
import { readFileSync, readdirSync } from 'node:fs';
import type { Input, MatchFile, Slot } from '@rewind/engine';
import { buildClone, loadMatches, matchesOf } from '@rewind/clone';
import { RewindSession, buildSnapshots, timelineMarkers } from '@rewind/rewind';
import { sanitizeInput } from './match';

/** A one-line summary of each recorded match, for the replay viewer's match list. */
export function matchList(dir: string): { id: string; players: string[]; ticks: number }[] {
  const out: { id: string; players: string[]; ticks: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const f = JSON.parse(readFileSync(dir + name, 'utf8')) as MatchFile;
      if (f.id && Array.isArray(f.players)) out.push({ id: f.id, players: f.players.map((p) => p.name), ticks: f.ticks });
    } catch { /* not a match file */ }
  }
  return out.sort((a, b) => b.ticks - a.ticks);
}

/** The full replay payload for one match: snapshots to draw, markers for the scrub bar, names and map. */
export function replayPayload(dir: string, id: string) {
  const file = JSON.parse(readFileSync(dir + id + '.json', 'utf8')) as MatchFile;
  return {
    id: file.id,
    map: file.map,
    players: file.players,
    ticks: file.ticks,
    snapshots: buildSnapshots(file),
    markers: timelineMarkers(file),
  };
}

/**
 * Opens a rewind session for a match: the human takes the given slot, the opponent is driven by a guarded
 * clone of whoever actually held the opponent slot. Throws if there is no data to build that clone.
 */
export function openSession(dir: string, id: string, human: Slot, forkTick: number): RewindSession {
  const all = loadMatches(dir);
  const file = all.find((m) => m.id === id);
  if (!file) throw new Error(`match ${id} not found`);
  const opponent = (1 - human) as Slot;
  const oppName = file.players.find((p) => p.slot === opponent)?.name ?? '';

  // Build the opponent's clone from all of their matches except this one, so the clone is not just
  // memorizing the very game being relived. If this is their only match, fall back to training on it.
  const oppMatches = matchesOf(all, oppName);
  const holdOut = oppMatches.length > 1 ? [id] : [];
  const { guarded } = buildClone(oppName, { allMatches: all, holdOut });
  return new RewindSession(file, human, forkTick, guarded);
}

export { sanitizeInput };
