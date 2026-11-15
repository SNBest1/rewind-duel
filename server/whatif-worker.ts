// Runs the what-if planner off the main thread, so 100 simulated futures never stall a live match.
import { parentPort, workerData } from 'node:worker_threads';
import type { Slot } from '@rewind/engine';
import { buildClone, loadMatches } from '../ai/clone/knn';
import type { Policy } from '../ai/clone/policy';
import { forkState } from '../ai/rewind/session';
import { PLANS, whatIf } from '../ai/rewind/whatif';
import { seededRng } from './ai';
import { BrainStore } from './brain';
import { AiAlonePolicy, PersonaPolicy, personSkill } from './persona';

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
  // The same opponent a rewind would face (the person and the AI together, D75), seeded per future and without
  // the belief map, which is the costly part over 100 futures of 5 seconds.
  const brains = new BrainStore(`${dataDir}brains/`);
  const skill = personSkill(brains.load(opponent));
  const knowsYou = brains.load(file.players.find((p) => p.slot === slot)?.name ?? 'you');
  const makePolicy = (seed: number): Policy =>
    useClone
      ? new PersonaPolicy(built.clone.fresh(), built.limit, skill, opp, file.map, knowsYou, seededRng(seed), undefined, true)
      : new AiAlonePolicy(opp, file.map, skill, knowsYou, undefined, seededRng(seed), true);
  const result = whatIf(file, tick, slot, makePolicy, PLANS, (done, total, best) => post({ t: 'progress', done, total, best }));
  post({ t: 'done', result: { ...result, opponent, clone: useClone ? `${opponent}'s habits (${built.trainSamples} decisions) + the AI at their rank` : `the AI at ${opponent}'s rank (not enough recordings for their habits)` } });
} catch (err) {
  post({ t: 'error', msg: (err as Error).message });
}
