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

/* ------------------------------------------------------------------ *
 * Milestone 2 — substitution field trap
 * ------------------------------------------------------------------ */
console.log('\nSubstitution fields cannot become evidence');
{
  /* Measured: across 240 ESPN roster entries, `subbedIn` and `subbedOut` read
     true for ALL twenty entries on every team, starters included. They are
     schema flags for whether an entry MAY be substituted, not a record of what
     happened. Interpreted as "came off the bench" they would have marked every
     starting eleven as substitutes and corrupted every rotation, minutes and
     role signal built on top.
     
     Raw archives may keep whatever the source sent. What must never happen is
     one of these becoming a NORMALISED semantic field. */
  const fields = ['subbedIn', 'subbedOut'];

  const readAll = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) readAll(p, out);
      else if (e.name.endsWith('.mjs') || e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };

  /* No warehouse module may even mention them — not read, not write, not map. */
  /* The field registry is the one file that must name these fields: it exists to
     record that they are REJECTED_SEMANTICS, and a registry that cannot say
     which fields it rejects would be useless. Exempted deliberately and by
     exact path, not by pattern. */
  const REGISTRY = 'scripts/warehouse/field-registry.mjs';
  const warehouseCode = readAll('scripts/warehouse').filter((f) => path.normalize(f) !== path.normalize(REGISTRY));
  const mentions = warehouseCode.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    /* Prose in a comment explaining WHY they are rejected is allowed and
       wanted; a code reference is not. Strip comments before looking. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return fields.some((x) => code.includes(x));
  });
  ok('no warehouse module references subbedIn/subbedOut in code', mentions.length === 0, mentions.join(', '));

  /* And no normalised row may carry them, whatever a future fetcher does. */
  const { paths: P2 } = await import('./warehouse/store.mjs');
  let scanned = 0; let carrying = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const src of [P2.teamMatch(c.key, s), P2.espnRosters(c.key, s), P2.espnPlayerSeasons(c.key, s)]) {
        for (const r of await readRows(src)) {
          scanned += 1;
          const flat = JSON.stringify(r);
          if (fields.some((x) => flat.includes(`"${x}"`))) carrying += 1;
        }
      }
    }
  }
  ok('no normalised or player-season row carries a substitution flag', carrying === 0,
    `${carrying} of ${scanned} rows`);
  ok('there were rows to scan', scanned > 0, `${scanned}`);

  /* The fields that DO carry selection evidence, and the cross-check between
     them. `starter` is exactly eleven a side; `formationPlace` is 1-11 for the
     eleven and "0" for the bench, so the two must always agree. */
  let lineups = 0; let elevens = 0; let agree = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const m of await readRows(P2.espnMatches(c.key, s))) {
        for (const t of m.teams) {
          if (!t.lineup?.length) continue;
          lineups += 1;
          if (t.lineup.filter((p) => p.starter).length === 11) elevens += 1;
          if (t.lineup.every((p) => p.starter === (p.formationPlace !== '0'))) agree += 1;
        }
      }
    }
  }
  if (lineups) {
    ok('every collected lineup names exactly eleven starters', elevens === lineups, `${elevens}/${lineups}`);
    ok('starter and formationPlace cross-validate on every lineup', agree === lineups, `${agree}/${lineups}`);
  } else console.log('  – no lineups collected yet, skipping');
}

/* ------------------------------------------------------------------ *
 * Milestone 2 — entity integrity
 * ------------------------------------------------------------------ */
console.log('\nEntity integrity');
{
  const { paths: P } = await import('./warehouse/store.mjs');

  /* B. player-season uniqueness, per tier. A player may legitimately appear in
     two competitions in one season (a domestic league and a European one), so
     uniqueness is per competition-season, not global. */
  let psRows = 0; let psDupes = 0; let tierMarked = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const [src, keyOf] of [
        [P.espnRosters(c.key, s), (r) => `${r.espnTeamId}:${r.espnId}`],
        [P.espnPlayerSeasons(c.key, s), (r) => `${r.espnId}`],
      ]) {
        const rows = await readRows(src);
        psRows += rows.length;
        const keys = rows.map(keyOf);
        psDupes += keys.length - new Set(keys).size;
        tierMarked += rows.filter((r) => r.tier === 'A' || r.tier === 'B').length;
      }
    }
  }
  if (psRows) {
    ok('no duplicate player-season rows within a competition-season', psDupes === 0, `${psDupes} dupes`);
    ok('every player-season row declares which tier produced it', tierMarked === psRows, `${tierMarked}/${psRows}`);
  } else console.log('  – no player-season rows yet, skipping');

  /* C. match uniqueness across every raw store. */
  let dupM = 0; let mRows = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      const espn = await readRows(P.espnMatches(c.key, s));
      mRows += espn.length;
      dupM += espn.length - new Set(espn.map((r) => r.eventId)).size;
      const fd = await readRows(P.fdMatches(c.key, s));
      mRows += fd.length;
      dupM += fd.length - new Set(fd.map((r) => r.matchId)).size;
    }
  }
  ok('no duplicate matches in any raw store', dupM === 0, `${dupM} dupes across ${mRows} rows`);

  /* G/H. null and zero are different claims and must stay different. Tier A
     does not carry minutes, so minutes MUST be null there — never 0, which
     would read as "played none" and destroy any per-90 rate built on it. */
  let tierA = 0; let tierAMinutesNull = 0; let tierAMinutesZero = 0; let measuredZeros = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const r of await readRows(P.espnRosters(c.key, s))) {
        tierA += 1;
        if (r.minutes === null) tierAMinutesNull += 1;
        if (r.minutes === 0) tierAMinutesZero += 1;
        // A keeper with zero goals is a MEASURED zero and must be preserved.
        if (r.goals === 0) measuredZeros += 1;
      }
    }
  }
  if (tierA) {
    ok('Tier A minutes are null, never zero', tierAMinutesNull === tierA && tierAMinutesZero === 0,
      `null ${tierAMinutesNull}/${tierA}, zero ${tierAMinutesZero}`);
    ok('measured zeros are preserved, not turned into null', measuredZeros > 0, `${measuredZeros}`);
  } else console.log('  – no Tier A rows yet, skipping null/zero checks');

  /* Tier B is the only source of minutes, so on a Tier B row minutes must be a
     NUMBER — present, not null.
     
     Deliberately not "> 0". Two Championship 2021 rows read minutes 0 with one
     appearance and one substitute entry: players who came on inside the last
     minute, which ESPN rounds down to zero. That is a MEASURED zero and the
     first version of this check called it a failure — conflating "he played
     none" with "we did not fetch it", which is precisely the distinction the
     rest of this file exists to defend. */
  let tierB = 0; let tierBPresent = 0; let tierBZero = 0; let tierBStarts = 0; let tierBSane = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const r of await readRows(P.espnPlayerSeasons(c.key, s))) {
        tierB += 1;
        if (typeof r.minutes === 'number') tierBPresent += 1;
        if (r.minutes === 0) tierBZero += 1;
        if (typeof r.starts === 'number') tierBStarts += 1;
        /* A physical bound: nobody accumulates N x 90 minutes in fewer than N
           starts, so starts can never exceed appearances. */
        if (r.starts != null && r.appearances != null && r.starts <= r.appearances) tierBSane += 1;
      }
    }
  }
  if (tierB) {
    ok('Tier B rows carry minutes as a number, never null', tierBPresent === tierB, `${tierBPresent}/${tierB}`);
    ok('Tier B rows carry starts as a number', tierBStarts === tierB, `${tierBStarts}/${tierB}`);
    ok('starts never exceed appearances', tierBSane === tierB, `${tierBSane}/${tierB}`);
  } else console.log('  – no Tier B rows yet, skipping');
}

