/**
 * Opportunity episodes: classification, exposure window, and full attrition.
 *
 * Supersedes the transition layer in transfers.mjs for opportunity work, for
 * one reason that matters: that file discards same-club moves as "stayed", so a
 * player promoted with his club never appeared in the cohort at all. A
 * Championship player who goes up WITH his club has, potentially, the same
 * manager, the same teammates and the same role — it is not a transfer, and
 * pooling it with cross-club Championship moves would blur exactly the contrast
 * worth measuring.
 *
 * ── What the destination target actually is ──
 *
 * There is no historical injury or suspension archive for these cohorts. So a
 * realised destination start rate reflects selection AND injury AND suspension
 * AND anything else that kept a player off the pitch. It must NOT be described
 * as P(start | available); the honest name is the realised rate across the
 * player's eligible fixture window, and that is what is computed here.
 *
 * When this eventually meets the live model, availability is already modelled
 * separately — so whatever is learned here must not be applied on top of it, or
 * injury gets counted twice.
 *
 * ── The denominator ──
 *
 * Raw destination minutes are not comparable across episodes: 200 minutes after
 * an August arrival and 200 after a January one mean different things. The
 * denominator is therefore the destination club's fixtures in that season, and
 * episodes whose exposure window cannot be established are separated rather
 * than assumed to be full-season.
 */
import fs from 'node:fs';
import { readRows, paths } from '../store.mjs';
import { COMPETITIONS, seasonsFor } from '../config.mjs';
import { canonicalTla } from '../tla.mjs';

const OUT = 'data/warehouse/research/opportunity-cohort.json';
const FD_SEASONS = seasonsFor('football-data');

/* ---- squads: playerId -> season -> [{competition, team}] ----------- */
const where = new Map();
const meta = new Map();
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of FD_SEASONS) {
    for (const t of await readRows(paths.fdTeams(comp.key, season))) {
      const tla = canonicalTla('football-data', t.tla, comp.key);
      for (const p of t.squad || []) {
        if (!where.has(p.playerId)) where.set(p.playerId, new Map());
        const bys = where.get(p.playerId);
        if (!bys.has(season)) bys.set(season, []);
        bys.get(season).push({ competition: comp.key, team: tla });
        if (!meta.has(p.playerId)) meta.set(p.playerId, { name: p.name, position: p.position ?? null, dateOfBirth: p.dateOfBirth ?? null });
      }
    }
  }
}

/* ---- exposure window: fixtures each club actually played ----------- */
const clubFixtures = new Map();   // `${comp}|${season}|${tla}` -> played count
for (const comp of COMPETITIONS.filter((c) => c.footballData)) {
  for (const season of FD_SEASONS) {
    for (const m of await readRows(paths.fdMatches(comp.key, season))) {
      if (m.homeGoals == null) continue;   // unplayed
      for (const tla of [m.homeTeamTla, m.awayTeamTla]) {
        const k = `${comp.key}|${season}|${canonicalTla('football-data', tla, comp.key)}`;
        clubFixtures.set(k, (clubFixtures.get(k) || 0) + 1);
      }
    }
  }
}

/* ---- bridges and Tier B ------------------------------------------- */
const xref = await readRows(paths.playerXref());
const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));
const tierB = new Map();
for (const c of COMPETITIONS) {
  for (const s of seasonsFor('espn')) {
    const rows = await readRows(paths.espnPlayerSeasons(c.key, s));
    if (rows.length) tierB.set(`${c.key}|${s}`, new Map(rows.map((r) => [r.espnId, r])));
  }
}
const detail = (comp, season, id) => tierB.get(`${comp}|${season}`)?.get(id) ?? null;

/* ---- build every transition, same-club included ------------------- */
const TYPES = {
  EPL_TO_EPL_TRANSFER: 'EPL_TO_EPL_TRANSFER',
  FOREIGN_TO_EPL_TRANSFER: 'FOREIGN_TO_EPL_TRANSFER',
  CHAMPIONSHIP_TO_EPL_TRANSFER: 'CHAMPIONSHIP_TO_EPL_TRANSFER',
  SAME_CLUB_PROMOTION: 'SAME_CLUB_PROMOTION',
};

const attrition = { allTransitions: 0, reasons: {} };
const drop = (why) => { attrition.reasons[why] = (attrition.reasons[why] || 0) + 1; };

