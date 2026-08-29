/**
 * How robust is the ~14% transfer-associated level shift?
 *
 * Milestone 4 reported point estimates only: same-club shots retention 98%,
 * EPL-to-EPL 85%, foreign 86%. That comparison carries the whole production
 * verdict, so it needs uncertainty, and it needs to survive reasonable changes
 * to the evidence threshold and the position mix.
 *
 * ── What this deliberately does NOT do ──
 *
 * Nothing here retunes a predictive model. The 2025 holdout has been inspected
 * repeatedly and is frozen; this is interpretation and robustness only. No
 * threshold is chosen because it produces a cleaner result — all four are
 * reported, including any that disagree.
 *
 * ── And what the result can and cannot mean ──
 *
 * Even a stable gap is TRANSFER-ASSOCIATED, not transfer-caused. Players who
 * move differ from players who stay in ways this cohort cannot control: role,
 * age, destination squad quality, and selection into the both-sides-minutes
 * requirement. Part 5 runs one descriptive adjusted check to see whether an
 * effect survives the obvious observed differences; it cannot rule out the
 * unobserved ones.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { assertModelSafe } from '../field-registry.mjs';

const OUT = 'data/warehouse/research/transition-robustness.json';
const METRICS = ['shots', 'shotsOnTarget', 'keyPasses', 'goals', 'assists'];
assertModelSafe(METRICS, 'transition robustness');
const THRESHOLDS = [180, 450, 900, 1800];

const same = JSON.parse(fs.readFileSync('data/warehouse/research/same-club-control.json', 'utf8')).cohort;
const prod = JSON.parse(fs.readFileSync('data/warehouse/research/production-translation.json', 'utf8'));
const oppCohort = JSON.parse(fs.readFileSync('data/warehouse/research/opportunity-cohort.json', 'utf8')).cohort;

/* Rebuild the transfer rows with per-90 on both sides, same construction as the
   production module, so the two cohorts are directly comparable. */
import { COMPETITIONS, seasonsFor } from '../config.mjs';
const tierB = new Map();
for (const c of COMPETITIONS) {
  for (const s of seasonsFor('espn')) {
    const rows = await readRows(paths.espnPlayerSeasons(c.key, s));
    if (rows.length) tierB.set(`${c.key}|${s}`, new Map(rows.map((r) => [r.espnId, r])));
  }
}
const per90 = (row, f) => (row && row.minutes > 0 && row[f] != null ? (row[f] / row.minutes) * 90 : null);
const transfers = [];
for (const e of oppCohort) {
  const s = tierB.get(`${e.sourceCompetition}|${e.sourceSeason}`)?.get(e.espnId);
  const d = tierB.get(`eng.1|${e.destSeason}`)?.get(e.espnId);
  if (!s || !d || !(s.minutes > 0) || !(d.minutes > 0)) continue;
  const r = { ...e, srcMin: s.minutes, dstMin: d.minutes, group: e.type };
  for (const m of METRICS) { r[`src_${m}`] = per90(s, m); r[`dst_${m}`] = per90(d, m); }
  transfers.push(r);
}
const sameRows = same.map((r) => ({ ...r, group: 'SAME_CLUB_EPL' }));
const ALL = [...sameRows, ...transfers];

/* Retention = mean(destination rate) / mean(source rate) over a group. */
const retention = (rows, m) => {
  const pts = rows.filter((r) => Number.isFinite(r[`src_${m}`]) && Number.isFinite(r[`dst_${m}`]));
  if (pts.length < 6) return null;
  const s = pts.reduce((a, r) => a + r[`src_${m}`], 0) / pts.length;
  const d = pts.reduce((a, r) => a + r[`dst_${m}`], 0) / pts.length;
  return s ? { n: pts.length, retention: d / s } : null;
};
const rng = (seed) => { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };

