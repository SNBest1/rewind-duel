// Runs the what-if planner off the main thread, so 100 simulated futures never stall a live match.
import { parentPort, workerData } from 'node:worker_threads';
import type { Slot } from '@rewind/engine';
import { GuardedClone, buildClone, loadMatches } from '../clone/knn';
import type { Policy } from '../clone/policy';
import { forkState } from '../rewind/session';
import { PLANS, whatIf } from '../rewind/whatif';
import { BasicBot, seededRng } from './ai';

const { dataDir, matchId, tick, slot } = workerData as { dataDir: string; matchId: string; tick: number; slot: Slot };
const post = (m: object) => parentPort!.postMessage(m);

try {
  const files = loadMatches(dataDir);
  const file = files.find((f) => f.id === matchId);
  if (!file) throw new Error('match not found');
  if (forkState(file, tick).phase !== 'live') throw new Error('pick a moment during a live round');
  const opp = (1 - slot) as Slot;
  const opponent = file.players.find((p) => p.slot === opp)?.name ?? 'opponent';
  const built = buildClone(opponent, files);
  const useClone = built.trainSamples >= 60;
  const makePolicy = (seed: number): Policy => {
    const bot = new BasicBot(opp, file.map, seededRng(seed));
    return useClone ? new GuardedClone(built.clone.fresh(), bot, built.limit) : bot;
  };
  const result = whatIf(file, tick, slot, makePolicy, PLANS, (done, total, best) => post({ t: 'progress', done, total, best }));
  post({ t: 'done', result: { ...result, opponent, clone: useClone ? `clone of ${opponent} (${built.trainSamples} decisions)` : 'basic bot (not enough recordings for a clone)' } });
} catch (err) {
  post({ t: 'error', msg: (err as Error).message });
}
