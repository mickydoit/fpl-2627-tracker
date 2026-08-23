/**
 * Sanity checks for the model and optimiser. Run with `node scripts/test.mjs`
 * after `node scripts/make-sample.mjs`. The refresh workflow runs derive.mjs,
 * which asserts squad legality on real data; this file covers the maths.
 */
import { readJSON } from './lib/io.mjs';
import {
  projectAll, poissonAtLeast, availability, inferGamesPlayed,
  teamDefence, upcomingByTeam, SQUAD_RULES, projectFixture, buildContext,
  actionableEvent, DEFCON_THRESHOLD, DEFCON_PTS,
} from '../js/model.js';
import { adaptDraftElements, draftPrior } from '../js/draft/adapt.js';
import { snakePicks, replacementRank, buildBoard, assignTiers } from '../js/draft/board.js';
import { ownershipFrom, availableRows, deriveSlot, myRoster, positionsNeeded } from '../js/draft/live.js';
import { makeRng, picksBetween, survival } from '../js/draft/simulate.js';
import { recommend } from '../js/draft/advise.js';
import { runDraft, STRATEGIES } from '../js/draft/compete.js';
import { optimiseSquad, validate, bestXI, scoreSquad, suggestTransfers, canSwap, splitXI } from '../js/optimiser.js';
import { hydrate, PRIOR_DEFAULTS } from '../js/prior.js';

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

const withParts = rows.find((p) => p.parts && !p.parts.noFixtures && p.minutes > 1500);
ok('breakdown components exist', withParts && Number.isFinite(withParts.parts.attack));
ok('clean sheet probability is a probability', rows.every((p) => !p.parts?.pCS || (p.parts.pCS > 0 && p.parts.pCS < 1)));

console.log('\nHorizon behaviour');
const short = projectAll(boot, fixtures, { horizon: 1 }).rows;
const long = projectAll(boot, fixtures, { horizon: 8 }).rows;
const shortById = new Map(short.map((p) => [p.id, p]));
const longById = new Map(long.map((p) => [p.id, p]));
const sample = rows.filter((p) => p.proj > 5).slice(0, 50);
ok('a longer horizon projects more points', sample.every((p) => longById.get(p.id).proj >= shortById.get(p.id).proj - 1e-9));

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
  const priorOf = (over) => ({ players: { 100: { code: 100, minutes: 0, expected_goals: 0,
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
  const twoPrior = { players: {
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
  const sampleBoot = await readJSON('data/bootstrap.json');
  const sampleFx = await readJSON('data/fixtures.json', []);
  if (sampleBoot?.elements?.length) {
    const zeroed = { ...sampleBoot, elements: sampleBoot.elements.map((e) => ({
      ...e, minutes: 0, bps: 0, yellow_cards: 0, expected_goals: '0.0', expected_assists: '0.0',
      expected_goals_conceded: '0.0', saves: 0, defensive_contribution: 0,
      expected_goals_per_90: 0, expected_assists_per_90: 0, expected_goals_conceded_per_90: 0,
      saves_per_90: 0, defensive_contribution_per_90: 0,
    })) };
    const built = { players: Object.fromEntries(sampleBoot.elements.map((e) => [e.code, {
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

console.log(`\n${failures === 0 ? `✓ all ${checks} checks passed` : `✗ ${failures} of ${checks} checks failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
