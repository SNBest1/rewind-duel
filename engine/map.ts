import type { Rect } from './types';

export type GameMap = {
  id: string;
  width: number;
  height: number;
  walls: Rect[];
  sites: { A: Rect; B: Rect };
  spawns: { attacker: { x: number; y: number }; defender: { x: number; y: number } };
};

const W = 48;
const H = 32;
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/*
 * Three lanes run left to right: top (to site A), mid, bottom (to site B).
 * Attackers spawn in the open column on the left, defenders in the open column on the right.
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
  width: W,
  height: H,
  walls: [
    // Border, placed just outside the playable area so rays and collision need no special case.
    r(-1, -1, W + 2, 1), r(-1, H, W + 2, 1), r(-1, 0, 1, H), r(W, 0, 1, H),
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
  spawns: { attacker: { x: 3, y: 16 }, defender: { x: 45, y: 16 } },
};

const MAPS: Record<string, GameMap> = { duel };

export function getMap(id: string): GameMap {
  const m = MAPS[id];
  if (!m) throw new Error(`unknown map ${id}`);
  return m;
}
