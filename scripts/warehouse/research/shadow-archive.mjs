/**
 * Frozen prospective candidates for 2026/27 arrivals. NOT a projection.
 *
 * ── Why this is not "pre-season prospective" ──
 *
 * The season has already started. Anything scored against gameweeks that have
 * already been played is retrospective, however the file is labelled. So the
 * archive records the first gameweek that is genuinely unresolved at freeze
 * time and only that gameweek onward may ever be quoted as prospective
 * evidence.
 *
 * ── No current-season leakage ──
 *
 * Every candidate is built from SOURCE-season evidence only. No 2026/27 EPL
 * starts, minutes, appearances, goals or assists enter the candidate — not even
 * indirectly through a fitted parameter, because the parameters come from the
 * 2024 training cohort. The live model has of course seen those gameweeks; that
 * is recorded separately as `liveModelState` so the two are never confused.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';
import { datasetVersion } from '../version.mjs';

const OUT = 'data/warehouse/research/shadow-archive.json';
const SOURCE_SEASON = 2025;
const DEST_SEASON = 2026;

const models = JSON.parse(fs.readFileSync('data/warehouse/research/opportunity-models.json', 'utf8'));
const P = models.fitted;

/* first unresolved gameweek at freeze time */
const boot = JSON.parse(fs.readFileSync('data/bootstrap.json', 'utf8'));
const firstScorable = boot.events.find((e) => !e.finished && !e.is_current)?.id
  ?? (boot.events.find((e) => e.is_next)?.id ?? null);

/* ---- who arrived ---- */
const where = new Map(); const meta = new Map();
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const s of seasonsFor('football-data')) {
    for (const t of await readRows(paths.fdTeams(comp.key, s))) {
      const tla = canonicalTla('football-data', t.tla, comp.key);
      for (const p of t.squad || []) {
        if (!where.has(p.playerId)) where.set(p.playerId, new Map());
        const b = where.get(p.playerId);
        if (!b.has(s)) b.set(s, []);
        b.get(s).push({ competition: comp.key, team: tla });
        if (!meta.has(p.playerId)) meta.set(p.playerId, { name: p.name, position: p.position ?? null });
      }
    }
  }
}
const xref = await readRows(paths.playerXref());
const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));
const srcTierB = new Map();
for (const c of COMPETITIONS) {
  const rows = await readRows(paths.espnPlayerSeasons(c.key, SOURCE_SEASON));
  if (rows.length) srcTierB.set(c.key, new Map(rows.map((r) => [r.espnId, r])));
}
const clubFixtures = new Map();
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const m of await readRows(paths.fdMatches(comp.key, SOURCE_SEASON))) {
    if (m.homeGoals == null) continue;
    for (const tla of [m.homeTeamTla, m.awayTeamTla]) {
      const k = `${comp.key}|${canonicalTla('football-data', tla, comp.key)}`;
      clubFixtures.set(k, (clubFixtures.get(k) || 0) + 1);
    }
  }
}

const shrink = (rate, apps, prior, k) => {
  if (rate == null) return prior;
  if (!Number.isFinite(k)) return prior;
  const w = apps / (apps + k);
  return w * rate + (1 - w) * prior;
};
const T = ['featureRate', 'startRate', 'minutesRate'];

