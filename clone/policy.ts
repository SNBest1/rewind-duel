import type { Input, Observation } from '@rewind/engine';

/** A past moment a decision was copied from: match file id and tick. */
export type TraceRef = { match: string; tick: number };

/** One line of the behaviour trace: what drove the opponent and why. */
export type TraceLine = {
  tick: number;
  actor: 'GHOST' | 'CLONE' | 'BOT' | 'AI';
  type: string; // HANDOFF, BREAKER, COPY, PLAN, PREAIM, FLASH, DODGE, SKILL, ...
  reason: string;
  ref?: TraceRef;
};

export type Decision = { input: Input; confidence: number; because: TraceRef[] };

export interface Policy {
  name: string;
  act(obs: Observation): Decision;
}
