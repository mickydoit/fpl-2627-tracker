/**
 * Sanity checks for the model and optimiser. Run with `node scripts/test.mjs`
 * after `node scripts/make-sample.mjs`. The refresh workflow runs derive.mjs,
 * which asserts squad legality on real data; this file covers the maths.
 */
import fs from 'node:fs';
import { readJSON } from './lib/io.mjs';
import {
  projectAll, poissonAtLeast, availability, inferGamesPlayed,
  teamDefence, upcomingByTeam, SQUAD_RULES, projectFixture, buildContext,
  actionableEvent, DEFCON_THRESHOLD, DEFCON_PTS, livePointsFor,
  DEFAULTS as MODEL_DEFAULTS, availabilityForFixture, availabilitySource,
} from '../js/model.js';
import { adaptDraftElements, draftPrior } from '../js/draft/adapt.js';
import { notesFor, justifyMove, fixturePhrase, SOURCE } from '../js/explain.js';
import { RATING_HORIZONS as DRAFT_RATING_HORIZONS } from '../js/draft/config.js';
import { snakePicks, replacementRank, buildBoard, assignTiers } from '../js/draft/board.js';
import { ownershipFrom, availableRows, deriveSlot, myRoster, positionsNeeded } from '../js/draft/live.js';
import { makeRng, picksBetween, survival } from '../js/draft/simulate.js';
import { recommend } from '../js/draft/advise.js';
import { runDraft, STRATEGIES } from '../js/draft/compete.js';
import { optimiseSquad, validate, bestXI, scoreSquad, suggestTransfers, canSwap, splitXI,
  optimiseWithinTransfers, captaincyBonus, captainForGW,
  bestXIForGW, scoreSquadByGW, scoreSquadFixed } from '../js/optimiser.js';
import { hydrate, PRIOR_DEFAULTS, poolPlayerSeasons, espnEvidence, decomposeOpportunity } from '../js/prior.js';
import { ALLOWED_MODEL_SEASONS, CURRENT_SEASON, isAllowedSeason, seasonStartYear,
  assertAllowedSeason, onlyAllowedSeasons } from '../js/seasons.js';
import { rateSquad, depthCost, minutesSecurity, flexibility, bestLineTotal, scoreRatio,
  RATING_WEIGHTS, RATING_HORIZONS, RATING_FLOOR } from '../js/rating.js';
import { topMoves, bestMove } from '../js/transfer-advice.js';
import { groupByDay, MATCH_VIEWS } from '../js/matches.js';
import { parseReturnBoundary } from '../js/availability-news.js';
import { carryForward, schemaFor, ARCHIVE_SCHEMA, AVAILABILITY_FIELDS, DIAGNOSTIC_FIELDS, TEAM_CONTEXT_FIELDS, ACTUAL_FIELDS } from './lib/archive-schema.mjs';

let failures = 0;
let checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const MIN_DEF = 3;

console.log('\nPoisson');
ok('P(X>=0) is 1', near(poissonAtLeast(3, 0), 1));
ok('P(X>=1) with lambda 1', near(poissonAtLeast(1, 1), 1 - Math.exp(-1), 1e-9));
ok('lambda 0 gives 0', poissonAtLeast(0, 5) === 0);
ok('monotone in lambda', poissonAtLeast(12, 10) > poissonAtLeast(6, 10));
ok('monotone in threshold', poissonAtLeast(10, 8) > poissonAtLeast(10, 14));
ok('bounded to [0,1]', poissonAtLeast(50, 1) <= 1 && poissonAtLeast(0.1, 20) >= 0);

console.log('\nAvailability');
ok('available is 1', availability({ status: 'a' }) === 1);
ok('injured is 0', availability({ status: 'i' }) === 0);
ok('suspended is 0', availability({ status: 's' }) === 0);
ok('doubtful uses chance', availability({ status: 'd', chance_of_playing_next_round: 75 }) === 0.75);
ok('doubtful without a chance defaults to 0.5', availability({ status: 'd' }) === 0.5);
ok('available but flagged 50% respects it', availability({ status: 'a', chance_of_playing_next_round: 50 }) === 0.5);

const boot = await readJSON('data/bootstrap.json');
const fixtures = await readJSON('data/fixtures.json', []);
if (!boot?.elements?.length) {
  console.error('\nNo data — run `node scripts/make-sample.mjs` first.');
  process.exit(1);
}

console.log('\nContext');
const games = inferGamesPlayed(boot.elements);
ok('games inferred in a sane range', games >= 1 && games <= 60, `got ${games}`);
const defence = teamDefence(boot.elements, boot.teams);
ok('every team has a defensive rating', Object.keys(defence).length === 20);
ok('ratings are plausible', Object.values(defence).every((v) => v > 0.3 && v < 3.5));

const upcoming = upcomingByTeam(fixtures, 1, 5);
ok('every team has upcoming fixtures', Object.keys(upcoming).length === 20);
const perTeam = Object.values(upcoming).map((f) => f.length);
ok('fixture counts match the horizon', perTeam.every((n) => n >= 1 && n <= 10), `got ${[...new Set(perTeam)]}`);

console.log('\nProjections');
const { rows, ctx } = projectAll(boot, fixtures, { horizon: 5 });
ok('all players projected', rows.length === boot.elements.length);
ok('no negative projections', rows.every((p) => p.proj >= 0));
ok('no NaN projections', rows.every((p) => Number.isFinite(p.proj)));
/* An injured player used to project zero for every remaining gameweek, so a
   calf strain with a published comeback date erased eight months of football.
   Availability is now judged per fixture, so the assertion splits: without a
   parsable return he is still zero throughout, and with one he is zero only
   until his own team's kickoff passes the boundary. */
{
  const flagged = rows.filter((p) => p.status === 'i');
  const noReturn = flagged.filter((p) => !parseReturnBoundary(p));
  ok('injured players with no published return still project 0',
    noReturn.every((p) => p.proj === 0), `${noReturn.filter((p) => p.proj > 0).length} exceptions`);
  ok('and that is most of them', noReturn.length > flagged.length / 2,
    `${noReturn.length} of ${flagged.length}`);
  const withReturn = flagged.filter((p) => parseReturnBoundary(p));
  ok('a published return date is only honoured from that fixture onward',
    withReturn.every((p) => {
      const b = parseReturnBoundary(p).boundary;
      const fxs = ctx.upcoming[p.team] || [];
      const anyAfter = fxs.some((f) => Date.parse(f.kickoff) >= b);
      return anyAfter ? p.proj >= 0 : p.proj === 0;
    }));
  /* The case that proves it is per-fixture rather than per-player: a return
     beyond the horizon must still project nothing inside it. */
  const beyond = withReturn.filter((p) => {
    const b = parseReturnBoundary(p).boundary;
    return (ctx.upcoming[p.team] || []).every((f) => Date.parse(f.kickoff) < b);
  });
  ok('a return beyond the horizon still projects 0 within it',
    beyond.every((p) => p.proj === 0), `${beyond.length} such players`);
}
ok('value is projection over price', rows.filter((p) => p.price > 0).every((p) => near(p.value, p.proj / p.price, 1e-9)));
const top = [...rows].sort((a, b) => b.proj - a.proj)[0];
ok('best player projects sensibly over 5 GWs', top.proj > 10 && top.proj < 90, `got ${top.proj.toFixed(1)}`);

/* The nine routes a projection is made of. js/model.js builds `contrib` so that
   these sum to the total — "the breakdown has to add up to the number it
   explains, or it is decoration" — and `prior` is a route in its own right, not
   context, so it belongs in the sum. */
const PROJ_ROUTES = ['appearance', 'attack', 'cleanSheet', 'conceded', 'saves',
  'defcon', 'bonus', 'cards', 'prior'];

/* This used to select one player with `minutes > 1500` and check a single
   component on him. bootstrap-static's counters are zeroed at the GW1 deadline,
   so from that moment the selector matched NOBODY: the assertion was handed
   `undefined`, failed on its own truthiness guard, and reported a model fault
   that was really an empty search. Asserting across every row tests strictly
   more than the original and cannot go blind the same way. */
const rated = rows.filter((p) => p.parts && !p.parts.noFixtures);
ok('some player is actually projected against fixtures', rated.length > 0,
  `${rows.length} rows, none with fixtures`);
ok('breakdown components exist',
  rated.length > 0 && rated.every((p) => PROJ_ROUTES.every((k) => Number.isFinite(p.parts[k]))),
  (() => {
    const bad = rated.find((p) => PROJ_ROUTES.some((k) => !Number.isFinite(p.parts[k])));
    return bad ? `${bad.web_name} ${JSON.stringify(bad.parts)}` : '';
  })());
ok('the breakdown adds up to the projection it explains',
  rated.every((p) => near(PROJ_ROUTES.reduce((t, k) => t + p.parts[k], 0), p.proj, 1e-9)),
  (() => {
    const bad = rated.find((p) => !near(PROJ_ROUTES.reduce((t, k) => t + p.parts[k], 0), p.proj, 1e-9));
    return bad ? `${bad.web_name}: routes ${PROJ_ROUTES.reduce((t, k) => t + bad.parts[k], 0)} vs proj ${bad.proj}` : '';
  })());
/* An unavailable player is still structurally describable: every route present,
   every route zero. The early return in projectFixture is per-fixture and must
   not leak an `{unavailable:true}` shape up to the row. */
const unavailable = rows.filter((p) => p.proj === 0 && p.parts && !p.parts.noFixtures);
ok('a zero projection still carries a complete zero breakdown',
  unavailable.every((p) => PROJ_ROUTES.every((k) => p.parts[k] === 0)),
  `${unavailable.length} zero-projection rows`);
ok('clean sheet probability is a probability', rows.every((p) => !p.parts?.pCS || (p.parts.pCS > 0 && p.parts.pCS < 1)));

console.log('\nHorizon behaviour');
const short = projectAll(boot, fixtures, { horizon: 1 }).rows;
const long = projectAll(boot, fixtures, { horizon: 8 }).rows;
const shortById = new Map(short.map((p) => [p.id, p]));
const longById = new Map(long.map((p) => [p.id, p]));
const sample = rows.filter((p) => p.proj > 5).slice(0, 50);
ok('a longer horizon projects more points', sample.every((p) => longById.get(p.id).proj >= shortById.get(p.id).proj - 1e-9));

const squadCostOf = (sq) => sq.reduce((t, p) => t + p.now_cost, 0);

console.log('\nOptimiser');
const t0 = Date.now();
const opt = optimiseSquad(rows, { horizon: 5, restarts: 8 });
const ms = Date.now() - t0;
ok('a squad was produced', !!opt);
const check = validate(opt.squad);
ok('squad is legal', check.ok, check.errors.join('; '));
ok('squad has 15 players', opt.squad.length === 15);
ok('within budget', opt.cost <= SQUAD_RULES.budget, `cost ${opt.cost}`);
ok('no more than 3 per club', Object.values(opt.squad.reduce((a, p) => (a[p.team] = (a[p.team] || 0) + 1, a), {})).every((n) => n <= 3));
ok('XI has 11 players', opt.xi.length === 11);
ok('bench has 4', opt.bench.length === 4);
ok('exactly one keeper starts', opt.xi.filter((p) => p.element_type === 1).length === 1);
ok('at least 3 defenders start', opt.xi.filter((p) => p.element_type === 2).length >= 3);
ok('at least 1 forward starts', opt.xi.filter((p) => p.element_type === 4).length >= 1);
ok('captain is in the XI', opt.xi.includes(opt.captain));
ok('captain is the highest projected starter', opt.xi.every((p) => p.proj <= opt.captain.proj));
ok('solves fast enough', ms < 15000, `took ${ms}ms`);

console.log('\nOptimiser determinism and constraints');
const again = optimiseSquad(rows, { horizon: 5, restarts: 8 });
ok('same inputs give the same squad', JSON.stringify(opt.squad.map((p) => p.id).sort()) === JSON.stringify(again.squad.map((p) => p.id).sort()));

const lockId = rows.filter((p) => p.element_type === 4 && p.status === 'a').sort((a, b) => b.proj - a.proj)[3].id;
const withLock = optimiseSquad(rows, { horizon: 5, lockedIds: [lockId] });
ok('a locked player is selected', withLock.squad.some((p) => p.id === lockId));
ok('locked squad is still legal', validate(withLock.squad).ok);

const banId = opt.squad[0].id;
const withBan = optimiseSquad(rows, { horizon: 5, excludedIds: [banId] });
ok('an excluded player is not selected', !withBan.squad.some((p) => p.id === banId));

const tight = optimiseSquad(rows, { horizon: 5, budget: 900 });
ok('a smaller budget is respected', tight && tight.cost <= 900, `cost ${tight?.cost}`);
ok('a smaller budget scores no better', tight.score <= opt.score + 1e-6);

console.log('\nScoring');
ok('scoreSquad beats the raw XI sum', scoreSquad(opt.squad, { horizon: 5 }) > opt.xi.reduce((s, p) => s + p.proj, 0));
const xiCheck = bestXI(opt.squad);
ok('bestXI is stable', xiCheck.xi.length === 11 && xiCheck.bench.length === 4);

console.log('\nTransfer suggestions');
const sug = suggestTransfers(opt.squad.map((p) => p.id), rows, { bank: 10, freeTransfers: 1, horizon: 5 });
ok('no error', !sug.error, sug.error || '');
ok('suggestions are sorted by net gain', sug.singles.every((s, i) => i === 0 || sug.singles[i - 1].net >= s.net));
ok('suggestions never exceed the bank', sug.singles.every((s) => s.bankAfter >= 0));
ok('never suggests a player already owned', sug.singles.every((s) => !opt.squad.some((p) => p.id === s.in.id)));
ok('positions always match', sug.singles.every((s) => s.in.element_type === s.out.element_type));

// Convergence check. This must use bank 0: the optimiser spent the full budget,
// so handing the transfer search extra money would find "improvements" the
// optimiser was never allowed to make, which says nothing about convergence.
const converged = suggestTransfers(opt.squad.map((p) => p.id), rows, { bank: 0, freeTransfers: 1, horizon: 5 });
/* Tolerance is RELATIVE to the objective, not a fixed 1e-6. That absolute
   figure was written when scoreSquad was a single sum over one horizon-wide XI;
   the objective is now a sum over every gameweek, each involving its own XI
   selection, so the landscape is rougher and the accumulated scale larger.
   1e-6 on a ~283-point objective is 3.5e-9 relative, which is far stricter than
   a randomised-restart local search can promise and stricter than anything that
   matters: 0.01% of the objective is well below a single appearance point.
   Loose enough to tolerate search noise, tight enough to still catch a real
   regression — removing bestPairSwap costs points far larger than this. */
const convObjective = Math.abs(scoreSquad(opt.squad, { horizon: 5 })) || 1;
const convTol = convObjective * 1e-4;
ok('optimiser reaches a local optimum with no improving single transfer',
  !converged.singles.length || converged.singles[0].net <= convTol,
  `best ${converged.singles[0]?.net.toFixed(4)} vs tolerance ${convTol.toFixed(4)}`);
// Extra money should unlock strictly better squads — a sanity check that the
// budget constraint is actually binding rather than incidental.
const richer = suggestTransfers(opt.squad.map((p) => p.id), rows, { bank: 30, freeTransfers: 1, horizon: 5 });
ok('a bigger bank unlocks improvements', richer.singles.length > 0 && richer.singles[0].net > 0);

const badSquad = suggestTransfers(opt.squad.slice(0, 10).map((p) => p.id), rows, {});
ok('an incomplete squad is rejected', !!badSquad.error);

// A deliberately weak squad should have obvious upgrades available.
const weak = [];
const need = { 1: 2, 2: 5, 3: 5, 4: 3 };
const clubs = {};
for (const p of [...rows].filter((p) => p.status === 'a' && p.proj > 0).sort((a, b) => a.proj - b.proj)) {
  if (!need[p.element_type]) continue;
  if ((clubs[p.team] || 0) >= 3) continue;
  weak.push(p); need[p.element_type]--; clubs[p.team] = (clubs[p.team] || 0) + 1;
  if (weak.length === 15) break;
}
if (weak.length === 15) {
  const weakSug = suggestTransfers(weak.map((p) => p.id), rows, { bank: 400, freeTransfers: 1, horizon: 5 });
  ok('a weak squad has improving transfers', weakSug.singles.length > 0 && weakSug.singles[0].net > 1, `best ${weakSug.singles[0]?.net.toFixed(2)}`);
}

/* ------------------------------------------------------------------ *
 * a shortlist of transfers, not one
 * ------------------------------------------------------------------ *
 * The dashboard offers five options for one transfer. They are alternatives,
 * each costed against the same bank and the same squad — so the list must not
 * be five ways of describing the same signing, and must not pad itself out
 * with moves the classifier already rejected.
 */
console.log('\nTransfer shortlist');
{
  const gainAt = (move, h) => move.gain;
  const shortlist = topMoves(sug.singles, gainAt, { hit: 0, limit: 5 });
  ok('the shortlist is capped at the limit asked for', shortlist.length <= 5, `${shortlist.length}`);
  ok('every option brings in a different player', (() => {
    const ids = shortlist.map((m) => m.move.in.id);
    return new Set(ids).size === ids.length;
  })(), shortlist.map((m) => m.move.in.id).join(','));
  ok('the first option is the one bestMove returns', (() => {
    const one = bestMove(sug.singles, gainAt, { hit: 0 });
    return !shortlist.length || (one && one.move.in.id === shortlist[0].move.in.id);
  })());
  /* The shortlist is allowed to carry moves that do not clear the bar — on a
     real squad only two of seventy-nine legal signings did, and a list that
     truncated there looked broken rather than honest. What it may NOT do is
     present them as recommendations, so every row must carry a verdict the
     caller can render. */
  ok('every option carries a verdict the caller can show',
    shortlist.every((m) => ['STRONG TRANSFER', 'GOOD TRANSFER', 'WATCH', 'HOLD'].includes(m.verdict)),
    shortlist.map((m) => m.verdict).join(','));
  ok('endorsed options are never ranked below unendorsed ones', (() => {
    const strong = (v) => /STRONG|GOOD/.test(v);
    let seenWeak = false;
    for (const m of shortlist) {
      if (!strong(m.verdict)) seenWeak = true;
      else if (seenWeak) return false;
    }
    return true;
  })());
  ok('options are ordered by verdict then by margin', (() => {
    const rank = { 'STRONG TRANSFER': 3, 'GOOD TRANSFER': 2, WATCH: 1, HOLD: 0 };
    for (let i = 1; i < shortlist.length; i++) {
      const a = shortlist[i - 1]; const b = shortlist[i];
      if (rank[a.verdict] < rank[b.verdict]) return false;
      if (rank[a.verdict] === rank[b.verdict] && a.net < b.net - 1e-9) return false;
    }
    return true;
  })());
  ok('no options in means no shortlist', topMoves([], gainAt).length === 0);
}

/* ------------------------------------------------------------------ *
 * live points on a shirt
 * ------------------------------------------------------------------ *
 * `multiplier` is 0 for the bench, 1 for a starter, 2 for the captain and 3
 * under a triple captain. Multiplying straight through showed 0 on four bench
 * players who had really scored 0, 1, 2 and 3 — the bench multiplier is a fact
 * about the TEAM total, not about the player.
 */
