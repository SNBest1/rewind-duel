import { C } from './constants';
import { rayCircle, rayWalls, sightBlocked } from './geometry';
import { getMap, type GameMap } from './map';
import { rand } from './rng';
import { angleDiff, canSee } from './vision';
import { BUY_TICKS, ECON, HEAD_RADIUS, NO_WEAPON, SHIELDS, SWITCH_TICKS, WEAPONS, damageAt, isBuyable, weapon } from './weapons';
import type { GameEvent, Input, PlayerState, Rect, RoundEndReason, Rules, Slot, State } from './types';

function spawnPlayer(map: GameMap, isAttacker: boolean): PlayerState {
  const p = isAttacker ? map.spawns.attacker : map.spawns.defender;
  return {
    // Spawn facing the middle of the map.
    x: p.x, y: p.y, aim: Math.atan2(map.height / 2 - p.y, map.width / 2 - p.x), hp: C.MAX_HP,
    ammo: C.MAG, reloadTicks: 0, fireCooldown: 0,
    smokes: 1, dashes: 1, dashTicks: 0, dashX: 0, dashY: 0,
    useTicks: 0, flashes: C.FLASHES, flashCooldown: 0, blindTicks: 0, moveState: 0, lastSeen: null,
    primary: 0, secondary: 1, equipped: 0, ammo2: weapon(1).mag, switchTicks: 0, spray: 0, shotTick: -1,
    credits: 0, armor: 0,
  };
}

/** VALORANT spawn: a Classic in hand, no primary, no shields. */
function pistolOnly(p: PlayerState): void {
  p.primary = NO_WEAPON;
  p.secondary = 1;
  p.equipped = 1;
  p.ammo = weapon(1).mag;
  p.ammo2 = 0;
  p.armor = 0;
}

/**
 * Respawn for the next round. Classic: keep your guns. VALORANT: keep guns and shields only if you survived
 * the round; credits always carry, except at the side swap where the economy resets.
 */
function respawn(map: GameMap, isAttacker: boolean, prev: PlayerState, s: State): PlayerState {
  const p = spawnPlayer(map, isAttacker);
  if (s.rules === 'classic') {
    p.primary = prev.primary;
    p.secondary = prev.secondary;
    p.ammo = weapon(p.primary).mag;
    p.ammo2 = weapon(p.secondary).mag;
    return p;
  }
  const halftime = s.round === C.SWAP_AFTER_ROUND + 1;
  p.credits = halftime ? ECON.START : prev.credits;
  if (halftime || prev.hp <= 0) {
    pistolOnly(p);
    return p;
  }
  p.primary = prev.primary;
  p.secondary = prev.secondary;
  p.armor = prev.armor;
  p.equipped = p.primary === NO_WEAPON ? 1 : 0;
  p.ammo = p.equipped === 0 ? weapon(p.primary).mag : weapon(p.secondary).mag;
  p.ammo2 = p.equipped === 0 ? weapon(p.secondary).mag : 0;
  return p;
}

function startRound(s: State): void {
  const map = getMap(s.mapId);
  // Sides may swap, so each slot keeps its own loadout regardless of which spawn it gets.
  s.players = [respawn(map, s.attacker === 0, s.players[0], s), respawn(map, s.attacker === 1, s.players[1], s)];
  s.smokes = [];
  s.flashes = [];
  s.spike = { state: 'carried', x: 0, y: 0, ticksLeft: 0 };
  s.roundTicks = 0;
  s.phase = 'live';
  s.phaseTicks = 0;
}

/** A fresh match at tick 0, round 1, slot 0 attacking. */
export function createMatch(seed: number, mapId: string, rules: Rules = 'classic'): State {
  const map = getMap(mapId);
  const s: State = {
    rules, lossStreak: [0, 0],
    tick: 0, rng: seed | 0, mapId, round: 1, score: [0, 0], attacker: 0,
    phase: 'live', phaseTicks: 0, roundTicks: 0,
    players: [spawnPlayer(map, true), spawnPlayer(map, false)],
    smokes: [], flashes: [], spike: { state: 'carried', x: 0, y: 0, ticksLeft: 0 }, winner: null,
  };
  if (rules === 'valorant') {
    for (const p of s.players) {
      pistolOnly(p);
      p.credits = ECON.START;
    }
  }
  return s;
}

