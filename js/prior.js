/**
 * Carry 2025/26 evidence into this season's projections.
 *
 * FPL zeroes every season total in bootstrap-static at the GW1 deadline. The
 * model reads those totals, so from that moment until a few gameweeks have
 * accumulated it has almost nothing to work with: on the morning of GW1 2026/27
 * it put 502 of 600 players on the price prior and ranked the league by cost.
 * The numbers still looked confident, which is the dangerous part.
 *
 * The evidence itself was never lost — scripts/freeze-prior.mjs captured it on
 * 17 Aug into data/draft/prior-2526.json, keyed by `code` because element ids
 * are not stable between games or seasons. That file is frozen and the refresh
 * workflow never rewrites it. It lives under data/draft/ for historical reasons
 * only; nothing in it is Draft-specific, it is simply last season.
 *
 * This module pools the two seasons and hands js/model.js a boot payload shaped
 * exactly like the one it already understands, so the model itself is unchanged
 * and every page benefits at once.
 *
 * ── Why pooling, and why it has to include minutes ──
 *
 * Rates are pooled by weight of evidence: last season's counts are discounted
 * by `lastSeasonWeight` and added to this season's, then divided by the pooled
 * minutes. This season therefore takes over on its own as it accumulates — no
 * gameweek threshold to cross, nothing to switch off later.
 *
 * Minutes cannot be left alone while the rates are pooled. The model derives
 * expected minutes as `minutes / ctx.games`, and ctx.games is inferred from the
 * busiest player's minutes. Pool the rates but not the minutes and every player
 * keeps a one-game denominator; pool the minutes without rescaling and
 * `inferGamesPlayed` reports 20 games while a player carries 90 — the model then
 * reads him as a 4.5-minute cameo.
 *
 * So minutes are rebuilt in minutes-per-game space, which is the quantity the
 * model actually wants, and multiplied back up by a single shared games figure.
 * Because every player is scaled by the same figure, `inferGamesPlayed` recovers
 * it exactly and the ratio each player needs survives.
 */
import { inferGamesPlayed } from './model.js';
import { isAllowedSeason, CURRENT_SEASON } from './seasons.js';

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const PRIOR_DEFAULTS = {
  /**
   * How much of last season to believe, per minute, relative to a minute played
   * this season. Squads, managers and roles all move over a summer, so a minute
   * from May is worth less than a minute from August — but not nothing, and at
   * one game played it is very nearly all the information there is.
   *
   * At 0.5 the two seasons carry equal weight around GW19, which is a
   * defensible place for last season to stop mattering more than this one.
   * Worth revisiting once there is a real season to fit against.
   */
  lastSeasonWeight: 0.5,
  /** Games in the season the prior was captured from. */
  lastSeasonGames: 38,
  /**
   * Below this much pooled Premier League evidence, ESPN's foreign season is
   * allowed to speak about a player's role. Above it, the Premier League has
   * already answered the question better and ESPN is ignored entirely.
   */
  espnAppliesBelowMinutes: 450,
};

/**
 * Pool one player's two seasons into the fields js/model.js reads.
 *
 * Extracted so there is exactly one implementation of the blend. `hydrate()`
 * uses it for the Classic bootstrap; scripts/fetch-draft.mjs uses it to build
 * the Draft board, which otherwise would have projected from a frozen 2025/26
 * snapshot for the whole season while Classic moved on.
 *
 * @param {object} current this season's counting stats (may be empty)
 * @param {object} prior   last season's, from prior-2526.json
 * @param {object} opts    gamesThis, games (the shared basis), and the weights
 * @returns {object|null}  model fields, or null when there is nothing on record
 */
