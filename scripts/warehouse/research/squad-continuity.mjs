/**
 * Squad continuity for promoted clubs. DESCRIPTIVE ONLY.
 *
 * The hypothesis worth testing later: a strong Championship team that keeps its
 * squad may translate differently from an equally strong one that replaces half
 * of it. The promoted-club baseline found no usable signal from league strength
 * alone, which makes continuity the more interesting variable rather than the
 * less.
 *
 * ── Two grains, and the difference matters ──
 *
 * MEMBERSHIP continuity — what share of last season's squad list is still
 * here — is computable now from football-data's season squads, and is the weak
 * version: a squad list counts a fourth-choice keeper the same as a 38-game
 * centre-half.
 *
 * MINUTES continuity — what share of last season's minutes is still here — is
 * the version that means something, and it needs per-player minutes, which only
 * ESPN's detailed player-season tier carries. Where that tier has not been
 * collected the figure is reported as null, never as zero, and never quietly
 * substituted with the membership number.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/squad-continuity.json';
const FD_SEASONS = seasonsFor('football-data');

/** football-data squads: comp -> season -> teamTla -> Set(playerId) + meta */
const squads = {};
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  squads[comp.key] = {};
  for (const s of FD_SEASONS) {
    const rows = await readRows(paths.fdTeams(comp.key, s));
    if (!rows.length) continue;
    squads[comp.key][s] = new Map(rows.map((t) => [
      canonicalTla('football-data', t.tla, comp.key),
      { teamId: t.teamId, name: t.name, players: (t.squad || []).map((p) => ({ id: p.playerId, name: p.name, position: p.position })) },
    ]));
  }
}

/** Where a given football-data player was in a given season, by competition. */
function locate(playerId, season) {
  const found = [];
  for (const comp of Object.keys(squads)) {
    const bySeason = squads[comp][season];
    if (!bySeason) continue;
    for (const [tla, t] of bySeason) {
      if (t.players.some((p) => p.id === playerId)) found.push({ competition: comp, team: tla });
    }
  }
  return found;
}

/** ESPN detailed minutes, keyed espnId, for a competition-season. */
async function minutesFor(comp, season) {
  const rows = await readRows(paths.espnPlayerSeasons(comp, season));
  return new Map(rows.filter((r) => r.minutes != null).map((r) => [r.espnId, r]));
}

/* Bridge football-data ids to ESPN ids.
   
   The FPL identity map is the wrong bridge here and using it was the first
   version's mistake: it covers the 616 players the tracker projects, and a
   promoted club's Championship squad from three seasons ago is almost entirely
   players who have since left the league. Every continuity figure came back
   null for want of a bridge rather than for want of minutes.
   
   player_xref covers every player the census has seen, joined on date of birth
   within a competition-season. */
const xref = await readRows(paths.playerXref());
const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));
if (!xref.length) console.warn('  ⚠ no player_xref — run scripts/warehouse/build-xref.mjs first');

/* ---- promoted clubs, same detection as the baseline --------------- */
const promoted = [];
for (const season of FD_SEASONS) {
  const eplNow = squads['eng.1'][season]; const chPrev = squads['eng.2'][season - 1];
  if (!eplNow || !chPrev) continue;
  for (const [tla, club] of eplNow) if (chPrev.has(tla)) promoted.push({ tla, season, club, from: chPrev.get(tla) });
}

