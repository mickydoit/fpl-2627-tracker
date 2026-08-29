/**
 * Opportunity translation — nested candidates against the real incumbent.
 *
 * NOTHING HERE TOUCHES A PROJECTION. It reads the warehouse, fits on the
 * earlier completed cohort, freezes, and scores the later one once.
 *
 * ── The control is the production code, not a description of it ──
 *
 * O0 reproduces what the tracker would actually believe about each arrival with
 * no cross-league evidence, by importing the same constants production uses —
 * `PRIOR_DEFAULTS`, `ESPN_TRANSITION` and `DEFAULTS` — rather than restating
 * them. If someone changes `MINUTES_PRIOR` or the ESPN minutes ceiling, this
 * control moves with it, which is the only way a comparison stays honest.
 *
 * ── What the target is ──
 *
 * Realised rate over the eligible fixture window. It absorbs injury and
 * suspension as well as selection, because no historical availability archive
 * exists. It is NOT P(start | available), and is not labelled as such anywhere.
 *
 * ── Chronological, and frozen ──
 *
 * Train on destination season 2024, score destination season 2025. One
 * direction only: future information cannot predict the past, and reversing the
 * split is not cross-validation. Every transformation and shrinkage constant is
 * fitted on training alone; the holdout is scored once.
 */
import fs from 'node:fs';
import { PRIOR_DEFAULTS, ESPN_TRANSITION } from '../../../js/prior.js';
import { DEFAULTS } from '../../../js/model.js';

const IN = 'data/warehouse/research/opportunity-cohort.json';
const OUT = 'data/warehouse/research/opportunity-models.json';
const TRAIN_SEASON = 2024;
const TEST_SEASON = 2025;

const cohort = JSON.parse(fs.readFileSync(IN, 'utf8')).cohort;
const train = cohort.filter((e) => e.destSeason === TRAIN_SEASON);
const test = cohort.filter((e) => e.destSeason === TEST_SEASON);

/* ------------------------------------------------------------------ *
 * O0 — the incumbent, reconstructed from production constants
 * ------------------------------------------------------------------ */
const MINUTES_PRIOR = { Goalkeeper: 24, Defender: 30, Midfielder: 27, Forward: 21 };
const priorMinutes = (pos) => MINUTES_PRIOR[pos] ?? 27;

/**
 * What `hydrate` + `projectFixture` produce for a player with no Premier League
 * record but an ESPN foreign season. Traced through the real code path:
 *
 *   hydrate      modelMinutes = espn.mpg * games,  mpg = srcMinutes / 38
 *                minutesEvidenceMinutes = min(srcMinutes * 0.65, ceiling * 450)
 *   projectFixture
 *                wMin    = clamp(minutesEvidence / minutesBlendMinutes, 0, 1)
 *                expMins = wMin * observedMpg + (1 - wMin) * minutesPrior(pos)
 *                pStart  = clamp((expMins - minsPerSub) / (minsPerStart - minsPerSub), 0, 1)
 *
 * `startProbability` is never set on this path, which is exactly why the
 * appearance fallback runs — and why it saturated before 28 August.
 */
function incumbent(e) {
  const mpg = Math.min(90, (e.srcMinutes ?? 0) / PRIOR_DEFAULTS.lastSeasonGames);
  const rawEvidence = (e.srcMinutes ?? 0) * ESPN_TRANSITION.minutesWeight;
  const evidence = Math.min(rawEvidence, ESPN_TRANSITION.minutesCeiling * DEFAULTS.minutesBlendMinutes);
  const wMin = Math.max(0, Math.min(1, evidence / DEFAULTS.minutesBlendMinutes));
  const expMins = Math.max(0, Math.min(90, wMin * mpg + (1 - wMin) * priorMinutes(e.position)));
  const pStart = Math.max(0, Math.min(1, (expMins - DEFAULTS.minsPerSub) / (DEFAULTS.minsPerStart - DEFAULTS.minsPerSub)));
  const pSub = Math.max(0, Math.min(1 - pStart, (expMins - pStart * DEFAULTS.minsPerStart) / DEFAULTS.minsPerSub));
  return { startRate: pStart, featureRate: Math.min(0.99, pStart + pSub), minutesRate: expMins };
}

