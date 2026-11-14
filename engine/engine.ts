import { C } from './constants';
import { rayCircle, rayWalls } from './geometry';
import { getMap, type GameMap } from './map';
import { rand } from './rng';
import { canSee } from './vision';
import type { GameEvent, Input, PlayerState, Rect, RoundEndReason, Slot, State } from './types';

function spawnPlayer(map: GameMap, isAttacker: boolean): PlayerState {
  const p = isAttacker ? map.spawns.attacker : map.spawns.defender;
  return {
    x: p.x, y: p.y, aim: isAttacker ? 0 : Math.PI, hp: C.MAX_HP,
    ammo: C.MAG, reloadTicks: 0, fireCooldown: 0,
    smokes: 1, dashes: 1, dashTicks: 0, dashX: 0, dashY: 0,
    useTicks: 0, moveState: 0, lastSeen: null,
  };
}

function startRound(s: State): void {
  const map = getMap(s.mapId);
  s.players = [spawnPlayer(map, s.attacker === 0), spawnPlayer(map, s.attacker === 1)];
  s.smokes = [];
  s.spike = { state: 'carried', x: 0, y: 0, ticksLeft: 0 };
  s.roundTicks = 0;
  s.phase = 'live';
  s.phaseTicks = 0;
}

/** A fresh match at tick 0, round 1, slot 0 attacking. */
export function createMatch(seed: number, mapId: string): State {
  const map = getMap(mapId);
  const s: State = {
    tick: 0, rng: seed | 0, mapId, round: 1, score: [0, 0], attacker: 0,
    phase: 'live', phaseTicks: 0, roundTicks: 0,
    players: [spawnPlayer(map, true), spawnPlayer(map, false)],
    smokes: [], spike: { state: 'carried', x: 0, y: 0, ticksLeft: 0 }, winner: null,
  };
  return s;
}

function cloneState(s: State): State {
  const cp = (p: PlayerState): PlayerState => ({ ...p, lastSeen: p.lastSeen && { ...p.lastSeen } });
  return {
    ...s,
    score: [s.score[0], s.score[1]],
    players: [cp(s.players[0]), cp(s.players[1])],
    smokes: s.smokes.map((k) => ({ ...k })),
    spike: { ...s.spike },
  };
}

/**
 * Moves a circle and pushes it out of any wall it overlaps.
 * Substeps stay under half the radius so the centre can never end up inside a wall, even mid-dash.
 */
function moveCircle(p: PlayerState, dx: number, dy: number, walls: Rect[]): void {
  const n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.2);
  for (let i = 0; i < n; i++) {
    p.x += dx / n;
    p.y += dy / n;
    for (let pass = 0; pass < 2; pass++) {
      for (const w of walls) {
        const cx = Math.min(Math.max(p.x, w.x), w.x + w.w);
        const cy = Math.min(Math.max(p.y, w.y), w.y + w.h);
        const ex = p.x - cx;
        const ey = p.y - cy;
        const d2 = ex * ex + ey * ey;
        if (d2 < C.RADIUS * C.RADIUS && d2 > 0) {
          const d = Math.sqrt(d2);
          p.x = cx + (ex / d) * C.RADIUS;
          p.y = cy + (ey / d) * C.RADIUS;
        }
      }
    }
  }
}