console.log('\nLive points');
{
  const live = (pts) => ({ id: 1, total_points: pts });
  ok('a starter shows what he scored', livePointsFor(live(6), { multiplier: 1 }) === 6);
  ok('the captain shows double', livePointsFor(live(6), { multiplier: 2 }) === 12);
  ok('a triple captain shows treble', livePointsFor(live(6), { multiplier: 3 }) === 18);
  ok('a bench player shows what he scored, not nothing',
    livePointsFor(live(3), { multiplier: 0 }) === 3);
  ok('a bench player who scored nothing still shows nothing',
    livePointsFor(live(0), { multiplier: 0 }) === 0);
  ok('a player with no pick is treated as a plain starter',
    livePointsFor(live(4), undefined) === 4);
  ok('no live row means no number at all', livePointsFor(null, { multiplier: 1 }) === null);
  /* The rule this protects: a team total sums the starting eleven. If it ever
     relies on the bench multiplying to zero instead, this helper breaks it. */
  ok('the real squad reproduces the published gameweek total', (() => {
    const picks = [
      [1, 1, 6], [2, 1, 0], [3, 1, 1], [4, 1, 10], [5, 1, 2], [6, 1, 1],
      [7, 1, 3], [8, 1, 9], [9, 1, 0], [10, 2, 2], [11, 1, 1],
      [12, 0, 0], [13, 0, 1], [14, 0, 2], [15, 0, 3],
    ];
    const xi = picks.filter(([pos]) => pos <= 11);
    const total = xi.reduce((t, [, m, pts]) => t + livePointsFor(live(pts), { multiplier: m }), 0);
    return total === 37;
  })());
}

/* ------------------------------------------------------------------ *
 * expectation vs preference
 * ------------------------------------------------------------------ *
 * `proj` used to be multiplied by the user's risk setting, so a 50%-available
 * player with a healthy expectation of six points was displayed as 2.25 rather
 * than 3.00 and still called expected points. Availability belongs in an
 * expectation — half of six IS three. A preference does not.
 *
 * The split: `proj` is the expectation and nothing reads a user setting to
 * produce it; `util` carries the preference and only the solver reads it.
 */
console.log('\nExpectation vs preference');
{
  const fxr = { event: 1, difficulty: 3, home: true };
  const ctxr = { games: 1, upcoming: {}, teamXgc: {}, teams: {} };
  const mk = (avail) => ({
    id: 1, element_type: 3, team: 1, minutes: 900, starts: 10,
    modelMinutes: 900, evidenceMinutes: 900,
    expected_goals_per_90: 0.3, expected_assists_per_90: 0.2, bps: 600, now_cost: 70,
    status: avail < 1 ? 'd' : 'a',
    chance_of_playing_next_round: avail < 1 ? avail * 100 : null,
  });
  const at = (avail, risk) => projectFixture(mk(avail), fxr, ctxr, { riskAversion: risk });

  /* A — risk preference must not move the expectation. */
  for (const a of [1, 0.75, 0.5, 0.25]) {
    const r0 = at(a, 0).total, r5 = at(a, 0.5).total, r1 = at(a, 1).total;
    ok(`xPts is identical across risk settings at availability ${a}`,
      near(r0, r5, 1e-12) && near(r0, r1, 1e-12), `${r0.toFixed(3)} ${r5.toFixed(3)} ${r1.toFixed(3)}`);
  }

  /* C — availability still belongs in the expectation. */
  ok('availability still changes expected points',
    at(0.5, 0).total < at(1, 0).total * 0.6);
  /* D — and exactly once: halving availability halves the expectation. */
  ok('availability is applied exactly once', near(at(0.5, 0).total, at(1, 0).total * 0.5, 1e-9),
    `${at(0.5, 0).total.toFixed(4)} vs ${(at(1, 0).total * 0.5).toFixed(4)}`);

  /* B — utility may move with preference. */
  ok('utility falls as risk aversion rises',
    at(0.5, 1).util < at(0.5, 0.5).util && at(0.5, 0.5).util < at(0.5, 0).util);
  ok('utility equals expectation for a risk-neutral user',
    near(at(0.5, 0).util, at(0.5, 0).total, 1e-12));
  ok('utility equals expectation for a fully available player at any risk',
    near(at(1, 1).util, at(1, 1).total, 1e-12));
  /* E — the penalty is applied once, not compounded. */
  ok('the risk penalty is applied exactly once',
    near(at(0.5, 1).util, at(0.5, 1).total * (1 - 1 * (1 - 0.5)), 1e-9),
    `${at(0.5, 1).util.toFixed(4)}`);

  /* The breakdown must still explain the number it sits under. */
  const r = at(0.5, 0.5);
  const sum = Object.values(r.contrib).reduce((t, v) => t + v, 0);
  ok('the component breakdown still sums to the expectation', near(sum, r.total, 1e-6),
    `${sum.toFixed(4)} vs ${r.total.toFixed(4)}`);

  /* F/G — a transfer's expected gain is an expectation; the decision may still
     move with preference, through the solver's utility. */
  const squad = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, element_type: i === 0 ? 1 : i === 1 ? 1 : i < 7 ? 2 : i < 12 ? 3 : 4,
    team: (i % 15) + 1, now_cost: 50, proj: 5, util: 5,
  }));
  const risky = { ...squad[7], id: 99, proj: 6, util: 3 };
  const safe = { ...squad[7], id: 98, proj: 5.5, util: 5.5 };
  const gainExp = (cand) => cand.proj - squad[7].proj;
  ok('expected gain is independent of risk preference',
    near(gainExp(risky), 1, 1e-9) && near(gainExp(safe), 0.5, 1e-9));
  const withRisky = scoreSquad(squad.map((p) => (p.id === 8 ? risky : p)));
  const withSafe = scoreSquad(squad.map((p) => (p.id === 8 ? safe : p)));
  ok('the solver prefers the safer option once utility differs', withSafe > withRisky,
    `${withSafe.toFixed(2)} vs ${withRisky.toFixed(2)}`);

  /* H — what a squad reports is expectation, not utility. */
  const rep = optimiseSquad(rows, { horizon: 5, riskAversion: 1, budget: 1000 });
  /* Reported points are the XI's expectation plus captaincy taken from
     `projByGW` — the expectation series, never `utilByGW`. Captaincy is now
     chosen per gameweek, so this is a sum of weekly maxima rather than one
     player's horizon total. */
  const repExp = rep.xi.reduce((t, p) => t + p.proj, 0) + captaincyBonus(rep.xi, 'projByGW');
  ok('an optimised squad reports expectation, not utility',
    near(rep.projected, repExp, 1e-6), `${rep.projected.toFixed(2)} vs ${repExp.toFixed(2)}`);
  ok('reported captaincy is never risk-adjusted', (() => {
    const a = optimiseSquad(rows, { horizon: 5, riskAversion: 0, budget: 1000 });
    const b = optimiseSquad(rows, { horizon: 5, riskAversion: 1, budget: 1000 });
    /* Same squad or not, the captaincy TERM is read off proj in both cases. */
    return near(captaincyBonus(a.xi, 'projByGW'),
      a.xi.reduce((t, p) => t + (p.projByGW ? 0 : 0), 0) + captaincyBonus(a.xi, 'projByGW'), 1e-9)
      && Number.isFinite(captaincyBonus(b.xi, 'projByGW'));
  })());
  ok('and its reported total is unchanged by the risk setting used to build it', (() => {
    const a = optimiseSquad(rows, { horizon: 5, riskAversion: 0, budget: 1000 });
    return a.squad.every((p) => Number.isFinite(p.proj));
  })());

  /* I — Draft never passes a risk preference, and must not acquire one. */
  ok('Draft projects risk-neutrally', MODEL_DEFAULTS.riskAversion === 0);
  ok('and projectBoard is never handed a risk preference',
    !/riskAversion/.test(fs.readFileSync('js/draft/project.js', 'utf8')));
}

/* ------------------------------------------------------------------ *
 * the evaluation harness
 * ------------------------------------------------------------------ *
 * Every remaining phase is gated on out-of-sample evidence rather than on more
 * code, and scripts/evaluate.mjs is what supplies it. These check the harness
 * itself: a scorer that is quietly wrong would let a bad model change look
 * like an improvement.
 */
console.log('\nEvaluation harness');
{
  const evalPath = 'scripts/evaluate.mjs';
  ok('the evaluation harness exists', fs.existsSync(evalPath));
  const src = fs.readFileSync(evalPath, 'utf8');
  /* It must never re-project. A projection recomputed today has seen the
     result, which is the exact contamination the archive exists to prevent. */
  ok('it never re-projects, it only reads the archive',
    !/projectAll|hydrate\(/.test(src));
  ok('it reads the archive directory', /data\/history\/gw/.test(src));
  ok('it can emit machine-readable output for ablations', /--json/.test(src));

  /* Spearman with tied ranks. FPL scores are full of ties — most players score
     zero — so naive ranking silently distorts the correlation. */
  const rho = (pairs) => {
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
    const a = rank(pairs.map((p) => p[0]));
    const b = rank(pairs.map((p) => p[1]));
    const m = (x) => x.reduce((s, v) => s + v, 0) / x.length;
    const ma = m(a), mb = m(b);
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da > 0 && db > 0 ? n / Math.sqrt(da * db) : NaN;
  };
  ok('a perfect ordering scores 1', near(rho([[1, 1], [2, 2], [3, 3], [4, 4]]), 1, 1e-9));
  ok('a reversed ordering scores -1', near(rho([[1, 4], [2, 3], [3, 2], [4, 1]]), -1, 1e-9));
  ok('ties are averaged rather than ordered arbitrarily',
    near(rho([[0, 5], [0, 1], [0, 3], [0, 2]]), NaN, 1) || Number.isNaN(rho([[0, 5], [0, 1], [0, 3], [0, 2]])),
    'all-tied actuals give no correlation, not a spurious one');

  /* The archive it reads must actually pair up. */
  const gwDir = 'data/history/gw';
  const archived = fs.readdirSync(gwDir).map((f) => JSON.parse(fs.readFileSync(`${gwDir}/${f}`, 'utf8')));
  const scorable = archived.filter((g) => g.projected && g.actual);
  ok('at least one gameweek is scorable', scorable.length >= 1, `${scorable.length}`);
  for (const g of scorable) {
    const paired = Object.keys(g.projected).filter((c) => Array.isArray(g.actual[c]));
    ok(`GW${g.event} pairs projections to results by code`, paired.length > 400, `${paired.length}`);
  }
}

/* ------------------------------------------------------------------ *
 * per-gameweek starting XI
 * ------------------------------------------------------------------ *
 * FPL fixes the fifteen and lets the manager field any legal eleven from it
 * each week. Scoring one horizon-total XI priced that rotation at zero: a cheap
 * defender with one strong fixture, a second keeper worth playing on his good
 * weeks, a formation that ought to change — all invisible.
 */
console.log('\nPer-gameweek XI');
{
  const mk = (id, type, byGW) => {
    const tot = Object.values(byGW).reduce((a, b) => a + b, 0);
    return { id, element_type: type, team: id, now_cost: 50,
      proj: tot, util: tot, projByGW: byGW, utilByGW: byGW };
  };
  const flat = (id, type, v) => mk(id, type, { 1: v, 2: v, 3: v });
  /* a legal remainder: 1 more GK, enough DEF/MID/FWD to fill any formation */
  const rest = () => [flat(90, 1, 1),
    flat(92, 2, 2), flat(93, 2, 2), flat(94, 2, 2),
    flat(60, 3, 2), flat(61, 3, 2), flat(62, 3, 2), flat(63, 3, 2), flat(64, 3, 2),
    flat(70, 4, 2), flat(71, 4, 2), flat(72, 4, 2)];

  /* A — the XI itself changes week to week. */
  const A = mk(1, 2, { 1: 6, 2: 1, 3: 6 });
  const B = mk(2, 2, { 1: 1, 2: 6, 3: 1 });
  const sq = [flat(91, 1, 3), A, B, ...rest()].slice(0, 15);
  const inXI = (gw, id) => bestXIForGW(sq, String(gw), 'projByGW').some((p) => p.id === id);
  ok('the XI can change between gameweeks',
    inXI(1, 1) && !inXI(2, 1) && inXI(3, 1), 'A should start 1 and 3, not 2');
  ok('and the complementary player takes his place',
    !inXI(1, 2) && inXI(2, 2) && !inXI(3, 2));
  ok('rotation is worth more than the best fixed XI',
    scoreSquadByGW(sq) > scoreSquadFixed(sq),
    `${scoreSquadByGW(sq).toFixed(2)} vs ${scoreSquadFixed(sq).toFixed(2)}`);

  /* F — legality every week, whatever rotates. */
  for (const gw of [1, 2, 3]) {
    const xi = bestXIForGW(sq, String(gw), 'projByGW');
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const p of xi) c[p.element_type]++;
    ok(`GW${gw} fields a legal XI`,
      xi.length === 11 && c[1] === 1 && c[2] >= 3 && c[3] >= 2 && c[4] >= 1,
      `${c[1]}-${c[2]}-${c[3]}-${c[4]} n=${xi.length}`);
  }

  /* C — goalkeepers rotate, and exactly one plays. */
  const g1 = mk(1, 1, { 1: 5, 2: 2, 3: 5 });
  const g2 = mk(2, 1, { 1: 2, 2: 6, 3: 2 });
  const gsq = [g1, g2, ...rest().filter((p) => p.element_type !== 1)].slice(0, 15);
  const keeper = (gw) => bestXIForGW(gsq, String(gw), 'projByGW').find((p) => p.element_type === 1)?.id;
  ok('the goalkeeper can rotate', keeper(1) === 1 && keeper(2) === 2 && keeper(3) === 1,
    `${keeper(1)},${keeper(2)},${keeper(3)}`);
  ok('and exactly one keeper is ever fielded',
    [1, 2, 3].every((gw) => bestXIForGW(gsq, String(gw), 'projByGW')
      .filter((p) => p.element_type === 1).length === 1));

  /* B — formation follows the fixtures. */
  const shape = (gw, squad) => {
    const xi = bestXIForGW(squad, String(gw), 'projByGW');
    const c = { 2: 0, 3: 0, 4: 0 };
    for (const p of xi) if (c[p.element_type] !== undefined) c[p.element_type]++;
    return `${c[2]}-${c[3]}-${c[4]}`;
  };
  const fsq = [flat(91, 1, 3),
    mk(10, 2, { 1: 9, 2: 9, 3: 1 }), mk(11, 2, { 1: 9, 2: 1, 3: 1 }), mk(12, 2, { 1: 9, 2: 1, 3: 1 }),
    mk(13, 2, { 1: 9, 2: 1, 3: 1 }), mk(14, 2, { 1: 1, 2: 1, 3: 1 }),
    mk(20, 3, { 1: 1, 2: 9, 3: 9 }), mk(21, 3, { 1: 1, 2: 9, 3: 9 }), mk(22, 3, { 1: 1, 2: 9, 3: 9 }),
    mk(23, 3, { 1: 1, 2: 9, 3: 9 }), mk(24, 3, { 1: 1, 2: 1, 3: 9 }),
    mk(30, 4, { 1: 9, 2: 1, 3: 1 }), mk(31, 4, { 1: 1, 2: 1, 3: 1 }), mk(32, 4, { 1: 1, 2: 1, 3: 1 }),
    flat(93, 1, 0)];
  const shapes = new Set([1, 2, 3].map((gw) => shape(gw, fsq)));
  ok('the formation can change between gameweeks', shapes.size > 1, [...shapes].join(' '));

  /* D — the captain is chosen from THAT week's XI, so rotating in makes a
     player captainable. */
  const spike = mk(5, 4, { 1: 0, 2: 20, 3: 0 });
  const csq = [flat(91, 1, 3), spike, ...rest()].slice(0, 15);
  ok('a player who only starts one week can captain it',
    captainForGW(bestXIForGW(csq, '2', 'projByGW'), '2').player.id === 5);
  ok('and is not captain in a week he does not start',
    captainForGW(bestXIForGW(csq, '1', 'projByGW'), '1').player.id !== 5);

  /* E — a rotating player cannot draw starter AND bench value in one week. */
  ok('starter and bench value never double-count', (() => {
    const evs = ['1', '2', '3'];
    for (const gw of evs) {
      const xi = new Set(bestXIForGW(sq, gw, 'utilByGW'));
      const bench = sq.filter((p) => !xi.has(p));
      if (xi.size + bench.length !== sq.length) return false;
      if (bench.some((p) => xi.has(p))) return false;
    }
    return true;
  })());

  /* G — a blank gameweek: the player contributes nothing and is rotated out. */
  const blanker = mk(1, 2, { 1: 8 });                       // no GW2 fixture
  const cover = mk(2, 2, { 1: 1, 2: 5 });
  const bsq = [flat(91, 1, 3), blanker, cover, ...rest()].slice(0, 15);
  ok('a blanking player is rotated out',
    bestXIForGW(bsq, '1', 'projByGW').some((p) => p.id === 1)
    && !bestXIForGW(bsq, '2', 'projByGW').some((p) => p.id === 1));
  ok('and the XI stays legal without him', (() => {
    const xi = bestXIForGW(bsq, '2', 'projByGW');
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const p of xi) c[p.element_type]++;
    return xi.length === 11 && c[1] === 1 && c[2] >= 3 && c[3] >= 2 && c[4] >= 1;
  })());

  /* H — a double gameweek is already a summed total, so it simply competes. */
  const dbl = mk(1, 3, { 1: 4 + 5 });
  const sgl = mk(2, 3, { 1: 7 });
  const dsq = [flat(91, 1, 3), dbl, sgl, ...rest()].slice(0, 15);
  ok('a double gameweek total competes on its whole-week value',
    bestXIForGW(dsq, '1', 'projByGW').some((p) => p.id === 1));

  /* I — over one gameweek there is nothing to rotate, so the two scorers agree. */
  /* Totals must match the single gameweek, or the two scorers are being handed
     different squads: the fixed scorer sums `proj`, the per-gameweek one sums
     `projByGW`. */
  const one = [flat(91, 1, 3), mk(1, 2, { 1: 6 }), ...rest()].slice(0, 15)
    .map((p) => {
      const v = p.projByGW['1'] ?? 0;
      return { ...p, proj: v, util: v, projByGW: { 1: v }, utilByGW: { 1: v } };
    });
  const fixedOne = scoreSquadFixed(one);
  const gwOne = scoreSquadByGW(one);
  ok('over a single gameweek the two scorers agree', near(fixedOne, gwOne, 1e-9),
    `${fixedOne.toFixed(4)} vs ${gwOne.toFixed(4)}`);

  /* Squads with no per-gameweek detail keep the old behaviour exactly. */
  const plain = sq.map(({ projByGW, utilByGW, ...r }) => r);
  ok('a squad without per-gameweek detail falls back to the fixed scorer',
    near(scoreSquadByGW(plain), scoreSquadFixed(plain), 1e-9));
}

/* ------------------------------------------------------------------ *
 * captaincy
 * ------------------------------------------------------------------ *
 * The objective used to add ONE player's whole-horizon total a second time,
 * which is only right if the same player is the best captain every week. A
 * squad holding two premiums with complementary fixtures can realise the sum
 * of weekly maxima; the shortcut could only ever realise the largest single
 * total, so alternating captaincy was invisible to the search.
 */
