// Rewind Duel client. It never simulates: it sends inputs and draws the Observation the server allows it.
import { C, TICK_RATE, getMap, rayCircle, rayWalls, type GameEvent, type Input, type Observation } from '@rewind/engine';

const map = getMap('duel');
const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const fog = document.createElement('canvas');
const fogCtx = fog.getContext('2d')!;

const SELF = '#3ad6c5';
const ENEMY = '#ff6b5e';

let scale = 20;
function resize(): void {
  scale = Math.max(8, Math.floor(Math.min(innerWidth / map.width, (innerHeight - 64) / map.height)));
  canvas.width = fog.width = map.width * scale;
  canvas.height = fog.height = map.height * scale;
}
addEventListener('resize', resize);
resize();

// --- connection ---------------------------------------------------------------------------------

let ws: WebSocket | null = null;
let obs: Observation | null = null;
let names: string[] = [];
let banner = '';
let bannerSub = '';

type Tracer = { x: number; y: number; toX: number; toY: number; mine: boolean; until: number };
let tracers: Tracer[] = [];
let hurtUntil = 0;
let hitUntil = 0;

function onEvents(events: GameEvent[], me: number): void {
  const now = performance.now();
  for (const e of events) {
    if (e.type === 'shot') {
      tracers.push({ x: e.x, y: e.y, toX: e.toX, toY: e.toY, mine: e.slot === me, until: now + 120 });
      if (e.hit && e.slot === me) hitUntil = now + 150;
      if (e.hit && e.slot !== me) hurtUntil = now + 250;
    } else if (e.type === 'roundEnd') {
      banner = e.winner === me ? 'ROUND WON' : 'ROUND LOST';
      bannerSub = { kill: 'elimination', time: 'time ran out', defuse: 'spike defused', detonation: 'spike detonated' }[e.reason];
    } else if (e.type === 'roundStart') {
      banner = bannerSub = '';
    } else if (e.type === 'matchEnd') {
      banner = e.winner === me ? 'VICTORY' : 'DEFEAT';
    }
  }
}

$('join').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const status = $('status');
  status.textContent = 'Connecting...';
  ws = new WebSocket(`ws://${location.hostname}:8080`);
  ws.onopen = () => ws!.send(JSON.stringify({
    t: 'join',
    name: ($('name') as HTMLInputElement).value,
    room: ($('room') as HTMLInputElement).value,
  }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'joined') status.textContent = 'Waiting for the other player...';
    else if (msg.t === 'error') status.textContent = msg.msg;
    else if (msg.t === 'start') {
      names = msg.names;
      $('join').style.display = 'none';
    } else if (msg.t === 'obs') {
      obs = msg.obs;
      onEvents(msg.events, msg.obs.slot);
    } else if (msg.t === 'end') {
      bannerSub = msg.why === 'disconnect' ? `opponent left · saved ${msg.matchId}` : `saved ${msg.matchId} · reload to play again`;
      if (msg.why === 'disconnect') banner = 'MATCH ENDED';
    }
  };
  ws.onclose = () => {
    if (!obs) status.textContent = 'Could not reach the server on port 8080';
  };
});

// --- input --------------------------------------------------------------------------------------

const keys = new Set<string>();
const mouse = { x: 0, y: 0, down: false };
addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
  keys.clear();
  mouse.down = false;
});
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / scale;
  mouse.y = (e.clientY - r.top) / scale;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) mouse.down = true;
});
addEventListener('mouseup', () => (mouse.down = false));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function aimAngle(): number {
  return obs ? Math.atan2(mouse.y - obs.self.y, mouse.x - obs.self.x) : 0;
}

function currentInput(): Input {
  const axis = (pos: string, neg: string) => ((keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0)) as -1 | 0 | 1;
  return {
    move: { x: axis('KeyD', 'KeyA'), y: axis('KeyS', 'KeyW') },
    walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    aim: aimAngle(),
    fire: mouse.down,
    reload: keys.has('KeyR'),
    smoke: keys.has('KeyQ'),
    dash: keys.has('KeyE'),
    use: keys.has('KeyF'),
  };
}

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN && obs) ws.send(JSON.stringify({ t: 'input', input: currentInput() }));
}, 1000 / TICK_RATE);

// --- drawing ------------------------------------------------------------------------------------

/** Outline of what the player can see: 30 units inside the aim cone, 3 units elsewhere, cut by walls and smokes. */
function visionPolygon(o: Observation, aim: number): [number, number][] {
  const RAYS = 360;
  const pts: [number, number][] = [];
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * 2 * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let off = Math.abs(a - aim) % (2 * Math.PI);
    if (off > Math.PI) off = 2 * Math.PI - off;
    let d = Math.min(off <= C.VISION_HALF_CONE ? C.VISION_RANGE : C.NEAR_RANGE, rayWalls(map.walls, o.self.x, o.self.y, dx, dy));
    for (const k of o.smokes) d = Math.min(d, rayCircle(o.self.x, o.self.y, dx, dy, k.x, k.y, C.SMOKE_RADIUS));
    pts.push([o.self.x + dx * d, o.self.y + dy * d]);
  }
  return pts;
}

function circle(x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x * scale, y * scale, r * scale, 0, 2 * Math.PI);
}

function drawPlayer(x: number, y: number, aim: number, color: string): void {
  ctx.fillStyle = color;
  circle(x, y, C.RADIUS);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x * scale, y * scale);
  ctx.lineTo((x + Math.cos(aim) * 1.1) * scale, (y + Math.sin(aim) * 1.1) * scale);
  ctx.stroke();
}

