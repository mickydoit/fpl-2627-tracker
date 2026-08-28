/**
 * What the warehouse actually holds, counted from disk.
 *
 * The point is to make absence visible. A research layer built on "we have the
 * Bundesliga" is worthless if the Bundesliga turns out to be three matchdays
 * with no possession figures, so every field is reported as a percentage of the
 * rows that could have carried it — and a field no source provides reads 0%
 * rather than being quietly omitted.
 */
import fs from 'node:fs';
import { readRows, paths, footprint, ROOT } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, seasonsFor } from './config.mjs';
import { datasetVersion } from './version.mjs';

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

const rows = [];
for (const comp of COMPETITIONS) {
  for (const season of WAREHOUSE_SEASONS) {
    const fdOn = comp.footballData && seasonsFor('football-data').includes(season);
    const fdM = fdOn ? await readRows(paths.fdMatches(comp.key, season)) : [];
    const fdT = fdOn ? await readRows(paths.fdTeams(comp.key, season)) : [];
    const espn = await readRows(paths.espnMatches(comp.key, season));
    const tm = await readRows(paths.teamMatch(comp.key, season));
    const psA = await readRows(paths.espnRosters(comp.key, season));
    const psB = await readRows(paths.espnPlayerSeasons(comp.key, season));
    if (!fdM.length && !fdT.length && !espn.length && !psA.length) continue;

    const sides = tm.length;
    const has = (f) => tm.filter((r) => r.stats?.[f] != null).length;
    const psAll = [...psA, ...psB];
    const hasPs = (f) => psAll.filter((r) => r[f] != null).length;

    rows.push({
      competition: comp.key, name: comp.name, tier: comp.tier, season,
      structuralMatches: fdM.length,
      structuralPlayed: fdM.filter((m) => m.homeGoals != null).length,
      espnMatches: espn.length,
      espnExpected: comp.matchesPerSeason,
      espnCollectedPct: pct(espn.length, comp.matchesPerSeason),
      teamMatchRows: sides,
      joinRatePct: pct(tm.filter((r) => r.footballDataMatchId).length, sides),
      teams: fdT.length,
      fdSquadPlayers: fdT.reduce((a, t) => a + (t.squad?.length || 0), 0),
      playerSeasonRows: psAll.length,
      playerSeasonTierA: psA.length,
      playerSeasonTierB: psB.length,
      cov: {
        startingLineup: pct(tm.filter((r) => r.startersNamed === 11).length, sides),
        formation: pct(tm.filter((r) => r.formation).length, sides),
        shots: pct(has('totalShots'), sides),
        shotsOnTarget: pct(has('shotsOnTarget'), sides),
        possession: pct(has('possessionPct'), sides),
        corners: pct(has('wonCorners'), sides),
        passAccuracy: pct(has('passPct'), sides),
        saves: pct(has('saves'), sides),
        /* Player-season field coverage. `minutes` is the one that matters and
           only the detailed tier carries it, so this number IS the Tier B
           coverage expressed the way a modeller would ask for it. */
        playerMinutes: pct(hasPs('minutes'), psAll.length),
        playerStarts: pct(hasPs('starts'), psAll.length),
        playerAppearances: pct(hasPs('appearances'), psAll.length),
        playerPosition: pct(hasPs('position'), psAll.length),
        playerDateOfBirth: pct(hasPs('dateOfBirth'), psAll.length),
        /* Verified absent. football-data's coach field is a historical dump
           (Liverpool returns Dalglish, Rodgers and Klopp for every season), and
           ESPN exposes no season manager. Reported as 0, not omitted. */
        manager: 0,
        /* No source in this warehouse publishes expected goals or assists. All
           95 fields of ESPN's detailed player tier were read to confirm it. */
        xg: 0,
        xa: 0,
      },
      unresolvedMatches: Math.max(0, fdM.filter((m) => m.homeGoals != null).length - espn.length),
      scoreConflicts: tm.filter((r) => r.scoreConflict).length,
    });
  }
}

/* ---- identity ----------------------------------------------------- */
const boot = readJSON('data/bootstrap.json');
const fplEspn = readJSON('data/identity/players.json');
const idReport = readJSON(`${ROOT}/mappings/identity-report.json`);
const warehousePlayers = await readRows(paths.players());
const byCode = new Map(warehousePlayers.map((p) => [p.fplCode, p]));
const espnHistory = readJSON('data/espn-history.json');

/* Where each mapped player has been seen, per competition, from the census. */
const seenIn = new Map();  // espnId -> Set(competition)
for (const comp of COMPETITIONS) {
  for (const season of seasonsFor('espn')) {
    for (const r of await readRows(paths.espnRosters(comp.key, season))) {
      if (!seenIn.has(r.espnId)) seenIn.set(r.espnId, new Set());
      seenIn.get(r.espnId).add(comp.key);
    }
    for (const r of await readRows(paths.espnPlayerSeasons(comp.key, season))) {
      if (!seenIn.has(r.espnId)) seenIn.set(r.espnId, new Set());
      seenIn.get(r.espnId).add(comp.key);
    }
  }
}