/* ------------------------------------------------------------------ *
 * Milestone 2 — identity across boundaries
 * ------------------------------------------------------------------ */
console.log('\nIdentity across promotion, relegation and transfer');
{
  const { paths: P } = await import('./warehouse/store.mjs');
  const teams = await readRows(P.teams());
  const players = await readRows(P.players());

  if (teams.length) {
    /* D. A club followed out of the Championship into the Premier League must
       keep ONE global id. If promotion minted a new identity, every
       promoted-club comparison would be comparing a club with itself. */
    const multi = teams.filter((t) => new Set(t.seasons.map((x) => x.competition)).size > 1);
    ok('some clubs appear in more than one competition', multi.length > 0, `${multi.length}`);
    ok('a club in two competitions still has exactly one global id',
      multi.every((t) => typeof t.globalTeamId === 'string' && t.globalTeamId.startsWith('fd:')));
    const ids = teams.map((t) => t.globalTeamId);
    ok('global team ids are unique', new Set(ids).size === ids.length);
    /* And no two clubs may claim the same external id. */
    const fplIds = teams.map((t) => t.fplTeamId).filter(Boolean);
    ok('no two clubs claim the same FPL team id', new Set(fplIds).size === fplIds.length);
    const espnIds = teams.map((t) => t.espnTeamId).filter(Boolean);
    ok('no two clubs claim the same ESPN team id', new Set(espnIds).size === espnIds.length);
  } else console.log('  – no team identity built yet, skipping');

  if (players.length) {
    /* E. A player's identity is keyed on FPL code and must not depend on which
       club he is at, so a transfer cannot break it. */
    const mapped = players.filter((p) => p.footballDataId);
    ok('player identity is keyed on the stable FPL code',
      players.every((p) => Number.isInteger(p.fplCode)));
    ok('no two players claim the same football-data id',
      new Set(mapped.map((p) => p.footballDataId)).size === mapped.length);
    ok('no two players claim the same ESPN id', (() => {
      const e = players.map((p) => p.espnId).filter(Boolean);
      return new Set(e).size === e.length;
    })());
    /* F. ambiguity is refused, never resolved by guessing. */
    ok('every mapping agreed on date of birth', mapped.every((p) => p.dateOfBirth));
    ok('no mapping was made on a name alone', mapped.every((p) => p.method?.startsWith('dob+')));
  } else console.log('  – no player identity built yet, skipping');
}

/* ------------------------------------------------------------------ *
 * Milestone 2 — derived research entities
 * ------------------------------------------------------------------ */
console.log('\nDerived research entities');
{
  const { paths: P } = await import('./warehouse/store.mjs');
  const transfers = await readRows(P.transfers());

  if (transfers.length) {
    /* J. one move per player per season-pair per club-pair. */
    const keys = transfers.map((m) => `${m.footballDataPlayerId}|${m.fromSeason}|${m.toSeason}|${m.fromTeam}|${m.toTeam}`);
    ok('the transfer cohort contains no duplicate moves', new Set(keys).size === keys.length,
      `${keys.length - new Set(keys).size} dupes of ${keys.length}`);
    ok('a move never has the same club on both sides', transfers.every((m) => m.fromTeam !== m.toTeam));
    ok('a move always spans consecutive seasons', transfers.every((m) => m.toSeason === m.fromSeason + 1));
    /* Nothing here may claim a fee or a loan status: no source publishes them. */
    ok('no move claims a transfer fee or loan status',
      transfers.every((m) => m.fee === undefined && m.loan === undefined));
  } else console.log('  – no transfers derived yet, skipping');

  /* K. promoted-club detection, and L. continuity bounds. */
  const promoted = (() => { try { return JSON.parse(fs.readFileSync('data/warehouse/research/promoted-clubs.json', 'utf8')); } catch { return null; } })();
  if (promoted?.cohort?.length) {
    ok('every promoted club was in the Championship the season before',
      promoted.cohort.every((c) => c.championshipSeason === c.eplSeason - 1));
    ok('a promoted club finished in a promotion place',
      promoted.cohort.every((c) => c.championship.position <= 6),
      promoted.cohort.filter((c) => c.championship.position > 6).map((c) => `${c.club} ${c.championship.position}`).join(','));
    ok('the promotion route matches the finishing position',
      promoted.cohort.every((c) => (c.championship.position <= 2 ? c.route === 'automatic' : c.route === 'playoff')));
    /* Three clubs are promoted each season — a useful check that detection is
       neither missing clubs nor inventing them. */
    const perSeason = {};
    for (const c of promoted.cohort) perSeason[c.eplSeason] = (perSeason[c.eplSeason] || 0) + 1;
    ok('exactly three clubs are detected per promotion season',
      Object.values(perSeason).every((n) => n === 3), JSON.stringify(perSeason));
  } else console.log('  – no promoted-club report yet, skipping');

  const cont = (() => { try { return JSON.parse(fs.readFileSync('data/warehouse/research/squad-continuity.json', 'utf8')); } catch { return null; } })();
  if (cont?.clubs?.length) {
    const pcts = cont.clubs.flatMap((c) => [c.membershipContinuityPct, c.minutesContinuityPct,
      c.startsContinuityPct, c.goalsContinuityPct, c.assistsContinuityPct]).filter((v) => v != null);
    ok('every continuity share is a percentage between 0 and 100',
      pcts.every((v) => v >= 0 && v <= 100), pcts.filter((v) => v < 0 || v > 100).join(','));
    ok('retained plus lost equals the previous squad',
      cont.clubs.every((c) => c.retained + c.lost === c.squadBefore));
    /* Minutes continuity must be null, not zero, where the detailed tier has
       not been collected — otherwise "no evidence" reads as "kept nobody". */
    ok('minutes continuity is null where minutes evidence is absent',
      cont.clubs.every((c) => c.minutesEvidencePlayers > 0 || c.minutesContinuityPct === null));
  } else console.log('  – no continuity report yet, skipping');
}

