/**
 * Score frozen forecasts against what actually happened.
 *
 * TWO MODES, AND THEY MUST NEVER BE MIXED
 * =======================================
 *
 *   ARCHIVED / OUT-OF-SAMPLE
 *     The projection actually frozen before that deadline, by whatever model
 *     was in production at the time. GW1: projected 773.41, actual 948.00.
 *     This is the ONLY figure that counts as genuine model performance,
 *     because nothing about it could have seen the result.
 *
 *   CURRENT MODEL REPLAY / RETROSPECTIVE
 *     Today's production model re-run against the same frozen pre-deadline
 *     inputs. GW1: 686.79 against the same 948.00. Useful for asking how a
 *     later change would have behaved, and NOT out-of-sample: every model
 *     change since was made with GW1's result already known.
 *
 * This file reports the archived mode only. Replay is a separate exercise and
 * its numbers must never be quoted alongside these as if comparable — a replay
 * that "beats" an archived forecast has simply been developed afterwards.
 *
 * ROUTE DECOMPOSITION is likewise mode-bound. The archive stores a total, not
 * components, so an archived forecast's route split is UNAVAILABLE unless that
 * gameweek's schema carried the pieces. It must not be approximated by running
 * today's code over the old inputs and presenting the result as an explanation
 * of the archived number — that is a different model's opinion.
 *
 * Every phase from here is gated on out-of-sample evidence rather than on more
 * code, and this is the thing that supplies it. `scripts/archive-gameweek.mjs`
 * freezes a projection before each deadline and attaches the result afterwards;
 * this reads those pairs back and says how good the forecast was.
 *
 * Deliberately reads ONLY the archive. It never re-projects, because a
 * projection recomputed today has seen the result — the whole point of the
 * archive is that its numbers were written down first.
 *
 *   node scripts/evaluate.mjs              concise default
 *   node scripts/evaluate.mjs --gw 3       one gameweek
 *   node scripts/evaluate.mjs --detail     add positions, minutes and bands
 *   node scripts/evaluate.mjs --json       machine-readable, for ablations
 *
 * BIAS SIGN, stated once and used everywhere:
 *
 *     bias = actual - projected
 *
 * A positive bias means the model projected too LOW. Reported per player, so
 * `bias x n` reconciles exactly with the aggregate league gap. The calibration
 * ratio is `actual / projected` over the same set, which is the same fact on a
 * multiplicative scale — quote one or the other, never both as if independent.
 *
 * The breakdowns exist to answer the question a single MAE cannot: when a
 * forecast was wrong, WHICH layer was wrong — availability, opportunity, or
 * production. Schema 3 archives carry the diagnostics that make that possible.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AVAILABILITY_FIELDS, DIAGNOSTIC_FIELDS, ACTUAL_FIELDS } from './lib/archive-schema.mjs';

const DIR = 'data/history/gw';
const args = process.argv.slice(2);
const wantGW = args.includes('--gw') ? Number(args[args.indexOf('--gw') + 1]) : null;
const asJSON = args.includes('--json');
const detail = args.includes('--detail');

/* ------------------------------------------------------------------ *
 * statistics
 * ------------------------------------------------------------------ */
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const mae = (rows) => mean(rows.map((r) => Math.abs(r.actual - r.projected)));
const rmse = (rows) => Math.sqrt(mean(rows.map((r) => (r.actual - r.projected) ** 2)));
const bias = (rows) => mean(rows.map((r) => r.actual - r.projected));

/** Spearman, with average ranks so ties do not distort it. */
function spearman(rows) {
  if (rows.length < 3) return NaN;
  const rank = (vals) => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
      i = j + 1;
    }
    return out;
  };
  const a = rank(rows.map((r) => r.actual));
  const b = rank(rows.map((r) => r.projected));
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

