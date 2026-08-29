/**
 * The control Milestone 3 was missing: players who stayed put.
 *
 * Milestone 3 found foreign->EPL persistence equal to or higher than EPL->EPL
 * persistence, which already argued against a league-quality penalty. But both
 * of those involve a club change, so neither establishes the natural ceiling —
 * how well one Premier League season predicts the next for a player who changed
 * nothing at all.
 *
 * Without that ceiling, a slope of 0.71 looks like a transition discount. With
 * it, the question becomes answerable: if a player who stayed at the same club
 * regresses about as much, then what Milestone 3 measured is ordinary
 * season-to-season reliability of a noisy volume statistic, and the correct
 * model carries no transition coefficient at all.
 *
 * These episodes were already being counted and discarded — the opportunity
 * attrition line "stayed at the same EPL club (not a transition)" held 1,027 of
 * them. They were never a gap in the data, only in the analysis.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';
import { assertModelSafe } from '../field-registry.mjs';

const OUT = 'data/warehouse/research/same-club-control.json';
const METRICS = ['shots', 'shotsOnTarget', 'keyPasses', 'goals', 'assists'];
assertModelSafe(METRICS, 'same-club control');
const THRESHOLDS = [180, 450, 900, 1800];

/* squads */
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
const tierB = new Map();
for (const s of seasonsFor('espn')) {
  const rows = await readRows(paths.espnPlayerSeasons('eng.1', s));
  if (rows.length) tierB.set(s, new Map(rows.map((r) => [r.espnId, r])));
}
const per90 = (row, f) => (row && row.minutes > 0 && row[f] != null ? (row[f] / row.minutes) * 90 : null);

/* same club, eng.1 -> eng.1, consecutive seasons */
const rows = [];
for (const [pid, bys] of where) {
  const seasons = [...bys.keys()].sort((a, b) => a - b);
  for (let i = 0; i < seasons.length - 1; i++) {
    const a = seasons[i]; const b = seasons[i + 1];
    if (b !== a + 1) continue;
    const from = (bys.get(a) || []).filter((x) => !x.competition.startsWith('uefa.'));
    const to = (bys.get(b) || []).filter((x) => !x.competition.startsWith('uefa.'));
    if (from.length !== 1 || to.length !== 1) continue;
    /* The defining condition: same competition AND same club. Anything else is
       a transfer and belongs to the other cohorts. */
    if (from[0].competition !== 'eng.1' || to[0].competition !== 'eng.1') continue;
    if (from[0].team !== to[0].team) continue;
    const espnId = espnByFd.get(pid);
    if (!espnId) continue;
    const s = tierB.get(a)?.get(espnId); const d = tierB.get(b)?.get(espnId);
    if (!s || !d) continue;
    /* This cohort is a PRODUCTION control, and a per-90 rate needs a
       denominator. A zero-minute season is a legitimate measured zero and is
       kept everywhere else in the warehouse — it simply cannot express a rate,
       so it is excluded HERE and only here, with the reason stated. */
    if (!(s.minutes > 0) || !(d.minutes > 0)) continue;
    const r = { espnId, name: meta.get(pid)?.name, position: meta.get(pid)?.position,
      club: from[0].team, fromSeason: a, toSeason: b, srcMin: s.minutes, dstMin: d.minutes,
      type: 'SAME_CLUB_EPL' };
    for (const m of METRICS) { r[`src_${m}`] = per90(s, m); r[`dst_${m}`] = per90(d, m); }
    rows.push(r);
  }
}

function pearson(p) {
  const n = p.length; if (n < 6) return null;
  const mx = p.reduce((a, b) => a + b[0], 0) / n; const my = p.reduce((a, b) => a + b[1], 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const z = 0.5 * Math.log((1 + r) / (1 - r)); const se = 1 / Math.sqrt(n - 3);
  return { n, r: +r.toFixed(3), ci: [+Math.tanh(z - 1.96 * se).toFixed(3), +Math.tanh(z + 1.96 * se).toFixed(3)],
    slope: +(sxy / sxx).toFixed(3) };
}

const result = { builtAt: new Date().toISOString(), episodes: rows.length, byThreshold: {} };
for (const t of THRESHOLDS) {
  const kept = rows.filter((r) => r.srcMin >= t && r.dstMin >= t);
  result.byThreshold[t] = { n: kept.length, metrics: {} };
  for (const m of METRICS) {
    const pts = kept.filter((r) => r[`src_${m}`] != null && r[`dst_${m}`] != null).map((r) => [r[`src_${m}`], r[`dst_${m}`]]);
    const p = pearson(pts);
    const ms = pts.length ? pts.reduce((a, b) => a + b[0], 0) / pts.length : null;
    const md = pts.length ? pts.reduce((a, b) => a + b[1], 0) / pts.length : null;
    result.byThreshold[t].metrics[m] = { ...(p ?? { n: pts.length, r: null }),
      srcMean: ms == null ? null : +ms.toFixed(3), dstMean: md == null ? null : +md.toFixed(3),
      retained: ms ? +((md / ms) * 100).toFixed(0) : null };
  }
}
fs.writeFileSync(OUT, JSON.stringify({ ...result, cohort: rows }, null, 1));

console.log('SAME-CLUB EPL CONTROL — the natural ceiling\n');
console.log(`  ${rows.length} same-club eng.1 season pairs with Tier B on both sides\n`);
for (const t of THRESHOLDS) {
  const b = result.byThreshold[t];
  if (!b.n) continue;
  console.log(`  threshold ${t} minutes both sides, n=${b.n}`);
  console.log('    metric           n    r       95% CI            slope   src -> dst      retained');
  for (const m of METRICS) {
    const v = b.metrics[m];
    if (!v || v.r == null) { console.log('    ' + m.padEnd(16) + 'insufficient'); continue; }
    console.log('    ' + m.padEnd(16) + String(v.n).padStart(4) + '  ' + String(v.r).padStart(6)
      + '  [' + v.ci.join(', ') + ']'.padEnd(4) + String(v.slope).padStart(8)
      + '   ' + String(v.srcMean).padStart(6) + ' -> ' + String(v.dstMean).padStart(6)
      + '   ' + String(v.retained + '%').padStart(6));
  }
  console.log();
}
console.log(`→ ${OUT}`);
