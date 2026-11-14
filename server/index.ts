// Match server. Run with: npm run server
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WebSocketServer, type WebSocket } from 'ws';
import { BUY_TICKS, MAP_IDS, TICK_RATE, WEAPONS, getMap, hashState, isMapId, observe, visibleEvents, type MatchFile, type Slot } from '@rewind/engine';
import { GuardedClone, buildClone, loadMatches } from '../ai/clone/knn';
import type { Policy, TraceLine } from '../ai/clone/policy';
import { forkState, RewindDriver, type BranchFile } from '../ai/rewind/session';
import { coachMoments } from '../ai/rewind/coach';
import { analyzeMatch, type MatchSummary } from '../ai/rewind/summary';
import { AiPlayer, BasicBot, parseDifficulty, type Difficulty } from './ai';
import { ALL_RANKS, rankOf } from './ranks';
import { BrainStore, Trainer, summarize } from './brain';
import { MatchRunner } from './match';

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 1000 / TICK_RATE);
// DATA_DIR lets a demo or a test run against its own folder of recordings.
const DATA_DIR = process.env.DATA_DIR ? `${resolve(process.env.DATA_DIR)}${sep}` : fileURLToPath(new URL('../data/', import.meta.url));
const BRANCH_DIR = `${DATA_DIR}branches/`;
const WEB_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url));
const MAX_ROOMS = 50; // the server may be public, so one visitor must not be able to open unlimited rooms
// Fake one-way network delay for testing client prediction on one machine. Round trip = 2 * LAG_MS.
const LAG_MS = Number(process.env.LAG_MS ?? 0);
const lagged = (fn: () => void) => (LAG_MS > 0 ? setTimeout(fn, LAG_MS) : fn());
/** Match ids become file names, so they are restricted to safe characters. */
const SAFE_ID = /^[a-z0-9-]{1,64}$/;
/** A clone needs at least this many recorded decisions to be worth using; below it the basic bot plays. */
const MIN_CLONE_SAMPLES = 60;

type Rewind = {
  file: MatchFile;
  forkTick: number;
  human: Slot;
  driver: RewindDriver;
  guarded: GuardedClone | null;
  opponent: string;
};

type Room = {
  code: string;
  sockets: WebSocket[]; // index = slot; AI and rewind rooms have one human socket
  names: string[];
  /** Each player's map vote: a map id or 'random'. */
  votes: string[];
  ai?: { difficulty: Difficulty; bot?: AiPlayer };
  /** Mirror mode: slot 1 is a clone of the human in slot 0, built from their own recordings. */
  mirror?: { built: ReturnType<typeof buildClone>; policy?: GuardedClone; samples: number; matches: number; buy: number[]; bought: number };
  rewind?: Rewind;
  trainers: Trainer[];
  /** Behaviour trace lines waiting to go out with the next observation. */
  trace: TraceLine[];
  runner?: MatchRunner;
  timer?: NodeJS.Timeout;
};

const rooms = new Map<string, Room>();
const brains = new BrainStore(`${DATA_DIR}brains/`);
const send = (ws: WebSocket | undefined, msg: object) => ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const pickRandom = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const shortId = () => Math.random().toString(36).slice(2, 8);

/** Agreed votes win; a 'random' vote defers to the other; two different picks are a coin flip between them. */
function resolveMap(votes: string[]): string {
  const real = votes.filter(isMapId);
  if (real.length === 0) return pickRandom(MAP_IDS);
  return pickRandom(real);
}

// --- recorded matches -----------------------------------------------------------------------------

function loadMatch(id: string): MatchFile | null {
  if (!SAFE_ID.test(id)) return null;
  const p = `${DATA_DIR}${id}.json`;
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MatchFile;
  } catch {
    return null;
  }
}

function loadBranches(matchId: string): BranchFile[] {
  const p = `${BRANCH_DIR}${matchId}.json`;
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as BranchFile[];
  } catch {
    return [];
  }
}

/** Summaries are a full replay each, so they are cached by id. Match files never change once written. */
const summaries = new Map<string, MatchSummary>();
function summaryOf(file: MatchFile): MatchSummary {
  let s = summaries.get(file.id);
  if (!s) summaries.set(file.id, (s = analyzeMatch(file, false)));
  return s;
}

