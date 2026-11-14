// Rewind Duel client. The server decides everything; this file sends inputs and draws the Observation it is allowed.
// The one thing it computes itself is a prediction of its own movement (predict.ts), for display only.
import { C, TICK_RATE, getMap, rayCircle, rayWalls, type GameEvent, type Input, type Observation } from '@rewind/engine';
import { initAudio, sfx, toggleMute } from './audio';
import { Predictor } from './predict';

const map = getMap('duel');
const $ = (id: string) => document.getElementById(id)!;
const arena = $('arena') as HTMLCanvasElement;
const ctx = arena.getContext('2d')!;
const tape = $('tape') as HTMLCanvasElement;
const tctx = tape.getContext('2d')!;
const fog = document.createElement('canvas');
const fogCtx = fog.getContext('2d')!;

// Same values as the CSS tokens in index.html.
const OXIDE = '#4b3a2e';
const OXIDE_DARK = '#1d1612';
const BAKELITE = '#8b735f';
const BAKELITE_EDGE = '#b39a80';
const LABEL = '#efe2c9';
const DIM = '#9c8a78';
const VU = '#ffb547';
const ICE = '#7fd6e8';
const REC = '#e5483b';
const DISPLAY = '"Big Shoulders Display", Impact, sans-serif';
const MONO = '"Martian Mono", ui-monospace, monospace';
const TAPE_H = 30;

let scale = 20;
let dpr = 1;
function resize(): void {
  dpr = devicePixelRatio || 1;
  scale = Math.max(8, Math.floor(Math.min((innerWidth - 32) / map.width, (innerHeight - 44 - TAPE_H - 48 - 16) / map.height)));
  const w = map.width * scale;
  const h = map.height * scale;
  for (const c of [arena, fog]) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  arena.style.width = `${w}px`;
  arena.style.height = `${h}px`;
  tape.width = w * dpr;
  tape.height = TAPE_H * dpr;
  tape.style.width = `${w}px`;
  tape.style.height = `${TAPE_H}px`;
  $('deck').style.width = `${w}px`;
}
addEventListener('resize', resize);
resize();

// --- match state as this client knows it ---------------------------------------------------------

let ws: WebSocket | null = null;
let obs: Observation | null = null;
let names: string[] = [];
const predictor = new Predictor();

/** Positions actually drawn: they chase their targets so 32 Hz updates look smooth at any frame rate. */
let selfDraw: { x: number; y: number } | null = null;
let enemyDraw: { x: number; y: number } | null = null;

type Tracer = { x: number; y: number; toX: number; toY: number; mine: boolean; until: number };
let tracers: Tracer[] = [];
let hitUntil = 0;
let hurtUntil = 0;
let hurtFrom = 0; // angle from you towards whoever hit you
let banner: { title: string; sub: string; color: string } | null = null;
let nextBeep = 0;

/** The round as a tape: what happened at which tick since the round began. */
type Stamp = { t: number; kind: 'shot' | 'hit' | 'hurt' | 'smoke' | 'dash' | 'plant' | 'kill' | 'death' };
let roundStartTick = 0;
let plantedAt: number | null = null;
let stamps: Stamp[] = [];
let seen: [number, number][] = []; // tick spans in which the rival was visible

const elapsed = () => (obs ? obs.tick - roundStartTick : 0);
/** Stereo pan for a sound at map x, relative to where you stand. */
const panFor = (x: number) => (selfDraw ? (x - selfDraw.x) / 20 : 0);

