/**
 * Team attack and defence baseline, without expected goals. DESCRIPTIVE ONLY.
 *
 * The warehouse has no xG and will not invent any. What it does have, on every
 * collected team-match row, is shots, shots on target, possession, corners,
 * pass accuracy, tackles, saves and the result — and the question is which of
 * those, if any, carries information about future goals.
 *
 * ── Three tests, in increasing order of what they would justify ──
 *
 *   1. STABILITY. Split each club's season into odd and even matches and
 *      correlate the two halves. A metric that does not agree with itself
 *      inside one season cannot describe a team, and no amount of downstream
 *      modelling repairs that.
 *
 *   2. SAME-SEASON EXPLANATION. Does the metric track goals in the season it
 *      was measured? Necessary, and almost free — shots and goals are close
 *      relatives — so passing this proves little on its own.
 *
 *   3. NEXT-SEASON PREDICTION, against a control. Does season N's metric
 *      predict season N+1's goals better than season N's GOALS do? This is the
 *      only test that would justify replacing anything, because the incumbent
 *      fallback already has last season's goals available to it.
 *
 * Test 3 is where most shot-based metrics earn or lose their place, and the
 * control is deliberately the strongest cheap alternative rather than a straw
 * man.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { seasonsFor, WAREHOUSE_SEASONS } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/team-strength.json';
const COMP = process.env.RESEARCH_COMPETITION || 'eng.1';
const MIN_MATCHES = 30;   // a club needs most of a season before it is described

function pearson(pairs) {
  const n = pairs.length;
  if (n < 4) return { n, r: null, note: 'too few clubs' };
  const xs = pairs.map((p) => p[0]); const ys = pairs.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!sxx || !syy) return { n, r: null, note: 'no variation' };
  const r = sxy / Math.sqrt(sxx * syy);
  const z = 0.5 * Math.log((1 + r) / (1 - r)); const se = 1 / Math.sqrt(n - 3);
  return { n, r: +r.toFixed(3), ci95: [+Math.tanh(z - 1.96 * se).toFixed(3), +Math.tanh(z + 1.96 * se).toFixed(3)] };
}

/* ---- per-club season aggregates from team-match rows -------------- */
async function aggregate(comp, season) {
  const rows = await readRows(paths.teamMatch(comp, season));
  const by = new Map();
  for (const r of rows) {
    const k = r.team; if (!k) continue;
    const a = by.get(k) || { team: k, matches: 0, odd: [], even: [],
      gf: 0, ga: 0, shots: 0, shotsAg: 0, sot: 0, sotAg: 0, poss: 0, corners: 0, passPct: 0, saves: 0 };
    a.matches += 1;
    a.gf += r.goalsFor ?? 0; a.ga += r.goalsAgainst ?? 0;
    a.shots += r.stats?.totalShots ?? 0; a.shotsAg += r.opponentStats?.totalShots ?? 0;
    a.sot += r.stats?.shotsOnTarget ?? 0; a.sotAg += r.opponentStats?.shotsOnTarget ?? 0;
    a.poss += r.stats?.possessionPct ?? 0; a.corners += r.stats?.wonCorners ?? 0;
    a.passPct += r.stats?.passPct ?? 0; a.saves += r.stats?.saves ?? 0;
    /* Split-half buckets, by match date so the split is not an artefact of
       collection order. */
    (a.matches % 2 ? a.odd : a.even).push(r);
    by.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of by) {
    if (a.matches < MIN_MATCHES) continue;
    const m = a.matches;
    out.set(k, {
      team: k, matches: m,
      goalsFor: a.gf, goalsAgainst: a.ga,
      gfPerGame: +(a.gf / m).toFixed(3), gaPerGame: +(a.ga / m).toFixed(3),
      shotsPerGame: +(a.shots / m).toFixed(3), shotsAgainstPerGame: +(a.shotsAg / m).toFixed(3),
      sotPerGame: +(a.sot / m).toFixed(3), sotAgainstPerGame: +(a.sotAg / m).toFixed(3),
      shotShare: a.shots + a.shotsAg ? +(a.shots / (a.shots + a.shotsAg)).toFixed(4) : null,
      sotShare: a.sot + a.sotAg ? +(a.sot / (a.sot + a.sotAg)).toFixed(4) : null,
      possession: +(a.poss / m).toFixed(2), cornersPerGame: +(a.corners / m).toFixed(3),
      passPct: +(a.passPct / m).toFixed(2), savesPerGame: +(a.saves / m).toFixed(3),
      _halves: { odd: a.odd, even: a.even },
    });
  }
  return out;
}

