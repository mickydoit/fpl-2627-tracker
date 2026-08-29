/**
 * Weekly prospective scoring. Reads frozen candidates; never refits.
 *
 * ── The window rule, enforced rather than remembered ──
 *
 * Predictions were frozen after GW2. Season-to-date totals therefore contain
 * two gameweeks that precede the freeze, and using them would score a forecast
 * against outcomes it could in principle have seen. Every realised quantity
 * below is summed from per-gameweek rows with `round >= firstScorableGW`, and
 * the count of excluded gameweeks is reported so the exclusion is visible
 * rather than assumed.
 *
 * ── What is scorable, and what is not ──
 *
 * FPL's element-summary carries per-gameweek minutes, starts, expected_goals
 * and expected_assists. So opportunity and the xG/xA bridge can both be scored
 * on a clean GW3+ window.
 *
 * It carries no shot or key-pass counts, and ESPN season aggregates cannot be
 * decomposed by gameweek. Production VOLUME is therefore not scorable today,
 * and is reported as NOT YET SCORABLE rather than quietly omitted or scored on
 * contaminated season totals.
 */
import fs from 'node:fs';

const OUT = 'data/warehouse/research/prospective-report.json';
const J = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const manifest = J('data/warehouse/research/EXPERIMENT-MANIFEST.json');
const archive = J('data/warehouse/research/shadow-archive.json');
const bridge = J('data/warehouse/research/xg-bridge-FROZEN.json');
const summaries = J('data/summaries.json') || {};
const boot = J('data/bootstrap.json');
if (!manifest) { console.error('no manifest — run freeze-manifest.mjs first'); process.exit(1); }

const FIRST = manifest.firstScorableGW;
const settled = (boot?.events || []).filter((e) => e.finished).map((e) => e.id);
const dataThrough = settled.length ? Math.max(...settled) : 0;
const eligible = settled.filter((g) => g >= FIRST);

/* ---- realised, from GW >= FIRST only ------------------------------ */
const byId = new Map();
for (const [, s] of Object.entries(summaries)) {
  const hist = (s.history || []).filter((h) => Number(h.round) >= FIRST);
  const excluded = (s.history || []).length - hist.length;
  if (!hist.length) { if (s.id != null) byId.set(s.id, { id: s.id, gws: 0, excludedGws: excluded, minutes: 0 }); continue; }
  const num = (v) => Number(v) || 0;
  byId.set(s.id, {
    id: s.id, gws: hist.length, excludedGws: excluded,
    minutes: hist.reduce((a, h) => a + num(h.minutes), 0),
    starts: hist.reduce((a, h) => a + num(h.starts), 0),
    played: hist.filter((h) => num(h.minutes) > 0).length,
    sixtyPlus: hist.filter((h) => num(h.minutes) >= 60).length,
    xg: hist.reduce((a, h) => a + num(h.expected_goals), 0),
    xa: hist.reduce((a, h) => a + num(h.expected_assists), 0),
  });
}

const inc = new Map((manifest.incumbentControl?.players || []).map((p) => [p.fplId, p]));
const shadowByName = new Map((archive?.players || []).map((p) => [p.name, p]));

/* ---- cohort assembly ---------------------------------------------- */
const rows = [];
for (const p of manifest.incumbentControl?.players || []) {
  const r = byId.get(p.fplId);
  const sh = shadowByName.get(p.name);
  if (!r) continue;
  rows.push({
    name: p.name, position: p.position, episodeType: p.episodeType,
    eligibleGws: r.gws, excludedGws: r.excludedGws,
    prospectiveMinutes: r.minutes, prospectiveStarts: r.starts,
    played: r.played, sixtyPlus: r.sixtyPlus,
    realised_xG90: r.minutes > 0 ? (r.xg / r.minutes) * 90 : null,
    realised_xA90: r.minutes > 0 ? (r.xa / r.minutes) * 90 : null,
    realised_startRate: r.gws > 0 ? r.starts / r.gws : null,
    realised_featureRate: r.gws > 0 ? r.played / r.gws : null,
    incumbent_xG90: p.incumbent_xG90, incumbent_xA90: p.incumbent_xA90,
    incumbentHasProductionEstimate: p.incumbentHasProductionEstimate,
    bridge_xG90: sh?.bridge?.predicted_xG90 ?? null,
    bridge_xA90: sh?.bridge?.predicted_xA90 ?? null,
    O0c_startRate: sh?.baselineO0c?.startRate ?? null,
    O3_startRate: sh?.candidateO3?.startRate ?? null,
    incumbent_startProbability: p.startProbability,
  });
}

