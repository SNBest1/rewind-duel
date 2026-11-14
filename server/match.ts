import { IDLE, createMatch, hashState, isBuyable, step, type GameEvent, type Input, type MatchFile, type Rules, type Slot, type State } from '@rewind/engine';

/** Rebuilds a client-sent input from scratch so nothing malformed reaches the engine or the log. */
export function sanitizeInput(raw: any): Input {
  const axis = (v: unknown) => (v === 1 || v === -1 ? v : 0);
  return {
    move: { x: axis(raw?.move?.x), y: axis(raw?.move?.y) },
    walk: raw?.walk === true,
    aim: Number.isFinite(raw?.aim) ? raw.aim : 0,
    fire: raw?.fire === true,
    reload: raw?.reload === true,
    smoke: raw?.smoke === true,
    dash: raw?.dash === true,
    use: raw?.use === true,
    flash: raw?.flash === true,
    // Optional keys are left out unless valid, so a normal input logs exactly as it did before.
    ...(Number.isInteger(raw?.buy) && (isBuyable(raw.buy) || raw.buy === 0) ? { buy: raw.buy as number } : {}),
    ...(raw?.equip === 0 || raw?.equip === 1 ? { equip: raw.equip as 0 | 1 } : {}),
  };
}

const MAX_QUEUED = 2;

/**
 * One authoritative match with no networking or clock in it: the caller decides when to tick.
 * It logs an input only when it differs from that slot's previous one, stamped with the tick it first applied on.
 */
export class MatchRunner {
  state: State;
  private inputs: [Input, Input] = [IDLE, IDLE];
  private lastLogged: [string, string] = ['', ''];
  private log: MatchFile['inputs'] = [];
  /** Per slot, the client's sequence number of the input in force. Echoed back so the client can reconcile its prediction. */
  readonly acks: [number, number] = [0, 0];

  /** @param initial start from this state instead of tick 0 (a rewind branch). Its log then starts at that tick. */
  constructor(readonly id: string, readonly seed: number, readonly names: [string, string], mapId = 'duel', initial?: State, rules: Rules = 'classic') {
    this.state = initial ?? createMatch(seed, mapId, rules);
  }

  /** The input log so far, delta-encoded. */
  get inputLog(): MatchFile['inputs'] {
    return this.log;
  }

  /**
   * Inputs waiting to be applied, oldest first. Clients send one input per tick, and each is applied for exactly one
   * tick so the client's prediction (which assumes the same) stays exact when packets arrive bunched (DECISIONS D17).
   */
  private queues: [{ input: Input; seq: number }[], { input: Input; seq: number }[]] = [[], []];

  setInput(slot: Slot, raw: unknown, seq: unknown = 0): void {
    const q = this.queues[slot];
    q.push({ input: sanitizeInput(raw), seq: Number.isSafeInteger(seq) ? (seq as number) : 0 });
    // A backlog is pure added latency, so past this many waiting inputs the oldest are dropped.
    if (q.length > MAX_QUEUED) q.splice(0, q.length - MAX_QUEUED);
  }

  tick(): GameEvent[] {
    for (const slot of [0, 1] as const) {
      // With nothing new the previous input stays in force, the same as a held key.
      const next = this.queues[slot].shift();
      if (next) {
        this.inputs[slot] = next.input;
        this.acks[slot] = next.seq;
      }
    }
    for (const slot of [0, 1] as const) {
      const json = JSON.stringify(this.inputs[slot]);
      if (json !== this.lastLogged[slot]) {
        this.log.push({ tick: this.state.tick, slot, input: this.inputs[slot] });
        this.lastLogged[slot] = json;
      }
    }
    const { next, events } = step(this.state, this.inputs);
    this.state = next;
    return events;
  }

  toFile(): MatchFile {
    return {
      id: this.id,
      seed: this.seed,
      map: this.state.mapId,
      players: [{ slot: 0, name: this.names[0] }, { slot: 1, name: this.names[1] }],
      inputs: this.log,
      ticks: this.state.tick,
      finalHash: hashState(this.state),
      rules: this.state.rules,
    };
  }
}