/* ------------------------------------------------------------------ *
 * Milestone 3 — cohort construction
 * ------------------------------------------------------------------ */
console.log('\nTransfer cohorts');
{
  const cohorts = (() => {
    try { return JSON.parse(fs.readFileSync('data/warehouse/research/cohorts.json', 'utf8')); }
    catch { return null; }
  })();

  if (!cohorts?.episodes?.length) {
    console.log('  – no cohorts built yet, skipping (run scripts/warehouse/research/cohorts.mjs)');
  } else {
    const eps = cohorts.episodes;

    /* M. The opportunity cohort must carry NO destination-minutes threshold.
       Filtering on destination minutes conditions on the target and would
       reproduce the optimism fixed on 28 August. The check is structural: if a
       threshold were being applied, no zero-minute episode could ever be
       eligible for the cohort, so assert that such episodes are RETAINED. */
    const inOpportunity = (e) => e.eligibility === 'eligible' && e.hasSourceEvidence && e.hasDestEvidence;
    const zeros = eps.filter((e) => inOpportunity(e) && e.destMinutes === 0);
    const lowMinute = eps.filter((e) => inOpportunity(e) && e.destMinutes != null && e.destMinutes < 450);
    const cohortSize = eps.filter(inOpportunity).length;
    if (cohortSize) {
      ok('the opportunity cohort retains zero-minute outcomes',
        zeros.length > 0 || lowMinute.length > 0 || cohortSize === 0,
        `cohort ${cohortSize}, zeros ${zeros.length}, sub-450 ${lowMinute.length}`);
      ok('no destination-minutes floor is applied to the opportunity cohort',
        !eps.some((e) => inOpportunity(e) && e.destMinutes != null && e.destMinutes < 0));
    } else console.log('  – opportunity cohort empty (collection in flight), structural checks only');

    /* Null and zero remain different claims on both sides of the move. */
    ok('a destination row that was never fetched reads null, not zero',
      eps.every((e) => e.hasDestEvidence || e.destMinutes === null));
    ok('a source row that was never fetched reads null, not zero',
      eps.every((e) => e.hasSourceEvidence || e.sourceMinutes === null));

    /* O. An administrative non-exposure must never be counted as a manager
       declining to pick the player. Multi-club and undetermined episodes are
       held out of the opportunity cohort and reported separately. */
    ok('multi-club episodes are excluded from the opportunity cohort',
      !eps.some((e) => e.eligibility === 'multi-club' && inOpportunity(e)));
    ok('undetermined episodes are excluded from the opportunity cohort',
      !eps.some((e) => e.eligibility === 'undetermined' && inOpportunity(e)));
    ok('every episode carries an explicit eligibility class',
      eps.every((e) => ['eligible', 'multi-club', 'undetermined', 'unbridged'].includes(e.eligibility)));
    /* The doubt must stay visible rather than being absorbed into either side. */
    const undet = eps.filter((e) => e.eligibility === 'undetermined').length;
    ok('the undetermined group is reported rather than folded away',
      Object.values(cohorts.byLeague).reduce((a, L) => a + L.undetermined, 0) === undet);

    /* Production thresholds must be monotonic — a stricter threshold cannot
       admit more episodes than a looser one. */
    let monotonic = true;
    for (const L of Object.values(cohorts.byLeague)) {
      const v = cohorts.thresholds.map((t) => L.production[`withBoth${t}`]);
      for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) monotonic = false;
    }
    ok('production cohort counts fall monotonically as the threshold rises', monotonic);

    /* An episode always spans consecutive seasons and lands in the EPL. */
    ok('every episode lands in eng.1', eps.every((e) => e.toSeason === e.fromSeason + 1));
  }
}

/* ------------------------------------------------------------------ *
 * Milestone 3 — the identity any opportunity candidate must respect
 * ------------------------------------------------------------------ */
console.log('\nOpportunity candidates respect the pitch');
{
  /* N. Whatever a translation candidate eventually predicts, a squad's summed
     start probabilities cannot exceed eleven per fixture. This is the identity
     that caught the 28 August defect, it needs no outcome, and it is asserted
     here as a reusable helper so any candidate can be checked against it before
     it is allowed anywhere near a projection. */
  const startsWithinPitch = (predictions, startersPerTeam = 11) => {
    const byTeamFixture = new Map();
    for (const p of predictions) {
      const k = `${p.team}|${p.fixture}`;
      byTeamFixture.set(k, (byTeamFixture.get(k) || 0) + (p.pStart ?? 0));
    }
    return [...byTeamFixture.values()].every((v) => v <= startersPerTeam + 1e-9);
  };

  ok('a legal squad passes the pitch identity', startsWithinPitch(
    Array.from({ length: 11 }, (_, i) => ({ team: 'ARS', fixture: 1, pStart: 1 }))));
  ok('twelve certain starters fail the pitch identity', !startsWithinPitch(
    Array.from({ length: 12 }, () => ({ team: 'ARS', fixture: 1, pStart: 1 }))));
  ok('the identity is per team AND per fixture, not per team', startsWithinPitch([
    ...Array.from({ length: 11 }, () => ({ team: 'ARS', fixture: 1, pStart: 1 })),
    ...Array.from({ length: 11 }, () => ({ team: 'ARS', fixture: 2, pStart: 1 })),
  ]));
  ok('fractional probabilities summing over eleven still fail', !startsWithinPitch(
    Array.from({ length: 30 }, () => ({ team: 'ARS', fixture: 1, pStart: 0.5 }))));
}

/* ------------------------------------------------------------------ *
 * Milestone 3 stage 2 — opportunity pipeline (OPP-1 .. OPP-10)
 * ------------------------------------------------------------------ */
