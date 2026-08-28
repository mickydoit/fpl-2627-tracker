/**
 * Warehouse tests.
 *
 * Two things are being defended here, and the second matters more than the
 * first.
 *
 *   1. The warehouse stores what it says it stores: rows are unique, empty
 *      fetches never overwrite good data, identity is never guessed.
 *
 *   2. The warehouse cannot reach the projection. Every model change in this
 *      repository has to earn its way in through an evaluation, and a research
 *      dataset sitting on disk is the easiest possible way for that rule to be
 *      broken by accident — an import here, a convenience read there, and six
 *      seasons of unvalidated cross-league data are suddenly inside a live
 *      projection. So the isolation is asserted mechanically rather than
 *      remembered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeRows, readRows, mergeRows, stamp } from './warehouse/store.mjs';
import { isWarehouseSeason, assertWarehouseSeason, seasonsFor, COMPETITIONS, WAREHOUSE_SEASONS } from './warehouse/config.mjs';
import { canonicalTla, fixtureKey } from './warehouse/tla.mjs';
import { ALLOWED_MODEL_SEASONS } from '../js/seasons.js';

let checks = 0; let failures = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};
const TMP = process.env.TMPDIR ? `${process.env.TMPDIR}wh-test` : '/tmp/wh-test';
fs.mkdirSync(TMP, { recursive: true });

/* ------------------------------------------------------------------ *
 * isolation — the rule the rest of the programme rests on
 * ------------------------------------------------------------------ */
console.log('\nWarehouse isolation');
{
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
    }
    return out;
  };

  /* The browser bundle must not import research code, and must not read
     research data. Either would put six seasons of unvalidated cross-league
     evidence one refresh away from a live projection. */
  const browserFiles = walk('js');
  const importsWarehouse = browserFiles.filter((f) => /warehouse/.test(fs.readFileSync(f, 'utf8')));
  ok('no browser module references the warehouse', importsWarehouse.length === 0,
    importsWarehouse.join(', '));

  /* The production model pipeline is equally off limits. The warehouse scripts
     themselves obviously read it, and archive/evaluate must not. */
  const productionScripts = ['scripts/derive.mjs', 'scripts/fetch-all.mjs', 'scripts/archive-gameweek.mjs',
    'scripts/evaluate.mjs', 'scripts/fetch-espn-history.mjs', 'scripts/fetch-espn-matches.mjs',
    'scripts/build-identity.mjs', 'scripts/freeze-prior.mjs'];
  const leaks = productionScripts.filter((f) => fs.existsSync(f) && /data\/warehouse|warehouse\//.test(fs.readFileSync(f, 'utf8')));
  ok('no production script reads the warehouse', leaks.length === 0, leaks.join(', '));

  /* The two season windows are deliberately different sizes. If they were ever
     made equal, the warehouse would have silently become the model's evidence
     base rather than a research store. */
  ok('the warehouse window is wider than the model window',
    WAREHOUSE_SEASONS.length > ALLOWED_MODEL_SEASONS.length);
  ok('the model window is still exactly two seasons', ALLOWED_MODEL_SEASONS.length === 2);
  ok('warehouse seasons include seasons the model must never read',
    WAREHOUSE_SEASONS.some((y) => !ALLOWED_MODEL_SEASONS.includes(y)));
}

/* ------------------------------------------------------------------ *
 * season guards
 * ------------------------------------------------------------------ */
console.log('\nSeason guards');
{
  ok('a season inside the window is allowed', isWarehouseSeason(2024));
  ok('a season before the window is refused', !isWarehouseSeason(2015));
  ok('a non-integer season is refused', !isWarehouseSeason('banana'));
  let threw = false;
  try { assertWarehouseSeason(2015); } catch { threw = true; }
  ok('ingesting an out-of-window season throws rather than silently skipping', threw);

  /* Measured, not assumed: football-data answers 403 below 2023 and ESPN does
     not. Encoding it stops every run burning three retries per season. */
  ok('football-data floor reflects the measured 403 boundary', !seasonsFor('football-data').includes(2022));
  ok('ESPN reaches further back than football-data', seasonsFor('espn').includes(2021));
}

/* ------------------------------------------------------------------ *
 * storage contract
 * ------------------------------------------------------------------ */
console.log('\nStorage contract');
{
  const p = `${TMP}/a.ndjson.gz`;
  fs.rmSync(p, { force: true });
  const prov = { source: 'test', fetchedAt: '2026-08-28T00:00:00Z' };
  await writeRows(p, [stamp({ id: 1 }, prov), stamp({ id: 2 }, prov)]);
  ok('rows round-trip through gzipped NDJSON', (await readRows(p)).length === 2);

  const again = await writeRows(p, [stamp({ id: 1 }, prov), stamp({ id: 2 }, prov)]);
  ok('an identical write is a no-op, so a half-hourly job does not churn the repo',
    !again.written && again.reason === 'unchanged');

  /* The failure mode every fetcher in this repo is built to avoid. */
  const emptied = await writeRows(p, []);
  ok('an empty write over good data is refused', !emptied.written);
  ok('the good data survives the refused write', (await readRows(p)).length === 2);

  const merged = await mergeRows(p, [stamp({ id: 2, v: 'new' }, prov), stamp({ id: 3 }, prov)], (r) => r.id);
  ok('merge adds new rows', merged.added === 1);
  ok('merge updates existing rows rather than duplicating them', merged.updated === 1 && merged.total === 3);
  const after = await readRows(p);
  ok('a re-fetched row wins over the older copy', after.find((r) => r.id === 2).v === 'new');
  ok('merged rows stay unique by key', new Set(after.map((r) => r.id)).size === after.length);

  ok('a missing file reads as no rows, not as an error', (await readRows(`${TMP}/nope.ndjson.gz`)).length === 0);

  /* Provenance is not optional: a row that cannot say where it came from cannot
     be re-checked against its source later. */
  ok('every row carries its source', after.every((r) => r._src === 'test'));
  ok('every row carries a fetch timestamp', after.every((r) => r._at));
}

