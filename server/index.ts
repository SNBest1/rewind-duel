// Match server. Run with: npm run server
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE, observe, visibleEvents, type Input, type Slot } from '@rewind/engine';
import { MatchRunner, sanitizeInput } from './match';
import { matchList, openSession, replayPayload, rosterData } from './rewind';
import { runWhatIf, DEMO_PRESETS, type RewindSession } from '@rewind/rewind';
import type { MatchFile } from '@rewind/engine';

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 1000 / TICK_RATE);
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url));
const MAX_ROOMS = 50; // the server may be public, so one visitor must not be able to open unlimited rooms
// Fake one-way network delay for testing client prediction on one machine. Round trip = 2 * LAG_MS.
const LAG_MS = Number(process.env.LAG_MS ?? 0);
const lagged = (fn: () => void) => (LAG_MS > 0 ? setTimeout(fn, LAG_MS) : fn());

type Room = {
  code: string;
  sockets: WebSocket[]; // index = slot
  names: string[];
  runner?: MatchRunner;
  timer?: NodeJS.Timeout;
};

const rooms = new Map<string, Room>();
const send = (ws: WebSocket, msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

function startMatch(room: Room): void {
  const id = `${room.code}-${Date.now()}`;
  const runner = new MatchRunner(id, Date.now() >>> 0, [room.names[0], room.names[1]]);
  room.runner = runner;
  room.sockets.forEach((ws) => send(ws, { t: 'start', names: room.names }));
  console.log(`[${room.code}] match ${id} started: ${room.names.join(' vs ')}`);

  // Ticks are scheduled against the start time, so a late timer catches up instead of drifting.
  const startedAt = performance.now();
  let ticked = 0;
  room.timer = setInterval(() => {
    while (room.runner && startedAt + ticked * TICK_MS <= performance.now()) {
      ticked++;
      const events = runner.tick();
      room.sockets.forEach((ws, slot) => {
        const msg = { t: 'obs', obs: observe(runner.state, slot as Slot), events: visibleEvents(runner.state, slot as Slot, events), ack: runner.acks[slot] };
        lagged(() => send(ws, msg));
      });
      if (runner.state.phase === 'matchEnd') finishMatch(room, 'finished');
    }
  }, 4);
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
  room.sockets.forEach((ws) => {
    send(ws, { t: 'end', matchId: file.id, why });
    ws.close();
  });
}

// The built client is read into memory once and served by exact path, so a request can never reach another file.
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const assets = new Map<string, { type: string; body: Buffer }>();
if (existsSync(WEB_DIST)) {
  for (const name of readdirSync(WEB_DIST, { recursive: true }) as string[]) {
    const type = MIME[extname(name)];
    if (type) assets.set('/' + name.replaceAll('\\', '/'), { type, body: readFileSync(WEB_DIST + name) });
  }
}
const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Rewind viewer JSON API. Read-only: lists recorded matches and serves one match's replay payload.
  if (path === '/api/matches') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(matchList(DATA_DIR)));
  }
  if (path === '/api/roster') {
    // Computed fresh from data/ each request so the roster page can poll it as matches land.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(rosterData(DATA_DIR)));
  }
  if (path === '/api/presets') {
    // The fixed demo forks, so the video loads the same engagement every take.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(DEMO_PRESETS));
  }
  if (path === '/api/replay') {
    const id = url.searchParams.get('id') ?? '';
    // The id becomes a file path, so restrict it to the same safe charset match ids use.
    if (!/^[a-z0-9-]{1,40}$/.test(id)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad id');
    }
    try {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(replayPayload(DATA_DIR, id)));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('match not found');
    }
  }

  const asset = assets.get(path === '/' ? '/index.html' : path);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(assets.size ? 'Not found' : 'Client not built. Run: npm run build');
  }
  res.writeHead(200, { 'content-type': asset.type });
  res.end(asset.body);
});

