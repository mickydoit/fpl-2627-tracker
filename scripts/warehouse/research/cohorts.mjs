/**
 * Transfer cohorts for Milestone 3. TWO populations, deliberately different.
 *
 * ── Why they cannot be the same set ──
 *
 * PRODUCTION translation predicts a per-90 rate, so it needs a minutes
 * denominator on both sides and a destination-minutes threshold is legitimate.
 *
 * OPPORTUNITY translation predicts minutes. Filtering the cohort on destination
 * minutes conditions on the target: a set of arrivals with 450+ EPL minutes has
 * already dropped everyone who arrived, played 200 minutes and disappeared, so
 * anything learned from it will overestimate how much new signings play. That is
 * the failure mode fixed on 28 August — evidence-free players reaching
 * P(start) = 1.000 — and it compounds registered hypothesis H1.
 *
 * So: no destination-minutes threshold in the opportunity cohort, at any value.
 * Zeros are retained because zeros are the signal.
 *
 * ── But zero only means something if there was a chance to play ──
 *
 * A player who moved and was immediately loaned on did not have a manager
 * decline to pick him. Counting that as "zero minutes, not selected" teaches the
 * model the wrong thing. Episodes are therefore classified, and the honest
 * classes are narrower than one would like, because squad lists cannot see a
 * registration dispute or a January arrival date:
 *
 *   eligible       in the destination club's squad AND in that club's ESPN
 *                  roster census for the season — a real exposure window.
 *   multi-club     appears in more than one club's squad in the destination
 *                  season. An onward loan and a January sale look identical
 *                  here, so it is excluded rather than guessed at.
 *   undetermined   in the destination squad but absent from the ESPN census.
 *                  This is NOT evidence of non-exposure: the census itself is
 *                  incomplete. Kept as a labelled third group exactly as the
 *                  brief requires, and never silently folded into either side.
 *
 * Only `eligible` enters the primary opportunity cohort. `undetermined` is
 * reported alongside so the size of the doubt is visible.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/cohorts.json';
const THRESHOLDS = [180, 450, 900, 1800];

/* ---- bridges ------------------------------------------------------ */
const xref = await readRows(paths.playerXref());
const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));

/* Tier B minutes, indexed by competition-season then espnId. */
const tierB = new Map();
for (const c of COMPETITIONS) {
  for (const s of seasonsFor('espn')) {
    const rows = await readRows(paths.espnPlayerSeasons(c.key, s));
    if (rows.length) tierB.set(`${c.key}|${s}`, new Map(rows.map((r) => [r.espnId, r])));
  }
}
const detail = (comp, season, espnId) => tierB.get(`${comp}|${season}`)?.get(espnId) ?? null;

/* ESPN roster census, for the exposure-window test. */
const census = new Map();
for (const c of COMPETITIONS) {
  for (const s of seasonsFor('espn')) {
    const rows = await readRows(paths.espnRosters(c.key, s));
    if (rows.length) census.set(`${c.key}|${s}`, new Set(rows.map((r) => r.espnId)));
  }
}
const inCensus = (comp, season, espnId) => census.get(`${comp}|${season}`)?.has(espnId) ?? false;

/* How many clubs' squads a football-data player appears in, per season. */
const clubsPerSeason = new Map();   // `${playerId}|${season}` -> Set(tla)
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const s of seasonsFor('football-data')) {
    for (const t of await readRows(paths.fdTeams(comp.key, s))) {
      const tla = canonicalTla('football-data', t.tla, comp.key);
      for (const p of t.squad || []) {
        const k = `${p.playerId}|${s}`;
        if (!clubsPerSeason.has(k)) clubsPerSeason.set(k, new Set());
        clubsPerSeason.get(k).add(tla);
      }
    }
  }
}

/* ---- build episodes ----------------------------------------------- */
const moves = (await readRows(paths.transfers())).filter((m) => m.toCompetition === 'eng.1');
const episodes = [];
for (const m of moves) {
  const espnId = espnByFd.get(m.footballDataPlayerId);
  const src = espnId ? detail(m.fromCompetition, m.fromSeason, espnId) : null;
  const dst = espnId ? detail('eng.1', m.toSeason, espnId) : null;

  const clubs = clubsPerSeason.get(`${m.footballDataPlayerId}|${m.toSeason}`);
  let eligibility;
  if (!espnId) eligibility = 'unbridged';
  else if (clubs && clubs.size > 1) eligibility = 'multi-club';
  else if (inCensus('eng.1', m.toSeason, espnId)) eligibility = 'eligible';
  else eligibility = 'undetermined';

  episodes.push({
    footballDataPlayerId: m.footballDataPlayerId,
    espnId: espnId ?? null,
    name: m.name,
    position: m.position ?? null,
    fromCompetition: m.fromCompetition,
    fromTeam: m.fromTeam,
    fromSeason: m.fromSeason,
    toTeam: m.toTeam,
    toSeason: m.toSeason,
    eligibility,
    /* Source-side evidence — required by BOTH cohorts. */
    sourceMinutes: src?.minutes ?? null,
    sourceStarts: src?.starts ?? null,
    sourceAppearances: src?.appearances ?? null,
    /* Destination outcome — the TARGET for opportunity, a FILTER for
       production. Null means unfetched; 0 means measured zero. */
    destMinutes: dst?.minutes ?? null,
    destStarts: dst?.starts ?? null,
    destAppearances: dst?.appearances ?? null,
    hasSourceEvidence: src != null,
    hasDestEvidence: dst != null,
  });
}

