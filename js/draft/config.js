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

/**
 * Cross-device draft sync (optional).
 *
 * The anon key is a *publishable* key and belongs in client code — but this
 * repo is public and there is no sign-in, so treat the synced row as public
 * data. It holds a pick log and nothing else. Leave `anonKey` empty to turn
 * sync off entirely; the app then behaves exactly as it did before.
 *
 * NEVER put a service_role key here. That key bypasses row-level security.
 */
export const SUPABASE = {
  url: 'https://gwemacdcdpeuajhjhamc.supabase.co',
  anonKey: '', // paste the project's anon / publishable key to enable sync
};

export const ROUNDS = 15;
/**
 * The owner's league is six managers. The Draft API's own
 * `settings.league.default_entries` is 8, but defaulting to the league actually
 * being drafted saves a step on the night; any size from 2 to 16 stays selectable.
 */
export const LEAGUE_SIZE_DEFAULT = 6;
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
  /** Below this, the survival-weighted opportunity-cost accumulation over
   *  remaining alternatives is negligible and further ones are skipped. */
  urgencyCarriedCutoff: 1e-6,
  /** Minimum urgency score before a reason cites the cost of passing. */
  urgencyReasonThreshold: 0.5,
  /**
   * Below this survival probability, a scarcity reason may additionally say
   * comparable options are unlikely to remain until the next pick. Above it,
   * that clause is omitted rather than asserted without support.
   */
  scarcitySurvivalReasonThreshold: 0.5,

  /* --- replacement level --- */
  /**
   * 'demand'   — replacement is the player at the edge of the league's
   *              OUTSTANDING roster demand at that position. Responds to the
   *              draft as it happens.
   * 'starters' — replacement is measured against starting slots only.
   * The two are compared in scripts/draft-diagnostics.mjs.
   */
  replacementBasis: 'starters',

  /* --- tiers and scarcity --- */
  /** Standard deviations above the mean gap that constitute a cliff. */
  tierGapThreshold: 1.0,
  /** Supply:demand at or below this marks a position HIGH scarcity. */
  scarcityHighRatio: 1.0,
  scarcityMediumRatio: 2.0,
  /**
   * How the scarcity LABEL (not the raw ratio) feeds the decision score.
   * `scarcityByPosition` ranks positions by their VORP gap and labels exactly
   * one HIGH, one MEDIUM, the rest LOW (zero-demand positions are always LOW).
   * Its `ratio` field (supply ÷ demand) is retained only as displayed detail —
   * on real data it spans just ~2.9-6.5 across all four positions at draft
   * start, so 1/(1+ratio) barely discriminates between them. The label is the
   * meaningful signal, so the decision score is built from these three fixed
   * points rather than from the ratio.
   */
  scarcityLabelWeights: { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.15 },

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
  /** Weight on the "unproven" component of risk (thin first-team evidence). */
  unprovenWeight: 0.5,
  /** Minimum risk score before a reason surfaces an availability/minutes warning. */
  riskReasonThreshold: 0.3,

  /* --- Phase 2 --- */
  /** Minimum projected gain before a waiver swap is worth recommending. */
  minimumImprovement: 4,
};
