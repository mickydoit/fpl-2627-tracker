/**
 * What the warehouse actually holds, measured rather than asserted.
 *
 * The point of this report is to make absence visible. A research layer built
 * on "we have the Bundesliga" is worthless if the Bundesliga turns out to be
 * three matchdays with no possession figures; the only honest way to plan the
 * next phase is to publish, per competition and season, exactly which fields
 * are populated and on what fraction of rows.
 *
 * Every number below is counted from the files on disk. Nothing is estimated,
 * and a field that is absent reads 0% rather than being omitted.
 */
import fs from 'node:fs';
import { readRows, paths, footprint, ROOT } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, seasonsFor } from './config.mjs';

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/* ------------------------------------------------------------------ *
 * per competition-season
 * ------------------------------------------------------------------ */
const rows = [];
for (const comp of COMPETITIONS) {
  for (const season of WAREHOUSE_SEASONS) {
    const espn = await readRows(paths.espnMatches(comp.key, season));
    const fdM = comp.footballData && seasonsFor('football-data').includes(season)
      ? await readRows(paths.fdMatches(comp.key, season)) : [];
    const fdT = comp.footballData && seasonsFor('football-data').includes(season)
      ? await readRows(paths.fdTeams(comp.key, season)) : [];
    const tm = await readRows(paths.teamMatch(comp.key, season));
    if (!espn.length && !fdM.length && !fdT.length) continue;

    /* Field-level coverage is measured on the team-match grain, because that is
       the grain every later model asks its questions at. */
    const sides = tm.length;
    const has = (f) => tm.filter((r) => r.stats?.[f] != null).length;
    const teamsSeen = new Set(fdT.map((t) => t.teamId));
    for (const r of tm) { teamsSeen.add(`espn:${r.espnTeamId}`); }

    rows.push({
      competition: comp.key,
      name: comp.name,
      tier: comp.tier,
      season,
      // structural
      fdMatches: fdM.length,
      fdMatchesPlayed: fdM.filter((m) => m.homeGoals != null).length,
      fdTeams: fdT.length,
      fdSquadPlayers: fdT.reduce((a, t) => a + (t.squad?.length || 0), 0),
      // performance
      espnMatches: espn.length,
      espnExpected: comp.matchesPerSeason,
      teamMatchRows: sides,
      playerMatchRows: 0,            // the expensive tier; deliberately not collected
      lineupRows: espn.reduce((a, m) => a + m.teams.reduce((b, t) => b + t.lineup.length, 0), 0),
      // field coverage, on team-match rows
      cov: {
        startingLineup: pct(tm.filter((r) => r.startersNamed === 11).length, sides),
        formation: pct(tm.filter((r) => r.formation).length, sides),
        shots: pct(has('totalShots'), sides),
        shotsOnTarget: pct(has('shotsOnTarget'), sides),
        possession: pct(has('possessionPct'), sides),
        corners: pct(has('wonCorners'), sides),
        passAccuracy: pct(has('passPct'), sides),
        tackles: pct(has('totalTackles'), sides),
        saves: pct(has('saves'), sides),
        // Verified null on the football-data free tier for every club checked,
        // and ESPN does not expose it on these endpoints at all.
        manager: 0,
        // No source in this warehouse publishes xG. Stated so no later phase
        // assumes otherwise.
        xg: 0,
      },
      joinedToFootballData: pct(tm.filter((r) => r.footballDataMatchId).length, sides),
      scoreConflicts: tm.filter((r) => r.scoreConflict).length,
    });
  }
}

/* ------------------------------------------------------------------ *
 * identity coverage for the current FPL player set
 * ------------------------------------------------------------------ */
const boot = readJSON('data/bootstrap.json');
const fplEspn = readJSON('data/identity/players.json');
const idReport = readJSON(`${ROOT}/mappings/identity-report.json`);
const warehousePlayers = await readRows(paths.players());
const espnHistory = readJSON('data/espn-history.json');

