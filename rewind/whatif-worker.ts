// The what-if evaluation, run inside a Node worker thread so it never blocks a live rewind session
// (spec Phase 4). A GuardedClone is a class instance and cannot cross the thread boundary, so the worker
// is handed the raw samples and the breaker limit and rebuilds the clone on its side.
import { parentPort, workerData } from 'node:worker_threads';
import type { MatchFile, Slot } from '@rewind/engine';
import { GuardedClone, KnnClone, type Sample } from '@rewind/clone';
import { replayMatch } from '@rewind/engine';
import { evaluatePlans } from './whatif';

export type WhatIfJob = {
  file: MatchFile;
  human: Slot;
  forkTick: number;
  playerName: string;
  samples: Sample[];
  breakerLimit: number;
  topN: number;
};

if (parentPort) {
  const job = workerData as WhatIfJob;
  const clone = new GuardedClone(new KnnClone(job.playerName, job.samples), job.breakerLimit);
  const fork = replayMatch(job.file, job.forkTick);
  const results = evaluatePlans(fork, job.human, clone).slice(0, job.topN);
  parentPort.postMessage(results);
}
