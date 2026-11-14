import { IDLE, createMatch, hashState, step, type GameEvent, type Input, type MatchFile, type Slot, type State } from '@rewind/engine';

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
  };
}

/**
 * One authoritative match with no networking or clock in it: the caller decides when to tick.
 * It logs an input only when it differs from that slot's previous one, stamped with the tick it first applied on.
 */
export class MatchRunner {
  state: State;
  private inputs: [Input, Input] = [IDLE, IDLE];
  private lastLogged: [string, string] = ['', ''];
  private log: MatchFile['inputs'] = [];

  constructor(readonly id: string, readonly seed: number, readonly names: [string, string]) {
    this.state = createMatch(seed, 'duel');
  }

  setInput(slot: Slot, raw: unknown): void {
    this.inputs[slot] = sanitizeInput(raw);
  }

  tick(): GameEvent[] {
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
    };
  }
}
