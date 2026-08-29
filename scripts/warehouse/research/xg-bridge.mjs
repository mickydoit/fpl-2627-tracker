/**
 * Volume -> xG/xA bridge. Trained on 2025/26 ONLY, then frozen.
 *
 * ── Why fit now rather than wait ──
 *
 * There is exactly one season where warehouse volume and FPL expected goals
 * describe the same players in the same season: 2025/26, n≈297. That is not
 * enough for historical out-of-sample proof, and Milestone 4 correctly called
 * the bridge NOT TESTABLE on those terms.
 *
 * But it is enough to FIT. And fitting now, before 2026/27 outcomes exist,
 * converts an untestable idea into a genuinely prospective one. Waiting until
 * mid-season and then fitting on 2026/27 would spend the only clean validation
 * season we will get.
 *
 * ── What this is not ──
 *
 * Not cross-league xG. The question is narrower and answerable: given a
 * player's attacking VOLUME and position, what xG/xA profile is typical of a
 * Premier League player who shoots and creates that much? Volume travels;
 * this bridge only ever converts volume that has already arrived.
 *
 * Position must enter, because the descriptive slopes differ materially by
 * position — a single `shots x constant` conversion is exactly what Part 6
 * forbids.
 *
 * Model form is deliberately dull: ridge-regularised linear, five or six terms,
 * on ~297 rows. Anything more flexible would fit this one season and tell us
 * nothing about the next.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { assertModelSafe } from '../field-registry.mjs';
import { datasetVersion } from '../version.mjs';

const OUT = 'data/warehouse/research/xg-bridge-FROZEN.json';
const TRAIN_SEASON = 2025;
assertModelSafe(['shots', 'shotsOnTarget', 'keyPasses'], 'xg bridge');

/* ---- training join: warehouse volume x FPL xG, SAME season -------- */
const prior = JSON.parse(fs.readFileSync('data/draft/prior-2526.json', 'utf8'));
if (String(prior.season) !== '2025/26') throw new Error(`prior season is ${prior.season}, expected 2025/26`);
const identity = JSON.parse(fs.readFileSync('data/identity/players.json', 'utf8'));
const espnByCode = new Map(Object.values(identity.players).map((p) => [p.code, p.espnId]));
const wh = new Map((await readRows(paths.espnPlayerSeasons('eng.1', TRAIN_SEASON))).map((r) => [r.espnId, r]));

const POSNAME = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const train = [];
for (const [code, pr] of Object.entries(prior.players)) {
  const espnId = espnByCode.get(Number(code));
  if (!espnId) continue;
  const w = wh.get(espnId);
  if (!w) continue;
  const pm = Number(pr.minutes) || 0;
  if (!(w.minutes >= 450 && pm >= 450)) continue;
  const pos = POSNAME[pr.element_type];
  if (pos === 'GK') continue;                    // attacking volume only
  train.push({
    code: Number(code), espnId, name: pr.web_name, pos,
    shots90: (w.shots || 0) / w.minutes * 90,
    sot90: (w.shotsOnTarget || 0) / w.minutes * 90,
    kp90: (w.keyPasses || 0) / w.minutes * 90,
    xg90: (Number(pr.expected_goals) || 0) / pm * 90,
    xa90: (Number(pr.expected_assists) || 0) / pm * 90,
  });
}

/* ---- ridge least squares ------------------------------------------ */
function ridge(X, y, lambda) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) { b[a] += X[i][a] * y[i]; for (let c = 0; c < k; c++) A[a][c] += X[i][a] * X[i][c]; }
  }
  for (let a = 1; a < k; a++) A[a][a] += lambda;        // never penalise the intercept
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c || Math.abs(M[c][c]) < 1e-12) continue;
      const f = M[r][c] / M[c][c];
      for (let cc = c; cc <= k; cc++) M[r][cc] -= f * M[c][cc];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[k] / row[i]));
}
const isMID = (r) => (r.pos === 'MID' ? 1 : 0);
const isFWD = (r) => (r.pos === 'FWD' ? 1 : 0);

/* Position enters as BOTH a baseline shift and a slope interaction, because the
   descriptive conversion differed by position. */
const FORMS = {
  XG0: { target: 'xg90', label: 'position baseline only', x: (r) => [1, isMID(r), isFWD(r)] },
  XG1: { target: 'xg90', label: 'shots + position (baseline and slope)',
    x: (r) => [1, r.shots90, isMID(r), isFWD(r), r.shots90 * isMID(r), r.shots90 * isFWD(r)] },
  XG2: { target: 'xg90', label: 'shots + SOT + position',
    x: (r) => [1, r.shots90, r.sot90, isMID(r), isFWD(r), r.shots90 * isMID(r), r.shots90 * isFWD(r)] },
  XA0: { target: 'xa90', label: 'position baseline only', x: (r) => [1, isMID(r), isFWD(r)] },
  XA1: { target: 'xa90', label: 'key passes + position (baseline and slope)',
    x: (r) => [1, r.kp90, isMID(r), isFWD(r), r.kp90 * isMID(r), r.kp90 * isFWD(r)] },
};

