// Spawns the what-if evaluation in a worker thread and resolves with the top plans. If the worker cannot
// start (for example a runtime without the tsx loader), it falls back to running inline on the caller's
// thread and says so, so a demo never silently returns nothing.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { MatchFile, Slot } from '@rewind/engine';
import { buildClone, loadMatches, matchesOf } from '@rewind/clone';
import { replayMatch } from '@rewind/engine';
import { evaluatePlans, type PlanResult } from './whatif';
import type { WhatIfJob } from './whatif-worker';

export type WhatIfOutcome = { results: PlanResult[]; ranInWorker: boolean };

/**
 * Runs the what-if for one fork of one match. Builds the opponent's guarded clone (holding out this match
 * when the opponent has others), then evaluates every micro-plan five times in a worker thread.
 */
export async function runWhatIf(file: MatchFile, human: Slot, forkTick: number, topN = 3): Promise<WhatIfOutcome> {
  const all = loadMatches();
  const opponent = (1 - human) as Slot;
  const oppName = file.players.find((p) => p.slot === opponent)?.name ?? '';
  const holdOut = matchesOf(all, oppName).length > 1 ? [file.id] : [];
  const built = buildClone(oppName, { allMatches: all, holdOut });

  const job: WhatIfJob = {
    file, human, forkTick, playerName: oppName,
    samples: built.samples, breakerLimit: built.breakerLimit, topN,
  };

  try {
    const results = await inWorker(job);
    return { results, ranInWorker: true };
  } catch {
    // Fallback: run on this thread. Correct, just not off the live loop.
    const fork = replayMatch(file, forkTick);
    return { results: evaluatePlans(fork, human, built.guarded).slice(0, topN), ranInWorker: false };
  }
}

function inWorker(job: WhatIfJob): Promise<PlanResult[]> {
  return new Promise((resolve, reject) => {
    const url = new URL('./whatif-worker.ts', import.meta.url);
    // Run the TS worker under the same tsx loader the parent uses.
    const w = new Worker(fileURLToPath(url), {
      workerData: job,
      execArgv: ['--import', 'tsx'],
    });
    w.once('message', (r: PlanResult[]) => { resolve(r); w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}
