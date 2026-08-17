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
 * The label comes from the ratio of useful supply to outstanding demand, and
 * is pulled up to HIGH when the cliff is close enough that the league's
 * remaining demand will eat through the good players before it is satisfied.
 */
export function scarcityByPosition(rows, demand, { leagueSize = LEAGUE_SIZE_DEFAULT } = {}) {
  const out = {};
  for (const t of TYPES) {
    const pool = rows.filter((r) => r.element_type === t);
    const need = demand?.[t] ?? 0;
    const beforeCliff = playersBeforeCliff(rows, t);
    const ratio = need > 0 ? pool.length / need : Infinity;

    let label;
    if (pool.length === 0 && need > 0) label = 'HIGH';
    else if (ratio >= DRAFT_CONFIG.scarcityHighRatio) label = 'HIGH';
    else if (ratio >= DRAFT_CONFIG.scarcityMediumRatio) label = 'MEDIUM';
    else label = 'LOW';

    // A cliff the league will chew straight through is urgent regardless of
    // how many bodies sit below it.
    if (beforeCliff < pool.length && need >= beforeCliff) label = 'HIGH';

    out[t] = { available: pool.length, demand: need, ratio, beforeCliff, label };
  }
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