/* ---- internal K-fold, DEVELOPMENT ONLY ---------------------------- */
const rng = (s) => { let x = s >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; };
function kfold(form, lambda, folds = 5, seed = 20260829) {
  const r = rng(seed);
  const idx = train.map((_, i) => i).sort(() => r() - 0.5);
  let se = 0; let ae = 0; let n = 0;
  for (let f = 0; f < folds; f++) {
    const testI = idx.filter((_, i) => i % folds === f);
    const trainI = idx.filter((_, i) => i % folds !== f);
    const beta = ridge(trainI.map((i) => form.x(train[i])), trainI.map((i) => train[i][form.target]), lambda);
    for (const i of testI) {
      const p = form.x(train[i]).reduce((a, v, j) => a + v * beta[j], 0);
      const e = train[i][form.target] - p; se += e * e; ae += Math.abs(e); n += 1;
    }
  }
  return { mae: +(ae / n).toFixed(5), rmse: +Math.sqrt(se / n).toFixed(5) };
}

const dev = {}; const fitted = {};
for (const [name, form] of Object.entries(FORMS)) {
  let best = { lambda: 0.01, mae: Infinity };
  for (const lambda of [0.001, 0.01, 0.1, 1, 10]) {
    const s = kfold(form, lambda);
    if (s.mae < best.mae) best = { lambda, ...s };
  }
  dev[name] = { label: form.label, target: form.target, ...best };
  fitted[name] = { target: form.target, lambda: best.lambda,
    coefficients: ridge(train.map(form.x), train.map((r) => r[form.target]), best.lambda).map((v) => +v.toFixed(6)) };
}

/* ---- freeze -------------------------------------------------------- */
const version = await datasetVersion();
const boot = JSON.parse(fs.readFileSync('data/bootstrap.json', 'utf8'));
const firstScorable = boot.events.find((e) => !e.finished && !e.is_current)?.id
  ?? boot.events.find((e) => e.is_next)?.id ?? null;

const frozen = {
  frozenAt: new Date().toISOString(),
  status: 'FROZEN — any change requires a NEW candidate version, not an edit to this one',
  trainingSeason: '2025/26', trainingN: train.length,
  trainingSource: 'warehouse eng.1 2025 Tier B volume x data/draft/prior-2526.json FPL xG/xA, same season, '
    + 'both sides >=450 minutes, goalkeepers excluded',
  validationStatus: 'NO EXTERNAL VALIDATION. One season of overlap. The K-fold figures below are '
    + 'INTERNAL MODEL DEVELOPMENT ONLY and are not out-of-sample proof.',
  forms: Object.fromEntries(Object.entries(FORMS).map(([k, v]) => [k, { label: v.label, target: v.target }])),
  development: dev,
  fitted,
  featureOrder: {
    XG0: ['1', 'isMID', 'isFWD'],
    XG1: ['1', 'shots90', 'isMID', 'isFWD', 'shots90*isMID', 'shots90*isFWD'],
    XG2: ['1', 'shots90', 'sot90', 'isMID', 'isFWD', 'shots90*isMID', 'shots90*isFWD'],
    XA0: ['1', 'isMID', 'isFWD'],
    XA1: ['1', 'kp90', 'isMID', 'isFWD', 'kp90*isMID', 'kp90*isFWD'],
  },
  units: 'INPUT shots/90, shotsOnTarget/90, keyPasses/90. OUTPUT xG/90, xA/90. These are different units '
    + 'from the inputs and must never be substituted for one another.',
  pricePrior: 'UNTOUCHED. This bridge is not a cold-start prior and does not replace price as the level prior.',
  firstScorableGW: firstScorable,
  warehouse: { schemaVersion: version.schemaVersion, coverageDigest: version.coverageDigest },
};
fs.writeFileSync(OUT, JSON.stringify(frozen, null, 1));

console.log('xG/xA BRIDGE — trained on 2025/26 only, frozen\n');
console.log(`  training rows: ${train.length} (outfield, both sides >=450 min)`);
console.log(`  by position: ${JSON.stringify(train.reduce((a, r) => { a[r.pos] = (a[r.pos] || 0) + 1; return a; }, {}))}`);
console.log('\n  I. INTERNAL DEVELOPMENT DIAGNOSTICS — NOT EXTERNAL VALIDATION');
console.log('  form  target  description                              lambda     MAE     RMSE');
for (const [k, v] of Object.entries(dev)) {
  console.log('  ' + k.padEnd(6) + v.target.padEnd(8) + v.label.slice(0, 38).padEnd(40)
    + String(v.lambda).padStart(6) + String(v.mae).padStart(9) + String(v.rmse).padStart(9));
}
console.log('\n  position slopes actually fitted (XG1 shots -> xG):');
const c = fitted.XG1.coefficients;
console.log(`    DEF  ${c[1].toFixed(4)}      MID  ${(c[1] + c[4]).toFixed(4)}      FWD  ${(c[1] + c[5]).toFixed(4)}`);
console.log('    a single universal conversion would have used one number for all three.');
console.log(`\n  firstScorableGW ${firstScorable}   digest ${version.coverageDigest}`);
console.log(`\n→ ${OUT}`);
