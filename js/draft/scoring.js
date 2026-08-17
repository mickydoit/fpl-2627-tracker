/**
 * 2026/27 BPS reconstruction.
 *
 * What can be claimed: the rebalanced BPS weights applied to the season totals
 * the game actually publishes — CBI at one per three (was one per two), the
 * tackled-penalty event gone, keeper saves restructured.
 *
 * What cannot: exact expected bonus. Bonus depends on a player's BPS relative
 * to the other twenty-one players in that specific match, and match-level Opta
 * event data is not public. So this is an estimate, flagged as one.
 *
 * Protection is by SHRINKAGE, not by a ceiling. Capping the bonus component
 * would flatten exactly the attacking full-backs and shot-stopping keepers the
 * rebalance rewards — the error this module exists to fix. Instead the estimate
 * is pulled toward a position baseline in proportion to how thin the evidence
 * behind it is, which restrains noisy players without truncating the top of the
 * distribution.
 */
import { DRAFT_CONFIG } from './config.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 2026/27 BPS weights for the events the API actually publishes. */
const BPS = {
  startingAppearance: 6,
  perGoal: { 1: 12, 2: 12, 3: 18, 4: 24 },
  perAssist: 9,
  cleanSheet: { 1: 12, 2: 12, 3: 0, 4: 0 },
  savesPerBps: 2,        // 1 BPS per 2 saves
  penaltySaved: 15,
  cbiPerBps: 3,          // 2026/27: 1 BPS per 3 CBI, was 1 per 2
  tackleBps: 2,
  recoveryPerBps: 3,
  yellow: -3,
  red: -9,
  ownGoal: -6,
};

/** A plausible BPS/90 baseline per position, used as the shrinkage target. */
const BASELINE_BPS90 = { 1: 18, 2: 16, 3: 15, 4: 14 };

/**
 * Estimated BPS per 90 from published season totals.
 * `confidence` rises with minutes played — thin evidence produces a number that
 * should not be trusted at face value, and the caller shrinks accordingly.
 */
export function estimateBps90(p) {
  const mins = num(p.minutes);
  const pos = p.element_type;
  if (mins <= 0) {
    return { bps90: BASELINE_BPS90[pos] ?? 15, confidence: 0, approximate: true };
  }

  const games = mins / 90;
  const total =
    num(p.starts) * BPS.startingAppearance
    + num(p.goals_scored) * (BPS.perGoal[pos] ?? 18)
    + num(p.assists) * BPS.perAssist
    + num(p.clean_sheets) * (BPS.cleanSheet[pos] ?? 0)
    + Math.floor(num(p.saves) / BPS.savesPerBps)
    + num(p.penalties_saved) * BPS.penaltySaved
    + Math.floor(num(p.clearances_blocks_interceptions) / BPS.cbiPerBps)
    + num(p.tackles) * BPS.tackleBps
    + Math.floor(num(p.recoveries) / BPS.recoveryPerBps)
    + num(p.yellow_cards) * BPS.yellow
    + num(p.red_cards) * BPS.red
    + num(p.own_goals) * BPS.ownGoal;

  const bps90 = Math.max(0, total / games);
  const confidence = clamp(mins / DRAFT_CONFIG.minutesConfidence, 0, 1);
  return { bps90, confidence, approximate: true };
}

/**
 * Expected bonus points per appearance from an estimated BPS/90.
 *
 * The logistic maps BPS/90 onto the 0–3 bonus range. Shrinkage blends the
 * player's own estimate with a *position-specific* baseline expectation
 * (`BASELINE_BPS90`) in proportion to confidence, so an unproven player
 * regresses toward what's plausible for a keeper, defender, midfielder or
 * forward — not toward a single shared number — instead of inheriting a
 * wild rate from 200 minutes of football. `pos` is optional so this stays
 * callable without one; omitting it falls back to a generic mid-table value.
 */
export function bonusFromBps90(bps90, confidence = 1, pos = null) {
  const curve = (x) => 3 / (1 + Math.exp(-(x - 30) / 8));
  const own = curve(bps90);
  const baseline = curve(BASELINE_BPS90[pos] ?? 20);
  const c = clamp(confidence, 0, 1);
  return clamp(own * c + baseline * (1 - c), 0, 3);
}

/** Drop-in replacement for the model's internal bonus term. */
export function draftBonusModel(p) {
  const { bps90, confidence } = estimateBps90(p);
  return bonusFromBps90(bps90, confidence, p.element_type);
}