// 1 KB is plenty for a live input, but a rewind message carries the trace and a snapshot, so allow 256 KB.
const wss = new WebSocketServer({ server: http, maxPayload: 256 * 1024 });
wss.on('connection', (ws) => {
  let room: Room | undefined;
  let slot: Slot = 0;
  let rewind: RewindSession | undefined; // a rewind session on this socket, if any

  /** Sends the human's fogged observation plus a full both-sides snapshot and the branch trace so far. */
  const sendRewind = (events: unknown[] = []) => {
    if (!rewind) return;
    const s = rewind.state;
    send(ws, {
      t: 'rw',
      obs: observe(s, rewind.human),
      // The both-sides snapshot is allowed here: a rewind is the player reliving their own recorded match.
      enemy: { x: s.players[rewind.opponent].x, y: s.players[rewind.opponent].y, aim: s.players[rewind.opponent].aim, hp: s.players[rewind.opponent].hp },
      mode: rewind.mode,
      handoffTick: rewind.handoffTick,
      events,
      trace: rewind.trace.slice(-200),
      done: rewind.done,
    });
  };

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'join' && !room) {
      const code = String(msg.room ?? '').trim().toLowerCase();
      const name = String(msg.name ?? '').trim().slice(0, 16);
      // The room code becomes part of the match file name, so it is restricted to safe characters.
      if (!/^[a-z0-9-]{1,16}$/.test(code)) return send(ws, { t: 'error', msg: 'Room code: letters, numbers and dashes only' });
      if (!name) return send(ws, { t: 'error', msg: 'Name is required' });
      const existing = rooms.get(code);
      if (existing && existing.sockets.length >= 2) return send(ws, { t: 'error', msg: 'That room is full' });
      if (!existing && rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Server is full, try again later' });
      room = existing ?? { code, sockets: [], names: [] };
      rooms.set(code, room);
      slot = room.sockets.length as Slot;
      room.sockets.push(ws);
      room.names.push(name);
      send(ws, { t: 'joined', slot });
      if (room.sockets.length === 2) startMatch(room);
    } else if (msg.t === 'input' && room?.runner) {
      const r = room;
      lagged(() => r.runner?.setInput(slot, msg.input, msg.seq));
    } else if (msg.t === 'rewind') {
      // Open a rewind session: take control of `human` from `forkTick` of match `id`.
      const id = String(msg.id ?? '');
      const human = (msg.human === 1 ? 1 : 0) as Slot;
      const forkTick = Number.isSafeInteger(msg.forkTick) ? Math.max(0, msg.forkTick as number) : 0;
      if (!/^[a-z0-9-]{1,40}$/.test(id)) return send(ws, { t: 'error', msg: 'bad match id' });
      try {
        rewind = openSession(DATA_DIR, id, human, forkTick);
        send(ws, { t: 'rwopen', human, opponent: rewind.opponent, forkTick, divergenceLimit: rewind.limit });
        sendRewind();
      } catch (e) {
        send(ws, { t: 'error', msg: `could not open rewind: ${(e as Error).message}` });
      }
    } else if (msg.t === 'rwinput' && rewind) {
      // One tick of the rewind session with the human's input.
      const input: Input = sanitizeInput(msg.input);
      const events = rewind.tick(input);
      sendRewind(events);
    } else if (msg.t === 'retry' && rewind) {
      // End this branch, store its outcome, and reset to the fork tick.
      const outcome = rewind.endBranch();
      send(ws, { t: 'branch', outcome });
      sendRewind();
    } else if (msg.t === 'whatif') {
      // "What you could have done": rank the micro-plans from this fork, in a worker thread.
      const id = String(msg.id ?? '');
      const human = (msg.human === 1 ? 1 : 0) as Slot;
      const forkTick = Number.isSafeInteger(msg.forkTick) ? Math.max(0, msg.forkTick as number) : 0;
      if (!/^[a-z0-9-]{1,40}$/.test(id)) return send(ws, { t: 'error', msg: 'bad match id' });
      try {
        const file = JSON.parse(readFileSync(`${DATA_DIR}${id}.json`, 'utf8')) as MatchFile;
        runWhatIf(file, human, forkTick, 3)
          .then((out) => send(ws, { t: 'whatif', forkTick, ranInWorker: out.ranInWorker, results: out.results }))
          .catch((e) => send(ws, { t: 'error', msg: `what-if failed: ${(e as Error).message}` }));
      } catch (e) {
        send(ws, { t: 'error', msg: `what-if failed: ${(e as Error).message}` });
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (room.runner) finishMatch(room, 'disconnect');
    else if (rooms.get(room.code) === room) rooms.delete(room.code); // the only player left before the match started
  });
});

http.listen(PORT, () => {
  console.log(`Rewind Duel server on http://0.0.0.0:${PORT} (${(1000 / TICK_MS).toFixed(0)} ticks/s, client ${assets.size ? 'built' : 'NOT built'})`);
});
