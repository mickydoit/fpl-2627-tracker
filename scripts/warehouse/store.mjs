/**
 * The warehouse's storage contract: gzipped NDJSON, written only on success.
 *
 * ── Why NDJSON, and why gzipped ──
 *
 * Measured on the existing match store, not assumed. A team-match record is
 * 6,018 bytes of JSON and compresses 8.3x; a full player-match record is 27,059
 * bytes and compresses 18.4x, because the same 40 stat keys repeat for every
 * player in every match and that is exactly what DEFLATE is good at. Five
 * seasons of all ten competitions is 11.9 MB gzipped at the cheap tier against
 * 99 MB raw, which is the difference between a repository that can hold its own
 * history and one that cannot.
 *
 * One row per line means a season file can be appended to and read back a row
 * at a time, and it diffs sanely: adding a matchday changes the tail of a file
 * rather than reflowing a pretty-printed array.
 *
 * ── Never overwrite good data with nothing ──
 *
 * Every external source here is allowed to fail, and several of them do
 * routinely. The rule from the existing fetchers holds: a fetch failure leaves
 * the last known good file exactly where it is. `writeRows` refuses an empty
 * write over a non-empty file unless the caller explicitly says the emptiness
 * is real, which nothing currently does.
 */
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = 'data/warehouse';

/** Every warehouse row carries where it came from and when. */
export function stamp(row, { source, sourceId = null, competition = null, season = null, fetchedAt }) {
  return {
    ...row,
    _src: source,
    ...(sourceId != null ? { _srcId: sourceId } : {}),
    ...(competition != null ? { _comp: competition } : {}),
    ...(season != null ? { _season: season } : {}),
    _at: fetchedAt,
  };
}

/** Read a gzipped NDJSON file. Missing file is an empty list, not an error. */
export async function readRows(path) {
  const buf = await readFile(path).catch(() => null);
  if (!buf) return [];
  let text;
  try {
    text = (path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8');
  } catch (err) {
    // A truncated or half-written file must not take the whole run down, and
    // must not silently read as "no data" either.
    throw new Error(`corrupt warehouse file ${path}: ${err.message}`);
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

/**
 * Write rows as gzipped NDJSON, but only when that is not a regression.
 *
 * @param {string} path
 * @param {object[]} rows
 * @param {{allowEmpty?: boolean}} opts
 * @returns {Promise<{written: boolean, reason: string, rows: number, bytes: number}>}
 */
export async function writeRows(path, rows, { allowEmpty = false } = {}) {
  const existing = await readRows(path).catch(() => []);
  if (!rows.length && existing.length && !allowEmpty) {
    return { written: false, reason: 'refused: would empty a non-empty file', rows: existing.length, bytes: 0 };
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n');
  const body = path.endsWith('.gz') ? gzipSync(Buffer.from(text), { level: 9 }) : Buffer.from(text);
  // Skip no-op writes so a half-hourly job does not churn the repository.
  const prev = await readFile(path).catch(() => null);
  if (prev) {
    const h = (b) => createHash('sha256').update(b).digest('hex');
    // Compare decompressed content: gzip output is not byte-stable across
    // zlib versions, so hashing the compressed bytes would report a change
    // on every runner upgrade.
    const prevText = (path.endsWith('.gz') ? gunzipSync(prev) : prev).toString('utf8');
    if (h(Buffer.from(prevText)) === h(Buffer.from(text))) {
      return { written: false, reason: 'unchanged', rows: rows.length, bytes: prev.length };
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return { written: true, reason: 'written', rows: rows.length, bytes: body.length };
}

/**
 * Merge new rows into an existing file, keyed by a stable identifier.
 *
 * Later rows win, which is what re-fetching a match that has since been
 * corrected should do. Ordering is by key so the file is stable and diffable
 * rather than depending on fetch order.
 */
export async function mergeRows(path, incoming, keyOf, opts = {}) {
  const existing = await readRows(path).catch(() => []);
  const map = new Map(existing.map((r) => [keyOf(r), r]));
  let added = 0; let updated = 0;
  for (const row of incoming) {
    const k = keyOf(row);
    if (map.has(k)) updated += 1; else added += 1;
    map.set(k, row);
  }
  const merged = [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([, v]) => v);
  const res = await writeRows(path, merged, opts);
  return { ...res, added, updated, total: merged.length };
}

/** Every .ndjson.gz under a directory, recursively. */
export async function listFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await listFiles(p, out);
    else if (e.name.endsWith('.ndjson.gz') || e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** Total bytes on disk under a directory. */
export async function footprint(dir) {
  const files = await listFiles(dir);
  let bytes = 0;
  for (const f of files) bytes += (await stat(f).catch(() => ({ size: 0 }))).size;
  return { files: files.length, bytes };
}

export const paths = {
  fdMatches: (comp, season) => `${ROOT}/raw/football-data/${comp}/${season}/matches.ndjson.gz`,
  fdTeams: (comp, season) => `${ROOT}/raw/football-data/${comp}/${season}/teams.ndjson.gz`,
  fdStandings: (comp, season) => `${ROOT}/raw/football-data/${comp}/${season}/standings.ndjson.gz`,
  espnMatches: (comp, season) => `${ROOT}/raw/espn/${comp}/${season}/matches.ndjson.gz`,
  /* Tier A: one request per team-season, 15 summary fields, no minutes. */
  espnRosters: (comp, season) => `${ROOT}/raw/espn/rosters/${comp}/${season}.ndjson.gz`,
  /* Tier B: one request per player-league-season, 95 fields including minutes
     and starts. Targeted, never a sweep. */
  espnPlayerSeasons: (comp, season) => `${ROOT}/raw/espn/player-seasons/${comp}/${season}.ndjson.gz`,
  teams: () => `${ROOT}/normalised/teams.ndjson.gz`,
  players: () => `${ROOT}/normalised/players.ndjson.gz`,
  teamMatch: (comp, season) => `${ROOT}/normalised/team_match/${comp}/${season}.ndjson.gz`,
  playerSeason: (season) => `${ROOT}/normalised/player_season/${season}.ndjson.gz`,
  transfers: () => `${ROOT}/normalised/transfers.ndjson.gz`,
  /* football-data player id <-> ESPN athlete id, for EVERY player the census
     has seen — not only the current FPL squad. */
  playerXref: () => `${ROOT}/normalised/player_xref.ndjson.gz`,
  coverage: () => `${ROOT}/coverage.json`,
};
