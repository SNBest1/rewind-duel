// Replays a match collecting the events a timeline wants to mark: kills, plants, round starts/ends, detonations.
// The web replay viewer uses these to draw the scrub bar, so a player can jump straight to a moment.
import { IDLE, createMatch, step, type GameEvent, type Input, type MatchFile } from '@rewind/engine';

export type Marker =
  | { tick: number; kind: 'roundStart'; round: number }
  | { tick: number; kind: 'roundEnd'; round: number; winner: 0 | 1; reason: string }
  | { tick: number; kind: 'kill'; killer: 0 | 1; victim: 0 | 1 }
  | { tick: number; kind: 'plant'; slot: 0 | 1 }
  | { tick: number; kind: 'defuse'; slot: 0 | 1 }
  | { tick: number; kind: 'detonate' };

/** Every marker in a match, in tick order. A full replay, so markers line up with the exact state at that tick. */
export function timelineMarkers(file: MatchFile): Marker[] {
  const markers: Marker[] = [];
  let s = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  const take = (events: GameEvent[]) => {
    for (const e of events) {
      if (e.type === 'roundStart') markers.push({ tick: e.tick, kind: 'roundStart', round: e.round });
      else if (e.type === 'roundEnd') markers.push({ tick: e.tick, kind: 'roundEnd', round: e.round, winner: e.winner, reason: e.reason });
      else if (e.type === 'kill') markers.push({ tick: e.tick, kind: 'kill', killer: e.killer, victim: e.victim });
      else if (e.type === 'plant') markers.push({ tick: e.tick, kind: 'plant', slot: e.slot });
      else if (e.type === 'defuse') markers.push({ tick: e.tick, kind: 'defuse', slot: e.slot });
      else if (e.type === 'detonate') markers.push({ tick: e.tick, kind: 'detonate' });
    }
  };
  // Round 1 starts at tick 0 with no event, so add it explicitly.
  markers.push({ tick: 0, kind: 'roundStart', round: 1 });
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    const r = step(s, current);
    s = r.next;
    take(r.events);
  }
  return markers;
}
