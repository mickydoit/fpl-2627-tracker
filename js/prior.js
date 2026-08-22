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
export function hydrate(boot, prior, opts = {}) {
  if (!boot?.elements?.length || !prior?.players) return boot;
  const o = { ...PRIOR_DEFAULTS, ...opts };
  const lambda = o.lastSeasonWeight;
  if (!(lambda > 0)) return boot;

  const gamesThis = inferGamesPlayed(boot.elements);
  // The shared denominator every player's minutes are expressed against.
  const games = gamesThis + lambda * o.lastSeasonGames;

  const elements = boot.elements.map((e) => {
    const pr = prior.players[e.code];
    if (!pr) return e;

    const mThis = num(e.minutes);
    const mLast = num(pr.minutes);
    const wLast = lambda * mLast;
    const pooled = mThis + wLast;
    // Nothing on record in either season: leave the row exactly as it came.
    if (pooled <= 0) return e;

    /** Pooled per-90 rate for a counting stat. */
    const rate = (thisSeason, lastSeason) =>
      ((num(thisSeason) + lambda * num(lastSeason)) / pooled) * 90;

    // Minutes per game, pooled on the same weights, then put back on the shared
    // games basis so `minutes / ctx.games` recovers it.
    const mpgThis = gamesThis > 0 ? mThis / gamesThis : 0;
    const mpgLast = o.lastSeasonGames > 0 ? mLast / o.lastSeasonGames : 0;
    const mpg = clamp((mThis * mpgThis + wLast * mpgLast) / pooled, 0, 90);
    const minutes = mpg * games;

    const xg90 = rate(e.expected_goals, pr.expected_goals);
    const xa90 = rate(e.expected_assists, pr.expected_assists);
    // The model works from xG and xA separately, but the Players table shows the
    // combined rate — pooled from its own total rather than added, so it stays
    // whatever FPL means by it.
    const xgi90 = rate(e.expected_goal_involvements, pr.expected_goal_involvements);
    const xgc90 = rate(e.expected_goals_conceded, pr.expected_goals_conceded);
    const saves90 = rate(e.saves, pr.saves);
    const defcon90 = rate(e.defensive_contribution, pr.defensive_contribution);
    const bps90 = rate(e.bps, pr.bps);
    const yc90 = rate(e.yellow_cards, pr.yellow_cards);
    const cbi90 = rate(e.clearances_blocks_interceptions, pr.clearances_blocks_interceptions);
    const tkl90 = rate(e.tackles, pr.tackles);
    const rec90 = rate(e.recoveries, pr.recoveries);

    /* The model reads some stats as per-90 fields and rebuilds others from a
       count over `minutes`. Both have to agree with the minutes above, so the
       counts are written back from the pooled rate rather than carried over. */
    const count = (per90) => (per90 * minutes) / 90;

    return {
      ...e,
      /* `minutes` is deliberately left alone: it is what he actually played
         this season, it is what the Players table shows, and quietly replacing
         it with a blended figure would read as a bug in August. The model takes
         its playing time from `modelMinutes` instead. */
      modelMinutes: minutes,
      /* Minutes genuinely observed, which is a different question from how much
         he plays. `modelMinutes` is on the shared games basis so expected
         minutes come out right; using it to measure confidence would read one
         75-minute appearance by a player with no prior season as a fully
         evidenced regular. The price-prior blend runs on this figure. */
      evidenceMinutes: pooled,
      expected_goals_per_90: xg90,
      expected_assists_per_90: xa90,
      expected_goal_involvements_per_90: xgi90,
      expected_goals_conceded_per_90: xgc90,
      saves_per_90: saves90,
      defensive_contribution_per_90: defcon90,
      bps: count(bps90),
      yellow_cards: count(yc90),
      clearances_blocks_interceptions: count(cbi90),
      tackles: count(tkl90),
      recoveries: count(rec90),
      // Provenance, so a page can say where a number came from.
      priorBlend: { thisSeasonMinutes: mThis, lastSeasonMinutes: mLast, weight: lambda },
    };
  });

  return { ...boot, elements };
}
