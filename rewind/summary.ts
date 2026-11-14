// What the replay viewer needs from a match file: rounds, a compact frame per 2 ticks, and the events worth drawing.
// Computed in Node by replaying the match (the browser never simulates).
import { IDLE, createMatch, step, type GameEvent, type Input, type MatchFile, type Slot } from '@rewind/engine';

export type RoundInfo = {
  round: number;
  attacker: Slot;
  startTick: number;
  endTick: number;
  winner: Slot | null;
  reason: string | null;
  kills: { tick: number; killer: Slot; victim: Slot }[];
};

export type MatchSummary = {
  id: string;
  map: string;
  players: MatchFile['players'];
  ticks: number;
  score: [number, number];
  rounds: RoundInfo[];
};

/** One frame: [tick, x0, y0, aim0, hp0, blind0, x1, y1, aim1, hp1, blind1]. */
export type Frame = number[];

export type MatchDetail = MatchSummary & {
  frameStep: number;
  frames: Frame[];
  /** Drawable events: shots (tracers), kills, plants, smokes, flash pops. */
  events: GameEvent[];
  /** Smokes alive at each frame, as [frameIndex, x, y][] (sparse). */
  smokes: [number, number, number][];
};

const FRAME_STEP = 2;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function analyzeMatch(file: MatchFile, withFrames: boolean): MatchSummary | MatchDetail {
  let s = createMatch(file.seed, file.map);
  const cur: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  const rounds: RoundInfo[] = [{ round: 1, attacker: 0, startTick: 0, endTick: file.ticks, winner: null, reason: null, kills: [] }];
  const frames: Frame[] = [];
  const smokes: [number, number, number][] = [];
  const events: GameEvent[] = [];
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      cur[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (withFrames && s.tick % FRAME_STEP === 0) {
      const [a, b] = s.players;
      frames.push([s.tick, r2(a.x), r2(a.y), r2(a.aim), a.hp, a.blindTicks, r2(b.x), r2(b.y), r2(b.aim), b.hp, b.blindTicks]);
      for (const k of s.smokes) smokes.push([frames.length - 1, r2(k.x), r2(k.y)]);
    }
    const r = step(s, cur);
    s = r.next;
    for (const e of r.events) {
      const last = rounds[rounds.length - 1];
      if (e.type === 'roundStart') rounds.push({ round: e.round, attacker: e.attacker, startTick: e.tick, endTick: file.ticks, winner: null, reason: null, kills: [] });
      else if (e.type === 'roundEnd') Object.assign(last, { endTick: e.tick, winner: e.winner, reason: e.reason });
      else if (e.type === 'kill') last.kills.push({ tick: e.tick, killer: e.killer, victim: e.victim });
      if (withFrames && (e.type === 'shot' || e.type === 'kill' || e.type === 'plant' || e.type === 'flashPop' || e.type === 'defuse' || e.type === 'roundStart')) {
        events.push(e);
      }
    }
  }
  const summary: MatchSummary = { id: file.id, map: file.map, players: file.players, ticks: file.ticks, score: [s.score[0], s.score[1]], rounds };
  return withFrames ? { ...summary, frameStep: FRAME_STEP, frames, events, smokes } : summary;
}