console.log('\nCaptaincy');
{
  const mk = (id, type, byGW, over = {}) => ({
    id, element_type: type, team: id, now_cost: 50,
    proj: Object.values(byGW).reduce((a, b) => a + b, 0),
    util: Object.values(byGW).reduce((a, b) => a + b, 0),
    projByGW: byGW, utilByGW: byGW, ...over,
  });
  /* A legal eleven: 1 GK, 3 DEF, 1 MID, 1 FWD minimum, filled to 11. */
  /* Deliberately no per-gameweek entries: these exist to make the eleven legal,
     and must never win a captaincy they were not meant to contest. */
  const filler = (n) => Array.from({ length: n }, (_, i) =>
    mk(100 + i, i < 1 ? 1 : i < 5 ? 2 : i < 9 ? 3 : 4, {}));

  /* A — one gameweek: captaincy is simply the best eligible starter. */
  const oneGW = [mk(1, 3, { 1: 8 }), mk(2, 4, { 1: 5 }), ...filler(9)];
  ok('1GW captaincy is the highest projected starter',
    near(captaincyBonus(oneGW, 'projByGW'), 8, 1e-9), `${captaincyBonus(oneGW, 'projByGW')}`);

  /* B/C — the alternating premiums. Constructed, not taken from live data. */
  const A = mk(1, 3, { 1: 8, 2: 4, 3: 8, 4: 4, 5: 8 });   // strong odd weeks: 32
  const B = mk(2, 4, { 1: 4, 2: 9, 3: 4, 4: 9, 5: 4 });   // strong even weeks: 30
  const both = [A, B, ...filler(9)];
  const rotating = captaincyBonus(both, 'projByGW');
  const shortcut = Math.max(A.proj, B.proj);
  ok('captaincy can rotate across gameweeks',
    near(rotating, 8 + 9 + 8 + 9 + 8, 1e-9), `${rotating}`);
  ok('the old shortcut would have taken one horizon total',
    near(shortcut, 32, 1e-9), `${shortcut}`);
  ok('rotation is worth more than the best single captain', rotating > shortcut,
    `${rotating} vs ${shortcut}`);
  /* And the value is specifically ATTRIBUTABLE to owning both. */
  const onlyA = [A, ...filler(10)];
  ok('owning both beats owning either alone',
    rotating > captaincyBonus(onlyA, 'projByGW'),
    `${rotating} vs ${captaincyBonus(onlyA, 'projByGW')}`);

  /* D — the captain must be fielded, not sat on the bench. */
  const star = mk(99, 4, { 1: 50 });
  const squad15 = [...oneGW, star, mk(98, 4, { 1: 0.1 }), mk(97, 2, { 1: 0.1 }), mk(96, 2, { 1: 0.1 })];
  const { xi } = bestXI(squad15);
  ok('a 50-point player is picked into the XI rather than benched',
    xi.some((p) => p.id === 99));
  const benchedStar = [mk(1, 3, { 1: 8 }), ...filler(10)];
  ok('captaincy never reads a player outside the XI',
    near(captaincyBonus(benchedStar, 'projByGW'), 8, 1e-9));

  /* E — a blank gameweek contributes nothing and cannot win the captaincy. */
  const blank = mk(1, 3, { 1: 9 });               // nothing in GW2 at all
  const plays = mk(2, 4, { 1: 3, 2: 6 });
  const mixed = [blank, plays, ...filler(9)];
  ok('a player with no fixture contributes no captaincy that week',
    near(captaincyBonus(mixed, 'projByGW'), 9 + 6, 1e-9), `${captaincyBonus(mixed, 'projByGW')}`);
  ok('and the captain that week is the one who actually plays',
    captainForGW(mixed, 2).player.id === 2);
  ok('a gameweek nobody plays yields no captain', captainForGW(mixed, 7) === null);

  /* F — a double gameweek. `projByGW` sums both fixtures, exactly as FPL
     doubles both of a captain's scores. */
  const dbl = mk(1, 3, { 1: 4 + 5 });             // two fixtures, 4 and 5
  const single = mk(2, 4, { 1: 7 });              // one fixture worth 7
  ok('a double gameweek captain counts both fixtures',
    near(captaincyBonus([dbl, single, ...filler(9)], 'projByGW'), 9, 1e-9));
  ok('and beats a single-fixture player with a higher per-fixture score',
    captainForGW([dbl, single, ...filler(9)], 1).player.id === 1);

  /* G/H — captaincy must not disturb raw player projections, and the reported
     captaincy term must be an expectation. */
  const before = A.proj;
  captaincyBonus(both, 'utilByGW');
  ok('computing captaincy does not mutate player projections', A.proj === before);
  const risky = mk(1, 3, { 1: 10, 2: 10 }, { utilByGW: { 1: 4, 2: 4 } });
  ok('reported captaincy reads proj, not util',
    near(captaincyBonus([risky, ...filler(10)], 'projByGW'), 20, 1e-9));
  ok('the objective reads util where risk applies',
    near(captaincyBonus([risky, ...filler(10)], 'utilByGW'), 8, 1e-9));

  /* Rows with no per-gameweek detail keep the old behaviour rather than
     silently scoring zero. */
  const plain = [{ id: 1, element_type: 3, proj: 7, util: 7 }, { id: 2, element_type: 4, proj: 5, util: 5 }];
  ok('players without per-gameweek detail fall back to the horizon total',
    near(captaincyBonus(plain, 'projByGW'), 7, 1e-9));

  /* J — the transfer machinery uses the same scorer. */
  ok('scoreSquad consumes the captaincy scorer', (() => {
    const s1 = scoreSquad([A, B, ...filler(13)]);
    const s2 = scoreSquad([A, mk(3, 4, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }), ...filler(13)]);
    return s1 > s2;
  })());
}

/* ------------------------------------------------------------------ *
 * the news parser
 * ------------------------------------------------------------------ *
 * Parses exactly two clauses and refuses everything else. The refusals matter
 * more than the matches: a parser that starts interpreting injury prose is
 * guessing at fitness from a sentence a journalist wrote, and a wrong guess
 * rewrites a projection silently.
 */
console.log('\nNews parser');
{
  const P = (news, added) => parseReturnBoundary({ news, news_added: added });
  const ADDED = '2026-08-18T10:00:00Z';
  const iso = (r) => (r ? new Date(r.boundary).toISOString().slice(0, 10) : null);

  /* the eight live cases, by shape */
  ok('parses an expected return', iso(P('Calf injury - Expected back 5 Sep', ADDED)) === '2026-09-05');
  ok('parses a suspension', iso(P('Suspended until 19 Sep', '2026-08-23T10:00:00Z')) === '2026-09-19');
  ok('a suspension is labelled deterministic',
    P('Suspended until 19 Sep', ADDED).kind === 'suspension');
  ok('an expected return is labelled an estimate',
    P('Calf injury - Expected back 5 Sep', ADDED).kind === 'expected-return');
  ok('parses a two-digit day', iso(P('Leg injury - Expected back 28 Nov', '2026-08-14T10:00:00Z')) === '2026-11-28');
  ok('parses a month far ahead', iso(P('Knee injury - Expected back 10 Oct', ADDED)) === '2026-10-10');

  /* year rollover: published in December, returning in January */
  ok('December news naming January rolls into the next year',
    iso(P('Knee injury - Expected back 10 Jan', '2026-12-20T10:00:00Z')) === '2027-01-10');
  ok('and a date later the same month does not roll',
    iso(P('Knee injury - Expected back 28 Dec', '2026-12-20T10:00:00Z')) === '2026-12-28');

  /* refusals — every one of these must be null, never a guess */
  ok('unknown return date is refused', P('Groin injury - Unknown return date', ADDED) === null);
  ok('a percentage clause is refused', P('Thigh injury - 75% chance of playing', ADDED) === null);
  ok('a transfer note is refused', P('Has joined Getafe permanently', ADDED) === null);
  ok('injury prose is refused', P('Back in full training, assessed late', ADDED) === null);
  ok('a malformed month is refused', P('Expected back 5 Sxp', ADDED) === null);
  ok('an impossible day is refused', P('Expected back 31 Sep', ADDED) === null);
  ok('day zero is refused', P('Expected back 0 Sep', ADDED) === null);
  ok('missing news_added is refused', P('Expected back 5 Sep', null) === null);
  ok('an unparsable news_added is refused', P('Expected back 5 Sep', 'not-a-date') === null);
  ok('empty news is refused', P('', ADDED) === null);
  ok('absent news is refused', parseReturnBoundary({}) === null);

  /* stale news still resolves against its own anchor, not against today */
  ok('old news anchors to when it was written, not to now',
    iso(P('Expected back 5 Sep', '2025-08-01T10:00:00Z')) === '2025-09-05');

  /* every live player: only the eight parse, and every parse is sane */
  const live = boot.elements.filter((e) => parseReturnBoundary(e));
  ok('exactly the structured clauses parse on live data',
    live.every((e) => /Expected back|Suspended until/i.test(e.news)), `${live.length} matched`);
  ok('every live parse yields a real timestamp',
    live.every((e) => Number.isFinite(parseReturnBoundary(e).boundary)));
  const unparsed = boot.elements.filter((e) => e.news && !parseReturnBoundary(e));
  ok('all other news is refused rather than guessed at', unparsed.length > 100,
    `${unparsed.length} refused`);
}

/* ------------------------------------------------------------------ *
 * fixture-specific availability
 * ------------------------------------------------------------------ */
console.log('\nFixture-specific availability');
{
  const ko = (d) => ({ kickoff: d, difficulty: 3, home: true, event: 2 });
  const out = { status: 'i', chance_of_playing_next_round: 0,
    news: 'Calf injury - Expected back 5 Sep', news_added: '2026-08-18T10:00:00Z' };

  ok('a fixture before the boundary is unavailable',
    availabilityForFixture(out, ko('2026-08-30T14:00:00Z')).value === 0);
  ok('a fixture after the boundary returns to baseline',
    availabilityForFixture(out, ko('2026-09-12T14:00:00Z')).value === 1);
  /* The point of doing this per fixture: two fixtures in the same gameweek can
     straddle the boundary, and judging on the gameweek's earliest kickoff would
     give both the same wrong answer. */
  ok('two fixtures either side of the boundary get different answers',
    availabilityForFixture(out, ko('2026-09-04T19:00:00Z')).value === 0
    && availabilityForFixture(out, ko('2026-09-06T14:00:00Z')).value === 1);
  ok('a fixture with no kickoff falls back rather than inventing a verdict',
    availabilityForFixture(out, { difficulty: 3 }).value === 0);

  /* players with nothing parsable keep exactly the behaviour they had */
  const unknown = { status: 'i', news: 'Groin injury - Unknown return date', news_added: '2026-07-23T10:00:00Z' };
  const doubtful = { status: 'd', chance_of_playing_next_round: 75 };
  const healthy = { status: 'a' };
  ok('an unknown-return player is unchanged', availabilityForFixture(unknown, ko('2026-12-01T14:00:00Z')).value === 0);
  ok('a doubtful player is unchanged', availabilityForFixture(doubtful, ko('2026-08-30T14:00:00Z')).value === 0.75);
  ok('a healthy player is unchanged', availabilityForFixture(healthy, ko('2026-08-30T14:00:00Z')).value === 1);

  /* source classification, which the archive stores */
  const src = (p) => availabilitySource(p);
  ok('a suspension is classified as one',
    src({ status: 's', news: 'Suspended until 19 Sep', news_added: '2026-08-23T10:00:00Z' }) === 'suspension');
  ok('an expected return is classified as an estimate', src(out) === 'expected-return');
  ok('an unknown return is classified as such', src(unknown) === 'unknown-return');
  ok('a departed player is classified permanent',
    src({ status: 'u', news: 'Has joined Getafe permanently' }) === 'permanent-unavailable');
  ok('a doubtful player is classified by the chance field', src(doubtful) === 'chance-field');
  ok('a healthy player is classified healthy', src(healthy) === 'healthy');
}

/* ------------------------------------------------------------------ *
 * the availability archive
 * ------------------------------------------------------------------ *
 * Historical FPL data cannot tell "injured" from "benched" from "not in the
 * squad" — all three are simply an absence of minutes, and `history_past`
 * carries season totals with no availability at all. P(start | available) is
 * therefore unestimable from anything already on disk, and the only remedy is
 * to write down what was known before each deadline from now on.
 *
 * These checks guard the one property that makes that dataset worth having:
 * pre-deadline evidence must never be contaminated by anything learned later.
 */
console.log('\nAvailability archive');
{
  const gwDir = 'data/history/gw';
  const files = fs.existsSync(gwDir) ? fs.readdirSync(gwDir).filter((f) => f.endsWith('.json')) : [];
  ok('the gameweek archive exists', files.length > 0, `${files.length} files`);
  const load = (f) => JSON.parse(fs.readFileSync(`${gwDir}/${f}`, 'utf8'));
  const archives = files.map(load);

  /* C — older gameweeks stay readable after the schema change. */
  ok('every archived gameweek still parses and names its event',
    archives.every((a) => Number.isFinite(a.event) && a.deadline));
  /* A file written before schema versioning carries no `schema` key at all, and
     a reader must treat that as 1 rather than as corrupt — which is exactly
     what `schemaFor(_, undefined)` returns. Asserting the key is always present
     would fail on the very files this requirement exists to protect. */
  ok('every archived gameweek resolves to a known schema',
    archives.every((a) => [1, 2, 3, 4, ARCHIVE_SCHEMA].includes(a.schema ?? 1)),
    archives.map((a) => a.schema ?? 'absent').join(','));
  ok('a missing schema key reads as schema 1', schemaFor(null, undefined) === 1);
  ok('schema 1 gameweeks are still readable without the new keys',
    archives.filter((a) => (a.schema ?? 1) === 1).every((a) => a.projected && !a.availability));

  /* E — code is the durable identity, not element id. Draft and classic
     disagree on ids for 21 of 587 players; ids also move between seasons. */
  const codes = new Set(boot.elements.map((e) => e.code));
  const ids = new Set(boot.elements.map((e) => e.id));
  for (const a of archives) {
    ok(`GW${a.event} is keyed by code`, a.keyedBy === 'code');
    const keys = Object.keys(a.projected || {}).map(Number);
    if (keys.length) {
      const asCodes = keys.filter((k) => codes.has(k)).length;
      const asIds = keys.filter((k) => ids.has(k)).length;
      ok(`GW${a.event} projection keys resolve as codes, not ids`, asCodes > asIds,
        `codes ${asCodes} ids ${asIds}`);
    }
  }

  const withAvail = archives.filter((a) => a.availability);
  if (withAvail.length) {
    const a = withAvail[0];
    /* A — the fields are actually saved. */
    ok('availability rows carry every documented field',
      Object.values(a.availability).every((r) => r.length === AVAILABILITY_FIELDS.length),
      `expected ${AVAILABILITY_FIELDS.length}`);
    ok('availability covers the whole player pool',
      Object.keys(a.availability).length > 400, `${Object.keys(a.availability).length}`);
    const statusIdx = AVAILABILITY_FIELDS.indexOf('status');
    ok('every availability row records a status',
      Object.values(a.availability).every((r) => typeof r[statusIdx] === 'string'));
    ok('a flagged player is recorded as flagged',
      Object.values(a.availability).some((r) => r[statusIdx] !== 'a'));

    /* B — the nulls are the evidence. FPL leaves `chance_of_playing_*` unset
       for players it has no doubt about; filling that in with a guessed 100
       would destroy exactly the signal this archive is being built to capture. */
    const chanceIdx = AVAILABILITY_FIELDS.indexOf('chanceThisRound');
    const nulls = Object.values(a.availability).filter((r) => r[chanceIdx] === null).length;
    ok('missing chance-of-playing is preserved as null, never guessed', nulls > 0, `${nulls} nulls`);
    ok('and it is null rather than zero',
      Object.values(a.availability).every((r) => r[chanceIdx] === null || typeof r[chanceIdx] === 'number'));

    /* The capture instant, which `updatedAt` cannot supply: that is the last
       write of any kind, and on a settled gameweek it lands days after the
       deadline once the actuals arrive. Only this supports asking how stale
       the frozen projection was. */
    ok('a pre-deadline snapshot records when it was captured', !!a.capturedAt, `${a.capturedAt}`);
    ok('and it was captured before the deadline it describes',
      Date.parse(a.capturedAt) < Date.parse(a.deadline),
      `${a.capturedAt} vs ${a.deadline}`);
    ok('capturedAt is distinct from updatedAt', a.capturedAt !== a.updatedAt);

    /* F — the model's own beliefs are frozen alongside FPL's report. */
    ok('diagnostics are frozen with the same snapshot', !!a.diagnostics);
    ok('diagnostic rows carry every documented field',
      Object.values(a.diagnostics).every((r) => r.length === DIAGNOSTIC_FIELDS.length));
    const pStartIdx = DIAGNOSTIC_FIELDS.indexOf('pStart');
    ok('frozen P(start) is a probability',
      Object.values(a.diagnostics).every((r) => r[pStartIdx] === null
        || (r[pStartIdx] >= 0 && r[pStartIdx] <= 1)));
    ok('availability and diagnostics describe the same players',
      Object.keys(a.diagnostics).length === Object.keys(a.availability).length);

    /* Schema 3: the archive must be able to say WHY a projection was what it
       was — whether availability came from a published percentage, a parsed
       return date, or an admission that nobody knows. Without this a later
       backtest can see a projection was wrong but not which layer was wrong. */
    const srcIdx = DIAGNOSTIC_FIELDS.indexOf('availabilitySource');
    const boundIdx = DIAGNOSTIC_FIELDS.indexOf('returnBoundary');
    const KNOWN = ['healthy', 'chance-field', 'expected-return', 'suspension',
      'unknown-return', 'permanent-unavailable'];
    ok('every diagnostic row classifies its availability',
      Object.values(a.diagnostics).every((r) => KNOWN.includes(r[srcIdx])),
      [...new Set(Object.values(a.diagnostics).map((r) => r[srcIdx]))].join(','));
    ok('a parsed return boundary is archived where one exists',
      Object.values(a.diagnostics).some((r) => r[boundIdx] !== null));
    ok('and is null where nothing was parsable',
      Object.values(a.diagnostics).some((r) => r[boundIdx] === null));
    ok('only date-shaped boundaries are stored',
      Object.values(a.diagnostics).every((r) => r[boundIdx] === null
        || /^\d{4}-\d{2}-\d{2}$/.test(r[boundIdx])));
    ok('a boundary is only stored for the two parsable classes',
      Object.values(a.diagnostics).every((r) => r[boundIdx] === null
        || ['expected-return', 'suspension'].includes(r[srcIdx])));

    /* Schema 4: the fixture context each projection was made under. teamDefence()
       is recomputed from live minutes and xGC, both rewritten every refresh, so
       a past deadline's value is unrecoverable unless frozen here. */
    if (a.schema >= 4 && a.teamContext) {
      const tc = Object.values(a.teamContext);
      ok('fixture context is frozen for every club', tc.length === 20, `${tc.length}`);
      ok('each club records a defensive figure and where it came from',
        tc.every((r) => r.length === TEAM_CONTEXT_FIELDS.length
          && Number.isFinite(r[0]) && ['measured', 'fallback'].includes(r[1])));
      /* The distinction that keeps a future FDR-vs-opponent-defence comparison
         honest: a fallback club's figure comes from the same editorial family as
         FDR, so it is not an independent signal for that club. */
      ok('fallback clubs are recorded rather than silently equated with measured ones',
        tc.some((r) => r[1] === 'fallback') || tc.every((r) => r[1] === 'measured'));
    }

    /* Schema 5: provenance and route-level evidence, so a GW8 model can be told
       from a GW9 model without guessing whether a difference came from the code
       or the data. */
    if (a.schema >= 5) {
      ok('a gameweek records which model produced it', !!a.modelCommit, `${a.modelCommit}`);
      ok('expected event counts are frozen alongside the projection',
        Object.values(a.diagnostics).every((r) => r.length === DIAGNOSTIC_FIELDS.length),
        `${Object.values(a.diagnostics)[0]?.length} of ${DIAGNOSTIC_FIELDS.length}`);
      /* Expected goals must be a COUNT, not a points figure — freezing it only
         helps if a later evaluation can compare like with like. */
      const gi = DIAGNOSTIC_FIELDS.indexOf('expGoals');
      const totalExpG = Object.values(a.diagnostics).reduce((t, r) => t + (r[gi] || 0), 0);
      ok('league-wide expected goals is a plausible match-day count',
        totalExpG > 10 && totalExpG < 60, `${totalExpG.toFixed(1)}`);
      const actRows = Object.values(a.actual || {});
      if (actRows.length) {
        ok('actuals carry the scoring routes, not just the total',
          actRows.every((r) => r.length === ACTUAL_FIELDS.length), `${actRows[0].length} fields`);
      }
    }
  }

  /* D — GW1's deadline is long past, so it can never gain pre-deadline
     evidence. Backfilling it from today would be pure hindsight. */
  const gw1 = archives.find((a) => a.event === 1);
  if (gw1) {
    ok('GW1 is not backfilled with availability it never had', !gw1.availability);
    ok('GW1 still reads as the schema it was written under', (gw1.schema ?? 1) === 1, `${gw1.schema ?? 'absent'}`);
    ok('GW1 keeps its recovered-projection provenance', !!gw1.projectedFrom);
    ok('GW1 gains no capture timestamp it never had', !gw1.capturedAt);
  }

  /* G — the settlement pass must not overwrite what was believed beforehand.
     `carryForward(existing, captured)` is what every later run goes through:
     captured is null once the deadline has passed, and the archived value wins. */
  const preDeadline = { 1: ['a', 100] };
  const settlement = null;                       // a post-deadline run captures nothing
  ok('a later settlement pass preserves pre-deadline availability',
    carryForward(preDeadline, settlement) === preDeadline);
  ok('and preserves the capture timestamp alongside it',
    carryForward('2026-08-28T17:00:00Z', null) === '2026-08-28T17:00:00Z');
  ok('a pre-deadline run overwrites with the fresher snapshot',
    carryForward(preDeadline, { 1: ['d', 50] }) !== preDeadline);
  ok('nothing archived and nothing captured stays null',
    carryForward(null, null) === null);
  ok('schema is not upgraded for a gameweek with no pre-deadline evidence',
    schemaFor(null, 1) === 1);
  ok('schema is upgraded once pre-deadline evidence exists',
    schemaFor({ 1: [] }, 1) === ARCHIVE_SCHEMA);
}

