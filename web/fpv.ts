// First-person three.js view of a recorded match (spec Phase 6, stretch). It renders the SAME 2D
// simulation — it reads the server's replay snapshots and draws them in 3D: walls extruded into boxes,
// players as cylinders, the camera at one player's eye facing their aim. No game logic lives here; the
// 2D engine is still the only source of truth. Map x,y become world x,z; up is y.
import * as THREE from 'three';
import { C, TICK_RATE, getMap } from '@rewind/engine';

type PlayerSnap = { x: number; y: number; aim: number; hp: number; moveState: number };
type Snapshot = {
  tick: number; round: number; phase: string;
  players: [PlayerSnap, PlayerSnap];
  smokes: { x: number; y: number; ticksLeft: number }[];
  spike: { state: string; x: number; y: number; ticksLeft: number };
  score: [number, number];
};
type Replay = { id: string; map: string; ticks: number; players: { slot: 0 | 1; name: string }[]; snapshots: Snapshot[] };

const map = getMap('duel');
const $ = (id: string) => document.getElementById(id)!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x160f0c);
scene.fog = new THREE.Fog(0x160f0c, 14, 40);

const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.1, 200);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// --- static world: floor, walls, site markers --------------------------------------------------

const WALL_H = 3;
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffd9a0, 0.9);
key.position.set(10, 20, 6);
scene.add(key);

// Floor (oxide). Centered so world coordinates equal map coordinates.
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(map.width, map.height),
  new THREE.MeshStandardMaterial({ color: 0x4b3a2e }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(map.width / 2, 0, map.height / 2);
scene.add(floor);

// Walls extruded to WALL_H. Border walls (outside the arena) are included; they frame the room.
const wallMat = new THREE.MeshStandardMaterial({ color: 0x8b735f });
for (const w of map.walls) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(w.w, WALL_H, w.h), wallMat);
  box.position.set(w.x + w.w / 2, WALL_H / 2, w.y + w.h / 2);
  scene.add(box);
}

// Site floor patches (red tint) so you can orient underground.
for (const s of [map.sites.A, map.sites.B]) {
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), new THREE.MeshStandardMaterial({ color: 0xe5483b, transparent: true, opacity: 0.18 }));
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(s.x + s.w / 2, 0.02, s.y + s.h / 2);
  scene.add(patch);
}

// --- dynamic actors: two players, smoke, spike -------------------------------------------------

const EYE = 1.6;
function makePlayer(color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(C.RADIUS, C.RADIUS, 1.8, 16), new THREE.MeshStandardMaterial({ color }));
  m.position.y = 0.9;
  scene.add(m);
  return m;
}
const bodies: [THREE.Mesh, THREE.Mesh] = [makePlayer(0xffb547), makePlayer(0x7fd6e8)];
const smokeGroup = new THREE.Group();
scene.add(smokeGroup);
const spikeMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0xe5483b }));
spikeMesh.visible = false;
scene.add(spikeMesh);

// Running leaves a visible ripple on the floor (spec Phase 6: "sound ripples when running"). A running
// player (moveState 2) spawns an expanding ring at their feet; walking (1) and standing (0) do not. This
// makes "running is loud, walking is quiet" legible in the 3D view without any engine change.
type Ripple = { ring: THREE.Mesh; born: number };
const ripples: Ripple[] = [];
const ringGeo = new THREE.RingGeometry(0.3, 0.45, 24);
function spawnRipple(x: number, y: number, color: number): void {
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.05, y);
  scene.add(ring);
  ripples.push({ ring, born: performance.now() });
}
function updateRipples(now: number): void {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const age = (now - ripples[i].born) / 700;
    if (age >= 1) { scene.remove(ripples[i].ring); ripples.splice(i, 1); continue; }
    const s = 1 + age * 5;
    ripples[i].ring.scale.set(s, s, s);
    (ripples[i].ring.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - age);
  }
}
let lastRippleTick = -1;

