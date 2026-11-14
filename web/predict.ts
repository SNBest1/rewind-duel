// Client-side prediction of this player's own movement. Display only: nothing computed here is sent or recorded.
import { applyMovement, applyTeleport, getMap, type GameMap, type Input, type Mover } from '@rewind/engine';

const copy = (m: Mover): Mover => ({ x: m.x, y: m.y, dashes: m.dashes, dashTicks: m.dashTicks, dashX: m.dashX, dashY: m.dashY, moveState: m.moveState });

/** One tick of movement exactly as the server does it: move, then teleport (which cancels a dash). */
function advance(p: Mover, input: Input, map: GameMap): void {
  applyMovement(p, input, map.walls);
  if (applyTeleport(p, map)) p.dashTicks = 0;
}

/**
 * Runs the engine's own movement rule on inputs the server has not applied yet.
 * Every sent input gets a sequence number; the server echoes the number of the input in force at each tick (`ack`).
 * On every observation the prediction is rebuilt as: authoritative self + every input newer than `ack`, one tick each.
 */
export class Predictor {
  private seq = 0;
  private pending: { seq: number; input: Input }[] = [];
  private map: GameMap;
  /** Where this player will be once the server has applied every input sent so far. Null until the first observation. */
  pos: Mover | null = null;

  constructor(mapId = 'duel') {
    this.map = getMap(mapId);
  }

  setMap(mapId: string): void {
    this.map = getMap(mapId);
    this.pos = null;
  }

  /** Records an input about to be sent and advances the prediction one tick. Returns the sequence number to send with it. */
  send(input: Input, live: boolean): number {
    this.seq++;
    this.pending.push({ seq: this.seq, input });
    if (this.pos && live) advance(this.pos, input, this.map);
    return this.seq;
  }

  /** Rebuilds the prediction from a server observation of this player. */
  reconcile(self: Mover, ack: number, live: boolean): void {
    this.pending = this.pending.filter((p) => p.seq > ack);
    const p = copy(self);
    if (live) for (const { input } of this.pending) advance(p, input, this.map);
    this.pos = p;
  }

  /** Inputs sent but not yet acknowledged. Roughly the round trip in ticks. */
  get unacked(): number {
    return this.pending.length;
  }
}