// --- live matches ---------------------------------------------------------------------------------

/** Runs a room's tick loop. `beforeTick` lets the room drive bot or ghost slots; `afterTick` sees the events. */
function runLoop(room: Room, runner: MatchRunner, beforeTick: () => void, afterTick: (events: ReturnType<MatchRunner['tick']>) => boolean): void {
  // Ticks are scheduled against the start time, so a late timer catches up instead of drifting.
  const startedAt = performance.now();
  let ticked = 0;
  room.timer = setInterval(() => {
    while (room.runner && startedAt + ticked * TICK_MS <= performance.now()) {
      ticked++;
      beforeTick();
      const events = runner.tick();
      // forEach, not for-of: a rewind room's arrays are indexed by slot and may have a hole at slot 0.
      room.trainers.forEach((t) => t.observe(runner.state, events));
      const trace = room.trace.splice(0);
      room.sockets.forEach((ws, slot) => {
        const msg = {
          t: 'obs', obs: observe(runner.state, slot as Slot), events: visibleEvents(runner.state, slot as Slot, events),
          ack: runner.acks[slot], trace,
          // The AI's current level (0-100), so the HUD can show it adapting round by round.
          aiLevel: room.ai?.bot ? Math.round(room.ai.bot.skill * 100) : undefined,
          // Four times a second: the AI's belief of where you are, so the page can show its mind.
          mind: room.ai?.bot && runner.state.tick % 8 === 0 ? room.ai.bot.belief.snapshot() : undefined,
          // Ranks, a few times a second: the AI's current rank, yours, and how often it has read you right.
          ranks: room.ai?.bot && runner.state.tick % 8 === 0 && room.trainers[0]
            ? { ai: rankOf(room.ai.bot.skill), you: rankOf(room.trainers[0].brain.skill), reads: room.trainers[0].brain.reads ?? { made: 0, correct: 0 } }
            : undefined,
        };
        lagged(() => send(ws, msg));
      });
      if (afterTick(events)) return;
    }
  }, 4);
}

function startMatch(room: Room): void {
  const id = `${room.code}-${Date.now()}`;
  const mapId = resolveMap(room.votes);
  // Every new live match uses the VALORANT rules: credits, shields, the real armory.
  const runner = new MatchRunner(id, Date.now() >>> 0, [room.names[0], room.names[1]], mapId, undefined, 'valorant');
  room.runner = runner;

  // Every human gets studied, in AI matches and human matches alike. Only AI matches move the adaptive skill.
  room.trainers = room.sockets.map((_, slot) => {
    const human = slot as Slot;
    return new Trainer(brains.load(room.names[slot]), human, room.ai ? 1 : null, room.ai?.difficulty === 'adaptive');
  });
  if (room.ai) {
    const bot = new AiPlayer(1, mapId, room.trainers[0].brain, room.ai.difficulty);
    bot.onTrace = (t) => room.trace.push(t);
    room.ai.bot = bot;
  }

  if (room.mirror) {
    // Built now that the map is known: the clone's fallback bot needs the map's navigation grid.
    const m = room.mirror;
    m.policy = new GuardedClone(m.built.clone.fresh(), new BasicBot(1, mapId), m.built.limit, (t) => room.trace.push(t));
  }

  room.sockets.forEach((ws, slot) => send(ws, {
    t: 'start', names: room.names, map: mapId, votes: room.votes,
    ai: room.ai ? { difficulty: room.ai.difficulty, skill: room.ai.bot!.skill, rank: rankOf(room.ai.bot!.skill) } : null,
    mirror: room.mirror ? { samples: room.mirror.samples, matches: room.mirror.matches } : null,
    brain: summarize(room.trainers[slot].brain),
  }));
  console.log(`[${room.code}] match ${id} on ${mapId} started: ${room.names.join(' vs ')}`);

  runLoop(room, runner, () => {
    const bot = room.ai?.bot;
    // The bot decides from its own fogged observation, exactly like a client, and its input is logged like one.
    if (bot) runner.setInput(bot.slot, bot.think(observe(runner.state, bot.slot)));
    const mirror = room.mirror;
    if (mirror?.policy) {
      const input = mirror.policy.act(observe(runner.state, 1)).input;
      // Your clone carries your guns: it buys your favourite loadout in the buy phase, one item per tick.
      if (runner.state.roundTicks === 0) mirror.bought = 0;
      if (runner.state.phase === 'live' && runner.state.roundTicks < BUY_TICKS && mirror.bought < mirror.buy.length) {
        input.buy = mirror.buy[mirror.bought++];
      }
      runner.setInput(1, input);
    }
  }, (events) => {
    if (room.ai?.bot && events.some((e) => e.type === 'roundEnd')) checkCall(room);
    if (runner.state.phase === 'matchEnd') {
      finishMatch(room, 'finished');
      return true;
    }
    return false;
  });
}