const rows = [];
for (const [pid, bys] of where) {
  const from = (bys.get(SOURCE_SEASON) || []).filter((x) => !x.competition.startsWith('uefa.'));
  const to = (bys.get(DEST_SEASON) || []).filter((x) => !x.competition.startsWith('uefa.'));
  const dst = to.find((x) => x.competition === 'eng.1');
  if (!dst || from.length !== 1 || to.length > 1) continue;
  const src = from[0];
  if (src.competition === 'eng.1' && src.team === dst.team) continue;

  let type;
  if (src.competition === 'eng.1') type = 'EPL_TO_EPL_TRANSFER';
  else if (src.competition === 'eng.2' && src.team === dst.team) type = 'SAME_CLUB_PROMOTION';
  else if (src.competition === 'eng.2') type = 'CHAMPIONSHIP_TO_EPL_TRANSFER';
  else if (src.team === dst.team) continue;
  else type = 'FOREIGN_TO_EPL_TRANSFER';

  const espnId = espnByFd.get(pid);
  if (!espnId) continue;
  const s = srcTierB.get(src.competition)?.get(espnId);
  if (!s) continue;
  const fx = clubFixtures.get(`${src.competition}|${src.team}`) ?? null;
  if (!fx) continue;

  const m = meta.get(pid);
  const srcRates = {
    featureRate: s.appearances / fx, startRate: s.starts / fx, minutesRate: s.minutes / fx,
  };
  const posLvl = P.byPosition[m.position] ?? P.global;
  const cand = {};
  for (const t of T) {
    cand[t] = shrink(srcRates[t], s.appearances ?? 0, posLvl[t] ?? P.global[t], P.k[t] ?? Infinity);
  }
  /* Shaped as the components production consumes, never one opaque score. */
  const featuredRate = Math.max(0, Math.min(1, cand.featureRate));
  const startRateGivenFeatured = featuredRate > 0 ? Math.max(0, Math.min(1, cand.startRate / featuredRate)) : 0;
  const minsPerStart = s.starts > 0 ? Math.max(45, Math.min(90, s.minutes / s.starts)) : null;

  rows.push({
    name: m.name, position: m.position, espnId, footballDataPlayerId: pid,
    episodeType: type,
    sourceCompetition: src.competition, sourceTeam: src.team, destTeam: dst.team,
    sourceFixtures: fx, sourceAppearances: s.appearances, sourceStarts: s.starts, sourceMinutes: s.minutes,
    sourceFeatureRate: +srcRates.featureRate.toFixed(4),
    sourceStartRate: +srcRates.startRate.toFixed(4),
    baselineO0b: Object.fromEntries(T.map((t) => [t, +P.global[t].toFixed(4)])),
    baselineO0c: Object.fromEntries(T.map((t) => [t, +(posLvl[t] ?? P.global[t]).toFixed(4)])),
    candidateO3: Object.fromEntries(T.map((t) => [t, +cand[t].toFixed(4)])),
    productionShape: {
      featuredRate: +featuredRate.toFixed(4),
      startRateGivenFeatured: +startRateGivenFeatured.toFixed(4),
      minsPerStart: minsPerStart == null ? null : +minsPerStart.toFixed(1),
    },
    evidenceStrength: { sourceAppearances: s.appearances, shrinkageWeight: T.reduce((a, t) => {
      const k = P.k[t]; a[t] = Number.isFinite(k) ? +((s.appearances) / (s.appearances + k)).toFixed(4) : 0; return a;
    }, {}) },
  });
}

const version = await datasetVersion();
const archive = {
  capturedAt: new Date().toISOString(),
  status: 'FROZEN — PROSPECTIVE FROM FREEZE DATE',
  firstScorableGW: firstScorable,
  scoringRule: `Only gameweek ${firstScorable} onward may be quoted as prospective evidence. `
    + 'Gameweeks already played at freeze time are retrospective and must not be scored as a forward test.',
  leakage: 'Candidates use SOURCE-season evidence only. No 2026/27 EPL starts, minutes, appearances, goals or '
    + 'assists enter them, and the fitted parameters come from the 2024 training cohort.',
  liveModelState: 'The production model has separately observed the completed 2026/27 gameweeks. That is its own '
    + 'state and is deliberately not mixed into these candidates.',
  modelVersion: { trainSeason: models.trainSeason, testSeason: models.testSeason, shrinkageK: models.fitted.k },
  warehouse: { schemaVersion: version.schemaVersion, coverageDigest: version.coverageDigest },
  n: rows.length,
  players: rows.sort((a, b) => b.sourceStartRate - a.sourceStartRate),
};
fs.writeFileSync(OUT, JSON.stringify(archive, null, 1));

console.log('SHADOW ARCHIVE — frozen, prospective from GW' + firstScorable + '\n');
console.log(`  ${rows.length} incoming 2026/27 players archived`);
const byType = rows.reduce((a, r) => { a[r.episodeType] = (a[r.episodeType] || 0) + 1; return a; }, {});
console.log('  by type: ' + JSON.stringify(byType));
console.log('\n  sample (highest source start rate):');
console.log('  player            type                  src         O0b    O0c    O3   | featRate startGF minsPS');
for (const r of rows.slice(0, 8)) {
  console.log('  ' + String(r.name).slice(0, 17).padEnd(18) + r.episodeType.slice(0, 21).padEnd(22)
    + String(r.sourceStartRate.toFixed(2)).padStart(5)
    + String(r.baselineO0b.startRate.toFixed(3)).padStart(8) + String(r.baselineO0c.startRate.toFixed(3)).padStart(7)
    + String(r.candidateO3.startRate.toFixed(3)).padStart(7)
    + '  |' + String(r.productionShape.featuredRate.toFixed(2)).padStart(7)
    + String(r.productionShape.startRateGivenFeatured.toFixed(2)).padStart(8)
    + String(r.productionShape.minsPerStart ?? '-').padStart(7));
}
console.log(`\n→ ${OUT}`);
