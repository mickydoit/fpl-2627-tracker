/**
 * Draft strategy configuration.
 *
 * Every coefficient the recommendation depends on lives here, named and
 * documented, so the board can be tuned after watching it behave on a real
 * draft night without hunting through the logic. Nothing in js/draft/ may
 * inline a magic number that belongs in this file.
 */

/** Roster quotas. FPL Draft matches the main game: 2/5/5/3, fifteen players. */
export const QUOTA = { 1: 2, 2: 5, 3: 5, 4: 3 };

/**
 * Starting slots for a representative XI (1 GK, 4 DEF, 4 MID, 2 FWD).
 * Only eleven players score and the reserve keeper never plays, so a
 * starters-based replacement level stops bench positions earning early picks.
 * Retained as an alternative basis — see `replacementBasis`.
 */
export const STARTER_QUOTA = { 1: 1, 2: 4, 3: 4, 4: 2 };

export const ROUNDS = 15;
export const LEAGUE_SIZE_DEFAULT = 8;  // the Draft API's own settings.league.default_entries
export const LEAGUE_SIZE_MIN = 2;
export const LEAGUE_SIZE_MAX = 16;

export const DRAFT_CONFIG = {
  /* --- horizons --- */
  /** Gameweeks in the near-term projection. Matches the classic model default. */
  nearTermHorizon: 5,
  /** Gameweeks in the rest-of-season projection. A full season. */
  rosHorizon: 38,

  /* --- how the two horizons combine --- */
  /**
   * A first-round pick is a season-long asset, so ROS dominates early. Later
   * rounds are marginal players where short-term role and fixtures matter more.
   * `nearTermWeight` is the share given to the near-term number in the FINAL
   * round; the blend moves linearly from `rosWeight` at round one.
   */
  rosWeight: 1.0,
  nearTermWeight: 0.35,

  /* --- decision score components --- */
  vorpWeight: 1.0,
  scarcityWeight: 0.35,
  urgencyWeight: 0.9,
  rosterNeedWeight: 0.25,
  riskWeight: 0.5,

  /* --- replacement level --- */
  /**
   * 'demand'   — replacement is the player at the edge of the league's
   *              OUTSTANDING roster demand at that position. Responds to the
   *              draft as it happens.
   * 'starters' — replacement is measured against starting slots only.
   * The two are compared in scripts/draft-diagnostics.mjs.
   */
  replacementBasis: 'demand',

  /* --- tiers and scarcity --- */
  /** Standard deviations above the mean gap that constitute a cliff. */
  tierGapThreshold: 1.0,
  /** Supply:demand at or below this marks a position HIGH scarcity. */
  scarcityHighRatio: 1.0,
  scarcityMediumRatio: 2.0,

  /* --- survival simulation --- */
  survivalTrials: 300,
  survivalSeed: 12345,
  /** Width of the window a typical manager picks within. 1 = a robot. */
  opponentGreed: 3,

  /* --- risk --- */
  /** Weight on the availability penalty; 1 fully discounts a doubtful player. */
  availabilityPenalty: 1.0,
  /** Minutes of evidence below which a player is treated as unproven. */
  minutesConfidence: 900,

  /* --- Phase 2 --- */
  /** Minimum projected gain before a waiver swap is worth recommending. */
  minimumImprovement: 4,
};
