/**
 * Sanity checks for the model and optimiser. Run with `node scripts/test.mjs`
 * after `node scripts/make-sample.mjs`. The refresh workflow runs derive.mjs,
 * which asserts squad legality on real data; this file covers the maths.
 */
import { readJSON } from './lib/io.mjs';
import {
  projectAll, poissonAtLeast, availability, inferGamesPlayed,
  teamDefence, upcomingByTeam, SQUAD_RULES,
} from '../js/model.js';
import { optimiseSquad, validate, bestXI, scoreSquad, suggestTransfers } from '../js/optimiser.js';

let failures = 0;
let checks = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

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

console.log(`\n${failures === 0 ? `✓ all ${checks} checks passed` : `✗ ${failures} of ${checks} checks failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