/* ACTIVE vs DEPARTED. The unmapped pool is dominated by players still carried
   in bootstrap with status 'u' — no longer at a Premier League club. An
   unmapped ACTIVE player is a real gap; an unmapped departed one is noise, and
   reporting them together overstates the problem. */
const elements = boot?.elements || [];
const isActive = (e) => e.status !== 'u';
const perCompetition = {};
for (const comp of COMPETITIONS) perCompetition[comp.key] = 0;
let mappedEspn = 0; let mappedFd = 0; let withMinutes = 0;
const unmappedActive = []; const unmappedDeparted = [];
for (const e of elements) {
  const m = fplEspn?.players?.[e.code];
  const w = byCode.get(e.code);
  if (m?.espnId) mappedEspn += 1;
  else (isActive(e) ? unmappedActive : unmappedDeparted).push({ code: e.code, name: e.web_name, status: e.status });
  if (w?.footballDataId) mappedFd += 1;
  const comps = m?.espnId ? seenIn.get(m.espnId) : null;
  if (comps) for (const c of comps) perCompetition[c] = (perCompetition[c] || 0) + 1;
  if (espnHistory?.players?.[e.code]?.seasons?.length) withMinutes += 1;
}

const identity = {
  fplTotal: elements.length,
  fplActive: elements.filter(isActive).length,
  fplDeparted: elements.filter((e) => !isActive(e)).length,
  mappedToEspn: mappedEspn,
  mappedToFootballData: mappedFd,
  ambiguousRefused: idReport?.proposals?.length ?? 0,
  unmappedActive: unmappedActive.length,
  unmappedDeparted: unmappedDeparted.length,
  historyByCompetition: perCompetition,
  withEspnSeasonMinutes: withMinutes,
  unmappedActiveList: unmappedActive.slice(0, 30),
};

/* ---- write -------------------------------------------------------- */
const fp = await footprint(ROOT);
const version = await datasetVersion();
const report = {
  dataset: version,
  builtAt: new Date().toISOString(),
  footprint: { files: fp.files, bytes: fp.bytes, mb: Math.round((fp.bytes / 1e6) * 100) / 100 },
  competitions: rows,
  identity,
};
fs.writeFileSync(paths.coverage(), JSON.stringify(report, null, 1));

/* ---- console ------------------------------------------------------ */
console.log(`WAREHOUSE COVERAGE — dataset schema v${version.schemaVersion}, digest ${version.coverageDigest}\n`);
console.log('competition      season  struct  espn/exp    tm-rows  join%  lineup%  shots%  poss%   ps-rows  mins%');
for (const r of rows) {
  console.log('  ' + r.competition.padEnd(15) + r.season
    + String(r.structuralMatches).padStart(8)
    + (r.espnMatches + '/' + r.espnExpected).padStart(10)
    + String(r.teamMatchRows).padStart(11) + String(r.joinRatePct).padStart(7)
    + String(r.cov.startingLineup).padStart(9) + String(r.cov.shots).padStart(8)
    + String(r.cov.possession).padStart(7)
    + String(r.playerSeasonRows).padStart(10) + String(r.cov.playerMinutes).padStart(7));
}
const tot = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
console.log(`\ntotals: structural ${tot('structuralMatches')}, espn ${tot('espnMatches')}, `
  + `team-match ${tot('teamMatchRows')}, player-season ${tot('playerSeasonRows')} `
  + `(tier A ${tot('playerSeasonTierA')}, tier B ${tot('playerSeasonTierB')})`);
console.log(`score conflicts: ${tot('scoreConflicts')}   footprint: ${report.footprint.mb} MB / ${fp.files} files`);
console.log('\nabsent everywhere, stated rather than omitted:  manager 0%   xG 0%   xA 0%');

console.log('\nIDENTITY — current FPL player set');
console.log(`  FPL players                        ${identity.fplTotal}  (active ${identity.fplActive}, departed ${identity.fplDeparted})`);
console.log(`  mapped to ESPN                      ${identity.mappedToEspn}  (${pct(identity.mappedToEspn, identity.fplTotal)}%)`);
console.log(`  mapped to football-data             ${identity.mappedToFootballData}  (${pct(identity.mappedToFootballData, identity.fplTotal)}%)`);
console.log(`  ambiguous, refused not guessed      ${identity.ambiguousRefused}`);
console.log(`  UNMAPPED ACTIVE  (the real gap)     ${identity.unmappedActive}`);
console.log(`  unmapped departed (status 'u')      ${identity.unmappedDeparted}`);
console.log('\n  history by competition (current FPL players seen there):');
for (const [k, v] of Object.entries(identity.historyByCompetition).sort((a, b) => b[1] - a[1])) {
  if (v) console.log('    ' + k.padEnd(16) + v);
}
console.log(`\n→ ${paths.coverage()}`);