/* ------------------------------------------------------------------ *
 * shrinkage
 * ------------------------------------------------------------------ */
/** Evidence-weighted shrink of a source rate toward a prior level. */
const shrink = (rate, appearances, prior, k) => {
  if (rate == null) return prior;
  if (!Number.isFinite(k)) return prior;          // k = Infinity: the prior itself
  const w = appearances / (appearances + k);
  return w * rate + (1 - w) * prior;
};

/* ------------------------------------------------------------------ *
 * candidates
 * ------------------------------------------------------------------ */
const TARGETS = ['featureRate', 'startRate', 'minutesRate'];

/** Fit everything a candidate needs from TRAINING data only. */
function fit(trainSet, opts = {}) {
  const mean = (rows, f) => {
    const v = rows.map(f).filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const params = { global: {}, byPosition: {}, byType: {}, byLeague: {}, k: {} };
  for (const t of TARGETS) params.global[t] = mean(trainSet, (e) => e[t]);

  for (const key of ['position', 'type', 'sourceCompetition']) {
    const bucket = key === 'position' ? 'byPosition' : key === 'type' ? 'byType' : 'byLeague';
    const groups = {};
    for (const e of trainSet) (groups[e[key]] ??= []).push(e);
    for (const [g, rows] of Object.entries(groups)) {
      params[bucket][g] = {};
      for (const t of TARGETS) {
        /* Group means are themselves shrunk toward the global mean by group
           size — a five-player league does not get its own level. */
        const w = rows.length / (rows.length + (opts.groupK ?? 10));
        params[bucket][g][t] = w * mean(rows, (e) => e[t]) + (1 - w) * params.global[t];
        params[bucket][g].n = rows.length;
      }
    }
  }

  /* Shrinkage strength, swept on TRAINING only. */
  for (const t of TARGETS) {
    const srcKey = t === 'minutesRate' ? 'srcMinutesRate' : t === 'startRate' ? 'srcStartRate' : 'srcFeatureRate';
    /* k = Infinity is the no-player-evidence prior. Including it makes the
       question explicit: does loss keep improving toward total shrinkage, or is
       there a finite optimum? If the answer is Infinity, source evidence
       contributes no useful LEVEL information under this target. */
    let best = { k: 10, mae: Infinity }; const curve = [];
    for (const k of [1, 2, 3, 5, 8, 12, 20, 30, 50, 75, 100, 150, 250, 500, 1000, 5000, Infinity]) {
      const errs = trainSet.map((e) => Math.abs(shrink(e[srcKey], e.srcAppearances ?? 0, params.global[t], k) - e[t]));
      const mae = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
      curve.push({ k: k === Infinity ? 'Inf' : k, mae: +mae.toFixed(5) });
      if (mae < best.mae) best = { k, mae };
    }
    params.k[t] = best.k;
    (params.curve ??= {})[t] = curve;
  }
  return params;
}

const CANDIDATES = {
  O0: { label: 'incumbent cold-start fallback', predict: (e) => incumbent(e) },
  /* The control that decides what any win MEANS.
   *
   * O0b uses no source evidence whatsoever — every arrival is predicted at the
   * training-set mean rate. If a candidate beats the incumbent but only matches
   * O0b, then source opportunity carried no information and the entire gain was
   * correcting the incumbent's LEVEL. That is still a useful finding, but it is
   * a completely different one from "previous role translates", and reporting
   * the first as the second would be the central error available here. */
  O0b: { label: 'generic new-player prior (training mean, NO source evidence)',
    predict: (e, p) => ({ featureRate: p.global.featureRate, startRate: p.global.startRate, minutesRate: p.global.minutesRate }) },
  /* Position means only — no player source evidence at all. This separates
     "position fixed the level" from "source role adds information", which is
     the distinction O3 alone cannot settle. */
  O0c: { label: 'position means only (NO source evidence)',
    predict: (e, p) => {
      const lvl = p.byPosition[e.position] ?? p.global;
      return Object.fromEntries(TARGETS.map((t) => [t, lvl[t] ?? p.global[t]]));
    } },
  O1: {
    label: 'source feature rate, shrunk',
    predict: (e, p) => {
      const f = shrink(e.srcFeatureRate, e.srcAppearances ?? 0, p.global.featureRate, p.k.featureRate);
      return { featureRate: f, startRate: f * (p.global.startRate / (p.global.featureRate || 1)), minutesRate: f * (p.global.minutesRate / (p.global.featureRate || 1)) };
    },
  },
  O2: {
    label: 'source feature + start rates, shrunk',
    predict: (e, p) => ({
      featureRate: shrink(e.srcFeatureRate, e.srcAppearances ?? 0, p.global.featureRate, p.k.featureRate),
      startRate: shrink(e.srcStartRate, e.srcAppearances ?? 0, p.global.startRate, p.k.startRate),
      minutesRate: shrink(e.srcMinutesRate, e.srcAppearances ?? 0, p.global.minutesRate, p.k.minutesRate),
    }),
  },
  O3: {
    label: 'O2 + position level',
    predict: (e, p) => {
      const lvl = p.byPosition[e.position] ?? p.global;
      return Object.fromEntries(TARGETS.map((t) => {
        const srcKey = t === 'minutesRate' ? 'srcMinutesRate' : t === 'startRate' ? 'srcStartRate' : 'srcFeatureRate';
        return [t, shrink(e[srcKey], e.srcAppearances ?? 0, lvl[t] ?? p.global[t], p.k[t])];
      }));
    },
  },
  O4: {
    label: 'O2 + transfer type',
    predict: (e, p) => {
      const lvl = p.byType[e.type] ?? p.global;
      return Object.fromEntries(TARGETS.map((t) => {
        const srcKey = t === 'minutesRate' ? 'srcMinutesRate' : t === 'startRate' ? 'srcStartRate' : 'srcFeatureRate';
        return [t, shrink(e[srcKey], e.srcAppearances ?? 0, lvl[t] ?? p.global[t], p.k[t])];
      }));
    },
  },
  O5: {
    label: 'O2 + source league (hierarchical, shrunk by group size)',
    predict: (e, p) => {
      const lvl = p.byLeague[e.sourceCompetition] ?? p.global;
      return Object.fromEntries(TARGETS.map((t) => {
        const srcKey = t === 'minutesRate' ? 'srcMinutesRate' : t === 'startRate' ? 'srcStartRate' : 'srcFeatureRate';
        return [t, shrink(e[srcKey], e.srcAppearances ?? 0, lvl[t] ?? p.global[t], p.k[t])];
      }));
    },
  },
};

/* ------------------------------------------------------------------ *
 * scoring
 * ------------------------------------------------------------------ */
function spearman(pairs) {
  const n = pairs.length; if (n < 4) return null;
  /* A constant predictor has no ranking to correlate. The first version of this
     returned a small arbitrary number (-0.015 for O0b) because the rank helper
     assigns distinct ranks to tied values by sort order, so the "correlation"
     was measuring the tie-break, not the model. Zero variance on either axis is
     UNDEFINED and must say so. */
  const varOf = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.reduce((a, b) => a + (b - m) ** 2, 0); };
  if (varOf(pairs.map((p) => p[0])) < 1e-12 || varOf(pairs.map((p) => p[1])) < 1e-12) return null;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n; i++) r[idx[i][1]] = i + 1;
    return r;
  };
  const rx = rank(pairs.map((p) => p[0])); const ry = rank(pairs.map((p) => p[1]));
  let d2 = 0; for (let i = 0; i < n; i++) d2 += (rx[i] - ry[i]) ** 2;
  return +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(4);
}