const episodes = [];
for (const [playerId, bys] of where) {
  const seasons = [...bys.keys()].sort((a, b) => a - b);
  for (let i = 0; i < seasons.length - 1; i++) {
    const a = seasons[i]; const b = seasons[i + 1];
    if (b !== a + 1) continue;
    const domestic = (l) => l.filter((x) => !x.competition.startsWith('uefa.'));
    const from = domestic(bys.get(a)); const to = domestic(bys.get(b));
    /* Only arrivals INTO the Premier League are episodes here. */
    const dst = to.find((x) => x.competition === 'eng.1');
    if (!dst) continue;
    if (!from.length) continue;

    attrition.allTransitions += 1;

    /* More than one destination club in the landing season means an onward
       loan and a January sale look identical. Excluded, not guessed. */
    if (to.filter((x) => x.competition === 'eng.1').length > 1 || to.length > 1) {
      drop('multi-club in destination season (onward loan / mid-season move indistinguishable)');
      continue;
    }
    if (from.length > 1) { drop('multi-club in source season'); continue; }
    const src = from[0];

    let type;
    if (src.competition === 'eng.1' && src.team === dst.team) { drop('stayed at the same EPL club (not a transition)'); continue; }
    else if (src.competition === 'eng.1') type = TYPES.EPL_TO_EPL_TRANSFER;
    else if (src.competition === 'eng.2' && src.team === dst.team) type = TYPES.SAME_CLUB_PROMOTION;
    else if (src.competition === 'eng.2') type = TYPES.CHAMPIONSHIP_TO_EPL_TRANSFER;
    else if (src.team === dst.team) { drop('same club across different competitions (not a football-environment change)'); continue; }
    else type = TYPES.FOREIGN_TO_EPL_TRANSFER;

    const espnId = espnByFd.get(playerId);
    if (!espnId) { drop('no identity bridge to ESPN'); continue; }

    const s = detail(src.competition, a, espnId);
    if (!s) { drop('no source-side Tier B evidence'); continue; }

    const d = detail('eng.1', b, espnId);
    if (!d) { drop('no destination-side Tier B row (unknown, not zero)'); continue; }

    const fixtures = clubFixtures.get(`eng.1|${b}|${dst.team}`) ?? null;
    if (!fixtures) { drop('destination club fixture count unavailable'); continue; }
    /* An incomplete destination season cannot be a completed outcome. */
    if (fixtures < 30) { drop(`destination season incomplete (${fixtures} fixtures played)`); continue; }

    const srcFixtures = clubFixtures.get(`${src.competition}|${a}|${src.team}`) ?? null;

    episodes.push({
      footballDataPlayerId: playerId,
      espnId,
      name: meta.get(playerId)?.name ?? null,
      position: meta.get(playerId)?.position ?? null,
      type,
      sourceCompetition: src.competition,
      sourceTeam: src.team,
      sourceSeason: a,
      destTeam: dst.team,
      destSeason: b,
      /* ---- source-side predictors ---- */
      srcFixtures,
      srcAppearances: s.appearances,
      srcStarts: s.starts,
      srcMinutes: s.minutes,
      srcFeatureRate: srcFixtures ? s.appearances / srcFixtures : null,
      srcStartRate: srcFixtures ? s.starts / srcFixtures : null,
      srcMinutesRate: srcFixtures ? s.minutes / srcFixtures : null,
      srcMinsPerStart: s.starts > 0 ? s.minutes / s.starts : null,
      /* ---- destination outcome — measured zeros retained ---- */
      destFixtures: fixtures,
      destAppearances: d.appearances,
      destStarts: d.starts,
      destMinutes: d.minutes,
      featureRate: d.appearances / fixtures,
      startRate: d.starts / fixtures,
      minutesRate: d.minutes / fixtures,
      minsWhenFeatured: d.appearances > 0 ? d.minutes / d.appearances : null,
    });
  }
}

/* ---- report -------------------------------------------------------- */
const byType = {};
for (const e of episodes) {
  const t = byType[e.type] ??= { type: e.type, n: 0, zeroMinutes: 0, zeroStarts: 0, bySeason: {} };
  t.n += 1;
  if (e.destMinutes === 0) t.zeroMinutes += 1;
  if (e.destStarts === 0) t.zeroStarts += 1;
  t.bySeason[e.destSeason] = (t.bySeason[e.destSeason] || 0) + 1;
}

const report = {
  builtAt: new Date().toISOString(),
  targetDefinition: 'Realised rate across the eligible fixture window. NOT P(start | available): there is '
    + 'no historical injury or suspension archive, so these rates absorb availability as well as selection.',
  denominator: 'destination club fixtures played in the destination season',
  attrition,
  episodes: episodes.length,
  byType: Object.values(byType),
  cohort: episodes,
};
fs.mkdirSync('data/warehouse/research', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('OPPORTUNITY COHORT\n');
console.log('ATTRITION — every candidate transition into the EPL accounted for');
console.log('  all transitions into eng.1'.padEnd(62) + String(attrition.allTransitions).padStart(5));
for (const [why, n] of Object.entries(attrition.reasons).sort((x, y) => y[1] - x[1])) {
  console.log('    − ' + why.padEnd(58) + String(n).padStart(5));
}
console.log('  = opportunity cohort'.padEnd(62) + String(episodes.length).padStart(5));
const accounted = episodes.length + Object.values(attrition.reasons).reduce((a, b) => a + b, 0);
console.log('  (accounted: ' + accounted + ' of ' + attrition.allTransitions + ')');

console.log('\nBY EPISODE TYPE');
console.log('  type                            n   zeroMins  zeroStarts   by destination season');
for (const t of Object.values(byType).sort((a, b) => b.n - a.n)) {
  console.log('    ' + t.type.padEnd(30) + String(t.n).padStart(3)
    + String(t.zeroMinutes).padStart(10) + String(t.zeroStarts).padStart(12)
    + '   ' + JSON.stringify(t.bySeason));
}
console.log(`\n→ ${OUT}`);
