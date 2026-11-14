// Match server. Run with: npm run server
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { TICK_RATE, observe, visibleEvents, type Slot } from '@rewind/engine';
import { MatchRunner } from './match';

const PORT = Number(process.env.PORT ?? 8080);
const TICK_MS = Number(process.env.TICK_MS ?? 1000 / TICK_RATE);
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../web/dist/', import.meta.url));
const MAX_ROOMS = 50; // the server may be public, so one visitor must not be able to open unlimited rooms

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
        send(ws, { t: 'obs', obs: observe(runner.state, slot as Slot), events: visibleEvents(runner.state, slot as Slot, events) });
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
  const path = (req.url ?? '/').split('?')[0];
  const asset = assets.get(path === '/' ? '/index.html' : path);
  if (!asset) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(assets.size ? 'Not found' : 'Client not built. Run: npm run build');
  }
  res.writeHead(200, { 'content-type': asset.type });
  res.end(asset.body);
});

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
      room.runner.setInput(slot, msg.input);
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
