// Rewind Duel client. The server decides everything; this file sends inputs and draws the Observation it is allowed.
// The one thing it computes itself is a prediction of its own movement (predict.ts), for display only.
import { BUY_TICKS, C, MAP_IDS, NO_WEAPON, SHIELDS, TICK_RATE, WEAPONS, getMap, rayCircle, rayWalls, weapon, type GameEvent, type Input, type Observation } from '@rewind/engine';
import { initAudio, sfx, toggleMute } from './audio';
import { Predictor } from './predict';
import { ALL_RANKS } from '../server/ranks';

// The map is decided by the server when the match starts (votes, or the AI room's pick). Duel until then.
let map = getMap('duel');
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
  // Room around the arena: the transport bar and readout in play, the viewer controls in replay mode.
  const chrome = document.body.classList.contains('viewing') ? 210 : 44 + 48;
  scale = Math.max(8, Math.floor(Math.min((innerWidth - 32) / map.width, (innerHeight - chrome - TAPE_H - 16) / map.height)));
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
  // The stage keeps the arena's size even when the arena shrinks to a minimap in first person.
  $('stage').style.width = `${w}px`;
  $('stage').style.height = `${h}px`;
  view3d?.resize(w, h);
}

// --- first person (V) ------------------------------------------------------------------------------

type View3DT = import('./view3d').View3D;
let view3d: View3DT | null = null;
let fp = false;
let yaw = 0;
let muzzleNow = false;
const view3dCanvas = $('view3d') as HTMLCanvasElement;

/** Turns first person on or off. The 3D code (three.js) is loaded the first time, so top-down play stays light. */
async function setFp(on: boolean): Promise<void> {
  if (on === fp) return;
  if (on) {
    if (!view3d) {
      const { View3D } = await import('./view3d');
      view3d = new View3D(view3dCanvas);
    }
    view3d.setMap(map);
    view3d.resize(map.width * scale, map.height * scale);
    yaw = obs?.self.aim ?? 0;
    fp = true;
    document.body.classList.add('fp');
  } else {
    fp = false;
    document.body.classList.remove('fp', 'locked');
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
view3dCanvas.addEventListener('click', () => {
  if (fp && document.pointerLockElement !== view3dCanvas) void view3dCanvas.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => document.body.classList.toggle('locked', document.pointerLockElement === view3dCanvas));
document.addEventListener('mousemove', (e) => {
  if (fp && document.pointerLockElement === view3dCanvas) yaw += e.movementX * 0.0024;
});
view3dCanvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && document.pointerLockElement === view3dCanvas) mouse.down = true;
});
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

// --- juice: muzzle flashes, impact sparks, shell casings, screen shake ---------------------------
// All display-only; computed from events, never sent or recorded, so determinism is untouched.
type Flash = { x: number; y: number; aim: number; until: number };
type Spark = { x: number; y: number; vx: number; vy: number; born: number; life: number; color: string };
let flashes: Flash[] = [];
let sparks: Spark[] = [];
let shakeMag = 0; // decays every frame; offsets the whole arena
let enemyHitUntil = 0; // flash the enemy white briefly when my shot connects
let lastStepAt = 0; // footstep sound throttle

// Flashbang pops (white rings) and floating text like "FLASHED 2.2s" or "DODGED".
type Pop = { x: number; y: number; born: number };
type Toast = { text: string; color: string; born: number; x: number; y: number };
let pops: Pop[] = [];
let toasts: Toast[] = [];

/** Top-right kill feed: killer, gun, headshot mark, victim. */
type Kill = { killer: string; victim: string; gun: string; head: boolean; mine: boolean; born: number };
let killfeed: Kill[] = [];
function renderKillfeed(): void {
  const el = $('killfeed');
  el.innerHTML = '';
  for (const k of killfeed) {
    const row = document.createElement('div');
    row.className = `kf ${k.mine ? 'mine' : 'theirs'}`;
    row.innerHTML = '<b></b><span></span><i></i><b></b>';
    row.children[0].textContent = k.killer;
    row.children[1].textContent = k.gun;
    row.children[2].textContent = k.head ? '◎' : '';
    row.children[3].textContent = k.victim;
    el.appendChild(row);
  }
}

/** Buying and equipping are one-tick presses: queued here, sent with the next input. */
let pendingBuy: number | undefined;
let pendingEquip: 0 | 1 | undefined;
const gunId = (name: string) => WEAPONS.findIndex((w) => w.name === name);
/** Quick-buy keys for the guns people actually buy; everything else is a click in the menu. */
const BUY_KEYS: Record<string, number> = {
  Digit1: gunId('Vandal'), Digit2: gunId('Phantom'), Digit3: gunId('Operator'), Digit4: gunId('Spectre'),
  Digit5: gunId('Sheriff'), Digit6: gunId('Ghost'), Digit7: 100, Digit8: 101,
};
const KEY_OF: Record<number, string> = Object.fromEntries(Object.entries(BUY_KEYS).map(([k, id]) => [id, k.slice(5)]));
function buyingNow(): boolean {
  return !!obs && obs.phase === 'live' && C.ROUND_TICKS - obs.roundTicksLeft < BUY_TICKS;
}

/** The buy menu, laid out by class like the game's. Built once from the armory. */
function buildBuyMenu(): void {
  const grid = $('buyGrid');
  const cols: [string, string[]][] = [
    ['Sidearms', ['Classic', 'Shorty', 'Frenzy', 'Ghost', 'Sheriff']],
    ['SMGs', ['Stinger', 'Spectre']],
    ['Shotguns', ['Bucky', 'Judge']],
    ['Rifles', ['Bulldog', 'Guardian', 'Phantom', 'Vandal']],
    ['Snipers', ['Marshal', 'Outlaw', 'Operator']],
    ['Heavy · Shields', ['Ares', 'Odin', '#100', '#101']],
  ];
  grid.innerHTML = '';
  for (const [title, items] of cols) {
    const col = document.createElement('div');
    col.className = 'buyCol';
    col.innerHTML = `<small>${title}</small>`;
    for (const item of items) {
      const id = item.startsWith('#') ? Number(item.slice(1)) : gunId(item);
      const sh = SHIELDS[id];
      const w = sh ? null : WEAPONS[id];
      const el = document.createElement('div');
      el.className = 'gun';
      el.dataset.gun = String(id);
      el.dataset.price = String(sh ? sh.price : w!.price);
      const key = KEY_OF[id];
      const head = w ? `${w.damage[0][1]} head · ${w.damage[0][2]} body` : `+${sh!.amount} shield`;
      el.innerHTML = `${key ? `<kbd>${key}</kbd>` : ''}<b></b><span class="price"></span><span></span>`;
      (el.children[key ? 1 : 0] as HTMLElement).textContent = sh ? sh.name : w!.name;
      (el.children[key ? 2 : 1] as HTMLElement).textContent = `¤ ${sh ? sh.price : w!.price}`;
      (el.children[key ? 3 : 2] as HTMLElement).textContent = w ? `${head}${w.pellets > 1 ? ` ×${w.pellets}` : ''}${w.silenced ? ' · suppressed' : ''}` : head;
      el.title = w?.blurb ?? '';
      el.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (buyingNow()) pendingBuy = id;
      });
      col.appendChild(el);
    }
    grid.appendChild(col);
  }
}
buildBuyMenu();
let vsAi = false;
function toast(text: string, color: string, x: number, y: number): void {
  toasts.push({ text, color, born: performance.now(), x, y });
}

function addShake(mag: number): void {
  shakeMag = Math.min(14, shakeMag + mag);
}