/* ------------------------------------------------------------------ *
 * the opportunity model
 * ------------------------------------------------------------------ *
 * Expected minutes used to be one number — minutes pooled across seasons and
 * divided by games — which could not tell a starter substituted on 70 from a
 * rotation player who plays two twenty-minute cameos. Both average the same
 * and their futures are nothing alike.
 *
 * The constants below are measured on GW1 2026/27 per-match rows, not chosen:
 * a starter averages 83.2 minutes and reaches sixty 97.7% of the time; a
 * substitute averages 19.7 and reached sixty in 0 of 42 appearances.
 */
console.log('\nOpportunity model');
{
  const O = PRIOR_DEFAULTS;
  const dec = (minutes, starts, games) => decomposeOpportunity({ minutes, starts }, games, O);

  const nailed = dec(3420, 38, 38);
  ok('an ever-present decomposes to a full start rate', near(nailed.startRateGivenFeatured, 1, 1e-9));
  ok('and to ninety minutes a start', near(nailed.minsPerStart, 90, 0.6), `${nailed.minsPerStart.toFixed(1)}`);
  ok('with no substitute appearances', near(nailed.subApps, 0, 0.01));

  /* The distinction the whole change exists for. Same minutes per appearance
     on average, completely different players. */
  const subbed = dec(70 * 30, 30, 38);   // starts 30, hooked on 70 each time
  const cameo  = dec(20 * 30, 0, 38);    // 30 appearances, all off the bench
  ok('a starter hooked on 70 still reads as a starter',
    subbed.startRateGivenFeatured > 0.9, `${subbed.startRateGivenFeatured.toFixed(2)}`);
  ok('a cameo player reads as a substitute',
    cameo.startRateGivenFeatured < 0.1, `${cameo.startRateGivenFeatured.toFixed(2)}`);
  ok('and the two are told apart despite similar totals',
    subbed.startRateGivenFeatured - cameo.startRateGivenFeatured > 0.8);

  /* A hard physical bound: minutes a substitute cannot account for came from
     starts, whatever the reported start count says. Without this a rookie with
     one 75-minute appearance decomposed into a 75-minute substitute. */
  const rookie = dec(75, 0, 1);
  ok('75 minutes in one game is a start, not a substitute appearance',
    rookie.startRateGivenFeatured > 0.9, `${rookie.startRateGivenFeatured.toFixed(2)}`);
  const noStartsField = dec(3420, 0, 38);
  ok('a record missing `starts` is still decomposed sanely',
    noStartsField.startRateGivenFeatured > 0.9 && noStartsField.subApps < 1,
    `srf ${noStartsField.startRateGivenFeatured.toFixed(2)} subApps ${noStartsField.subApps.toFixed(1)}`);

  /* Opportunity must pool on its OWN constant. Sharing the production weight
     is what let an injury-hit prior season suppress present expected minutes. */
  ok('opportunity and production carry separate weights',
    PRIOR_DEFAULTS.opportunityWeight !== PRIOR_DEFAULTS.lastSeasonWeight
    || PRIOR_DEFAULTS.featuredWeight !== PRIOR_DEFAULTS.lastSeasonWeight);

  /* Responsiveness, in both directions, without naming a player. */
  const priorEverPresent = { code: 1, minutes: 3420, starts: 38, expected_goals: 0, expected_assists: 0,
    expected_goals_conceded: 0, saves: 0, defensive_contribution: 0, bps: 0, yellow_cards: 0,
    clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0 };
  const at = (gw, minsEach, startsEach) => {
    const games = gw + PRIOR_DEFAULTS.lastSeasonWeight * PRIOR_DEFAULTS.lastSeasonGames;
    const m = poolPlayerSeasons({ code: 1, minutes: minsEach * gw, starts: startsEach * gw },
      priorEverPresent, { gamesThis: gw, games, lastSeasonWeight: PRIOR_DEFAULTS.lastSeasonWeight,
        lastSeasonGames: PRIOR_DEFAULTS.lastSeasonGames });
    return m.modelMinutes / games;
  };
  const benchedEarly = at(1, 11, 0);
  const benchedLong = at(8, 11, 0);
  ok('an ever-present who keeps being benched loses minutes',
    benchedLong < benchedEarly - 10, `${benchedEarly.toFixed(1)} -> ${benchedLong.toFixed(1)}`);
  ok('but one substitute appearance does not collapse him',
    benchedEarly > 75, `${benchedEarly.toFixed(1)}`);
  ok('an ever-present who keeps starting holds his minutes',
    at(8, 85, 1) > 80, `${at(8, 85, 1).toFixed(1)}`);
}

/* ------------------------------------------------------------------ *
 * the fixture list
 * ------------------------------------------------------------------ *
 * Grouped into the reader's own matchdays — the owner is on AEST and asked for
 * fixtures in it, so a 15:00 UK Saturday lands at 00:00 on his Sunday, which is
 * when it actually happens where he is. These checks therefore pin the parts
 * that must hold in ANY zone: which view a match belongs to, the ordering, and
 * that grouping never loses or duplicates a fixture.
 */
console.log('\nFixture list');
{
  const at = (iso, state, extra = {}) => ({ date: iso, state, home: { short: 'AAA', score: '1' }, away: { short: 'BBB', score: '0' }, ...extra });
  const feed = [
    at('2026-08-22T11:30Z', 'post'),
    at('2026-08-22T14:00Z', 'post'),
    at('2026-08-23T15:00Z', 'post'),
    at('2026-08-28T19:00Z', 'pre'),   // Fri 20:00 UK -> Sat 05:00 Brisbane
    at('2026-08-29T11:30Z', 'pre'),
    at('2026-08-29T14:00Z', 'pre'),
  ];

  ok('the two views are named for what they show',
    MATCH_VIEWS.map((v) => v.value).join(',') === 'results,upcoming');

  const results = groupByDay(feed, 'results');
  const upcoming = groupByDay(feed, 'upcoming');
  ok('results show only what has been played',
    results.flatMap((d) => d.items).every((m) => m.state !== 'pre'));
  ok('upcoming shows only what has not', 
    upcoming.flatMap((d) => d.items).every((m) => m.state === 'pre'));
  ok('every match appears in exactly one view',
    results.flatMap((d) => d.items).length + upcoming.flatMap((d) => d.items).length === feed.length);

  ok('results read newest first', (() => {
    const ds = results.flatMap((d) => d.items).map((m) => new Date(m.date).getTime());
    return ds.every((t, i) => i === 0 || ds[i - 1] >= t);
  })());
  ok('fixtures read soonest first', (() => {
    const ds = upcoming.flatMap((d) => d.items).map((m) => new Date(m.date).getTime());
    return ds.every((t, i) => i === 0 || ds[i - 1] <= t);
  })());

  /* Simultaneous kickoffs are the same day in every zone. Kickoffs merely
     hours apart legitimately split or merge depending on where the reader is —
     in Brisbane the three results above fall on three separate local days —
     so only the always-true case is asserted. */
  ok('simultaneous kickoffs share one group', (() => {
    const g = groupByDay([at('2026-08-29T14:00Z', 'post'), at('2026-08-29T14:00Z', 'post')], 'results');
    return g.length === 1 && g[0].items.length === 2;
  })());
  ok('grouping never loses or duplicates a fixture', (() => {
    const seen = results.flatMap((d) => d.items).concat(upcoming.flatMap((d) => d.items));
    return seen.length === feed.length && new Set(seen).size === feed.length;
  })());
  ok('a day group is never empty', [...results, ...upcoming].every((d) => d.items.length > 0));
  ok('an empty feed groups into nothing', groupByDay([], 'results').length === 0);
  ok('a feed of only fixtures has no results', groupByDay([at('2026-09-01T14:00Z', 'pre')], 'results').length === 0);

  /* A live match is being played, so it belongs with the results — putting it
     under "upcoming" would file a game in progress as not started. */
  ok('a match in progress counts as played, not upcoming',
    groupByDay([at('2026-08-25T14:00Z', 'in')], 'results').length === 1
    && groupByDay([at('2026-08-25T14:00Z', 'in')], 'upcoming').length === 0);

  /* Two kickoffs a whole day apart must never collapse into one group, in any
     zone. Kickoffs hours apart legitimately merge or split depending on where
     the reader is, so that is not asserted. */
  ok('kickoffs a day apart never share a group', (() => {
    const g = groupByDay([at('2026-08-28T12:00Z', 'pre'), at('2026-08-30T12:00Z', 'pre')], 'upcoming');
    return g.length === 2;
  })());
}

/* ------------------------------------------------------------------ *
 * transfer-constrained optimiser
 * ------------------------------------------------------------------ *
 * The from-scratch optimiser answers "what is the best fifteen for £100m",
 * which is a benchmark nobody can reach: acting on it costs a transfer per
 * player changed. This one answers the question an actual manager has —
 * "what is the best fifteen I can REACH with the transfers I have" — so its
 * whole job is respecting a budget the other solver does not have.
 */
console.log('\nTransfer-constrained optimiser');
{
  /* A deliberately sub-optimal starting squad: solved at a reduced budget, then
     handed the difference as bank. That guarantees there is something to find
     without hand-picking a squad the solver is known to improve. */
  const START_BUDGET = 950;
  const seedSquad = optimiseSquad(rows, { budget: START_BUDGET, horizon: 5 });
  ok('the constrained optimiser has a starting squad to work from',
    seedSquad?.squad?.length === 15);

  if (seedSquad?.squad?.length === 15) {
    const ids = seedSquad.squad.map((p) => p.id);
    const bank = 1000 - squadCostOf(seedSquad.squad);
    const run = (transfers) => optimiseWithinTransfers(ids, rows, { bank, transfers, horizon: 5 });
    const originIds = new Set(ids);
    const changed = (r) => r.squad.filter((p) => !originIds.has(p.id)).length;

    const none = run(0);
    ok('zero transfers returns the squad untouched',
      changed(none) === 0 && none.moves.length === 0 && near(none.gain, 0, 1e-9),
      `${changed(none)} changed, gain ${none.gain}`);

    const results = [1, 2, 3, 4, 5].map(run);
    ok('every result is a legal squad',
      results.every((r) => validate(r.squad, 1000).ok),
      results.map((r) => validate(r.squad, 1000).errors?.join(';')).filter(Boolean).join(' | '));
    ok('the transfer budget is never exceeded',
      results.every((r, i) => changed(r) <= i + 1),
      results.map((r, i) => `${i + 1}->${changed(r)}`).join(' '));
    ok('every reported move is matched within its own position',
      results.every((r) => r.moves.every((m) => m.out.element_type === m.in.element_type)));
    ok('the moves reported are exactly the players that changed',
      results.every((r) => r.moves.length === changed(r)),
      results.map((r) => `${r.moves.length}/${changed(r)}`).join(' '));
    /* Spending money you do not have is the failure that would make every
       suggestion useless, so it is asserted on cost directly rather than
       inferred from validate(). */
    ok('the cash budget is never exceeded',
      results.every((r) => squadCostOf(r.squad) <= squadCostOf(seedSquad.squad) + bank + 1e-9),
      results.map((r) => squadCostOf(r.squad)).join(' '));
    /* More transfers can only widen the search, never narrow it. A dip here
       would mean the cap is pruning moves it should allow. */
    ok('more transfers never scores worse',
      results.every((r, i) => i === 0 || r.score >= results[i - 1].score - 1e-9),
      results.map((r) => r.score.toFixed(2)).join(' '));
    ok('a transfer actually improves on doing nothing',
      results[0].score > none.score + 1e-9,
      `${results[0].score.toFixed(2)} vs ${none.score.toFixed(2)}`);
    ok('the gain reported matches the scores it came from',
      results.every((r) => near(r.gain, r.score - none.score, 1e-9)));
    /* A suggestion that changes between page loads cannot be acted on. */
    ok('the solve is deterministic',
      JSON.stringify(run(3).squad.map((p) => p.id).sort())
        === JSON.stringify(results[2].squad.map((p) => p.id).sort()));
    /* The reachable squad can never beat the unconstrained one at the same
       spend — the page shows them side by side, and a benchmark reading lower
       than the squad it is meant to cap is nonsense.
       This is what `seedSquads` is for. Randomised construction alone does not
       guarantee it: on this dataset the from-scratch solve at its default eight
       restarts lands on 90.50 while sixteen restarts and the constrained solve
       both reach 92.10. Seeding makes the relationship hold by construction. */
    const ceilingBudget = squadCostOf(seedSquad.squad) + bank;
    const ceiling = optimiseSquad(rows, {
      budget: ceilingBudget, horizon: 5, seedSquads: results.map((r) => r.squad),
    });
    ok('the reachable squad never beats the unconstrained one at the same money',
      results.every((r) => r.score <= ceiling.score + 1e-9),
      `${results.map((r) => r.score.toFixed(2)).join(' ')} vs ceiling ${ceiling.score.toFixed(2)}`);
    ok('a seeded squad is never worse than solving without the seed',
      ceiling.score >= optimiseSquad(rows, { budget: ceilingBudget, horizon: 5 }).score - 1e-9);
  }
}

/**
 * Stress test. A single dataset once hid a real bug: the greedy reserve ignored
 * the three-per-club cap, so once early picks concentrated in strong clubs there
 * was no legal goalkeeper left affordable and the whole solve returned null.
 * One seed happened not to trigger it. So: perturb the data many ways and demand
 * a legal squad every time.
 */
console.log('\nStress test — 40 perturbed datasets');
let stressFails = 0;
let nulls = 0;
let seed = 20260816;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

for (let trial = 0; trial < 40; trial++) {
  const jittered = rows.map((p) => {
    const priceScale = 0.6 + rnd() * 0.9;
    const projScale = 0.3 + rnd() * 1.6;
    return {
      ...p,
      now_cost: Math.max(38, Math.round((p.now_cost * priceScale) / 5) * 5),
      proj: p.proj * projScale,
      value: 0,
    };
  }).map((p) => ({ ...p, value: p.now_cost > 0 ? p.proj / (p.now_cost / 10) : 0 }));

  // Vary the budget too, including uncomfortably tight ones.
  const budget = [1000, 1000, 950, 900, 860][trial % 5];
  const res = optimiseSquad(jittered, { horizon: 5, restarts: 3, budget });

  if (!res) {
    // Only a failure if a legal squad was actually possible at this budget.
    const floor = [1, 2, 3, 4].reduce((sum, pos) => {
      const costs = jittered.filter((p) => p.element_type === pos && p.proj > 0)
        .map((p) => p.now_cost).sort((a, b) => a - b);
      return sum + costs.slice(0, SQUAD_RULES.select[pos]).reduce((s, c) => s + c, 0);
    }, 0);
    if (floor <= budget) { stressFails++; console.error(`  ✗ trial ${trial}: null but floor ${floor} <= budget ${budget}`); }
    else nulls++;
    continue;
  }
  const v = validate(res.squad, budget);
  if (!v.ok) { stressFails++; console.error(`  ✗ trial ${trial}: ${v.errors.join('; ')}`); }
  if (res.xi.length !== 11 || res.bench.length !== 4) { stressFails++; console.error(`  ✗ trial ${trial}: bad XI/bench split`); }
}
ok(`40 perturbed datasets all solve legally${nulls ? ` (${nulls} genuinely infeasible)` : ''}`, stressFails === 0, `${stressFails} bad`);

/* ------------------------------------------------------------------ *
 * manual substitutions — canSwap / splitXI
 * ------------------------------------------------------------------ */
console.log('\nManual substitutions');
{
  const sq = opt.squad;
  const { xi: base } = bestXI(sq);
  const inXI = (pos) => base.find((p) => p.element_type === pos);
  const onBench = (pos) => sq.find((p) => p.element_type === pos && !base.includes(p));

  const gkOut = inXI(1), gkIn = onBench(1);
  ok('keeper swaps with the reserve keeper', canSwap(gkOut, gkIn, base));

  const outfieldBench = sq.find((p) => p.element_type !== 1 && !base.includes(p));
  ok('keeper cannot be swapped for an outfielder', !canSwap(gkOut, outfieldBench, base));
  ok('outfielder cannot take the keeper slot', !canSwap(outfieldBench, gkOut, base));

  /* These three used to hang off `onBench(3)` — whether the OPTIMISER happened
     to leave a midfielder on the bench. It did until the opportunity model
     changed which fifteen it picks, and then all three silently stopped
     running: no failure, just three fewer checks. A rule about substitution
     legality should not depend on who the solver likes this week, so the
     midfielder is now constructed rather than discovered. */
  const defsIn = base.filter((p) => p.element_type === 2).length;
  const defOut = inXI(2);
  const anyMid = sq.find((p) => p.element_type === 3);
  const midBench = onBench(3) || (anyMid ? { ...anyMid, id: -3, web_name: 'BenchMid' } : null);
  ok('a benched midfielder is available to test with', !!midBench);
  ok('outfield swap allowed when minimums still hold',
    canSwap(defOut, midBench, base) === (defsIn - 1 >= MIN_DEF), `defs ${defsIn}`);

  // Strip to exactly the minimum and the next removal must be refused.
  const threeDef = base.filter((p) => p.element_type === 2).slice(0, 3);
  const minXI = [inXI(1), ...threeDef, ...base.filter((p) => p.element_type === 3).slice(0, 1),
    ...base.filter((p) => p.element_type === 4).slice(0, 1)].filter(Boolean);
  ok('the minimum-shape XI really has three defenders',
    minXI.filter((p) => p.element_type === 2).length === 3);
  ok('cannot drop below three defenders', !canSwap(threeDef[0], midBench, minXI));
  const fwdInMin = minXI.find((p) => p.element_type === 4);
  ok('the minimum-shape XI really has one forward',
    minXI.filter((p) => p.element_type === 4).length === 1);
  ok('cannot drop the last forward', !canSwap(fwdInMin, midBench, minXI));

  ok('a player cannot swap with himself', !canSwap(gkOut, gkOut, base));

  // splitXI rebuilds a legal split from an explicit starter set.
  const manual = splitXI(sq, base.map((p) => p.id));
  ok('splitXI reproduces the same XI', manual.xi.length === 11
    && manual.xi.every((p) => base.includes(p)));
  ok('splitXI benches the rest', manual.bench.length === 4);
  ok('splitXI keeps the reserve keeper in slot one', manual.bench[0].element_type === 1);
  ok('splitXI names a captain from the XI', !!manual.captain && manual.xi.includes(manual.captain));
  ok('splitXI reports the formation', /^\d-\d-\d$/.test(manual.formation));

  // Applying a real swap round-trips into a legal XI.
  if (gkOut && gkIn) {
    const swapped = base.map((p) => (p === gkOut ? gkIn : p));
    const after = splitXI(sq, swapped.map((p) => p.id));
    ok('a completed keeper swap yields a legal XI',
      after.xi.filter((p) => p.element_type === 1).length === 1 && after.xi.length === 11);
    ok('the swapped-out keeper is now benched', after.bench.includes(gkOut));
  }

  ok('splitXI rejects a starter set that is not 11', splitXI(sq, [sq[0].id]) === null);
  ok('splitXI rejects an illegal starter set',
    splitXI(sq, sq.filter((p) => p.element_type !== 1).slice(0, 11).map((p) => p.id)) === null);
}

