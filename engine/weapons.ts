// The VALORANT armory (used with permission granted to hackathon attendees).
// Damage, fire rate, magazine, reload and price follow the game's published values as of recent patches,
// written from memory: check them against the current patch notes before quoting exact numbers.
// One map unit is treated as one metre for damage falloff.
//
// Headshots are real aim, not a dice roll: a hit is a headshot when the bullet's line passes within
// HEAD_RADIUS of the target's centre. Spread and spray bloom push it off centre. There are no legs in
// top-down, so leg damage is not modelled.

export type WeaponClass = 'sidearm' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'heavy' | 'legacy';

export type Weapon = {
  id: number;
  name: string;
  cls: WeaponClass;
  kind: 'primary' | 'secondary';
  price: number;
  /** Time between shots in 1/100 ticks, so fire rates like 9.75/s are exact on average at 32 ticks/s. */
  cooldown100: number;
  mag: number;
  reload: number; // ticks
  spread: [number, number, number]; // degrees: still, walking, running (per pellet for shotguns)
  bloom: number; // extra degrees per consecutive shot
  bloomCap: number; // max extra degrees
  /** Damage by range: [up to this many units, head, body]. The last band covers everything beyond. */
  damage: [number, number, number][];
  pellets: number; // 1, or more for shotguns
  silenced: boolean; // suppressed: not heard through walls
  blurb: string;
};

const W = (
  id: number, name: string, cls: WeaponClass, price: number, rate: number, mag: number, reloadS: number,
  spread: [number, number, number], bloom: number, bloomCap: number, damage: [number, number, number][],
  extra: { pellets?: number; silenced?: boolean } = {}, blurb = '',
): Weapon => ({
  id, name, cls, kind: cls === 'sidearm' ? 'secondary' : 'primary', price,
  cooldown100: Math.round(3200 / rate), mag, reload: Math.round(reloadS * 32), spread, bloom, bloomCap, damage,
  pellets: extra.pellets ?? 1, silenced: extra.silenced ?? false, blurb,
});

const INF = Infinity;