function addCredits(s: State, slot: Slot, amount: number, reason: 'win' | 'loss' | 'kill' | 'plant', events: GameEvent[]): void {
  if (s.rules !== 'valorant') return;
  const p = s.players[slot];
  const before = p.credits;
  p.credits = Math.min(ECON.MAX, p.credits + amount);
  if (p.credits !== before) events.push({ type: 'credits', tick: s.tick, slot, amount: p.credits - before, reason });
}

function cloneState(s: State): State {
  const cp = (p: PlayerState): PlayerState => ({ ...p, lastSeen: p.lastSeen && { ...p.lastSeen } });
  return {
    ...s,
    score: [s.score[0], s.score[1]],
    lossStreak: [s.lossStreak[0], s.lossStreak[1]],
    players: [cp(s.players[0]), cp(s.players[1])],
    smokes: s.smokes.map((k) => ({ ...k })),
    flashes: s.flashes.map((f) => ({ ...f })),
    spike: { ...s.spike },
  };
}

/**
 * Moves a player who is standing on a teleporter pad to its exit. Returns the teleporter used, or null.
 * Exported so the browser's prediction teleports exactly when the server does.
 */
export function applyTeleport(p: { x: number; y: number }, map: GameMap): { fromX: number; fromY: number } | null {
  for (const tp of map.teleporters) {
    if (inRect(tp.pad, p.x, p.y)) {
      const from = { fromX: p.x, fromY: p.y };
      p.x = tp.exit.x;
      p.y = tp.exit.y;
      return from;
    }
  }
  return null;
}

/**
 * How long a flash popping at (x, y) blinds player `p`, or 0. One-sided by design:
 * the pop has to be inside the player's view cone, within range, with no wall or smoke in between.
 * Returns -1 when the player had a clear line to the pop but was looking away (a dodge).
 */
export function flashBlindTicks(map: GameMap, smokes: State['smokes'], p: PlayerState, x: number, y: number): number {
  if (p.hp <= 0) return 0;
  const dx = x - p.x;
  const dy = y - p.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > C.FLASH_RANGE) return 0;
  if (sightBlocked(map.walls, smokes, p.x, p.y, x, y)) return 0;
  const off = d < 1e-6 ? 0 : Math.abs(angleDiff(Math.atan2(dy, dx), p.aim));
  let ticks: number;
  if (off <= C.FLASH_FULL_CONE) ticks = C.FLASH_BLIND_FULL;
  else if (off <= C.VISION_HALF_CONE) ticks = C.FLASH_BLIND_EDGE;
  else return -1;
  return d > C.FLASH_FAR ? Math.round(ticks * C.FLASH_FAR_FACTOR) : ticks;
}

/**
 * Moves a circle and pushes it out of any wall it overlaps.
 * Substeps stay under half the radius so the centre can never end up inside a wall, even mid-dash.
 */
