// Transfer-test helper. The spec asks us to log, for a lost fight: the person's first attempt, their
// retries, and a fresh attempt at the same situation, then summarize. We reconstruct this from recorded
// data: find a round a player lost, fork ~3 s before it ended, and report
//   - first attempt  : the recorded outcome (they lost, by construction)
//   - retries         : the player's own clone vs the opponent's clone, replayed N times from the fork
//   - fresh attempt   : the best what-if micro-plan from the same fork
// All three face the opponent's guarded clone, so they are comparable.
import { IDLE, observe, replayMatch, step, type Input, type MatchFile, type Slot, type State } from '@rewind/engine';
import { buildClone, matchesOf, type BuiltClone } from '@rewind/clone';
import { evaluatePlans, timelineMarkers } from '@rewind/rewind';

export type TransferCase = {
  matchId: string;
  player: string;
  round: number;
  forkTick: number;
  firstAttempt: 'lost';
  retries: { branch: number; playerWon: boolean }[];
  freshAttempt: { plan: string; winRate: number; survivalRate: number } | null;
};

/** The first round in a match that the given slot lost, with the tick it ended. */
function firstLostRound(file: MatchFile, slot: Slot): { round: number; endTick: number } | null {
  for (const m of timelineMarkers(file)) {
    if (m.kind === 'roundEnd' && m.winner !== slot) return { round: m.round, endTick: m.tick };
  }
  return null;
}

/** Runs both slots as clones from a fork for `horizon` ticks under one seed; returns whether `player` won. */
function simulateClones(fork: State, player: Slot, own: BuiltClone, opp: BuiltClone, horizon: number, seed: number): boolean {
  const other = (1 - player) as Slot;
  let s: State = { ...fork, rng: (fork.rng + seed * 2654435761) | 0 };
  for (let t = 0; t < horizon && s.phase === 'live'; t++) {
    const inputs: [Input, Input] = [IDLE, IDLE];
    inputs[player] = own.guarded.act(observe(s, player)).input;
    inputs[other] = opp.guarded.act(observe(s, other)).input;
    s = step(s, inputs).next;
  }
  return s.players[player].hp > 0 && s.players[other].hp <= 0;
}

/**
 * Builds one transfer case for a player in a match, or null if they never lost a round or lack opponent data.
 * `allMatches` must include this match so the clones can hold it out.
 */
export function transferCase(file: MatchFile, playerName: string, allMatches: MatchFile[], retries = 3): TransferCase | null {
  const slot = file.players.find((p) => p.name === playerName)?.slot;
  if (slot === undefined) return null;
  const lost = firstLostRound(file, slot);
  if (!lost) return null;
  const forkTick = Math.max(0, lost.endTick - 96); // ~3 s before the round was lost
  const opponent = (1 - slot) as Slot;
  const oppName = file.players.find((p) => p.slot === opponent)?.name ?? '';

  let oppBuilt: BuiltClone;
  try {
    const holdOut = matchesOf(allMatches, oppName).length > 1 ? [file.id] : [];
    oppBuilt = buildClone(oppName, { allMatches, holdOut });
  } catch {
    return null;
  }

  // Retries: the player's own clone vs the opponent clone, from the fork, under N seeds.
  const retryResults: TransferCase['retries'] = [];
  let ownBuilt: BuiltClone | null = null;
  try {
    const holdOut = matchesOf(allMatches, playerName).length > 1 ? [file.id] : [];
    ownBuilt = buildClone(playerName, { allMatches, holdOut });
  } catch {
    ownBuilt = null;
  }
  const fork = replayMatch(file, forkTick);
  if (ownBuilt) {
    for (let i = 0; i < retries; i++) {
      retryResults.push({ branch: i, playerWon: simulateClones(fork, slot, ownBuilt, oppBuilt, 96, i) });
    }
  }

  // Fresh attempt: the best what-if micro-plan from the same fork.
  const ranked = evaluatePlans(fork, slot, oppBuilt.guarded);
  const best = ranked[0] ?? null;

  return {
    matchId: file.id,
    player: playerName,
    round: lost.round,
    forkTick,
    firstAttempt: 'lost',
    retries: retryResults,
    freshAttempt: best ? { plan: best.label, winRate: best.winRate, survivalRate: best.survivalRate } : null,
  };
}