const byCode = new Map(warehousePlayers.map((p) => [p.fplCode, p]));
const fplCodes = (boot?.elements || []).map((e) => e.code);

/* "Usable pre-EPL or promoted-league evidence" is the question the next phase
   actually turns on, so it is answered strictly: the player must be mapped to
   football-data AND have been seen in a squad of a competition other than the
   Premier League. Being listed is not evidence of having played, and the report
   says so rather than letting the number read as minutes. */
const fdSquadSeen = new Map();
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of seasonsFor('football-data')) {
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      for (const p of t.squad || []) {
        if (!fdSquadSeen.has(p.playerId)) fdSquadSeen.set(p.playerId, new Set());
        fdSquadSeen.get(p.playerId).add(comp.key);
      }
    }
  }
}

let mappedEspn = 0; let mappedFd = 0; let nonEplSquad = 0; let espnSeasonEvidence = 0;
for (const code of fplCodes) {
  const w = byCode.get(code);
  if (fplEspn?.players?.[code]?.espnId) mappedEspn += 1;
  if (w?.footballDataId) {
    mappedFd += 1;
    const comps = fdSquadSeen.get(w.footballDataId);
    if (comps && [...comps].some((c) => c !== 'eng.1')) nonEplSquad += 1;
  }
  if (espnHistory?.players?.[code]?.seasons?.length) espnSeasonEvidence += 1;
}

const identity = {
  fplTotal: fplCodes.length,
  mappedToEspn: mappedEspn,
  mappedToFootballData: mappedFd,
  ambiguous: idReport?.proposals?.length ?? 0,
  unmapped: fplCodes.length - mappedEspn,
  withNonEplSquadPresence: nonEplSquad,
  withEspnSeasonMinutes: espnSeasonEvidence,
};

/* ------------------------------------------------------------------ */
const fp = await footprint(ROOT);
const report = {
  builtAt: new Date().toISOString(),
  window: { warehouseSeasons: WAREHOUSE_SEASONS, footballData: seasonsFor('football-data'), espn: seasonsFor('espn') },
  footprint: { files: fp.files, bytes: fp.bytes, mb: Math.round((fp.bytes / 1e6) * 100) / 100 },
  competitions: rows,
  identity,
};
fs.writeFileSync(paths.coverage(), JSON.stringify(report, null, 1));

/* ------------------------------------------------------------------ */
console.log('WAREHOUSE COVERAGE\n');
console.log('competition      season  fd-matches  teams  squad   espn   team-match   lineup  join%  formation%  possession%');
for (const r of rows) {
  console.log('  ' + r.competition.padEnd(15) + r.season
    + String(r.fdMatches).padStart(11) + String(r.fdTeams).padStart(7) + String(r.fdSquadPlayers).padStart(7)
    + String(r.espnMatches).padStart(7) + String(r.teamMatchRows).padStart(13) + String(r.lineupRows).padStart(9)
    + String(r.joinedToFootballData).padStart(7) + String(r.cov.formation).padStart(12) + String(r.cov.possession).padStart(13));
}
console.log(`\nfootprint: ${report.footprint.mb} MB across ${fp.files} files`);
console.log('\nIDENTITY COVERAGE — current FPL player set');
console.log(`  FPL players                                 ${identity.fplTotal}`);
console.log(`  mapped to ESPN                              ${identity.mappedToEspn}  (${pct(identity.mappedToEspn, identity.fplTotal)}%)`);
console.log(`  mapped to football-data                     ${identity.mappedToFootballData}  (${pct(identity.mappedToFootballData, identity.fplTotal)}%)`);
console.log(`  ambiguous (refused, not guessed)            ${identity.ambiguous}`);
console.log(`  unmapped                                    ${identity.unmapped}`);
console.log(`  seen in a NON-Premier-League squad          ${identity.withNonEplSquadPresence}`);
console.log(`  with ESPN season minutes on record          ${identity.withEspnSeasonMinutes}`);
console.log(`\n→ ${paths.coverage()}`);