/* ------------------------------------------------------------------ *
 * club vocabulary
 * ------------------------------------------------------------------ */
console.log('\nClub vocabulary');
{
  ok('ESPN Manchester United maps onto FPL', canonicalTla('espn', 'MAN') === 'MUN');
  ok('football-data Nottingham Forest maps onto FPL', canonicalTla('football-data', 'NOT') === 'NFO');
  ok('a club both sources agree on is left alone', canonicalTla('espn', 'ARS') === 'ARS');
  ok('an unknown code passes through rather than being dropped', canonicalTla('espn', 'ZZZ') === 'ZZZ');
  ok('a null code does not become the string "null"', canonicalTla('espn', null) === null);

  /* The join this vocabulary exists for. Before it, these two fixtures failed
     to join and two of six matches were silently lost. */
  ok('the same fixture keys identically from either source',
    fixtureKey('espn', '2024-08-16', 'MAN', 'FUL') === fixtureKey('football-data', '2024-08-16', 'MUN', 'FUL'));
  ok('fixture keys do not depend on which club is listed first',
    fixtureKey('espn', '2024-08-16', 'FUL', 'MAN') === fixtureKey('espn', '2024-08-16', 'MAN', 'FUL'));
  ok('different days do not collide',
    fixtureKey('espn', '2024-08-16', 'ARS', 'CHE') !== fixtureKey('espn', '2024-08-17', 'ARS', 'CHE'));
}

/* ------------------------------------------------------------------ *
 * competition table
 * ------------------------------------------------------------------ */
console.log('\nCompetition table');
{
  ok('every competition has an ESPN slug', COMPETITIONS.every((c) => c.espn));
  ok('competition keys are unique', new Set(COMPETITIONS.map((c) => c.key)).size === COMPETITIONS.length);
  ok('ESPN slugs are unique', new Set(COMPETITIONS.map((c) => c.espn)).size === COMPETITIONS.length);
  const fd = COMPETITIONS.filter((c) => c.footballData).map((c) => c.footballData);
  ok('football-data codes are unique where present', new Set(fd).size === fd.length);
  ok('the Premier League is the target competition',
    COMPETITIONS.find((c) => c.key === 'eng.1')?.tier === 'target');
  ok('the Championship is a feeder, because promoted squads come through it',
    COMPETITIONS.find((c) => c.key === 'eng.2')?.tier === 'feeder');
  ok('at least one bridge competition exists for cross-league comparison',
    COMPETITIONS.some((c) => c.tier === 'bridge'));
}

/* ------------------------------------------------------------------ *
 * collected data, where any has been collected
 * ------------------------------------------------------------------ */
console.log('\nCollected data');
{
  const { paths: P } = await import('./warehouse/store.mjs');
  const players = await readRows(P.players());
  if (!players.length) {
    console.log('  – no identity built yet, skipping (run scripts/warehouse/build-identity.mjs)');
  } else {
    ok('no two FPL players claim the same football-data id', (() => {
      const seen = new Set();
      for (const p of players.filter((x) => x.footballDataId)) {
        if (seen.has(p.footballDataId)) return false;
        seen.add(p.footballDataId);
      }
      return true;
    })());
    ok('every mapped player agreed on date of birth',
      players.filter((p) => p.footballDataId).every((p) => p.dateOfBirth));
    ok('a mapping records how it was made', players.filter((p) => p.footballDataId).every((p) => p.method && p.confidence));
    ok('name-only agreement never produces a mapping',
      players.filter((p) => p.footballDataId).every((p) => p.method.startsWith('dob+')));
    ok('unmapped players are still present, carrying nulls rather than being dropped',
      players.some((p) => !p.footballDataId));
  }

  let tmRows = 0; let dupes = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      const rows = await readRows(P.teamMatch(c.key, s));
      tmRows += rows.length;
      const keys = rows.map((r) => `${r.espnEventId}:${r.espnTeamId}`);
      dupes += keys.length - new Set(keys).size;
    }
  }
  if (tmRows) {
    ok('no duplicate team-match rows', dupes === 0, `${dupes} duplicates`);
    ok('team-match rows exist to test', tmRows > 0);
  } else console.log('  – no team-match rows yet, skipping uniqueness check');
}

console.log(`\n${failures === 0 ? `✓ all ${checks} warehouse checks passed` : `✗ ${failures} of ${checks} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