function onEvents(events: GameEvent[], me: number): void {
  const now = performance.now();
  for (const e of events) {
    const t = e.tick - roundStartTick;
    if (e.type === 'shot') {
      const mine = e.slot === me;
      tracers.push({ x: e.x, y: e.y, toX: e.toX, toY: e.toY, mine, until: now + 110 });
      sfx.shot(mine, panFor(e.x));
      if (mine) {
        stamps.push({ t, kind: e.hit ? 'hit' : 'shot' });
        if (e.hit) {
          hitUntil = now + 160;
          sfx.hit();
        }
      } else if (e.hit) {
        stamps.push({ t, kind: 'hurt' });
        hurtUntil = now + 900;
        if (selfDraw) hurtFrom = Math.atan2(e.y - selfDraw.y, e.x - selfDraw.x);
        sfx.hurt(panFor(e.x));
      }
    } else if (e.type === 'kill') {
      stamps.push({ t, kind: e.killer === me ? 'kill' : 'death' });
      if (e.killer === me) sfx.kill();
    } else if (e.type === 'smoke') {
      stamps.push({ t, kind: 'smoke' });
      sfx.smoke(panFor(e.x));
    } else if (e.type === 'dash') {
      if (e.slot === me) stamps.push({ t, kind: 'dash' });
      sfx.dash(e.slot === me || !obs?.enemy ? 0 : panFor(obs.enemy.x));
    } else if (e.type === 'plant') {
      plantedAt = t;
      stamps.push({ t, kind: 'plant' });
      sfx.plant();
    } else if (e.type === 'roundEnd') {
      const won = e.winner === me;
      const why = { kill: 'Elimination', time: 'Time ran out', defuse: 'Spike defused', detonation: 'Spike detonated' }[e.reason];
      banner = { title: won ? 'Round won' : 'Round lost', sub: why, color: won ? VU : ICE };
      sfx.roundEnd(won);
    } else if (e.type === 'roundStart') {
      banner = null;
      roundStartTick = e.tick;
      plantedAt = null;
      stamps = [];
      seen = [];
      selfDraw = enemyDraw = null;
      sfx.roundStart();
    }
  }
}

function showResult(matchId: string, why: string): void {
  const me = obs?.slot ?? 0;
  const won = obs?.winner === me;
  $('resultTitle').textContent = why === 'disconnect' ? 'Ended' : won ? 'Won' : 'Lost';
  $('resultTitle').style.color = why === 'disconnect' ? '' : won ? REC : '';
  const score = obs ? `${obs.score[me]}–${obs.score[1 - me]} against ${names[1 - me] ?? 'your rival'}.` : '';
  $('resultSub').textContent = why === 'disconnect'
    ? `Your rival disconnected. ${score} The match so far is saved as ${matchId}.`
    : `${score} Saved as ${matchId}.`;
  $('result').style.display = 'grid';
}
$('again').addEventListener('click', () => location.reload());

const nameInput = $('name') as HTMLInputElement;
const roomInput = $('room') as HTMLInputElement;
try {
  nameInput.value = localStorage.getItem('rd-name') ?? '';
} catch { /* storage blocked: the field just starts empty */ }

$('join').addEventListener('submit', (ev) => {
  ev.preventDefault();
  initAudio();
  try {
    localStorage.setItem('rd-name', nameInput.value);
  } catch { /* not important */ }
  const status = $('status');
  status.textContent = 'Connecting…';
  // Under `npm run web` the page is on Vite's port and the game server is on 8080.
  // Anywhere else (the built client, a tunnel) the same server serves both, so use the page's own origin.
  ws = new WebSocket(location.port === '5173'
    ? `ws://${location.hostname}:8080`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => ws!.send(JSON.stringify({ t: 'join', name: nameInput.value, room: roomInput.value }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'joined') {
      status.textContent = `In room “${roomInput.value.toLowerCase()}”. Waiting for a second player: send them this page and the room code.`;
    } else if (msg.t === 'error') {
      status.textContent = msg.msg;
    } else if (msg.t === 'start') {
      names = msg.names;
      $('join').style.display = 'none';
    } else if (msg.t === 'obs') {
      const o: Observation = msg.obs;
      obs = o;
      predictor.reconcile(o.self, msg.ack ?? 0, o.phase === 'live');
      onEvents(msg.events, o.slot);
      if (o.enemy && o.phase === 'live') {
        const t = o.tick - roundStartTick;
        const last = seen[seen.length - 1];
        if (last && last[1] >= t - 1) last[1] = t;
        else seen.push([t, t]);
      }
    } else if (msg.t === 'end') {
      showResult(msg.matchId, msg.why);
    }
  };
  ws.onclose = () => {
    if (!obs) status.textContent = 'Could not reach the game server. Check that it is running, then try again.';
  };
});

// --- input --------------------------------------------------------------------------------------

const keys = new Set<string>();
const mouse = { x: map.width / 2, y: map.height / 2, down: false };
addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  if (e.code === 'KeyM' && !e.repeat) $('net').dataset.muted = toggleMute() ? '1' : '';
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
  keys.clear();
  mouse.down = false;
});
arena.addEventListener('mousemove', (e) => {
  const r = arena.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / scale;
  mouse.y = (e.clientY - r.top) / scale;
});
arena.addEventListener('mousedown', (e) => {
  if (e.button === 0) mouse.down = true;
});
addEventListener('mouseup', () => (mouse.down = false));
arena.addEventListener('contextmenu', (e) => e.preventDefault());

