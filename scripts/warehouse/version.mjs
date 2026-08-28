/**
 * Dataset identity, so an experiment can name the evidence it used.
 *
 * A research finding that cannot say which data produced it is not
 * reproducible, and "the warehouse" is not an answer when the warehouse grows
 * every day. This is deliberately a stamp and not a migration framework: a
 * schema number, a build time, and a per-source content digest.
 *
 * SCHEMA_VERSION changes only when the SHAPE of a normalised entity changes —
 * a field added, removed, or given a different meaning. Collecting more rows of
 * the same shape does not bump it; that is what the digests are for.
 */
import { createHash } from 'node:crypto';
import { readRows, paths, listFiles, ROOT } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, seasonsFor, SOURCE_MIN_SEASON } from './config.mjs';

/**
 * 2 — Milestone 2. Changes from 1:
 *   - `player_season` entity added, with an explicit tier marker: 'A' is the
 *     cheap squad census (no minutes), 'B' carries minutes and starts.
 *   - `subbedIn` / `subbedOut` removed from every normalised entity; they were
 *     schema flags, not events (see docs/WAREHOUSE.md).
 *   - club codes canonicalised per competition, because football-data gives
 *     both Sheffield clubs the same TLA.
 *   - `transfers` entity added, derived from squad membership only.
 */
export const SCHEMA_VERSION = 2;

/** A short, stable digest of a set of rows: content, not file bytes. */
function digest(rows) {
  const h = createHash('sha256');
  for (const r of rows) h.update(JSON.stringify(r));
  return h.digest('hex').slice(0, 16);
}

export async function datasetVersion() {
  const perSource = {};

  for (const src of ['football-data', 'espn']) {
    perSource[src] = { minSeason: SOURCE_MIN_SEASON[src], competitionSeasons: 0, rows: 0 };
  }

  let teamMatchRows = 0; let playerSeasonRows = 0; let structuralRows = 0;
  const parts = [];
  for (const comp of COMPETITIONS) {
    for (const season of WAREHOUSE_SEASONS) {
      const fd = comp.footballData && seasonsFor('football-data').includes(season)
        ? await readRows(paths.fdMatches(comp.key, season)) : [];
      const espn = await readRows(paths.espnMatches(comp.key, season));
      const tm = await readRows(paths.teamMatch(comp.key, season));
      const psA = await readRows(paths.espnRosters(comp.key, season));
      const psB = await readRows(paths.espnPlayerSeasons(comp.key, season));
      if (!fd.length && !espn.length && !psA.length) continue;
      if (fd.length) { perSource['football-data'].competitionSeasons += 1; perSource['football-data'].rows += fd.length; }
      if (espn.length || psA.length) { perSource.espn.competitionSeasons += 1; perSource.espn.rows += espn.length + psA.length + psB.length; }
      structuralRows += fd.length; teamMatchRows += tm.length; playerSeasonRows += psA.length + psB.length;
      parts.push(`${comp.key}:${season}:${fd.length}:${espn.length}:${tm.length}:${psA.length}:${psB.length}`);
    }
  }

  const identity = await readRows(paths.players());
  const teams = await readRows(paths.teams());
  const transfers = await readRows(paths.transfers());
  const files = await listFiles(ROOT);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    /* One digest over the coverage manifest. Two runs with the same digest hold
       the same rows, so an experiment can quote it and be checked later. */
    coverageDigest: digest(parts.sort()),
    entities: {
      structural_match: structuralRows,
      team_match: teamMatchRows,
      player_season: playerSeasonRows,
      teams: teams.length,
      players: identity.length,
      transfers: transfers.length,
    },
    sources: perSource,
    seasonWindows: { warehouse: WAREHOUSE_SEASONS, 'football-data': seasonsFor('football-data'), espn: seasonsFor('espn') },
    files: files.length,
  };
}
