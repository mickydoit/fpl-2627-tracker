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
  anonKey: 'sb_publishable_AuvRYZ78ggTkoF3n-s1qFQ_0otk7JFZ', // publishable key — safe in client code
};

/**
 * How the League Hub's headline rating weighs its components.
 *
 * These are weights on each squad's PERCENTILE within the league, not on raw
 * points — see js/draft/rating.js for why. They must sum to 1.
 *
 * The shape of the opinion: only eleven players score, so best-XI strength
 * dominates. Total squad strength still matters because injuries and rotation
 * are certain over 38 gameweeks, but it is worth less than the XI. Depth is
 * measured as what the XI actually loses per absence, which is why it earns
 * real weight rather than a token. VORP and risk are deliberately small — both
 * are already partly expressed through the first three, and double-counting
 * them would let one idea dominate the number.
 */
export const RATING_WEIGHTS = { xi: 0.40, ros: 0.25, depth: 0.15, vorp: 0.10, risk: 0.10 };

export const ROUNDS = 15;
/**
 * The owner's league is six managers. The Draft API's own
 * `settings.league.default_entries` is 8, but defaulting to the league actually
 * being drafted saves a step on the night; any size from 2 to 16 stays selectable.
 */
export const LEAGUE_SIZE_DEFAULT = 6;
export const LEAGUE_SIZE_MIN = 2;
export const LEAGUE_SIZE_MAX = 16;

/**
 * Which replacement basis to measure VORP against, by league size.
 *
 * `starters` places the baseline at STARTER_QUOTA[t] * size, a fixed index;
 * `demand` places it at the league's outstanding roster slots, which starts
 * deeper (QUOTA is 2/5/5/3 against a starting 1/4/4/2) and decays to zero as
 * the draft fills up.
 *
 * **Re-measured after the defensive-contribution fix.** The earlier band —
 * demand from five to nine — was derived on projections in which every
 * outfielder received the full two defensive-contribution points, because a
 * volume rate was being read as a scoring rate. That flattened the difference
 * between positions, and the replacement baseline is a per-position quantity,
 * so the comparison was measuring a distorted board. Correcting it moved the
 * answer, which is the whole argument for fixing correctness before tuning.
 *
 * Paired drafts on corrected projections — same board, seed and slot, only my
 * own strategy differing (starters minus demand, so negative means demand won):
 *
 *   size   pairs   startersW  demandW  ties   mean margin
 *      2      24         5       10       9       -1.77
 *      3      36        13       18       5       -3.54
 *      4      48        21       18       9       +0.30
 *      5     200       148       45       7      +12.07
 *      6     240       208       17      15       +7.41
 *      7     280       137      121      22       -2.47
 *      8     320        51      269       0      -16.03
 *      9     360       223      121      16       +4.33
 *     10     120       117        3       0      +58.41
 *     11     132       132        0       0      +70.01
 *     12     144       144        0       0     +105.42
 *     14     168       168        0       0     +114.20
 *     16     192       192        0       0     +106.35
 *
 * `starters` now wins everywhere that shows a stable signal, decisively from
 * ten managers up and clearly at five, six and nine. Two and three lean demand
 * by margins smaller than a single point of a squad total; four and seven are
 * coin flips.
 *
 * **Eight managers is a genuine, unexplained exception.** Demand wins it 269-51
 * over 320 paired drafts, worth about sixteen points — too large and too
 * consistent to dismiss, but there is no mechanism that would make eight
 * special while seven and nine both go the other way. Encoding a
 * single-size exception would be fitting a point, not a rule, so the rule
 * stays uniform and the anomaly is written down instead. Worth revisiting with
 * a different opponent model, or once a real draft's worth of evidence exists.
 *
 * The seam is kept as a function rather than folded back into a constant: the
 * head-to-head in scripts/test-draft.mjs asserts the rule still matches what
 * wins, so if the balance shifts again the suite says so.
 */
export const DEMAND_BASIS_SIZES = null;

/** @returns {'demand'|'starters'} */
export function replacementBasisForLeagueSize(leagueSize = LEAGUE_SIZE_DEFAULT) {
  const n = Number(leagueSize);
  if (!Number.isFinite(n)) return 'starters';
  if (!DEMAND_BASIS_SIZES) return 'starters';
  return n >= DEMAND_BASIS_SIZES.min && n <= DEMAND_BASIS_SIZES.max ? 'demand' : 'starters';
}

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
   * Force a basis, overriding the league-size rule below. `null` means use
   * `replacementBasisForLeagueSize()`, which is what the board does.
   *
   * Only the head-to-head in scripts/test-draft.mjs and the diagnostics set
   * this; it exists so both arms of a comparison can be pinned. A basis passed
   * explicitly to `replacementLevel()` still wins over it.
   */
  replacementBasis: null,

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
