// Learning curve: how does a clone get better as it trains on more of that player's games? For each player
// we hold out one match, then train on 1, 2, 3, ... of the remaining matches and measure accuracy on the
// held-out match. If a player has few matches the curve is short — that is the honest signal that they
// need more recorded games, not something to hide.
import type { MatchFile, Slot } from '@rewind/engine';
import { buildClone, matchesOf, slotOf } from '@rewind/clone';
import { cloneAccuracy } from './metrics';

export type CurvePoint = { trainMatches: number; bothAcc: number; moveAcc: number; fireAcc: number; decisions: number };
export type PlayerCurve = { player: string; isBot: boolean; heldOut: string; points: CurvePoint[] };

/**
 * Builds the learning curve for one player: hold out their last match, train on the first 1..k of the rest.
 * Returns null if the player has fewer than two matches (no hold-out possible).
 */
export function playerCurve(playerName: string, allMatches: MatchFile[], isBot: boolean): PlayerCurve | null {
  const mine = matchesOf(allMatches, playerName);
  if (mine.length < 2) return null;
  // Hold out the FIRST match — the same one the accuracy table uses — so the curve's last point matches
  // the own-clone row in section 1. (The table trains on everything-but-first; the curve's top k == that.)
  const heldOut = mine[0];
  const slot = slotOf(heldOut, playerName) as Slot;
  const trainPool = mine.filter((m) => m.id !== heldOut.id);

  const points: CurvePoint[] = [];
  for (let k = 1; k <= trainPool.length; k++) {
    const trainIds = trainPool.slice(0, k).map((m) => m.id);
    const built = buildClone(playerName, { allMatches, trainOnly: trainIds });
    const acc = cloneAccuracy(heldOut, slot, built.guarded);
    const d = Math.max(1, acc.decisions);
    points.push({
      trainMatches: k,
      bothAcc: acc.bothMatch / d,
      moveAcc: acc.moveMatch / d,
      fireAcc: acc.fireMatch / d,
      decisions: acc.decisions,
    });
  }
  return { player: playerName, isBot, heldOut: heldOut.id, points };
}

/**
 * An SVG line chart of the learning curves (one line per player, MOVE-match accuracy vs training matches).
 * Move match is the discriminating signal (fire is dominated by "not firing", so it inflates a combined
 * score). Self-contained SVG so it drops straight into a slide or video frame. Returns the SVG string.
 */
export function curveChartSvg(curves: PlayerCurve[], title = 'Clone move-match accuracy vs training matches'): string {
  const W = 720, H = 420, padL = 60, padR = 170, padT = 50, padB = 50;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxX = Math.max(1, ...curves.flatMap((c) => c.points.map((p) => p.trainMatches)));
  const colors = ['#ffb547', '#7fd6e8', '#e5483b', '#9c8a78', '#b39a80', '#efe2c9'];
  const x = (n: number) => padL + (maxX <= 1 ? plotW / 2 : ((n - 1) / (maxX - 1)) * plotW);
  const y = (acc: number) => padT + (1 - acc) * plotH; // 0..1 accuracy, 1 at top

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, monospace">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#160f0c"/>`);
  parts.push(`<text x="${padL}" y="28" fill="#efe2c9" font-size="18" font-weight="700">${title}</text>`);

  // Y gridlines at 0, 25, 50, 75, 100%.
  for (let g = 0; g <= 100; g += 25) {
    const yy = y(g / 100);
    parts.push(`<line x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}" stroke="#3a2d25" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 8}" y="${yy + 4}" fill="#9c8a78" font-size="11" text-anchor="end">${g}%</text>`);
  }
  // X labels (integer training-match counts).
  for (let n = 1; n <= maxX; n++) {
    parts.push(`<text x="${x(n)}" y="${padT + plotH + 20}" fill="#9c8a78" font-size="11" text-anchor="middle">${n}</text>`);
  }
  parts.push(`<text x="${padL + plotW / 2}" y="${H - 10}" fill="#9c8a78" font-size="12" text-anchor="middle">training matches</text>`);
  parts.push(`<text transform="translate(16 ${padT + plotH / 2}) rotate(-90)" fill="#9c8a78" font-size="12" text-anchor="middle">move-match accuracy</text>`);

  curves.forEach((c, i) => {
    const color = colors[i % colors.length];
    const pts = c.points.map((p) => `${x(p.trainMatches)},${y(p.moveAcc)}`).join(' ');
    if (c.points.length === 1) {
      const p = c.points[0];
      parts.push(`<circle cx="${x(p.trainMatches)}" cy="${y(p.moveAcc)}" r="5" fill="${color}"/>`);
    } else {
      parts.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"/>`);
      for (const p of c.points) parts.push(`<circle cx="${x(p.trainMatches)}" cy="${y(p.moveAcc)}" r="3.5" fill="${color}"/>`);
    }
    // Legend.
    const ly = padT + 6 + i * 20;
    parts.push(`<rect x="${padL + plotW + 16}" y="${ly - 9}" width="12" height="12" fill="${color}"/>`);
    parts.push(`<text x="${padL + plotW + 34}" y="${ly + 1}" fill="#efe2c9" font-size="12">${c.player}${c.isBot ? ' (bot)' : ''}</text>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}
