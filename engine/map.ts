import type { Rect } from './types';

/** A one-way teleporter: touching the pad moves you to `exit`. Exits sit outside every pad, so nobody ping-pongs. */
export type Teleporter = { pad: Rect; exit: { x: number; y: number } };

export type GameMap = {
  id: string;
  name: string;
  blurb: string;
  width: number;
  height: number;
  walls: Rect[];
  /** Plant sites by label. Two on most maps, three on Trident. */
  sites: Record<string, Rect>;
  spawns: { attacker: { x: number; y: number }; defender: { x: number; y: number } };
  teleporters: Teleporter[];
};

const W = 48;
const H = 32;
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
// Border, placed just outside the playable area so rays and collision need no special case.
const BORDER = [r(-1, -1, W + 2, 1), r(-1, H, W + 2, 1), r(-1, 0, 1, H), r(W, 0, 1, H)];
const SPAWNS = { attacker: { x: 3, y: 16 }, defender: { x: 45, y: 16 } };

/*
 * The original map. Three lanes run left to right: top (to site A), mid, bottom (to site B).
 *
 *   +-----------------------------------------------+
 *   |          [box]        |choke  AAAAAAAA        |
 *   |                          gap  AA[]AAAA        |
 *   |       ============  ================          |
 *   | atk        [box]        [pil] |door     def   |
 *   |       ==========  ==================          |
 *   |                          gap  BB[]BBBB        |
 *   |            [box]      |choke  BBBBBBBB        |
 *   +-----------------------------------------------+
 */
const duel: GameMap = {
  id: 'duel',
  name: 'Duel',
  blurb: 'The original. Three lanes, two sites, a mid door.',
  width: W,
  height: H,
  walls: [
    ...BORDER,
    // Lane dividers. The gaps (x 20-24 top, x 18-22 bottom) are rotation connectors.
    r(8, 10, 12, 2), r(24, 10, 16, 2),
    r(8, 20, 10, 2), r(22, 20, 18, 2),
    // Site chokes: the attacker has to swing through a 4-wide opening.
    r(30, 2, 1, 4), r(30, 26, 1, 4),
    // Mid door at x 34, opening y 14-18. The pillar breaks the long sightline through it.
    r(34, 12, 1, 2), r(34, 18, 1, 2), r(28, 14, 2, 4),
    // Cover boxes.
    r(22, 4, 2, 3), r(15, 15, 2, 2), r(24, 25, 2, 3),
    r(36, 5, 2, 2), r(36, 25, 2, 2),
  ],
  sites: { A: r(32, 2, 8, 8), B: r(32, 22, 8, 8) },
  spawns: SPAWNS,
  teleporters: [],
};

/*
 * Relay: no mid. A solid block splits the map, so the only fast rotate is a one-way teleporter
 * on the attacker side. A has a wide main and a narrow "bath" entry; B has "hookah" and "long".
 *
 *   +-----------------------------------------------+
 *   | atk  [T1]      lamps       |   AAAAAAAAA      |
 *   |         =======showers=    |   AA[]AAAAA      |
 *   |                            bath               |
 *   |        ##########################   def      |
 *   |        ##########################             |
 *   |                          hookah               |
 *   |         ======hookah====   |   BB[]BBBBB      |
 *   |      [T2]       long       |   BBBBBBBBB      |
 *   +-----------------------------------------------+
 */
const relay: GameMap = {
  id: 'relay',
  name: 'Bind',
  blurb: 'No mid. Two teleporters on the attacker side make fast fake rotates.',
  width: W,
  height: H,
  walls: [
    ...BORDER,
    r(10, 12, 26, 8), // the block: no mid
    r(16, 6, 12, 1), r(16, 25, 12, 1), // showers / hookah dividers
    r(33, 4, 1, 6), // A choke: main (y 0-4) and bath (y 10-12)
    r(33, 22, 1, 6), // B choke: hookah window (y 20-22) and long (y 28-32)
    r(39, 5, 2, 2), r(39, 25, 2, 2), // site boxes
    r(42, 14, 1, 4), // defender spawn cover
    r(22, 2, 2, 2), r(22, 28, 2, 2), // lane cover
  ],
  sites: { A: r(36, 1, 9, 9), B: r(36, 22, 9, 9) },
  spawns: SPAWNS,
  teleporters: [
    { pad: r(6, 3, 2, 2), exit: { x: 26, y: 29.5 } }, // A-side lane to B long
    { pad: r(6, 27, 2, 2), exit: { x: 26, y: 2.5 } }, // B-side lane to A lamps
  ],
};

