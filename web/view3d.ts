// First-person 3D view of the same 2D simulation. Logic stays 2D (spec, phase 6): the server, the engine, the AI
// and replays are untouched. This file only draws what the client already knows, from the player's eyes.
// Engine (x, y) maps to three.js (x, 0, y); y goes down the map, which is +z in the scene.
import * as THREE from 'three';
import { C, type GameMap, type Observation } from '@rewind/engine';

const EYE = 0.95;
const UP = new THREE.Vector3(0, 1, 0);
const WALL_H = 2.6;
const COL = {
  floor: 0x4b3a2e, wall: 0x8b735f, wallTop: 0xb39a80, me: 0xffb547, enemy: 0x7fd6e8, rec: 0xe5483b,
  fog: 0x1d1612, smoke: 0xd6c8b4, tp: 0xb48cff,
};

export type Scene3DInput = {
  self: { x: number; y: number; aim: number; hp: number; moveState: number };
  enemy: { x: number; y: number; aim: number } | null;
  enemyFlash: boolean; // my shot just hit them
  lastSeen: { x: number; y: number; ticksAgo: number } | null;
  obs: Observation;
  tracers: { x: number; y: number; toX: number; toY: number; mine: boolean; until: number }[];
  pops: { x: number; y: number; born: number }[];
  ripples: { x: number; y: number; born: number }[];
  muzzle: boolean; // I fired this frame
  now: number;
};