function burst(x: number, y: number, n: number, color: string, speed: number, now: number): void {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.6);
    sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, born: now, life: 180 + Math.random() * 220, color });
  }
}

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
      // Muzzle flash at the shooter + spark + ejected casing at the muzzle.
      const ang = Math.atan2(e.toY - e.y, e.toX - e.x);
      flashes.push({ x: e.x, y: e.y, aim: ang, until: now + 70 });
      if (mine) {
        muzzleNow = true;
        addShake(3.2);
        burst(e.x + Math.cos(ang) * 0.6, e.y + Math.sin(ang) * 0.6, 3, VU, 0.004, now);
        stamps.push({ t, kind: e.hit ? 'hit' : 'shot' });
        if (e.hit) {
          hitUntil = now + 160;
          enemyHitUntil = now + 90;
          addShake(2);
          // Impact sparks where the shot landed.
          burst(e.toX, e.toY, e.head ? 14 : 7, e.head ? '#ffffff' : '#ffd07a', 0.006, now);
          if (e.head) {
            sfx.head();
            toast(`HEADSHOT ${e.damage ?? ''}`, '#ffffff', e.toX, e.toY - 1);
          } else {
            sfx.hit();
          }
        }
      } else if (e.hit) {
        stamps.push({ t, kind: 'hurt' });
        hurtUntil = now + 900;
        addShake(6);
        burst(e.toX, e.toY, 9, REC, 0.006, now);
        if (selfDraw) hurtFrom = Math.atan2(e.y - selfDraw.y, e.x - selfDraw.x);
        sfx.hurt(panFor(e.x));
      }
    } else if (e.type === 'kill') {
      stamps.push({ t, kind: e.killer === me ? 'kill' : 'death' });
      addShake(e.killer === me ? 5 : 8);
      if (e.killer === me) sfx.kill();
      killfeed.push({ killer: names[e.killer] ?? 'rival', victim: names[e.victim] ?? 'you', gun: weapon(e.weapon ?? 0).name, head: !!e.head, mine: e.killer === me, born: now });
      if (killfeed.length > 4) killfeed.shift();
      renderKillfeed();
    } else if (e.type === 'buy') {
      if (e.slot === me) sfx.buy();
    } else if (e.type === 'smoke') {
      stamps.push({ t, kind: 'smoke' });
      sfx.smoke(panFor(e.x));
    } else if (e.type === 'flash') {
      sfx.flashPin(panFor(e.x));
    } else if (e.type === 'flashPop') {
      pops.push({ x: e.x, y: e.y, born: now });
      sfx.flashPop(panFor(e.x));
    } else if (e.type === 'blinded') {
      if (e.slot === me) {
        sfx.flashRing(e.ticks / C.FLASH_BLIND_FULL);
        addShake(4);
        if (e.by === me) toast('SELF FLASH', LABEL, selfDraw?.x ?? 0, (selfDraw?.y ?? 0) - 1.4);
      } else if (e.by === me) {
        toast(`FLASHED ${(e.ticks / TICK_RATE).toFixed(1)}s`, VU, selfDraw?.x ?? 0, (selfDraw?.y ?? 0) - 1.4);
        sfx.hit();
      }
    } else if (e.type === 'flashDodged') {
      if (e.slot === me) toast('DODGED', ICE, selfDraw?.x ?? 0, (selfDraw?.y ?? 0) - 1.4);
    } else if (e.type === 'teleport') {
      burst(e.fromX, e.fromY, 12, '#b48cff', 0.008, now);
      burst(e.x, e.y, 12, '#b48cff', 0.008, now);
      sfx.teleport(e.slot === me ? 0 : panFor(e.x));
      if (e.slot === me) selfDraw = null; // snap, do not glide across the map
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
      flashes = [];
      sparks = [];
      pops = [];
      toasts = [];
      shakeMag = 0;
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
  // What the AI took away from this match.
  const list = $('insights');
  list.innerHTML = '';
  if (brain) {
    const head = document.createElement('p');
    head.className = 'brainHead';
    head.textContent = vsAi
      ? `AI skill now ${Math.round(brain.skill * 100)} · ${brain.rounds} rounds studied${brain.aiWinRate === null ? '' : ` · AI wins ${brain.aiWinRate}% of rounds`}`
      : `${brain.rounds} rounds of your play studied by the AI`;
    list.appendChild(head);
    for (const line of brain.insights.length ? brain.insights : ['Not enough rounds yet to spot your habits. Keep playing.']) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    if (vsAi && brain.skillHistory.length > 1) {
      const cap = document.createElement('p');
      cap.className = 'brainHead';
      cap.textContent = 'AI skill, round by round (red dot = you won the round, so it got harder)';
      list.append(cap, skillChart(brain.skillHistory));
    }
  }
  $('again').textContent = 'Play again';
  $('toReplay').textContent = 'Watch the replay and rewind';
  $('toReplay').style.display = '';
  lastRewind = { outcome: 'won', reason: '', match: matchId, tick: 0, slot: me, attempts: 0, wins: 0, handoffTick: null, ghostSeconds: null, breakerShare: 0 };
  rewindInfo = null; // "again" reloads; "watch the replay" opens this match
  $('result').style.display = 'grid';
}

type BrainSummary = { rounds: number; skill: number; aiWinRate: number | null; insights: string[]; skillHistory: { skill: number; humanWon: boolean }[] };
let brain: BrainSummary | null = null;

/** The map card shown for a few seconds as a match begins. */
function showIntro(lines: string[]): void {
  const el = $('intro');
  el.innerHTML = `<b>${lines[0]}</b>${lines.slice(1).map((l) => `<span>${l.replace(/[<>&]/g, '')}</span>`).join('')}`;
  el.classList.remove('show');
  void el.offsetWidth; // restart the animation
  el.classList.add('show');
}

// --- behaviour trace: why the opponent does what it does ---------------------------------------------

