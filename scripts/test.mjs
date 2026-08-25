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
  actionableEvent, DEFCON_THRESHOLD, DEFCON_PTS,
} from '../js/model.js';
import { adaptDraftElements, draftPrior } from '../js/draft/adapt.js';
import { RATING_HORIZONS as DRAFT_RATING_HORIZONS } from '../js/draft/config.js';
import { snakePicks, replacementRank, buildBoard, assignTiers } from '../js/draft/board.js';
import { ownershipFrom, availableRows, deriveSlot, myRoster, positionsNeeded } from '../js/draft/live.js';
import { makeRng, picksBetween, survival } from '../js/draft/simulate.js';
import { recommend } from '../js/draft/advise.js';
import { runDraft, STRATEGIES } from '../js/draft/compete.js';
import { optimiseSquad, validate, bestXI, scoreSquad, suggestTransfers, canSwap, splitXI,
  optimiseWithinTransfers } from '../js/optimiser.js';
import { hydrate, PRIOR_DEFAULTS, poolPlayerSeasons, espnEvidence } from '../js/prior.js';
import { ALLOWED_MODEL_SEASONS, CURRENT_SEASON, isAllowedSeason, seasonStartYear,
  assertAllowedSeason, onlyAllowedSeasons } from '../js/seasons.js';
import { rateSquad, depthCost, minutesSecurity, flexibility, bestLineTotal, scoreRatio,
  RATING_WEIGHTS, RATING_HORIZONS, RATING_FLOOR } from '../js/rating.js';

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
ok('injured players project 0', rows.filter((p) => p.status === 'i').every((p) => p.proj === 0));
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
ok('optimiser reaches a local optimum with no improving single transfer',
  !converged.singles.length || converged.singles[0].net <= 1e-6,
  `best ${converged.singles[0]?.net.toFixed(3)}`);
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

  // A swap that changes formation is legal while the minimums hold.
  const defsIn = base.filter((p) => p.element_type === 2).length;
  const midBench = onBench(3);
  const defOut = inXI(2);
  if (midBench && defOut) {
    ok('outfield swap allowed when minimums still hold',
      canSwap(defOut, midBench, base) === (defsIn - 1 >= MIN_DEF), `defs ${defsIn}`);
  }

  // Strip to exactly the minimum and the next removal must be refused.
  const threeDef = base.filter((p) => p.element_type === 2).slice(0, 3);
  const minXI = [inXI(1), ...threeDef, ...base.filter((p) => p.element_type === 3).slice(0, 1),
    ...base.filter((p) => p.element_type === 4).slice(0, 1)].filter(Boolean);
  if (minXI.filter((p) => p.element_type === 2).length === 3 && midBench) {
    ok('cannot drop below three defenders', !canSwap(threeDef[0], midBench, minXI));
  }
  const fwdInMin = minXI.find((p) => p.element_type === 4);
  if (fwdInMin && midBench && minXI.filter((p) => p.element_type === 4).length === 1) {
    ok('cannot drop the last forward', !canSwap(fwdInMin, midBench, minXI));
  }

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

  const games = inferGamesPlayed(h.elements);
  ok('inferGamesPlayed recovers the pooled basis', games === Math.round((1 + L * G)), `got ${games}`);
  ok('expected minutes come back to a full game',
    near(p.modelMinutes / games, 90, 0.5), `${(p.modelMinutes / games).toFixed(1)}`);
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

  /* Stays cheap: the archive exists instead of keeping 38 copies of live.json. */
  const bytes = files.reduce((t, f) => t + fs.statSync(`${dir}/${f}`).size, 0);
  ok('the archive stays small', bytes / files.length < 40 * 1024,
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