export const WEAPONS: Weapon[] = [
  // 0: the original rifle of this project. Not sold in VALORANT rules; kept so classic matches and old tests stay exact.
  W(0, 'Standard', 'legacy', 0, 4, 10, 2, [1, 4, 10], 0, 0, [[INF, 25, 25]], {}, 'The original. 4 shots a second.'),
  // Sidearms
  W(1, 'Classic', 'sidearm', 0, 6.75, 12, 1.75, [0.4, 2.5, 6], 0.6, 4, [[30, 78, 26], [INF, 66, 22]], {}, 'Free. Tap the head.'),
  W(2, 'Shorty', 'sidearm', 150, 3.33, 2, 1.75, [4, 4.5, 5], 0, 0, [[7, 22, 11], [15, 12, 6], [INF, 6, 3]], { pellets: 15 }, 'Two shells. Point blank only.'),
  W(3, 'Frenzy', 'sidearm', 450, 10, 13, 1.5, [0.65, 2.5, 6], 0.9, 6, [[20, 78, 26], [INF, 63, 21]], {}, 'Full-auto pistol.'),
  W(4, 'Ghost', 'sidearm', 500, 6.75, 15, 1.5, [0.3, 2, 5], 0.5, 3.5, [[30, 105, 30], [INF, 87, 25]], { silenced: true }, 'Suppressed. Two-tap head.'),
  W(5, 'Sheriff', 'sidearm', 800, 4, 6, 2.25, [0.25, 2.5, 6], 1.6, 6, [[30, 159, 55], [INF, 145, 50]], {}, 'One headshot kills.'),
  // SMGs
  W(6, 'Stinger', 'smg', 1100, 16, 20, 2.25, [0.65, 2, 4], 0.7, 7, [[15, 67, 27], [INF, 62, 25]], {}, 'Very fast. Close range.'),
  W(7, 'Spectre', 'smg', 1600, 13.33, 30, 2.25, [0.4, 1.5, 3], 0.35, 4.5, [[20, 78, 26], [INF, 66, 22]], { silenced: true }, 'Suppressed SMG. Runs and guns.'),
  // Shotguns
  W(8, 'Bucky', 'shotgun', 850, 1.1, 5, 2.5, [2.6, 2.6, 3], 0, 0, [[8, 40, 20], [12, 26, 13], [INF, 18, 9]], { pellets: 15 }, 'Pump. One blast up close.'),
  W(9, 'Judge', 'shotgun', 1850, 3.5, 7, 2.2, [2.25, 2.25, 2.6], 0.5, 2, [[10, 34, 17], [15, 26, 13], [INF, 20, 10]], { pellets: 12 }, 'Auto shotgun. Holds corners.'),
  // Rifles
  W(10, 'Bulldog', 'rifle', 2050, 9.15, 24, 2.5, [0.3, 2.5, 6], 0.55, 6, [[INF, 116, 35]], {}, 'Budget rifle.'),
  W(11, 'Guardian', 'rifle', 2250, 5.25, 12, 2.5, [0.1, 2.5, 7], 1.2, 5, [[INF, 195, 65]], {}, 'Semi-auto. One-tap head through shields.'),
  W(12, 'Phantom', 'rifle', 2900, 11, 30, 2.5, [0.2, 2.5, 6.5], 0.3, 4.5, [[15, 156, 39], [30, 140, 35], [INF, 124, 31]], { silenced: true }, 'Suppressed. Tight spray, damage falls off.'),
  W(13, 'Vandal', 'rifle', 2900, 9.75, 25, 2.5, [0.25, 2.5, 6.5], 0.45, 6, [[INF, 160, 40]], {}, 'One-tap head at any range.'),
  // Snipers
  W(14, 'Marshal', 'sniper', 950, 1.5, 5, 2.5, [0, 3, 8], 0, 0, [[INF, 202, 101]], {}, 'Light sniper. One head, two body.'),
  W(15, 'Outlaw', 'sniper', 2400, 2.75, 2, 2.8, [0, 3, 8], 0, 0, [[INF, 238, 140]], {}, 'Double-shot sniper.'),
  W(16, 'Operator', 'sniper', 4700, 0.6, 5, 3.7, [0, 6, 15], 0, 0, [[INF, 255, 150]], {}, 'One body shot kills. Stand still.'),
  // Heavies
  W(17, 'Ares', 'heavy', 1600, 10, 50, 3.25, [1, 3, 6], 0.25, 4, [[30, 72, 30], [INF, 67, 28]], {}, 'Big mag, spins up.'),
  W(18, 'Odin', 'heavy', 3200, 12, 100, 5, [0.8, 3, 6], 0.2, 4, [[30, 95, 38], [INF, 77, 31]], {}, 'Wall of bullets.'),
];

/** Shields: extra hit points taken first. Bought like a gun (these ids go in `input.buy`). */
export const SHIELDS: Record<number, { name: string; amount: number; price: number }> = {
  100: { name: 'Light Shields', amount: 25, price: 400 },
  101: { name: 'Heavy Shields', amount: 50, price: 1000 },
};

/** Damage of one bullet (or pellet) at a distance. */
export function damageAt(w: Weapon, distance: number, head: boolean): number {
  for (const [upTo, h, b] of w.damage) if (distance <= upTo) return head ? h : b;
  const last = w.damage[w.damage.length - 1];
  return head ? last[1] : last[2];
}

/** A hit whose line passes this close to the target's centre is a headshot. */
export const HEAD_RADIUS = 0.13;
/** Buying is allowed in the first 4 seconds of a round. */
export const BUY_TICKS = 128;
/** Swapping between primary and secondary takes a quarter second. */
export const SWITCH_TICKS = 8;
/** Unsilenced shots are heard this far, through walls. */
export const SHOT_HEAR_RANGE = 30;
/** No primary weapon (after dying in VALORANT rules). */
export const NO_WEAPON = -1;

/** The VALORANT economy. */
export const ECON = {
  START: 800, WIN: 3000, LOSS: [1900, 2400, 2900], KILL: 200, PLANT: 300, MAX: 9000,
} as const;

export function weapon(id: number): Weapon {
  return WEAPONS[id] ?? WEAPONS[0];
}

export function isBuyable(id: number): boolean {
  return (id > 0 && id < WEAPONS.length) || id in SHIELDS;
}
