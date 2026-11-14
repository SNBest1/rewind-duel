// Replay / rewind viewer. It does two things:
//   1. REPLAY: fetch a recorded match's snapshots + markers from the server, scrub the timeline, draw both
//      players, and optionally draw each player's vision cone.
//   2. REWIND: "take control from here" opens a WebSocket rewind session on the server. The human drives one
//      slot; the server runs the ghost -> clone opponent and streams back the fogged observation and trace.
// The browser never simulates the match here either: in replay it draws server snapshots; in rewind it draws
// the server's observation. The one thing it predicts is nothing — a rewind tick is a clean round trip.
import { C, TICK_RATE, getMap, rayCircle, rayWalls, type Input, type Observation } from '@rewind/engine';

type PlayerSnap = { x: number; y: number; aim: number; hp: number; moveState: number };
type Snapshot = {
  tick: number; round: number; phase: string;
  players: [PlayerSnap, PlayerSnap];
  smokes: { x: number; y: number; ticksLeft: number }[];
  spike: { state: string; x: number; y: number; ticksLeft: number };
  score: [number, number];
};
type Marker = { tick: number; kind: string; [k: string]: any };
type TraceEvent = { kind: string; tick: number; actor: 0 | 1; [k: string]: any };
type Replay = { id: string; map: string; players: { slot: 0 | 1; name: string }[]; ticks: number; snapshots: Snapshot[]; markers: Marker[] };

const map = getMap('duel');
const $ = (id: string) => document.getElementById(id)!;
const arena = $('arena') as HTMLCanvasElement;
const ctx = arena.getContext('2d')!;

const VU = '#ffb547', ICE = '#7fd6e8', REC = '#e5483b', OXIDE = '#4b3a2e', OXIDE_DARK = '#1d1612';
const BAKELITE = '#8b735f', LABEL = '#efe2c9', DIM = '#9c8a78';
const MONO = '"Martian Mono", ui-monospace, monospace';
const DISPLAY = '"Big Shoulders Display", Impact, sans-serif';

let scale = 18;
function resize(): void {
  const stage = $('stage');
  scale = Math.max(8, Math.floor(Math.min((stage.clientWidth - 24) / map.width, (stage.clientHeight - 24) / map.height)));
  arena.width = map.width * scale;
  arena.height = map.height * scale;
}
addEventListener('resize', () => { resize(); if (replay) render(); });

// --- state --------------------------------------------------------------------------------------

let replay: Replay | null = null;
let cursor = 0; // current snapshot index
let playing = false;
let showMe = true;
let showThem = false;
let controlSlot: 0 | 1 = 0;

// Rewind session state (null outside a rewind).
let ws: WebSocket | null = null;
let rewinding = false;
let rwObs: Observation | null = null;
let rwEnemy: PlayerSnap | null = null;
let rwTrace: TraceEvent[] = [];
let rwMode = '';
let forkTick = 0;

// --- loading ------------------------------------------------------------------------------------

async function loadMatchList(): Promise<void> {
  const list = (await (await fetch('/api/matches')).json()) as { id: string; players: string[]; ticks: number }[];
  const sel = $('matchSel') as HTMLSelectElement;
  sel.innerHTML = list.map((m) => `<option value="${m.id}">${m.players.join(' vs ')} — ${(m.ticks / TICK_RATE).toFixed(0)}s</option>`).join('');
  if (list.length) await loadReplay(list[0].id);
}

async function loadReplay(id: string): Promise<void> {
  stopRewind();
  replay = (await (await fetch(`/api/replay?id=${encodeURIComponent(id)}`)).json()) as Replay;
  cursor = 0;
  ($('scrub') as HTMLInputElement).max = String(replay.snapshots.length - 1);
  $('who').textContent = replay.players.map((p) => `${p.slot}:${p.name}`).join('  ');
  drawMarkers();
  resize();
  render();
}

// --- timeline markers (DOM) ---------------------------------------------------------------------

