/**
 * Cross-league PRODUCTION translation. Research only; nothing reaches a xPts.
 *
 * ── P0 cannot be reconstructed, and saying so is the point ──
 *
 * The live production fallback is `pricePrior(p)`, which returns expected FPL
 * POINTS PER APPEARANCE from price and position. The targets here are per-90
 * EVENT rates — goals, shots, key passes. Those are different units, and
 * scoring one against the other would repeat exactly the semantic error the O0
 * audit caught. Historical FPL price is also absent from the warehouse for most
 * of these players, several of whom were never in FPL at all.
 *
 * So P0 is reported as NOT RECONSTRUCTIBLE for event-rate targets, and P1 —
 * the position-level production prior fitted on training data — is the honest
 * incumbent-shaped control. P6 (price hybrid) is likewise unavailable
 * historically and is registered rather than fitted.
 *
 * ── saves is not a goalkeeper statistic ──
 *
 * Measured across 4,133 Tier-B player-seasons: `saves` is non-zero for 65% of
 * DEFENDERS and 57% of midfielders. Like `attemptsInBox` before it, it is a
 * team-level quantity sitting in a player block. The goalkeeper production
 * track is therefore not buildable from this feed and is not attempted.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { assertModelSafe } from '../field-registry.mjs';

const OUT = 'data/warehouse/research/production-translation.json';
const COHORT = 'data/warehouse/research/opportunity-cohort.json';
const THRESHOLDS = [180, 450, 900, 1800];
/* Player-level attacking metrics only. Defensive fields sit at 25-30% non-zero
   and share a block with a field already proven team-level, so they are left
   out rather than trusted. */
const METRICS = ['goals', 'assists', 'shots', 'shotsOnTarget', 'keyPasses'];
/* Executable, not decorative: an unregistered or rejected field fails the run
   rather than being modelled on the strength of its name. This is what stops a
   fourth `saves` reaching a model. */
assertModelSafe(METRICS, 'production translation');
const TRAIN_SEASON = 2024; const TEST_SEASON = 2025;

/* ---- per-90 rates on both sides of each episode ------------------- */
const episodes = JSON.parse(fs.readFileSync(COHORT, 'utf8')).cohort;
const tierB = new Map();
for (const c of COMPETITIONS) {
  for (const s of seasonsFor('espn')) {
    const rows = await readRows(paths.espnPlayerSeasons(c.key, s));
    if (rows.length) tierB.set(`${c.key}|${s}`, new Map(rows.map((r) => [r.espnId, r])));
  }
}
const per90 = (row, f) => (row && row.minutes > 0 && row[f] != null ? (row[f] / row.minutes) * 90 : null);

const rows = [];
for (const e of episodes) {
  const s = tierB.get(`${e.sourceCompetition}|${e.sourceSeason}`)?.get(e.espnId);
  const d = tierB.get(`eng.1|${e.destSeason}`)?.get(e.espnId);
  if (!s || !d) continue;
  const r = { ...e, srcMin: s.minutes, dstMin: d.minutes };
  for (const m of METRICS) { r[`src_${m}`] = per90(s, m); r[`dst_${m}`] = per90(d, m); }
  rows.push(r);
}

/* ---- D. cohort sizes at every threshold --------------------------- */
const cohortTable = {};
for (const t of THRESHOLDS) {
  const kept = rows.filter((r) => r.srcMin >= t && r.dstMin >= t);
  cohortTable[t] = { total: kept.length, byType: {}, bySource: {} };
  for (const r of kept) {
    cohortTable[t].byType[r.type] = (cohortTable[t].byType[r.type] || 0) + 1;
    cohortTable[t].bySource[r.sourceCompetition] = (cohortTable[t].bySource[r.sourceCompetition] || 0) + 1;
  }
}

