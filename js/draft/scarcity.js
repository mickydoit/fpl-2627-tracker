/**
 * Positional supply, demand and urgency.
 *
 * Raw counts mislead: twenty-five interchangeable defenders are less urgent
 * than four forwards when three of the four sit above a cliff. What matters is
 * how many useful players remain before the next real drop in value, measured
 * against how many slots the league still has to fill.
 */
import { DRAFT_CONFIG, LEAGUE_SIZE_DEFAULT } from './config.js';

const TYPES = [1, 2, 3, 4];

/**
 * How many players remain at a position before the next unusually large gap.
 * A gap counts as a cliff when it exceeds the mean gap by `threshold` standard
 * deviations — the same rule the tier system uses, so the two agree.
 */
export function playersBeforeCliff(rows, type, threshold = DRAFT_CONFIG.tierGapThreshold) {
  const pool = rows
    .filter((r) => r.element_type === type)
    .sort((a, b) => b.proj - a.proj);
  if (pool.length < 3) return pool.length;

  const gaps = [];
  for (let i = 1; i < pool.length; i++) gaps.push(pool[i - 1].proj - pool[i].proj);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const cut = mean + threshold * Math.sqrt(variance);

  const at = gaps.findIndex((g) => g > cut);
  return at === -1 ? pool.length : at + 1;
}

/**
 * Supply, demand and an urgency label per position.
 *
 * The label is determined by the urgency gap — how much value you lose by
 * ignoring this position right now, measured as (best available) − (replacement).
 * Positions are ranked by their gap; the scarcest (largest gap, most value at risk)
 * is HIGH, second is MEDIUM, the rest are LOW. Positions with zero outstanding
 * demand are always LOW (nobody needs them, so nothing about them is urgent).
 */
export function scarcityByPosition(rows, demand, { leagueSize = LEAGUE_SIZE_DEFAULT, replacement } = {}) {
  const out = {};

  // Calculate gap for each position and store positions with demand for ranking.
  const gapped = [];
  for (const t of TYPES) {
    const pool = rows.filter((r) => r.element_type === t);
    const need = demand?.[t] ?? 0;
    const beforeCliff = playersBeforeCliff(rows, t);
    const ratio = need > 0 ? pool.length / need : Infinity;

    let gap = 0;
    if (need > 0) {
      if (pool.length === 0) {
        // Exhausted position (no supply but demand remains) is maximally urgent
        gap = Infinity;
      } else {
        // Use vorp if available, else calculate from replacement or pool bounds.
        // Always sort a copy — pool preserves caller's input order, not value order.
        if (pool[0].vorp !== undefined) {
          // VORP provided: find player with max VORP in this position
          const sorted = [...pool].sort((a, b) => (b.vorp ?? 0) - (a.vorp ?? 0));
          gap = sorted[0].vorp;
        } else if (replacement && replacement[t] !== undefined) {
          // Replacement baseline provided: find player with max (proj - replacement)
          const sorted = [...pool].sort((a, b) => b.proj - a.proj);
          gap = sorted[0].proj - replacement[t];
        } else if (pool.length > 1) {
          // No replacement: gap = (best - worst) within position
          const sorted = [...pool].sort((a, b) => b.proj - a.proj);
          gap = sorted[0].proj - sorted[sorted.length - 1].proj;
        } else {
          gap = pool[0].proj;
        }
      }
      gapped.push({ type: t, gap, available: pool.length, need, ratio, beforeCliff });
    }

    // Positions with zero demand are always LOW
    out[t] = { available: pool.length, demand: need, ratio, beforeCliff, label: 'LOW' };
  }

  // Rank positions with demand by gap descending; assign labels
  gapped.sort((a, b) => b.gap - a.gap);
  if (gapped.length > 0) out[gapped[0].type].label = 'HIGH';
  if (gapped.length > 1) out[gapped[1].type].label = 'MEDIUM';

  return out;
}

/**
 * Which positions may still be recommended.
 *
 * Late in a draft, positional need stops being a weight and becomes a filter:
 * with two picks left and a keeper and a defender still required, nothing else
 * is legal. A position with no need left is only allowed while there is slack
 * — enough remaining picks to cover every mandatory slot without it.
 */
export function allowedPositions(needs, picksRemaining) {
  const totalNeeded = TYPES.reduce((s, t) => s + (needs[t] || 0), 0);
  const slack = picksRemaining - totalNeeded;
  return TYPES.filter((t) => needs[t] > 0 || slack > totalNeeded);
}
