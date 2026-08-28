/**
 * Raw → normalised. The raw files are never rewritten by this step.
 *
 * The programme's rule is that incoming data is archived before it is
 * interpreted, so that a later idea can be tested against the evidence as it
 * arrived rather than against whatever a previous model thought worth keeping.
 * This file therefore only ever READS data/warehouse/raw and WRITES
 * data/warehouse/normalised.
 *
 * ── Source precedence, stated rather than assumed ──
 *
 * The two sources overlap on exactly one thing: the result. Where they
 * disagree, football-data wins on STRUCTURE (which match this is, when it was,
 * what the score was, which matchday it belongs to) because that is a curated
 * feed with stable ids; ESPN wins on PERFORMANCE (formation, lineup, the 28
 * team statistics) because football-data does not carry it at all on this plan.
 *
 * A disagreement on the score is not silently resolved. It is recorded on the
 * row as `scoreConflict` so it can be counted, because a systematic conflict
 * would mean the two feeds are being joined wrongly and that is worth finding
 * out loudly.
 */
import { readRows, writeRows, paths } from './store.mjs';
import { COMPETITIONS, seasonsFor, WAREHOUSE_SEASONS } from './config.mjs';
import { canonicalTla, fixtureKey } from './tla.mjs';

const ONLY = (process.env.WAREHOUSE_COMPETITIONS || '').split(',').filter(Boolean);
const targets = COMPETITIONS.filter((c) => !ONLY.length || ONLY.includes(c.key));

/** Kick-off times differ by seconds between feeds; same day is the join. */
const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

let totalRows = 0; let conflicts = 0; let joined = 0;
const summary = [];

for (const comp of targets) {
  for (const season of WAREHOUSE_SEASONS) {
    const espn = await readRows(paths.espnMatches(comp.key, season));
    const fd = comp.footballData && seasonsFor('football-data').includes(season)
      ? await readRows(paths.fdMatches(comp.key, season)) : [];
    if (!espn.length && !fd.length) continue;

    /* Index football-data by (day, both TLAs) so an ESPN match can find its
       structural twin without depending on either feed's match id. */
    const fdIndex = new Map();
    for (const m of fd) {
      fdIndex.set(fixtureKey('football-data', dayOf(m.utcDate), m.homeTeamTla, m.awayTeamTla), m);
    }

    const rows = [];
    for (const m of espn) {
      const home = m.teams.find((t) => t.homeAway === 'home');
      const away = m.teams.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      const twin = fdIndex.get(fixtureKey('espn', dayOf(m.date), home.abbreviation, away.abbreviation)) ?? null;
      if (twin) joined += 1;

      /* One row PER TEAM, not per match: every later question — team attack,
         opponent defence, manager tendency, promoted-club translation — is
         asked of a team in a fixture, and a per-match row would need unpacking
         at every one of those call sites. */
      for (const [side, opp] of [[home, away], [away, home]]) {
        const isHome = side.homeAway === 'home';
        const fdGoals = twin ? (isHome ? twin.homeGoals : twin.awayGoals) : null;
        const conflict = fdGoals != null && side.score != null && fdGoals !== side.score;
        if (conflict) conflicts += 1;
        rows.push({
          competition: comp.key,
          season,
          espnEventId: m.eventId,
          footballDataMatchId: twin?.matchId ?? null,
          date: m.date ?? twin?.utcDate ?? null,
          matchday: twin?.matchday ?? null,
          stage: twin?.stage ?? null,
          venue: m.venue ?? twin?.venue ?? null,
          referee: twin?.referee ?? null,

          espnTeamId: side.espnTeamId,
          team: canonicalTla('espn', side.abbreviation),
          teamName: side.name,
          opponentEspnTeamId: opp.espnTeamId,
          opponent: canonicalTla('espn', opp.abbreviation),
          home: isHome,

          goalsFor: side.score ?? null,
          goalsAgainst: opp.score ?? null,
          ...(conflict ? { scoreConflict: { espn: side.score, footballData: fdGoals } } : {}),

          formation: side.formation ?? null,
          startersNamed: side.lineup.filter((p) => p.starter).length,
          squadNamed: side.lineup.length,
          // The lineup itself stays out of this table: it is per-PLAYER
          // evidence and belongs in a player-grain entity, not a team one.
          stats: side.teamStats ?? {},
          opponentStats: opp.teamStats ?? {},

          _src: 'espn+football-data',
          _at: m._at ?? null,
        });
      }
    }
    if (!rows.length) continue;
    const res = await writeRows(paths.teamMatch(comp.key, season), rows);
    totalRows += rows.length;
    summary.push({ competition: comp.key, season, rows: rows.length, espnMatches: espn.length, fdMatches: fd.length, written: res.written });
    console.log(`  ${comp.key.padEnd(15)} ${season}  ${String(rows.length).padStart(4)} team-match rows`
      + `  (espn ${espn.length}, football-data ${fd.length})`);
  }
}

console.log(`\n✓ ${totalRows} team-match rows across ${summary.length} competition-seasons`);
console.log(`  ${joined} ESPN matches joined to a football-data twin`
  + `, ${conflicts} score conflicts`);
if (conflicts) console.log('  ⚠ a score conflict means the two feeds may be joined wrongly — investigate before modelling on this');