/* ---- helpers ------------------------------------------------------ */
function pearson(p) {
  const n = p.length; if (n < 6) return null;
  const mx = p.reduce((a, b) => a + b[0], 0) / n; const my = p.reduce((a, b) => a + b[1], 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const z = 0.5 * Math.log((1 + r) / (1 - r)); const se = 1 / Math.sqrt(n - 3);
  return { n, r: +r.toFixed(3), ci: [+Math.tanh(z - 1.96 * se).toFixed(3), +Math.tanh(z + 1.96 * se).toFixed(3)] };
}
function spearman(p) {
  const n = p.length; if (n < 4) return null;
  const v = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.reduce((x, y) => x + (y - m) ** 2, 0); };
  if (v(p.map((x) => x[0])) < 1e-12 || v(p.map((x) => x[1])) < 1e-12) return null;   // constant -> NA
  const rk = (a) => { const i = a.map((val, j) => [val, j]).sort((x, y) => x[0] - y[0]); const r = new Array(n); i.forEach(([, j], k) => { r[j] = k + 1; }); return r; };
  const rx = rk(p.map((x) => x[0])); const ry = rk(p.map((x) => x[1]));
  let d = 0; for (let i = 0; i < n; i++) d += (rx[i] - ry[i]) ** 2;
  return +(1 - (6 * d) / (n * (n * n - 1))).toFixed(3);
}
const rng = (s) => { let x = s >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };

/* ---- F/G/H/I. persistence by episode type, per metric ------------- */
const MIN_MIN = 450;
const persistence = {};
for (const m of METRICS) {
  persistence[m] = {};
  for (const type of ['EPL_TO_EPL_TRANSFER', 'SAME_CLUB_PROMOTION', 'FOREIGN_TO_EPL_TRANSFER', 'CHAMPIONSHIP_TO_EPL_TRANSFER']) {
    const g = rows.filter((r) => r.type === type && r.srcMin >= MIN_MIN && r.dstMin >= MIN_MIN
      && r[`src_${m}`] != null && r[`dst_${m}`] != null);
    const p = pearson(g.map((r) => [r[`src_${m}`], r[`dst_${m}`]]));
    const ms = g.length ? g.reduce((a, r) => a + r[`src_${m}`], 0) / g.length : null;
    const md = g.length ? g.reduce((a, r) => a + r[`dst_${m}`], 0) / g.length : null;
    persistence[m][type] = { n: g.length, r: p?.r ?? null, ci: p?.ci ?? null,
      srcMean: ms == null ? null : +ms.toFixed(3), dstMean: md == null ? null : +md.toFixed(3),
      retained: ms ? +((md / ms) * 100).toFixed(0) : null };
  }
}