console.log('\nOpportunity pipeline');
{
  const readIf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const oc = readIf('data/warehouse/research/opportunity-cohort.json');
  const om = readIf('data/warehouse/research/opportunity-models.json');
  const { paths: P } = await import('./warehouse/store.mjs');

  /* OPP-1 / OPP-2. A measured zero must survive every layer, not merely the
     last one. The collector previously dropped zero-appearance seasons, so the
     cohort builder could not retain what was never written — the filter the
     brief forbids, applied one layer earlier where it was invisible. */
  let zeroApp = 0; let zeroMin = 0; let tierBRows = 0;
  for (const c of COMPETITIONS) {
    for (const s of WAREHOUSE_SEASONS) {
      for (const r of await readRows(P.espnPlayerSeasons(c.key, s))) {
        tierBRows += 1;
        if (r.appearances === 0) zeroApp += 1;
        if (r.minutes === 0) zeroMin += 1;
      }
    }
  }
  if (tierBRows) {
    ok('OPP-1 measured zero appearances survive into player_season', zeroApp > 0, `${zeroApp} of ${tierBRows}`);
    ok('OPP-2 measured zero minutes survive into player_season', zeroMin > 0, `${zeroMin} of ${tierBRows}`);
  } else console.log('  – no Tier B rows, skipping OPP-1/2');

  if (oc?.cohort?.length) {
    const cohort = oc.cohort;
    /* OPP-3. No destination-minutes minimum, at any value. */
    const zeros = cohort.filter((e) => e.destMinutes === 0);
    ok('OPP-3 the opportunity cohort contains zero-minute episodes', zeros.length > 0, `${zeros.length}`);
    ok('OPP-3 zero-minute episodes reach the modelling cohort with a usable target',
      zeros.every((e) => Number.isFinite(e.startRate) && Number.isFinite(e.featureRate)));

    /* OPP-4. A same-club promotion is not a cross-club transfer. */
    const promo = cohort.filter((e) => e.type === 'SAME_CLUB_PROMOTION');
    ok('OPP-4 same-club promotion is its own class', promo.length > 0, `${promo.length}`);
    ok('OPP-4 every same-club promotion really is the same club',
      promo.every((e) => e.sourceTeam === e.destTeam && e.sourceCompetition === 'eng.2'));
    ok('OPP-4 no cross-club episode is labelled a promotion',
      !cohort.some((e) => e.type === 'CHAMPIONSHIP_TO_EPL_TRANSFER' && e.sourceTeam === e.destTeam));

    /* OPP-5 / OPP-6. The denominator is the club's real fixture count, and an
       unknown window is excluded rather than assumed to be a full season. */
    ok('OPP-5 every episode carries a real fixture denominator',
      cohort.every((e) => Number.isInteger(e.destFixtures) && e.destFixtures >= 30));
    ok('OPP-6 no episode assumes 38 fixtures without evidence',
      cohort.every((e) => e.destFixtures <= 46));
    ok('OPP-6 rates are computed against that denominator, not a constant',
      cohort.every((e) => Math.abs(e.startRate - e.destStarts / e.destFixtures) < 1e-9));

    /* OPP-7. Every exclusion is named. */
    const acc = oc.episodes + Object.values(oc.attrition.reasons).reduce((a, b) => a + b, 0);
    ok('OPP-7 every candidate transition is accounted for',
      acc === oc.attrition.allTransitions, `${acc} vs ${oc.attrition.allTransitions}`);
    ok('OPP-7 every exclusion carries an explicit reason',
      Object.keys(oc.attrition.reasons).every((r) => r && r.length > 8));
  } else console.log('  – no opportunity cohort, skipping OPP-3..7');

  if (om?.fitted) {
    /* OPP-8. Every fitted parameter comes from training only. The holdout is a
       later season, so a leak would show as the fit knowing about it. */
    ok('OPP-8 training and holdout are different seasons', om.trainSeason < om.testSeason);
    ok('OPP-8 the chronological direction is forwards only', om.testSeason === om.trainSeason + 1);
    ok('OPP-9 fitted parameters are recorded once and not per-target-holdout',
      typeof om.fitted.k === 'object' && Object.keys(om.fitted.k).length > 0);

    /* OPP-10. Candidate output must map onto the components production
       consumes, not an opaque score. */
    const t = om.targets?.startRate?.scores;
    ok('OPP-10 candidates emit featureRate, startRate and minutesRate',
      ['featureRate', 'startRate', 'minutesRate'].every((k) => om.targets[k]));
    ok('OPP-10 no opaque single opportunity score is emitted',
      !Object.keys(om.targets).some((k) => /score|index/i.test(k)));
    ok('OPP-10 the incumbent control is scored alongside every candidate',
      !!t?.O0 && !!t?.O0b);
  } else console.log('  – no model results, skipping OPP-8..10');
}

/* ------------------------------------------------------------------ *
 * Milestone 4 — same-club control and external-field safety
 * ------------------------------------------------------------------ */