/** Bootstrap the DIFFERENCE in retention between two groups. */
function diff(a, b, m, seed = 20260829, iters = 3000) {
  const A = a.filter((r) => Number.isFinite(r[`src_${m}`]) && Number.isFinite(r[`dst_${m}`]));
  const B = b.filter((r) => Number.isFinite(r[`src_${m}`]) && Number.isFinite(r[`dst_${m}`]));
  if (A.length < 8 || B.length < 8) return null;
  const r = rng(seed); const d = [];
  const ret = (rows) => {
    const s = rows.reduce((x, y) => x + y[`src_${m}`], 0) / rows.length;
    const dd = rows.reduce((x, y) => x + y[`dst_${m}`], 0) / rows.length;
    return s ? dd / s : null;
  };
  for (let i = 0; i < iters; i++) {
    const sa = Array.from({ length: A.length }, () => A[Math.floor(r() * A.length)]);
    const sb = Array.from({ length: B.length }, () => B[Math.floor(r() * B.length)]);
    const ra = ret(sa); const rb = ret(sb);
    if (ra != null && rb != null) d.push(ra - rb);
  }
  if (!d.length) return null;
  d.sort((x, y) => x - y); const q = (p) => d[Math.floor(p * (d.length - 1))];
  return { nA: A.length, nB: B.length,
    diff: +(d.reduce((x, y) => x + y, 0) / d.length).toFixed(4),
    ci: [+q(0.025).toFixed(4), +q(0.975).toFixed(4)],
    pPositive: +(d.filter((x) => x > 0).length / d.length).toFixed(3) };
}

const G = (rows, g, t) => rows.filter((r) => r.group === g && r.srcMin >= t && r.dstMin >= t);
const report = { builtAt: new Date().toISOString(), thresholds: {}, byPosition: {}, adjusted: {},
  caveat: 'TRANSFER-ASSOCIATED, not transfer-caused. Role, age, destination squad quality and selection '
    + 'into the both-sides-minutes requirement are uncontrolled.' };

/* ---- B + C. uncertainty, at every threshold ---------------------- */
for (const t of THRESHOLDS) {
  const sc = G(ALL, 'SAME_CLUB_EPL', t);
  const ee = G(ALL, 'EPL_TO_EPL_TRANSFER', t);
  const fe = G(ALL, 'FOREIGN_TO_EPL_TRANSFER', t);
  report.thresholds[t] = { n: { sameClub: sc.length, eplToEpl: ee.length, foreign: fe.length }, metrics: {} };
  for (const m of METRICS) {
    report.thresholds[t].metrics[m] = {
      retention: {
        sameClub: retention(sc, m)?.retention ?? null,
        eplToEpl: retention(ee, m)?.retention ?? null,
        foreign: retention(fe, m)?.retention ?? null,
      },
      'sameClub - eplToEpl': diff(sc, ee, m),
      'sameClub - foreign': diff(sc, fe, m),
      'eplToEpl - foreign': diff(ee, fe, m),
    };
  }
}

/* ---- D. position robustness -------------------------------------- */
const POS = { DEF: ['Defender', 'Defence', 'Centre-Back', 'Left-Back', 'Right-Back'],
  MID: ['Midfielder', 'Midfield', 'Central Midfield', 'Attacking Midfield', 'Defensive Midfield'],
  FWD: ['Forward', 'Attacker', 'Centre-Forward', 'Offence'] };
const posOf = (p) => {
  for (const [k, list] of Object.entries(POS)) if (list.some((x) => String(p || '').includes(x))) return k;
  return String(p || '').includes('Goalkeep') ? 'GK' : 'OTHER';
};
for (const t of [450]) {
  report.byPosition[t] = {};
  for (const pos of ['DEF', 'MID', 'FWD']) {
    const f = (g) => G(ALL, g, t).filter((r) => posOf(r.position) === pos);
    report.byPosition[t][pos] = { n: { sameClub: f('SAME_CLUB_EPL').length, eplToEpl: f('EPL_TO_EPL_TRANSFER').length, foreign: f('FOREIGN_TO_EPL_TRANSFER').length }, metrics: {} };
    for (const m of ['shots', 'keyPasses']) {
      report.byPosition[t][pos].metrics[m] = {
        sameClub: retention(f('SAME_CLUB_EPL'), m)?.retention ?? null,
        eplToEpl: retention(f('EPL_TO_EPL_TRANSFER'), m)?.retention ?? null,
        foreign: retention(f('FOREIGN_TO_EPL_TRANSFER'), m)?.retention ?? null,
        'sameClub - anyTransfer': diff(f('SAME_CLUB_EPL'), [...f('EPL_TO_EPL_TRANSFER'), ...f('FOREIGN_TO_EPL_TRANSFER')], m),
      };
    }
  }
}

/* ---- E. one descriptive adjusted check --------------------------- */
/* dst ~ src + isTransfer + isForeign + position, least squares. No destination
   information among the predictors. Deliberately small: four terms on a few
   hundred rows, no selection, reported unstable if it is. */