type TraceLine = { tick: number; actor: string; type: string; reason: string; ref?: { match: string; tick: number } };
let traceLines: TraceLine[] = [];
const ACTOR_COLOR: Record<string, string> = { GHOST: DIM, CLONE: ICE, BOT: REC, AI: VU };
const clockOf = (ticks: number) => {
  const s = Math.max(0, Math.floor(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// --- the AI's mind: its probability map of where you are -------------------------------------------

let mind: { cols: number; rows: number; v: Uint8Array } | null = null;
let mindOverlay = false;
const mindCanvas = document.createElement('canvas');
function setMind(m: { cols: number; rows: number; data: string }): void {
  const bin = atob(m.data);
  const v = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) v[i] = bin.charCodeAt(i);
  mind = { cols: m.cols, rows: m.rows, v };
  // Paint it once into a small canvas; drawing scales it up smoothly.
  mindCanvas.width = m.cols;
  mindCanvas.height = m.rows;
  const g = mindCanvas.getContext('2d')!;
  const img = g.createImageData(m.cols, m.rows);
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 60 + (a >> 2);
    img.data[i * 4 + 2] = 40;
    img.data[i * 4 + 3] = a === 0 ? 0 : 40 + Math.round(a * 0.75);
  }
  g.putImageData(img, 0, 0);
  // The small copy in the trace panel.
  const mini = $('mindMini') as HTMLCanvasElement;
  const mg = mini.getContext('2d')!;
  mini.width = 240;
  mini.height = Math.round((240 * map.height) / map.width);
  const s = mini.width / map.width;
  mg.fillStyle = OXIDE_DARK;
  mg.fillRect(0, 0, mini.width, mini.height);
  mg.fillStyle = BAKELITE;
  for (const w of map.walls) mg.fillRect(w.x * s, w.y * s, w.w * s, w.h * s);
  mg.imageSmoothingEnabled = true;
  mg.drawImage(mindCanvas, 0, 0, mini.width, mini.height);
  if (selfDraw) {
    mg.fillStyle = VU;
    mg.beginPath();
    mg.arc(selfDraw.x * s, selfDraw.y * s, 3, 0, 2 * Math.PI);
    mg.fill();
  }
  mini.style.display = 'block';
}

/** Footstep ripples: where you heard a running enemy through the walls. */
type Ripple = { x: number; y: number; born: number };
let ripples: Ripple[] = [];
let lastHeardKey = '';
let lastHeardAt = 0;

type RankT = { index: number; tier: string; division: number | null; label: string; color: string; rr: number };
let aiRankIndex: number | null = null;
let youRankIndex: number | null = null;

/** Rank chips: the AI's rank (with an arrow when it moves), yours with RR, and how often it has read you. */
function showRanks(r: { ai: RankT; you: RankT; reads: { made: number; correct: number } }): void {
  const ai = $('aiLevel');
  ai.style.display = '';
  if (aiRankIndex !== null && r.ai.index !== aiRankIndex) {
    ai.dataset.dir = r.ai.index > aiRankIndex ? 'up' : 'down';
    window.setTimeout(() => (ai.dataset.dir = ''), 4000);
  }
  aiRankIndex = r.ai.index;
  ai.textContent = `AI ${r.ai.label.toUpperCase()}${ai.dataset.dir === 'up' ? ' ▲' : ai.dataset.dir === 'down' ? ' ▼' : ''}`;
  ai.style.borderColor = ai.style.color = r.ai.color;
  ai.title = 'The AI plays at this rank. Win a round and it climbs; lose and it drops. Streaks move it faster.';
  const you = $('youRank');
  you.style.display = '';
  you.textContent = `YOU ${r.you.label.toUpperCase()} · ${r.you.rr} RR`;
  you.style.borderColor = you.style.color = r.you.color;
  you.title = 'Your rank: the AI level you are currently holding your own against.';
  if (youRankIndex !== null && r.you.index !== youRankIndex) {
    const up = r.you.index > youRankIndex;
    const el = $('rankUp');
    el.innerHTML = `<small>${up ? 'RANK UP' : 'DEMOTED'}</small><b></b>`;
    (el.children[1] as HTMLElement).textContent = r.you.label;
    (el.children[1] as HTMLElement).style.color = r.you.color;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    sfx.rankUp(up);
  }
  youRankIndex = r.you.index;
  const reads = $('reads');
  reads.style.display = r.reads.made ? '' : 'none';
  reads.textContent = `AI READS ${r.reads.correct}/${r.reads.made}`;
  reads.title = 'How often the AI called where you would go before it ever saw you.';
}

function setTracePanel(open: boolean): void {
  $('trace').classList.toggle('open', open);
}

function addTrace(lines: TraceLine[]): void {
  traceLines.push(...lines);
  if (traceLines.length > 80) traceLines = traceLines.slice(-80);
  renderTrace();
}

function renderTrace(): void {
  const list = $('traceList');
  list.innerHTML = '';
  for (const t of traceLines.slice().reverse()) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'tt';
    time.textContent = clockOf(t.tick - roundStartTick);
    const who = document.createElement('b');
    who.textContent = `${t.actor} ${t.type}`;
    who.style.color = ACTOR_COLOR[t.actor] ?? LABEL;
    const why = document.createElement('span');
    why.textContent = t.reason;
    li.append(time, who, why);
    if (t.ref) {
      const ref = t.ref;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ref';
      btn.textContent = `↳ copied ${ref.match.slice(0, 18)} @ ${clockOf(ref.tick)}`;
      btn.title = 'Play the recorded moment this decision was copied from';
      btn.addEventListener('click', () => void playMemory(ref));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

// The past moment a clone decision copied, played in a small inset beside the live game.
const memCanvas = $('memory') as HTMLCanvasElement;
const memCtx = memCanvas.getContext('2d')!;
let memory: { d: MatchDetail; from: number; to: number; started: number; ref: { match: string; tick: number } } | null = null;
const detailCache = new Map<string, MatchDetail>();

async function fetchDetail(id: string): Promise<MatchDetail> {
  let d = detailCache.get(id);
  if (!d) {
    const res = await fetch(`${SERVER}/api/matches/${id}`);
    if (!res.ok) throw new Error(`match ${id}: ${res.status}`);
    d = (await res.json()) as MatchDetail;
    detailCache.set(id, d);
  }
  return d;
}

async function playMemory(ref: { match: string; tick: number }): Promise<void> {
  try {
    const d = await fetchDetail(ref.match);
    memory = { d, from: Math.max(0, ref.tick - 48), to: ref.tick + 48, started: performance.now(), ref };
    memCanvas.style.display = 'block';
  } catch {
    memory = null;
  }
}

/** Draws one frame of a recorded match into any 2D context at a given scale. Used by the inset and the viewer. */
function drawFrame(g: CanvasRenderingContext2D, d: MatchDetail, tick: number, s: number, highlight: number | null, t0 = 0): void {
  const m = getMap(d.map);
  g.fillStyle = OXIDE;
  g.fillRect(0, 0, m.width * s, m.height * s);
  for (const r of Object.values(m.sites)) {
    g.fillStyle = 'rgba(229, 72, 59, 0.12)';
    g.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
  }
  g.fillStyle = BAKELITE;
  for (const w of m.walls) g.fillRect(w.x * s, w.y * s, w.w * s, w.h * s);
  const fi = Math.max(0, Math.min(d.frames.length - 1, Math.floor((tick - t0) / d.frameStep)));
  const f = d.frames[fi];
  for (const k of d.smokes) {
    if (k[0] !== fi) continue;
    g.fillStyle = 'rgba(214, 200, 180, 0.8)';
    g.beginPath();
    g.arc(k[1] * s, k[2] * s, C.SMOKE_RADIUS * s, 0, 2 * Math.PI);
    g.fill();
  }
  for (const e of d.events) {
    if (e.type !== 'shot' || e.tick > tick || e.tick < tick - 4) continue;
    g.strokeStyle = e.slot === 0 ? VU : ICE;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(e.x * s, e.y * s);
    g.lineTo(e.toX * s, e.toY * s);
    g.stroke();
  }
  for (const slot of [0, 1]) {
    const [x, y, aim, hp, blind] = f.slice(1 + slot * 5, 6 + slot * 5);
    const color = slot === 0 ? VU : ICE;
    if (hp <= 0) {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo((x - 0.4) * s, (y - 0.4) * s);
      g.lineTo((x + 0.4) * s, (y + 0.4) * s);
      g.moveTo((x + 0.4) * s, (y - 0.4) * s);
      g.lineTo((x - 0.4) * s, (y + 0.4) * s);
      g.stroke();
      continue;
    }
    if (highlight === slot) {
      g.strokeStyle = LABEL;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x * s, y * s, (C.RADIUS + 0.35) * s, 0, 2 * Math.PI);
      g.stroke();
    }
    g.fillStyle = blind > 0 ? '#ffffff' : color;
    g.beginPath();
    g.arc(x * s, y * s, Math.max(3, C.RADIUS * s), 0, 2 * Math.PI);
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo((x + Math.cos(aim) * 0.5) * s, (y + Math.sin(aim) * 0.5) * s);
    g.lineTo((x + Math.cos(aim) * 1.2) * s, (y + Math.sin(aim) * 1.2) * s);
    g.stroke();
  }
}

function drawMemory(now: number): void {
  if (!memory) return;
  const { d, from, to, started, ref } = memory;
  const m = getMap(d.map);
  const s = memCanvas.width / m.width;
  const span = to - from;
  const tick = from + (((now - started) / 1000) * TICK_RATE) % span;
  const who = d.players.find((p) => p.name === rewindInfo?.opponent)?.slot ?? null;
  drawFrame(memCtx, d, tick, s, who);
  memCtx.fillStyle = 'rgba(22, 15, 12, 0.8)';
  memCtx.fillRect(0, 0, memCanvas.width, 16);
  memCtx.fillStyle = Math.abs(tick - ref.tick) < 6 ? VU : LABEL;
  memCtx.font = `700 10px ${MONO}`;
  memCtx.textAlign = 'left';
  memCtx.textBaseline = 'middle';
  memCtx.fillText(`MEMORY ${ref.match.slice(0, 16)} @ ${clockOf(tick)}${Math.abs(tick - ref.tick) < 6 ? '  ← this moment' : ''}`, 4, 8);
}
memCanvas.addEventListener('click', () => {
  memory = null;
  memCanvas.style.display = 'none';
});

// --- AI coach: what would have won each fight you died in -------------------------------------------

type CoachItem = { round: number; tick: number; deathTick: number; status: string; result?: WhatIfResult; error?: string };

async function pollCoach(matchId: string): Promise<void> {
  const box = $('coach');
  for (let tries = 0; tries < 240; tries++) {
    let c: { items: CoachItem[] } | null = null;
    try {
      const res = await fetch(`${SERVER}/api/coach/${matchId}`);
      if (res.ok) c = await res.json();
    } catch { /* server gone: stop quietly */ }
    if (!c) return;
    renderCoach(box, matchId, c.items);
    if (c.items.every((i) => i.status === 'done' || i.status === 'error')) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function renderCoach(box: HTMLElement, matchId: string, items: CoachItem[]): void {
  box.innerHTML = '';
  const h = document.createElement('h3');
  const done = items.filter((i) => i.status === 'done').length;
  h.textContent = done < items.length ? `AI coach: reviewing your deaths (${done}/${items.length})…` : 'AI coach: how you could have won';
  box.appendChild(h);
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'coachItem';
    b.innerHTML = '<small></small><b></b><span></span>';
    b.children[0].textContent = `Round ${it.round} · you died ${((it.deathTick - it.tick) / TICK_RATE).toFixed(1)}s after this moment`;
    if (it.status === 'done' && it.result) {
      const best = it.result.top[0];
      b.children[1].textContent = `${best.name}: won the fight ${best.fightsWon}/${best.runs}`;
      b.children[2].textContent = `${it.result.futures} futures simulated. Best run: ${best.reason}. Click to watch it.`;
      b.addEventListener('click', async () => {
        $('result').style.display = 'none';
        await openViewer(matchId, it.tick, 0);
        whatIfResult = it.result!;
        renderWhatIf(it.result!);
        if (viewer) viewer.alt = { f: best, started: performance.now() };
      });
    } else {
      b.disabled = true;
      b.children[1].textContent = it.status === 'error' ? 'Could not review this one' : it.status === 'running' ? 'Simulating 100 futures…' : 'Waiting…';
      b.children[2].textContent = it.error ?? '';
    }
    box.appendChild(b);
  }
}

// --- rewind result ------------------------------------------------------------------------------------

type RewindEnd = { outcome: 'won' | 'lost' | 'abandoned'; reason: string; match: string; tick: number; slot: number; attempts: number; wins: number; handoffTick: number | null; ghostSeconds: number | null; breakerShare: number };
let lastRewind: RewindEnd | null = null;

function showRewindResult(r: RewindEnd): void {
  lastRewind = r;
  const won = r.outcome === 'won';
  $('resultTitle').textContent = won ? 'Won' : 'Lost';
  $('resultTitle').style.color = won ? REC : '';
  const why = { kill: 'elimination', time: 'time ran out', defuse: 'spike defused', detonation: 'spike detonated' }[r.reason] ?? r.reason;
  const was = rewindInfo?.originalOutcome === 'lost' ? ' You had lost it the first time.' : '';
  $('resultSub').textContent = `Rewind of round ${rewindInfo?.round ?? '?'} (${why}).${was} From this moment you have won ${r.wins} of ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}.`;
  const list = $('insights');
  list.innerHTML = '';
  const head = document.createElement('p');
  head.className = 'brainHead';
  head.textContent = `How ${rewindInfo?.opponent ?? 'the opponent'} was played`;
  list.appendChild(head);
  const lines = [
    r.handoffTick === null
      ? 'The ghost replayed the whole round: you played it close enough to the original that nothing diverged.'
      : `Ghost for ${r.ghostSeconds}s, replaying their real inputs. Then you changed the fight and the clone took over.`,
    rewindInfo?.clone.used
      ? `The clone copied ${rewindInfo.opponent}'s recorded decisions (k = 7 nearest moments).${r.breakerShare ? ` For ${r.breakerShare}% of the time the situation was new to it, so the basic bot stood in.` : ' It never had to fall back to the basic bot.'}`
      : 'Not enough recordings for a clone, so the basic bot played after the handoff.',
  ];
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    list.appendChild(li);
  }
  $('again').textContent = 'Try again from this moment';
  $('toReplay').textContent = 'Back to the replay';
  $('toReplay').style.display = '';
  $('result').style.display = 'grid';
}

$('toReplay').addEventListener('click', () => {
  $('result').style.display = 'none';
  setTracePanel(false);
  memory = null;
  memCanvas.style.display = 'none';
  if (lastRewind) void openViewer(lastRewind.match, lastRewind.tick, lastRewind.slot);
});

/** A small line chart of the AI's skill after each adaptive round, dots where you won the round. */
function skillChart(history: { skill: number; humanWon: boolean }[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 260;
  const h = 56;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'skillChart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `AI skill over the last ${history.length} rounds, now ${Math.round((history.at(-1)?.skill ?? 0) * 100)}`);
  const X = (i: number) => 6 + (i / Math.max(1, history.length - 1)) * (w - 12);
  const Y = (v: number) => h - 6 - v * (h - 12);
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', history.map((p, i) => `${X(i)},${Y(p.skill)}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  svg.appendChild(line);
  history.forEach((p, i) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(X(i)));
    c.setAttribute('cy', String(Y(p.skill)));
    c.setAttribute('r', '3');
    c.setAttribute('fill', p.humanWon ? '#e5483b' : '#1d1612');
    svg.appendChild(c);
  });
  return svg;
}

// --- replay viewer --------------------------------------------------------------------------------------

type RoundInfo = { round: number; attacker: number; startTick: number; endTick: number; winner: number | null; reason: string | null; kills: { tick: number; killer: number; victim: number }[] };
type MatchSummaryT = { id: string; map: string; players: { slot: number; name: string }[]; ticks: number; score: [number, number]; rounds: RoundInfo[]; branches: number };
type MatchDetail = Omit<MatchSummaryT, 'branches'> & {
  frameStep: number;
  frames: number[][];
  events: GameEvent[];
  smokes: [number, number, number][];
  branches: { forkTick: number; human: number; outcome: string; handoffTick: number | null }[];
};

/** One simulated future from the what-if planner, as the server sends it. */
type Future = { id: string; name: string; score: number; fightsWon: number; survived: number; roundsWon: number; runs: number; reason: string; frames: number[][]; events: GameEvent[] };
type WhatIfResult = { match: string; forkTick: number; human: number; futures: number; ms: number; baseline: Future; top: Future[]; all: { name: string; score: number; fightsWon: number; runs: number }[]; opponent: string; clone: string };

let viewer: {
  d: MatchDetail; t: number; playing: boolean; speed: number; me: number; vision: boolean;
  /** A simulated future being played in place of the recording. */
  alt?: { f: Future; started: number };
} | null = null;
let whatIfResult: WhatIfResult | null = null;

async function runWhatIf(): Promise<void> {
  if (!viewer) return;
  const { d, me } = viewer;
  const tick = Math.floor(viewer.t);
  const box = $('whatIf');
  const status = $('vStatus');
  box.innerHTML = '';
  status.textContent = 'Simulating futures from this moment…';
  ($('vWhatIf') as HTMLButtonElement).disabled = true;
  try {
    const res = await fetch(`${SERVER}/api/whatif?match=${encodeURIComponent(d.id)}&tick=${tick}&slot=${me}`, { method: 'POST' });
    let job = await res.json();
    if (!res.ok) throw new Error(job.error ?? res.status);
    while (job.status === 'running') {
      status.textContent = `Simulating ${job.done}/${job.total} futures against ${d.players.find((p) => p.slot !== me)?.name}${job.best ? ` · best so far: ${job.best}` : ''}`;
      await new Promise((r) => setTimeout(r, 250));
      job = await (await fetch(`${SERVER}/api/whatif/${job.id}`)).json();
    }
    if (job.status === 'error') throw new Error(job.error);
    whatIfResult = job.result as WhatIfResult;
    renderWhatIf(whatIfResult);
    status.textContent = `${whatIfResult.futures} futures in ${(whatIfResult.ms / 1000).toFixed(1)} s vs ${whatIfResult.clone}. Click a card to watch it.`;
  } catch (err) {
    status.textContent = `What-if failed: ${(err as Error).message}`;
  } finally {
    ($('vWhatIf') as HTMLButtonElement).disabled = false;
  }
}

function renderWhatIf(r: WhatIfResult): void {
  const box = $('whatIf');
  box.innerHTML = '';
  const card = (f: Future, label: string, cls: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `future ${cls}`;
    const runs = f.runs > 1 ? `won the fight ${f.fightsWon}/${f.runs} · survived ${f.survived}/${f.runs}` : 'what really happened';
    b.innerHTML = '<small></small><b></b><span></span><em></em>';
    b.children[0].textContent = label;
    b.children[1].textContent = f.name;
    b.children[2].textContent = runs;
    b.children[3].textContent = `best run: ${f.reason}`;
    b.addEventListener('click', () => {
      if (!viewer) return;
      viewer.alt = { f, started: performance.now() };
      viewer.playing = false;
    });
    box.appendChild(b);
  };
  card(r.baseline, 'YOU DID', 'base');
  r.top.forEach((f, i) => card(f, `#${i + 1} OF ${r.all.length}`, i === 0 ? 'best' : ''));
}

async function openReplays(): Promise<void> {
  const box = $('replayList');
  box.textContent = 'Loading…';
  $('replays').style.display = 'grid';
  try {
    const res = await fetch(`${SERVER}/api/matches`);
    if (!res.ok) throw new Error(String(res.status));
    const list = (await res.json()) as MatchSummaryT[];
    box.innerHTML = '';
    if (!list.length) box.textContent = 'No recorded matches yet. Play one first.';
    for (const mt of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'matchRow';
      const when = /-(\d{13})$/.exec(mt.id);
      const date = when ? new Date(Number(when[1])).toLocaleString() : mt.id;
      b.innerHTML = `<b></b><span></span><small></small>`;
      b.children[0].textContent = `${getMap(mt.map).name} · ${mt.players.map((p) => p.name).join(' vs ')}`;
      b.children[1].textContent = `${mt.score.join('–')} · ${mt.rounds.length} rounds${mt.branches ? ` · ${mt.branches} rewind${mt.branches === 1 ? '' : 's'}` : ''}`;
      b.children[2].textContent = date;
      b.addEventListener('click', () => void openViewer(mt.id));
      box.appendChild(b);
    }
  } catch {
    box.textContent = 'Could not load matches. The game server is not running, or it is running old code: stop it (Ctrl+C) and run npm run server again.';
  }
}

/** Set once the server answers /api/version with the version this page was built for. */
let serverOk = false;
const API_VERSION = 3;
async function checkServer(): Promise<void> {
  try {
    const res = await fetch(`${SERVER}/api/version`);
    const v = res.ok ? ((await res.json()) as { version: number }).version : 0;
    serverOk = v === API_VERSION;
    if (!serverOk) $('status').textContent = `The game server is running old code (version ${v || 'unknown'}, page expects ${API_VERSION}). Stop it with Ctrl+C and run npm run server again.`;
  } catch {
    $('status').textContent = 'Game server not reachable. Start it in another terminal: npm run server';
  }
}
void checkServer();

/** Leaves whatever was on screen (a finished match, a rewind) so its last frame and banner cannot stay frozen. */
function clearLive(): void {
  obs = null;
  banner = null;
  toasts = [];
  pops = [];
  setTracePanel(false);
}

/** Back to the lobby with a message the player can actually see. */
function backToLobby(message: string): void {
  clearLive();
  closeViewer();
  $('result').style.display = 'none';
  $('replays').style.display = 'none';
  $('join').style.display = 'grid';
  $('status').textContent = message;
}

async function openViewer(id: string, atTick?: number, asSlot?: number): Promise<void> {
  void setFp(false);
  clearLive();
  $('result').style.display = 'none';
  let d: MatchDetail | null = null;
  try {
    d = await fetchDetail(id);
  } catch (err) {
    backToLobby(serverOk
      ? `Could not load the replay ${id}: ${(err as Error).message}`
      : 'Could not load the replay: the game server is not running or is running old code. Stop it (Ctrl+C) and run npm run server again.');
    return;
  }
  detailCache.delete(id); // branch list changes after each rewind; refetch next time
  map = getMap(d.map);
  names = d.players.map((p) => p.name);
  document.body.classList.add('viewing');
  resize();
  const nameNow = nameInput.value.trim();
  const guess = d.players.find((p) => p.name === nameNow)?.slot ?? 0;
  viewer = { d, t: atTick ?? 0, playing: atTick === undefined, speed: 1, me: asSlot ?? guess, vision: true };
  obs = null;
  document.body.classList.add('viewing');
  $('join').style.display = 'none';
  $('replays').style.display = 'none';
  $('result').style.display = 'none';
  ($('scrub') as HTMLInputElement).max = String(d.ticks - 1);
  $('whatIf').innerHTML = '';
  whatIfResult = null;
  renderViewerBar();
}

function closeViewer(): void {
  viewer = null;
  document.body.classList.remove('viewing');
}

/** The moment to rewind to for a round: 5 seconds before its first kill, or 3 seconds in if nobody died. */
function keyMoment(r: RoundInfo): number {
  const k = r.kills[0];
  return k ? Math.max(r.startTick + 16, k.tick - 5 * TICK_RATE) : r.startTick + 3 * TICK_RATE;
}

function renderViewerBar(): void {
  if (!viewer) return;
  const { d, me } = viewer;
  const who = $('vMe');
  who.innerHTML = '';
  for (const p of d.players) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.style.color = p.slot === 0 ? VU : ICE;
    b.setAttribute('aria-pressed', String(p.slot === me));
    b.addEventListener('click', () => {
      viewer!.me = p.slot;
      renderViewerBar();
    });
    who.appendChild(b);
  }
  const rounds = $('vRounds');
  rounds.innerHTML = '';
  for (const r of d.rounds) {
    const b = document.createElement('button');
    b.type = 'button';
    const outcome = r.winner === null ? '…' : r.winner === me ? 'won' : 'lost';
    b.className = `roundChip ${outcome}`;
    const tries = d.branches.filter((x) => x.forkTick >= r.startTick && x.forkTick <= r.endTick && x.human === me);
    b.textContent = `R${r.round} ${outcome}${tries.length ? ` · ${tries.filter((x) => x.outcome === 'won').length}/${tries.length} retries won` : ''}`;
    b.title = r.reason ? `Round ${r.round}: ${r.reason}. Jumps to 5 s before the first kill.` : '';
    b.addEventListener('click', () => {
      viewer!.t = keyMoment(r);
      viewer!.playing = false;
      viewer!.alt = undefined;
    });
    rounds.appendChild(b);
  }
  $('vOpp').textContent = d.players.find((p) => p.slot !== me)?.name ?? 'opponent';
}