/** Binomial deviance from COUNTS. No per-match binaries are invented. */
function binomialDeviance(rows, predKey, kKey, nKey) {
  let dev = 0; let used = 0;
  for (const r of rows) {
    const N = r[nKey]; const k = r[kKey];
    if (!(N > 0) || k == null) continue;
    const p = Math.min(1 - 1e-6, Math.max(1e-6, r[predKey]));
    dev += -2 * (k * Math.log(p) + (N - k) * Math.log(1 - p));
    used += N;
  }
  return used ? +(dev / used).toFixed(4) : null;
}

function score(rows, preds, target) {
  const pairs = rows.map((e, i) => [preds[i][target], e[target]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pairs.length) return null;
  const n = pairs.length;
  const errs = pairs.map(([p, a]) => a - p);
  const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / n);
  const bias = errs.reduce((a, b) => a + b, 0) / n;
  const sumP = pairs.reduce((a, [p]) => a + p, 0);
  const sumA = pairs.reduce((a, [, x]) => a + x, 0);
  return {
    n, mae: +mae.toFixed(4), rmse: +rmse.toFixed(4), bias: +bias.toFixed(4),
    spearman: spearman(pairs), calibration: sumP ? +(sumA / sumP).toFixed(4) : null,
  };
}

/* seeded bootstrap, reproducible */
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function bootstrapDelta(rows, predsA, predsB, target, seed = 20260829, iters = 2000) {
  const rng = makeRng(seed);
  const idx = rows.map((_, i) => i).filter((i) => Number.isFinite(predsA[i][target]) && Number.isFinite(predsB[i][target]) && Number.isFinite(rows[i][target]));
  if (idx.length < 8) return null;
  const deltas = [];
  for (let b = 0; b < iters; b++) {
    let sa = 0; let sb = 0;
    for (let j = 0; j < idx.length; j++) {
      const i = idx[Math.floor(rng() * idx.length)];
      sa += Math.abs(rows[i][target] - predsA[i][target]);
      sb += Math.abs(rows[i][target] - predsB[i][target]);
    }
    deltas.push((sb - sa) / idx.length);   // positive => A better than B
  }
  deltas.sort((x, y) => x - y);
  const q = (p) => deltas[Math.floor(p * (deltas.length - 1))];
  return { deltaMAE: +((deltas.reduce((a, b) => a + b, 0)) / deltas.length).toFixed(4),
    ci95: [+q(0.025).toFixed(4), +q(0.975).toFixed(4)],
    pBetter: +(deltas.filter((d) => d > 0).length / deltas.length).toFixed(3) };
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */
if (train.length < 8 || test.length < 8) {
  console.log(`Insufficient cohort for a chronological split — train ${train.length}, test ${test.length}.`);
  console.log('Collection is still in flight; re-run once opportunity-cohort.mjs reports more episodes.');
  process.exit(0);
}

const params = fit(train);
const results = { trainSeason: TRAIN_SEASON, testSeason: TEST_SEASON, trainN: train.length, testN: test.length, fitted: params, targets: {} };

for (const t of TARGETS) {
  const preds = {};
  for (const [name, c] of Object.entries(CANDIDATES)) preds[name] = test.map((e) => c.predict(e, params));
  results.targets[t] = { scores: {}, vsControl: {}, deviance: {} };
  for (const [name] of Object.entries(CANDIDATES)) {
    results.targets[t].scores[name] = score(test, preds[name], t);
    if (name !== 'O0') results.targets[t].vsControl[name] = bootstrapDelta(test, preds[name], preds.O0, t);
  }
  /* The comparison that actually answers the question. Beating the incumbent
     is mostly level correction; the scientific question is whether source
     evidence adds anything over a correctly-levelled baseline carrying no
     player information at all. */
  results.targets[t].vsNoEvidence = {};
  for (const base of ['O0b', 'O0c']) {
    for (const cand of ['O1', 'O3']) {
      results.targets[t].vsNoEvidence[`${cand} vs ${base}`] = bootstrapDelta(test, preds[cand], preds[base], t);
    }
  }

  if (t !== 'minutesRate') {
    const kKey = t === 'startRate' ? 'destStarts' : 'destAppearances';
    for (const [name] of Object.entries(CANDIDATES)) {
      const rows = test.map((e, i) => ({ ...e, _p: preds[name][i][t] }));
      results.targets[t].deviance[name] = binomialDeviance(rows, '_p', kKey, 'destFixtures');
    }
  }
}

/* ---- item 10: does shrinkage preserve ranking with THIS formula? ---- */
results.shrinkageRanking = {};
for (const t of TARGETS) {
  const srcKey = t === 'minutesRate' ? 'srcMinutesRate' : t === 'startRate' ? 'srcStartRate' : 'srcFeatureRate';
  const rows = test.filter((e) => e[srcKey] != null && Number.isFinite(e[t]));
  const rawRho = spearman(rows.map((e) => [e[srcKey], e[t]]));
  const ks = [1, 10, 50, 250, 1000];
  const shrunkRho = {}; const orderChanged = {};
  const byRaw = [...rows].sort((a, b) => a[srcKey] - b[srcKey]).map((e) => e.espnId);
  for (const k of ks) {
    const f = (e) => shrink(e[srcKey], e.srcAppearances ?? 0, params.global[t], k);
    shrunkRho[k] = spearman(rows.map((e) => [f(e), e[t]]));
    const byShrunk = [...rows].sort((a, b) => f(a) - f(b)).map((e) => e.espnId);
    orderChanged[k] = byRaw.some((id, i) => id !== byShrunk[i]);
  }
  results.shrinkageRanking[t] = { n: rows.length, rawRho, shrunkRho, orderChanged };
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

console.log('\n── item 10: does shrinkage preserve ranking? ──');
console.log('  w = appearances / (appearances + k) varies BY PLAYER, so the transform is NOT');
console.log('  common across players and rank order is not guaranteed to survive.');
for (const [t, r] of Object.entries(results.shrinkageRanking)) {
  console.log('  ' + t.padEnd(12) + 'n=' + String(r.n).padStart(4) + '  raw rho ' + String(r.rawRho).padStart(7)
    + '   shrunk ' + Object.entries(r.shrunkRho).map(([k, v]) => 'k' + k + '=' + v).join(' '));
  console.log(' '.repeat(14) + 'order changed: ' + Object.entries(r.orderChanged).map(([k, v]) => 'k' + k + ':' + (v ? 'YES' : 'no')).join('  '));
}
console.log('\n── shrinkage curve (MAE by k, fitted on TRAINING only) ──');
for (const [t, curve] of Object.entries(params.curve || {})) {
  console.log('  ' + t.padEnd(12) + curve.map((c) => c.k + '=' + c.mae).join('  '));
}

/* ---- console ------------------------------------------------------ */
console.log('OPPORTUNITY TRANSLATION — chronological, frozen before scoring\n');
console.log(`train: destination season ${TRAIN_SEASON}, n=${train.length}`);
console.log(`test:  destination season ${TEST_SEASON}, n=${test.length}`);
console.log(`fitted shrinkage k (training only): ${JSON.stringify(params.k)}`);
console.log('\nTarget realised over the eligible fixture window — absorbs availability, NOT P(start|available).');

for (const t of TARGETS) {
  console.log(`\n── ${t} ──`);
  console.log('  model  description                                    MAE    RMSE    bias   rho    calib   dev');
  for (const [name, c] of Object.entries(CANDIDATES)) {
    const s = results.targets[t].scores[name]; if (!s) continue;
    const d = results.targets[t].deviance[name];
    console.log('  ' + name.padEnd(6) + c.label.slice(0, 44).padEnd(46)
      + String(s.mae).padStart(6) + String(s.rmse).padStart(8) + String(s.bias).padStart(8)
      + String(s.spearman ?? '-').padStart(7) + String(s.calibration ?? '-').padStart(8)
      + String(d ?? '-').padStart(7)
      + (name === 'O0' ? '   <= control' : ''));
  }
  console.log('  vs NO-PLAYER-EVIDENCE baselines (positive dMAE = source evidence better):');
  for (const [name, b] of Object.entries(results.targets[t].vsNoEvidence)) {
    if (!b) continue;
    const [ca, , cb] = name.split(' ');
    const rhoA = results.targets[t].scores[ca]?.spearman;
    const rhoB = results.targets[t].scores[cb]?.spearman;
    console.log('    ' + name.padEnd(14) + 'dMAE ' + String(b.deltaMAE).padStart(8)
      + '  95% [' + b.ci95[0] + ', ' + b.ci95[1] + ']  P ' + String(b.pBetter).padStart(5)
      + '   rho ' + String(rhoB ?? 'NA').padStart(6) + ' -> ' + String(rhoA ?? 'NA'));
  }
  console.log('  bootstrap vs incumbent (positive dMAE = candidate better):');
  for (const [name, b] of Object.entries(results.targets[t].vsControl)) {
    if (!b) continue;
    console.log('    ' + name.padEnd(5) + 'dMAE ' + String(b.deltaMAE).padStart(8)
      + '  95% [' + b.ci95[0] + ', ' + b.ci95[1] + ']  P(better) ' + b.pBetter);
  }
}
console.log(`\n→ ${OUT}`);