/** Did the players we ranked highest actually score more than average? */
function topK(rows, k) {
  if (rows.length < k) return null;
  const top = [...rows].sort((a, b) => b.projected - a.projected).slice(0, k);
  return { meanActual: mean(top.map((r) => r.actual)), field: mean(rows.map((r) => r.actual)) };
}

/** Do players projected around N actually average about N? */
function calibration(rows, edges = [0, 1, 2, 3, 4, 5, 6, 99]) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const band = rows.filter((r) => r.projected >= edges[i] && r.projected < edges[i + 1]);
    if (band.length < 5) continue;
    out.push({ band: `${edges[i]}-${edges[i + 1]}`, n: band.length,
      predicted: mean(band.map((r) => r.projected)), actual: mean(band.map((r) => r.actual)) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * loading
 * ------------------------------------------------------------------ */
function loadGameweek(file) {
  const g = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  if (!g.projected || !g.actual) return null;
  const availIdx = Object.fromEntries(AVAILABILITY_FIELDS.map((f, i) => [f, i]));
  const diagIdx = Object.fromEntries(DIAGNOSTIC_FIELDS.map((f, i) => [f, i]));
  const actIdx = Object.fromEntries(ACTUAL_FIELDS.map((f, i) => [f, i]));
  const rows = [];
  for (const [code, projected] of Object.entries(g.projected)) {
    const act = g.actual[code];
    if (!Array.isArray(act)) continue;
    const av = g.availability?.[code];
    const dg = g.diagnostics?.[code];
    rows.push({
      code: Number(code),
      projected: Number(projected),
      actual: Number(act[0]),
      minutes: Number(act[1] ?? 0),
      /* Schema 3 only. Absent on older gameweeks, which is why every consumer
         below has to tolerate undefined rather than assume. */
      status: av ? av[availIdx.status] : null,
      position: null,   // filled below where the current bootstrap can supply it
      availability: dg ? dg[diagIdx.availability] : null,
      availabilitySource: dg ? dg[diagIdx.availabilitySource] : null,
      expMins: dg ? dg[diagIdx.expMins] : null,
      /* How much production evidence the model HAD at the deadline, frozen.
         Read from the archive rather than recomputed: `evidenceMinutes` lives
         on the hydrated payload and is rewritten every refresh, so today's
         value is not what the forecast was made with. */
      productionConfidence: dg ? dg[diagIdx.productionConfidence] : null,
      expGoals: dg ? dg[diagIdx.expGoals] : null,
      expAssists: dg ? dg[diagIdx.expAssists] : null,
      defconProb: dg ? dg[diagIdx.defconProb] : null,
      /* Schema 5+ carries the routes. Older gameweeks stored four fields, so
         everything below tolerates undefined rather than assuming. */
      goals: act.length > 4 ? Number(act[actIdx.goals]) : null,
      assists: act.length > 4 ? Number(act[actIdx.assists]) : null,
      defcon: act.length > 4 ? Number(act[actIdx.defensiveContribution]) : null,
      pStart: dg ? dg[diagIdx.pStart] : null,
      p60: dg ? dg[diagIdx.p60] : null,
    });
  }
  for (const r of rows) {
    const m = meta.get(r.code);
    if (m) r.position = m.element_type;
  }
  return { event: g.event, schema: g.schema ?? 1, final: !!g.final,
    capturedAt: g.capturedAt ?? null, modelCommit: g.modelCommit ?? g.projectedFrom ?? null,
    deadline: g.deadline, rows };
}

/* Positions and evidence come from the CURRENT bootstrap. That is safe: a
   player's position and his accumulated minutes are not outcomes of the
   gameweek being scored, and nothing here feeds back into a projection. */
let meta = new Map();
try {
  const boot = JSON.parse(fs.readFileSync('data/bootstrap.json', 'utf8'));
  meta = new Map(boot.elements.map((e) => [e.code, e]));
} catch { /* evaluation still works without it, just without the breakdowns */ }
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
const weeks = files.map(loadGameweek).filter(Boolean)
  .filter((w) => (wantGW == null ? true : w.event === wantGW))
  .sort((a, b) => a.event - b.event);

if (!weeks.length) {
  console.error('No archived gameweeks with both a projection and a result.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * report
 * ------------------------------------------------------------------ */
const summarise = (rows) => ({ n: rows.length, mae: mae(rows), rmse: rmse(rows),
  bias: bias(rows), rho: spearman(rows) });

const report = { gameweeks: [], overall: null };
const all = [];

for (const w of weeks) {
  all.push(...w.rows);
  const played = w.rows.filter((r) => r.minutes > 0);
  const started = w.rows.filter((r) => r.minutes >= 60);
  const entry = {
    event: w.event, schema: w.schema, final: w.final,
    mode: 'ARCHIVED / OUT-OF-SAMPLE',
    modelCommit: w.modelCommit ?? null,
    capturedAt: w.capturedAt ?? null,
    leadMinutes: w.capturedAt
      ? Math.round((Date.parse(w.deadline) - Date.parse(w.capturedAt)) / 60000) : null,
    all: summarise(w.rows), played: summarise(played), started: summarise(started),
    top10: topK(w.rows, 10), top20: topK(w.rows, 20), top50: topK(w.rows, 50),
    calibration: calibration(w.rows),
  };
  /* Availability attribution: only schema 3 carries it. This is the breakdown
     that says whether a miss was an availability call rather than a bad
     production estimate. */
  if (w.schema >= 3) {
    entry.bySource = {};
    for (const src of new Set(w.rows.map((r) => r.availabilitySource).filter(Boolean))) {
      entry.bySource[src] = summarise(w.rows.filter((r) => r.availabilitySource === src));
    }
    /* Did players we said would start, start? The single most important
       component check, and the one Phase 1 exists to serve. */
    const withP = w.rows.filter((r) => r.pStart != null);
    if (withP.length) {
      const bands = [[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.01]];
      entry.startCalibration = bands.map(([lo, hi]) => {
        const b = withP.filter((r) => r.pStart >= lo && r.pStart < hi);
        return b.length < 5 ? null
          : { band: `${lo}-${hi}`, n: b.length, predicted: mean(b.map((r) => r.pStart)),
              actual: b.filter((r) => r.minutes >= 60).length / b.length };
      }).filter(Boolean);
    }
  }
  /* Calibration ratio alongside bias — the same fact multiplicatively. */
  const pTot = w.rows.reduce((s2, r) => s2 + r.projected, 0);
  const aTot = w.rows.reduce((s2, r) => s2 + r.actual, 0);
  entry.totals = { projected: pTot, actual: aTot, ratio: pTot > 0 ? aTot / pTot : NaN };

  if (detail || asJSON) {
    entry.byPosition = {};
    for (const t of [1, 2, 3, 4]) {
      const b = w.rows.filter((r) => r.position === t);
      if (!b.length) continue;
      const p = b.reduce((s2, r) => s2 + r.projected, 0);
      const a = b.reduce((s2, r) => s2 + r.actual, 0);
      entry.byPosition[POS[t]] = { n: b.length, projected: p, actual: a, diff: a - p, per: (a - p) / b.length };
    }
    /* Evidence bands — how much of the error sits with players the model barely
       knows. This is the segmentation Phase 7 is monitored on, and it needs the
       confidence FROZEN at the deadline: `evidenceMinutes` on the live payload
       is rewritten every refresh, so scoring against today's value would band
       players by what we know now rather than by what we knew then. Only
       schema 3+ gameweeks carry it. */
    const withConf = w.rows.filter((r) => r.productionConfidence != null);
    if (withConf.length) {
      const bands = [['none 0', (r) => r.productionConfidence <= 0],
        ['low <0.25', (r) => r.productionConfidence > 0 && r.productionConfidence < 0.25],
        ['0.25-0.5', (r) => r.productionConfidence >= 0.25 && r.productionConfidence < 0.5],
        ['0.5-0.9', (r) => r.productionConfidence >= 0.5 && r.productionConfidence < 0.9],
        ['full 0.9+', (r) => r.productionConfidence >= 0.9]];
      entry.byEvidence = {};
      for (const [label, f] of bands) {
        const b = withConf.filter(f);
        if (!b.length) continue;
        const p = b.reduce((s2, r) => s2 + r.projected, 0);
        const a = b.reduce((s2, r) => s2 + r.actual, 0);
        entry.byEvidence[label] = { n: b.length, projected: p, actual: a, diff: a - p,
          ratio: p > 0 ? a / p : NaN, rho: spearman(b) };
      }
    }
    /* Minutes error, where the archive froze an expectation to compare against. */
    const withMins = w.rows.filter((r) => r.expMins != null);
    if (withMins.length) {
      entry.minutes = {
        n: withMins.length,
        mae: mean(withMins.map((r) => Math.abs(r.minutes - r.expMins))),
        bias: mean(withMins.map((r) => r.minutes - r.expMins)),
      };
    }
  }
  /* Attack and DefCon, where both sides are frozen. Registered hypotheses H3
     (DefCon under-prediction) and the attack half of H4 are monitored here. */
  const withEv = w.rows.filter((r) => r.expGoals != null && r.goals != null);
  if (withEv.length) {
    const eG = withEv.reduce((s2, r) => s2 + r.expGoals, 0);
    const eA = withEv.reduce((s2, r) => s2 + r.expAssists, 0);
    entry.attack = { n: withEv.length,
      expectedGoals: eG, actualGoals: withEv.reduce((s2, r) => s2 + r.goals, 0),
      expectedAssists: eA, actualAssists: withEv.reduce((s2, r) => s2 + r.assists, 0) };
  }
  const withDC = w.rows.filter((r) => r.defconProb != null && r.defcon != null && r.position);
  if (withDC.length) {
    const th = (p) => (p === 2 ? 10 : 12);
    const hits = withDC.filter((r) => r.defcon >= th(r.position)).length;
    const expHits = withDC.reduce((s2, r) => s2 + r.defconProb, 0);
    entry.defcon = { n: withDC.length, expectedHits: expHits, actualHits: hits,
      expectedPoints: expHits * 2, actualPoints: hits * 2,
      ratio: expHits > 0 ? hits / expHits : NaN };
  }
  report.gameweeks.push(entry);
}
report.overall = { all: summarise(all), played: summarise(all.filter((r) => r.minutes > 0)),
  started: summarise(all.filter((r) => r.minutes >= 60)) };

if (asJSON) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
console.log(`\nForecast evaluation — ARCHIVED / OUT-OF-SAMPLE — ${weeks.length} gameweek(s)`);
console.log('Every figure below is the projection frozen before that deadline, scored against');
console.log('the result. Current-model replay numbers are a different mode and are not shown\n'
  + 'here; they must never be quoted alongside these.\n');
for (const g of report.gameweeks) {
  console.log(`GW${g.event}  schema ${g.schema}${g.final ? ' (final)' : ''}`
    + `  model ${g.modelCommit ?? 'unknown'}`
    + (g.leadMinutes != null ? `  frozen ${g.leadMinutes} min before deadline` : '  (no capture timestamp)'));
  for (const [k, s] of [['all', g.all], ['played', g.played], ['started 60+', g.started]]) {
    console.log(`   ${k.padEnd(12)} n=${String(s.n).padStart(4)}  MAE ${f(s.mae, 2)}  RMSE ${f(s.rmse, 2)}`
      + `  bias ${f(s.bias, 2)}  rho ${f(s.rho)}`);
  }
  console.log(`   ${'totals'.padEnd(12)} projected ${f(g.totals.projected, 1)}  actual ${f(g.totals.actual, 1)}`
    + `  calibration ratio ${f(g.totals.ratio, 3)}`);
  for (const [k, t] of [['top10', g.top10], ['top20', g.top20], ['top50', g.top50]]) {
    if (t) console.log(`   ${k.padEnd(12)} mean actual ${f(t.meanActual, 2)} vs field ${f(t.field, 2)}`);
  }
  if (g.minutes) {
    console.log(`   ${'minutes'.padEnd(12)} n=${String(g.minutes.n).padStart(4)}  MAE ${f(g.minutes.mae, 1)}`
      + `  bias ${f(g.minutes.bias, 2)}`);
  }
  if (g.byPosition) {
    console.log('   by position:');
    for (const [k, v] of Object.entries(g.byPosition)) {
      console.log(`     ${k.padEnd(6)} n=${String(v.n).padStart(4)} projected ${f(v.projected, 1).padStart(7)}`
        + ` actual ${f(v.actual, 1).padStart(7)} diff ${f(v.diff, 1).padStart(7)} per player ${f(v.per, 2)}`);
    }
  }
  if (g.byEvidence) {
    /* Two properties, tracked separately because Phase 7 suggests they diverge:
       the price prior may RANK cold-start players well while sitting too low in
       LEVEL. `rho` is discrimination, `ratio` is calibration. */
    console.log('   by production confidence frozen at the deadline:');
    for (const [k, v] of Object.entries(g.byEvidence)) {
      console.log(`     ${k.padEnd(10)} n=${String(v.n).padStart(4)}`
        + ` level ${f(v.ratio, 3).padStart(6)}  rank rho ${f(v.rho, 3).padStart(6)}`
        + `  projected ${f(v.projected, 1).padStart(7)} actual ${f(v.actual, 1).padStart(7)}`);
    }
  }
  if (g.attack) {
    console.log(`   attack        goals ${f(g.attack.expectedGoals, 1)} expected vs ${g.attack.actualGoals} actual`
      + `   assists ${f(g.attack.expectedAssists, 1)} vs ${g.attack.actualAssists}`);
  }
  if (g.defcon) {
    console.log(`   defcon        hits ${f(g.defcon.expectedHits, 1)} expected vs ${g.defcon.actualHits} actual`
      + `  (ratio ${f(g.defcon.ratio, 2)})   points ${f(g.defcon.expectedPoints, 1)} vs ${g.defcon.actualPoints}`);
  }
  if (g.bySource) {
    console.log('   by availability source:');
    for (const [src, s] of Object.entries(g.bySource)) {
      console.log(`     ${src.padEnd(22)} n=${String(s.n).padStart(4)} MAE ${f(s.mae, 2)} bias ${f(s.bias, 2)}`);
    }
  }
  if (g.startCalibration?.length) {
    console.log('   P(start) calibration:');
    for (const b of g.startCalibration) {
      console.log(`     ${b.band.padEnd(10)} n=${String(b.n).padStart(4)} predicted ${f(b.predicted)} actual ${f(b.actual)}`);
    }
  }
  console.log('');
}
if (weeks.length > 1) {
  const o = report.overall;
  console.log('Overall');
  for (const [k, s] of [['all', o.all], ['played', o.played], ['started 60+', o.started]]) {
    console.log(`   ${k.padEnd(12)} n=${String(s.n).padStart(5)}  MAE ${f(s.mae, 2)}  RMSE ${f(s.rmse, 2)}`
      + `  bias ${f(s.bias, 2)}  rho ${f(s.rho)}`);
  }
  console.log('');
}
console.log('bias = actual - projected, so a positive bias means the model projected too low.');
if (!detail) console.log('Run with --detail for positions, minutes and evidence bands, or --json for ablations.');
console.log('');
console.log('One gameweek of FPL points is dominated by variance — a goal is 4-6 points and');
console.log('close to a coin flip. Read rank correlation and calibration across several');
console.log('gameweeks before concluding anything about a model change.\n');