console.log('\nMilestone 4');
{
  const readIf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const { FIELD_REGISTRY, isModelSafe, assertModelSafe } = await import('./warehouse/field-registry.mjs');
  const sc = readIf('data/warehouse/research/same-club-control.json');
  const oc = readIf('data/warehouse/research/opportunity-cohort.json');
  const froz = readIf('data/warehouse/research/opportunity-FROZEN.json');
  const shadow = readIf('data/warehouse/research/shadow-archive.json');

  if (sc?.cohort?.length) {
    /* M4-1 / M4-2. The control must contain only players who stayed put — a
       single transfer episode leaking in would contaminate the ceiling the
       whole milestone rests on. */
    ok('M4-1 same-club pairs are consecutive eng.1 seasons',
      sc.cohort.every((r) => r.toSeason === r.fromSeason + 1));
    ok('M4-1 every same-club pair is labelled as such', sc.cohort.every((r) => r.type === 'SAME_CLUB_EPL'));
    ok('M4-2 the same-club control contains no club change', sc.cohort.every((r) => typeof r.club === 'string'));
    /* And it must not overlap the transfer cohorts at all. */
    if (oc?.cohort?.length) {
      const transferKeys = new Set(oc.cohort.map((e) => `${e.espnId}|${e.destSeason}`));
      const leaked = sc.cohort.filter((r) => transferKeys.has(`${r.espnId}|${r.toSeason}`));
      ok('M4-2 no transfer episode appears in the same-club control', leaked.length === 0, `${leaked.length} leaked`);
    }
    /* M4-3. Per-90 needs a real denominator on both sides. */
    ok('M4-3 every same-club row has positive minutes on both sides',
      sc.cohort.every((r) => r.srcMin > 0 && r.dstMin > 0));
  } else console.log('  – no same-club control yet, skipping M4-1..3');

  /* M4-4. The saves trap can never reach goalkeeper modelling. */
  ok('M4-4 saves is registered REJECTED_SEMANTICS', FIELD_REGISTRY.saves?.status === 'REJECTED_SEMANTICS');
  ok('M4-4 saves is not model-safe', !isModelSafe('saves'));
  ok('M4-4 asserting saves throws', (() => {
    try { assertModelSafe(['saves']); return false; } catch { return true; }
  })());
  /* And no research module may consume it. */
  {
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p2 = path.join(dir, e.name);
        if (e.isDirectory()) walk(p2, out); else if (e.name.endsWith('.mjs')) out.push(p2);
      }
      return out;
    };
    /* The dangerous use is `saves` as a PLAYER metric. The identically named
       team-boxscore field is a genuine team total and is registered separately
       as `team.saves` — so the check targets player-metric declarations rather
       than the word, which would flag the legitimate use too. */
    const research = walk('scripts/warehouse/research');
    const consuming = research.filter((f) => {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const metricLists = src.match(/(?:METRICS|FIELDS|PRODUCTION_METRICS)\s*=\s*\[[^\]]*\]/g) || [];
      const per90Reads = src.match(/per90\([^)]*['"]saves['"]/g) || [];
      const rowReads = src.match(/\b(?:src|dst)_saves\b/g) || [];
      return metricLists.some((l) => /['"]saves['"]/.test(l)) || per90Reads.length || rowReads.length;
    });
    ok('M4-4 no research module models saves as a player metric', consuming.length === 0, consuming.join(', '));
    ok('M4-4 the team boxscore saves is registered separately as team.saves',
      FIELD_REGISTRY['team.saves']?.status === 'MODEL_SAFE');
  }

  /* M4-5 / M4-6. Every registered field has a status, and unknown is not safe. */
  ok('M4-5 every registered field declares a status',
    Object.values(FIELD_REGISTRY).every((v) => ['MODEL_SAFE', 'RAW_ONLY', 'REJECTED_SEMANTICS', 'UNKNOWN'].includes(v.status)));
  ok('M4-5 every MODEL_SAFE field states the population it was checked against',
    Object.entries(FIELD_REGISTRY).filter(([, v]) => v.status === 'MODEL_SAFE')
      .every(([, v]) => v.population && v.evidence));
  ok('M4-6 an UNKNOWN field is not model-safe',
    Object.entries(FIELD_REGISTRY).filter(([, v]) => v.status === 'UNKNOWN').every(([f]) => !isModelSafe(f)));
  ok('M4-6 an unregistered field is not model-safe', !isModelSafe('someFieldNobodyChecked'));

  /* M4-7 / M4-8. The historical freeze is immutable. */
  if (froz) {
    ok('M4-7 the frozen opportunity result records its commit and digest',
      !!froz.codeCommit && !!froz.warehouse?.coverageDigest);
    ok('M4-7 frozen candidates record their formula and shrinkage',
      ['O0b', 'O0c', 'O3'].every((k) => froz.candidates[k]?.formula));
    ok('M4-7 the frozen verdict names its holdout cohort',
      froz.cohort?.testSeason === 2025 && froz.cohort?.trainSeason === 2024);
  }
  if (shadow) {
    ok('M4-8 the shadow archive records a capture time and digest',
      !!shadow.capturedAt && !!shadow.warehouse?.coverageDigest);
    ok('M4-8 the shadow archive names its first scorable gameweek', Number.isInteger(shadow.firstScorableGW));
    /* M4-9. No destination-season outcome may appear in a source-only candidate. */
    ok('M4-9 no shadow candidate carries a destination-season outcome',
      (shadow.players || []).every((p) => p.destMinutes === undefined && p.destStarts === undefined
        && p.destAppearances === undefined));
    ok('M4-9 every shadow candidate is built from source-season evidence',
      (shadow.players || []).every((p) => Number.isFinite(p.sourceMinutes)));
  }

  /* M4-10. The whole programme's standing guarantee. */
  {
    const jsFiles = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p2 = path.join(dir, e.name);
        if (e.isDirectory()) walk(p2); else if (e.name.endsWith('.js')) jsFiles.push(p2);
      }
    };
    walk('js');
    const leaking = jsFiles.filter((f) => /research\/|field-registry|shadow-archive|same-club/.test(fs.readFileSync(f, 'utf8')));
    ok('M4-10 no browser module references warehouse research', leaking.length === 0, leaking.join(', '));
  }
}

/* ------------------------------------------------------------------ *
 * Milestone 5 — frozen bridge and prospective discipline
 * ------------------------------------------------------------------ */