/* ---- goals from the structural feed, for every season ------------- */
async function goalsFromStructure(comp, season) {
  const rows = await readRows(paths.fdMatches(comp, season));
  const by = new Map();
  for (const m of rows) {
    if (m.homeGoals == null) continue;
    const h = canonicalTla('football-data', m.homeTeamTla, comp);
    const a = canonicalTla('football-data', m.awayTeamTla, comp);
    for (const [t, gf, ga] of [[h, m.homeGoals, m.awayGoals], [a, m.awayGoals, m.homeGoals]]) {
      const p = by.get(t) || { team: t, matches: 0, gf: 0, ga: 0 };
      p.matches += 1; p.gf += gf; p.ga += ga; by.set(t, p);
    }
  }
  for (const v of by.values()) {
    v.gfPerGame = +(v.gf / v.matches).toFixed(3);
    v.gaPerGame = +(v.ga / v.matches).toFixed(3);
  }
  return by;
}

/* ---- run ---------------------------------------------------------- */
const seasons = WAREHOUSE_SEASONS;
const aggBySeason = {};
for (const s of seasons) {
  const a = await aggregate(COMP, s);
  if (a.size) aggBySeason[s] = a;
}
const structBySeason = {};
for (const s of seasonsFor('football-data')) {
  const g = await goalsFromStructure(COMP, s);
  if (g.size) structBySeason[s] = g;
}

const METRICS = [
  ['shotsPerGame', 'attack'], ['sotPerGame', 'attack'], ['shotShare', 'attack'],
  ['sotShare', 'attack'], ['possession', 'attack'], ['cornersPerGame', 'attack'], ['passPct', 'attack'],
  ['shotsAgainstPerGame', 'defence'], ['sotAgainstPerGame', 'defence'], ['savesPerGame', 'defence'],
];

const report = { builtAt: new Date().toISOString(), competition: COMP, seasonsAggregated: Object.keys(aggBySeason).map(Number), tests: {} };

/* 1. stability: odd vs even matches within a season */
const stability = {};
for (const [season, agg] of Object.entries(aggBySeason)) {
  const usable = [...agg.values()].filter((a) => a._halves.odd.length >= 12 && a._halves.even.length >= 12);
  if (usable.length < 6) continue;
  const half = (rows, get) => rows.reduce((s, r) => s + (get(r) ?? 0), 0) / rows.length;
  const getters = {
    shotsPerGame: (r) => r.stats?.totalShots, sotPerGame: (r) => r.stats?.shotsOnTarget,
    possession: (r) => r.stats?.possessionPct, cornersPerGame: (r) => r.stats?.wonCorners,
    shotsAgainstPerGame: (r) => r.opponentStats?.totalShots,
    sotAgainstPerGame: (r) => r.opponentStats?.shotsOnTarget,
    gfPerGame: (r) => r.goalsFor, gaPerGame: (r) => r.goalsAgainst,
  };
  stability[season] = {};
  for (const [name, get] of Object.entries(getters)) {
    stability[season][name] = pearson(usable.map((a) => [half(a._halves.odd, get), half(a._halves.even, get)]));
  }
}
report.tests.stability = stability;

