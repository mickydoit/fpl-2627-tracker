/**
 * Draft -> model adapter.
 *
 * FPL Draft ships season totals but no per-90 fields, and no prices at all.
 * Everything the projection model needs is derivable from `minutes`, except
 * the price prior — which is replaced by one built on the game's own
 * `draft_rank`.
 */

const num = (v) => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Ceiling of the prior per position, matching pricePrior's clamp bounds. */
const PRIOR_CEIL = { 1: 5.2, 2: 6.0, 3: 7.5, 4: 7.5 };
const PRIOR_FLOOR = 0.4;

/**
 * Expected points per appearance from draft rank. Decays from the position
 * ceiling at rank 1 and flattens by roughly rank 200, then takes the higher
 * of that and points_per_game where a player already has a record.
 */
export function draftPrior(p) {
  const rank = num(p.draft_rank) || 500;
  const ceil = PRIOR_CEIL[p.element_type] ?? 6.0;
  const decayed = ceil * Math.exp(-(rank - 1) / 90);
  const ppg = num(p.points_per_game);
  return clamp(Math.max(decayed, ppg), PRIOR_FLOOR, ceil);
}

/** Per-90 rate from a season total. Zero minutes gives zero, not NaN. */
const per90 = (total, minutes) => (minutes > 0 ? (num(total) / minutes) * 90 : 0);

/**
 * Map Draft's bootstrap elements into the row shape js/model.js expects.
 * Original fields are preserved so draft_rank and friends stay available.
 */
export function adaptDraftElements(draftBoot) {
  return (draftBoot?.elements || []).map((p) => {
    const mins = num(p.minutes);
    return {
      ...p,
      expected_goals_per_90: per90(p.expected_goals, mins),
      expected_assists_per_90: per90(p.expected_assists, mins),
      expected_goals_conceded_per_90: per90(p.expected_goals_conceded, mins),
      saves_per_90: per90(p.saves, mins),
      defensive_contribution_per_90: per90(p.defensive_contribution, mins),
    };
  });
}