// --- state --------------------------------------------------------------------------------------

let replay: Replay | null = null;
let cursor = 0;
let playing = false;
let eye: 0 | 1 = 0;

async function loadList(): Promise<void> {
  const list = (await (await fetch('/api/matches')).json()) as { id: string; players: string[]; ticks: number }[];
  const sel = $('matchSel') as HTMLSelectElement;
  sel.innerHTML = list.map((m) => `<option value="${m.id}">${m.players.join(' vs ')} — ${(m.ticks / TICK_RATE).toFixed(0)}s</option>`).join('');
  if (list.length) await load(list[0].id);
}

async function load(id: string): Promise<void> {
  replay = (await (await fetch(`/api/replay?id=${encodeURIComponent(id)}`)).json()) as Replay;
  cursor = 0;
  ($('scrub') as HTMLInputElement).max = String(replay.snapshots.length - 1);
  apply();
}

/** Draws snapshot `cursor`: positions the two bodies, smokes and spike, and the first-person camera. */
function apply(): void {
  if (!replay) return;
  const snap = replay.snapshots[cursor];
  for (const slot of [0, 1] as const) {
    const p = snap.players[slot];
    bodies[slot].position.set(p.x, 0.9, p.y);
    bodies[slot].visible = p.hp > 0;
    // Running (moveState 2) leaves a ripple; throttle to a new ripple per snapshot advance.
    if (p.hp > 0 && p.moveState === 2 && snap.tick !== lastRippleTick) {
      spawnRipple(p.x, p.y, slot === 0 ? 0xffb547 : 0x7fd6e8);
    }
  }
  lastRippleTick = snap.tick;

  // Smokes: translucent spheres that fade as they expire.
  smokeGroup.clear();
  for (const k of snap.smokes) {
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(C.SMOKE_RADIUS, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xd6c8b4, transparent: true, opacity: 0.55 * Math.min(1, k.ticksLeft / 32) }),
    );
    s.position.set(k.x, C.SMOKE_RADIUS * 0.7, k.y);
    smokeGroup.add(s);
  }
  spikeMesh.visible = snap.spike.state === 'planted';
  if (spikeMesh.visible) spikeMesh.position.set(snap.spike.x, 0.3, snap.spike.y);

  // First-person camera: at the chosen player's eye, looking along their aim.
  const me = snap.players[eye];
  camera.position.set(me.x, EYE, me.y);
  camera.lookAt(me.x + Math.cos(me.aim), EYE, me.y + Math.sin(me.aim));
  // Hide your own body so it does not fill the view.
  bodies[eye].visible = false;

  $('clock').textContent = `${(snap.tick / TICK_RATE).toFixed(1)}s  ·  round ${snap.round}  ·  ${snap.score.join('–')}`;
}

// --- controls + loop ---------------------------------------------------------------------------

($('matchSel') as HTMLSelectElement).addEventListener('change', (e) => load((e.target as HTMLSelectElement).value));
($('scrub') as HTMLInputElement).addEventListener('input', (e) => { cursor = Number((e.target as HTMLInputElement).value); apply(); });
$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? 'pause' : 'play'; });
$('eyeSel').addEventListener('click', () => {
  eye = (1 - eye) as 0 | 1;
  $('eyeSel').textContent = `eyes: slot ${eye}`;
  apply();
});

let last = performance.now();
function loop(): void {
  requestAnimationFrame(loop);
  if (replay && playing) {
    const now = performance.now();
    if (now - last >= 1000 / TICK_RATE) {
      last = now;
      cursor = Math.min(replay.snapshots.length - 1, cursor + 1);
      ($('scrub') as HTMLInputElement).value = String(cursor);
      apply();
      if (cursor >= replay.snapshots.length - 1) { playing = false; $('play').textContent = 'play'; }
    }
  }
  updateRipples(performance.now());
  renderer.render(scene, camera);
}
loop();
loadList();