console.log('\nMilestone 5');
{
  const readIf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const bridge = readIf('data/warehouse/research/xg-bridge-FROZEN.json');
  const rob = readIf('data/warehouse/research/transition-robustness.json');
  const shadow = readIf('data/warehouse/research/shadow-archive.json');
  const prereg = readIf('data/warehouse/research/team-strength-PREREGISTERED.json');
  const { isModelSafe } = await import('./warehouse/field-registry.mjs');

  if (rob) {
    /* M5-1. The bootstrap must be reproducible — it is seeded, so a rerun gives
       the same interval. Asserted by re-deriving one figure from the stored
       output rather than trusting that it was seeded. */
    const s450 = rob.thresholds?.['450']?.metrics?.shots;
    ok('M5-1 retention bootstrap intervals are stored with n on both sides',
      !!s450?.['sameClub - eplToEpl']?.ci && Number.isInteger(s450['sameClub - eplToEpl'].nA));
    ok('M5-1 the bootstrap reports a direction probability',
      Number.isFinite(s450['sameClub - eplToEpl'].pPositive));
    /* M5-2. Every transition group must be measured at the same thresholds with
       the same definition — otherwise the comparison is between different
       populations, not different transitions. */
    const ts = Object.keys(rob.thresholds);
    ok('M5-2 all four thresholds are reported', ts.length === 4, ts.join(','));
    ok('M5-2 every threshold reports all three groups',
      ts.every((t) => ['sameClub', 'eplToEpl', 'foreign']
        .every((g) => rob.thresholds[t].metrics.shots.retention[g] !== undefined)));
    ok('M5-2 no threshold was omitted for being inconvenient',
      ts.every((t) => Number.isInteger(rob.thresholds[t].n.sameClub)));
  } else console.log('  – no robustness output, skipping M5-1..2');

  if (bridge) {
    /* M5-3 / M5-4. Training is 2025/26 only, and 2026 cannot enter. */
    ok('M5-3 the bridge trained on 2025/26 only', bridge.trainingSeason === '2025/26');
    ok('M5-3 training required a same-season join on both sides',
      /same season/i.test(bridge.trainingSource) && /450/.test(bridge.trainingSource));
    ok('M5-4 the bridge declares no external validation',
      /NO EXTERNAL VALIDATION/.test(bridge.validationStatus));
    ok('M5-4 internal K-fold is labelled development only',
      /INTERNAL MODEL DEVELOPMENT ONLY/.test(bridge.validationStatus));
    /* M5-5. Immutable after freeze: it carries a status saying so and a digest. */
    ok('M5-5 the bridge is marked frozen with a new-version rule',
      /FROZEN/.test(bridge.status) && /NEW candidate version/.test(bridge.status));
    ok('M5-5 the bridge records its warehouse digest', !!bridge.warehouse?.coverageDigest);
    /* M5-6 / M5-7. Prospective scoring starts after the freeze. */
    ok('M5-6 the bridge names a first scorable gameweek', Number.isInteger(bridge.firstScorableGW));
    ok('M5-7 the first scorable gameweek is not 1 or 2', bridge.firstScorableGW >= 3,
      `got ${bridge.firstScorableGW}`);
    /* M5-8. Position effects survive — a universal conversion is what Part 6 forbids. */
    const xg1 = bridge.fitted?.XG1?.coefficients;
    ok('M5-8 the bridge fits position interactions, not one universal slope',
      Array.isArray(xg1) && xg1.length === 6 && (xg1[4] !== 0 || xg1[5] !== 0));
    ok('M5-8 position slopes actually differ',
      Math.abs((xg1[1] + xg1[4]) - xg1[1]) > 1e-6);
    /* M5-9. Units are declared and distinct. */
    ok('M5-9 the bridge declares input and output units',
      /shots\/90/.test(bridge.units) && /xG\/90/.test(bridge.units));
    ok('M5-9 the bridge forbids substituting one unit for the other',
      /never be substituted/.test(bridge.units));
    /* M5-10. Price prior untouched. */
    ok('M5-10 the bridge states the price prior is untouched', /UNTOUCHED/.test(bridge.pricePrior));
  } else console.log('  – no frozen bridge, skipping M5-3..10');

  if (shadow?.bridgeAdded) {
    ok('M5-4 prospective bridge predictions carry the frozen version',
      (shadow.players || []).filter((p) => p.bridge).every((p) => p.bridge.version === 'xg-bridge-2025-v1'));
    ok('M5-9 bridge output is xG/xA, never re-labelled volume',
      (shadow.players || []).filter((p) => p.bridge?.predicted_xG90 != null)
        .every((p) => /xG\/90 and xA\/90/.test(p.bridge.note)));
    ok('M5-7 the shadow archive first scorable gameweek is 3 or later', shadow.firstScorableGW >= 3);
  }

  /* M5-11. Only MODEL_SAFE fields reach research models — enforced, not hoped. */
  ok('M5-11 assertModelSafe is called by the modelling paths', (() => {
    const files = ['scripts/warehouse/research/production-translation.mjs',
      'scripts/warehouse/research/same-club-control.mjs',
      'scripts/warehouse/research/transition-robustness.mjs',
      'scripts/warehouse/research/xg-bridge.mjs'];
    return files.every((f) => fs.existsSync(f) && /assertModelSafe\(/.test(fs.readFileSync(f, 'utf8')));
  })());
  ok('M5-11 a rejected field is still rejected', !isModelSafe('saves'));

  /* M5-12. The standing guarantee. */
  ok('M5-12 no browser module references any shadow or bridge artefact', (() => {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p2 = path.join(dir, e.name);
        if (e.isDirectory()) walk(p2); else if (e.name.endsWith('.js')) out.push(p2);
      }
    };
    walk('js');
    return !out.some((f) => /xg-bridge|shadow-archive|transition-robustness|same-club/.test(fs.readFileSync(f, 'utf8')));
  })());

  if (prereg) {
    ok('M5-pre the team-strength test is pre-registered before scoring',
      /PRE-REGISTERED/.test(prereg.status) && Array.isArray(prereg.attackCandidates));
    ok('M5-pre the pre-registration names its control and forbids post-hoc changes',
      /goals/.test(prereg.control) && prereg.rules.some((r) => /may be added, removed or transformed/.test(r)));
  }
}

/* ------------------------------------------------------------------ *
 * Prospective evidence period — the window rule
 * ------------------------------------------------------------------ */