$('openReplays').addEventListener('click', () => void openReplays());
$('replaysBack').addEventListener('click', () => ($('replays').style.display = 'none'));
$('vBack').addEventListener('click', () => {
  closeViewer();
  $('join').style.display = 'grid';
  void openReplays();
});
$('vPlay').addEventListener('click', () => viewer && (viewer.playing = !viewer.playing));
$('vSpeed').addEventListener('click', () => {
  if (!viewer) return;
  viewer.speed = viewer.speed === 1 ? 2 : viewer.speed === 2 ? 0.5 : 1;
  $('vSpeed').textContent = `${viewer.speed}×`;
});
$('vVision').addEventListener('click', () => viewer && (viewer.vision = !viewer.vision));
$('scrub').addEventListener('input', (e) => {
  if (!viewer) return;
  viewer.t = Number((e.target as HTMLInputElement).value);
  viewer.playing = false;
  viewer.alt = undefined;
});
$('vWhatIf').addEventListener('click', () => void runWhatIf());
$('vRewind').addEventListener('click', () => {
  if (!viewer) return;
  const { d, me } = viewer;
  const name = nameInput.value.trim() || d.players.find((p) => p.slot === me)!.name;
  connect({ mode: 'rewind', match: d.id, tick: Math.floor(viewer.t), slot: me, name }, $('vStatus'));
});

