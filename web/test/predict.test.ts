import { describe, expect, it } from 'vitest';
import { IDLE, observe, type Input } from '@rewind/engine';
import { MatchRunner } from '../../server/match';
import { Predictor } from '../predict';

/** Scripted inputs for slot 0: diagonal into a lane wall (so it slides), one dash, then straight. */
function script(t: number): Input {
  if (t < 60) return { ...IDLE, move: { x: 1, y: -1 } };
  if (t === 60) return { ...IDLE, move: { x: 1, y: 0 }, dash: true };
  return { ...IDLE, move: { x: 1, y: 0 }, walk: t > 150 };
}

/**
 * Plays `ticks` ticks through a real MatchRunner with `lag` ticks of delay each way,
 * one client input per server tick. Returns the prediction and the raw observation after each tick.
 */
function simulate(lag: number, ticks: number, bunch = false) {
  const runner = new MatchRunner('t', 1, ['a', 'b']);
  const pred = new Predictor();
  const toServer: { at: number; input: Input; seq: number }[] = [];
  const toClient: { at: number; obs: ReturnType<typeof observe>; ack: number }[] = [];
  const out: { pred: { x: number; y: number }; seen: { x: number; y: number } }[] = [];
  let seen = { x: 0, y: 0 };
  for (let t = 0; t < ticks; t++) {
    const input = script(t);
    // `bunch` holds every even input back a tick, so inputs arrive in pairs and then not at all, as on a jittery network.
    toServer.push({ at: t + lag + (bunch && t % 2 === 0 ? 1 : 0), input, seq: pred.send(input, true) });
    for (const m of toServer.filter((m) => m.at <= t)) runner.setInput(0, m.input, m.seq);
    toServer.splice(0, toServer.length, ...toServer.filter((m) => m.at > t));
    runner.tick();
    toClient.push({ at: t + lag, obs: observe(runner.state, 0), ack: runner.acks[0] });
    while (toClient.length && toClient[0].at <= t) {
      const m = toClient.shift()!;
      pred.reconcile(m.obs.self, m.ack, true);
      seen = { x: m.obs.self.x, y: m.obs.self.y };
    }
    out.push({ pred: { x: pred.pos?.x ?? NaN, y: pred.pos?.y ?? NaN }, seen });
  }
  return out;
}

describe('Predictor', () => {
  it('with no lag the prediction is exactly the server position', () => {
    for (const s of simulate(0, 200)) expect(s.pred).toEqual(s.seen);
  });

  it('with lag, the prediction equals where a lag-free match would be at the same input', () => {
    const truth = simulate(0, 200);
    const lagged = simulate(4, 200);
    // Before the first observation arrives (2 * lag ticks) there is nothing to predict from.
    for (let t = 8; t < 200; t++) expect(lagged[t].pred).toEqual(truth[t].pred);
  });

  it('with lag, the raw observation trails the prediction by the round trip', () => {
    const truth = simulate(0, 200);
    const lagged = simulate(4, 200);
    for (let t = 8; t < 200; t++) expect(lagged[t].seen).toEqual(truth[t - 8].seen);
    // While moving, that trail is visible distance: 8 ticks at run speed is over a unit.
    expect(Math.hypot(lagged[100].pred.x - lagged[100].seen.x, lagged[100].pred.y - lagged[100].seen.y)).toBeGreaterThan(1);
  });

  it('stays exact when inputs reach the server in bunches', () => {
    const truth = simulate(0, 200);
    const bunched = simulate(4, 200, true);
    for (let t = 10; t < 200; t++) expect(bunched[t].pred).toEqual(truth[t].pred);
  });
});