/*
 * Trident: three sites, A top, B mid, C bottom. Defenders have to guess which one, attackers
 * have to pick. Two rotation gaps cut through the lane walls.
 */
const trident: GameMap = {
  id: 'trident',
  name: 'Haven',
  blurb: 'Three sites. A top, B in the middle, C at the bottom.',
  width: W,
  height: H,
  walls: [
    ...BORDER,
    r(8, 10, 10, 2), r(22, 10, 12, 2), // top divider, rotate gap x 18-22
    r(8, 20, 10, 2), r(22, 20, 12, 2), // bottom divider
    r(32, 3, 1, 4), // A choke: openings y 0-3 and y 7-10
    r(32, 25, 1, 4), // C choke: openings y 22-25 and y 29-32
    r(32, 12, 1, 3), r(32, 17, 1, 3), // B mid window, opening y 15-17
    r(38, 4, 2, 2), r(38, 26, 2, 2), // site boxes
    r(14, 15, 2, 2), r(24, 5, 2, 2), r(24, 26, 2, 2), // lane cover
  ],
  sites: { A: r(35, 1, 10, 8), B: r(34, 13, 6, 6), C: r(35, 23, 10, 8) },
  spawns: SPAWNS,
  teleporters: [],
};

/*
 * Courtyard: a big open courtyard in mid that both sides fight over. Each site has a wide main
 * and a narrow door that opens off mid.
 */
const courtyard: GameMap = {
  id: 'courtyard',
  name: 'Ascent',
  blurb: 'Open mid courtyard. Win mid, then hit a site from its door.',
  width: W,
  height: H,
  walls: [
    ...BORDER,
    r(8, 9, 14, 2), r(8, 21, 14, 2), // lane dividers end at the courtyard
    r(33, 3, 1, 3), r(33, 8, 1, 3), // A west wall: main y 0-3, door y 6-8
    r(33, 11, 7, 1), // A south wall
    r(33, 21, 1, 3), r(33, 26, 1, 3), // B west wall: door y 24-26, main y 29-32
    r(33, 20, 7, 1), // B north wall
    r(26, 14, 3, 4), // courtyard pillar
    r(18, 15, 2, 2), // lane box
    r(38, 4, 2, 2), r(38, 26, 2, 2), // site boxes
  ],
  sites: { A: r(35, 1, 10, 9), B: r(35, 22, 10, 9) },
  spawns: SPAWNS,
  teleporters: [],
};

/*
 * Fault: tight. Long dividers leave only narrow vents from mid into each site, and the
 * site chokes are two units wide. Every corner is a duel.
 */
const fault: GameMap = {
  id: 'fault',
  name: 'Split',
  blurb: 'Tight chokes and vents. Close fights on every corner.',
  width: W,
  height: H,
  walls: [
    ...BORDER,
    r(8, 10, 20, 2), r(32, 10, 6, 2), // top divider, vent x 28-32
    r(8, 20, 20, 2), r(32, 20, 6, 2), // bottom divider, vent x 28-32
    r(16, 12, 2, 3), r(16, 17, 2, 3), // mid mail, opening y 15-17
    r(34, 2, 1, 6), // A ramps: openings y 0-2 and y 8-10
    r(34, 24, 1, 6), // B main: openings y 22-24 and y 30-32
    r(40, 5, 2, 2), r(40, 25, 2, 2), // site boxes
    r(22, 4, 2, 2), r(22, 26, 2, 2), // lane cover
  ],
  sites: { A: r(36, 1, 9, 9), B: r(36, 22, 9, 9) },
  spawns: SPAWNS,
  teleporters: [],
};

const MAPS: Record<string, GameMap> = { duel, relay, trident, courtyard, fault };

/** Every map id, in lobby order. */
export const MAP_IDS: string[] = Object.keys(MAPS);

export function getMap(id: string): GameMap {
  const m = MAPS[id];
  if (!m) throw new Error(`unknown map ${id}`);
  return m;
}

export function isMapId(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAPS, id);
}