/* ---- J/N. candidates, chronological ------------------------------- */
function fitProduction(train) {
  const p = { global: {}, byPosition: {}, byLeague: {}, slope: {}, k: {} };
  const mean = (rs, f) => { const v = rs.map(f).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
  for (const m of METRICS) {
    p.global[m] = mean(train, (r) => r[`dst_${m}`]);
    const groups = {};
    for (const r of train) (groups[r.position] ??= []).push(r);
    p.byPosition[m] = {};
    for (const [g, rs] of Object.entries(groups)) {
      const w = rs.length / (rs.length + 10);
      p.byPosition[m][g] = w * mean(rs, (r) => r[`dst_${m}`]) + (1 - w) * p.global[m];
    }
    const lg = {};
    for (const r of train) (lg[r.sourceCompetition] ??= []).push(r);
    p.byLeague[m] = {};
    for (const [g, rs] of Object.entries(lg)) {
      const w = rs.length / (rs.length + 10);
      p.byLeague[m][g] = w * mean(rs, (r) => r[`dst_${m}`]) + (1 - w) * p.global[m];
    }
    /* Pooled translation slope: dst = a + b * src, least squares on TRAINING. */
    const pts = train.filter((r) => Number.isFinite(r[`src_${m}`]) && Number.isFinite(r[`dst_${m}`]))
      .map((r) => [r[`src_${m}`], r[`dst_${m}`]]);
    if (pts.length >= 6) {
      const mx = pts.reduce((a, b) => a + b[0], 0) / pts.length; const my = pts.reduce((a, b) => a + b[1], 0) / pts.length;
      let sxy = 0; let sxx = 0;
      for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
      p.slope[m] = sxx ? { b: sxy / sxx, a: my - (sxy / sxx) * mx } : { b: 0, a: my };
    } else p.slope[m] = { b: 0, a: p.global[m] };
    /* Shrinkage on source minutes, swept on TRAINING only, Infinity included. */
    let best = { k: Infinity, mae: Infinity };
    for (const k of [50, 100, 250, 500, 900, 1800, 3600, Infinity]) {
      const errs = train.map((r) => {
        const w = Number.isFinite(k) ? r.srcMin / (r.srcMin + k) : 0;
        return Math.abs((w * (r[`src_${m}`] ?? p.global[m]) + (1 - w) * p.global[m]) - r[`dst_${m}`]);
      }).filter(Number.isFinite);
      const mae = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
      if (mae < best.mae) best = { k, mae };
    }
    p.k[m] = best.k;
  }
  return p;
}

const CAND = {
  P1: { label: 'position production prior (no source)', f: (r, p, m) => p.byPosition[m][r.position] ?? p.global[m] },
  P2: { label: 'raw source rate, 1:1 (no translation)', f: (r, p, m) => r[`src_${m}`] ?? p.global[m] },
  P3: { label: 'shrunk source rate', f: (r, p, m) => {
    const k = p.k[m]; const w = Number.isFinite(k) ? r.srcMin / (r.srcMin + k) : 0;
    return w * (r[`src_${m}`] ?? p.global[m]) + (1 - w) * p.global[m]; } },
  P4: { label: 'pooled translation (fitted slope)', f: (r, p, m) => {
    const s = r[`src_${m}`]; return s == null ? p.global[m] : p.slope[m].a + p.slope[m].b * s; } },
  P5: { label: 'league-aware (slope + league level)', f: (r, p, m) => {
    const s = r[`src_${m}`]; const lvl = p.byLeague[m][r.sourceCompetition] ?? p.global[m];
    return s == null ? lvl : (p.slope[m].a + p.slope[m].b * s) * 0.5 + lvl * 0.5; } },
};

function score(test, p, cand, m) {
  const pts = test.map((r) => [cand.f(r, p, m), r[`dst_${m}`]]).filter((x) => Number.isFinite(x[0]) && Number.isFinite(x[1]));
  if (pts.length < 6) return null;
  const n = pts.length; const errs = pts.map(([a, b]) => b - a);
  const sumP = pts.reduce((a, b) => a + b[0], 0); const sumA = pts.reduce((a, b) => a + b[1], 0);
  return { n, mae: +(errs.reduce((a, b) => a + Math.abs(b), 0) / n).toFixed(4),
    rmse: +Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / n).toFixed(4),
    bias: +(errs.reduce((a, b) => a + b, 0) / n).toFixed(4),
    rho: spearman(pts), calib: sumP ? +(sumA / sumP).toFixed(3) : null };
}
function boot(test, p, A, B, m, seed = 20260829, it = 2000) {
  const r = rng(seed); const idx = test.map((_, i) => i)
    .filter((i) => Number.isFinite(A.f(test[i], p, m)) && Number.isFinite(B.f(test[i], p, m)) && Number.isFinite(test[i][`dst_${m}`]));
  if (idx.length < 8) return null;
  const d = [];
  for (let b = 0; b < it; b++) {
    let sa = 0; let sb = 0;
    for (let j = 0; j < idx.length; j++) {
      const i = idx[Math.floor(r() * idx.length)];
      sa += Math.abs(test[i][`dst_${m}`] - A.f(test[i], p, m));
      sb += Math.abs(test[i][`dst_${m}`] - B.f(test[i], p, m));
    }
    d.push((sb - sa) / idx.length);
  }
  d.sort((x, y) => x - y); const q = (v) => d[Math.floor(v * (d.length - 1))];
  return { dMAE: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(4), ci: [+q(0.025).toFixed(4), +q(0.975).toFixed(4)],
    p: +(d.filter((x) => x > 0).length / d.length).toFixed(3) };
}

const THRESH = Number(process.env.PROD_THRESHOLD || 450);
const usable = rows.filter((r) => r.srcMin >= THRESH && r.dstMin >= THRESH);
const train = usable.filter((r) => r.destSeason === TRAIN_SEASON);
const test = usable.filter((r) => r.destSeason === TEST_SEASON);

