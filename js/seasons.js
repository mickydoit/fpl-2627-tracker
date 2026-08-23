/**
 * The season boundary, in one place.
 *
 * The projection model may read football performance data from the current
 * season and the one before it, and from nothing older. Not a preference — a
 * rule, because a player's output three seasons ago describes a different
 * player: different age, role, manager, system, league and teammates. Recency
 * beats sample size, and a thin recent sample is handled by lowering confidence
 * rather than by reaching further back.
 *
 * Everything that ingests evidence goes through here — FPL frozen priors, ESPN
 * enrichment, evidence pooling, production priors, minutes priors — so the rule
 * is enforced at the door rather than remembered in a dozen call sites.
 *
 * ── Canonical identifier ──
 *
 * A season is named by the calendar year it STARTS in. 2025 means 2025/26.
 * That is ESPN's own convention, verified against its season metadata rather
 * than assumed:
 *
 *   eng.1/seasons/2025 -> "2025-26 English Premier League", 2025-06-01 to 2026-06-01
 *   eng.1/seasons/2026 -> "2026-27 English Premier League", 2026-06-01 to 2027-06-01
 *   esp.1/seasons/2025 -> "2025-26 Spanish LALIGA"
 *
 * FPL has no season field on its payloads at all: `bootstrap-static` simply
 * holds whatever the current season is, and data/draft/prior-2526.json carries
 * an explicit `season: '2025/26'` label. Both map onto the same start-year
 * space through `seasonStartYear()`.
 */

/** Current season, by start year. 2026 is 2026/27. */
export const CURRENT_SEASON = 2026;

/** The only seasons whose performance data may reach a projection. */
export const ALLOWED_MODEL_SEASONS = [CURRENT_SEASON - 1, CURRENT_SEASON];

/**
 * Normalise the season labels this project actually encounters into a start
 * year. Accepts 2025, '2025', '2025/26', '2025-26', '2025/2026'.
 *
 * @returns {number|null} start year, or null when it cannot be read
 */
export function seasonStartYear(label) {
  if (label == null) return null;
  if (typeof label === 'number') return Number.isInteger(label) ? label : null;
  const m = String(label).trim().match(/^(\d{4})(?:\s*[/-]\s*(\d{2,4}))?$/);
  if (!m) return null;
  const start = Number(m[1]);
  if (!Number.isInteger(start)) return null;
  // '2025/26' and '2025-2026' both start in 2025; a bare '2025' does too.
  return start;
}

/** Is this season's performance data allowed into the model? */
export function isAllowedSeason(label) {
  const y = seasonStartYear(label);
  return y != null && ALLOWED_MODEL_SEASONS.includes(y);
}

/**
 * Ingestion guard. Throws rather than returning false, because silently
 * dropping a season at the door is how stale data creeps back in later: a
 * caller that meant to write 2024/25 has a bug, and should hear about it.
 */
export function assertAllowedSeason(label, context = 'evidence') {
  if (!isAllowedSeason(label)) {
    throw new Error(
      `${context}: season ${JSON.stringify(label)} is outside the model window `
      + `[${ALLOWED_MODEL_SEASONS.join(', ')}]. Older evidence must not enter projections — `
      + 'use a conservative prior instead of reaching further back.',
    );
  }
  return seasonStartYear(label);
}

/**
 * Filter a list of records down to permitted seasons.
 *
 * For discovery lists, where an endpoint unavoidably reports every season it
 * knows about. Discovery may see them; ingestion may not keep them.
 */
export function onlyAllowedSeasons(records, getSeason = (r) => r.season) {
  return (records || []).filter((r) => isAllowedSeason(getSeason(r)));
}