/** When a round ends, compare the AI's call ("you are hitting B") with where the human really went. */
function checkCall(room: Room): void {
  const bot = room.ai!.bot!;
  const truth = room.trainers[0]?.lastRound;
  const call = bot.prediction;
  if (!call || !truth || !truth.site || call.attacking !== truth.humanAttacked) return;
  const brain = room.trainers[0].brain;
  brain.reads ??= { made: 0, correct: 0 };
  brain.reads.made++;
  const right = call.site === truth.site;
  if (right) brain.reads.correct++;
  room.trace.push({
    tick: room.runner!.state.tick, actor: 'AI', type: right ? 'CALLED' : 'MISREAD',
    reason: right
      ? `✓ called it ${((room.runner!.state.tick - call.tick) / TICK_RATE).toFixed(0)}s early: you ${truth.humanAttacked ? 'hit' : 'held'} ${truth.site} (${brain.reads.correct}/${brain.reads.made} reads)`
      : `✗ I said ${call.site}, you ${truth.humanAttacked ? 'hit' : 'held'} ${truth.site} (${brain.reads.correct}/${brain.reads.made} reads)`,
  });
  bot.prediction = null;
}

function finishMatch(room: Room, why: string): void {
  const runner = room.runner;
  if (!runner) return;
  clearInterval(room.timer);
  room.runner = undefined;
  rooms.delete(room.code);
  const file = runner.toFile();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}${file.id}.json`, JSON.stringify(file));
  console.log(`[${room.code}] ${why} at tick ${file.ticks}, hash ${file.finalHash}, wrote data/${file.id}.json`);
  // Save what was learned, even from a match cut short by a disconnect.
  for (const t of room.trainers) {
    t.finishMatch();
    brains.save(t.brain);
  }
  // Against the AI or your clone, the coach reviews your deaths in the background.
  const coach = room.ai || room.mirror ? startCoach(file, 0) : 0;
  room.sockets.forEach((ws, slot) => {
    send(ws, { t: 'end', matchId: file.id, why, brain: room.trainers[slot] ? summarize(room.trainers[slot].brain) : null, coach });
    ws.close();
  });
}

// --- rewind sessions --------------------------------------------------------------------------------

/**
 * Jump into a recorded match at `forkTick` as `human`. The opponent replays its recorded inputs (ghost) until the
 * fight diverges, then a clone of that real player, built from all their recorded matches, takes over.
 */
function startRewind(ws: WebSocket, file: MatchFile, forkTick: number, human: Slot, name: string): Room | string {
  const start = forkState(file, forkTick);
  if (start.phase !== 'live') return 'Pick a moment during a live round, not between rounds.';
  const opp = (1 - human) as Slot;
  const opponent = file.players.find((p) => p.slot === opp)?.name ?? 'opponent';
  const code = `rw-${shortId()}`;
  const room: Room = { code, sockets: [], names: file.players.map((p) => p.name), votes: [], trainers: [], trace: [] };
  room.sockets[human] = ws;

  // The clone of the opponent. Built from every recorded match they played, this one included.
  const built = buildClone(opponent, loadMatches(DATA_DIR));
  const useClone = built.trainSamples >= MIN_CLONE_SAMPLES;
  let guarded: GuardedClone | null = null;
  const makePolicy = (): Policy => {
    const fallback = new BasicBot(opp, file.map);
    if (!useClone) return fallback;
    guarded = new GuardedClone(built.clone.fresh(), fallback, built.limit, (t) => room.trace.push(t));
    rewind.guarded = guarded;
    return guarded;
  };
  const driver = new RewindDriver(file, forkTick, human, makePolicy, (t) => room.trace.push(t));
  const rewind: Rewind = { file, forkTick, human, driver, guarded, opponent };
  room.rewind = rewind;
  if (!useClone) {
    room.trace.push({ tick: forkTick, actor: 'BOT', type: 'NOTE', reason: `only ${built.trainSamples} recorded decisions of ${opponent}: the basic bot will stand in after the handoff` });
  }

  const branchNo = loadBranches(file.id).length + 1;
  const runner = new MatchRunner(`${file.id}-b${branchNo}`, file.seed, [room.names[0], room.names[1]], file.map, start);
  room.runner = runner;
  room.trainers = [];
  // The human is still being studied while they retry, so the AI learns from rewinds too.
  const trainer = new Trainer(brains.load(name), human, opp, false);
  room.trainers[human] = trainer;
  rooms.set(code, room);

  const original = summaryOf(file).rounds.find((r) => r.round === start.round);
  send(ws, {
    t: 'start', names: room.names, map: file.map, votes: [], ai: null, brain: summarize(trainer.brain),
    rewind: {
      match: file.id, tick: forkTick, round: start.round, roundStartTick: forkTick - start.roundTicks, opponent, branch: branchNo,
      originalOutcome: original?.winner === null || original?.winner === undefined ? null : original.winner === human ? 'won' : 'lost',
      clone: { samples: built.trainSamples, matches: built.matches.length, limit: Math.round(built.limit * 100) / 100, used: useClone },
    },
  });
  console.log(`[${code}] rewind of ${file.id} at tick ${forkTick}, ${name} as slot ${human} vs ${opponent} (${built.trainSamples} decisions)`);

  runLoop(room, runner, () => {
    runner.setInput(opp, driver.opponentInput(runner.state));
  }, (events) => {
    const end = events.find((e) => e.type === 'roundEnd');
    if (end && end.type === 'roundEnd') {
      finishRewind(room, end.winner === human ? 'won' : 'lost', end.reason);
      return true;
    }
    return false;
  });
  return room;
}

function finishRewind(room: Room, outcome: 'won' | 'lost' | 'abandoned', reason: string): void {
  const runner = room.runner;
  const rw = room.rewind;
  if (!runner || !rw) return;
  clearInterval(room.timer);
  room.runner = undefined;
  rooms.delete(room.code);
  const branches = loadBranches(rw.file.id);
  if (outcome !== 'abandoned') {
    const g = rw.guarded as GuardedClone | null;
    const branch: BranchFile = {
      match: rw.file.id, forkTick: rw.forkTick, human: rw.human, opponent: rw.opponent,
      inputs: runner.inputLog, ticks: runner.state.tick, finalHash: hashState(runner.state),
      outcome, reason, handoffTick: rw.driver.handoffTick, breakerTicks: g?.ticksOnBreaker ?? 0, at: new Date().toISOString(),
    };
    branches.push(branch);
    mkdirSync(BRANCH_DIR, { recursive: true });
    writeFileSync(`${BRANCH_DIR}${rw.file.id}.json`, JSON.stringify(branches));
  }
  for (const t of room.trainers) {
    if (!t) continue;
    brains.save(t.brain);
  }
  const fromHere = branches.filter((b) => b.forkTick === rw.forkTick && b.human === rw.human);
  const g = rw.guarded as GuardedClone | null;
  console.log(`[${room.code}] rewind ${outcome} (${reason}), handoff at ${rw.driver.handoffTick ?? 'never'}`);
  const ws = room.sockets[rw.human];
  send(ws, {
    t: 'end', matchId: rw.file.id, why: 'rewind', brain: room.trainers[rw.human] ? summarize(room.trainers[rw.human].brain) : null,
    rewind: {
      outcome, reason, match: rw.file.id, tick: rw.forkTick, slot: rw.human,
      attempts: fromHere.length, wins: fromHere.filter((b) => b.outcome === 'won').length,
      handoffTick: rw.driver.handoffTick, ghostSeconds: rw.driver.handoffTick === null ? null : Math.round(((rw.driver.handoffTick - rw.forkTick) / TICK_RATE) * 10) / 10,
      breakerShare: g && g.ticks ? Math.round((100 * g.ticksOnBreaker) / g.ticks) : 0,
    },
  });
  ws?.close();
}

// --- what-if jobs: ~100 simulated futures from a moment, in a worker thread --------------------------

type WhatIfJob = { id: string; key: string; status: 'running' | 'done' | 'error'; done: number; total: number; best: string; result?: unknown; error?: string; at: number };
const whatIfJobs = new Map<string, WhatIfJob>();
let whatIfRunning = 0;

/**
 * Starts (or reuses) a what-if job. One runs at a time: each is a few seconds of full CPU, and this machine
 * may also be hosting live matches. A finished job for the same moment is reused.
 */
function startWhatIf(matchId: string, tick: number, slot: Slot): WhatIfJob {
  const key = `${matchId}@${tick}/${slot}`;
  for (const j of whatIfJobs.values()) if (j.key === key && j.status !== 'error') return j;
  for (const [id, j] of whatIfJobs) if (Date.now() - j.at > 15 * 60_000) whatIfJobs.delete(id);
  const job: WhatIfJob = { id: shortId(), key, status: 'running', done: 0, total: 1, best: '', at: Date.now() };
  whatIfJobs.set(job.id, job);
  if (whatIfRunning >= 1) {
    job.status = 'error';
    job.error = 'Another what-if is still running. Try again in a few seconds.';
    return job;
  }
  whatIfRunning++;
  // The worker is TypeScript too, so it needs tsx's loader. Under a plain `node` build this would point at a .js file.
  const worker = new Worker(new URL('./whatif-worker.ts', import.meta.url), {
    workerData: { dataDir: DATA_DIR, matchId, tick, slot },
    execArgv: ['--import', 'tsx'],
    resourceLimits: { maxOldGenerationSizeMb: 384 },
  });
  const finish = () => {
    whatIfRunning = Math.max(0, whatIfRunning - 1);
  };
  worker.on('message', (m: { t: string; done?: number; total?: number; best?: string; result?: unknown; msg?: string }) => {
    if (m.t === 'progress') Object.assign(job, { done: m.done, total: m.total, best: m.best });
    else if (m.t === 'done') Object.assign(job, { status: 'done', result: m.result, done: job.total });
    else if (m.t === 'error') Object.assign(job, { status: 'error', error: m.msg });
  });
  worker.on('error', (e: Error) => Object.assign(job, { status: 'error', error: e.message }));
  worker.on('exit', () => {
    finish();
    if (job.status === 'running') Object.assign(job, { status: 'error', error: 'the planner stopped unexpectedly' });
  });
  console.log(`[whatif ${job.id}] ${key}`);
  return job;
}

// --- AI coach: after a match, review each death with the what-if planner ----------------------------

type CoachItem = { round: number; tick: number; deathTick: number; status: 'waiting' | 'running' | 'done' | 'error'; result?: unknown; error?: string };
type Coach = { match: string; human: Slot; items: CoachItem[]; at: number };
const coaches = new Map<string, Coach>();

/**
 * Picks the moments worth reviewing (3 seconds before each of the human's last 3 deaths) and runs the
 * what-if planner on them one after another, in the background. The result screen polls /api/coach/:match.
 */
function startCoach(file: MatchFile, human: Slot): number {
  const moments = coachMoments(file, human);
  if (!moments.length) return 0;
  for (const [id, c] of coaches) if (Date.now() - c.at > 30 * 60_000) coaches.delete(id);
  coaches.set(file.id, { match: file.id, human, at: Date.now(), items: moments.map((m) => ({ ...m, status: 'waiting' })) });
  void runCoach(file.id);
  return moments.length;
}

async function runCoach(matchId: string): Promise<void> {
  const coach = coaches.get(matchId);
  if (!coach) return;
  for (const item of coach.items) {
    item.status = 'running';
    // One planner at a time on this machine: wait for any other job to finish first.
    let job = startWhatIf(matchId, item.tick, coach.human);
    for (let tries = 0; job.status === 'error' && /still running/.test(job.error ?? '') && tries < 60; tries++) {
      whatIfJobs.delete(job.id);
      await new Promise((r) => setTimeout(r, 1000));
      job = startWhatIf(matchId, item.tick, coach.human);
    }
    while (job.status === 'running') await new Promise((r) => setTimeout(r, 400));
    if (job.status === 'done') Object.assign(item, { status: 'done', result: job.result });
    else Object.assign(item, { status: 'error', error: job.error });
  }
}

// --- http: the built client and a small read-only API for the replay viewer ------------------------

// The built client is read into memory once and served by exact path, so a request can never reach another file.
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const assets = new Map<string, { type: string; body: Buffer }>();
if (existsSync(WEB_DIST)) {
  for (const name of readdirSync(WEB_DIST, { recursive: true }) as string[]) {
    const type = MIME[extname(name)];
    if (type) assets.set('/' + name.replaceAll('\\', '/'), { type, body: readFileSync(WEB_DIST + name) });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  // Read-only and public by design (it is the same data anyone in the match saw), so any origin may read it.
  // That is what lets the Vite dev page on :5173 call the game server on :8080.
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

const http = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  // Bumped whenever the client and server must change together. The page refuses to guess with an old server.
  if (req.method === 'GET' && path === '/api/version') return json(res, 200, { version: 3 });
  if (req.method === 'GET' && path === '/api/matches') {
    const list = loadMatches(DATA_DIR)
      .map((f) => ({ ...summaryOf(f), branches: loadBranches(f.id).length }))
      .sort((a, b) => b.id.localeCompare(a.id));
    return json(res, 200, list);
  }
  if (path === '/api/whatif' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  if (path === '/api/whatif' && req.method === 'POST') {
    const q = new URL(req.url ?? '', 'http://x').searchParams;
    const matchId = q.get('match') ?? '';
    const tick = Number(q.get('tick'));
    const slot = (q.get('slot') === '1' ? 1 : 0) as Slot;
    const file = loadMatch(matchId);
    if (!file) return json(res, 404, { error: 'no such match' });
    if (!Number.isInteger(tick) || tick < 0 || tick >= file.ticks) return json(res, 400, { error: 'tick outside the match' });
    return json(res, 200, startWhatIf(matchId, tick, slot));
  }
  const cj = /^\/api\/coach\/([a-z0-9-]+)$/.exec(path);
  if (req.method === 'GET' && cj) {
    const c = coaches.get(cj[1]);
    if (!c) return json(res, 404, { error: 'no review for that match' });
    return json(res, 200, c);
  }
  const wj = /^\/api\/whatif\/([a-z0-9]+)$/.exec(path);
  if (req.method === 'GET' && wj) {
    const job = whatIfJobs.get(wj[1]);
    if (!job) return json(res, 404, { error: 'no such job' });
    return json(res, 200, job);
  }
  const m = /^\/api\/matches\/([a-z0-9-]+)$/.exec(path);
  if (req.method === 'GET' && m) {
    const file = loadMatch(m[1]);
    if (!file) return json(res, 404, { error: 'no such match' });
    return json(res, 200, { ...analyzeMatch(file, true), branches: loadBranches(file.id).map(({ inputs, ...b }) => b) });
  }
  const asset = assets.get(path === '/' ? '/index.html' : path);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(assets.size ? 'Not found' : 'Client not built. Run: npm run build');
  }
  res.writeHead(200, { 'content-type': asset.type });
  res.end(asset.body);
});

// --- websocket: join a match, an AI match or a rewind ----------------------------------------------

const wss = new WebSocketServer({ server: http, maxPayload: 1024 });
wss.on('connection', (ws) => {
  let room: Room | undefined;
  let slot: Slot = 0;

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'join' && !room) {
      const name = String(msg.name ?? '').trim().slice(0, 16);
      if (!name) return send(ws, { t: 'error', msg: 'Name is required' });
      const vote = isMapId(msg.map) ? msg.map : 'random';
      const full = () => send(ws, { t: 'error', msg: 'Server is full, try again later' });

      if (msg.mode === 'rewind') {
        if (rooms.size >= MAX_ROOMS) return full();
        const file = loadMatch(String(msg.match ?? ''));
        if (!file) return send(ws, { t: 'error', msg: 'That match file was not found' });
        const tick = Number(msg.tick);
        if (!Number.isInteger(tick) || tick < 0 || tick >= file.ticks) return send(ws, { t: 'error', msg: 'That moment is outside the match' });
        const human = (msg.slot === 1 ? 1 : 0) as Slot;
        const r = startRewind(ws, file, tick, human, name);
        if (typeof r === 'string') return send(ws, { t: 'error', msg: r });
        room = r;
        slot = human;
        return;
      }

      if (msg.mode === 'ai') {
        if (rooms.size >= MAX_ROOMS) return full();
        const difficulty = parseDifficulty(msg.difficulty);
        const label = difficulty.startsWith('rank:') ? ALL_RANKS[Number(difficulty.slice(5))].label : difficulty;
        // A private room for you and the bot. The code only needs to be unique and file-name safe.
        const code = `ai-${shortId()}`;
        room = { code, sockets: [ws], names: [name, `AI ${label}`], votes: [vote], ai: { difficulty }, trainers: [], trace: [] };
        rooms.set(code, room);
        slot = 0;
        send(ws, { t: 'joined', slot });
        startMatch(room);
        return;
      }

      if (msg.mode === 'mirror') {
        // Fight yourself: a clone of you, built from every match you have recorded.
        if (rooms.size >= MAX_ROOMS) return full();
        const built = buildClone(name, loadMatches(DATA_DIR));
        if (built.trainSamples < MIN_CLONE_SAMPLES) {
          return send(ws, { t: 'error', msg: `Not enough recordings of "${name}" yet (${built.trainSamples} decisions). Play a match or two under this name first.` });
        }
        const brain = brains.load(name);
        const fav = (kind: 'primary' | 'secondary') =>
          Object.entries(brain.weapons ?? {}).map(([id, n]) => [Number(id), n] as const)
            .filter(([id]) => WEAPONS[id]?.kind === kind).sort((a, b) => b[1] - a[1])[0]?.[0];
        const buy = [fav('primary') ?? 0, fav('secondary') ?? 1];
        const code = `ai-${shortId()}`;
        room = {
          code, sockets: [ws], names: [name, `${name}'s clone`], votes: [vote], trainers: [], trace: [],
          mirror: { built, samples: built.trainSamples, matches: built.matches.length, buy, bought: 0 },
        };
        rooms.set(code, room);
        slot = 0;
        send(ws, { t: 'joined', slot });
        startMatch(room);
        return;
      }

      const code = String(msg.room ?? '').trim().toLowerCase();
      // The room code becomes part of the match file name, so it is restricted to safe characters.
      if (!/^[a-z0-9-]{1,16}$/.test(code) || code.startsWith('ai-') || code.startsWith('rw-')) return send(ws, { t: 'error', msg: 'Room code: letters, numbers and dashes only' });
      const existing = rooms.get(code);
      if (existing && existing.sockets.length >= 2) return send(ws, { t: 'error', msg: 'That room is full' });
      if (!existing && rooms.size >= MAX_ROOMS) return full();
      room = existing ?? { code, sockets: [], names: [], votes: [], trainers: [], trace: [] };
      rooms.set(code, room);
      slot = room.sockets.length as Slot;
      room.sockets.push(ws);
      room.names.push(name);
      room.votes.push(vote);
      send(ws, { t: 'joined', slot, votes: room.votes.map((v) => (v === 'random' ? 'Random' : getMap(v).name)) });
      if (room.sockets.length === 2) startMatch(room);
    } else if (msg.t === 'input' && room?.runner) {
      const r = room;
      lagged(() => r.runner?.setInput(slot, msg.input, msg.seq));
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (room.rewind) finishRewind(room, 'abandoned', 'left');
    else if (room.runner) finishMatch(room, 'disconnect');
    else if (rooms.get(room.code) === room) rooms.delete(room.code); // the only player left before the match started
  });
});

http.listen(PORT, () => {
  console.log(`Rewind Duel server on http://0.0.0.0:${PORT} (${(1000 / TICK_MS).toFixed(0)} ticks/s, client ${assets.size ? 'built' : 'NOT built'})`);
});