function drawViewer(now: number, dt: number): void {
  const v = viewer!;
  const { d } = v;
  if (v.playing) v.t = Math.min(d.ticks - 1, v.t + (dt / 1000) * TICK_RATE * v.speed);
  if (v.t >= d.ticks - 1) v.playing = false;
  ($('scrub') as HTMLInputElement).value = String(Math.floor(v.t));
  $('vPlay').textContent = v.playing ? 'Pause' : 'Play';
  $('vVision').setAttribute('aria-pressed', String(v.vision));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (v.alt) {
    // A simulated future, looping: its 5 seconds, then a beat of stillness, then again.
    const f = v.alt.f;
    const t0 = f.frames[0][0];
    const span = f.frames[f.frames.length - 1][0] - t0;
    const t = t0 + Math.min(span, (((now - v.alt.started) / 1000) * TICK_RATE) % (span + 24));
    drawFrame(ctx, { ...d, frames: f.frames, events: f.events, smokes: [], frameStep: 2 }, t, scale, v.me, t0);
    drawWalls();
    ctx.fillStyle = 'rgba(22, 15, 12, 0.82)';
    ctx.fillRect(0, 0, map.width * scale, 28);
    ctx.fillStyle = VU;
    ctx.font = `700 12px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`SIMULATED FUTURE · ${f.name.toUpperCase()} · +${((t - t0) / TICK_RATE).toFixed(1)}s · ${f.reason}`, 8, 14);
    ctx.fillStyle = DIM;
    ctx.textAlign = 'right';
    ctx.fillText('click the timeline to go back to the recording', map.width * scale - 8, 14);
    drawViewerTape(v, d.rounds.find((x) => t0 >= x.startTick && t0 <= x.endTick) ?? d.rounds[0]);
    return;
  }
  drawFrame(ctx, d, v.t, scale, v.me);
  // Your vision at that moment, so you can see what you could and could not see.
  if (v.vision) {
    const f = d.frames[Math.min(d.frames.length - 1, Math.floor(v.t / d.frameStep))];
    const [x, y, aim, hp] = f.slice(1 + v.me * 5, 5 + v.me * 5);
    if (hp > 0) {
      const fi = Math.floor(v.t / d.frameStep);
      const smokes = d.smokes.filter((k) => k[0] === fi).map((k) => ({ x: k[1], y: k[2], ticksLeft: 1 }));
      fogCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fogCtx.globalCompositeOperation = 'source-over';
      fogCtx.clearRect(0, 0, map.width * scale, map.height * scale);
      fogCtx.fillStyle = 'rgba(18, 12, 9, 0.55)';
      fogCtx.fillRect(0, 0, map.width * scale, map.height * scale);
      fogCtx.globalCompositeOperation = 'destination-out';
      fogCtx.beginPath();
      for (const [px, py] of visionPolygon({ smokes } as unknown as Observation, x, y, aim)) fogCtx.lineTo(px * scale, py * scale);
      fogCtx.closePath();
      fogCtx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(fog, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  drawWalls();
  const r = d.rounds.find((x) => v.t >= x.startTick && v.t <= x.endTick) ?? d.rounds[d.rounds.length - 1];
  ctx.fillStyle = 'rgba(22, 15, 12, 0.75)';
  ctx.fillRect(0, 0, 260, 26);
  ctx.fillStyle = LABEL;
  ctx.font = `700 12px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`REPLAY · ROUND ${r.round} · ${clockOf(v.t - r.startTick)}`, 8, 13);
  drawViewerTape(v, r);
  void now;
}