/** Where you are as far as you can tell: the prediction once there is one. */
function selfPos(): { x: number; y: number } | null {
  return predictor.pos ?? obs?.self ?? null;
}

function aimFrom(p: { x: number; y: number } | null): number {
  return p ? Math.atan2(mouse.y - p.y, mouse.x - p.x) : 0;
}

function currentInput(): Input {
  const axis = (pos: string, neg: string) => ((keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0)) as -1 | 0 | 1;
  return {
    move: { x: axis('KeyD', 'KeyA'), y: axis('KeyS', 'KeyW') },
    walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    // Aim from the predicted position: that is where the server will have you when this input lands.
    aim: aimFrom(selfPos()),
    fire: mouse.down,
    reload: keys.has('KeyR'),
    smoke: keys.has('KeyQ'),
    dash: keys.has('KeyE'),
    use: keys.has('KeyF'),
  };
}

setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN || !obs) return;
  const input = currentInput();
  const seq = predictor.send(input, obs.phase === 'live' && obs.self.hp > 0);
  ws.send(JSON.stringify({ t: 'input', input, seq }));
}, 1000 / TICK_RATE);

// --- arena --------------------------------------------------------------------------------------

/** Outline of what you can see: 30 units inside the aim cone, 3 units elsewhere, cut by walls and smokes. */
function visionPolygon(o: Observation, px: number, py: number, aim: number): [number, number][] {
  const RAYS = 360;
  const pts: [number, number][] = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * 2 * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let off = Math.abs(a - aim) % (2 * Math.PI);
    if (off > Math.PI) off = 2 * Math.PI - off;
    let d = Math.min(off <= C.VISION_HALF_CONE ? C.VISION_RANGE : C.NEAR_RANGE, rayWalls(map.walls, px, py, dx, dy));
    for (const k of o.smokes) d = Math.min(d, rayCircle(px, py, dx, dy, k.x, k.y, C.SMOKE_RADIUS));
    pts.push([px + dx * d, py + dy * d]);
  }
  return pts;
}

function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x * scale, y * scale, r * scale, 0, 2 * Math.PI);
}

function arc(x: number, y: number, r: number, from: number, to: number, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x * scale, y * scale, r * scale, from, to);
  ctx.stroke();
}