function drawMarkers(): void {
  if (!replay) return;
  const row = $('markrow');
  row.innerHTML = '';
  for (const m of replay.markers) {
    const el = document.createElement('div');
    el.className = `mk ${m.kind}`;
    el.style.left = `${(m.tick / replay.ticks) * 100}%`;
    el.title = `${m.kind} @ ${m.tick}`;
    row.appendChild(el);
  }
}

// --- drawing ------------------------------------------------------------------------------------

function circle(x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x * scale, y * scale, r * scale, 0, 2 * Math.PI);
}

function drawFloor(): void {
  ctx.fillStyle = OXIDE;
  ctx.fillRect(0, 0, arena.width, arena.height);
  for (const [label, s] of Object.entries(map.sites)) {
    ctx.fillStyle = 'rgba(229,72,59,0.07)';
    ctx.fillRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale);
    ctx.fillStyle = 'rgba(229,72,59,0.4)';
    ctx.font = `900 ${4 * scale}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, (s.x + s.w / 2) * scale, (s.y + s.h / 2) * scale);
  }
}

function drawWalls(): void {
  for (const w of map.walls) {
    ctx.fillStyle = BAKELITE;
    ctx.fillRect(w.x * scale, w.y * scale, w.w * scale, w.h * scale);
  }
}

/** The vision outline for a player at (px,py) aiming `aim`, cut by walls and smokes. Same rule as the engine. */
function visionPolygon(px: number, py: number, aim: number, smokes: { x: number; y: number }[]): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 240; i++) {
    const a = (i / 240) * 2 * Math.PI;
    const dx = Math.cos(a), dy = Math.sin(a);
    let off = Math.abs(a - aim) % (2 * Math.PI);
    if (off > Math.PI) off = 2 * Math.PI - off;
    let d = Math.min(off <= C.VISION_HALF_CONE ? C.VISION_RANGE : C.NEAR_RANGE, rayWalls(map.walls, px, py, dx, dy));
    for (const k of smokes) d = Math.min(d, rayCircle(px, py, dx, dy, k.x, k.y, C.SMOKE_RADIUS));
    pts.push([px + dx * d, py + dy * d]);
  }
  return pts;
}

function fillVision(p: PlayerSnap, smokes: { x: number; y: number }[], color: string): void {
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const [x, y] of visionPolygon(p.x, p.y, p.aim, smokes)) ctx.lineTo(x * scale, y * scale);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPlayer(p: PlayerSnap, color: string): void {
  if (p.hp <= 0) color = '#5a4a3e';
  ctx.fillStyle = OXIDE_DARK;
  circle(p.x, p.y, C.RADIUS + 0.12);
  ctx.fill();
  ctx.fillStyle = color;
  circle(p.x, p.y, C.RADIUS);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo((p.x + Math.cos(p.aim) * 0.55) * scale, (p.y + Math.sin(p.aim) * 0.55) * scale);
  ctx.lineTo((p.x + Math.cos(p.aim) * 1.15) * scale, (p.y + Math.sin(p.aim) * 1.15) * scale);
  ctx.stroke();
  // HP bar
  ctx.fillStyle = '#000a';
  ctx.fillRect((p.x - 0.5) * scale, (p.y - 0.9) * scale, scale, 3);
  ctx.fillStyle = color;
  ctx.fillRect((p.x - 0.5) * scale, (p.y - 0.9) * scale, scale * Math.max(0, p.hp / 100), 3);
}

function drawSmokeSpike(smokes: Snapshot['smokes'], spike: Snapshot['spike']): void {
  for (const k of smokes) {
    ctx.fillStyle = 'rgba(214,200,180,0.85)';
    circle(k.x, k.y, C.SMOKE_RADIUS);
    ctx.fill();
  }
  if (spike.state === 'planted') {
    ctx.save();
    ctx.translate(spike.x * scale, spike.y * scale);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = REC;
    ctx.fillRect(-0.32 * scale, -0.32 * scale, 0.64 * scale, 0.64 * scale);
    ctx.restore();
  }
}

/** Draw a static snapshot (replay mode). */
function render(): void {
  if (!replay) return;
  const snap = replay.snapshots[cursor];
  drawFloor();
  if (showMe) fillVision(snap.players[0], snap.smokes, VU);
  if (showThem) fillVision(snap.players[1], snap.smokes, ICE);
  drawWalls();
  drawSmokeSpike(snap.smokes, snap.spike);
  drawPlayer(snap.players[0], VU);
  drawPlayer(snap.players[1], ICE);
  $('clock').textContent = `${(snap.tick / TICK_RATE).toFixed(1)}s  ·  round ${snap.round}  ·  ${snap.score.join('–')}`;
  $('mode').textContent = '';
}

/** Draw the live rewind state (server-authoritative observation + the opponent position it allows). */
function renderRewind(): void {
  if (!rwObs) return;
  const o = rwObs;
  drawFloor();
  drawWalls();
  drawSmokeSpike(o.smokes as any, o.spike as any);
  // Opponent: drawn from the server's rewind snapshot (replay of your own match, so both sides are allowed).
  if (rwEnemy) drawPlayer(rwEnemy, ICE);
  drawPlayer({ ...o.self, moveState: o.self.moveState } as PlayerSnap, VU);
  $('clock').textContent = `${(o.tick / TICK_RATE).toFixed(1)}s  ·  round ${o.round}  ·  ${o.score.join('–')}`;
  $('mode').textContent = rwMode === 'ghost' ? 'GHOST (replaying opponent)' : 'CLONE (opponent is a clone)';
  $('mode').style.color = rwMode === 'ghost' ? DIM : ICE;
}

// --- trace panel --------------------------------------------------------------------------------

function renderTrace(lines: TraceEvent[]): void {
  const el = $('trace');
  el.innerHTML = lines.map((e, i) => {
    let reason = '';
    if (e.kind === 'GHOST') reason = `divergence ${e.score.toFixed(2)}`;
    else if (e.kind === 'HANDOFF') reason = `divergence ${e.score.toFixed(2)} > ${e.limit}`;
    else if (e.kind === 'CLONE') reason = `${e.action} · nn ${e.nnDist.toFixed(2)} · ${e.because?.length ?? 0} refs`;
    else if (e.kind === 'BREAKER') reason = e.reason;
    return `<div class="tl ${e.kind}" data-i="${i}"><span class="tk">${e.tick}</span><span class="kd">${e.kind}</span><span class="rs">${reason}</span></div>`;
  }).join('');
  // Clicking a CLONE line shows the copied past moment(s) it cited.
  el.querySelectorAll('.tl.CLONE').forEach((node) => {
    node.addEventListener('click', () => {
      const e = lines[Number((node as HTMLElement).dataset.i)];
      showCopiedMoment(e);
    });
  });
  el.scrollTop = el.scrollHeight;
}

/** Shows the recorded moment a CLONE decision copied, beside the current one. */
function showCopiedMoment(e: TraceEvent): void {
  const pop = $('pop');
  pop.classList.add('show');
  const refs = (e.because ?? []).slice(0, 3);
  pop.innerHTML =
    `<b style="color:${ICE}">why: copied ${refs.length} moment(s)</b><br>` +
    refs.map((r: any) => `${r.playerName} · ${r.matchId.slice(0, 10)} @ tick ${r.tick} · weight ${(r.weight * 100).toFixed(0)}%`).join('<br>') +
    `<br><span class="hint">nearest-neighbor distance ${e.nnDist.toFixed(2)}</span>`;
  setTimeout(() => pop.classList.remove('show'), 5000);
}

// --- rewind session over WebSocket --------------------------------------------------------------

function wsUrl(): string {
  return location.port === '5173'
    ? `ws://${location.hostname}:8080`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

function startRewind(): void {
  if (!replay) return;
  playing = false;
  forkTick = replay.snapshots[cursor].tick;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => ws!.send(JSON.stringify({ t: 'rewind', id: replay!.id, human: controlSlot, forkTick }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'rwopen') {
      rewinding = true;
      $('rwstatus').textContent = `controlling slot ${msg.human}, opponent is a clone past divergence ${msg.divergenceLimit}`;
      $('take').style.display = 'none';
      $('retry').style.display = '';
    } else if (msg.t === 'rw') {
      rwObs = msg.obs;
      rwEnemy = msg.enemy;
      rwMode = msg.mode;
      rwTrace = msg.trace;
      renderRewind();
      renderTrace(rwTrace);
      if (msg.done) $('rwstatus').textContent = `round over — press "retry from fork" to try again`;
    } else if (msg.t === 'branch') {
      const o = msg.outcome;
      $('rwstatus').textContent = `branch ${o.branchId}: you ${o.humanWon ? 'WON' : 'lost'}${o.handoffTick !== null ? `, clone took over at tick ${o.handoffTick}` : ', ghost all the way'}`;
    } else if (msg.t === 'error') {
      $('rwstatus').textContent = msg.msg;
      stopRewind();
    }
  };
  ws.onclose = () => { if (rewinding) $('rwstatus').textContent += ' (disconnected)'; };
}

function stopRewind(): void {
  rewinding = false;
  rwObs = null;
  ws?.close();
  ws = null;
  $('take').style.display = '';
  $('retry').style.display = 'none';
}

// --- input while rewinding ----------------------------------------------------------------------

const keys = new Set<string>();
const mouse = { x: map.width / 2, y: map.height / 2, down: false };
addEventListener('keydown', (e) => { if (!(document.activeElement instanceof HTMLSelectElement)) keys.add(e.code); });
addEventListener('keyup', (e) => keys.delete(e.code));
arena.addEventListener('mousemove', (e) => {
  const r = arena.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / scale;
  mouse.y = (e.clientY - r.top) / scale;
});
arena.addEventListener('mousedown', () => (mouse.down = true));
addEventListener('mouseup', () => (mouse.down = false));
arena.addEventListener('contextmenu', (e) => e.preventDefault());

function rewindInput(): Input {
  const axis = (pos: string, neg: string) => ((keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0)) as -1 | 0 | 1;
  const self = rwObs?.self;
  const aim = self ? Math.atan2(mouse.y - self.y, mouse.x - self.x) : 0;
  return {
    move: { x: axis('KeyD', 'KeyA'), y: axis('KeyS', 'KeyW') },
    walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    aim, fire: mouse.down, reload: keys.has('KeyR'),
    smoke: keys.has('KeyQ'), dash: keys.has('KeyE'), use: keys.has('KeyF'),
  };
}

// The rewind session advances only while we hold a live session and the round is not over.
setInterval(() => {
  if (!rewinding || !ws || ws.readyState !== WebSocket.OPEN || !rwObs) return;
  ws.send(JSON.stringify({ t: 'rwinput', input: rewindInput() }));
}, 1000 / TICK_RATE);

// --- controls -----------------------------------------------------------------------------------

($('matchSel') as HTMLSelectElement).addEventListener('change', (e) => loadReplay((e.target as HTMLSelectElement).value));
($('scrub') as HTMLInputElement).addEventListener('input', (e) => {
  if (rewinding) return;
  cursor = Number((e.target as HTMLInputElement).value);
  render();
});
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'pause' : 'play'; });
$('visMe').addEventListener('click', () => { showMe = !showMe; $('visMe').classList.toggle('on', showMe); if (!rewinding) render(); });
$('visThem').addEventListener('click', () => { showThem = !showThem; $('visThem').classList.toggle('on', showThem); if (!rewinding) render(); });
($('slotSel') as HTMLSelectElement).addEventListener('change', (e) => (controlSlot = Number((e.target as HTMLSelectElement).value) as 0 | 1));
$('take').addEventListener('click', startRewind);
$('retry').addEventListener('click', () => ws?.send(JSON.stringify({ t: 'retry' })));

// Playback loop for replay mode.
let lastStep = performance.now();
function loop(): void {
  requestAnimationFrame(loop);
  if (rewinding || !replay || !playing) return;
  const now = performance.now();
  if (now - lastStep >= 1000 / TICK_RATE) {
    lastStep = now;
    cursor = Math.min(replay.snapshots.length - 1, cursor + 1);
    ($('scrub') as HTMLInputElement).value = String(cursor);
    render();
    if (cursor >= replay.snapshots.length - 1) { playing = false; $('play').textContent = 'play'; }
  }
}
loop();

loadMatchList();
