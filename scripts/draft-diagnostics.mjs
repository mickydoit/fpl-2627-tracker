/**
 * Draft model diagnostics. Dev-only — run `npm run diagnostics`.
 *
 * Prints the boards a human has to eyeball before trusting them, plus the
 * checks worth failing over: whether the official draft_rank and our ranking
 * disagree wildly, whether either replacement basis produces a nonsense
 * ordering, and whether the tier split is actually informative. draft_rank is
 * a BENCHMARK, not a target — beating it is the point of building this.
 *
 * Not imported by any page. Not part of the deployed product.
 */
import { readJSON } from './lib/io.mjs';
import { projectBoard } from '../js/draft/project.js';
import { outstandingDemand, replacementLevel, attachVorp } from '../js/draft/replacement.js';
import { scarcityByPosition } from '../js/draft/scarcity.js';
import { evaluate } from '../js/draft/value.js';
import { assignTiers } from '../js/draft/board.js';
import { QUOTA, replacementBasisForLeagueSize, DEMAND_BASIS_SIZES,
  LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from '../js/draft/config.js';

const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const LEAGUE = Number(process.env.LEAGUE_SIZE) || 8;

const board = await readJSON('data/draft/players.json');
const fixtures = await readJSON('data/fixtures.json', []);
if (!board?.players?.length) throw new Error('no board data — run `npm run refresh:draft`');

// Team strengths come from the board file itself, never from bootstrap.json —
// that file is regenerated as synthetic seed data by the test harness.
const projected = projectBoard(board.players, fixtures, board.teams);

const demand = outstandingDemand(new Map(), LEAGUE, new Map());
const replacement = replacementLevel(projected, demand, { leagueSize: LEAGUE });
const withVorp = attachVorp(projected, replacement);
const scarcity = scarcityByPosition(withVorp, demand, { leagueSize: LEAGUE, replacement });
const ranked = evaluate(withVorp, {
  replacement, demand, scarcity,
  needs: { ...QUOTA }, picksRemaining: 15,
  opponentPicksBeforeMyNext: LEAGUE - 1, round: 1, leagueSize: LEAGUE,
});

// Tiers are computed from the same VORP the ranking uses, over the whole
// ranked pool, then joined back onto each row by id.
const tiered = assignTiers(ranked, 1.0);
const tierById = new Map(tiered.map((r) => [r.id, r.tier]));

const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('  rank  player            pos  ROS    next5  VORP   scarce risk  value  tier');
  rows.forEach((r, i) => {
    const sc = scarcity[r.element_type];
    console.log(
      `  ${String(i + 1).padStart(4)}  ${r.web_name.padEnd(17).slice(0, 17)} ${POS[r.element_type]}  `
      + `${r.rosValue.toFixed(1).padStart(6)} ${r.nearTermValue.toFixed(1).padStart(6)} `
      + `${r.vorp.toFixed(1).padStart(6)} ${sc.label.padStart(6)} `
      + `${r.risk.toFixed(2).padStart(5)} ${r.draftValue.toFixed(1).padStart(6)} `
      + `${String(tierById.get(r.id) ?? '?').padStart(4)}`);
  });
};

table(`Top 20 overall (${LEAGUE}-manager league)`, ranked.slice(0, 20));
for (const [type, n] of [[1, 10], [2, 20], [3, 20], [4, 15]]) {
  table(`Top ${n} ${POS[type]}`, ranked.filter((r) => r.element_type === type).slice(0, n));
}

console.log(`\nReplacement basis in force: ${replacementBasisForLeagueSize(LEAGUE)} `
  + `(${LEAGUE} managers; demand applies from ${DEMAND_BASIS_SIZES.min} to ${DEMAND_BASIS_SIZES.max})`);
console.log('  The rule and the simulation evidence behind it are in js/draft/config.js.');
console.log('  Across every selectable size:');
{
  const line = [];
  for (let n = LEAGUE_SIZE_MIN; n <= LEAGUE_SIZE_MAX; n++) line.push(`${n}:${replacementBasisForLeagueSize(n)[0]}`);
  console.log(`    ${line.join(' ')}   (d = demand, s = starters)`);
}

console.log('\nReplacement level per position (demand basis vs starters basis)');
for (const t of [1, 2, 3, 4]) {
  const starters = replacementLevel(projected, demand, { basis: 'starters', leagueSize: LEAGUE })[t];
  const pool = projected.filter((r) => r.element_type === t).sort((a, b) => b.proj - a.proj);
  const median = pool.length ? pool[Math.floor(pool.length / 2)].proj : 0;
  const flag = replacement[t] > median ? '  <- INVESTIGATE (above median player)' : '';
  console.log(`  ${POS[t]}  demand-basis ${replacement[t].toFixed(1).padStart(6)}   starters-basis ${starters.toFixed(1).padStart(6)}   median ${median.toFixed(1).padStart(6)}${flag}`);
}

console.log('\nScarcity labels (pre-draft, full outstanding demand)');
for (const t of [1, 2, 3, 4]) {
  const sc = scarcity[t];
  console.log(`  ${POS[t]}  ${sc.label.padEnd(6)} available ${String(sc.available).padStart(3)}  demand ${String(sc.demand).padStart(3)}  ratio ${sc.ratio.toFixed(2)}`);
}

console.log('\nTier distribution (from js/draft/board.js assignTiers — known to degenerate on large pools)');
for (const t of [1, 2, 3, 4]) {
  const rows = tiered.filter((r) => r.element_type === t);
  const counts = new Map();
  for (const r of rows) counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);
  const summary = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([tier, n]) => `T${tier}:${n}`).join(' ');
  console.log(`  ${POS[t]}  ${rows.length} players  ${summary}`);
}

console.log('\nSanity checks');
const top20 = ranked.slice(0, 20);
const keepers = top20.filter((r) => r.element_type === 1).length;
console.log(`  keepers in the top 20: ${keepers} ${keepers >= 5 ? '<- INVESTIGATE' : 'ok'}`);

const bestDef = ranked.find((r) => r.element_type === 2);
const bestDefRank = bestDef ? ranked.indexOf(bestDef) + 1 : -1;
const attackersAboveTopDef = bestDef ? ranked.slice(0, bestDefRank - 1).some((r) => r.element_type === 3 || r.element_type === 4) : true;
console.log(`  top-ranked defender is #${bestDefRank} (${bestDef?.web_name ?? 'n/a'}); an attacker (MID/FWD) ranks above him: ${attackersAboveTopDef ? 'yes, ok' : 'NO <- INVESTIGATE (defender above every forward and midfielder)'}`);

const top10 = ranked.slice(0, 10);
const thin = top10.filter((r) => (r.minutes ?? 0) < 500);
console.log(`  players with under 500 minutes in the top 10: ${thin.length} ${thin.length ? '<- INVESTIGATE (' + thin.map((r) => r.web_name).join(', ') + ')' : 'ok'}`);

const withRank = ranked.filter((r) => Number.isFinite(r.draft_rank)).slice(0, 100);
const disagreements = withRank.filter((r, i) => Math.abs(r.draft_rank - (i + 1)) > 60);
console.log(`  top-100 players more than 60 places from FPL's draft_rank: ${disagreements.length}`);
disagreements.slice(0, 10).forEach((r) => {
  const ours = ranked.indexOf(r) + 1;
  console.log(`    ${r.web_name} — ours #${ours}, FPL #${r.draft_rank}`);
});
console.log('\n  draft_rank is a benchmark, not a target. Large gaps are worth understanding, not eliminating.');
