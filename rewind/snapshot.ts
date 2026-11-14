// A replay viewer shows the whole round, both players, so it is allowed to see both sides (it is the
// player's own recorded match, after the fact). This builds a compact per-tick snapshot the client draws.
// Live fog never uses this; only the post-match replay viewer does.
import { IDLE, createMatch, step, type Input, type MatchFile, type Slot, type State } from '@rewind/engine';

export type PlayerSnap = { x: number; y: number; aim: number; hp: number; moveState: number };
export type Snapshot = {
  tick: number;
  round: number;
  phase: string;
  players: [PlayerSnap, PlayerSnap];
  smokes: { x: number; y: number; ticksLeft: number }[];
  spike: { state: string; x: number; y: number; ticksLeft: number };
  score: [number, number];
};

function snap(s: State): Snapshot {
  const p = (slot: Slot): PlayerSnap => {
    const q = s.players[slot];
    return { x: q.x, y: q.y, aim: q.aim, hp: q.hp, moveState: q.moveState };
  };
  return {
    tick: s.tick,
    round: s.round,
    phase: s.phase,
    players: [p(0), p(1)],
    smokes: s.smokes.map((k) => ({ x: k.x, y: k.y, ticksLeft: k.ticksLeft })),
    spike: { state: s.spike.state, x: s.spike.x, y: s.spike.y, ticksLeft: s.spike.ticksLeft },
    score: [s.score[0], s.score[1]],
  };
}

/**
 * One snapshot per `stride` ticks across the whole match (default every tick). The client interpolates
 * between snapshots when scrubbing, so a coarser stride trades file size for scrub smoothness.
 */
export function buildSnapshots(file: MatchFile, stride = 1): Snapshot[] {
  const out: Snapshot[] = [];
  let s = createMatch(file.seed, file.map);
  const current: [Input, Input] = [IDLE, IDLE];
  let i = 0;
  while (s.tick < file.ticks) {
    while (i < file.inputs.length && file.inputs[i].tick === s.tick) {
      current[file.inputs[i].slot] = file.inputs[i].input;
      i++;
    }
    if (s.tick % stride === 0) out.push(snap(s));
    s = step(s, current).next;
  }
  out.push(snap(s));
  return out;
}