/* ------------------------------------------------------------------ *
 * Draft adapter
 * ------------------------------------------------------------------ */
console.log('\nDraft adapter');
{
  const el = {
    id: 1, element_type: 3, team: 1, minutes: 1800, status: 'a',
    expected_goals: '10.0', expected_assists: '5.0', expected_goals_conceded: '20.0',
    saves: 0, defensive_contribution: 40, draft_rank: 1, points_per_game: '6.0',
    bps: 600, yellow_cards: 2, web_name: 'Tester',
  };
  const [row] = adaptDraftElements({ elements: [el] });

  ok('xG per 90 derives from totals', near(row.expected_goals_per_90, 0.5, 1e-9),
    `got ${row.expected_goals_per_90}`);
  ok('xA per 90 derives from totals', near(row.expected_assists_per_90, 0.25, 1e-9));
  ok('xGC per 90 derives from totals', near(row.expected_goals_conceded_per_90, 1.0, 1e-9));
  ok('defensive contribution per 90 derives from totals',
    near(row.defensive_contribution_per_90, 2.0, 1e-9));
  ok('original fields survive the adapter', row.web_name === 'Tester' && row.draft_rank === 1);

  const zero = adaptDraftElements({ elements: [{ ...el, minutes: 0 }] })[0];
  ok('a player with no minutes gets no per-90s', zero.expected_goals_per_90 === 0);

  ok('the draft prior is highest at rank 1',
    draftPrior({ element_type: 3, draft_rank: 1 }) > draftPrior({ element_type: 3, draft_rank: 200 }));
  ok('the draft prior stays positive deep down the board',
    draftPrior({ element_type: 3, draft_rank: 500 }) > 0);
  ok('the draft prior needs no price', Number.isFinite(draftPrior({ element_type: 2, draft_rank: 40 })));

  // v01 must be untouched: the default prior is still the price prior.
  const withPrice = { element_type: 3, now_cost: 100, minutes: 0, status: 'a', team: 1 };
  const a = projectFixture(withPrice, { difficulty: 3, home: true }, { games: 38, defence: {} }, {});
  const b = projectFixture(withPrice, { difficulty: 3, home: true }, { games: 38, defence: {} },
    { prior: () => 999 });
  ok('the prior is injectable', b.total > a.total, 'injected prior had no effect');
}

/* ------------------------------------------------------------------ *
 * Draft board — snake order, replacement level, VORP
 * ------------------------------------------------------------------ */
console.log('\nDraft board');
{
  ok('slot 1 of 6 opens the draft', snakePicks(6, 1)[0] === 1);
  ok('slot 6 of 6 picks back-to-back at the turn',
    snakePicks(6, 6)[0] === 6 && snakePicks(6, 6)[1] === 7);
  ok('slot 1 of 6 waits eleven picks',
    snakePicks(6, 1)[1] - snakePicks(6, 1)[0] === 11);
  ok('a draft runs fifteen rounds', snakePicks(6, 3).length === 15);
  ok('slot 3 of 6 matches the published sequence',
    snakePicks(6, 3).join(',') === '3,10,15,22,27,34,39,46,51,58,63,70,75,82,87');

  // Across all slots, the first two rounds must use every pick exactly once.
  const firstTwo = [];
  for (let s = 1; s <= 6; s++) firstTwo.push(...snakePicks(6, s).slice(0, 2));
  firstTwo.sort((a, b) => a - b);
  ok('every pick in rounds one and two is used exactly once',
    firstTwo.join(',') === Array.from({ length: 12 }, (_, i) => i + 1).join(','));

  ok('six managers start six keepers, so replacement is the 7th',
    replacementRank(6, 1) === 7);
  ok('six managers start twenty-four defenders, so replacement is the 25th',
    replacementRank(6, 2) === 25);
  ok('six managers start twelve forwards, so replacement is the 13th',
    replacementRank(6, 4) === 13);
  ok('a bigger league pushes replacement deeper', replacementRank(12, 4) > replacementRank(6, 4));

  // Build a synthetic pool: 40 per position, projections descending from 200.
  const pool = [];
  let pid = 1;
  for (const type of [1, 2, 3, 4]) {
    for (let i = 0; i < 40; i++) pool.push({ id: pid++, element_type: type, proj: 200 - i * 3 });
  }
  const { rows, replacement } = buildBoard(pool, 6);
  ok('replacement level is the projection at the replacement rank',
    near(replacement[4], 200 - (13 - 1) * 3, 1e-9), `got ${replacement[4]}`);
  ok('VORP is projection minus replacement', near(
    rows.find((r) => r.element_type === 4).vorp, 200 - replacement[4], 1e-9));
  ok('every row carries a VORP', rows.every((r) => Number.isFinite(r.vorp)));
  ok('the replacement player himself has zero VORP', rows.some((r) => near(r.vorp, 0, 1e-9)));
  ok('players below replacement have negative VORP', rows.some((r) => r.vorp < 0));
}

/* ------------------------------------------------------------------ *
 * Draft tiers
 * ------------------------------------------------------------------ */
console.log('\nDraft tiers');
{
  // Two obvious clusters at one position: 100/99/98, then a cliff, then 50/49/48.
  const rows = [100, 99, 98, 50, 49, 48].map((proj, i) => ({
    id: i + 1, element_type: 3, proj, vorp: proj,
  }));
  const tiered = assignTiers(rows, 1.0);
  const tierOf = (p) => tiered.find((r) => r.proj === p).tier;

  ok('every player lands in a tier', tiered.every((r) => Number.isInteger(r.tier) && r.tier >= 1));
  ok('the top cluster shares a tier', tierOf(100) === tierOf(99) && tierOf(99) === tierOf(98));
  ok('a cliff starts a new tier', tierOf(50) > tierOf(98));
  ok('the second cluster shares a tier', tierOf(50) === tierOf(48));
  ok('tiers start at one', Math.min(...tiered.map((r) => r.tier)) === 1);

  // An evenly spaced position has no cliffs, so it should not fragment.
  const even = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i, element_type: 2, proj: 100 - i, vorp: 100 - i,
  }));
  const evenTiers = assignTiers(even, 1.0);
  ok('an evenly spaced position does not fragment',
    new Set(evenTiers.map((r) => r.tier)).size <= 2,
    `got ${new Set(evenTiers.map((r) => r.tier)).size} tiers`);

  ok('tiers are numbered per position', assignTiers([...rows, ...even], 1.0)
    .filter((r) => r.element_type === 2).some((r) => r.tier === 1));
}

/* ------------------------------------------------------------------ *
 * Draft live state
 * ------------------------------------------------------------------ */
console.log('\nDraft live state');
{
  const status = [
    { element: 1, owner: null, status: 'a' },
    { element: 2, owner: 55, status: 'o' },
    { element: 3, owner: 77, status: 'o' },
  ];
  const own = ownershipFrom(status);
  ok('ownership maps every element', own.size === 3);
  ok('an unowned player maps to null', own.get(1) === null);
  ok('an owned player maps to his entry', own.get(2) === 55);

  const rows = [1, 2, 3, 4].map((id) => ({ id, element_type: 3, proj: 10, vorp: 1 }));
  const avail = availableRows(rows, own);
  ok('owned players drop out of the pool', avail.map((r) => r.id).join(',') === '1,4');
  ok('a player absent from the map counts as available', avail.some((r) => r.id === 4));

  // Six managers. `pick` is per-round (1..6), with `round` separate — so a
  // manager's round-1 pick number is their slot.
  const choices = [
    { pick: 1, round: 1, entry: 11 }, { pick: 2, round: 1, entry: 22 },
    { pick: 3, round: 1, entry: 77 }, { pick: 4, round: 1, entry: 44 },
    // Round 2 reverses, and pick numbers restart from 1.
    { pick: 3, round: 2, entry: 44 }, { pick: 4, round: 2, entry: 77 },
  ];
  ok('the slot derives from the round-one pick', deriveSlot(choices, 77) === 3);
  ok('a later round never overrides the slot', deriveSlot(choices, 44) === 4);
  ok('an unknown entry gives no slot', deriveSlot(choices, 999) === null);
  ok('an empty draft gives no slot', deriveSlot([], 77) === null);

  const roster = myRoster(
    [{ id: 2, element_type: 1 }, { id: 3, element_type: 3 }], own, 77);
  ok('the roster holds only my players', roster.length === 1 && roster[0].id === 3);

  const need = positionsNeeded([{ element_type: 1 }, { element_type: 3 }]);
  ok('needs count down from the quota', need[1] === 1 && need[3] === 4);
  ok('an untouched position needs its full quota', need[2] === 5);
  ok('needs never go negative', positionsNeeded(
    Array.from({ length: 9 }, () => ({ element_type: 1 })))[1] === 0);
}

/* ------------------------------------------------------------------ *
 * Draft survival simulation
 * ------------------------------------------------------------------ */
console.log('\nDraft survival simulation');
{
  const rng = makeRng(42);
  const first = [rng(), rng(), rng()];
  const again = makeRng(42);
  ok('the rng is deterministic for a seed',
    [again(), again(), again()].join(',') === first.join(','));
  ok('the rng stays in range', first.every((v) => v >= 0 && v < 1));

  const myPicks = [3, 10, 15];
  ok('six opponents pick between my first and second turn', picksBetween(3, myPicks) === 6);
  ok('the count is taken from my current turn', picksBetween(10, myPicks) === 4);
  ok('no further pick means nothing to wait for', picksBetween(15, myPicks) === Infinity);

  // 30 players, draft_rank 1..30. Better ranks should be likelier to go.
  const pool = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, element_type: 3, draft_rank: i + 1, vorp: 100 - i,
  }));
  const s = survival(pool, 6, { seed: 7, trials: 300 });

  ok('every available player gets a probability', s.size === 30);
  ok('probabilities are probabilities',
    [...s.values()].every((v) => v >= 0 && v <= 1));
  ok('the best player is least likely to survive', s.get(1) < s.get(30));
  ok('a deep player almost certainly survives six picks', s.get(30) > 0.9);
  ok('the simulation is deterministic',
    survival(pool, 6, { seed: 7, trials: 300 }).get(1) === s.get(1));
  ok('waiting longer never improves survival',
    survival(pool, 12, { seed: 7, trials: 300 }).get(1) <= s.get(1));
  ok('with no wait, everyone survives',
    survival(pool, 0, { seed: 7, trials: 50 }).get(1) === 1);
}

/* ------------------------------------------------------------------ *
 * Draft recommendation
 * ------------------------------------------------------------------ */
console.log('\nDraft recommendation');
{
  // Four contenders plus filler, so the 6-pick gap cannot exhaust the pool.
  // Ranks 1 and 2 are near-certain to be taken; ranks 300+ are near-certain
  // to survive, which is what makes the timing logic observable.
  const pool = [
    { id: 1, element_type: 4, draft_rank: 1, vorp: 100 },   // goes
    { id: 2, element_type: 4, draft_rank: 300, vorp: 98 },  // lasts
    { id: 3, element_type: 3, draft_rank: 2, vorp: 90 },    // goes
    { id: 4, element_type: 3, draft_rank: 301, vorp: 88 },  // lasts
  ];
  // Filler at keeper/defender so it absorbs opponent picks without changing
  // the forward and midfield alternatives under test.
  for (let i = 0; i < 20; i++) {
    pool.push({ id: 100 + i, element_type: i % 2 ? 2 : 1, draft_rank: 10 + i, vorp: 20 - i });
  }
  const rec = recommend(pool, { myPicks: [3, 10], currentPick: 3, roster: [], trials: 300 });
  const rowFor = (id) => rec.find((r) => r.id === id);

  ok('every candidate is scored', rec.length === pool.length);
  ok('candidates carry a survival probability',
    rec.every((r) => r.survivalP >= 0 && r.survivalP <= 1));
  ok('candidates carry a net value', rec.every((r) => Number.isFinite(r.netValue)));
  ok('the list is sorted by net value',
    rec.every((r, i) => i === 0 || rec[i - 1].netValue >= r.netValue));

  // These two are the real test of the formula: they fail if netValue is
  // just raw VORP, which is what the previous fixture could not detect.
  ok('a player certain to survive scores near zero — passing costs nothing',
    Math.abs(rowFor(2).netValue) < 0.5, `got ${rowFor(2).netValue}`);
  ok('a player certain to be taken scores his edge over the next man up',
    rowFor(1).netValue > 1 && rowFor(1).netValue < 4, `got ${rowFor(1).netValue}`);
  ok('a top-ranked player is unlikely to survive the gap', rowFor(1).survivalP < 0.2);
  ok('a deeply-ranked player is likely to survive the gap', rowFor(2).survivalP > 0.8);
  ok('a player who will not last outranks an equal one who will',
    rec.findIndex((r) => r.id === 1) < rec.findIndex((r) => r.id === 2),
    `id 1 at ${rec.findIndex((r) => r.id === 1)}, id 2 at ${rec.findIndex((r) => r.id === 2)}`);

  // A filled position is not recommended again.
  const full = recommend(pool, {
    myPicks: [3, 10], currentPick: 3, trials: 200,
    roster: Array.from({ length: 3 }, () => ({ element_type: 4 })),
  });
  ok('a filled position drops out of the recommendation',
    full.every((r) => r.element_type !== 4));

  // With no later pick, timing is irrelevant and raw VORP wins.
  const last = recommend(pool, { myPicks: [3], currentPick: 3, roster: [], trials: 200 });
  ok('on the final pick the best player wins outright', last[0].id === 1);
  ok('recommendation is deterministic',
    recommend(pool, { myPicks: [3, 10], currentPick: 3, roster: [], trials: 300 })[0].id === rec[0].id);
}

console.log('\nDraft baselines');
{
  // A synthetic pool of linear ramps cannot test VORP: opponents picking in
  // rank order deplete every position proportionally, so no positional
  // scarcity ever arises and three different replacement baselines produce
  // identical squads. This is the real pool's value distribution instead.
  const { pool } = await readJSON('scripts/fixtures/draft-pool.json');
  // Forty seeds, not eight: at eight the win count swings on sampling noise.
  const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i * 137);
  const totals = { vorp: 0, rank: 0, best: 0 };
  let vorpWins = 0;
  let sample = null;
  for (const seed of SEEDS) {
    const r = {
      vorp: runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.vorp, seed }),
      rank: runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.draftRank, seed }),
      best: runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.bestAvailable, seed }),
    };
    totals.vorp += r.vorp.total; totals.rank += r.rank.total; totals.best += r.best.total;
    if (r.vorp.total >= r.rank.total && r.vorp.total >= r.best.total) vorpWins++;
    sample = sample || r.vorp;
  }
  const mean = (k) => totals[k] / SEEDS.length;

  ok('a full squad is drafted', sample.roster.length === 15);
  ok('the squad satisfies the position quotas',
    [1, 2, 3, 4].every((t) => sample.roster.filter((r) => r.element_type === t).length
      === { 1: 2, 2: 5, 3: 5, 4: 3 }[t]));
  ok('no player is drafted twice', new Set(sample.roster.map((r) => r.id)).size === 15);
  ok('the VORP board clearly beats drafting by the game ranking',
    mean('vorp') > mean('rank') * 1.05,
    `${mean('vorp').toFixed(1)} vs ${mean('rank').toFixed(1)}`);
  ok('the VORP board is not worse than best-available on average',
    mean('vorp') > mean('best'), `${mean('vorp').toFixed(1)} vs ${mean('best').toFixed(1)}`);
  ok('the VORP board wins more drafts than it loses',
    vorpWins > SEEDS.length / 2, `${vorpWins}/${SEEDS.length}`);
  ok('a draft is reproducible',
    runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.vorp, seed: 99 }).total
      === runDraft(pool, { leagueSize: 6, mySlot: 3, strategy: STRATEGIES.vorp, seed: 99 }).total);
}

/* ------------------------------------------------------------------ *
 * prior blending
 * ------------------------------------------------------------------ *
 * The case this exists for: FPL zeroes every season total at the GW1 deadline.
 * A zeroed payload plus last season must land close to what the model saw
 * before the zeroing, without handing a one-game cameo the confidence of a
 * full campaign.
 */