const THRESH = [180, 450, 900];
const isGK = (pos) => pos === 1;
const report = {
  generatedAt: new Date().toISOString(),
  experimentFreeze: { commit: manifest.freezeCommit, at: manifest.freezeTimestamp,
    digest: manifest.warehouseDigest, firstScorableGW: FIRST },
  dataThroughGW: dataThrough,
  eligibleGameweeks: eligible,
  eligibleGwCount: eligible.length,
  excludedGameweeks: settled.filter((g) => g < FIRST),
  cohortN: rows.length,
  modelChanges: 'NONE — no candidate was refitted, edited or re-versioned this run.',
  measurability: manifest.measurability,
  thresholds: {},
  pooled: {},
};

if (!eligible.length) {
  report.status = 'NOT YET SCORABLE — no settled gameweek at or after the freeze';
} else {
  for (const t of THRESH) {
    for (const [label, filt] of [['ALL', () => true], ['OUTFIELD', (r) => !isGK(r.position)], ['GK', (r) => isGK(r.position)]]) {
      const g = rows.filter((r) => filt(r) && r.prospectiveMinutes >= t);
      report.thresholds[`${t}|${label}`] = { n: g.length,
        status: g.length < 8 ? 'NOT YET INDIVIDUALLY SCORABLE' : 'scorable' };
    }
  }
  /* Pooled early diagnostics — level only, never a promotion basis. */
  const out = rows.filter((r) => !isGK(r.position) && r.prospectiveMinutes > 0);
  const sum = (f) => out.reduce((a, r) => a + (f(r) || 0), 0);
  report.pooled = {
    n: out.length, totalProspectiveMinutes: sum((r) => r.prospectiveMinutes),
    realisedTotalXG: +sum((r) => (r.realised_xG90 || 0) * r.prospectiveMinutes / 90).toFixed(3),
    bridgePredictedTotalXG: +sum((r) => (r.bridge_xG90 || 0) * r.prospectiveMinutes / 90).toFixed(3),
    incumbentPredictedTotalXG: +sum((r) => (r.incumbent_xG90 || 0) * r.prospectiveMinutes / 90).toFixed(3),
    caveat: 'Pooled level agreement only. A model can match the aggregate and rank players badly, so this '
      + 'may never on its own justify promoting a candidate.',
  };
}
fs.writeFileSync(OUT, JSON.stringify({ ...report, rows }, null, 1));

console.log('PROSPECTIVE REPORT\n');
console.log(`  EXPERIMENT FREEZE   ${manifest.freezeCommit ?? 'n/a'} at ${String(manifest.freezeTimestamp).slice(0, 19)}`);
console.log(`                      digest ${manifest.warehouseDigest}`);
console.log(`  DATA THROUGH GW     ${dataThrough}`);
console.log(`  ELIGIBLE GW WINDOW  GW${FIRST}+ -> ${eligible.length ? eligible.join(', ') : 'none yet'}`);
console.log(`  EXCLUDED (pre-freeze) ${report.excludedGameweeks.join(', ') || 'none'}`);
console.log(`  COHORT              ${rows.length} players\n`);
if (!eligible.length) {
  console.log('  STATUS: NOT YET SCORABLE — no settled gameweek at or after the freeze.');
  console.log('  Nothing is scored, and season-to-date totals are deliberately NOT substituted.');
} else {
  console.log('  OPPORTUNITY / BRIDGE cohort sizes by prospective minutes:');
  for (const k of Object.keys(report.thresholds)) {
    const v = report.thresholds[k];
    console.log('    ' + k.padEnd(16) + 'n=' + String(v.n).padStart(3) + '  ' + v.status);
  }
  console.log('\n  POOLED (level only):', JSON.stringify(report.pooled).slice(0, 200));
}
console.log('\n  PRODUCTION VOLUME   ' + manifest.measurability['production volume (shots, SOT, keyPasses)'].split(' —')[0]);
console.log('  NO MODEL CHANGES    ' + report.modelChanges);
console.log(`\n→ ${OUT}`);