/** The whole match as a strip: rounds, kills (amber = yours), plants, earlier rewinds (ticks), and the playhead. */
function drawViewerTape(v: NonNullable<typeof viewer>, current: RoundInfo): void {
  const w = map.width * scale;
  const h = TAPE_H;
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.fillStyle = OXIDE_DARK;
  tctx.fillRect(0, 0, w, h);
  const X = (t: number) => (t / v.d.ticks) * w;
  for (const r of v.d.rounds) {
    tctx.fillStyle = r === current ? '#3a2d25' : '#2a201a';
    tctx.fillRect(X(r.startTick) + 1, 4, X(r.endTick) - X(r.startTick) - 2, h - 8);
    tctx.fillStyle = r.winner === v.me ? VU : r.winner === null ? DIM : ICE;
    tctx.fillRect(X(r.startTick) + 1, h - 5, X(r.endTick) - X(r.startTick) - 2, 2);
    for (const k of r.kills) {
      tctx.fillStyle = k.killer === v.me ? VU : ICE;
      tctx.save();
      tctx.translate(X(k.tick), h / 2);
      tctx.rotate(Math.PI / 4);
      tctx.fillRect(-3.5, -3.5, 7, 7);
      tctx.restore();
    }
  }
  for (const e of v.d.events) {
    if (e.type !== 'plant') continue;
    tctx.fillStyle = REC;
    tctx.fillRect(X(e.tick) - 1, 3, 3, h - 6);
  }
  for (const b of v.d.branches) {
    if (b.human !== v.me) continue;
    tctx.fillStyle = b.outcome === 'won' ? VU : LABEL;
    tctx.fillRect(X(b.forkTick), 0, 1, 6);
  }
  tctx.fillStyle = REC;
  tctx.fillRect(Math.round(X(v.t)) - 1, 0, 2, h);
}
tape.addEventListener('click', (e) => {
  if (!viewer) return;
  const r = tape.getBoundingClientRect();
  viewer.t = Math.max(0, Math.min(viewer.d.ticks - 1, ((e.clientX - r.left) / r.width) * viewer.d.ticks));
  viewer.playing = false;
  viewer.alt = undefined;
});

// --- lobby: mode, map vote, difficulty ---------------------------------------------------------------

type Mode = 'ai' | 'pvp' | 'mirror';
let mode: Mode = 'ai';
let vote = 'random';
let difficulty = 'adaptive';
const modeButtons = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
const MODE_BLURB: Record<Mode, string> = {
  ai: 'The AI tracks where you probably are, calls your play, learns your habits, and plays at your rank.',
  mirror: 'Fight yourself: a clone built from every decision you have recorded, with your guns. Needs a match or two first.',
  pvp: 'Two players, same room code. Both of you are studied by the AI as you play.',
};
function setMode(m: Mode): void {
  mode = m;
  modeButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('roomRow').style.display = m === 'pvp' ? '' : 'none';
  $('diffRow').style.display = m === 'ai' ? '' : 'none';
  roomInput.required = m === 'pvp';
  $('joinBtn').textContent = m === 'ai' ? 'Play the AI' : m === 'mirror' ? 'Fight your clone' : 'Join room';
  $('mapLabel').textContent = m === 'pvp' ? 'Map vote' : 'Map';
  $('modeBlurb').textContent = MODE_BLURB[m];
}
modeButtons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));

// Fixed-rank picker: every rank from Iron 1 to Apex.
const rankSel = $('rankSel') as HTMLSelectElement;
rankSel.innerHTML = `<option value="">or pick a fixed rank…</option>${ALL_RANKS.map((r) => `<option value="${r.index}">${r.label}</option>`).join('')}`;
rankSel.addEventListener('change', () => {
  difficulty = rankSel.value === '' ? 'adaptive' : `rank:${rankSel.value}`;
  document.querySelectorAll('[data-diff]').forEach((x) => x.setAttribute('aria-pressed', String(difficulty === 'adaptive')));
});

/** Draws a map as a tiny floor plan for the lobby. */
function preview(c: HTMLCanvasElement, m: ReturnType<typeof getMap>): void {
  const s = 3;
  c.width = m.width * s;
  c.height = m.height * s;
  const g = c.getContext('2d')!;
  g.fillStyle = OXIDE;
  g.fillRect(0, 0, c.width, c.height);
  for (const r of Object.values(m.sites)) {
    g.fillStyle = 'rgba(229, 72, 59, 0.35)';
    g.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
  }
  g.fillStyle = BAKELITE_EDGE;
  for (const w of m.walls) g.fillRect(w.x * s, w.y * s, w.w * s, w.h * s);
  g.fillStyle = '#b48cff';
  for (const tp of m.teleporters) g.fillRect(tp.pad.x * s, tp.pad.y * s, tp.pad.w * s, tp.pad.h * s);
  g.fillStyle = VU;
  g.fillRect(m.spawns.attacker.x * s - 3, m.spawns.attacker.y * s - 3, 6, 6);
  g.fillStyle = ICE;
  g.fillRect(m.spawns.defender.x * s - 3, m.spawns.defender.y * s - 3, 6, 6);
}

const mapGrid = $('maps');
for (const id of ['random', ...MAP_IDS]) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mapCard';
  b.dataset.map = id;
  if (id === 'random') {
    b.innerHTML = `<span class="mapArt randomArt">?</span><b>Random</b><small>Any map</small>`;
  } else {
    const m = getMap(id);
    const c = document.createElement('canvas');
    c.className = 'mapArt';
    preview(c, m);
    b.appendChild(c);
    b.insertAdjacentHTML('beforeend', `<b>${m.name}</b><small>${Object.keys(m.sites).length} sites${m.teleporters.length ? ' · TP' : ''}</small>`);
    b.title = m.blurb;
  }
  b.addEventListener('click', () => {
    vote = id;
    mapGrid.querySelectorAll('.mapCard').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.map === id)));
    $('mapBlurb').textContent = id === 'random' ? 'Let fate pick. In a friend match, a Random vote goes with the other vote.' : getMap(id).blurb;
  });
  mapGrid.appendChild(b);
}
(mapGrid.firstElementChild as HTMLButtonElement).click();

document.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((b) => b.addEventListener('click', () => {
  difficulty = b.dataset.diff!;
  rankSel.value = '';
  document.querySelectorAll('[data-diff]').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.diff === difficulty)));
}));
$('again').addEventListener('click', () => {
  // After a rewind, "again" means another attempt from the same moment: a new branch.
  if (lastRewind && rewindInfo) {
    const r = lastRewind;
    lastRewind = null;
    connect({ mode: 'rewind', match: r.match, tick: r.tick, slot: r.slot, name: nameInput.value.trim() || names[r.slot] }, $('resultSub'));
    return;
  }
  location.reload();
});

const nameInput = $('name') as HTMLInputElement;
const roomInput = $('room') as HTMLInputElement;
try {
  nameInput.value = localStorage.getItem('rd-name') ?? '';
} catch { /* storage blocked: the field just starts empty */ }

// Under `npm run web` the page is on Vite's port and the game server is on 8080.
// Anywhere else (the built client, a tunnel) the same server serves both, so use the page's own origin.
const SERVER = location.port === '5173' ? `${location.protocol}//${location.hostname}:8080` : '';
const WS_URL = location.port === '5173'
  ? `ws://${location.hostname}:8080`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

/** The rewind this client is in (or just finished), so "Try again" can rejoin the same moment. */
let rewindInfo: { match: string; tick: number; slot: number; opponent: string; round: number; branch: number; originalOutcome: string | null; clone: { samples: number; matches: number; limit: number; used: boolean } } | null = null;