/* 2. same-season explanation, and 3. next-season prediction vs control */
const sameSeason = {}; const nextSeason = {};
for (const [seasonStr, agg] of Object.entries(aggBySeason)) {
  const season = Number(seasonStr);
  const clubs = [...agg.values()];
  if (clubs.length < 6) continue;
  sameSeason[season] = {};
  for (const [m, side] of METRICS) {
    const target = side === 'attack' ? 'gfPerGame' : 'gaPerGame';
    sameSeason[season][`${m} -> ${target}`] = pearson(clubs.filter((c) => c[m] != null).map((c) => [c[m], c[target]]));
  }
  const nxt = structBySeason[season + 1];
  if (!nxt) continue;
  nextSeason[`${season}->${season + 1}`] = {};
  for (const [m, side] of METRICS) {
    const target = side === 'attack' ? 'gfPerGame' : 'gaPerGame';
    const pairs = clubs.filter((c) => c[m] != null && nxt.has(c.team) && nxt.get(c.team).matches >= 20)
      .map((c) => [c[m], nxt.get(c.team)[target]]);
    nextSeason[`${season}->${season + 1}`][`${m} -> next ${target}`] = pearson(pairs);
  }
  /* The control the incumbent already has: last season's goals. */
  for (const [target, label] of [['gfPerGame', 'CONTROL goals for'], ['gaPerGame', 'CONTROL goals against']]) {
    const pairs = clubs.filter((c) => nxt.has(c.team) && nxt.get(c.team).matches >= 20)
      .map((c) => [c[target], nxt.get(c.team)[target]]);
    nextSeason[`${season}->${season + 1}`][`${label} -> next ${target}`] = pearson(pairs);
  }
}
report.tests.sameSeason = sameSeason;
report.tests.nextSeason = nextSeason;
report.caveat = 'DESCRIPTIVE ONLY. No coefficient here may enter a projection. A metric only earns '
  + 'consideration by beating the CONTROL rows in the next-season test, not by looking sophisticated.';

fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

/* ---- console ------------------------------------------------------ */
console.log(`TEAM STRENGTH BASELINE — ${COMP}  (descriptive only)\n`);
console.log('seasons with enough collected matches:', report.seasonsAggregated.join(', ') || 'none');
for (const [s, agg] of Object.entries(aggBySeason)) console.log(`  ${s}: ${agg.size} clubs with >=${MIN_MATCHES} matches`);

console.log('\n1. STABILITY — odd vs even matches within a season (does the metric agree with itself?)');
for (const [s, m] of Object.entries(stability)) {
  console.log(`  season ${s}:`);
  for (const [k, v] of Object.entries(m).sort((a, b) => (b[1].r ?? -9) - (a[1].r ?? -9))) {
    console.log('    ' + k.padEnd(24) + (v.r === null ? `n=${v.n} ${v.note}` : `r=${String(v.r).padStart(6)}  n=${v.n}`));
  }
}
console.log('\n2. SAME-SEASON — metric vs goals in the same season');
for (const [s, m] of Object.entries(sameSeason)) {
  console.log(`  season ${s}:`);
  for (const [k, v] of Object.entries(m).sort((a, b) => Math.abs(b[1].r ?? 0) - Math.abs(a[1].r ?? 0))) {
    console.log('    ' + k.padEnd(42) + (v.r === null ? `n=${v.n} ${v.note}` : `r=${String(v.r).padStart(6)}  n=${v.n}`));
  }
}
console.log('\n3. NEXT-SEASON — metric vs NEXT season\'s goals, against the control');
for (const [k, m] of Object.entries(nextSeason)) {
  console.log(`  ${k}:`);
  for (const [name, v] of Object.entries(m).sort((a, b) => Math.abs(b[1].r ?? 0) - Math.abs(a[1].r ?? 0))) {
    const mark = name.startsWith('CONTROL') ? '  <== control' : '';
    console.log('    ' + name.padEnd(46) + (v.r === null ? `n=${v.n} ${v.note}` : `r=${String(v.r).padStart(6)}  n=${v.n}  CI [${v.ci95[0]}, ${v.ci95[1]}]`) + mark);
  }
}
console.log(`\n→ ${OUT}`);