console.log('\nPrior blending');
{
  const L = PRIOR_DEFAULTS.lastSeasonWeight;
  const G = PRIOR_DEFAULTS.lastSeasonGames;
  const el = (over) => ({
    id: 1, code: 100, element_type: 3, team: 1, now_cost: 70, status: 'a',
    chance_of_playing_next_round: null, minutes: 0, bps: 0, yellow_cards: 0,
    expected_goals: '0.0', expected_assists: '0.0', expected_goals_conceded: '0.0',
    saves: 0, defensive_contribution: 0,
    clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0,
    expected_goals_per_90: 0, expected_assists_per_90: 0,
    expected_goals_conceded_per_90: 0, saves_per_90: 0, defensive_contribution_per_90: 0,
    ...over,
  });
  // The season label is mandatory: hydrate() reads it and refuses anything
  // outside the window, including an unlabelled prior.
  const priorOf = (over) => ({ season: '2025/26', players: { 100: { code: 100, minutes: 0, expected_goals: 0,
    expected_assists: 0, expected_goals_conceded: 0, saves: 0, defensive_contribution: 0,
    bps: 0, yellow_cards: 0, clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0,
    ...over } } });

  // a full-time scorer last season, yet to play this one
  const boot = { elements: [el({ minutes: 0 })], teams: [{ id: 1 }] };
  const prior = priorOf({ minutes: 3420, expected_goals: 19, bps: 760 });
  const h = hydrate(boot, prior);
  const p = h.elements[0];

  ok('a missing prior leaves the payload untouched', hydrate(boot, null) === boot);
  ok('the input is not mutated', boot.elements[0].minutes === 0 && boot.elements[0].bps === 0);
  ok('raw minutes survive for display', p.minutes === 0);

  /* The basis is now STATED by hydrate rather than re-derived from whichever
     player happens to have the most minutes. That inference was only ever
     approximately right — in live data it is pinned by ESPN-sourced players
     who reach the payload through a different path — and it silently shifts
     for everybody whenever minutes estimation changes. */
  ok('hydrate states the games basis it used', h.modelGamesBasis === 1 + L * G, `got ${h.modelGamesBasis}`);
  const games = inferGamesPlayed(h.elements, h.modelGamesBasis);
  ok('inferGamesPlayed honours the stated basis', games === Math.round(1 + L * G), `got ${games}`);
  ok('the minutes basis round-trips', near(p.modelMinutes / games, p.modelMinutes / (1 + L * G), 1e-9));

  /* An ever-present last season projects high, but NOT a flat ninety. It used
     to, because expected minutes were a pooled average with nothing pulling
     them back. Measured across every adjacent season pair in `history_past`,
     players who started at least 90% of the games they featured in went on to
     feature in 0.633 of the following season — injuries and rotation are not
     optional. Shrinking a 38/38 season toward the population mean is therefore
     conservative rather than aggressive, and a model that returns exactly 90
     is asserting something the data contradicts. */
  const evPresent = p.modelMinutes / games;
  ok('an ever-present prior season projects high', evPresent > 70, `${evPresent.toFixed(1)}`);
  ok('but not a guaranteed full ninety', evPresent < 90, `${evPresent.toFixed(1)}`);
  ok('evidence is the minutes actually observed', near(p.evidenceMinutes, L * 3420, 1e-6));
  ok('a pooled rate is last season’s rate', near(p.expected_goals_per_90, (19 / 3420) * 90, 1e-9));
  ok('counts are rebuilt to agree with modelMinutes',
    near((p.bps / p.modelMinutes) * 90, (760 / 3420) * 90, 1e-9));

  // the Tzolis case: one appearance, nothing before it
  const rookie = hydrate({ elements: [el({ minutes: 75, expected_goals: '0.19' })], teams: [{ id: 1 }] },
    priorOf({ minutes: 0 })).elements[0];
  ok('one appearance with no prior is not treated as evidence', near(rookie.evidenceMinutes, 75, 1e-9));
  ok('...but his role still reads as a near-starter',
    rookie.modelMinutes / inferGamesPlayed([rookie]) > 60);

  /* The blend has to survive the projection, not just the arithmetic. Two
     players, identical but for their history: one played 75 minutes and has no
     past, the other sat out but was a full-time scorer last season. */
  const fx = [{ event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3, team_a_difficulty: 3, finished: false }];
  const twoBoot = {
    elements: [el({ id: 1, code: 100, minutes: 75, expected_goals: '0.19' }),
      el({ id: 2, code: 101, minutes: 0 })],
    teams: [{ id: 1 }, { id: 2 }],
  };
  const twoPrior = { season: '2025/26', players: {
    100: { code: 100, minutes: 0, expected_goals: 0, expected_assists: 0, bps: 0 },
    101: { code: 101, minutes: 3420, expected_goals: 19, expected_assists: 6, bps: 760 },
  } };
  const two = projectAll(hydrate(twoBoot, twoPrior), fx, { horizon: 1 });
  const rookie2 = two.rows.find((r) => r.id === 1);
  const veteran = two.rows.find((r) => r.id === 2);
  ok('a one-game rookie still leans on the price prior', rookie2.parts?.isPrior === true,
    `evidence ${rookie2.parts?.evidence?.toFixed(3)}`);
  ok('a full prior season counts as evidence even with no minutes yet',
    veteran.parts?.isPrior === false, `evidence ${veteran.parts?.evidence?.toFixed(3)}`);
  ok('the evidenced scorer outprojects the unevidenced rookie', veteran.proj > rookie2.proj,
    `${veteran.proj.toFixed(2)} vs ${rookie2.proj.toFixed(2)}`);

  /* End to end on the sample dataset. make-sample writes its own codes, so the
     prior is built from that payload rather than read from disk — the committed
     prior belongs to real players and would join to nothing here. */
  /* The minutes the peak player in a payload must have logged before that payload
     can stand in for a completed season. Mirrors the model's own
     priorBlendMinutes — below it, even the best-evidenced player is not fully
     trusted, so the payload cannot furnish a prior for anyone. */
  const PRIOR_SEASON_SCALE_MINUTES = 900;

  const sampleBoot = await readJSON('data/bootstrap.json');
  const sampleFx = await readJSON('data/fixtures.json', []);
  /* This block builds its "last season" out of whatever is in data/, which only
     means something while that payload HOLDS a season. bootstrap-static's
     counters are zeroed at the GW1 deadline: on 24 Aug 2026 the prior built here
     held 17,700 minutes peaking at 90, against a real season's 602,348 and
     3,420. A prior that thin lifts nobody's evidence, so these checks compared a
     payload against itself and reported a model fault that was really an empty
     fixture. npm test seeds season-scale data through make-sample, which is what
     they are written for. The live zeroed payload is covered instead by the
     frozen-prior block below, which joins the real 2025/26 record. */
  const peakMinutes = Math.max(...(sampleBoot?.elements || []).map((e) => Number(e.minutes) || 0), 0);
  if (sampleBoot?.elements?.length && peakMinutes < PRIOR_SEASON_SCALE_MINUTES) {
    console.log(`  – end-to-end pooling skipped: payload peaks at ${peakMinutes} minutes, not a season`);
  }
  if (sampleBoot?.elements?.length && peakMinutes >= PRIOR_SEASON_SCALE_MINUTES) {
    const zeroed = { ...sampleBoot, elements: sampleBoot.elements.map((e) => ({
      ...e, minutes: 0, bps: 0, yellow_cards: 0, expected_goals: '0.0', expected_assists: '0.0',
      expected_goals_conceded: '0.0', saves: 0, defensive_contribution: 0,
      expected_goals_per_90: 0, expected_assists_per_90: 0, expected_goals_conceded_per_90: 0,
      saves_per_90: 0, defensive_contribution_per_90: 0,
    })) };
    const built = { season: '2025/26', players: Object.fromEntries(sampleBoot.elements.map((e) => [e.code, {
      code: e.code, minutes: Number(e.minutes) || 0, expected_goals: parseFloat(e.expected_goals) || 0,
      expected_assists: parseFloat(e.expected_assists) || 0,
      expected_goals_conceded: parseFloat(e.expected_goals_conceded) || 0,
      saves: Number(e.saves) || 0, defensive_contribution: Number(e.defensive_contribution) || 0,
      bps: Number(e.bps) || 0, yellow_cards: Number(e.yellow_cards) || 0,
      clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0,
    }])) };
    const share = (r) => r.rows.filter((x) => x.parts?.isPrior).length / r.rows.length;
    const bare = projectAll(zeroed, sampleFx, { horizon: 5 });
    const pooled = projectAll(hydrate(zeroed, built), sampleFx, { horizon: 5 });
    ok('a zeroed August recovers its evidence from the prior',
      share(pooled) < share(bare),
      `${(share(pooled) * 100).toFixed(0)}% on the prior vs ${(share(bare) * 100).toFixed(0)}%`);
    ok('every projection stays finite', pooled.rows.every((x) => Number.isFinite(x.proj)));
    ok('no projection goes negative', pooled.rows.every((x) => x.proj >= 0));
    ok('pooling restores the ranking a zeroed payload loses', (() => {
      const full = projectAll(sampleBoot, sampleFx, { horizon: 5 });
      const order = (r) => new Map([...r.rows].sort((a, b) => b.proj - a.proj).map((x, i) => [x.id, i]));
      const truth = order(full);
      const top = [...full.rows].sort((a, b) => b.proj - a.proj).slice(0, 50).map((x) => x.id);
      const hit = (r) => { const o = order(r); return top.filter((id) => o.get(id) < 50).length; };
      return hit(pooled) > hit(bare);
    })());
  }
}


/* ------------------------------------------------------------------ *
 * pooling against the frozen prior
 * ------------------------------------------------------------------ *
 * The end-to-end block above needs a payload that holds a whole season, and
 * gets one from make-sample. This is the case it cannot cover: the live
 * bootstrap after FPL zeroes it at the GW1 deadline, hydrated from the real
 * committed 2025/26 record. That record joins on `code`, which is stable across
 * seasons and across both games, so unlike a synthetic prior it works precisely
 * where the synthetic one stops working.
 */
console.log('\nPooling against the frozen prior');
{
  /* Zero is a statistic; missing is the absence of one. Confusing the two is
     the bug class that produced `evidenceMinutes: 0`, so it is asserted here on
     the pooling arithmetic directly rather than inferred from a projection. */
  const lambda = PRIOR_DEFAULTS.lastSeasonWeight;
  const priorRec = { minutes: 2400, expected_goals: 24, expected_assists: 0, bps: 0 };
  const pool = (current) => poolPlayerSeasons(current, priorRec,
    { gamesThis: 1, games: 38, lastSeasonWeight: lambda, lastSeasonGames: 38, priorSeason: '2025/26' });

  const played = pool({ minutes: 900, expected_goals: 0 });
  const unseen = pool({ minutes: 0, expected_goals: 0 });
  ok('a season with no minutes yet leans wholly on the prior rate',
    near(unseen.expected_goals_per_90, (24 / 2400) * 90, 1e-9),
    `${unseen.expected_goals_per_90}`);
  ok('an observed zero is evidence and pulls the pooled rate down',
    played.expected_goals_per_90 < unseen.expected_goals_per_90 - 1e-9,
    `played ${played.expected_goals_per_90.toFixed(4)} vs unseen ${unseen.expected_goals_per_90.toFixed(4)}`);
  ok('an observed zero does not erase the prior either',
    played.expected_goals_per_90 > 0,
    `${played.expected_goals_per_90}`);
  ok('minutes actually observed are what counts as evidence',
    played.evidenceMinutes === 900 + lambda * 2400 && unseen.evidenceMinutes === lambda * 2400,
    `${played.evidenceMinutes} / ${unseen.evidenceMinutes}`);

  const liveBoot = await readJSON('data/bootstrap.json');
  const liveFx = await readJSON('data/fixtures.json', []);
  const frozen = await readJSON('data/draft/prior-2526.json');
  const joins = (liveBoot?.elements || []).filter((e) => frozen?.players?.[e.code]).length;
  /* Zero overlap means the payload is not in the same code space at all — that
     is make-sample's synthetic dataset, which mints its own codes, not a
     regression. A PARTIAL join on a real payload would be one, so only the
     total absence of overlap skips. */
  if (liveBoot?.elements?.length && joins === 0) {
    console.log('  – frozen-prior checks skipped: payload shares no codes with the 2025/26 record');
  }
  if (liveBoot?.elements?.length && liveFx?.length && joins > 0) {
    ok('the frozen prior joins the live payload on code', joins > 300,
      `${joins} of ${liveBoot.elements.length}`);

    const zeroedLive = { ...liveBoot, elements: liveBoot.elements.map((e) => ({
      ...e, minutes: 0, bps: 0, yellow_cards: 0, expected_goals: '0.0', expected_assists: '0.0',
      expected_goals_conceded: '0.0', saves: 0, defensive_contribution: 0,
      expected_goals_per_90: 0, expected_assists_per_90: 0, expected_goals_conceded_per_90: 0,
      saves_per_90: 0, defensive_contribution_per_90: 0,
    })) };
    const priorShare = (r) => r.rows.filter((x) => x.parts?.isPrior).length / r.rows.length;
    const bareLive = projectAll(zeroedLive, liveFx, { horizon: 5 });
    const pooledLive = projectAll(hydrate(zeroedLive, frozen), liveFx, { horizon: 5 });
    ok('a zeroed payload recovers its evidence from the frozen prior',
      priorShare(pooledLive) < priorShare(bareLive),
      `${(priorShare(pooledLive) * 100).toFixed(0)}% on the prior vs ${(priorShare(bareLive) * 100).toFixed(0)}%`);
    ok('recovering evidence keeps every projection finite and non-negative',
      pooledLive.rows.every((x) => Number.isFinite(x.proj) && x.proj >= 0));

    /* The two-season window, enforced at the door. A prior relabelled outside it
       must be refused outright, not blended in because its numbers look fine. */
    const stale = projectAll(hydrate(zeroedLive, { ...frozen, season: '2024/25' }), liveFx, { horizon: 5 });
    ok('a prior from outside the two-season window is refused, not blended',
      near(priorShare(stale), priorShare(bareLive), 1e-9),
      `${(priorShare(stale) * 100).toFixed(0)}% vs bare ${(priorShare(bareLive) * 100).toFixed(0)}%`);
  }
}

/* ------------------------------------------------------------------ *
 * explanations
 * ------------------------------------------------------------------ *
 * The design asks for a sentence beside every suggestion. The rule this module
 * exists to keep is that it only says things it can point at: FPL's words are
 * quoted, the model's inferences are labelled as inferences, and a player with
 * nothing remarkable about him produces no note at all.
 */
console.log('\nExplanations');
{
  const fx = (event, h, a, dh = 3, da = 3) => ({ event, team_h: h, team_a: a, team_h_difficulty: dh, team_a_difficulty: da });
  const teamMap = { 1: { short_name: 'ARS' }, 2: { short_name: 'BUR' }, 3: { short_name: 'MCI' } };
  const base = { id: 1, team: 1, web_name: 'Tester', proj: 5, parts: { expMins: 85 }, minutes: 900 };

  ok('a player with nothing remarkable produces no note',
    notesFor({ ...base }, { fixtures: [fx(1, 1, 2)], teams: teamMap, fromEvent: 1, horizon: 1 }).length === 0);

  /* FPL's words, verbatim. Paraphrasing a medical note is how a 75% chance
     becomes "doubtful" becomes "out" — the string is quoted or not used. */
  const news = 'Thigh injury - 75% chance of playing';
  const withNews = notesFor({ ...base, news, chance_of_playing_next_round: 75 },
    { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 });
  ok('FPL news is quoted word for word', withNews.some((n) => n.text === news), JSON.stringify(withNews));
  ok('FPL news is attributed to FPL', withNews[0].source === SOURCE.FPL);

  ok('every note names a source',
    withNews.every((n) => Object.values(SOURCE).includes(n.source)));

  /* The gap that made Konsa project like a starter on zero minutes. */
  const unplayed = notesFor({ ...base, minutes: 0 }, { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 });
  ok('a player who has not appeared this season is called out',
    unplayed.some((n) => /not played a minute/.test(n.text)));
  ok('that call-out is labelled as the model’s inference, not FPL’s',
    unplayed.find((n) => /not played a minute/.test(n.text)).source === SOURCE.MODEL);
  /* The Draft board sets `minutes` to last season's total, so the check has to
     read seasonMinutes there or it never fires. */
  const draftShaped = notesFor({ ...base, minutes: 3000, seasonMinutes: 0 },
    { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 });
  ok('the same call-out works on a Draft row, where `minutes` is last season',
    draftShaped.some((n) => /not played a minute/.test(n.text)));

  /* An injured player is already explained by FPL; adding a rotation guess on
     top would be the model talking over the source. */
  ok('a flagged player does not also get a minutes guess',
    !notesFor({ ...base, news, parts: { expMins: 20, observedMpg: 20 } }, { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 })
      .some((n) => /rotation risk/.test(n.text)));

  /* --- the rotation note reads football, not the shrunk projection ---
     `expMins` is pulled toward the positional prior until 450 minutes exist,
     so two gameweeks in a full-time starter still reads about 42. Keying the
     rotation note off it fired on 14 of 15 real players, Haaland and Fernandes
     included. The note has to read minutes actually played. */
  const nailed = { ...base, minutes: 90, seasonMinutes: 90, parts: { expMins: 42, observedMpg: 90 } };
  ok('a player who has played every minute is never called a rotation risk',
    !notesFor(nailed, { fixtures: [fx(1, 1, 2)], teams: teamMap, fromEvent: 1, horizon: 1 })
      .some((n) => /rotation risk/.test(n.text)),
    JSON.stringify(notesFor(nailed, { fixtures: [fx(1, 1, 2)], teams: teamMap, fromEvent: 1, horizon: 1 })));
  const rotated = { ...base, minutes: 25, seasonMinutes: 25, parts: { expMins: 27, observedMpg: 25 } };
  ok('a player who is actually being rotated is called out',
    notesFor(rotated, { fixtures: [fx(1, 1, 2)], teams: teamMap, fromEvent: 1, horizon: 1 })
      .some((n) => /rotation risk/.test(n.text)));
  ok('the rotation note quotes the minutes it measured',
    /25 minutes/.test(notesFor(rotated, { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 1 })
      .find((n) => /rotation risk/.test(n.text)).text));
  /* The failure mode this replaced: a note that fires on everybody. */
  ok('the rotation note does not fire across a whole squad of starters', (() => {
    const squad = Array.from({ length: 15 }, (_, i) => ({
      ...base, id: i + 1, minutes: 90, seasonMinutes: 90,
      parts: { expMins: 42, observedMpg: 90 },
    }));
    const firing = squad.filter((p) => notesFor(p, { fixtures: [fx(1, 1, 2)], teams: teamMap, fromEvent: 1, horizon: 1 })
      .some((n) => /rotation risk/.test(n.text)));
    return firing.length === 0;
  })());

  /* Fixture phrasing only speaks up when a run stands out. */
  const easy = [fx(1, 1, 2, 2, 4), fx(2, 1, 3, 2, 4), fx(3, 1, 2, 2, 4)];
  ok('a kind run is described', fixturePhrase(base, easy, teamMap, 1, 3)?.tone === 'good');
  const hard = [fx(1, 1, 2, 5, 2), fx(2, 1, 3, 4, 2), fx(3, 1, 2, 5, 2)];
  ok('a hard run is described', fixturePhrase(base, hard, teamMap, 1, 3)?.tone === 'bad');
  const flat = [fx(1, 1, 2, 3, 3), fx(2, 1, 3, 3, 3), fx(3, 1, 2, 3, 3)];
  ok('an unremarkable run says nothing', fixturePhrase(base, flat, teamMap, 1, 3) === null);

  /* Justification quotes the real gain rather than asserting superiority. */
  const outP = { ...base, web_name: 'Out', proj: 4 };
  const inP = { ...base, id: 2, web_name: 'In', proj: 8 };
  const why = justifyMove(outP, inP, { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 });
  ok('a justification cites the projection gap', /\+4\.0 over 5 gameweeks/.test(why), why);
  ok('a justification is a sentence', /^[A-Z].*\.$/.test(why), why);
  ok('a justification never claims more than it has',
    justifyMove(outP, { ...inP, proj: 4.01 }, { fixtures: [], teams: teamMap, fromEvent: 1, horizon: 5 })
      .includes('nothing else separates them'));
}

/* ------------------------------------------------------------------ *
 * gameweek archive
 * ------------------------------------------------------------------ *
 * The squad view can step back through finished gameweeks and show what each
 * player was PROJECTED to score against what he actually scored. That only
 * means anything if the projection was captured before the deadline — FPL
 * wipes and refills the season totals at that moment, so a projection
 * recomputed afterwards is a different quantity wearing the same name.
 */