function moveCircle(p: { x: number; y: number }, dx: number, dy: number, walls: Rect[]): void {
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

/** The movement fields `applyMovement` reads and writes. Nothing else about a player affects where they go. */
export type Mover = Pick<PlayerState, 'x' | 'y' | 'dashes' | 'dashTicks' | 'dashX' | 'dashY' | 'moveState'>;

/**
 * One tick of one player's movement, mutating `p`. Returns true if a dash started this tick.
 * Exported so the browser can predict its own movement with exactly the rule the server uses (DECISIONS D16).
 */
export function applyMovement(p: Mover, inp: Input, walls: Rect[]): boolean {
  let started = false;
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
      started = true;
    } else {
      const speed = inp.walk ? C.WALK : C.RUN;
      dx = (inp.move.x / len) * speed;
      dy = (inp.move.y / len) * speed;
      p.moveState = inp.walk ? 1 : 2;
    }
  }
  if (dx !== 0 || dy !== 0) moveCircle(p, dx, dy, walls);
  return started;
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function endRound(s: State, winner: Slot, reason: RoundEndReason, events: GameEvent[]): void {
  s.score[winner]++;
  // Economy: the winner gets 3000; the loser 1900, 2400, then 2900 for each further loss in a row.
  const loser = (1 - winner) as Slot;
  addCredits(s, winner, ECON.WIN, 'win', events);
  addCredits(s, loser, ECON.LOSS[Math.min(s.lossStreak[loser], ECON.LOSS.length - 1)], 'loss', events);
  s.lossStreak[loser]++;
  s.lossStreak[winner] = 0;
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
    if (p.blindTicks > 0) p.blindTicks--;
    if (p.flashCooldown > 0) p.flashCooldown--;
    if (applyMovement(p, inp, map.walls)) events.push({ type: 'dash', tick: s.tick, slot });
    const tp = applyTeleport(p, map);
    if (tp) {
      // A dash does not carry through a teleporter.
      p.dashTicks = 0;
      events.push({ type: 'teleport', tick: s.tick, slot, fromX: tp.fromX, fromY: tp.fromY, x: p.x, y: p.y });
    }

    if (inp.flash === true && p.flashes > 0 && p.flashCooldown === 0 && p.hp > 0) {
      p.flashes--;
      p.flashCooldown = C.FLASH_COOLDOWN;
      s.flashes.push({
        x: p.x, y: p.y,
        vx: Math.cos(p.aim) * C.FLASH_SPEED, vy: Math.sin(p.aim) * C.FLASH_SPEED,
        ticksLeft: C.FLASH_FUSE, slot,
      });
      events.push({ type: 'flash', tick: s.tick, slot, x: p.x, y: p.y });
    }

    // Buy phase: the first BUY_TICKS of a round. Buying puts the gun in your hand with a full magazine.
    // VALORANT rules charge credits; classic rules are free (and sell the legacy Standard rifle too).
    const canBuy = inp.buy !== undefined && s.roundTicks < BUY_TICKS && p.hp > 0 && (isBuyable(inp.buy) || (inp.buy === 0 && s.rules === 'classic'));
    const shield = canBuy ? SHIELDS[inp.buy!] : undefined;
    if (shield) {
      const cost = s.rules === 'valorant' ? shield.price : 0;
      if (p.armor < shield.amount && p.credits >= cost) {
        p.credits -= cost;
        p.armor = shield.amount;
        events.push({ type: 'buy', tick: s.tick, slot, weapon: inp.buy!, cost });
      }
    } else if (canBuy && WEAPONS[inp.buy!]) {
      const w = WEAPONS[inp.buy!];
      const slotOf = w.kind === 'primary' ? 0 : 1;
      const owned = slotOf === 0 ? p.primary : p.secondary;
      const cost = s.rules === 'valorant' && owned !== w.id ? w.price : 0;
      if ((owned !== w.id || p.equipped !== slotOf) && p.credits >= cost) {
        p.credits -= cost;
        if (p.equipped !== slotOf) {
          // Bring the other gun's slot into hand first, so `ammo` is always the gun in hand.
          [p.ammo, p.ammo2] = [p.ammo2, p.ammo];
          p.equipped = slotOf as 0 | 1;
        }
        if (slotOf === 0) p.primary = w.id;
        else p.secondary = w.id;
        p.ammo = w.mag;
        p.reloadTicks = 0;
        p.spray = 0;
        p.switchTicks = SWITCH_TICKS;
        if (owned !== w.id) events.push({ type: 'buy', tick: s.tick, slot, weapon: w.id, cost });
      }
    }
    // Weapon swap: primary (0) or secondary (1). Cancels a reload; a short draw time before you can fire.
    // There is nothing to swap to without a primary.
    if (inp.equip !== undefined && inp.equip !== p.equipped && (inp.equip === 0 || inp.equip === 1) && !(inp.equip === 0 && p.primary === NO_WEAPON)) {
      [p.ammo, p.ammo2] = [p.ammo2, p.ammo];
      p.equipped = inp.equip;
      p.switchTicks = SWITCH_TICKS;
      p.reloadTicks = 0;
      p.spray = 0;
    }
    if (p.switchTicks > 0) p.switchTicks--;
    const gun = weapon(p.equipped === 0 ? p.primary : p.secondary);

    // fireCooldown is in 1/100 ticks: 9.75 shots a second is 328 per shot, so fire rates are exact on average.
    if (p.fireCooldown > 0) p.fireCooldown -= 100;
    if (p.reloadTicks > 0) {
      if (--p.reloadTicks === 0) p.ammo = gun.mag;
    } else if (inp.reload && p.ammo < gun.mag) {
      p.reloadTicks = gun.reload;
    }
    // Spray recovers once you stop shooting for a moment.
    if (p.spray > 0 && s.tick - p.shotTick > Math.ceil(gun.cooldown100 / 100) + 2) p.spray = Math.max(0, p.spray - 0.5);

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

  // Flashbangs fly in a straight line, stop just short of a wall, and pop when the fuse runs out.
  // The pop is judged against both players at once, after movement and aim for this tick are applied.
  for (const f of s.flashes) {
    const speed = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (speed > 0) {
      const dx = f.vx / speed;
      const dy = f.vy / speed;
      const tWall = rayWalls(map.walls, f.x, f.y, dx, dy);
      if (tWall <= speed + 0.3) {
        const t = Math.max(0, tWall - 0.3);
        f.x += dx * t;
        f.y += dy * t;
        f.vx = 0;
        f.vy = 0;
      } else {
        f.x += f.vx;
        f.y += f.vy;
      }
    }
    f.ticksLeft--;
  }
  for (const f of s.flashes) {
    if (f.ticksLeft > 0) continue;
    events.push({ type: 'flashPop', tick: s.tick, slot: f.slot, x: f.x, y: f.y });
    for (const slot of [0, 1] as const) {
      const p = s.players[slot];
      const ticks = flashBlindTicks(map, s.smokes, p, f.x, f.y);
      if (ticks > 0) {
        p.blindTicks = Math.max(p.blindTicks, ticks);
        events.push({ type: 'blinded', tick: s.tick, slot, by: f.slot, ticks });
      } else if (ticks < 0) {
        events.push({ type: 'flashDodged', tick: s.tick, slot });
      }
    }
  }
  s.flashes = s.flashes.filter((f) => f.ticksLeft > 0);

  // Both shots are traced against post-movement positions before any damage lands, so slot order gives no edge.
  const damage: [number, number] = [0, 0];
  const headKill: [boolean, boolean] = [false, false];
  const killGun: [number, number] = [0, 0];
  for (const slot of [0, 1] as const) {
    const p = s.players[slot];
    const blocked = !inputs[slot].fire || p.fireCooldown > 0 || p.reloadTicks > 0 || p.ammo <= 0 || p.switchTicks > 0 || p.hp <= 0;
    if (blocked) {
      // A cooldown that ran below zero only carries into a shot fired this tick; otherwise it is spent.
      if (p.fireCooldown < 0) p.fireCooldown = 0;
      continue;
    }
    const gun = weapon(p.equipped === 0 && p.primary !== NO_WEAPON ? p.primary : p.secondary);
    p.ammo--;
    p.fireCooldown += gun.cooldown100;
    const other = (1 - slot) as Slot;
    const e = s.players[other];
    // Spread for how you are moving, plus bloom for every shot in a row. Shotguns roll it per pellet.
    const spread = gun.spread[p.moveState] + Math.min(gun.bloomCap, p.spray * gun.bloom);
    p.spray++;
    p.shotTick = s.tick;
    let total = 0;
    let anyHead = false;
    let first: { angle: number; t: number; hit: boolean } | null = null;
    for (let k = 0; k < gun.pellets; k++) {
      const angle = p.aim + (((rand(s) * 2 - 1) * spread) * Math.PI) / 180;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const tWall = rayWalls(map.walls, p.x, p.y, dx, dy);
      const tHit = rayCircle(p.x, p.y, dx, dy, e.x, e.y, C.RADIUS);
      const hit = tHit < tWall;
      // Headshot: the bullet's line passes within HEAD_RADIUS of their centre (perpendicular distance).
      const head = hit && Math.abs((e.x - p.x) * dy - (e.y - p.y) * dx) <= HEAD_RADIUS;
      if (hit) {
        total += damageAt(gun, tHit, head);
        anyHead ||= head;
      }
      first ??= { angle, t: hit ? tHit : tWall, hit };
    }
    if (total > 0) {
      damage[other] += total;
      headKill[other] = anyHead;
      killGun[other] = gun.id;
    }
    const f = first!;
    events.push({
      type: 'shot', tick: s.tick, slot, x: p.x, y: p.y, toX: p.x + Math.cos(f.angle) * f.t, toY: p.y + Math.sin(f.angle) * f.t,
      angle: f.angle, hit: total > 0, weapon: gun.id, head: anyHead, damage: total,
    });
  }
  for (const slot of [0, 1] as const) {
    if (damage[slot] === 0) continue;
    const v = s.players[slot];
    // Shields take damage first.
    const absorbed = Math.min(v.armor, damage[slot]);
    v.armor -= absorbed;
    v.hp = Math.max(0, v.hp - (damage[slot] - absorbed));
    if (v.hp === 0) {
      const killer = (1 - slot) as Slot;
      events.push({ type: 'kill', tick: s.tick, killer, victim: slot, head: headKill[slot], weapon: killGun[slot] });
      addCredits(s, killer, ECON.KILL, 'kill', events);
    }
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
    const inSite = Object.values(map.sites).some((site) => inRect(site, ap.x, ap.y));
    if (inputs[atk].use && ap.moveState === 0 && inSite) {
      if (++ap.useTicks >= C.PLANT_TICKS) {
        ap.useTicks = 0;
        s.spike = { state: 'planted', x: ap.x, y: ap.y, ticksLeft: C.FUSE_TICKS };
        events.push({ type: 'plant', tick: s.tick, slot: atk, x: ap.x, y: ap.y });
        addCredits(s, atk, ECON.PLANT, 'plant', events);
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

/**
 * True once a state has left the original game: VALORANT rules, a flashbang, a gun other than the original
 * rifle in hand, shields, or a sub-tick fire cooldown. Spray and last-shot tick are left out of the test on
 * purpose: with the original rifle (no bloom) they cannot change how the match unfolds.
 */
function usesNewFields(s: State): boolean {
  if (s.rules === 'valorant' || s.flashes.length > 0) return true;
  return s.players.some((p) =>
    p.flashes !== C.FLASHES || p.flashCooldown !== 0 || p.blindTicks !== 0 || p.primary !== 0 || p.secondary !== 1 ||
    p.equipped !== 0 || p.switchTicks !== 0 || p.armor !== 0 || p.credits !== 0 || p.ammo2 !== weapon(1).mag ||
    p.fireCooldown % 100 !== 0);
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
  // The original fields, in the original order. fireCooldown is now kept in 1/100 ticks; the original rifle
  // only ever holds whole ticks, so /100 gives back exactly the number the original engine hashed.
  for (const p of s.players) {
    ints.push(
      q(p.x), q(p.y), q(p.aim), p.hp, p.ammo, p.reloadTicks, Math.trunc(p.fireCooldown / 100),
      p.smokes, p.dashes, p.dashTicks, q(p.dashX), q(p.dashY), p.useTicks, p.moveState,
      p.lastSeen ? q(p.lastSeen.x) : -1, p.lastSeen ? q(p.lastSeen.y) : -1, p.lastSeen ? p.lastSeen.tick : -1,
    );
  }
  for (const k of s.smokes) ints.push(q(k.x), q(k.y), k.ticksLeft);
  // Fields added later (flashes, guns, economy) are hashed only once a state actually uses them. A classic
  // match that never touches them evolves exactly as it did before they existed, so every recording made
  // before then keeps its original hash and `npm run replay` still matches it.
  if (usesNewFields(s)) {
    for (const p of s.players) {
      ints.push(
        p.fireCooldown, p.flashes, p.flashCooldown, p.blindTicks,
        p.primary, p.secondary, p.equipped, p.ammo2, p.switchTicks, Math.round(p.spray * 2), p.shotTick,
        p.credits, p.armor,
      );
    }
    ints.push(s.rules === 'valorant' ? 1 : 0, s.lossStreak[0], s.lossStreak[1]);
    for (const f of s.flashes) ints.push(q(f.x), q(f.y), q(f.vx), q(f.vy), f.ticksLeft, f.slot);
  }

  let h = 0x811c9dc5;
  for (const n of ints) {
    for (let i = 0; i < 4; i++) {
      h ^= (n >>> (8 * i)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