/** Opens a connection and sends `join`. Used by the lobby, by "Rewind from here" and by "Try again". */
function connect(join: Record<string, unknown>, status: HTMLElement): void {
  initAudio();
  status.textContent = 'Connecting…';
  ws = new WebSocket(WS_URL);
  ws.onopen = () => ws!.send(JSON.stringify({ t: 'join', ...join }));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.t === 'joined') {
      if (join.mode === 'pvp') status.textContent = `In room “${String(join.room).toLowerCase()}”, map vote: ${msg.votes?.[msg.slot] ?? 'Random'}. Waiting for a second player: send them this page and the room code.`;
    } else if (msg.t === 'error') {
      status.textContent = msg.msg;
    } else if (msg.t === 'start') {
      names = msg.names;
      map = getMap(msg.map);
      predictor.setMap(msg.map);
      selfDraw = enemyDraw = null;
      obs = null;
      banner = null; // a rewind starts mid-round: no leftover "Round won" from the last session
      traceLines = [];
      renderTrace();
      closeViewer();
      resize();
      vsAi = !!msg.ai;
      rewindInfo = msg.rewind ?? null;
      const intro = [`${map.name.toUpperCase()}`, map.blurb];
      if (rewindInfo) {
        roundStartTick = msg.rewind.roundStartTick;
        stamps = [];
        seen = [];
        intro[0] = `REWIND · ROUND ${rewindInfo.round}`;
        intro[1] = `Attempt ${rewindInfo.branch}. ${rewindInfo.originalOutcome === 'lost' ? 'You lost this round.' : rewindInfo.originalOutcome === 'won' ? 'You won this round.' : ''} ${rewindInfo.opponent}'s ghost replays exactly what they did. Change the fight and their clone takes over.`;
        intro.push(rewindInfo.clone.used
          ? `Clone of ${rewindInfo.opponent}: ${rewindInfo.clone.samples} recorded decisions from ${rewindInfo.clone.matches} match${rewindInfo.clone.matches === 1 ? '' : 'es'}.`
          : `Not enough recordings of ${rewindInfo.opponent} yet: the basic bot stands in after the handoff.`);
        setTracePanel(true);
      } else if (msg.ai) {
        const b = msg.brain;
        intro.push(b.rounds
          ? `The AI has studied you for ${b.rounds} rounds. Skill ${Math.round(msg.ai.skill * 100)}.`
          : `First match: the AI starts learning you now. Skill ${Math.round(msg.ai.skill * 100)}.`);
        setTracePanel(true);
      } else if (msg.votes?.[0] !== msg.votes?.[1]) {
        intro.push(`Votes: ${msg.votes.map((v: string) => (v === 'random' ? 'Random' : getMap(v).name)).join(' vs ')}`);
      }
      showIntro(intro);
      $('join').style.display = 'none';
      $('result').style.display = 'none';
    } else if (msg.t === 'obs') {
      const o: Observation = msg.obs;
      obs = o;
      predictor.reconcile(o.self, msg.ack ?? 0, o.phase === 'live');
      onEvents(msg.events, o.slot);
      if (msg.trace?.length) addTrace(msg.trace);
      if (msg.ranks) showRanks(msg.ranks);
      if (msg.mind) setMind(msg.mind);
      if (o.heard && o.phase === 'live') {
        const now = performance.now();
        const key = `${o.heard.x},${o.heard.y}`;
        if (key !== lastHeardKey || now - lastHeardAt > 300) {
          lastHeardKey = key;
          lastHeardAt = now;
          ripples.push({ x: o.heard.x, y: o.heard.y, born: now });
          sfx.step(panFor(o.heard.x));
        }
      }
      if (o.enemy && o.phase === 'live') {
        const t = o.tick - roundStartTick;
        const last = seen[seen.length - 1];
        if (last && last[1] >= t - 1) last[1] = t;
        else seen.push([t, t]);
      }
    } else if (msg.t === 'end') {
      brain = msg.brain ?? null;
      if (msg.rewind) showRewindResult(msg.rewind);
      else showResult(msg.matchId, msg.why);
      $('coach').innerHTML = '';
      if (msg.coach) void pollCoach(msg.matchId);
    }
  };
  ws.onclose = () => {
    if (!obs) status.textContent = 'Could not reach the game server. Check that it is running, then try again.';
  };
}

$('join').addEventListener('submit', (ev) => {
  ev.preventDefault();
  try {
    localStorage.setItem('rd-name', nameInput.value);
  } catch { /* not important */ }
  connect({ name: nameInput.value, room: roomInput.value, mode, map: vote, difficulty }, $('status'));
});

// --- input --------------------------------------------------------------------------------------

const keys = new Set<string>();
const mouse = { x: map.width / 2, y: map.height / 2, down: false };
addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement) return;
  if (e.code === 'KeyM' && !e.repeat) $('net').dataset.muted = toggleMute() ? '1' : '';
  if (e.code === 'KeyT' && !e.repeat) setTracePanel(!$('trace').classList.contains('open'));
  if (e.code === 'KeyI' && !e.repeat) mindOverlay = !mindOverlay;
  if (e.code === 'KeyB' && !e.repeat) $('buy').classList.toggle('hidden');
  // Digits: buy in the buy phase, otherwise 1 = primary, 2 = secondary.
  if (!e.repeat && e.code in BUY_KEYS) {
    if (buyingNow()) pendingBuy = BUY_KEYS[e.code];
    else if (e.code === 'Digit1') pendingEquip = 0;
    else if (e.code === 'Digit2') pendingEquip = 1;
  }
  if (e.code === 'KeyV' && !e.repeat && !viewer) void setFp(!fp);
  if (e.code === 'Space' && viewer && !e.repeat) {
    viewer.playing = !viewer.playing;
    e.preventDefault();
  }
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

/**
 * First person: W moves where you look, D to your right. The engine only takes 8 directions, so the wanted
 * direction snaps to the nearest of them (each axis is on when the direction leans past 22.5 degrees).
 */
function fpMove(): Input['move'] {
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  if (!fwd && !side) return { x: 0, y: 0 };
  const dx = fwd * Math.cos(yaw) - side * Math.sin(yaw);
  const dy = fwd * Math.sin(yaw) + side * Math.cos(yaw);
  const len = Math.hypot(dx, dy);
  const snap = (v: number) => (v / len > 0.38 ? 1 : v / len < -0.38 ? -1 : 0) as -1 | 0 | 1;
  return { x: snap(dx), y: snap(dy) };
}

/** The input for this tick: keys and mouse, plus any buy or weapon swap pressed since the last tick. */
function currentInput(): Input {
  const input = baseInput();
  if (pendingBuy !== undefined) input.buy = pendingBuy;
  if (pendingEquip !== undefined) input.equip = pendingEquip;
  pendingBuy = pendingEquip = undefined;
  return input;
}