export function poolPlayerSeasons(current, prior, { gamesThis, games, lastSeasonWeight, lastSeasonGames, priorSeason = CURRENT_SEASON - 1 }) {
  const lambda = lastSeasonWeight;
  /* The season boundary is enforced at the door. A prior labelled anything
     outside the window is dropped rather than blended — reaching further back
     to enlarge a thin sample is exactly what the rule forbids, and a caller
     that passes 2024/25 has a bug rather than a shortcut. */
  const priorUsable = prior && isAllowedSeason(priorSeason) ? prior : null;
  const mThis = num(current?.minutes);
  const mLast = num(priorUsable?.minutes);
  const wLast = lambda * mLast;
  const pooled = mThis + wLast;
  if (pooled <= 0) return null;

  const rate = (a, b) => ((num(a) + lambda * num(b)) / pooled) * 90;
  const pr = priorUsable;
  const mpgThis = gamesThis > 0 ? mThis / gamesThis : 0;
  const mpgLast = lastSeasonGames > 0 ? mLast / lastSeasonGames : 0;
  const mpg = clamp((mThis * mpgThis + wLast * mpgLast) / pooled, 0, 90);
  const minutes = mpg * games;
  const count = (per90) => (per90 * minutes) / 90;

  const xg90 = rate(current?.expected_goals, pr?.expected_goals);
  const xa90 = rate(current?.expected_assists, pr?.expected_assists);
  const bps90 = rate(current?.bps, pr?.bps);
  const yc90 = rate(current?.yellow_cards, pr?.yellow_cards);
  const cbi90 = rate(current?.clearances_blocks_interceptions, pr?.clearances_blocks_interceptions);
  const tkl90 = rate(current?.tackles, pr?.tackles);
  const rec90 = rate(current?.recoveries, pr?.recoveries);

  return {
    modelMinutes: minutes,
    evidenceMinutes: pooled,
    /* Role is observed sooner and more cheaply than production: every
       appearance reports minutes, while a shooting rate takes a season to mean
       anything. Same pooled minutes, but the model weighs it on its own scale. */
    minutesEvidenceMinutes: pooled,
    expected_goals_per_90: xg90,
    expected_assists_per_90: xa90,
    expected_goal_involvements_per_90: rate(current?.expected_goal_involvements, pr?.expected_goal_involvements),
    expected_goals_conceded_per_90: rate(current?.expected_goals_conceded, pr?.expected_goals_conceded),
    saves_per_90: rate(current?.saves, pr?.saves),
    defensive_contribution_per_90: rate(current?.defensive_contribution, pr?.defensive_contribution),
    bps: count(bps90),
    yellow_cards: count(yc90),
    clearances_blocks_interceptions: count(cbi90),
    tackles: count(tkl90),
    recoveries: count(rec90),
    priorBlend: { thisSeasonMinutes: mThis, lastSeasonMinutes: mLast, weight: lambda },
  };
}

/**
 * What a permitted ESPN 2025/26 season tells us about a player the Premier
 * League has never seen.
 *
 * Two very different questions, answered with very different confidence.
 *
 * **Minutes travel well.** A player who started thirty league games last season
 * is a first-team footballer wherever he did it; one with 1,000 minutes across
 * twenty-three appearances, eleven off the bench, is a substitute. That
 * distinction survives a change of league almost intact, and it is the single
 * most useful thing ESPN can tell us. It still earns less than Premier League
 * evidence, because a new club and a new manager are a real unknown — so the
 * transition discount lands on the CONFIDENCE, not on the minutes themselves.
 *
 * **Production does not travel well, and we cannot yet say by how much.** There
 * is no calibrated translation from a La Liga shooting rate to a Premier League
 * one, and inventing a multiplier would dress a guess as a measurement. So the
 * production signal is deliberately weak: it shifts the rate a little, shrunk
 * toward the generic prior by sample size, and mostly it just lowers certainty.
 * ESPN also publishes goals and assists rather than xG and xA, which are
 * noisier for the same sample — another reason to lean on it lightly.
 *
 * @param {object} record  a cached ESPN player record, already season-filtered
 * @param {number} pos     FPL element_type
 */
