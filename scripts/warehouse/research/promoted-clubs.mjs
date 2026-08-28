/**
 * Promoted-club baseline. DESCRIPTIVE ONLY — no coefficients.
 *
 * The question: does a promoted club's first Premier League season vary with
 * how strong it was in the Championship, and if so, along what measure?
 *
 * This report deliberately stops before answering it in a form the model could
 * consume. It reports the cohort, the paired seasons, and the relationships,
 * with the sample size attached to every one — because the honest headline here
 * is that the sample is small, and a correlation on six clubs is a description
 * of six clubs rather than a finding about football.
 *
 * ── Why the cohort is the size it is ──
 *
 * A promotion is detected by presence: a club in eng.1 season N that was in
 * eng.2 season N-1. That needs consecutive seasons of BOTH competitions, and
 * football-data's free tier starts at 2023. So promotions are detectable for
 * 2024, 2025 and 2026, and only 2024 and 2025 have a COMPLETED first Premier
 * League season to pair against. That is six clubs, and no amount of
 * presentation makes six clubs a large sample.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/promoted-clubs.json';
const SEASONS = seasonsFor('football-data');

/** Pearson r, with n attached so it can never be quoted without its sample. */
function correlate(pairs) {
  const xs = pairs.map((p) => p[0]); const ys = pairs.map((p) => p[1]);
  const n = xs.length;
  if (n < 3) return { n, r: null, note: 'too few pairs to correlate' };
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return { n, r: null, note: 'no variation on one axis' };
  const r = sxy / Math.sqrt(sxx * syy);
  /* Fisher z 95% interval. On n=6 this interval is enormous, which is the point:
     the number is reported WITH the reason not to trust it. */
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const lo = Math.tanh(z - 1.96 * se); const hi = Math.tanh(z + 1.96 * se);
  return { n, r: +r.toFixed(3), ci95: [+lo.toFixed(3), +hi.toFixed(3)] };
}

/* ---- load structural tables -------------------------------------- */
const table = {};   // comp -> season -> [rows]
for (const comp of ['eng.1', 'eng.2']) {
  table[comp] = {};
  for (const s of SEASONS) {
    const rows = await readRows(paths.fdStandings(comp, s));
    if (rows.length) table[comp][s] = rows;
  }
}

/* ---- ESPN team-match aggregates, where collected ------------------ */
async function espnAgg(comp, season) {
  const rows = await readRows(paths.teamMatch(comp, season));
  const by = new Map();
  for (const r of rows) {
    const k = r.team;
    const prev = by.get(k) || { team: k, matches: 0, shots: 0, shotsAgainst: 0, sot: 0, sotAgainst: 0, poss: 0, corners: 0 };
    prev.matches += 1;
    prev.shots += r.stats?.totalShots ?? 0;
    prev.sot += r.stats?.shotsOnTarget ?? 0;
    prev.shotsAgainst += r.opponentStats?.totalShots ?? 0;
    prev.sotAgainst += r.opponentStats?.shotsOnTarget ?? 0;
    prev.poss += r.stats?.possessionPct ?? 0;
    prev.corners += r.stats?.wonCorners ?? 0;
    by.set(k, prev);
  }
  /* Coverage gate. The ESPN backfill is incremental, so a club can have two
     matches collected out of thirty-eight — and a "possession 77.8%" computed
     from one home win against a relegated side reads exactly like a season
     average in a table. Below the threshold the aggregate is withheld and the
     match count is reported instead, so thin coverage is visible rather than
     disguised as a measurement. */
  const MIN_MATCHES = 10;
  for (const v of by.values()) {
    if (v.matches < MIN_MATCHES) {
      v.insufficient = true;
      v.shotsPerGame = null; v.shotsAgainstPerGame = null;
      v.shotDiffPerGame = null; v.sotDiffPerGame = null; v.possession = null;
      continue;
    }
    v.shotsPerGame = v.matches ? +(v.shots / v.matches).toFixed(2) : null;
    v.shotsAgainstPerGame = v.matches ? +(v.shotsAgainst / v.matches).toFixed(2) : null;
    v.shotDiffPerGame = v.matches ? +((v.shots - v.shotsAgainst) / v.matches).toFixed(2) : null;
    v.sotDiffPerGame = v.matches ? +((v.sot - v.sotAgainst) / v.matches).toFixed(2) : null;
    v.possession = v.matches ? +(v.poss / v.matches).toFixed(1) : null;
  }
  return by;
}