/** A canvas texture of the floor: grid, sites with big letters, teleporter pads. */
function floorTexture(map: GameMap): THREE.CanvasTexture {
  const px = 32;
  const c = document.createElement('canvas');
  c.width = map.width * px;
  c.height = map.height * px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4b3a2e';
  g.fillRect(0, 0, c.width, c.height);
  // Worn concrete: a little noise.
  for (let i = 0; i < 6000; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,240,220'},${Math.random() * 0.05})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  g.strokeStyle = 'rgba(239, 226, 201, 0.10)';
  g.lineWidth = 2;
  for (let x = 0; x <= map.width; x += 2) {
    g.beginPath();
    g.moveTo(x * px, 0);
    g.lineTo(x * px, c.height);
    g.stroke();
  }
  for (let y = 0; y <= map.height; y += 2) {
    g.beginPath();
    g.moveTo(0, y * px);
    g.lineTo(c.width, y * px);
    g.stroke();
  }
  for (const [label, s] of Object.entries(map.sites)) {
    g.fillStyle = 'rgba(229, 72, 59, 0.16)';
    g.fillRect(s.x * px, s.y * px, s.w * px, s.h * px);
    g.strokeStyle = 'rgba(229, 72, 59, 0.8)';
    g.lineWidth = 6;
    g.setLineDash([24, 18]);
    g.strokeRect(s.x * px + 3, s.y * px + 3, s.w * px - 6, s.h * px - 6);
    g.setLineDash([]);
    g.fillStyle = 'rgba(229, 72, 59, 0.55)';
    g.font = `900 ${Math.min(s.w, s.h) * px * 0.7}px Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, (s.x + s.w / 2) * px, (s.y + s.h / 2) * px);
  }
  for (const tp of map.teleporters) {
    g.fillStyle = 'rgba(180, 140, 255, 0.5)';
    g.fillRect(tp.pad.x * px, tp.pad.y * px, tp.pad.w * px, tp.pad.h * px);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A capsule-ish player: body, head, gun. */
function playerMesh(color: number): unknown {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, emissive: color, emissiveIntensity: 0.25 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(C.RADIUS * 0.9, C.RADIUS, 1.25, 16), mat);
  body.position.y = 0.62;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), mat);
  head.position.y = 1.48;
  head.castShadow = true;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x1d1612, roughness: 0.4 }));
  gun.position.set(0.45, 1.05, 0.18);
  gun.castShadow = true;
  group.add(body, head, gun);
  return group;
}

export class View3D {
  readonly canvas: HTMLCanvasElement;
  private renderer: any;
  private scene: any;
  private camera: any;
  private mapGroup: any = null;
  private enemy: any;
  private enemyMat: any[] = [];
  private ghost: any;
  private viewGun: any;
  private muzzleLight: any;
  private popLight: any;
  private tracerPool: any[] = [];
  private smokePool: any[] = [];
  private flashPool: any[] = [];
  private ripplePool: any[] = [];
  private spike: any;
  private spikeLight: any;
  private kick = 0;
  private bob = 0;
  mapId = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.fog);
    this.scene.fog = new THREE.Fog(COL.fog, 6, 34);
    this.camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 80);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xffe8cc, 0x2a1d16, 0.9));
    const sun = new THREE.DirectionalLight(0xfff0dd, 1.6);
    sun.position.set(30, 40, 10);
    sun.target.position.set(24, 0, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 100 });
    this.scene.add(sun, sun.target);

    this.enemy = playerMesh(COL.enemy);
    this.enemy.traverse((m: any) => m.material && this.enemyMat.push(m.material));
    this.scene.add(this.enemy);
    // Where you last saw them: a see-through outline that fades with age.
    this.ghost = new THREE.Mesh(
      new THREE.CylinderGeometry(C.RADIUS, C.RADIUS, 1.6, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: COL.enemy, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    this.ghost.position.y = 0.8;
    this.scene.add(this.ghost);

    // Your gun, attached to the camera, bottom right.
    this.viewGun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.6), new THREE.MeshStandardMaterial({ color: 0x241a14, roughness: 0.35, metalness: 0.6 }));
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.28), new THREE.MeshStandardMaterial({ color: COL.me, roughness: 0.6, emissive: COL.me, emissiveIntensity: 0.15 }));
    stock.position.set(0, -0.05, 0.22);
    this.viewGun.add(barrel, stock);
    this.viewGun.position.set(0.22, -0.2, -0.45);
    this.camera.add(this.viewGun);
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 6, 2);
    this.muzzleLight.position.set(0.22, -0.16, -0.8);
    this.camera.add(this.muzzleLight);
    this.popLight = new THREE.PointLight(0xffffff, 0, 30, 1.5);
    this.scene.add(this.popLight);

    this.spike = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshStandardMaterial({ color: COL.rec, emissive: COL.rec, emissiveIntensity: 1 }));
    this.spikeLight = new THREE.PointLight(COL.rec, 0, 8, 2);
    this.scene.add(this.spike, this.spikeLight);
  }

  setMap(map: GameMap): void {
    if (this.mapId === map.id) return;
    this.mapId = map.id;
    if (this.mapGroup) this.scene.remove(this.mapGroup);
    const g = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height), new THREE.MeshStandardMaterial({ map: floorTexture(map), roughness: 0.92 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(map.width / 2, 0, map.height / 2);
    floor.receiveShadow = true;
    g.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: COL.wall, roughness: 0.8 });
    const topMat = new THREE.MeshStandardMaterial({ color: COL.wallTop, emissive: 0xffb547, emissiveIntensity: 0.12 });
    for (const w of map.walls) {
      // Border walls sit outside the playable area; draw them a little taller as the arena's edge.
      const border = w.x < 0 || w.y < 0 || w.x + w.w > map.width || w.y + w.h > map.height;
      const h = border ? WALL_H + 1 : WALL_H;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w.w, h, w.h), wallMat);
      box.position.set(w.x + w.w / 2, h / 2, w.y + w.h / 2);
      box.castShadow = !border;
      box.receiveShadow = true;
      g.add(box);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.02, 0.06, w.h + 0.02), topMat);
      top.position.set(w.x + w.w / 2, h + 0.03, w.y + w.h / 2);
      g.add(top);
    }
    for (const tp of map.teleporters) {
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(tp.pad.w * 0.5, tp.pad.w * 0.5, 2, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: COL.tp, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
      pad.position.set(tp.pad.x + tp.pad.w / 2, 1, tp.pad.y + tp.pad.h / 2);
      pad.userData.spin = true;
      g.add(pad);
    }
    this.mapGroup = g;
    this.scene.add(g);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private pool(list: any[], make: () => any, n: number): any[] {
    while (list.length < n) {
      const m = make();
      this.scene.add(m);
      list.push(m);
    }
    list.forEach((m, i) => (m.visible = i < n));
    return list;
  }

  render(s: Scene3DInput, dt: number): void {
    const { self, obs, now } = s;
    // Camera: at the eyes, facing the aim. A small head bob while running.
    const moving = self.moveState > 0;
    this.bob += moving ? dt * (self.moveState === 2 ? 0.012 : 0.007) : 0;
    const bobY = moving ? Math.sin(this.bob) * (self.moveState === 2 ? 0.035 : 0.015) : 0;
    this.camera.position.set(self.x, EYE + bobY, self.y);
    this.camera.lookAt(self.x + Math.cos(self.aim), EYE + bobY, self.y + Math.sin(self.aim));

    // Gun kick and muzzle light on my shot.
    if (s.muzzle) this.kick = 1;
    this.kick = Math.max(0, this.kick - dt / 90);
    this.viewGun.position.z = -0.45 + this.kick * 0.08;
    this.viewGun.rotation.x = this.kick * 0.12;
    this.viewGun.position.y = -0.2 + bobY * 0.6;
    this.muzzleLight.intensity = this.kick > 0.6 ? 6 * this.kick : 0;

    // Enemy: only drawn when the server says you can see them.
    this.enemy.visible = !!s.enemy;
    if (s.enemy) {
      this.enemy.position.set(s.enemy.x, 0, s.enemy.y);
      this.enemy.rotation.y = -s.enemy.aim;
      for (const m of this.enemyMat) m.emissiveIntensity = s.enemyFlash ? 1.5 : 0.25;
    }
    this.ghost.visible = !s.enemy && !!s.lastSeen && obs.phase === 'live';
    if (s.lastSeen) {
      this.ghost.position.set(s.lastSeen.x, 0.8, s.lastSeen.y);
      this.ghost.material.opacity = Math.max(0.1, 0.55 - s.lastSeen.ticksAgo / (12 * 32));
    }

    // Tracers.
    const live = s.tracers.filter((t) => t.until > now);
    this.pool(this.tracerPool, () => new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true })), live.length)
      .slice(0, live.length).forEach((m, i) => {
        const t = live[i];
        const len = Math.hypot(t.toX - t.x, t.toY - t.y);
        m.scale.set(1, len, 1);
        m.position.set((t.x + t.toX) / 2, 1.0, (t.y + t.toY) / 2);
        // The cylinder runs along +Y; turn +Y onto the shot direction (in the floor plane).
        m.quaternion.setFromUnitVectors(UP, new THREE.Vector3((t.toX - t.x) / len, 0, (t.toY - t.y) / len));
        m.material.color.set(t.mine ? COL.me : COL.enemy);
        m.material.opacity = Math.max(0, (t.until - now) / 110);
      });

    // Smokes: a few overlapping soft spheres each, so they read as a cloud.
    const puffs: { x: number; y: number; z: number; r: number; a: number }[] = [];
    for (const k of obs.smokes) {
      const fade = Math.min(1, k.ticksLeft / 32);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + k.x;
        puffs.push({ x: k.x + Math.cos(a) * 0.9, y: 0.9 + (i % 2) * 0.6, z: k.y + Math.sin(a) * 0.9, r: C.SMOKE_RADIUS * 0.75, a: 0.55 * fade });
      }
      puffs.push({ x: k.x, y: 1.3, z: k.y, r: C.SMOKE_RADIUS, a: 0.8 * fade });
    }
    this.pool(this.smokePool, () => new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: COL.smoke, transparent: true, roughness: 1, depthWrite: false })), puffs.length)
      .slice(0, puffs.length).forEach((m, i) => {
        const p = puffs[i];
        m.position.set(p.x, p.y, p.z);
        m.scale.setScalar(p.r);
        m.material.opacity = p.a;
      });

    // Flashbangs in flight.
    this.pool(this.flashPool, () => new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })), obs.flashes.length)
      .slice(0, obs.flashes.length).forEach((m, i) => {
        const f = obs.flashes[i];
        const arc = Math.sin((1 - f.ticksLeft / C.FLASH_FUSE) * Math.PI) * 0.9;
        m.position.set(f.x, 1.0 + arc, f.y);
      });
    // Pops light the whole area for a moment.
    const pop = s.pops.filter((p) => now - p.born < 400).at(-1);
    this.popLight.intensity = pop ? 60 * (1 - (now - pop.born) / 400) : 0;
    if (pop) this.popLight.position.set(pop.x, 1.4, pop.y);

    // Footsteps heard through walls: rings on the floor.
    const rip = s.ripples.filter((r) => now - r.born < 700);
    this.pool(this.ripplePool, () => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({ color: COL.enemy, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      m.rotation.x = -Math.PI / 2;
      return m;
    }, rip.length).slice(0, rip.length).forEach((m, i) => {
      const t = (now - rip[i].born) / 700;
      m.position.set(rip[i].x, 0.05, rip[i].y);
      m.scale.setScalar(0.5 + t * 2.4);
      m.material.opacity = 0.8 * (1 - t);
    });

    // The spike, once planted: blinking light, faster as the fuse burns.
    const planted = obs.spike.state === 'planted';
    this.spike.visible = planted;
    if (planted) {
      this.spike.position.set(obs.spike.x, 0.35 + Math.sin(now / 300) * 0.05, obs.spike.y);
      this.spike.rotation.y = now / 600;
      const rate = 120 + 880 * (obs.spike.ticksLeft / C.FUSE_TICKS);
      this.spikeLight.position.set(obs.spike.x, 0.8, obs.spike.y);
      this.spikeLight.intensity = Math.floor(now / rate) % 2 ? 4 : 0.5;
    } else {
      this.spikeLight.intensity = 0;
    }

    if (this.mapGroup) for (const m of this.mapGroup.children) if (m.userData.spin) m.rotation.y = now / 800;
    this.renderer.render(this.scene, this.camera);
  }
}