export function espnEvidence(record, pos) {
  const seasons = (record?.seasons || []).filter((x) => isAllowedSeason(x.season));
  if (!seasons.length) return null;

  // A winter move splits a season across two competitions; both count.
  const minutes = seasons.reduce((a, x) => a + num(x.minutes), 0);
  const apps = seasons.reduce((a, x) => a + num(x.appearances), 0);
  const starts = seasons.reduce((a, x) => a + num(x.starts), 0);
  const goals = seasons.reduce((a, x) => a + num(x.goals), 0);
  const assists = seasons.reduce((a, x) => a + num(x.assists), 0);
  if (!(minutes > 0) || !(apps > 0)) return null;

  /* Minutes per match, from the season he actually played. A 38-game basis
     rather than his own appearance count, because a player who appeared 20
     times in a 38-game season was not a 90-minute starter for that season —
     the games he missed are evidence too. */
  const mpg = clamp(minutes / PRIOR_DEFAULTS.lastSeasonGames, 0, 90);
  const startShare = apps > 0 ? starts / apps : 0;

  return {
    minutes,
    apps,
    starts,
    startShare,
    mpg,
    /* Role evidence, discounted for the league change. Two thirds: enough that
       a full foreign season outweighs a conservative guess, not so much that it
       rivals having actually seen him in this league. */
    minutesEvidence: minutes * ESPN_TRANSITION.minutesWeight,
    /* Attacking output per 90, in FPL points, before any shrinking. Goals and
       assists only — ESPN has no xG, and the defensive columns are too patchy
       across leagues to price. */
    attackingRate: ((goals * (GOAL_POINTS[pos] ?? 4)) + assists * 3) / minutes * 90,
    /* Zero, deliberately, and it took a diagnostic to see why.
     *
     * Production confidence measures how far to trust the MODELLED rate. ESPN
     * does not supply one — there is no xG or xA in it, and converting foreign
     * goals into a Premier League rate is precisely the unvalidated translation
     * we are not doing yet. So the modelled rate for these players is empty.
     * Raising confidence in an empty estimate does not add information, it
     * removes it: it shifts weight off the generic prior and onto zero, and a
     * new signing with a strong foreign season ends up projecting BELOW one
     * with no history at all.
     *
     * So ESPN speaks to opportunity, where it genuinely knows something, and
     * stays silent on production, where it does not. The prior keeps answering
     * "how productive" until this league answers it. When a calibrated league
     * translation exists, this is where it will attach. */
    productionEvidence: 0,
    competitions: seasons.map((x) => `${x.competition} ${x.season}`),
  };
}

/** Mirrors DEFAULTS.priorBlendMinutes in js/model.js — the minutes at which
 *  production evidence is trusted completely. */
const PRODUCTION_FULL_CONFIDENCE_MINUTES = 900;

/** FPL goal values, for turning ESPN goals into something comparable. */
const GOAL_POINTS = { 1: 10, 2: 6, 3: 5, 4: 4 };

export const ESPN_TRANSITION = {
  /**
   * How much a foreign minute counts as role evidence against a Premier League
   * one. Minutes describe selection, which is largely a property of the player.
   */
  minutesWeight: 0.65,
  /**
   * And how much it counts as PRODUCTION evidence. Far lower, because the rate
   * itself may not survive the move and we have no calibration that says by how
   * much. This is uncertainty, expressed as weight, rather than an invented
   * conversion factor.
   */
  productionWeight: 0.25,
  /**
   * And a ceiling on it, as a share of the evidence needed for full confidence.
   *
   * Without this the discount is defeated by volume: an ever-present
   * Championship season is 4,140 minutes, and a quarter of that clears the
   * threshold outright, so a player the Premier League has never seen would be
   * treated as fully understood. A foreign season can be substantial evidence.
   * It cannot be conclusive evidence, however many minutes it contains, because
   * the open question is the league change rather than the sample size.
   */
  productionCeiling: 0.6,
};