const results = { threshold: THRESH, trainN: train.length, testN: test.length, cohortTable, persistence, metrics: {} };
if (train.length >= 10 && test.length >= 10) {
  const p = fitProduction(train);
  results.fitted = { k: Object.fromEntries(Object.entries(p.k).map(([m, k]) => [m, Number.isFinite(k) ? k : 'Inf'])),
    slope: Object.fromEntries(Object.entries(p.slope).map(([m, s]) => [m, { a: +s.a.toFixed(4), b: +s.b.toFixed(4) }])) };
  for (const m of METRICS) {
    results.metrics[m] = { scores: {}, vsP1: {} };
    for (const [name, c] of Object.entries(CAND)) results.metrics[m].scores[name] = score(test, p, c, m);
    for (const name of ['P2', 'P3', 'P4', 'P5']) results.metrics[m].vsP1[name] = boot(test, p, CAND[name], CAND.P1, m);
  }
}
results.notReconstructible = {
  P0: 'Live fallback pricePrior() returns POINTS PER APPEARANCE, not per-90 event rates — different units. '
    + 'Historical FPL price is also absent for most of these players. NOT RECONSTRUCTIBLE for these targets.',
  P6: 'Price + translated hybrid requires historical FPL price. Registered, not fitted.',
  goalkeepers: 'saves is non-zero for 65% of defenders and 57% of midfielders across 4,133 player-seasons — '
    + 'a team-level quantity in a player block, like attemptsInBox. GK production track NOT buildable.',
};
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

/* ---- console ------------------------------------------------------ */
console.log('PRODUCTION TRANSLATION — research only\n');
console.log('D. cohort by destination-minute threshold (both sides)');
console.log('  thresh  total   ' + Object.keys(cohortTable[180].byType).join('  '));
for (const t of THRESHOLDS) {
  console.log('  ' + String(t).padEnd(8) + String(cohortTable[t].total).padStart(5) + '   '
    + Object.entries(cohortTable[t].byType).map(([k, v]) => k.slice(0, 12) + ' ' + v).join('  '));
}
console.log('\nG/H/I. persistence of source rate into the EPL (both sides >=450 min)');
for (const m of METRICS) {
  console.log(`  ${m}`);
  for (const [t, v] of Object.entries(persistence[m])) {
    if (!v.n) continue;
    console.log('    ' + t.slice(0, 28).padEnd(30) + 'n=' + String(v.n).padStart(3)
      + '  r=' + String(v.r ?? 'NA').padStart(6) + '  ' + (v.ci ? '[' + v.ci.join(', ') + ']' : '').padEnd(18)
      + '  ' + String(v.srcMean).padStart(6) + ' -> ' + String(v.dstMean).padStart(6) + '  (' + v.retained + '%)');
  }
}
if (results.fitted) {
  console.log(`\nJ/N. chronological: train ${TRAIN_SEASON} n=${train.length}, holdout ${TEST_SEASON} n=${test.length}, threshold ${THRESH}`);
  console.log('  fitted slope b (pooled translation): ' + Object.entries(results.fitted.slope).map(([m, s]) => m + ' ' + s.b).join('  '));
  console.log('  fitted shrinkage k: ' + JSON.stringify(results.fitted.k));
  for (const m of METRICS) {
    console.log(`\n  ── ${m} ──`);
    console.log('    model  description                             MAE     rho    calib   bias');
    for (const [name, c] of Object.entries(CAND)) {
      const s = results.metrics[m].scores[name]; if (!s) continue;
      console.log('    ' + name.padEnd(6) + c.label.slice(0, 38).padEnd(40)
        + String(s.mae).padStart(7) + String(s.rho ?? 'NA').padStart(8) + String(s.calib ?? 'NA').padStart(8)
        + String(s.bias).padStart(9) + (name === 'P1' ? '  <= control' : ''));
    }
    const b = results.metrics[m].vsP1;
    console.log('    vs P1: ' + Object.entries(b).filter(([, v]) => v)
      .map(([k, v]) => `${k} dMAE ${v.dMAE} [${v.ci[0]}, ${v.ci[1]}] P ${v.p}`).join('   '));
  }
} else console.log('\nInsufficient cohort at this threshold for a chronological split.');
console.log(`\n→ ${OUT}`);
