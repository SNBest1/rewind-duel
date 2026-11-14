// Ranks. The AI's skill (0 to 1) is shown as a competitive rank, and your rank is the AI level you are
// currently holding your own against: the adaptive AI climbs when you win and drops when you lose, so where
// it settles is, by definition, your level.

// VALORANT's competitive ranks (used with the hackathon's permission): eight tiers of three, then Radiant.
export const TIERS = [
  { name: 'Iron', color: '#8a8a8a' },
  { name: 'Bronze', color: '#a5855d' },
  { name: 'Silver', color: '#d2d6d8' },
  { name: 'Gold', color: '#e8c34f' },
  { name: 'Platinum', color: '#3aa5b6' },
  { name: 'Diamond', color: '#c88ef0' },
  { name: 'Ascendant', color: '#2fbf71' },
  { name: 'Immortal', color: '#d83e5a' },
  { name: 'Radiant', color: '#fff4b8' },
] as const;

/** 8 tiers x 3 divisions, plus Apex on top: 25 steps from skill 0 to 1. */
export const RANK_STEPS = (TIERS.length - 1) * 3 + 1;

export type Rank = { index: number; tier: string; division: number | null; label: string; color: string; rr: number };

export function rankOf(skill: number): Rank {
  const pos = Math.max(0, Math.min(1, skill)) * (RANK_STEPS - 1);
  const index = Math.min(RANK_STEPS - 1, Math.floor(pos + 1e-9));
  const tierIndex = Math.min(TIERS.length - 1, Math.floor(index / 3));
  const t = TIERS[tierIndex];
  const division = tierIndex === TIERS.length - 1 ? null : (index % 3) + 1;
  // RR: progress through the current division, 0 to 99.
  const rr = index === RANK_STEPS - 1 ? 100 : Math.floor((pos - index) * 100);
  return { index, tier: t.name, division, label: division ? `${t.name} ${division}` : t.name, color: t.color, rr };
}

/** The skill at the bottom of a rank step, for "play the AI at Gold 2". */
export function skillOfRank(index: number): number {
  return Math.max(0, Math.min(RANK_STEPS - 1, index)) / (RANK_STEPS - 1);
}

/** Every rank, for the lobby. */
export const ALL_RANKS: Rank[] = Array.from({ length: RANK_STEPS }, (_, i) => rankOf(skillOfRank(i) + 1e-6));