/**
 * Rebuild a bootstrap payload with last season pooled in.
 *
 * Pure: neither argument is mutated. Returns the input unchanged when there is
 * no prior to apply, so callers can pass a missing snapshot straight through.
 *
 * @param {object} boot   live bootstrap-static
 * @param {object} prior  data/draft/prior-2526.json, or null
 * @returns {object} a boot payload js/model.js can consume as-is
 */
export function hydrate(boot, prior, opts = {}, espnHistory = null) {
  if (!boot?.elements?.length || !prior?.players) return boot;
  const o = { ...PRIOR_DEFAULTS, ...opts };
  const lambda = o.lastSeasonWeight;
  if (!(lambda > 0)) return boot;

  const gamesThis = inferGamesPlayed(boot.elements);
  // The shared denominator every player's minutes are expressed against.
  const games = gamesThis + lambda * o.lastSeasonGames;
  /* The frozen file states which season it holds. Read it rather than assume
     it, so a prior rebuilt from a different season cannot slip in unnoticed. */
  const priorSeason = prior.season ?? null;
  if (!isAllowedSeason(priorSeason)) {
    // Outside the window: project from this season alone rather than blending
    // something stale. Returning the payload untouched is the honest failure.
    return boot;
  }

  const elements = boot.elements.map((e) => {
    const pr = prior.players[e.code];
    if (!pr) return e;
    const pooled = poolPlayerSeasons(e, pr, {
      gamesThis, games, lastSeasonWeight: lambda, lastSeasonGames: o.lastSeasonGames, priorSeason,
    });

    /* Tier 3. Only for players the Premier League cannot describe: anyone with
       real FPL evidence already has better data than ESPN can offer, and FPL
       stays authoritative wherever the two overlap. */
    const espn = espnHistory?.players?.[e.code]
      ? espnEvidence(espnHistory.players[e.code], e.element_type)
      : null;
    const thinHere = !pooled || pooled.evidenceMinutes < o.espnAppliesBelowMinutes;

    if (!pooled) {
      if (!espn || !thinHere) return e;
      /* No FPL record at all. ESPN supplies the role, and only the role — the
         production prior stays where it was, carrying its own low confidence. */
      return {
        ...e,
        modelMinutes: espn.mpg * games,
        minutesEvidenceMinutes: espn.minutesEvidence,
        /* Deliberately NOT zero, and deliberately not the role figure either.
           Zero would make the model fall back to `modelMinutes` for confidence,
           which ESPN has just inflated — the player would be treated as fully
           understood on the strength of minutes he played in another country.
           This is the weak production evidence a foreign season really is. */
        evidenceMinutes: Math.max(1, espn.productionEvidence),
        espn: { ...espn, applied: 'minutes' },
      };
    }
    if (espn && thinHere) {
      /* Some FPL record, but not enough to describe a role. Take whichever
         source has more to say about selection, rather than averaging a
         90-minute cameo against a full foreign season. */
      const espnMpgMinutes = espn.mpg * games;
      if (espn.minutesEvidence > (pooled.minutesEvidenceMinutes ?? 0)) {
        return {
          ...e,
          ...pooled,
          modelMinutes: espnMpgMinutes,
          minutesEvidenceMinutes: espn.minutesEvidence,
          // Production confidence is whatever the Premier League actually saw,
          // plus a little for the foreign season. Never the role figure.
          evidenceMinutes: Math.max(pooled.evidenceMinutes, espn.productionEvidence),
          espn: { ...espn, applied: 'minutes' },
        };
      }
      return { ...e, ...pooled, espn: { ...espn, applied: 'none' } };
    }
    // Nothing on record in either season: leave the row exactly as it came.
    if (!pooled) return e;
    /* `minutes` is deliberately left alone: it is what he actually played this
       season, it is what the Players table shows, and quietly replacing it with
       a blended figure would read as a bug in August. The model takes its
       playing time from `modelMinutes` and its confidence from
       `evidenceMinutes`, both of which poolPlayerSeasons supplies. */
    return { ...e, ...pooled };
  });

  return { ...boot, elements };
}