function drawPlayer(x: number, y: number, aim: number, color: string): void {
  ctx.fillStyle = OXIDE_DARK;
  circle(ctx, x, y, C.RADIUS + 0.12);
  ctx.fill();
  ctx.fillStyle = color;
  circle(ctx, x, y, C.RADIUS);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo((x + Math.cos(aim) * 0.55) * scale, (y + Math.sin(aim) * 0.55) * scale);
  ctx.lineTo((x + Math.cos(aim) * 1.15) * scale, (y + Math.sin(aim) * 1.15) * scale);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

/** Moves `cur` towards `target` with time constant `tau` ms; jumps straight there if the gap is over `snap` units. */
function chase(cur: { x: number; y: number } | null, target: { x: number; y: number }, dt: number, tau: number, snap: number) {
  if (!cur || Math.hypot(target.x - cur.x, target.y - cur.y) > snap) return { x: target.x, y: target.y };
  const k = 1 - Math.exp(-dt / tau);
  return { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k };
}

function drawFloor(): void {
  ctx.fillStyle = OXIDE;
  ctx.fillRect(0, 0, map.width * scale, map.height * scale);
  ctx.strokeStyle = 'rgba(239, 226, 201, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 4; x < map.width; x += 4) {
    ctx.moveTo(x * scale + 0.5, 0);
    ctx.lineTo(x * scale + 0.5, map.height * scale);
  }
  for (let y = 4; y < map.height; y += 4) {
    ctx.moveTo(0, y * scale + 0.5);
    ctx.lineTo(map.width * scale, y * scale + 0.5);
  }
  ctx.stroke();

  for (const [label, s] of Object.entries(map.sites)) {
    ctx.fillStyle = 'rgba(229, 72, 59, 0.07)';
    ctx.fillRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
    ctx.strokeStyle = 'rgba(229, 72, 59, 0.45)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(s.x * scale + 0.75, s.y * scale + 0.75, s.w * scale - 1.5, s.h * scale - 1.5);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(229, 72, 59, 0.4)';
    ctx.font = `900 ${4 * scale}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, (s.x + s.w / 2) * scale, (s.y + s.h / 2) * scale + 0.2 * scale);
  }
}

function drawWalls(): void {
  for (const w of map.walls) {
    ctx.fillStyle = BAKELITE;
    ctx.fillRect(w.x * scale, w.y * scale, w.w * scale, w.h * scale);
    ctx.fillStyle = BAKELITE_EDGE;
    ctx.fillRect(w.x * scale, w.y * scale, w.w * scale, 2);
  }
}

/** Crosshair whose gap is the real spread for how you are moving, at the distance you are aiming. */
function drawCrosshair(o: Observation, px: number, py: number, now: number): void {
  const moveState = predictor.pos?.moveState ?? o.self.moveState;
  const dist = Math.hypot(mouse.x - px, mouse.y - py);
  const gap = Math.max(5, dist * Math.tan((C.SPREAD_DEG[moveState] * Math.PI) / 180) * scale);
  const mx = mouse.x * scale;
  const my = mouse.y * scale;
  const color = o.self.reloadTicks > 0 || o.self.ammo === 0 ? DIM : VU;
  for (const [w, c] of [[4, OXIDE_DARK], [2, color]] as const) {
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(mx + dx * gap, my + dy * gap);
      ctx.lineTo(mx + dx * (gap + 7), my + dy * (gap + 7));
    }
    ctx.stroke();
  }
  if (o.self.reloadTicks > 0) {
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, gap + 12, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * (1 - o.self.reloadTicks / C.RELOAD_TICKS));
    ctx.stroke();
  }
  if (hitUntil > now) {
    ctx.strokeStyle = LABEL;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      ctx.moveTo(mx + sx * 6, my + sy * 6);
      ctx.lineTo(mx + sx * 13, my + sy * 13);
    }
    ctx.stroke();
  }
}

function drawBanner(): void {
  if (!banner) return;
  const w = map.width * scale;
  const h = map.height * scale;
  ctx.fillStyle = 'rgba(22, 15, 12, 0.82)';
  ctx.fillRect(0, h / 2 - 3.4 * scale, w, 6.8 * scale);
  ctx.fillStyle = banner.color;
  ctx.fillRect(0, h / 2 - 3.4 * scale, w, 3);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${4.2 * scale}px ${DISPLAY}`;
  ctx.fillText(banner.title.toUpperCase(), w / 2, h / 2 - 0.7 * scale);
  ctx.fillStyle = LABEL;
  ctx.font = `400 ${0.85 * scale}px ${MONO}`;
  ctx.fillText(banner.sub, w / 2, h / 2 + 2 * scale);
}

let lastFrame = performance.now();
function draw(): void {
  requestAnimationFrame(draw);
  const now = performance.now();
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFloor();

  const o = obs;
  if (!o) {
    drawWalls();
    drawTape();
    return;
  }
  const me = o.slot;
  const alive = o.self.hp > 0;
  const live = o.phase === 'live';
  const target = selfPos()!;
  selfDraw = chase(selfDraw, target, dt, 22, 1.5);
  const { x: px, y: py } = selfDraw;
  const aim = live ? aimFrom(selfDraw) : o.self.aim;

  if (o.spike.state === 'planted') {
    const pulse = (now % 1000) / 1000;
    arc(o.spike.x, o.spike.y, 0.5 + pulse * 1.5, 0, 2 * Math.PI, `rgba(229, 72, 59, ${1 - pulse})`, 2);
    if (o.attacker !== me) {
      ctx.setLineDash([3, 5]);
      arc(o.spike.x, o.spike.y, C.DEFUSE_RANGE, 0, 2 * Math.PI, 'rgba(127, 214, 232, 0.5)', 1.5);
      ctx.setLineDash([]);
    }
    ctx.save();
    ctx.translate(o.spike.x * scale, o.spike.y * scale);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = Math.floor(now / 250) % 2 ? REC : '#8a2a22';
    ctx.fillRect(-0.32 * scale, -0.32 * scale, 0.64 * scale, 0.64 * scale);
    ctx.restore();
    if (now >= nextBeep) {
      sfx.beep();
      nextBeep = now + 110 + 890 * (o.spike.ticksLeft / C.FUSE_TICKS);
    }
  }

  if (o.enemy) {
    enemyDraw = chase(enemyDraw, o.enemy, dt, 35, 2);
    drawPlayer(enemyDraw.x, enemyDraw.y, o.enemy.aim, ICE);
  } else {
    enemyDraw = null;
    if (o.lastSeenEnemy && live) {
      const age = o.lastSeenEnemy.ticksAgo / TICK_RATE;
      ctx.globalAlpha = Math.max(0.25, 1 - age / 12);
      ctx.setLineDash([4, 4]);
      arc(o.lastSeenEnemy.x, o.lastSeenEnemy.y, C.RADIUS, 0, 2 * Math.PI, ICE, 1.5);
      ctx.setLineDash([]);
      ctx.fillStyle = ICE;
      ctx.font = `400 ${Math.max(9, 0.6 * scale)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${age.toFixed(1)}s`, o.lastSeenEnemy.x * scale, (o.lastSeenEnemy.y + 0.6) * scale);
      ctx.globalAlpha = 1;
    }
  }

  // Fog: darken the whole map, then cut out what you can see.
  fogCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fogCtx.globalCompositeOperation = 'source-over';
  fogCtx.clearRect(0, 0, map.width * scale, map.height * scale);
  fogCtx.fillStyle = 'rgba(18, 12, 9, 0.8)';
  fogCtx.fillRect(0, 0, map.width * scale, map.height * scale);
  if (alive) {
    fogCtx.globalCompositeOperation = 'destination-out';
    fogCtx.beginPath();
    for (const [x, y] of visionPolygon(o, px, py, aim)) fogCtx.lineTo(x * scale, y * scale);
    fogCtx.closePath();
    fogCtx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(fog, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (const k of o.smokes) {
    const fade = Math.min(1, k.ticksLeft / 32);
    ctx.fillStyle = `rgba(214, 200, 180, ${0.88 * fade})`;
    circle(ctx, k.x, k.y, C.SMOKE_RADIUS);
    ctx.fill();
    ctx.strokeStyle = `rgba(239, 226, 201, ${0.5 * fade})`;
    ctx.lineWidth = 1;
    circle(ctx, k.x, k.y, C.SMOKE_RADIUS * (0.55 + 0.1 * Math.sin(now / 400 + k.x)));
    ctx.stroke();
  }

  tracers = tracers.filter((t) => t.until > now);
  for (const t of tracers) {
    ctx.strokeStyle = t.mine ? VU : ICE;
    ctx.globalAlpha = (t.until - now) / 110;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(t.x * scale, t.y * scale);
    ctx.lineTo(t.toX * scale, t.toY * scale);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (alive) {
    drawPlayer(px, py, aim, VU);
    const useMax = o.attacker === me ? C.PLANT_TICKS : C.DEFUSE_TICKS;
    if (o.self.useTicks > 0) arc(px, py, 0.95, -Math.PI / 2, -Math.PI / 2 + (2 * Math.PI * o.self.useTicks) / useMax, LABEL, 3);
    if (hurtUntil > now) {
      ctx.globalAlpha = (hurtUntil - now) / 900;
      arc(px, py, 1.5, hurtFrom - 0.45, hurtFrom + 0.45, REC, 5);
      ctx.globalAlpha = 1;
    }
  }

  drawWalls();
  if (alive && live) drawCrosshair(o, px, py, now);
  drawBanner();
  drawTape();
  updateHud(o);
}

// --- tape strip ---------------------------------------------------------------------------------

/** The current round laid out left to right like tape under a record head. */
function drawTape(): void {
  const w = map.width * scale;
  const h = TAPE_H;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.fillStyle = OXIDE_DARK;
  tctx.fillRect(0, 0, w, h);
  const left = 58;
  const right = w - 112;
  const span = plantedAt !== null ? plantedAt + C.FUSE_TICKS : C.ROUND_TICKS;
  const X = (t: number) => left + (Math.min(t, span) / span) * (right - left);
  const now = elapsed();

  tctx.fillStyle = '#3a2d25';
  tctx.fillRect(left, 6, X(now) - left, h - 12);
  tctx.fillStyle = '#4a3a30';
  for (let t = 0; t <= span; t += TICK_RATE) {
    const tall = t % (TICK_RATE * 10) === 0;
    tctx.fillRect(Math.round(X(t)), tall ? 4 : h - 9, 1, tall ? h - 8 : 3);
  }
  for (const [a, b] of seen) {
    tctx.fillStyle = ICE;
    tctx.fillRect(X(a), h - 8, Math.max(1, X(b) - X(a)), 2);
  }
  for (const s of stamps) {
    const x = Math.round(X(s.t));
    if (s.kind === 'shot') (tctx.fillStyle = VU), tctx.fillRect(x, 8, 1, 5);
    else if (s.kind === 'hit') (tctx.fillStyle = VU), tctx.fillRect(x - 1, 6, 3, 10);
    else if (s.kind === 'hurt') (tctx.fillStyle = REC), tctx.fillRect(x - 1, h - 16, 3, 10);
    else if (s.kind === 'smoke' || s.kind === 'dash') {
      tctx.fillStyle = s.kind === 'smoke' ? LABEL : DIM;
      tctx.beginPath();
      tctx.arc(x, h / 2, 2.5, 0, 2 * Math.PI);
      tctx.fill();
    } else {
      tctx.fillStyle = s.kind === 'kill' ? VU : s.kind === 'death' ? ICE : REC;
      tctx.save();
      tctx.translate(x, h / 2);
      tctx.rotate(Math.PI / 4);
      tctx.fillRect(-4, -4, 8, 8);
      tctx.restore();
    }
  }
  if (plantedAt !== null) {
    tctx.fillStyle = 'rgba(229, 72, 59, 0.18)';
    tctx.fillRect(X(plantedAt), 6, right - X(plantedAt), h - 12);
  }
  tctx.fillStyle = REC;
  tctx.fillRect(Math.round(X(now)) - 1, 2, 2, h - 4);

  tctx.font = `700 10px ${MONO}`;
  tctx.textBaseline = 'middle';
  tctx.textAlign = 'left';
  tctx.fillStyle = DIM;
  tctx.fillText(obs ? `ROUND ${obs.round}` : 'ROUND', 0, h / 2);
  tctx.textAlign = 'right';
  tctx.fillStyle = LABEL;
  const s = Math.floor(now / TICK_RATE);
  const tc = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(now % TICK_RATE).padStart(2, '0')}`;
  tctx.fillText(tc, w, h / 2);
}

// --- HUD (DOM) ------------------------------------------------------------------------------------

let lastAmmoKey = '';
function updateHud(o: Observation): void {
  const me = o.slot;
  $('myScore').textContent = String(o.score[me]);
  $('theirScore').textContent = String(o.score[1 - me]);
  $('myName').textContent = names[me] ?? 'you';
  $('theirName').textContent = names[1 - me] ?? 'rival';
  const side = $('side');
  side.textContent = o.attacker === me ? 'Attack' : 'Defend';
  side.style.color = o.attacker === me ? REC : ICE;

  const planted = o.spike.state === 'planted';
  const left = planted ? o.spike.ticksLeft : o.roundTicksLeft;
  const secs = left / TICK_RATE;
  const clock = $('clock');
  clock.classList.toggle('hot', planted || secs < 10);
  clock.innerHTML = secs < 10
    ? `${secs.toFixed(1)}<small>${planted ? ' spike' : 's'}</small>`
    : `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}${planted ? '<small> spike</small>' : ''}`;

  const lag = Math.round((predictor.unacked * 1000) / TICK_RATE);
  $('net').textContent = `${$('net').dataset.muted ? 'muted · ' : ''}lag ~${lag}ms`;

  const hp = $('hp');
  hp.textContent = String(o.self.hp);
  hp.classList.toggle('low', o.self.hp <= 25);

  const ammoKey = `${o.self.ammo}/${o.self.reloadTicks > 0}`;
  if (ammoKey !== lastAmmoKey) {
    lastAmmoKey = ammoKey;
    $('ammoLabel').textContent = o.self.reloadTicks > 0 ? 'Reloading' : o.self.ammo === 0 ? 'Empty: press R' : 'Ammo';
    $('ammo').innerHTML = Array.from({ length: C.MAG }, (_, i) => `<b class="${i < o.self.ammo && o.self.reloadTicks === 0 ? '' : 'off'}"></b>`).join('');
  }
  $('smokeKey').classList.toggle('spent', o.self.smokes === 0);
  $('dashKey').classList.toggle('spent', o.self.dashes === 0);

  let hint = '';
  if (o.phase === 'live' && o.self.hp > 0) {
    const p = selfPos()!;
    const inSite = Object.values(map.sites).some((s) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);
    if (o.attacker === me) hint = planted ? 'Spike planted. Hold the site.' : inSite ? 'Stand still and hold F to plant' : 'Get the spike to A or B';
    else if (planted) hint = Math.hypot(p.x - o.spike.x, p.y - o.spike.y) <= C.DEFUSE_RANGE ? 'Hold F to defuse' : 'Spike planted. Find it and defuse.';
    else hint = 'Stop the plant';
  }
  $('hint').textContent = hint;
}

draw();