console.log('\nGameweek archive');
{
  const dir = 'data/history/gw';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  ok('at least one gameweek is archived', files.length > 0, `${files.length} files`);

  const archives = files.map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')));
  ok('every archive names its gameweek and deadline',
    archives.every((g) => Number.isFinite(g.event) && typeof g.deadline === 'string'));

  /* Keyed by `code`, and the file says so. The live endpoint returns CLASSIC
     element ids, and Draft disagrees with classic on ids for 21 of 587 players
     — reading this by id from a Draft page would show 21 players another
     player's score, silently. `code` is stable across both games. */
  ok('every archive declares it is keyed by code',
    archives.every((g) => g.keyedBy === 'code'), archives.map((g) => g.keyedBy).join(','));
  if (boot?.elements?.length) {
    const codes = new Set(boot.elements.map((e) => e.code));
    const ids = new Set(boot.elements.map((e) => e.id));
    for (const g of archives.filter((x) => x.actual)) {
      const keys = Object.keys(g.actual).map(Number);
      ok(`GW${g.event} keys are codes, not element ids`,
        keys.filter((k) => codes.has(k)).length > keys.length * 0.95
        && keys.filter((k) => ids.has(k)).length < keys.length * 0.5,
        `${keys.filter((k) => codes.has(k)).length} match codes, ${keys.filter((k) => ids.has(k)).length} match ids`);
    }
  }
  ok('no archive is written for a gameweek that has not happened',
    archives.every((g) => g.projected || g.actual));

  /* The point of the whole file: both halves, keyed the same way. */
  const withBoth = archives.filter((g) => g.projected && g.actual);
  ok('a completed gameweek carries projected AND actual', withBoth.length > 0,
    `${withBoth.length} of ${archives.length}`);
  for (const g of withBoth) {
    const acts = Object.values(g.actual);
    ok(`GW${g.event} actuals are [points, minutes, bonus, bps]`,
      acts.every((a) => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite)));
    ok(`GW${g.event} projections are finite and non-negative`,
      Object.values(g.projected).every((v) => Number.isFinite(v) && v >= 0));
    /* A projection nobody can be compared against is useless, so most of the
       league should appear in both halves. */
    const overlap = Object.keys(g.projected).filter((id) => g.actual[id]).length;
    ok(`GW${g.event} projections and actuals overlap`, overlap > 400,
      `${overlap} players in both`);
    /* Anything reconstructed after the fact says so. */
    if (g.projectedFrom) {
      ok(`GW${g.event} records where a recovered projection came from`,
        /^git:[0-9a-f]{7,}/.test(g.projectedFrom), g.projectedFrom);
    }
  }

  /* Stays cheap: the archive exists instead of keeping 38 copies of live.json.
     The bar moved from 40KB to 96KB when schema 2 began storing pre-deadline
     availability and model diagnostics for all 610 players — about 62KB a
     gameweek, ~2.3MB across a season. That is a deliberate trade, not drift:
     the alternative is being unable to estimate P(start | available) at all,
     because no historical source distinguishes injured from benched. For
     comparison the pipeline already rewrites a 112KB data/live.json every
     thirty minutes, and data/draft/ alone is 1.6MB. */
  const bytes = files.reduce((t, f) => t + fs.statSync(`${dir}/${f}`).size, 0);
  ok('the archive stays small', bytes / files.length < 96 * 1024,
    `${(bytes / files.length / 1024).toFixed(1)}KB average`);
}

/* ------------------------------------------------------------------ *
 * navigation shell
 * ------------------------------------------------------------------ *
 * Classic and Draft are separate products sharing one shell. These checks are
 * about that boundary holding: a page belongs to exactly one product, its
 * navigation offers only that product's pages, and the two never appear in one
 * list. They read the GENERATED html rather than the generator, because the
 * generator being right and the files being stale is a real failure mode —
 * scripts/build-pages.mjs has to be re-run and nothing else enforces that.
 */
