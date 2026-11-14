// Named demo presets: fixed forks from real human matches where the opponent clone SEES the player and
// SHOOTS, so the video plays the same engagement every take. Each preset names the match, the fork tick,
// which slot the presenter controls, and the opponent being cloned. The replay viewer loads one by name;
// nothing is random, so take 1 and take 5 are identical.
//
// These were chosen (eval/_demo scan) for: opponent clone saw the player >= ~8 ticks and fired >= ~4 over a
// 3-second rollout of the best plan, across three different matches and three different opponents.

export type DemoPreset = {
  name: string; // the handle the video and the viewer use
  matchId: string; // which recorded match
  forkTick: number; // the exact tick to rebuild at
  human: 0 | 1; // which slot the presenter controls (the other is the opponent clone)
  opponent: string; // the real player whose clone drives the other slot
  note: string; // one line: what this engagement shows
};

export const DEMO_PRESETS: DemoPreset[] = [
  {
    name: 'duel-straight',
    matchId: '1234-1794679679263',
    forkTick: 2935,
    human: 0,
    opponent: 'Supra',
    note: 'Straight mid fight: the Supra clone holds its angle and trades — it sees you ~25 ticks and fires ~24.',
  },
  {
    name: 'duel-rush',
    matchId: '12345-1794678166338',
    forkTick: 5097,
    human: 0,
    opponent: 'Pratul',
    note: 'Close rush onto the last-seen angle: the Pratul clone fires on every tick it sees you.',
  },
  {
    name: 'duel-dash',
    matchId: '123456-1794676398055',
    forkTick: 8132,
    human: 0,
    opponent: 'Pratul Saini',
    note: 'Dash across the angle: the Pratul Saini clone picks you up and shoots as you cross.',
  },
];

export function presetByName(name: string): DemoPreset | undefined {
  return DEMO_PRESETS.find((p) => p.name === name);
}