/* ---- cohorts ------------------------------------------------------- */
const byLeague = {};
for (const e of episodes) {
  const L = byLeague[e.fromCompetition] ??= {
    route: `${e.fromCompetition} -> eng.1`, totalMoves: 0,
    unbridged: 0, multiClub: 0, undetermined: 0, eligible: 0,
    sourceEvidence: 0, destEvidence: 0,
    opportunityCohort: 0, opportunityZeroMinute: 0,
    production: Object.fromEntries(THRESHOLDS.map((t) => [`withBoth${t}`, 0])),
  };
  L.totalMoves += 1;
  if (e.eligibility === 'unbridged') L.unbridged += 1;
  if (e.eligibility === 'multi-club') L.multiClub += 1;
  if (e.eligibility === 'undetermined') L.undetermined += 1;
  if (e.eligibility === 'eligible') L.eligible += 1;
  if (e.hasSourceEvidence) L.sourceEvidence += 1;
  if (e.hasDestEvidence) L.destEvidence += 1;

  /* OPPORTUNITY: eligible + source evidence. NO destination filter.
     A destination row that exists and reads 0 is kept; a destination row that
     was never fetched is NOT the same thing and is excluded, because we cannot
     tell zero from unknown. */
  if (e.eligibility === 'eligible' && e.hasSourceEvidence && e.hasDestEvidence) {
    L.opportunityCohort += 1;
    if (e.destMinutes === 0) L.opportunityZeroMinute += 1;
  }

  /* PRODUCTION: minutes on both sides, at each threshold. */
  if (e.hasSourceEvidence && e.hasDestEvidence) {
    for (const t of THRESHOLDS) {
      if (e.sourceMinutes >= t && e.destMinutes >= t) L.production[`withBoth${t}`] += 1;
    }
  }
}

const report = {
  builtAt: new Date().toISOString(),
  rule: 'The opportunity cohort carries NO destination-minutes threshold at any value. '
    + 'Only `eligible` episodes enter it; `undetermined` is reported alongside so the size of the '
    + 'doubt is visible, and is never folded into either side.',
  thresholds: THRESHOLDS,
  totalMovesIntoEpl: episodes.length,
  byLeague,
  episodes,
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

/* ---- console ------------------------------------------------------- */
console.log('TRANSFER COHORTS — opportunity and production are different populations\n');
console.log('route             moves  unbrdg  multi  undet  elig   srcEv  dstEv | OPP  (zero) | 180  450  900 1800');
const order = Object.values(byLeague).sort((a, b) => b.totalMoves - a.totalMoves);
for (const L of order) {
  console.log('  ' + L.route.padEnd(17)
    + String(L.totalMoves).padStart(5) + String(L.unbridged).padStart(8) + String(L.multiClub).padStart(7)
    + String(L.undetermined).padStart(7) + String(L.eligible).padStart(6)
    + String(L.sourceEvidence).padStart(8) + String(L.destEvidence).padStart(6)
    + ' |' + String(L.opportunityCohort).padStart(4) + String('(' + L.opportunityZeroMinute + ')').padStart(7)
    + ' |' + THRESHOLDS.map((t) => String(L.production[`withBoth${t}`]).padStart(5)).join(''));
}
const sum = (f) => order.reduce((a, L) => a + (typeof f === 'string' ? L[f] : f(L)), 0);
console.log('  ' + 'TOTAL'.padEnd(17) + String(sum('totalMoves')).padStart(5)
  + String(sum('unbridged')).padStart(8) + String(sum('multiClub')).padStart(7)
  + String(sum('undetermined')).padStart(7) + String(sum('eligible')).padStart(6)
  + String(sum('sourceEvidence')).padStart(8) + String(sum('destEvidence')).padStart(6)
  + ' |' + String(sum('opportunityCohort')).padStart(4)
  + String('(' + sum('opportunityZeroMinute') + ')').padStart(7)
  + ' |' + THRESHOLDS.map((t) => String(sum((L) => L.production[`withBoth${t}`])).padStart(5)).join(''));

console.log(`\n→ ${OUT}`);