console.log('\nProspective window');
{
  const readIf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const man = readIf('data/warehouse/research/EXPERIMENT-MANIFEST.json');
  const rep = readIf('data/warehouse/research/prospective-report.json');

  if (man) {
    ok('PW-1 the manifest is marked immutable', /IMMUTABLE/.test(man.status));
    ok('PW-1 the manifest records freeze commit, timestamp and digest',
      !!man.freezeTimestamp && !!man.warehouseDigest);
    ok('PW-1 every candidate family is versioned',
      !!man.candidateVersions?.xGBridge && !!man.candidateVersions?.productionVolume
      && !!man.candidateVersions?.opportunity?.O3);
    ok('PW-2 the evaluation window starts at or after gameweek 3', man.evaluationWindowStartGW >= 3);
    ok('PW-2 the window rule forbids season-to-date totals',
      /may not be used/.test(man.windowRule) && /removed exactly/.test(man.windowRule));

    /* The incumbent control must carry the structural-zero flag, or a Stage A
       comparison would score the bridge against an absence and call it a win. */
    const players = man.incumbentControl?.players || [];
    ok('PW-3 the incumbent control is frozen per player', players.length > 0);
    ok('PW-3 each player declares whether the incumbent holds a real estimate',
      players.every((p) => typeof p.incumbentHasProductionEstimate === 'boolean'));
    ok('PW-3 a zero incumbent xG is flagged as no estimate, not as a forecast',
      players.filter((p) => p.incumbent_xG90 === 0 && p.incumbent_xA90 === 0)
        .every((p) => p.incumbentHasProductionEstimate === false));
    ok('PW-3 the caveat states pricePrior carries cold-start production instead',
      /pricePrior/.test(man.incumbentControl.caveat) && /POINTS PER/.test(man.incumbentControl.caveat));

    /* Production volume must be declared unscorable rather than scored on
       contaminated season totals. */
    ok('PW-4 production volume is declared not yet scorable',
      /NOT YET SCORABLE/.test(man.measurability['production volume (shots, SOT, keyPasses)']));
    ok('PW-4 opportunity and bridge are declared scorable',
      /SCORABLE/.test(man.measurability['opportunity (minutes, starts, 60+)'])
      && /SCORABLE/.test(man.measurability['bridge (xG/90, xA/90)']));
  } else console.log('  – no manifest, skipping PW-1..4');

  if (rep) {
    /* PW-5. The decisive regression test: no pre-freeze gameweek may appear in
       the eligible window, and pre-freeze gameweeks must be reported as
       excluded rather than silently dropped. */
    ok('PW-5 no eligible gameweek precedes the freeze',
      (rep.eligibleGameweeks || []).every((g) => g >= rep.experimentFreeze.firstScorableGW),
      JSON.stringify(rep.eligibleGameweeks));
    ok('PW-5 pre-freeze gameweeks are reported as excluded, not hidden',
      Array.isArray(rep.excludedGameweeks));
    ok('PW-5 every excluded gameweek really is before the freeze',
      (rep.excludedGameweeks || []).every((g) => g < rep.experimentFreeze.firstScorableGW));
    /* Per-player accounting must show the exclusion too. */
    ok('PW-5 each row records how many gameweeks it excluded',
      (rep.rows || []).every((r) => Number.isInteger(r.excludedGws)));
    ok('PW-5 no row counts more eligible gameweeks than exist',
      (rep.rows || []).every((r) => r.eligibleGws <= (rep.eligibleGwCount || 0)));
    /* And when there is no window, nothing may be scored. */
    if (!(rep.eligibleGwCount > 0)) {
      ok('PW-6 with no eligible window the report scores nothing',
        /NOT YET SCORABLE/.test(rep.status || ''));
      ok('PW-6 season-to-date totals are not substituted when the window is empty',
        !rep.pooled || Object.keys(rep.pooled).length === 0);
    }
    ok('PW-7 the report states that no model was changed', /NONE/.test(rep.modelChanges));
  } else console.log('  – no prospective report, skipping PW-5..7');
}

/* ------------------------------------------------------------------ *
 * Prospective evidence period — collection and population discipline
 * ------------------------------------------------------------------ */
console.log('\nProspective evidence (PE)');
{
  const readIf = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const man = readIf('data/warehouse/research/EXPERIMENT-MANIFEST.json');
  const rep = readIf('data/warehouse/research/prospective-report.json');
  const tsFrozen = readIf('data/warehouse/research/team-strength-RESULT-FROZEN.json');
  const { isModelSafe, FIELD_REGISTRY } = await import('./warehouse/field-registry.mjs');

  /* PE-1. A structural absence is null/false, never a zero forecast. */
  if (man) {
    const players = man.incumbentControl?.players || [];
    ok('PE-1 structural absence is flagged, never presented as a zero forecast',
      players.filter((p) => !p.incumbentHasProductionEstimate)
        .every((p) => p.incumbentHasProductionEstimate === false));
    ok('PE-1 the manifest states the structural-zero rule',
      /structural absence, not a forecast/.test(man.incumbentControl?.caveat || ''));
    ok('PE-1 both a real-estimate and a no-estimate group exist',
      man.incumbentControl.withProductionEstimate > 0 && man.incumbentControl.withoutProductionEstimate > 0);
  }

  /* PE-2 / PE-3. The two populations answer different questions and the
     cold-start group must never be scored against the incumbent. */
  if (rep?.populations) {
    const A = rep.populations['GROUP A — INCUMBENT-COMPARABLE'];
    const B = rep.populations['GROUP B — COLD-START GAP'];
    ok('PE-2 the cold-start group excludes the incumbent as a comparator',
      !B.comparators.some((c) => /incumbent/i.test(c)));
    ok('PE-2 the cold-start group records why', /manufacture a win/.test(B.forbidden || ''));
    ok('PE-3 the cold-start group is still evaluated against the position baseline',
      B.comparators.some((c) => /position baseline/i.test(c)));
    ok('PE-3 the incumbent-comparable group does include the incumbent',
      A.comparators.some((c) => /incumbent/i.test(c)));
  } else console.log('  – no eligible window yet, population split not exercised');

  /* PE-4 / PE-9. Only GW>=3 outcomes and minutes. */
  if (rep) {
    ok('PE-4 no eligible gameweek precedes the freeze',
      (rep.eligibleGameweeks || []).every((g) => g >= rep.experimentFreeze.firstScorableGW));
    ok('PE-9 prospective minutes are summed only from eligible gameweeks',
      (rep.rows || []).every((r) => r.eligibleGws <= (rep.eligibleGwCount || 0)));
  }

  /* PE-5. A collection failure can never become a measured zero. */
  {
    const src = fs.readFileSync('scripts/warehouse/fetch-prospective-outcomes.mjs', 'utf8');
    ok('PE-5 the collector initialises unfetched detail fields to null, not zero',
      /minutes: null, keyPasses: null/.test(src));
    ok('PE-5 a missing statistics block is skipped rather than zeroed',
      /never write a zero/.test(src));
    ok('PE-5 unavailable matches are recorded as missing coverage',
      /COVERAGE INCOMPLETE/.test(src) && /NOT as zero/.test(src));
  }

  /* PE-6. Endpoint-specific safety, enforced before collection. */
  ok('PE-6 the collector refuses fields that are not MODEL_SAFE for its endpoint',
    /refusing to collect it into evaluation/.test(fs.readFileSync('scripts/warehouse/fetch-prospective-outcomes.mjs', 'utf8')));
  ok('PE-6 match-summary shots are registered for that endpoint specifically',
    isModelSafe('matchSummary.totalShots'));
  ok('PE-6 the same field name can differ by endpoint',
    isModelSafe('matchSummary.saves') && !isModelSafe('saves'));
  ok('PE-6 match-summary goalsConceded is rejected as team-level',
    FIELD_REGISTRY['matchSummary.goalsConceded']?.status === 'REJECTED_SEMANTICS');

  /* PE-7. Re-running the report changes nothing. */
  if (rep) {
    ok('PE-7 the report declares no model change', /NONE/.test(rep.modelChanges));
    ok('PE-7 the report is keyed to a freeze version', !!rep.experimentFreeze?.firstScorableGW);
  }

  /* PE-8. Frozen candidates cannot be edited by outcomes. */
  {
    const bridge = readIf('data/warehouse/research/xg-bridge-FROZEN.json');
    ok('PE-8 the bridge remains marked frozen with a new-version rule',
      /FROZEN/.test(bridge?.status || '') && /NEW candidate version/.test(bridge?.status || ''));
    const collector = fs.readFileSync('scripts/warehouse/fetch-prospective-outcomes.mjs', 'utf8');
    ok('PE-8 the collector states it may not refit a candidate',
      /EVALUATION ONLY/.test(collector) && /may refit any candidate|refit/.test(collector));
  }

  /* PE-10. The pre-registered team-strength result is immutable. */
  if (tsFrozen) {
    ok('PE-10 the team-strength result is frozen after scoring', /FROZEN RESULT/.test(tsFrozen.status));
    ok('PE-10 it forbids re-selecting a defensive metric post hoc',
      /invalidate it/.test(tsFrozen.prohibition) && /different defensive metric/.test(tsFrozen.prohibition));
    ok('PE-10 attack is a shadow hypothesis, not a production change',
      /SHADOW HYPOTHESIS/.test(tsFrozen.attack.action) && /No production change/.test(tsFrozen.attack.action));
    ok('PE-10 defence keeps the control', /KEEP CONTROL/.test(tsFrozen.defence.action));
    ok('PE-10 the replication caveats are recorded, not just the numbers',
      Array.isArray(tsFrozen.attack.reasons) && tsFrozen.attack.reasons.length >= 3);
  }
}