/* ---- detect promotions ------------------------------------------- */
const cohort = [];
for (const season of SEASONS) {
  const prev = season - 1;
  const epl = table['eng.1'][season]; const ch = table['eng.2'][prev];
  if (!epl || !ch) continue;
  const chByTla = new Map(ch.map((r) => [canonicalTla('football-data', r.teamTla, 'eng.2'), r]));
  for (const e of epl) {
    const tla = canonicalTla('football-data', e.teamTla, 'eng.1');
    const from = chByTla.get(tla);
    if (!from) continue;   // was in the Premier League last season

    /* Route matters: an automatic champion and a playoff winner are not the
       same football team, and lumping them is the first thing a naive promoted
       prior gets wrong. Reported as the raw position too, so a continuous
       measure stays available. */
    const route = from.position <= 2 ? 'automatic' : 'playoff';
    cohort.push({
      club: tla,
      name: e.teamName,
      eplSeason: season,
      championshipSeason: prev,
      route,
      championship: {
        position: from.position, points: from.points, played: from.played,
        won: from.won, draw: from.draw, lost: from.lost,
        goalsFor: from.goalsFor, goalsAgainst: from.goalsAgainst, goalDifference: from.goalDifference,
        pointsPerGame: +(from.points / from.played).toFixed(3),
        gdPerGame: +(from.goalDifference / from.played).toFixed(3),
      },
      epl: {
        position: e.position, points: e.points, played: e.played,
        won: e.won, draw: e.draw, lost: e.lost,
        goalsFor: e.goalsFor, goalsAgainst: e.goalsAgainst, goalDifference: e.goalDifference,
        pointsPerGame: +(e.points / e.played).toFixed(3),
        gdPerGame: +(e.goalDifference / e.played).toFixed(3),
        complete: e.played >= 38,
      },
    });
  }
}

/* attach ESPN shot/possession context where it has been collected */
for (const c of cohort) {
  const chAgg = await espnAgg('eng.2', c.championshipSeason);
  const eplAgg = await espnAgg('eng.1', c.eplSeason);
  c.championship.espn = chAgg.get(c.club) ?? null;
  c.epl.espn = eplAgg.get(c.club) ?? null;
}

const complete = cohort.filter((c) => c.epl.complete);

/* ---- relationships, each with its sample size -------------------- */
const rel = {
  'championship PPG -> EPL PPG': correlate(complete.map((c) => [c.championship.pointsPerGame, c.epl.pointsPerGame])),
  'championship GD/game -> EPL GD/game': correlate(complete.map((c) => [c.championship.gdPerGame, c.epl.gdPerGame])),
  'championship position -> EPL points': correlate(complete.map((c) => [c.championship.position, c.epl.points])),
  'championship GF -> EPL GF': correlate(complete.map((c) => [c.championship.goalsFor, c.epl.goalsFor])),
  'championship GA -> EPL GA': correlate(complete.map((c) => [c.championship.goalsAgainst, c.epl.goalsAgainst])),
};

const byRoute = {};
for (const c of complete) {
  (byRoute[c.route] ??= []).push(c);
}
const routeSummary = Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, {
  clubs: v.length,
  meanEplPoints: +(v.reduce((a, c) => a + c.epl.points, 0) / v.length).toFixed(1),
  meanEplGD: +(v.reduce((a, c) => a + c.epl.goalDifference, 0) / v.length).toFixed(1),
  meanChampionshipPPG: +(v.reduce((a, c) => a + c.championship.pointsPerGame, 0) / v.length).toFixed(3),
}]));

const report = {
  builtAt: new Date().toISOString(),
  scope: {
    footballDataSeasons: SEASONS,
    promotionsDetectable: [...new Set(cohort.map((c) => c.eplSeason))],
    note: 'A promotion needs consecutive eng.1 and eng.2 seasons. football-data free tier starts at 2023, '
      + 'so 2024 is the earliest detectable promotion and 2026 has no completed EPL season to pair.',
  },
  cohortSize: cohort.length,
  completePairs: complete.length,
  cohort,
  relationships: rel,
  byRoute: routeSummary,
  caveat: 'DESCRIPTIVE ONLY. No coefficient here may enter a projection. With this many clubs every '
    + 'confidence interval below spans most of the possible range, and the route split has 2-4 clubs a side.',
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

/* ---- console ----------------------------------------------------- */
console.log('PROMOTED-CLUB BASELINE  (descriptive only)\n');
console.log(`cohort: ${cohort.length} club-seasons, ${complete.length} with a completed EPL season\n`);
console.log('club  promoted  route      Champ: pos  pts  GD    ->  EPL: pos  pts   GD   shots/g  poss');
for (const c of cohort.sort((a, b) => a.eplSeason - b.eplSeason || a.championship.position - b.championship.position)) {
  console.log('  ' + c.club.padEnd(5) + String(c.eplSeason).padEnd(10) + c.route.padEnd(11)
    + String(c.championship.position).padStart(9) + String(c.championship.points).padStart(5)
    + String(c.championship.goalDifference).padStart(5)
    + '    ->' + String(c.epl.position).padStart(8) + String(c.epl.points).padStart(5)
    + String(c.epl.goalDifference).padStart(5)
    + String(c.epl.espn?.shotsPerGame ?? (c.epl.espn?.matches ? `(${c.epl.espn.matches}m)` : '-')).padStart(9)
    + String(c.epl.espn?.possession ?? '-').padStart(6)
    + (c.epl.complete ? '' : '   (in progress)'));
}
console.log('\nrelationships (Pearson r, 95% CI):');
for (const [k, v] of Object.entries(rel)) {
  console.log('  ' + k.padEnd(38) + (v.r === null ? `n=${v.n}  ${v.note}` : `n=${v.n}  r=${String(v.r).padStart(6)}  CI [${v.ci95[0]}, ${v.ci95[1]}]`));
}
console.log('\nby promotion route:');
for (const [k, v] of Object.entries(routeSummary)) {
  console.log('  ' + k.padEnd(11) + `clubs ${v.clubs}  mean EPL points ${v.meanEplPoints}  mean EPL GD ${v.meanEplGD}  mean Champ PPG ${v.meanChampionshipPPG}`);
}
console.log(`\n→ ${OUT}`);
