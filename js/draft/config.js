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
 * The two bases place the baseline at different depths in the available pool:
 * `starters` at STARTER_QUOTA[t] * size, a fixed index; `demand` at the
 * league's outstanding roster slots, which starts deeper (QUOTA is 2/5/5/3
 * against a starting 1/4/4/2) and decays to zero as the draft fills up.
 *
 * Neither wins everywhere, and the reason is depth. Measured over paired
 * drafts — same board, same seed, same slot, only my own strategy differing,
 * so both arms face identical opponents (`starters` minus `demand`, so a
 * negative margin means demand won):
 *
 *   size   pairs   startersW  demandW  ties   mean margin
 *      3     120        95        0      25       +7.96
 *      4     160        84       66      10       -0.87
 *      5     200        22      157      21      -12.67
 *      6      96         0       95       1      -21.13
 *      7     112         9       93      10      -15.70
 *      8     128        27       55      46       -4.25
 *      9     360        12      223     125      -11.66
 *     10     400       291       88      21      +14.73
 *     11     440       438        2       0      +66.56
 *     12     192       192        0       0      +73.26
 *     14     224       224        0       0      +68.86
 *     16     256       236        0      20      +45.98
 *
 * Five through nine go to `demand`, ten and up to `starters`, and the upper
 * boundary has a mechanism behind it: `demand`'s index runs past the usable
 * depth of the shallow positions in a big league. At sixteen managers the
 * keeper baseline collapses to 55.7 projected points against `starters`' 126.1,
 * which inflates VORP for every keeper and forward on the board. The distortion
 * shows up in the squads — at twelve, `demand` starts 5 DEF and the minimum
 * 2 MID, despite its own numbers saying midfield is the deeper position.
 *
 * Below five the margins are small and the evidence is thinner: three is a
 * clear `starters` win (95-0), four is a coin flip at 0.04% of a squad total,
 * two is noise. They are grouped with `starters` because three says so and
 * four does not care. A two- or three-manager league is a degenerate draft
 * anyway — almost nothing is scarce, which is exactly the quantity `demand`
 * exists to measure.
 *
 * Reproduce with the head-to-head in scripts/test-draft.mjs, which runs this
 * comparison and fails if the rule stops matching the evidence.
 */
export const DEMAND_BASIS_SIZES = { min: 5, max: 9 };

/** @returns {'demand'|'starters'} */
export function replacementBasisForLeagueSize(leagueSize = LEAGUE_SIZE_DEFAULT) {
  const n = Number(leagueSize);
  if (!Number.isFinite(n)) return replacementBasisForLeagueSize(LEAGUE_SIZE_DEFAULT);
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
