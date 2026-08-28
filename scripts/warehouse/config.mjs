/**
 * The warehouse's own boundaries, kept deliberately apart from js/seasons.js.
 *
 * ── Why this file exists at all ──
 *
 * js/seasons.js enforces a two-season window on everything the PROJECTION may
 * read, and that rule is not being relaxed. A player's output three seasons ago
 * describes a different player, and the model is right to refuse it.
 *
 * Research is the opposite problem. To ask "does a Bundesliga xG translate to
 * the Premier League" you need many seasons of players who made that move, and
 * one season of evidence answers nothing. So the warehouse keeps a wider window
 * — and keeps it HERE, in a constant the model cannot import by accident.
 *
 * The separation is enforced by a test: no file under js/ may import anything
 * under scripts/warehouse/, and no production model path may read
 * data/warehouse/. Research data earns its way into a projection by passing an
 * evaluation, never by being on disk.
 */

/** Seasons the warehouse may collect, by start year. 2021 means 2021/22. */
export const WAREHOUSE_SEASONS = [2021, 2022, 2023, 2024, 2025, 2026];

/** The warehouse's newest season, for defaulting incremental runs. */
export const CURRENT_WAREHOUSE_SEASON = 2026;

/**
 * How far back each source will actually go, measured against the live APIs
 * rather than taken from documentation.
 *
 * football-data.org's free tier serves 2023 onward and answers 403 for 2021 and
 * 2022 — checked on the Premier League, the Championship and LaLiga, so it is a
 * plan boundary and not a per-competition gap. ESPN has no such limit and
 * returned complete 380-match seasons for 2021 and 2022 on request.
 *
 * The two therefore have different depths, and that is a fact about the
 * warehouse rather than a bug in it: structure is available for four seasons,
 * performance for six.
 */
export const SOURCE_MIN_SEASON = {
  'football-data': 2023,
  espn: 2021,
};

/**
 * Competitions the warehouse tracks, and how each source names them.
 *
 * `espn` is the slug used by both ESPN hosts. `footballData` is the code used
 * by api.football-data.org, or null where the free tier does not carry it.
 * `tier` records what the competition is FOR, because it changes how much of a
 * request budget it deserves:
 *
 *   target   the competition we predict. Every row matters.
 *   feeder   competitions players transfer to the Premier League FROM. Needed
 *            for cross-league translation; per-match detail matters less than
 *            per-player season totals.
 *   bridge   European competitions where teams from different domestic leagues
 *            meet. The only direct evidence of relative league strength.
 */
export const COMPETITIONS = [
  { key: 'eng.1', name: 'Premier League',   espn: 'eng.1',          footballData: 'PL',  tier: 'target', matchesPerSeason: 380 },
  { key: 'eng.2', name: 'Championship',     espn: 'eng.2',          footballData: 'ELC', tier: 'feeder', matchesPerSeason: 557 },
  { key: 'esp.1', name: 'LaLiga',           espn: 'esp.1',          footballData: 'PD',  tier: 'feeder', matchesPerSeason: 380 },
  { key: 'ger.1', name: 'Bundesliga',       espn: 'ger.1',          footballData: 'BL1', tier: 'feeder', matchesPerSeason: 306 },
  { key: 'ita.1', name: 'Serie A',          espn: 'ita.1',          footballData: 'SA',  tier: 'feeder', matchesPerSeason: 380 },
  { key: 'fra.1', name: 'Ligue 1',          espn: 'fra.1',          footballData: 'FL1', tier: 'feeder', matchesPerSeason: 306 },
  { key: 'ned.1', name: 'Eredivisie',       espn: 'ned.1',          footballData: 'DED', tier: 'feeder', matchesPerSeason: 309 },
  { key: 'por.1', name: 'Primeira Liga',    espn: 'por.1',          footballData: 'PPL', tier: 'feeder', matchesPerSeason: 306 },
  { key: 'uefa.champions', name: 'UEFA Champions League', espn: 'uefa.champions', footballData: 'CL', tier: 'bridge', matchesPerSeason: 189 },
  { key: 'uefa.europa',    name: 'UEFA Europa League',    espn: 'uefa.europa',    footballData: null, tier: 'bridge', matchesPerSeason: 189 },
];

/** Seasons a given source can actually serve, within the warehouse window. */
export function seasonsFor(source, seasons = WAREHOUSE_SEASONS) {
  const floor = SOURCE_MIN_SEASON[source] ?? -Infinity;
  return seasons.filter((y) => y >= floor);
}

export const byKey = (k) => COMPETITIONS.find((c) => c.key === k) ?? null;
export const espnSlugs = () => COMPETITIONS.map((c) => c.espn);

/** Is this season inside the warehouse window? */
export function isWarehouseSeason(year) {
  const y = Number(year);
  return Number.isInteger(y) && WAREHOUSE_SEASONS.includes(y);
}

/**
 * Ingestion guard. Throws, so a caller that meant to collect 2018 hears about
 * it rather than quietly writing a season nothing downstream expects.
 */
export function assertWarehouseSeason(year, context = 'warehouse ingest') {
  if (!isWarehouseSeason(year)) {
    throw new Error(
      `${context}: season ${JSON.stringify(year)} is outside the warehouse window `
      + `[${WAREHOUSE_SEASONS.join(', ')}]`,
    );
  }
  return Number(year);
}

/**
 * Request budget per run.
 *
 * The binding constraint on this whole programme is not disk, it is politeness.
 * Measured: an ESPN team-match record costs 3 requests, a full player-match
 * record costs 43. Five seasons of all ten competitions is 49,530 requests at
 * the cheap tier and 709,930 at the expensive one. The second number is not a
 * thing anyone should do to an undocumented API, so the expensive tier is
 * always targeted and never a sweep.
 *
 * Backfill is therefore incremental and capped, exactly like the existing
 * match collector: a run does a slice, commits it, and the next run continues.
 */
export const BUDGET = {
  /** ESPN team-match records per run (3 requests each). */
  espnMatchesPerRun: Number(process.env.WAREHOUSE_ESPN_MATCHES || 120),
  /** ESPN player-season aggregate lookups per run (1 request each). */
  espnPlayerSeasonsPerRun: Number(process.env.WAREHOUSE_ESPN_PLAYERS || 150),
  /** football-data.org allows 10 requests/minute on the free tier. */
  footballDataPerMinute: 10,
};