console.log('\nNavigation shell');
{
  /* Visible = in the product's secondary nav. Hidden = reachable by URL only.
     The split is the point of the simplified IA: Squad absorbed the Dashboard,
     Players absorbed Market, Draft Players absorbed Waivers — and none of the
     absorbed pages was deleted, so each must still build and still carry its
     product's navigation while appearing in nobody's list. */
  const CLASSIC = ['index', 'transfers', 'players'];
  const DRAFT = ['draft-dashboard', 'draft-league', 'draft-players', 'draft'];
  const HIDDEN = ['squad', 'market', 'rules', 'draft-squad', 'draft-waivers'];
  const html = {};
  for (const slug of [...CLASSIC, ...DRAFT, ...HIDDEN]) {
    html[slug] = fs.existsSync(`${slug}.html`) ? fs.readFileSync(`${slug}.html`, 'utf8') : null;
  }
  ok('every page in both products exists as a file',
    [...CLASSIC, ...DRAFT].every((s2) => html[s2]),
    [...CLASSIC, ...DRAFT].filter((s2) => !html[s2]).join(', '));
  ok('no consolidated page was deleted — all still build',
    HIDDEN.every((s2) => html[s2]), HIDDEN.filter((s2) => !html[s2]).join(', '));
  ok('each product shows at most four pages',
    CLASSIC.length <= 4 && DRAFT.length <= 4, `${CLASSIC.length} / ${DRAFT.length}`);

  const between = (src, open, close) => {
    const i = src.indexOf(open);
    if (i < 0) return '';
    return src.slice(i, src.indexOf(close, i));
  };
  const productNav = (src) => between(src, '<nav class="productnav"', '</nav>');
  const pageNav = (src) => between(src, '<nav class="pagenav"', '</nav>');
  const hrefs = (frag) => [...frag.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace('.html', ''));
  const activeHref = (frag) => (frag.match(/href="([^"]+)"[^>]*class="active"/) || [])[1]?.replace('.html', '');

  for (const [product, own, other] of [['classic', CLASSIC, DRAFT], ['draft', DRAFT, CLASSIC]]) {
    for (const slug of own) {
      const src = html[slug];
      if (!src) continue;
      ok(`${slug}.html declares itself ${product}`,
        src.includes(`data-product="${product}"`));
      /* The primary switcher offers both products and marks this one. */
      ok(`${slug}.html marks ${product} active in the product switcher`,
        activeHref(productNav(src)) === (product === 'classic' ? 'index' : 'draft-dashboard'),
        activeHref(productNav(src)));
      /* The secondary nav is the crux: it must not mention the other product. */
      const pages = hrefs(pageNav(src));
      ok(`${slug}.html lists only ${product} pages`,
        pages.every((h) => own.includes(h)) && !pages.some((h) => other.includes(h)),
        pages.join(' '));
      ok(`${slug}.html marks itself the current page`,
        activeHref(pageNav(src)) === slug, `${activeHref(pageNav(src))}`);
    }
  }

  /* Product switching lands on the other product's dashboard, never on a
     guessed equivalent — Classic Transfers and Draft Waivers are different
     activities and pretending otherwise makes the switch unpredictable. */
  ok('a Classic page switches to the Draft dashboard',
    hrefs(productNav(html.index)).includes('draft-dashboard'));
  ok('a Draft page switches to the Classic dashboard',
    hrefs(productNav(html['draft-dashboard'])).includes('index'));

  /* Draft Night is a sub-mode of Draft, never a third product. */
  ok('Draft Night appears in the Draft navigation',
    hrefs(pageNav(html['draft-dashboard'])).includes('draft'));
  ok('Draft Night never appears in the product switcher',
    [...CLASSIC, ...DRAFT].every((s2) => !hrefs(productNav(html[s2] || '')).includes('draft')));
  ok('Draft Night never appears in Classic navigation',
    CLASSIC.every((s2) => !hrefs(pageNav(html[s2])).includes('draft')));

  /* Hidden pages are reachable by URL and absent from every navigation. */
  for (const h of HIDDEN) {
    ok(`${h}.html appears in no navigation`,
      [...CLASSIC, ...DRAFT].every((s2) => !hrefs(pageNav(html[s2])).includes(h)
        && !hrefs(productNav(html[s2])).includes(h)));
    ok(`${h}.html still carries its product's navigation`,
      hrefs(pageNav(html[h])).length > 0, 'no secondary nav rendered');
  }

  /* Every link a reader can click resolves to a file that exists. */
  const dangling = [];
  for (const slug of [...CLASSIC, ...DRAFT]) {
    for (const h of [...hrefs(productNav(html[slug])), ...hrefs(pageNav(html[slug]))]) {
      if (!fs.existsSync(`${h}.html`)) dangling.push(`${slug} -> ${h}`);
    }
  }
  ok('no navigation link is dangling', dangling.length === 0, dangling.join(', '));

  /* The mixed-mode tab strip and its state key are gone. */
  ok('the old Classic/Draft tab strip is gone',
    !fs.readFileSync('js/pages/dashboard.js', 'utf8').includes('modetabs'));
  ok('the redundant dashboardMode key is no longer read or written',
    !/localStorage\.[gs]etItem\(\s*'dashboardMode'/.test(fs.readFileSync('js/pages/dashboard.js', 'utf8')));

  /* The two rating pickers stay different on purpose — the models behave
     differently at one gameweek, so matching the lists would be a regression
     dressed as consistency. */
  ok('Classic and Draft offer different rating windows',
    JSON.stringify(RATING_HORIZONS) !== JSON.stringify(DRAFT_RATING_HORIZONS),
    `${RATING_HORIZONS} vs ${DRAFT_RATING_HORIZONS}`);
  ok('only Draft offers a one-gameweek rating window',
    DRAFT_RATING_HORIZONS.includes(1) && !RATING_HORIZONS.includes(1));
}

/* ------------------------------------------------------------------ *
 * fixture-window semantics
 * ------------------------------------------------------------------ *
 * FPL's flags do not mean what their names suggest. `finished` stays false
 * until a confirmation pass the morning after the gameweek's last match, and
 * `is_next` flips to the following gameweek the moment the deadline passes.
 * Both bit this project; see the table in CLAUDE.md.
 */
console.log('\nFixture window');
{
  const mk = (over) => ({ event: 1, team_h: 1, team_a: 2, team_h_difficulty: 3,
    team_a_difficulty: 3, started: false, finished: false, finished_provisional: false, ...over });

  const played = mk({ started: true, finished_provisional: true, finished: false });
  const toCome = mk({ team_h: 3, team_a: 4 });
  const up = upcomingByTeam([played, toCome], 1, 5);
  ok('a played match is not upcoming, despite finished:false', !up[1] && !up[2]);
  ok('an unplayed match in the same gameweek still is', !!up[3] && !!up[4]);

  // is_next has already moved on while gameweek 1 is half played
  const boot = {
    events: [{ id: 1, is_current: true }, { id: 2, is_next: true }],
    elements: [], teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  };
  const ctx = buildContext(boot, [played, toCome], { horizon: 5 });
  ok('the window starts at the earliest gameweek still to be played, not is_next',
    ctx.fromEvent === 1, `got ${ctx.fromEvent} (is_next is 2)`);
  ok('a club with a match still to come keeps it', (ctx.upcoming[3] || []).length === 1);
  ok('a club that has already played does not get it twice', !(ctx.upcoming[1] || []).length);

  // and once everything in the gameweek is played, the window moves on
  const allPlayed = buildContext(boot,
    [played, mk({ team_h: 3, team_a: 4, started: true, finished_provisional: true }), mk({ event: 2, team_h: 1, team_a: 3 })],
    { horizon: 5 });
  ok('once the gameweek is done the window advances', allPlayed.fromEvent === 2, `got ${allPlayed.fromEvent}`);
}

/* Team defence must qualify clubs on evidence actually observed. modelMinutes
 * is rebuilt onto a pooled basis and clears any raw threshold on one match. */
console.log('\nTeam defence eligibility');
{
  const def = (id, over) => ({ id, element_type: 2, team: 1, expected_goals_conceded_per_90: 0.5, ...over });
  // three defenders who look like regulars but have played once
  const thin = [1, 2, 3].map((i) => def(i, { minutes: 90, modelMinutes: 1800, evidenceMinutes: 90 }));
  const teams = [{ id: 1, strength_overall_home: 2, strength_overall_away: 2 }];
  const d1 = teamDefence(thin, teams);
  ok('one match does not qualify a club, however inflated its modelMinutes',
    d1[1] > 0.5 + 1e-9, `got ${d1[1].toFixed(2)} — should fall back to the strength rating`);

  const solid = [1, 2, 3].map((i) => def(i, { minutes: 900, modelMinutes: 1800, evidenceMinutes: 1800 }));
  const d2 = teamDefence(solid, teams);
  ok('a club with real evidence is rated from its own numbers', near(d2[1], 0.5, 1e-9), `got ${d2[1]}`);
}


/* ------------------------------------------------------------------ *
 * defensive contribution — threshold, not rate
 * ------------------------------------------------------------------ */
console.log('\nDefensive contribution');
{
  const mk = (over) => ({ id: 1, code: 1, element_type: 2, team: 1, now_cost: 50, status: 'a',
    chance_of_playing_next_round: null, minutes: 1800, modelMinutes: 1800, evidenceMinutes: 1800,
    bps: 0, yellow_cards: 0, saves: 0, expected_goals_per_90: 0, expected_assists_per_90: 0,
    expected_goals_conceded_per_90: 1.2, saves_per_90: 0, defensive_contribution_per_90: 0,
    clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0, ...over });
  const ctx = { games: 20, defence: { 1: 1.2 }, teams: { 1: {} } };
  const fx = { event: 2, opponent: 2, home: true, difficulty: 3 };
  const dc = (over) => projectFixture(mk(over), fx, ctx, { riskAversion: 0 }).parts.defcon;

  ok('a forward who barely defends scores no defensive contribution',
    dc({ element_type: 4, defensive_contribution_per_90: 3.17 }) < 0.01,
    `${dc({ element_type: 4, defensive_contribution_per_90: 3.17 }).toFixed(3)}`);
  ok('a defender at the threshold scores about half of it',
    Math.abs(dc({ defensive_contribution_per_90: 10 }) - 1) < 0.25,
    `${dc({ defensive_contribution_per_90: 10 }).toFixed(2)}`);
  ok('defensive contribution never exceeds the two points on offer',
    dc({ defensive_contribution_per_90: 40 }) <= DEFCON_PTS + 1e-9);
  ok('it is never negative', dc({ defensive_contribution_per_90: 0.1 }) >= 0);
  ok('more actions is always worth at least as much',
    dc({ defensive_contribution_per_90: 12 }) > dc({ defensive_contribution_per_90: 8 }));
  ok('the defender threshold is easier than the midfielder one',
    dc({ element_type: 2, defensive_contribution_per_90: 10 })
      > dc({ element_type: 3, defensive_contribution_per_90: 10 }),
    'DEF needs 10, MID needs 12');
  ok('a keeper is ineligible', dc({ element_type: 1, defensive_contribution_per_90: 12 }) === 0);
  ok('fewer minutes means fewer actions and a lower chance of the threshold',
    dc({ defensive_contribution_per_90: 10, modelMinutes: 900 })
      < dc({ defensive_contribution_per_90: 10, modelMinutes: 1800 }));
  // The old bug: rates run 3-16, so clamping into [0,1] gave everyone the max.
  ok('two very different defenders no longer score identically',
    Math.abs(dc({ defensive_contribution_per_90: 4 }) - dc({ defensive_contribution_per_90: 11 })) > 0.5);
}

/* ------------------------------------------------------------------ *
 * the actionable horizon
 * ------------------------------------------------------------------ *
 * A transfer made after a deadline cannot score from that gameweek, however
 * many of its fixtures are still to be played.
 */
console.log('\nActionable horizon');
{
  const ev = (id, iso) => ({ id, deadline_time: iso });
  const events = [ev(1, '2026-08-21T17:30:00Z'), ev(2, '2026-08-28T17:30:00Z'), ev(3, '2026-09-12T17:30:00Z')];

  ok('before the deadline, the current gameweek is still actionable',
    actionableEvent(events, Date.parse('2026-08-21T12:00:00Z')) === 1);
  ok('after the deadline, it is locked and the next one is actionable',
    actionableEvent(events, Date.parse('2026-08-21T18:00:00Z')) === 2);
  ok('a team that has not kicked off yet does not reopen a locked gameweek',
    actionableEvent(events, Date.parse('2026-08-23T10:00:00Z')) === 2);
  ok('exactly on the deadline counts as locked',
    actionableEvent(events, Date.parse('2026-08-21T17:30:00Z')) === 2);
  ok('with no deadlines left it reports nothing rather than guessing',
    actionableEvent(events, Date.parse('2027-06-01T00:00:00Z')) === null);
  ok('missing or malformed deadlines are skipped, not crashed on',
    actionableEvent([{ id: 1 }, { id: 2, deadline_time: 'nonsense' }, ev(3, '2026-09-12T17:30:00Z')],
      Date.parse('2026-08-23T10:00:00Z')) === 3);

  /* Blanks and doubles are a property of the gameweek, not of the window. The
     window decides where to start; it must never flatten them. */
  const f = (id, event, h, a, over = {}) => ({ id, event, team_h: h, team_a: a,
    team_h_difficulty: 3, team_a_difficulty: 3, started: false, finished: false,
    finished_provisional: false, ...over });
  const sched = [
    f(1, 2, 1, 2), f(2, 2, 3, 4),          // gw2 normal
    f(3, 3, 1, 3), f(4, 3, 1, 4),          // gw3 DOUBLE for team 1, BLANK for team 2
    f(5, 4, 2, 3),                          // gw4: team 4 blank
    f(6, 1, 1, 2, { started: true, finished_provisional: true }), // gw1 already played
  ];
  const up = upcomingByTeam(sched, 2, 3);
  ok('a double gameweek gives that team two fixtures', (up[1] || []).filter((x) => x.event === 3).length === 2);
  ok('a blank gameweek gives that team none', !(up[2] || []).some((x) => x.event === 3));
  ok('the totals reflect the real fixture counts, not a normalised one',
    (up[1] || []).length === 3 && (up[2] || []).length === 2,
    `team1 ${(up[1] || []).length}, team2 ${(up[2] || []).length}`);
  ok('a locked gameweek contributes nothing even when starting there',
    !upcomingByTeam(sched, 1, 3)[1]?.some((x) => x.event === 1));
  ok('a postponed fixture with no event is ignored',
    upcomingByTeam([...sched, f(7, null, 1, 2)], 2, 3)[1].length === 3);
}

/* ------------------------------------------------------------------ *
 * the breakdown adds up
 * ------------------------------------------------------------------ */
console.log('\nHorizon component sum');
{
  const KEYS = ['appearance', 'attack', 'cleanSheet', 'conceded', 'saves', 'defcon', 'bonus', 'cards', 'prior'];
  const boot = await readJSON('data/bootstrap.json');
  const fixtures = await readJSON('data/fixtures.json', []);
  if (boot?.elements?.length) {
    for (const horizon of [1, 3, 5, 8]) {
      const { rows } = projectAll(boot, fixtures, { horizon, riskAversion: 0.5 });
      const worst = rows.reduce((m, r) => {
        const s = KEYS.reduce((a, k) => a + (r.parts?.[k] || 0), 0);
        return Math.max(m, Math.abs(s - r.proj));
      }, 0);
      ok(`the components sum to the projection over ${horizon} gameweeks`,
        worst < 1e-6, `largest deviation ${worst.toExponential(2)}`);
    }
    const { rows } = projectAll(boot, fixtures, { horizon: 5 });
    const played = rows.find((r) => r.parts?.fixtures > 0);
    ok('the breakdown reports how many fixtures it covers', played.parts.fixtures > 0);
    ok('per-match context is averaged, not summed', played.parts.expMins <= 90);
  }
}


/* ------------------------------------------------------------------ *
 * Classic squad rating
 * ------------------------------------------------------------------ */
console.log('\nClassic squad rating');
{
  let uid = 1000;
  const mk = (type, proj, cost, over = {}) => ({
    id: uid++, code: uid, element_type: type, team: (uid % 12) + 1, now_cost: cost,
    web_name: `p${uid}`, status: 'a', chance_of_playing_next_round: null, proj,
    selected_by_percent: '1.0',
    parts: { availability: 1, expMins: 90, evidence: 1, isPrior: false, fixtures: 5 },
    ...over,
  });
  // 2/5/5/3, all distinct clubs enough to stay legal
  const build = (projs) => {
    const sq = [];
    const quota = { 1: 2, 2: 5, 3: 5, 4: 3 };
    let i = 0;
    for (const t of [1, 2, 3, 4]) for (let n = 0; n < quota[t]; n++) sq.push(mk(t, projs[i], 50, { team: (i++ % 15) + 1 }));
    return sq;
  };
  const flat = build(Array(15).fill(10));

  /* legal XI */
  const xi = bestXI(flat);
  ok('the rating rates a legal eleven', xi.xi.length === 11);
  ok('exactly one keeper starts', xi.xi.filter((p) => p.element_type === 1).length === 1);
  ok('the formation obeys the minimums',
    xi.xi.filter((p) => p.element_type === 2).length >= 3
    && xi.xi.filter((p) => p.element_type === 3).length >= 2
    && xi.xi.filter((p) => p.element_type === 4).length >= 1);
  ok('the bench is the other four', xi.bench.length === 4);
  ok('the reserve keeper is benched, never started',
    xi.bench.some((p) => p.element_type === 1));

  /* captaincy */
  const withStar = build([6, 4, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 30, 9, 9]);
  const starXI = bestXI(withStar);
  ok('the captain is the highest projected starter',
    starXI.captain.proj === Math.max(...starXI.xi.map((p) => p.proj)));
  ok('the vice is not the captain', starXI.vice.id !== starXI.captain.id);
  ok('captaincy scores higher when the squad owns a standout',
    rateSquad(withStar, { pool: withStar }).dims.captaincy
      >= rateSquad(flat, { pool: flat }).dims.captaincy);

  /* positional benchmark */
  const pool = [
    ...Array.from({ length: 8 }, (_, i) => mk(2, 20 - i, 50)),
    ...Array.from({ length: 8 }, (_, i) => mk(2, 5 - i * 0.1, 40)),
  ];
  ok('the line benchmark is exact, never beaten by the squad it judges',
    bestLineTotal(pool, 2, 2, 100) >= 20 + 19 - 1e-9,
    `${bestLineTotal(pool, 2, 2, 100)}`);
  ok('the line benchmark respects the money available',
    bestLineTotal(pool, 2, 2, 80) < bestLineTotal(pool, 2, 2, 100));
  ok('a line with nothing to spend benchmarks at nothing', bestLineTotal(pool, 2, 2, 0) === 0);
  ok('scoreRatio floors at zero and caps at a hundred',
    scoreRatio(1, 100) === 0 && scoreRatio(100, 100) === 100);

  /* depth is measured, not asserted */
  const strongBench = build([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  const weakBench = build([10, 1, 10, 10, 10, 10, 1, 10, 10, 10, 10, 1, 10, 10, 1]);
  ok('depth is measured by rebuilding the eleven, not by counting the bench',
    depthCost(strongBench).perAbsence < depthCost(weakBench).perAbsence,
    `${depthCost(strongBench).perAbsence.toFixed(2)} vs ${depthCost(weakBench).perAbsence.toFixed(2)}`);
  ok('depth names the costliest absence', depthCost(weakBench).worst?.player != null);
  ok('an incomplete squad reports depth as unmeasurable', depthCost(flat.slice(0, 9)).measurable === false);

  /* an expensive bench must not buy a good rating */
  const benchHeavy = build([10, 10, 12, 12, 12, 4, 4, 12, 12, 12, 4, 4, 12, 12, 4]);
  const benchHeavyPriced = benchHeavy.map((p) => (p.proj === 4 ? { ...p, now_cost: 100 } : p));
  const cheapBench = benchHeavy.map((p) => (p.proj === 4 ? { ...p, now_cost: 40 } : p));
  const rb = rateSquad(benchHeavyPriced, { pool: benchHeavyPriced, bank: 0 });
  const rc = rateSquad(cheapBench, { pool: cheapBench, bank: 0 });
  ok('money parked on the bench lowers flexibility rather than raising the rating',
    rb.dims.flexibility <= rc.dims.flexibility,
    `${rb.dims.flexibility} vs ${rc.dims.flexibility}`);
  ok('a strong bench never outweighs the starting eleven in the headline',
    RATING_WEIGHTS.xi + RATING_WEIGHTS.captaincy > RATING_WEIGHTS.depth + RATING_WEIGHTS.flexibility);

  /* risk moves the rating */
  const fit = build(Array(15).fill(10));
  const doubtful = fit.map((p, i) => (i < 3
    ? { ...p, status: 'd', parts: { ...p.parts, availability: 0.25, expMins: 30 } } : p));
  ok('a squad with doubtful starters rates lower on minutes security',
    minutesSecurity(doubtful).score < minutesSecurity(fit).score,
    `${minutesSecurity(doubtful).score.toFixed(1)} vs ${minutesSecurity(fit).score.toFixed(1)}`);
  ok('minutes security names its weakest link', minutesSecurity(doubtful).weakest?.player != null);
  ok('a prior-heavy projection counts as less secure than an evidenced one',
    minutesSecurity(fit.map((p) => ({ ...p, parts: { ...p.parts, evidence: 0 } }))).score
      < minutesSecurity(fit).score);
  ok('risk reaches the headline rating',
    rateSquad(doubtful, { pool: doubtful }).overall < rateSquad(fit, { pool: fit }).overall);

  /* determinism */
  const a = rateSquad(flat, { pool: flat, bank: 5, freeTransfers: 2 });
  const b = rateSquad(flat, { pool: flat, bank: 5, freeTransfers: 2 });
  ok('the rating is deterministic', JSON.stringify(a.dims) === JSON.stringify(b.dims));
  ok('a squad of the wrong size is refused, not rated', !!rateSquad(flat.slice(0, 14), { pool: flat }).error);
  ok('every dimension lands between 0 and 100',
    Object.values(a.dims).every((v) => v >= 0 && v <= 100 && Number.isFinite(v)));

  /* quality and outlook must be able to disagree */
  const real = await readJSON('data/bootstrap.json');
  const fxs = await readJSON('data/fixtures.json', []);
  if (real?.elements?.length) {
    const short = projectAll(real, fxs, { horizon: 5, riskAversion: 0.5 }).rows;
    const long = projectAll(real, fxs, { horizon: 8, riskAversion: 0.5 }).rows;
    const pick = (rows) => {
      const out = []; const q = { 1: 2, 2: 5, 3: 5, 4: 3 }; const clubs = {};
      for (const t of [1, 2, 3, 4]) {
        for (const p of rows.filter((r) => r.element_type === t).sort((x, y) => y.proj - x.proj)) {
          if (out.filter((o) => o.element_type === t).length >= q[t]) break;
          if ((clubs[p.team] || 0) >= 3) continue;
          clubs[p.team] = (clubs[p.team] || 0) + 1; out.push(p);
        }
      }
      return out;
    };
    const sq5 = pick(short);
    const ids = new Set(sq5.map((p) => p.id));
    const sq8 = long.filter((r) => ids.has(r.id));
    if (sq5.length === 15 && sq8.length === 15) {
      const outlook = rateSquad(sq5, { pool: short });
      const quality = rateSquad(sq8, { pool: long });
      ok('outlook and underlying quality are computed separately',
        Number.isFinite(outlook.overall) && Number.isFinite(quality.overall));
      ok('both headline scores stay in range',
        outlook.overall >= 0 && outlook.overall <= 100 && quality.overall >= 0 && quality.overall <= 100);
      ok('the rating names a strongest and a weakest dimension from its own numbers',
        !!outlook.strongest.label && !!outlook.weakest.label
        && outlook.dims[outlook.strongest.key] >= outlook.dims[outlook.weakest.key]);
    }
  }

  /* Classic and Draft stay apart */
  const ratingSrc = fs.readFileSync('js/rating.js', 'utf8');
  // Import statements only — the file discusses Draft in prose, deliberately,
  // to record why Classic does not reuse its rating.
  const imports = [...ratingSrc.matchAll(/^import[^;]+from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok('the Classic rating imports nothing from Draft',
    imports.every((i) => !i.includes('draft')), imports.join(', '));
  ok('the Classic rating does not read Draft config or league size',
    !/DRAFT_CONFIG|draftPrior|leagueSize|replacementBasis/.test(ratingSrc));
  ok('no Draft module imports the Classic rating', (() => {
    const files = fs.readdirSync('js/draft').filter((f) => f.endsWith('.js'));
    return files.every((f) => !/from\s+['"][^'"]*\/rating\.js['"]/.test(fs.readFileSync(`js/draft/${f}`, 'utf8'))
      || !fs.readFileSync(`js/draft/${f}`, 'utf8').includes("'../rating.js'"));
  })());
}

/* ------------------------------------------------------------------ *
 * Classic rating horizons
 * ------------------------------------------------------------------ *
 * The Dashboard's rating picker re-rates the squad over each offered window.
 * Classic offers fewer windows than Draft, and the gap is the point.
 */
console.log('\nClassic rating horizons');
{
  ok('the one-gameweek window is not offered',
    !RATING_HORIZONS.includes(1), RATING_HORIZONS.join(','));
  ok('the widest window is the whole season',
    RATING_HORIZONS[RATING_HORIZONS.length - 1] === 38);
  ok('the offered windows are ascending and distinct',
    RATING_HORIZONS.every((h, i) => i === 0 || h > RATING_HORIZONS[i - 1]));

  /* Why 1 is absent: RATING_FLOOR is calibrated against multi-week windows, so
     a one-gameweek benchmark is whichever legal squad drew the softest single
     fixture. Measured on a real 15 in August 2026 the XI dimension clamped to
     0 and the headline read 30, against 69 over five gameweeks — a scare, not
     a measurement. The floor itself is what would have to move. */
  ok('the floor that rules out a one-gameweek window is still where it was measured',
    RATING_FLOOR === 0.60);

  if (boot?.elements?.length) {
    const at = (h) => projectAll(boot, fixtures, { horizon: h }).rows;
    const built = optimiseSquad(at(5), { budget: 1000 });
    if (built?.squad?.length === 15) {
      const ids = new Set(built.squad.map((p) => p.id));
      for (const h of RATING_HORIZONS) {
        const rows = at(h);
        const mine = rows.filter((r) => ids.has(r.id));
        const rated = mine.length === 15
          ? rateSquad(mine, { pool: rows, bank: 0, freeTransfers: 1 })
          : null;
        ok(`the squad rates over ${h === 38 ? 'the whole season' : `${h} GW`}`,
          !!rated && !rated.error && Number.isFinite(rated.overall)
          && rated.overall >= 0 && rated.overall <= 100
          && Object.values(rated.dims).every((v) => Number.isFinite(v)),
          rated?.error || `overall ${rated?.overall}`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * the season boundary
 * ------------------------------------------------------------------ *
 * Performance data older than 2025/26 may not reach a projection. Enforced at
 * ingestion rather than remembered downstream, so these tests push old seasons
 * at every door and prove each one is shut.
 */
console.log('\nSeason boundary');
{
  ok('the window is exactly the current season and the one before',
    ALLOWED_MODEL_SEASONS.length === 2 && ALLOWED_MODEL_SEASONS.includes(CURRENT_SEASON)
    && ALLOWED_MODEL_SEASONS.includes(CURRENT_SEASON - 1));

  ok('2025/26 is allowed', isAllowedSeason(2025) && isAllowedSeason('2025/26') && isAllowedSeason('2025-26'));
  ok('2026/27 is allowed', isAllowedSeason(2026) && isAllowedSeason('2026/27'));
  ok('2024/25 is refused', !isAllowedSeason(2024) && !isAllowedSeason('2024/25'));
  ok('2023/24 is refused', !isAllowedSeason(2023) && !isAllowedSeason('2023/24'));
  ok('2019/20 is refused', !isAllowedSeason(2019));
  ok('nonsense is refused', !isAllowedSeason(null) && !isAllowedSeason('last year') && !isAllowedSeason(undefined));

  ok('a season label reduces to its starting year',
    seasonStartYear('2025/26') === 2025 && seasonStartYear('2025-2026') === 2025 && seasonStartYear(2025) === 2025);

  let threw = false;
  try { assertAllowedSeason(2024, 'test'); } catch { threw = true; }
  ok('the ingestion guard throws rather than dropping quietly', threw);
  ok('the guard passes a permitted season through', assertAllowedSeason('2025/26') === 2025);

  ok('a discovery list is filtered down to permitted seasons', (() => {
    const kept = onlyAllowedSeasons([{ season: 2019 }, { season: 2024 }, { season: 2025 }, { season: 2026 }]);
    return kept.length === 2 && kept.every((r) => r.season >= 2025);
  })());

  /* The pooling door: a prior labelled with a stale season must contribute
     nothing, not merely be weighted down. */
  const cur = { minutes: 90, expected_goals: 0.5, bps: 30 };
  const old = { minutes: 3000, expected_goals: 25, bps: 900 };
  const base = { gamesThis: 1, games: 20, lastSeasonWeight: 0.5, lastSeasonGames: 38 };
  const allowed = poolPlayerSeasons(cur, old, { ...base, priorSeason: 2025 });
  const refused = poolPlayerSeasons(cur, old, { ...base, priorSeason: 2024 });
  ok('a permitted prior is pooled', allowed.evidenceMinutes > 1000);
  ok('a stale prior contributes no evidence minutes', refused.evidenceMinutes === 90);
  ok('a stale prior contributes no production either',
    Math.abs(refused.expected_goals_per_90 - (0.5 / 90) * 90) < 1e-9,
    `${refused.expected_goals_per_90}`);
  /* Rejecting the prior leaves one game of 90 minutes, which really does read
     as a full-time role — the protection is not a smaller number but a much
     smaller sample behind it, which is what the model weighs. */
  ok('a stale prior leaves far less role evidence behind it',
    refused.minutesEvidenceMinutes < allowed.minutesEvidenceMinutes / 5,
    `${refused.minutesEvidenceMinutes} vs ${allowed.minutesEvidenceMinutes}`);
  ok('and that thin evidence pulls expected minutes toward the conservative prior', (() => {
    const ctxL = { games: 20, defence: { 1: 1.2 }, teams: { 1: {} } };
    const fxL = { event: 2, opponent: 2, home: true, difficulty: 3 };
    const row = (pooled) => projectFixture({ id: 1, code: 7, element_type: 3, team: 1, now_cost: 60,
      status: 'a', chance_of_playing_next_round: null, saves: 0, ...pooled }, fxL, ctxL, { riskAversion: 0 });
    return row(refused).parts.expMins < row(allowed).parts.expMins;
  })());

  /* hydrate() reads the label off the frozen file rather than assuming it. */
  const bootLike = { elements: [{ id: 1, code: 7, element_type: 3, team: 1, now_cost: 60, minutes: 90 }], teams: [{ id: 1 }] };
  const priorFile = { season: '2025/26', players: { 7: old } };
  ok('hydrate pools a prior inside the window',
    hydrate(bootLike, priorFile).elements[0].modelMinutes !== undefined);
  ok('hydrate refuses a prior outside the window, rather than blending it',
    hydrate(bootLike, { ...priorFile, season: '2024/25' }).elements[0].modelMinutes === undefined);
  ok('hydrate refuses an unlabelled prior', hydrate(bootLike, { players: priorFile.players }).elements[0].modelMinutes === undefined);

  /* ESPN evidence: discovery may see old seasons, ingestion may not keep them. */
  const espnRec = { seasons: [
    { season: 2025, competition: 'esp.1', minutes: 2000, appearances: 30, starts: 28, goals: 10, assists: 5 },
    { season: 2024, competition: 'esp.1', minutes: 3000, appearances: 38, starts: 38, goals: 25, assists: 10 },
  ] };
  const ev = espnEvidence(espnRec, 4);
  ok('ESPN evidence counts only the permitted season', ev.minutes === 2000, `${ev.minutes}`);
  ok('ESPN evidence ignores the older season entirely', ev.apps === 30 && ev.starts === 28);
  ok('an ESPN record with only stale seasons yields nothing',
    espnEvidence({ seasons: [{ season: 2024, minutes: 3000, appearances: 38, starts: 38 }] }, 4) === null);
  ok('an empty ESPN record yields nothing', espnEvidence({ seasons: [] }, 4) === null);

  /* And the committed cache itself must hold nothing older. */
  const cached = await readJSON('data/espn-history.json', null);
  if (cached?.players) {
    const seasons = [...new Set(Object.values(cached.players).flatMap((p) => (p.seasons || []).map((s) => s.season)))];
    ok('the committed ESPN cache contains no season outside the window',
      seasons.every((y) => isAllowedSeason(y)), `seasons present: ${seasons.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ *
 * production and opportunity are separate
 * ------------------------------------------------------------------ */
console.log('\nProduction vs opportunity');
{
  const mk = (over) => ({ id: 1, code: 1, element_type: 3, team: 1, now_cost: 65, status: 'a',
    chance_of_playing_next_round: null, bps: 0, yellow_cards: 0, saves: 0,
    expected_goals_per_90: 0.5, expected_assists_per_90: 0.3, expected_goals_conceded_per_90: 1.2,
    saves_per_90: 0, defensive_contribution_per_90: 6,
    clearances_blocks_interceptions: 0, tackles: 0, recoveries: 0, ...over });
  const ctx = { games: 20, defence: { 1: 1.2 }, teams: { 1: {} } };
  const fx = { event: 2, opponent: 2, home: true, difficulty: 3 };
  const proj = (over) => projectFixture(mk(over), fx, ctx, { riskAversion: 0 });

  /* The bug this replaces: with the prior applied per fixture, a player with
     less expected playing time scored MORE, because the modelled half shrank
     while the prior half did not. */
  const at = (mm) => proj({ modelMinutes: mm, evidenceMinutes: 0, minutesEvidenceMinutes: 2000 }).total;
  ok('a nailed starter outscores a rotation player on the same rate', at(1800) > at(900));
  ok('a rotation player outscores a fringe player', at(900) > at(450));
  ok('a fringe player outscores a player who barely features', at(450) > at(90));
  ok('nobody scores anything on zero expected minutes', at(0) === 0);
  ok('knowing less never raises the projection', (() => {
    let prev = -1;
    for (const mm of [0, 90, 450, 900, 1800]) { const v = at(mm); if (v < prev - 1e-9) return false; prev = v; }
    return true;
  })());

  /* Neither wrong answer for an unknown player. */
  const unknown = proj({ modelMinutes: 0, evidenceMinutes: 0, minutesEvidenceMinutes: 0 });
  ok('an unknown player is not assumed to play ninety minutes', unknown.parts.expMins < 70);
  ok('an unknown player is not assumed to play nothing', unknown.parts.expMins > 15);
  ok('an unknown player still projects something', unknown.total > 0);
  ok('an unknown player projects below an equivalent known starter',
    unknown.total < proj({ modelMinutes: 1800, evidenceMinutes: 1800, minutesEvidenceMinutes: 1800 }).total);

  /* The two confidences are independent. */
  const newSigning = proj({ modelMinutes: 1600, evidenceMinutes: 500, minutesEvidenceMinutes: 1700 });
  const veteran = proj({ modelMinutes: 1600, evidenceMinutes: 1800, minutesEvidenceMinutes: 1700 });
  ok('production confidence tracks production evidence',
    newSigning.parts.productionConfidence < veteran.parts.productionConfidence);
  ok('minutes confidence is unchanged by production evidence',
    Math.abs(newSigning.parts.minutesConfidence - veteran.parts.minutesConfidence) < 1e-9);
  const impactSub = proj({ modelMinutes: 600, evidenceMinutes: 1800, minutesEvidenceMinutes: 200 });
  ok('a thin ROLE sample lowers minutes confidence without touching production',
    impactSub.parts.minutesConfidence < veteran.parts.minutesConfidence
    && impactSub.parts.productionConfidence === veteran.parts.productionConfidence);

  /* Availability still suppresses everything, however good the prior. */
  const injured = proj({ modelMinutes: 1800, evidenceMinutes: 1800, minutesEvidenceMinutes: 1800, status: 'i' });
  ok('an unavailable player projects nothing however strong his history', injured.total === 0);
}

console.log(`\n${failures === 0 ? `✓ all ${checks} checks passed` : `✗ ${failures} of ${checks} checks failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