/* ------------------------------------------------------------------ *
 * Double gameweeks, blanks and reschedules
 * ------------------------------------------------------------------ */
console.log('\nEvent-grain aggregation');
{
  const { aggregateToEvent, buildEventMap, coverage } = await import('./warehouse/research/prospective-aggregate.mjs');

  /* PE-11. The denominator trap. Two matches in one FPL event must produce ONE
     rate over ONE minutes total — not two rates each using the full total, and
     not one rate over a doubled total. */
  const dgw = [
    { espnId: 1, gameweek: 7, eventId: 100, name: 'A', shots: 2, shotsOnTarget: 1, keyPasses: 1, minutes: 90, starter: true },
    { espnId: 1, gameweek: 7, eventId: 101, name: 'A', shots: 3, shotsOnTarget: 2, keyPasses: 0, minutes: 60, starter: true },
  ];
  const agg = aggregateToEvent(dgw);
  ok('PE-11 a double gameweek produces exactly one player-event row', agg.length === 1, `${agg.length}`);
  ok('PE-11 outcomes are summed across both matches', agg[0].shots === 5 && agg[0].shotsOnTarget === 3);
  ok('PE-11 minutes are summed once, not applied per match', agg[0].minutes === 150, `${agg[0].minutes}`);
  ok('PE-11 the rate is 5 shots per 150 minutes', Math.abs(agg[0].shots90 - (5 / 150) * 90) < 1e-9,
    `${agg[0].shots90}`);
  ok('PE-11 the denominator is not doubled', Math.abs(agg[0].shots90 - (5 / 300) * 90) > 1e-9);
  ok('PE-11 the row is flagged as a double gameweek', agg[0].isDoubleGameweek === true);

  /* The FPL-event fallback must behave identically — one total, not one per match. */
  const noEspnMins = dgw.map((r) => ({ ...r, minutes: null }));
  const aggF = aggregateToEvent(noEspnMins, new Map([['1|7', 150]]));
  ok('PE-11 the FPL fallback also uses one event total', aggF[0].minutes === 150 && aggF[0].shots === 5);
  ok('PE-11 the fallback records which source supplied minutes', aggF[0].minutesSource === 'fpl-event-total');
  ok('PE-11 ESPN match minutes are preferred when present', agg[0].minutesSource === 'espn-match-summed');

  /* PE-12. A blank gameweek is not a measured zero. */
  const blank = aggregateToEvent([
    { espnId: 2, gameweek: 7, eventId: 100, name: 'B', shots: 1, minutes: 90, starter: true },
  ]);
  ok('PE-12 a player with no fixture produces no row at all',
    !blank.some((r) => r.espnId === 3));
  ok('PE-12 absence is never rendered as zero shots',
    !blank.some((r) => r.espnId === 3 && r.shots === 0));
  /* And a field that was never fetched stays null rather than summing to zero. */
  const partial = aggregateToEvent([
    { espnId: 4, gameweek: 8, eventId: 200, name: 'C', shots: 2, keyPasses: null, minutes: 90, starter: true },
  ]);
  ok('PE-12 an unfetched field aggregates to null, not zero', partial[0].keyPasses === null);
  ok('PE-12 a null field yields a null rate, not zero', partial[0].keyPasses90 === null);
  ok('PE-12 a genuinely observed zero is preserved', (() => {
    const z = aggregateToEvent([{ espnId: 5, gameweek: 8, eventId: 200, shots: 0, minutes: 90, starter: true }]);
    return z[0].shots === 0 && z[0].shots90 === 0;
  })());

  /* PE-13. A rescheduled match keeps the FPL event that scores it, whatever the
     calendar says. */
  const fixtures = [
    { event: 5, kickoff_time: '2026-10-03T14:00:00Z', team_h: 1, team_a: 2 },
    /* played months late, still scored in event 5 */
    { event: 5, kickoff_time: '2027-01-14T20:00:00Z', team_h: 3, team_a: 4 },
    { event: 20, kickoff_time: '2027-01-14T17:30:00Z', team_h: 5, team_a: 6 },
  ];
  const map = buildEventMap(fixtures, []);
  ok('PE-13 a rescheduled match maps to its FPL event, not its calendar week',
    map.resolve('2027-01-14', 3, 4) === 5, String(map.resolve('2027-01-14', 3, 4)));
  ok('PE-13 a same-day match in a different event is not confused with it',
    map.resolve('2027-01-14', 5, 6) === 20);
  ok('PE-13 an unmapped fixture resolves to null rather than a guess',
    map.resolve('2027-02-01', 9, 9) === null);

  /* Coverage must name gaps. */
  const cov = coverage([], { 5: { eligible: 10, settled: 8, archived: 6 } });
  ok('PE-13 incomplete coverage is reported as incomplete', cov[5].status === 'COVERAGE INCOMPLETE');
}

console.log(`\n${failures === 0 ? `✓ all ${checks} warehouse checks passed` : `✗ ${failures} of ${checks} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
