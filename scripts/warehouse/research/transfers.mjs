/**
 * Transfer history, derived from squad membership rather than asserted.
 *
 * A move is inferred from presence: a player in club A's season-N squad and
 * club B's season-N+1 squad has moved. That is all squad lists can honestly
 * support, and it is deliberately less than a transfer feed would give:
 *
 *   - no fee, ever. Nothing here publishes one.
 *   - no loan-versus-permanent distinction. A loan and a sale look identical in
 *     two squad lists, so the field is not invented.
 *   - no date beyond the season boundary. A January move and a July move both
 *     appear as "present in N, present elsewhere in N+1".
 *
 * ── What this is FOR ──
 *
 * The cross-league translation question needs cohorts: how many players moved
 * from each competition into the Premier League, and how many of them have
 * enough minutes on BOTH sides of the move to be usable evidence. That last
 * number is the one that decides whether league translation is realistic, and
 * it is almost always far smaller than the raw move count.
 */
import fs from 'node:fs';
import { readRows, writeRows, paths, stamp } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/transfers.json';
const SEASONS = seasonsFor('football-data');

/* playerId -> season -> [{competition, team, teamId}] */
const where = new Map();
const playerMeta = new Map();
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of SEASONS) {
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      const tla = canonicalTla('football-data', t.tla, comp.key);
      for (const p of t.squad || []) {
        if (!where.has(p.playerId)) where.set(p.playerId, new Map());
        const bySeason = where.get(p.playerId);
        if (!bySeason.has(season)) bySeason.set(season, []);
        bySeason.get(season).push({ competition: comp.key, team: tla, teamId: t.teamId });
        if (!playerMeta.has(p.playerId)) {
          playerMeta.set(p.playerId, { name: p.name, dateOfBirth: p.dateOfBirth ?? null, position: p.position ?? null });
        }
      }
    }
  }
}

/* ---- derive moves ------------------------------------------------- */
const moves = [];
for (const [playerId, bySeason] of where) {
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  for (let i = 0; i < seasons.length - 1; i++) {
    const a = seasons[i]; const b = seasons[i + 1];
    if (b !== a + 1) continue;   // a gap is not a move we can describe
    const from = bySeason.get(a); const to = bySeason.get(b);
    /* A player can appear in two competitions in one season (a domestic league
       and a European one). The DOMESTIC entry is the club; European presence is
       the same club in another competition, not a transfer. */
    const domestic = (list) => list.filter((x) => !x.competition.startsWith('uefa.'));
    const fromD = domestic(from); const toD = domestic(to);
    if (!fromD.length || !toD.length) continue;
    for (const f of fromD) {
      for (const t of toD) {
        if (f.team === t.team) continue;   // stayed
        moves.push({
          footballDataPlayerId: playerId,
          name: playerMeta.get(playerId)?.name ?? null,
          dateOfBirth: playerMeta.get(playerId)?.dateOfBirth ?? null,
          position: playerMeta.get(playerId)?.position ?? null,
          fromSeason: a, toSeason: b,
          fromCompetition: f.competition, fromTeam: f.team,
          toCompetition: t.competition, toTeam: t.team,
          route: `${f.competition} -> ${t.competition}`,
        });
      }
    }
  }
}

/* Deduplicate: the same player-season-pair-club-pair must appear once. */
const seen = new Set();
const unique = [];
for (const m of moves) {
  const k = `${m.footballDataPlayerId}|${m.fromSeason}|${m.toSeason}|${m.fromTeam}|${m.toTeam}`;
  if (seen.has(k)) continue;
  seen.add(k); unique.push(m);
}

await writeRows(paths.transfers(), unique.map((m) => stamp(m, {
  source: 'derived:football-data-squads', fetchedAt: new Date().toISOString(),
})));

/* ---- minutes evidence either side of the move --------------------- */
/* The wide bridge, not the FPL one. A player who moved from the Bundesliga in
   2023 need not be in today's FPL bootstrap, and using the FPL-keyed map here
   returned zero minutes on both sides of every move — a bridge failure reported
   as an evidence failure. */
const xref = await readRows(paths.playerXref());
const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));
if (!xref.length) console.warn('  ⚠ no player_xref — run scripts/warehouse/build-xref.mjs first');
const minsCache = new Map();
async function minutes(comp, season, espnId) {
  const key = `${comp}:${season}`;
  if (!minsCache.has(key)) {
    const rows = await readRows(paths.espnPlayerSeasons(comp, season));
    minsCache.set(key, new Map(rows.filter((r) => r.minutes != null).map((r) => [r.espnId, r.minutes])));
  }
  return minsCache.get(key).get(espnId) ?? null;
}

const INTO_EPL = unique.filter((m) => m.toCompetition === 'eng.1');
const cohorts = {};
for (const m of INTO_EPL) {
  const key = m.fromCompetition;
  const c = cohorts[key] ??= { route: `${key} -> eng.1`, players: 0, withPreMinutes: 0, withPostMinutes: 0, withBoth: 0, withBoth450: 0 };
  c.players += 1;
  const espnId = espnByFd.get(m.footballDataPlayerId);
  if (!espnId) continue;
  const pre = await minutes(m.fromCompetition, m.fromSeason, espnId);
  const post = await minutes('eng.1', m.toSeason, espnId);
  if (pre != null) c.withPreMinutes += 1;
  if (post != null) c.withPostMinutes += 1;
  if (pre != null && post != null) {
    c.withBoth += 1;
    if (pre >= 450 && post >= 450) c.withBoth450 += 1;
  }
}

const report = {
  builtAt: new Date().toISOString(),
  seasonsCovered: SEASONS,
  seasonTransitions: SEASONS.slice(0, -1).map((s) => `${s}->${s + 1}`),
  totalMoves: unique.length,
  movesIntoEpl: INTO_EPL.length,
  cohorts: Object.values(cohorts).sort((a, b) => b.players - a.players),
  caveat: 'Derived from squad membership. No fees, no loan/permanent distinction, no within-season dates — '
    + 'none of which any source here publishes. "withBoth450" is the only column that matters for '
    + 'translation work: it counts players with 450+ minutes on BOTH sides of the move.',
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('TRANSFER HISTORY  (derived from squad membership)\n');
console.log(`season transitions available: ${report.seasonTransitions.join(', ')}`);
console.log(`total moves derived: ${unique.length}   into the Premier League: ${INTO_EPL.length}\n`);
console.log('route                        players   pre-mins   post-mins   both   both >=450');
for (const c of report.cohorts) {
  console.log('  ' + c.route.padEnd(26) + String(c.players).padStart(7)
    + String(c.withPreMinutes).padStart(11) + String(c.withPostMinutes).padStart(12)
    + String(c.withBoth).padStart(7) + String(c.withBoth450).padStart(13));
}
const eplEpl = unique.filter((m) => m.fromCompetition === 'eng.1' && m.toCompetition === 'eng.1').length;
console.log(`\nEPL club -> EPL club moves: ${eplEpl}`);
console.log(`\n→ ${OUT}`);