function baseInput(): Input {
  const axis = (pos: string, neg: string) => ((keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0)) as -1 | 0 | 1;
  if (fp) {
    return {
      move: fpMove(), walk: keys.has('ShiftLeft') || keys.has('ShiftRight'), aim: yaw, fire: mouse.down,
      reload: keys.has('KeyR'), smoke: keys.has('KeyQ'), dash: keys.has('KeyE'), use: keys.has('KeyF'), flash: keys.has('KeyC'),
    };
  }
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
    flash: keys.has('KeyC'),
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

  // Teleporter pads glow and pulse; a faint line shows where each one sends you.
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  for (const tp of map.teleporters) {
    const { x, y, w, h } = tp.pad;
    ctx.fillStyle = `rgba(180, 140, 255, ${0.25 + 0.2 * pulse})`;
    ctx.fillRect(x * scale, y * scale, w * scale, h * scale);
    ctx.strokeStyle = '#b48cff';
    ctx.lineWidth = 2;
    ctx.strokeRect(x * scale + 1, y * scale + 1, w * scale - 2, h * scale - 2);
    ctx.setLineDash([2, 8]);
    ctx.strokeStyle = 'rgba(180, 140, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo((x + w / 2) * scale, (y + h / 2) * scale);
    ctx.lineTo(tp.exit.x * scale, tp.exit.y * scale);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(180, 140, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(tp.exit.x * scale, tp.exit.y * scale, 0.35 * scale, 0, 2 * Math.PI);
    ctx.fill();
  }

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
  drawMemory(now);
  if (viewer) {
    drawViewer(now, dt);
    return;
  }
  // Screen shake: a small random offset that decays each frame.
  shakeMag *= Math.exp(-dt / 70);
  if (shakeMag < 0.05) shakeMag = 0;
  const sx = (Math.random() * 2 - 1) * shakeMag;
  const sy = (Math.random() * 2 - 1) * shakeMag;
  ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
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
  const aim = live ? (fp ? yaw : aimFrom(selfDraw)) : o.self.aim;

  // Footstep ticks while running (moving and not walking).
  const runningNow = live && alive && (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD')) && !(keys.has('ShiftLeft') || keys.has('ShiftRight'));
  if (runningNow && now - lastStepAt > 260) {
    lastStepAt = now;
    sfx.step(0);
  }

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
    drawPlayer(enemyDraw.x, enemyDraw.y, o.enemy.aim, enemyHitUntil > now ? '#ffffff' : ICE);
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

  // Muzzle flashes.
  flashes = flashes.filter((f) => f.until > now);
  for (const f of flashes) {
    const a = (f.until - now) / 70;
    const mx = (f.x + Math.cos(f.aim) * 0.6) * scale;
    const my = (f.y + Math.sin(f.aim) * 0.6) * scale;
    ctx.save();
    ctx.globalAlpha = a;
    const grad = ctx.createRadialGradient(mx, my, 0, mx, my, 0.9 * scale);
    grad.addColorStop(0, 'rgba(255,240,190,0.95)');
    grad.addColorStop(1, 'rgba(255,180,70,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mx, my, 0.9 * scale, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // Sparks / casings / blood.
  sparks = sparks.filter((s) => now - s.born < s.life);
  for (const s of sparks) {
    const age = (now - s.born) / s.life;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= 0.92;
    s.vy *= 0.92;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x * scale - 1.5, s.y * scale - 1.5, 3, 3);
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

  // The AI's mind (B): where it believes you are. Red = likely. It only knows what it saw and heard.
  if (mindOverlay && mind) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.75;
    ctx.drawImage(mindCanvas, 0, 0, map.width * scale, map.height * scale);
    ctx.restore();
    ctx.fillStyle = 'rgba(22, 15, 12, 0.8)';
    ctx.fillRect(0, map.height * scale - 22, 330, 22);
    ctx.fillStyle = REC;
    ctx.font = `700 11px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('AI MIND: where it thinks you are (B to hide)', 8, map.height * scale - 11);
  }

  // Footsteps you heard through walls: rings that spread from the rough spot.
  ripples = ripples.filter((r) => now - r.born < 700);
  for (const r of ripples) {
    const t = (now - r.born) / 700;
    arc(r.x, r.y, 0.4 + t * 2.2, 0, 2 * Math.PI, `rgba(127, 214, 232, ${0.7 * (1 - t)})`, 2);
  }

  // Flashbangs in flight: a bright pin with a short fuse ring that closes as it nears the pop.
  for (const f of o.flashes) {
    const fuse = f.ticksLeft / C.FLASH_FUSE;
    ctx.fillStyle = '#ffffff';
    circle(ctx, f.x, f.y, 0.22);
    ctx.fill();
    arc(f.x, f.y, 0.35 + fuse * 0.6, 0, 2 * Math.PI, f.mine ? 'rgba(255, 181, 71, 0.8)' : 'rgba(255, 255, 255, 0.85)', 1.5);
  }
  // Pops: a white burst that everyone hears, whether it blinded them or not.
  pops = pops.filter((p) => now - p.born < 500);
  for (const p of pops) {
    const t = (now - p.born) / 500;
    const g = ctx.createRadialGradient(p.x * scale, p.y * scale, 0, p.x * scale, p.y * scale, (1 + t * 5) * scale);
    g.addColorStop(0, `rgba(255, 255, 255, ${0.9 * (1 - t)})`);
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    circle(ctx, p.x, p.y, 1 + t * 5);
    ctx.fill();
  }

  if (alive && live && !fp) drawCrosshair(o, px, py, now);

  // First person: the same frame from the player's eyes. The 2D arena above is now the minimap.
  if (fp && view3d) {
    view3d.setMap(map);
    view3d.render({
      self: { x: px, y: py, aim, hp: o.self.hp, moveState: predictor.pos?.moveState ?? o.self.moveState },
      enemy: o.enemy && enemyDraw ? { x: enemyDraw.x, y: enemyDraw.y, aim: o.enemy.aim } : null,
      enemyFlash: enemyHitUntil > now,
      lastSeen: o.lastSeenEnemy, obs: o, tracers, pops, ripples, muzzle: muzzleNow, now,
    }, dt);
    // Crosshair gap = the real spread for how you are moving, 10 units out, projected through the 78 degree lens.
    const ms = predictor.pos?.moveState ?? o.self.moveState;
    const focal = (map.height * scale) / 2 / Math.tan((78 / 2) * (Math.PI / 180));
    $('xhair').style.setProperty('--gap', `${Math.max(4, focal * Math.tan((C.SPREAD_DEG[ms] * Math.PI) / 180)).toFixed(1)}px`);
    $('blind').style.opacity = String(o.self.blindTicks > 0 ? Math.min(1, o.self.blindTicks / 26) * 0.97 : 0);
  }
  muzzleNow = false;

  // Floating text.
  toasts = toasts.filter((t) => now - t.born < 1100);
  for (const t of toasts) {
    const age = (now - t.born) / 1100;
    ctx.globalAlpha = 1 - age * age;
    ctx.fillStyle = t.color;
    ctx.font = `900 ${Math.max(14, 1.1 * scale)}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.text, t.x * scale, (t.y - age * 1.2) * scale);
    ctx.globalAlpha = 1;
  }

  // Blind: the screen goes white and fades back over the last ~0.8 s. Only your own screen, only if it caught you.
  if (o.self.blindTicks > 0) {
    const a = Math.min(1, o.self.blindTicks / 26);
    ctx.fillStyle = `rgba(255, 252, 240, ${0.97 * a})`;
    ctx.fillRect(-20, -20, map.width * scale + 40, map.height * scale + 40);
  }

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

  const noPrimary = o.self.primary === NO_WEAPON;
  const gun = weapon(o.self.equipped === 0 && !noPrimary ? o.self.primary : o.self.secondary);
  const otherId = o.self.equipped === 0 ? o.self.secondary : o.self.primary;
  const other = otherId === NO_WEAPON ? null : weapon(otherId);
  $('credits').textContent = o.rules === 'valorant' ? `¤ ${o.self.credits}` : 'free';
  $('armor').textContent = o.self.armor > 0 ? ` +${o.self.armor}` : '';
  const ammoKey = `${gun.id}/${o.self.ammo}/${o.self.reloadTicks > 0}/${o.self.switchTicks > 0}`;
  if (ammoKey !== lastAmmoKey) {
    lastAmmoKey = ammoKey;
    const state = o.self.switchTicks > 0 ? 'drawing' : o.self.reloadTicks > 0 ? 'reloading' : o.self.ammo === 0 ? 'empty: R or swap' : `${o.self.ammo}/${gun.mag}`;
    $('ammoLabel').textContent = `${gun.name} · ${state}`;
    // One pip per round for small magazines; a bar for big ones.
    $('ammo').innerHTML = gun.mag <= 12
      ? Array.from({ length: gun.mag }, (_, i) => `<b class="${i < o.self.ammo && o.self.reloadTicks === 0 ? '' : 'off'}"></b>`).join('')
      : `<i class="bar"><i style="width:${Math.round((100 * (o.self.reloadTicks > 0 ? 0 : o.self.ammo)) / gun.mag)}%"></i></i>`;
    $('otherGun').textContent = other ? `${o.self.equipped === 0 ? 2 : 1} ${other.name}` : 'no primary';
  }
  // The buy menu, for the first 4 seconds of a live round.
  const buying = o.phase === 'live' && o.self.hp > 0 && C.ROUND_TICKS - o.roundTicksLeft < BUY_TICKS;
  const buy = $('buy');
  buy.classList.toggle('open', buying);
  if (buying) {
    $('buyTimer').textContent = ((BUY_TICKS - (C.ROUND_TICKS - o.roundTicksLeft)) / TICK_RATE).toFixed(1);
    $('buyCredits').textContent = o.rules === 'valorant' ? `¤ ${o.self.credits}` : 'free buys (classic rules)';
    buy.querySelectorAll<HTMLElement>('[data-gun]').forEach((el) => {
      const id = Number(el.dataset.gun);
      const owned = id === o.self.primary || id === o.self.secondary || (SHIELDS[id] && o.self.armor >= SHIELDS[id].amount);
      el.classList.toggle('owned', !!owned);
      el.classList.toggle('poor', !owned && o.rules === 'valorant' && Number(el.dataset.price) > o.self.credits);
    });
  }
  $('smokeKey').classList.toggle('spent', o.self.smokes === 0);
  $('dashKey').classList.toggle('spent', o.self.dashes === 0);
  $('flashKey').classList.toggle('spent', o.self.flashes === 0);
  $('flashCount').textContent = `×${o.self.flashes}`;

  let hint = '';
  if (o.phase === 'live' && o.self.hp > 0) {
    const p = selfPos()!;
    const inSite = Object.values(map.sites).some((s) => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);
    const labels = Object.keys(map.sites);
    const siteList = labels.length > 2 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels.join(' or ');
    if (o.self.blindTicks > 0) hint = 'Flashed! Back off or spray.';
    else if (o.attacker === me) hint = planted ? 'Spike planted. Hold the site.' : inSite ? 'Stand still and hold F to plant' : `Get the spike to ${siteList}`;
    else if (planted) hint = Math.hypot(p.x - o.spike.x, p.y - o.spike.y) <= C.DEFUSE_RANGE ? 'Hold F to defuse' : 'Spike planted. Find it and defuse.';
    else hint = 'Stop the plant';
  }
  $('hint').textContent = hint;
}

setMode('ai');
draw();
