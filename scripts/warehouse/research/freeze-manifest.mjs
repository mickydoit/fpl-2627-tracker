/**
 * The immutable experiment manifest, and the live incumbent frozen alongside it.
 *
 * ── Why the incumbent must be captured, and why it is not a fair control here ──
 *
 * The plan asks for `incumbent xG/90 vs bridge xG/90 vs realised`. That is the
 * right shape, and for a player with Premier League history it works. For the
 * players the bridge actually targets it does not, and the reason matters:
 *
 * The incumbent reports xG/90 = 0 for a cold-start foreign signing. Checked on
 * the current cohort — Penders, Vitor Reis, Palestra and Touré all read exactly
 * zero. That is not a prediction of no threat; the incumbent simply does not
 * express a cold-start production belief in xG/90 units. It routes that belief
 * through `pricePrior()`, which returns POINTS PER APPEARANCE.
 *
 * So a Stage A comparison on those players would have the bridge beating a
 * structural zero, and the bridge would "win" without demonstrating anything.
 * That is the same unit mismatch Part 4 exists to prevent, one level further
 * down.
 *
 * The manifest therefore records, per player, whether the incumbent holds a
 * real xG/90 opinion — and the evaluator scores Stage A only on the subset
 * where it does. For the rest the honest verdict is INCUMBENT_HAS_NO_ESTIMATE,
 * and the comparison waits for Stage B, where the scoring engine can put both
 * beliefs in the same units.
 */
import fs from 'node:fs';
import { hydrate } from '../../../js/prior.js';
import { datasetVersion } from '../version.mjs';

const OUT = 'data/warehouse/research/EXPERIMENT-MANIFEST.json';
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const boot = hydrate(J('data/bootstrap.json'), J('data/draft/prior-2526.json'), {}, J('data/espn-history.json'));
const raw = J('data/bootstrap.json');
const archive = J('data/warehouse/research/shadow-archive.json');
const bridge = J('data/warehouse/research/xg-bridge-FROZEN.json');
const frozenOpp = J('data/warehouse/research/opportunity-FROZEN.json');
const version = await datasetVersion();

const firstScorable = raw.events.find((e) => !e.finished && !e.is_current)?.id
  ?? raw.events.find((e) => e.is_next)?.id ?? null;

/* Freeze the incumbent's belief for every shadow player, at this timestamp. */
const byName = new Map(boot.elements.map((e) => [e.web_name, e]));
const findEl = (p) => byName.get(p.name)
  ?? boot.elements.find((e) => String(p.name).includes(e.web_name))
  ?? boot.elements.find((e) => e.web_name === String(p.name).split(' ').pop())
  ?? null;

let withEstimate = 0; let withoutEstimate = 0; let unmatched = 0;
const incumbent = [];
for (const p of archive.players) {
  const e = findEl(p);
  if (!e) { unmatched += 1; continue; }
  const xg = Number(e.expected_goals_per_90) || 0;
  const xa = Number(e.expected_assists_per_90) || 0;
  /* The decisive flag. A structural zero is not a forecast. */
  const hasEstimate = xg > 0 || xa > 0;
  if (hasEstimate) withEstimate += 1; else withoutEstimate += 1;
  incumbent.push({
    name: p.name, fplId: e.id, fplCode: e.code, position: e.element_type,
    episodeType: p.episodeType,
    incumbent_xG90: +xg.toFixed(4), incumbent_xA90: +xa.toFixed(4),
    incumbentHasProductionEstimate: hasEstimate,
    evidenceMinutes: e.evidenceMinutes ?? null,
    minutesEvidenceMinutes: e.minutesEvidenceMinutes ?? null,
    modelMinutes: e.modelMinutes ?? null,
    featuredRate: e.featuredRate ?? null,
    startRateGivenFeatured: e.startRateGivenFeatured ?? null,
    minsPerStart: e.minsPerStart ?? null,
    startProbability: e.startProbability ?? null,
    price: e.now_cost / 10,
    status: e.status,
    chanceNextRound: e.chance_of_playing_next_round ?? null,
  });
}

const manifest = {
  status: 'IMMUTABLE — any model change gets a NEW version, never an edit to this',
  freezeCommit: process.env.FREEZE_COMMIT || null,
  freezeTimestamp: new Date().toISOString(),
  warehouseSchema: version.schemaVersion,
  warehouseDigest: version.coverageDigest,
  firstScorableGW: firstScorable,
  evaluationWindowStartGW: firstScorable,
  windowRule: `Every prospective outcome must be computed from GW${firstScorable} onward. `
    + 'Season-to-date totals contain GW1 and GW2, which precede the freeze, and may not be used '
    + 'unless that contribution is removed exactly.',
  candidateVersions: {
    opportunity: { O0b: 'opportunity-2024-v1', O0c: 'opportunity-2024-v1', O3: 'opportunity-2024-v1',
      O6: 'REGISTERED BUT UNFITTED — not scorable' },
    productionVolume: 'production-volume-2024-v1',
    xGBridge: 'xg-bridge-2025-v1',
    xABridge: 'xg-bridge-2025-v1',
  },
  frozenArtefacts: {
    opportunity: 'data/warehouse/research/opportunity-FROZEN.json',
    bridge: 'data/warehouse/research/xg-bridge-FROZEN.json',
    shadow: 'data/warehouse/research/shadow-archive.json',
    teamStrengthPreRegistration: 'data/warehouse/research/team-strength-PREREGISTERED.json',
  },
  opportunityVerdicts: frozenOpp.verdict,
  bridgeValidationStatus: bridge.validationStatus,
  incumbentControl: {
    capturedAt: new Date().toISOString(),
    n: incumbent.length,
    withProductionEstimate: withEstimate,
    withoutProductionEstimate: withoutEstimate,
    unmatchedToBootstrap: unmatched,
    caveat: 'incumbent_xG90 reads exactly 0 for cold-start signings. That is a structural absence, not a '
      + 'forecast: the incumbent expresses cold-start production through pricePrior() in POINTS PER '
      + 'APPEARANCE. Stage A may only be scored on players where incumbentHasProductionEstimate is true; '
      + 'elsewhere the verdict is INCUMBENT_HAS_NO_ESTIMATE and the comparison waits for Stage B.',
    players: incumbent,
  },
  measurability: {
    'opportunity (minutes, starts, 60+)': 'SCORABLE — FPL element-summary carries per-gameweek minutes and starts',
    'bridge (xG/90, xA/90)': 'SCORABLE — FPL element-summary carries per-gameweek expected_goals and expected_assists',
    'production volume (shots, SOT, keyPasses)': 'NOT YET SCORABLE — FPL publishes no per-gameweek shot or '
      + 'key-pass counts, and ESPN season aggregates cannot be decomposed by gameweek. Requires per-match '
      + 'ESPN player collection for 2026/27, about 430 requests per gameweek.',
  },
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 1));

console.log('EXPERIMENT MANIFEST — frozen\n');
console.log(`  firstScorableGW ${firstScorable}   digest ${version.coverageDigest}   schema v${version.schemaVersion}`);
console.log(`  incumbent captured for ${incumbent.length} players`);
console.log(`    with a real xG/xA estimate      ${withEstimate}`);
console.log(`    xG/90 = 0 (structural absence)  ${withoutEstimate}`);
console.log(`    unmatched to bootstrap          ${unmatched}`);
console.log('\n  measurability:');
for (const [k, v] of Object.entries(manifest.measurability)) console.log('    ' + k.padEnd(42) + v.split(' —')[0]);
console.log(`\n→ ${OUT}`);