function draw(): void {
  requestAnimationFrame(draw);
  const now = performance.now();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const [label, s] of Object.entries(map.sites)) {
    ctx.fillStyle = '#e0b05022';
    ctx.fillRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
    ctx.fillStyle = '#e0b05066';
    ctx.font = `${2 * scale}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, (s.x + s.w / 2) * scale, (s.y + s.h / 2) * scale);
  }

  const o = obs;
  if (o) {
    const me = o.slot;
    const aim = o.phase === 'live' ? aimAngle() : o.self.aim;

    if (o.spike.state === 'planted') {
      const blink = Math.floor(now / 250) % 2 === 0;
      ctx.fillStyle = blink ? '#ff4040' : '#802020';
      ctx.fillRect((o.spike.x - 0.3) * scale, (o.spike.y - 0.3) * scale, 0.6 * scale, 0.6 * scale);
    }
    if (o.enemy) drawPlayer(o.enemy.x, o.enemy.y, o.enemy.aim, ENEMY);
    else if (o.lastSeenEnemy && o.phase === 'live') {
      ctx.strokeStyle = ENEMY + '88';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      circle(o.lastSeenEnemy.x, o.lastSeenEnemy.y, C.RADIUS);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Fog: darken the whole map, then punch out the vision polygon.
    fogCtx.globalCompositeOperation = 'source-over';
    fogCtx.clearRect(0, 0, fog.width, fog.height);
    fogCtx.fillStyle = 'rgba(5, 7, 10, 0.72)';
    fogCtx.fillRect(0, 0, fog.width, fog.height);
    if (o.self.hp > 0) {
      fogCtx.globalCompositeOperation = 'destination-out';
      fogCtx.beginPath();
      for (const [x, y] of visionPolygon(o, aim)) fogCtx.lineTo(x * scale, y * scale);
      fogCtx.closePath();
      fogCtx.fill();
    }
    ctx.drawImage(fog, 0, 0);

    for (const k of o.smokes) {
      ctx.fillStyle = `rgba(170, 180, 190, ${k.ticksLeft < 32 ? 0.3 : 0.8})`;
      circle(k.x, k.y, C.SMOKE_RADIUS);
      ctx.fill();
    }

    tracers = tracers.filter((t) => t.until > now);
    for (const t of tracers) {
      ctx.strokeStyle = t.mine ? '#fff7c2' : '#ffb0a8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(t.x * scale, t.y * scale);
      ctx.lineTo(t.toX * scale, t.toY * scale);
      ctx.stroke();
    }

    if (o.self.hp > 0) drawPlayer(o.self.x, o.self.y, aim, SELF);

    if (hitUntil > now) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      const mx = mouse.x * scale;
      const my = mouse.y * scale;
      ctx.beginPath();
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        ctx.moveTo(mx + sx * 5, my + sy * 5);
        ctx.lineTo(mx + sx * 12, my + sy * 12);
      }
      ctx.stroke();
    }
    if (hurtUntil > now) {
      ctx.fillStyle = 'rgba(255, 40, 40, 0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const progress = o.self.useTicks / (o.attacker === me ? C.PLANT_TICKS : C.DEFUSE_TICKS);
    if (progress > 0) {
      ctx.fillStyle = '#000a';
      ctx.fillRect((o.self.x - 1) * scale, (o.self.y - 1.1) * scale, 2 * scale, 0.25 * scale);
      ctx.fillStyle = '#e0b050';
      ctx.fillRect((o.self.x - 1) * scale, (o.self.y - 1.1) * scale, 2 * scale * progress, 0.25 * scale);
    }

    const secs = (t: number) => (t / TICK_RATE).toFixed(1);
    const clock = o.spike.state === 'planted' ? `SPIKE ${secs(o.spike.ticksLeft)}` : secs(o.roundTicksLeft);
    $('top').textContent =
      `Round ${o.round}   ${names[me] ?? 'you'} ${o.score[me]} : ${o.score[1 - me]} ${names[1 - me] ?? 'enemy'}   ` +
      `${o.attacker === me ? 'ATTACK' : 'DEFEND'}   ${clock}`;
    $('bottom').textContent =
      `HP ${String(o.self.hp).padStart(3)}   AMMO ${o.self.reloadTicks > 0 ? `reloading ${secs(o.self.reloadTicks)}` : `${o.self.ammo}/${C.MAG}`}   ` +
      `[Q] smoke ${o.self.smokes}   [E] dash ${o.self.dashes}   ` +
      (o.spike.state === 'planted' ? (o.attacker === me ? 'spike planted' : '[F] defuse the spike') : o.attacker === me ? '[F] plant in A or B' : 'stop the plant');
  }

  ctx.fillStyle = '#566173';
  for (const w of map.walls) ctx.fillRect(w.x * scale, w.y * scale, w.w * scale, w.h * scale);

  if (banner) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000a';
    ctx.fillRect(0, canvas.height / 2 - 3 * scale, canvas.width, 6 * scale);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${2.4 * scale}px ui-monospace, monospace`;
    ctx.fillText(banner, canvas.width / 2, canvas.height / 2 - 0.6 * scale);
    ctx.font = `${1 * scale}px ui-monospace, monospace`;
    ctx.fillText(bannerSub, canvas.width / 2, canvas.height / 2 + 1.6 * scale);
  }
}
draw();