const report = [];
for (const p of promoted) {
  const before = p.from.players;
  const after = p.club.players;
  const beforeIds = new Set(before.map((x) => x.id));
  const afterIds = new Set(after.map((x) => x.id));

  const retained = before.filter((x) => afterIds.has(x.id));
  const lost = before.filter((x) => !afterIds.has(x.id));
  const added = after.filter((x) => !beforeIds.has(x.id));

  /* Where did the additions come from? Answered by presence, in the season
     BEFORE they arrived — which is the only thing squad lists can honestly
     support. A player found in no collected competition is 'unknown', not
     'no club'. */
  const addedBy = {};
  for (const a of added) {
    const where = locate(a.id, p.season - 1).filter((w) => !(w.competition === 'eng.2' && w.team === p.tla));
    const key = where.length ? where.map((w) => w.competition).sort().join('+') : 'unknown';
    addedBy[key] = (addedBy[key] || 0) + 1;
  }

  /* Minutes continuity, where the detailed tier exists for the Championship
     season. Null rather than zero when it does not. */
  const chMins = await minutesFor('eng.2', p.season - 1);
  let minutesRetained = null; let minutesTotal = null; let startsRetained = null; let startsTotal = null;
  let goalsRetained = null; let goalsTotal = null; let assistsRetained = null; let assistsTotal = null;
  const withMins = before.map((x) => chMins.get(espnByFd.get(x.id))).filter(Boolean);
  if (withMins.length >= Math.max(8, before.length * 0.4)) {
    const sum = (rows, f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
    const kept = before.filter((x) => afterIds.has(x.id)).map((x) => chMins.get(espnByFd.get(x.id))).filter(Boolean);
    minutesTotal = sum(withMins, 'minutes'); minutesRetained = sum(kept, 'minutes');
    startsTotal = sum(withMins, 'starts'); startsRetained = sum(kept, 'starts');
    goalsTotal = sum(withMins, 'goals'); goalsRetained = sum(kept, 'goals');
    assistsTotal = sum(withMins, 'assists'); assistsRetained = sum(kept, 'assists');
  }
  const share = (a, b) => (a != null && b) ? +((a / b) * 100).toFixed(1) : null;

  report.push({
    club: p.tla,
    name: p.club.name,
    eplSeason: p.season,
    championshipSeason: p.season - 1,
    squadBefore: before.length,
    squadAfter: after.length,
    retained: retained.length,
    lost: lost.length,
    added: added.length,
    membershipContinuityPct: share(retained.length, before.length),
    addedBySourceCompetition: addedBy,
    /* The measure that matters, and it is honestly null where the evidence for
       it has not been collected. */
    minutesEvidencePlayers: withMins.length,
    minutesContinuityPct: share(minutesRetained, minutesTotal),
    startsContinuityPct: share(startsRetained, startsTotal),
    goalsContinuityPct: share(goalsRetained, goalsTotal),
    assistsContinuityPct: share(assistsRetained, assistsTotal),
  });
}

const out = {
  builtAt: new Date().toISOString(),
  caveat: 'DESCRIPTIVE ONLY. Membership continuity weights a fourth-choice keeper like a 38-game '
    + 'centre-half; minutes continuity is the meaningful measure and is null wherever ESPN\'s detailed '
    + 'player-season tier has not been collected for that Championship season.',
  clubs: report,
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

console.log('PROMOTED-CLUB SQUAD CONTINUITY  (descriptive only)\n');
console.log('club  EPL   squad(before/after)  retained  lost  added   membership%   minutes%  (evidence)');
for (const r of report.sort((a, b) => a.eplSeason - b.eplSeason || a.club.localeCompare(b.club))) {
  console.log('  ' + r.club.padEnd(5) + String(r.eplSeason).padEnd(6)
    + (r.squadBefore + '/' + r.squadAfter).padStart(12)
    + String(r.retained).padStart(11) + String(r.lost).padStart(6) + String(r.added).padStart(7)
    + String(r.membershipContinuityPct + '%').padStart(13)
    + String(r.minutesContinuityPct == null ? 'n/a' : r.minutesContinuityPct + '%').padStart(11)
    + `   (${r.minutesEvidencePlayers} players)`);
}
console.log('\nadditions by the competition they came from:');
for (const r of report.sort((a, b) => a.eplSeason - b.eplSeason)) {
  console.log('  ' + r.club + ' ' + r.eplSeason + ': ' + Object.entries(r.addedBySourceCompetition)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
}
console.log(`\n→ ${OUT}`);