function movePlayer(s: State, slot: Slot, inp: Input, map: GameMap, events: GameEvent[]): void {
  const p = s.players[slot];
  let dx = 0;
  let dy = 0;
  if (p.dashTicks > 0) {
    p.dashTicks--;
    dx = p.dashX;
    dy = p.dashY;
    p.moveState = 2;
  } else {
    const len = Math.sqrt(inp.move.x * inp.move.x + inp.move.y * inp.move.y);
    if (len === 0) {
      p.moveState = 0;
    } else if (inp.dash && p.dashes > 0) {
      p.dashes--;
      p.dashTicks = C.DASH_TICKS - 1;
      p.dashX = dx = ((inp.move.x / len) * C.DASH_DIST) / C.DASH_TICKS;
      p.dashY = dy = ((inp.move.y / len) * C.DASH_DIST) / C.DASH_TICKS;
      p.moveState = 2;
      events.push({ type: 'dash', tick: s.tick, slot });
    } else {
      const speed = inp.walk ? C.WALK : C.RUN;
      dx = (inp.move.x / len) * speed;
      dy = (inp.move.y / len) * speed;
      p.moveState = inp.walk ? 1 : 2;
    }
  }
  if (dx !== 0 || dy !== 0) moveCircle(p, dx, dy, map.walls);
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function endRound(s: State, winner: Slot, reason: RoundEndReason, events: GameEvent[]): void {
  s.score[winner]++;
  events.push({ type: 'roundEnd', tick: s.tick, round: s.round, winner, reason });
  if (s.score[winner] >= C.WIN_SCORE) {
    s.phase = 'matchEnd';
    s.winner = winner;
    events.push({ type: 'matchEnd', tick: s.tick, winner });
  } else {
    s.phase = 'roundEnd';
    s.phaseTicks = C.INTERMISSION_TICKS;
  }
}

/**
 * Advances the match by one tick. Pure: returns a new state and never touches the one passed in.
 * Order inside a live tick: move both, timers, smokes, shots (resolved simultaneously), deaths, spike, clock.
 */
export function step(prev: State, inputs: [Input, Input]): { next: State; events: GameEvent[] } {
  const s = cloneState(prev);
  const events: GameEvent[] = [];

  if (s.phase === 'matchEnd') return { next: s, events };

  if (s.phase === 'roundEnd') {
    if (--s.phaseTicks <= 0) {
      s.round++;
      s.attacker = s.round > C.SWAP_AFTER_ROUND ? 1 : 0;
      startRound(s);
      events.push({ type: 'roundStart', tick: s.tick, round: s.round, attacker: s.attacker });
    }
    s.tick++;
    return { next: s, events };
  }

  const map = getMap(s.mapId);

  for (const k of s.smokes) k.ticksLeft--;
  s.smokes = s.smokes.filter((k) => k.ticksLeft > 0);

  for (const slot of [0, 1] as const) {
    const p = s.players[slot];
    const inp = inputs[slot];
    p.aim = inp.aim;
    movePlayer(s, slot, inp, map, events);

    if (p.fireCooldown > 0) p.fireCooldown--;
    if (p.reloadTicks > 0) {
      if (--p.reloadTicks === 0) p.ammo = C.MAG;
    } else if (inp.reload && p.ammo < C.MAG) {
      p.reloadTicks = C.RELOAD_TICKS;
    }

    if (inp.smoke && p.smokes > 0) {
      p.smokes--;
      // Input carries no aim distance, so the smoke lands at max range along the aim, or just short of a wall.
      const dx = Math.cos(p.aim);
      const dy = Math.sin(p.aim);
      const d = Math.min(C.SMOKE_RANGE, rayWalls(map.walls, p.x, p.y, dx, dy));
      const smoke = { x: p.x + dx * d, y: p.y + dy * d, ticksLeft: C.SMOKE_TICKS };
      s.smokes.push(smoke);
      events.push({ type: 'smoke', tick: s.tick, slot, x: smoke.x, y: smoke.y });
    }
  }

  // Both shots are traced against post-movement positions before any damage lands, so slot order gives no edge.
  const damage: [number, number] = [0, 0];
  for (const slot of [0, 1] as const) {
    const p = s.players[slot];
    if (!inputs[slot].fire || p.fireCooldown > 0 || p.reloadTicks > 0 || p.ammo <= 0) continue;
    p.ammo--;
    p.fireCooldown = C.FIRE_COOLDOWN;
    const other = (1 - slot) as Slot;
    const e = s.players[other];
    const angle = p.aim + (((rand(s) * 2 - 1) * C.SPREAD_DEG[p.moveState]) * Math.PI) / 180;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tWall = rayWalls(map.walls, p.x, p.y, dx, dy);
    const tHit = rayCircle(p.x, p.y, dx, dy, e.x, e.y, C.RADIUS);
    const hit = tHit < tWall;
    const t = hit ? tHit : tWall;
    if (hit) damage[other] += C.DAMAGE;
    events.push({ type: 'shot', tick: s.tick, slot, x: p.x, y: p.y, toX: p.x + dx * t, toY: p.y + dy * t, angle, hit });
  }
  for (const slot of [0, 1] as const) {
    if (damage[slot] === 0) continue;
    s.players[slot].hp = Math.max(0, s.players[slot].hp - damage[slot]);
    if (s.players[slot].hp === 0) events.push({ type: 'kill', tick: s.tick, killer: (1 - slot) as Slot, victim: slot });
  }

  const atk = s.attacker;
  const def = (1 - atk) as Slot;
  const atkDead = s.players[atk].hp === 0;
  const defDead = s.players[def].hp === 0;

  if (atkDead && defDead) {
    // A trade resolves the way the round would with nobody left: a planted spike detonates, otherwise time runs out.
    endRound(s, s.spike.state === 'planted' ? atk : def, 'kill', events);
  } else if (defDead) {
    endRound(s, atk, 'kill', events);
  } else if (atkDead) {
    endRound(s, def, 'kill', events);
  } else if (s.spike.state === 'carried') {
    const ap = s.players[atk];
    const inSite = inRect(map.sites.A, ap.x, ap.y) || inRect(map.sites.B, ap.x, ap.y);
    if (inputs[atk].use && ap.moveState === 0 && inSite) {
      if (++ap.useTicks >= C.PLANT_TICKS) {
        ap.useTicks = 0;
        s.spike = { state: 'planted', x: ap.x, y: ap.y, ticksLeft: C.FUSE_TICKS };
        events.push({ type: 'plant', tick: s.tick, slot: atk, x: ap.x, y: ap.y });
      }
    } else {
      ap.useTicks = 0;
    }
    if (s.spike.state === 'carried' && s.roundTicks + 1 >= C.ROUND_TICKS) endRound(s, def, 'time', events);
  } else if (s.spike.state === 'planted') {
    const dp = s.players[def];
    const ddx = dp.x - s.spike.x;
    const ddy = dp.y - s.spike.y;
    if (inputs[def].use && ddx * ddx + ddy * ddy <= C.DEFUSE_RANGE * C.DEFUSE_RANGE) {
      if (++dp.useTicks >= C.DEFUSE_TICKS) {
        s.spike.state = 'defused';
        events.push({ type: 'defuse', tick: s.tick, slot: def });
        endRound(s, def, 'defuse', events);
      }
    } else {
      dp.useTicks = 0;
    }
    if (s.spike.state === 'planted' && --s.spike.ticksLeft <= 0) {
      s.spike.state = 'detonated';
      events.push({ type: 'detonate', tick: s.tick });
      endRound(s, atk, 'detonation', events);
    }
  }

  s.roundTicks++;
  s.tick++;
  for (const slot of [0, 1] as const) {
    const other = (1 - slot) as Slot;
    if (canSee(s, slot, other)) {
      s.players[slot].lastSeen = { x: s.players[other].x, y: s.players[other].y, tick: s.tick };
    }
  }
  return { next: s, events };
}

/** FNV-1a (32-bit) over the whole state, with floats quantized to 1/1000. */
export function hashState(s: State): string {
  const q = (v: number) => Math.round(v * 1000);
  const phases = { live: 0, roundEnd: 1, matchEnd: 2 };
  const spikes = { carried: 0, planted: 1, defused: 2, detonated: 3 };
  const ints: number[] = [
    s.tick, s.rng, s.round, s.score[0], s.score[1], s.attacker,
    phases[s.phase], s.phaseTicks, s.roundTicks, s.winner ?? -1,
    spikes[s.spike.state], q(s.spike.x), q(s.spike.y), s.spike.ticksLeft,
  ];
  for (const p of s.players) {
    ints.push(
      q(p.x), q(p.y), q(p.aim), p.hp, p.ammo, p.reloadTicks, p.fireCooldown,
      p.smokes, p.dashes, p.dashTicks, q(p.dashX), q(p.dashY), p.useTicks, p.moveState,
      p.lastSeen ? q(p.lastSeen.x) : -1, p.lastSeen ? q(p.lastSeen.y) : -1, p.lastSeen ? p.lastSeen.tick : -1,
    );
  }
  for (const k of s.smokes) ints.push(q(k.x), q(k.y), k.ticksLeft);

  let h = 0x811c9dc5;
  for (const n of ints) {
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (8 * i)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