for (const m of ['shots', 'keyPasses']) {
  const rows = ALL.filter((r) => r.srcMin >= 450 && r.dstMin >= 450
    && Number.isFinite(r[`src_${m}`]) && Number.isFinite(r[`dst_${m}`]) && posOf(r.position) !== 'GK');
  if (rows.length < 60) { report.adjusted[m] = { note: 'too few rows' }; continue; }
  const X = rows.map((r) => [1, r[`src_${m}`], r.group === 'SAME_CLUB_EPL' ? 0 : 1,
    r.group === 'FOREIGN_TO_EPL_TRANSFER' ? 1 : 0, posOf(r.position) === 'MID' ? 1 : 0, posOf(r.position) === 'FWD' ? 1 : 0]);
  const y = rows.map((r) => r[`dst_${m}`]);
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b]; }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += 1e-6;          // tiny ridge for stability
  /* Gaussian elimination */
  const M2 = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r2 = c + 1; r2 < k; r2++) if (Math.abs(M2[r2][c]) > Math.abs(M2[piv][c])) piv = r2;
    [M2[c], M2[piv]] = [M2[piv], M2[c]];
    for (let r2 = 0; r2 < k; r2++) {
      if (r2 === c || Math.abs(M2[c][c]) < 1e-12) continue;
      const f = M2[r2][c] / M2[c][c];
      for (let cc = c; cc <= k; cc++) M2[r2][cc] -= f * M2[c][cc];
    }
  }
  const beta = M2.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
  report.adjusted[m] = { n: rows.length,
    terms: { intercept: +beta[0].toFixed(4), sourceRate: +beta[1].toFixed(4),
      isTransfer: +beta[2].toFixed(4), isForeign: +beta[3].toFixed(4),
      posMID: +beta[4].toFixed(4), posFWD: +beta[5].toFixed(4) },
    reading: 'isTransfer is the level shift after source rate and position. isForeign is any ADDITIONAL '
      + 'foreign effect on top of transferring at all — the number that would have to be non-zero for a '
      + 'league-specific penalty to exist.' };
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

/* ---- console ----------------------------------------------------- */
console.log('TRANSITION ROBUSTNESS — interpretation only, no retuning\n');
console.log('C. LEVEL RETENTION BY THRESHOLD (same-club / EPL->EPL / foreign)');
for (const t of THRESHOLDS) {
  const b = report.thresholds[t];
  console.log(`  ${t} min  (n ${b.n.sameClub}/${b.n.eplToEpl}/${b.n.foreign})`);
  for (const m of ['shots', 'shotsOnTarget', 'keyPasses']) {
    const r = b.metrics[m].retention;
    const pct = (v) => (v == null ? '  -  ' : (v * 100).toFixed(0) + '%');
    console.log('    ' + m.padEnd(15) + pct(r.sameClub).padStart(6) + pct(r.eplToEpl).padStart(9) + pct(r.foreign).padStart(9));
  }
}
console.log('\nB. BOOTSTRAP ON THE GAP, 450 minutes (positive = first group retains more)');
for (const m of METRICS) {
  const v = report.thresholds[450].metrics[m];
  for (const key of ['sameClub - eplToEpl', 'sameClub - foreign', 'eplToEpl - foreign']) {
    const d = v[key]; if (!d) continue;
    console.log('  ' + m.padEnd(15) + key.padEnd(22) + String(d.diff).padStart(8)
      + '  95% [' + d.ci[0] + ', ' + d.ci[1] + ']  P ' + d.pPositive + `  n ${d.nA}/${d.nB}`);
  }
}
console.log('\nD. BY POSITION, 450 minutes, shots retention');
for (const pos of ['DEF', 'MID', 'FWD']) {
  const p = report.byPosition[450][pos];
  const s = p.metrics.shots;
  const pct = (v) => (v == null ? ' - ' : (v * 100).toFixed(0) + '%');
  console.log('  ' + pos + '  n ' + p.n.sameClub + '/' + p.n.eplToEpl + '/' + p.n.foreign
    + '   same ' + pct(s.sameClub) + '  eplEpl ' + pct(s.eplToEpl) + '  foreign ' + pct(s.foreign)
    + (s['sameClub - anyTransfer'] ? '   gap ' + s['sameClub - anyTransfer'].diff
      + ' [' + s['sameClub - anyTransfer'].ci.join(', ') + ']' : ''));
}
console.log('\nE. ADJUSTED DESCRIPTIVE CHECK (dst ~ src + isTransfer + isForeign + position)');
for (const [m, a] of Object.entries(report.adjusted)) {
  if (!a.terms) { console.log('  ' + m + ': ' + a.note); continue; }
  console.log('  ' + m + '  n=' + a.n + '  ' + Object.entries(a.terms).map(([k2, v]) => k2 + ' ' + v).join('  '));
}
console.log(`\n→ ${OUT}`);
