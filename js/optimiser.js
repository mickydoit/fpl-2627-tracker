/**
 * Squad optimiser and transfer suggester.
 *
 * Picking 15 players under a budget, a per-club cap and per-position quotas is a
 * constrained knapsack — NP-hard, and there is no ILP solver in the browser. So
 * this uses randomised greedy construction followed by steepest-ascent local
 * search over single and paired swaps, restarted a few times. In practice it
 * lands on the same squads a proper solver finds, in well under a second.
 */

import { SQUAD_RULES, DEFAULTS } from './model.js';

/**
 * The number the solver ranks on.
 *
 * `proj` is the model's expected FPL points and must stay that way — it is
 * what the app displays, and a user's risk setting has no business altering
 * an expectation. `util` is the same figure after that preference is applied,
 * and only ranking reads it. At riskAversion 0 the two are identical, so a
 * risk-neutral user optimises directly on expectation.
 *
 * Every ordering, swap test and objective below goes through here. Anything
 * reporting a number to the reader uses `proj` instead.
 */
const score = (p) => (Number.isFinite(p?.util) ? p.util : (p?.proj ?? 0));

const { budget: BUDGET, perClub: PER_CLUB, select: SELECT, minPlay: MIN_PLAY, maxPlay: MAX_PLAY } = SQUAD_RULES;

/* ------------------------------------------------------------------ *
 * evaluating a squad
 * ------------------------------------------------------------------ */

/**
 * Best legal XI from a 15, plus captain. Take the mandatory minimum at each
 * position first, then fill the remaining slots with whoever projects highest
 * and still fits under the per-position maximum.
 */
/**
 * The best legal eleven under an arbitrary per-player value.
 *
 * Take the mandatory minimum at each position, then fill the remaining four
 * slots with whoever is worth most and still fits under the per-position
 * maximum. That is optimal here rather than merely reasonable: the minimums
 * must be paid, and what is left is a plain "best four subject to a cap per
 * position", where greedy by value is exact.
 *
 * Parameterised on `valueOf` so the same selector serves the horizon-total XI
 * and a single gameweek's XI. Two selectors would drift apart and one of them
 * would eventually field an illegal side.
 */
function pickXI(squad, valueOf) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of squad) byPos[p.element_type].push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => valueOf(b) - valueOf(a));

  const xi = [];
  const used = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const pos of [1, 2, 3, 4]) {
    for (let i = 0; i < MIN_PLAY[pos]; i++) {
      const p = byPos[pos][i];
      if (p) { xi.push(p); used[pos]++; }
    }
  }
  const rest = [];
  for (const pos of [1, 2, 3, 4]) rest.push(...byPos[pos].slice(used[pos]));
  rest.sort((a, b) => valueOf(b) - valueOf(a));
  for (const p of rest) {
    if (xi.length >= 11) break;
    const pos = p.element_type;
    if (used[pos] >= MAX_PLAY[pos]) continue;
    xi.push(p);
    used[pos]++;
  }
  return xi;
}

/** Best legal XI on horizon totals, plus captain, bench and formation. */
export function bestXI(squad) {
  return dressXI(squad, pickXI(squad, score));
}

/**
 * Best legal XI for ONE gameweek.
 *
 * FPL lets a manager field a different legal eleven every week, so a fifteen is
 * worth more than its best fixed eleven: a cheap defender with one good fixture
 * earns his place that week and sits the rest. Scoring the squad on a single
 * horizon-total XI priced that rotation at zero.
 */
export function bestXIForGW(squad, gw, key = 'utilByGW') {
  return pickXI(squad, (p) => p?.[key]?.[gw] ?? 0);
}

/**
 * Is an XI legal to field? Exactly one keeper, and the outfield minimums.
 * This is the rule the manual-substitution UI enforces while dragging.
 */
export function legalXI(xi) {
  if (xi.length !== 11) return false;
  const c = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of xi) c[p.element_type]++;
  return c[1] === MIN_PLAY[1] && c[2] >= MIN_PLAY[2] && c[3] >= MIN_PLAY[3] && c[4] >= MIN_PLAY[4];
}

/**
 * Build the bench, captain, vice and formation around a chosen XI. Shared by
 * bestXI and splitXI so the bench ordering rule lives in exactly one place.
 */
function dressXI(squad, xi) {
  const used = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of xi) used[p.element_type]++;

  // FPL benches the reserve keeper in its own slot — it is not part of the
  // outfield autosub order. Keep the keeper first, then subs 1-3 by projection.
  const benched = squad.filter((p) => !xi.includes(p));
  const bench = [
    ...benched.filter((p) => p.element_type === 1),
    ...benched.filter((p) => p.element_type !== 1).sort((a, b) => b.proj - a.proj),
  ];
  const captain = xi.reduce((best, p) => (!best || score(p) > score(best) ? p : best), null);
  const vice = xi.filter((p) => p !== captain).reduce((best, p) => (!best || score(p) > score(best) ? p : best), null);

  const formation = `${used[2]}-${used[3]}-${used[4]}`;
  return { xi, bench, captain, vice, formation };
}

/**
 * May `out` (currently starting) be exchanged for `inc` (currently benched)?
 *
 * FPL only fixes the keeper: it is one of the two, never swapped for an
 * outfielder. Everything else is legal as long as the resulting XI still
 * holds the outfield minimums — which is how you change formation without
 * making a transfer.
 */
export function canSwap(out, inc, xi) {
  if (!out || !inc || out === inc || out.id === inc.id) return false;
  const isGK = (p) => p.element_type === 1;
  if (isGK(out) || isGK(inc)) return isGK(out) && isGK(inc);
  if (!xi.includes(out) || xi.includes(inc)) return false;
  return legalXI(xi.map((p) => (p === out ? inc : p)));
}

/**
 * Split a 15 around an explicit set of starter ids — the manual XI the user
 * has dragged into place. Returns null if those ids do not describe a legal
 * XI, so a stale saved selection can never render an illegal team.
 */
export function splitXI(squad, starterIds) {
  const want = new Set(starterIds);
  const xi = squad.filter((p) => want.has(p.id));
  if (xi.length !== want.size || !legalXI(xi)) return null;
  return dressXI(squad, xi);
}

/**
 * Captaincy, chosen per gameweek rather than once for the horizon.
 *
 * The old objective added one player's WHOLE-HORIZON total a second time,
 * which is only correct if the same player is the best captain every week. A
 * squad holding two premiums with complementary fixtures could realise
 * `max(GW1) + max(GW2) + ...`; the shortcut could only ever realise
 * `max(total)`, so alternating captaincy was invisible to the search.
 *
 * Two things this deliberately does NOT do. It does not rotate the STARTING
 * XI: `bestXI` picks one eleven on horizon totals and that limitation is left
 * alone here, so the captain is chosen from the eleven actually fielded rather
 * than from all fifteen. And it adds no captain-specific availability or
 * variance term — a doubtful player's lower projection already carries that,
 * and doubling it would be charging for the same doubt twice.
 *
 * `projByGW` already sums every fixture in an event, so a double gameweek is
 * handled by construction: FPL doubles both of a captain's fixtures and so does
 * this. A player with no fixture that week contributes nothing and cannot be
 * chosen over someone who plays.
 *
 * @param {object[]} xi   the eleven actually fielded
 * @param {string} key    'utilByGW' for the objective, 'projByGW' for reporting
 */
export function captaincyBonus(xi, key = 'utilByGW') {
  const events = new Set();
  for (const p of xi) for (const gw of Object.keys(p?.[key] || {})) events.add(gw);
  /* No per-gameweek detail — synthetic rows, or a caller that built players by
     hand. Fall back to the horizon-total shortcut so behaviour is unchanged
     rather than silently zero. */
  if (!events.size) {
    const best = xi.reduce((b, p) => (!b || score(p) > score(b) ? p : b), null);
    return best ? score(best) : 0;
  }
  let total = 0;
  for (const gw of events) {
    let best = 0;
    for (const p of xi) {
      const v = p?.[key]?.[gw] ?? 0;
      if (v > best) best = v;
    }
    total += best;
  }
  return total;
}

/** Who to captain in a given gameweek, for display. */
export function captainForGW(xi, gw, key = 'projByGW') {
  let best = null;
  for (const p of xi) {
    const v = p?.[key]?.[gw] ?? 0;
    if (!best || v > best.value) best = { player: p, value: v };
  }
  return best && best.value > 0 ? best : null;
}

/**
 * The fixed-XI objective: one eleven for the whole horizon.
 *
 * Kept as the fallback for squads with no per-gameweek detail, and as the
 * control the rotation gain is measured against. `scoreSquad` below is the
 * entry point everything actually calls.
 */
export function scoreSquadFixed(squad, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { xi, bench, captain } = bestXI(squad);
  const xiPts = xi.reduce((s, p) => s + score(p), 0);
  const benchPts = bench.reduce((s, p) => s + score(p), 0);
  return xiPts + captaincyBonus(xi, 'utilByGW') + benchPts * o.benchWeight;
}

/**
 * The squad objective. Re-picks the eleven every gameweek where the data
 * supports it, and falls back to the fixed-XI scorer where it does not.
 *
 * Every caller — the solver's swap tests, the transfer adviser, the transfer
 * ladder — goes through here, so rotation value reaches all of them from one
 * place rather than three that could drift.
 */
export function scoreSquad(squad, opts = {}) {
  return scoreSquadByGW(squad, opts);
}

/** Gameweeks any player in the squad has a projection for. */
function eventsOf(squad, key) {
  const evs = new Set();
  for (let i = 0; i < squad.length; i++) {
    const m = squad[i]?.[key];
    if (m === undefined) continue;
    for (const gw in m) evs.add(gw);
  }
  return [...evs];
}

/**
 * Squad value with the eleven re-chosen every gameweek.
 *
 * FPL fixes the fifteen and lets the manager field any legal eleven from it
 * each week. Scoring one horizon-total XI therefore undercounted a squad by
 * exactly its rotation value — a cheap defender with one strong fixture, a
 * second keeper worth playing on his good weeks, a formation that ought to
 * change. All of that priced at zero.
 *
 *   for each gameweek:
 *     XI      = best legal eleven on THAT week's projections
 *     captain = best of that eleven that week   (Phase 4, now on a rotating XI)
 *     bench   = the four not selected THAT week, discounted
 *
 * The bench term is deliberately computed per gameweek from whoever is left
 * out that week, not from a fixed four. Otherwise a player who starts in GW2
 * and sits in GW3 would collect starter value and bench value in the same
 * breath, and the optimiser would happily pay twice for him.
 *
 * `benchWeight` keeps its meaning and its value: the chance a benched player is
 * autosubbed in. That is a per-gameweek event, so it applies per gameweek. It
 * is NOT refitted here.
 *
 * Falls back to the fixed-XI scorer when rows carry no per-gameweek detail, so
 * synthetic squads and older callers behave exactly as before.
 */
export function scoreSquadByGW(squad, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const evs = eventsOf(squad, 'utilByGW');
  if (!evs.length) return scoreSquadFixed(squad, opts);

  /* This runs in the solver's innermost loop — tens of thousands of squads, each
     scored across every gameweek in the horizon — so the arithmetic is worth
     keeping tight. The whole-squad total is computed once per week and the XI is
     subtracted from it, which avoids a second pass and a Set membership test per
     player. Semantics are unchanged: bench value is still exactly the players
     NOT selected that week. */
  const bw = o.benchWeight;
  let total = 0;
  for (let e = 0; e < evs.length; e++) {
    const gw = evs[e];
    const valueOf = (p) => {
      const m = p.utilByGW;
      return m === undefined ? 0 : (m[gw] ?? 0);
    };
    let squadPts = 0;
    for (let i = 0; i < squad.length; i++) squadPts += valueOf(squad[i]);

    const xi = pickXI(squad, valueOf);
    let xiPts = 0;
    let cap = 0;
    for (let i = 0; i < xi.length; i++) {
      const v = valueOf(xi[i]);
      xiPts += v;
      if (v > cap) cap = v;
    }
    total += xiPts + cap + (squadPts - xiPts) * bw;
  }
  return total;
}

export function squadCost(squad) {
  return squad.reduce((s, p) => s + p.now_cost, 0);
}

export function validate(squad, budget = BUDGET) {
  const errors = [];
  if (squad.length !== 15) errors.push(`${squad.length} players, need 15`);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const clubs = {};
  for (const p of squad) {
    counts[p.element_type]++;
    clubs[p.team] = (clubs[p.team] || 0) + 1;
  }
  for (const pos of [1, 2, 3, 4]) {
    if (counts[pos] !== SELECT[pos]) errors.push(`${counts[pos]} of position ${pos}, need ${SELECT[pos]}`);
  }
  for (const [team, n] of Object.entries(clubs)) {
    if (n > PER_CLUB) errors.push(`${n} players from team ${team}, max ${PER_CLUB}`);
  }
  const cost = squadCost(squad);
  if (cost > budget) errors.push(`£${(cost / 10).toFixed(1)}m over the £${(budget / 10).toFixed(1)}m budget`);
  return { ok: errors.length === 0, errors, cost };
}

/* ------------------------------------------------------------------ *
 * building a squad
 * ------------------------------------------------------------------ */

function poolByPosition(players, { exclude = new Set(), maxPool = 90 } = {}) {
  const pool = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of players) {
    if (exclude.has(p.id)) continue;
    if (score(p) <= 0) continue;
    pool[p.element_type].push(p);
  }
  for (const pos of [1, 2, 3, 4]) {
    const byProj = [...pool[pos]].sort((a, b) => score(b) - score(a)).slice(0, maxPool);
    const byValue = [...pool[pos]].sort((a, b) => b.value - a.value).slice(0, maxPool);
    // Cheap enablers matter as much as premiums — a good 15 needs both ends.
    const cheap = [...pool[pos]].sort((a, b) => a.now_cost - b.now_cost || score(b) - score(a)).slice(0, 25);
    const seen = new Set();
    pool[pos] = [...byProj, ...byValue, ...cheap].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }
  return pool;
}

function greedySquad(pool, { budget, locked = [], noise = 0, rng = Math.random }) {
  const squad = [...locked];
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const clubs = {};
  let spend = 0;
  for (const p of locked) {
    counts[p.element_type]++;
    clubs[p.team] = (clubs[p.team] || 0) + 1;
    spend += p.now_cost;
  }

  const chosen = new Set(squad.map((p) => p.id));

  /**
   * Cheapest way to fill `need` slots at `pos` that is actually reachable.
   *
   * This has to respect the three-per-club cap. Reserving against the globally
   * cheapest player is wrong: greedy concentrates its early picks in the strong
   * clubs, so by the time it reaches goalkeepers the cheapest *reachable* keeper
   * can cost far more than the cheapest keeper in the league. Under-reserving
   * that way strands the solve with no legal candidate and no budget left.
   */
  const reserveFor = (pos, need) => {
    if (need <= 0) return 0;
    const costs = pool[pos]
      .filter((p) => !chosen.has(p.id) && (clubs[p.team] || 0) < PER_CLUB)
      .map((p) => p.now_cost)
      .sort((a, b) => a - b);
    if (costs.length < need) return Infinity;
    let sum = 0;
    for (let i = 0; i < need; i++) sum += costs[i];
    return sum;
  };

  // Fill the expensive positions first — they constrain the budget most.
  const order = [4, 3, 2, 1];
  for (const pos of order) {
    while (counts[pos] < SELECT[pos]) {
      let reserve = 0;
      for (const q of [1, 2, 3, 4]) {
        reserve += reserveFor(q, SELECT[q] - counts[q] - (q === pos ? 1 : 0));
      }
      if (!Number.isFinite(reserve)) return null;
      const affordable = budget - spend - reserve;

      const candidates = pool[pos].filter(
        (p) =>
          !chosen.has(p.id) &&
          p.now_cost <= affordable &&
          (clubs[p.team] || 0) < PER_CLUB,
      );
      if (!candidates.length) return null;

      // Rank by value density, jittered so restarts explore different squads.
      const scored = candidates.map((p) => ({
        p,
        s: (score(p) / Math.max(1, p.now_cost / 10)) * (1 + (rng() - 0.5) * 2 * noise),
      }));
      scored.sort((a, b) => b.s - a.s);
      const pick = scored[0].p;

      squad.push(pick);
      chosen.add(pick.id);
      counts[pos]++;
      clubs[pick.team] = (clubs[pick.team] || 0) + 1;
      spend += pick.now_cost;
    }
  }
  return squad;
}

function clubCounts(squad) {
  const clubs = {};
  for (const p of squad) clubs[p.team] = (clubs[p.team] || 0) + 1;
  return clubs;
}

function clubsLegal(squad) {
  const clubs = {};
  for (const p of squad) {
    clubs[p.team] = (clubs[p.team] || 0) + 1;
    if (clubs[p.team] > PER_CLUB) return false;
  }
  return true;
}

/** One steepest-ascent pass over single swaps. Returns the best improvement or null. */
function bestSingleSwap(current, pool, { budget, lockedIds, opts, best, accept = null }) {
  let bestSwap = null;
  for (let i = 0; i < current.length; i++) {
    const out = current[i];
    if (lockedIds.has(out.id)) continue;
    const rest = current.filter((_, j) => j !== i);
    const spend = squadCost(rest);
    const clubs = clubCounts(rest);
    const ids = new Set(rest.map((p) => p.id));

    for (const inc of pool[out.element_type]) {
      if (ids.has(inc.id)) continue;
      if (spend + inc.now_cost > budget) continue;
      if ((clubs[inc.team] || 0) >= PER_CLUB) continue;
      if (score(inc) <= score(out) && inc.now_cost >= out.now_cost) continue; // strictly dominated

      const trial = [...rest, inc];
      // Checked before scoring: rejecting a trial is far cheaper than valuing it.
      if (accept && !accept(trial)) continue;
      const s = scoreSquad(trial, opts);
      if (s > best + 1e-9 && (!bestSwap || s > bestSwap.score)) {
        bestSwap = { score: s, squad: trial };
      }
    }
  }
  return bestSwap;
}

/**
 * One pass over *paired* swaps: downgrade one player to fund an upgrade elsewhere.
 *
 * Single-swap hill climbing gets stuck whenever the best squad requires selling a
 * mid-price player to afford a premium — no individual swap improves the score, so
 * the search stops early. That was leaving real points on the table, so pairs are
 * searched too, restricted to plausible (upgrade, downgrade) combinations to keep
 * it fast enough to run in the browser.
 */
function bestPairSwap(current, pool, { budget, lockedIds, opts, best, accept = null, upgradeK = 10, downgradeK = 6 }) {
  let bestMove = null;
  const owned = new Set(current.map((p) => p.id));

  // Cache the candidate shortlists per squad slot — they don't change within a pass.
  const upgradesFor = current.map((out) =>
    lockedIds.has(out.id) ? [] :
      pool[out.element_type]
        .filter((p) => !owned.has(p.id) && score(p) > score(out) && p.now_cost > out.now_cost)
        .sort((a, b) => score(b) - score(a))
        .slice(0, upgradeK),
  );
  const downgradesFor = current.map((out) =>
    lockedIds.has(out.id) ? [] :
      pool[out.element_type]
        .filter((p) => !owned.has(p.id) && p.now_cost < out.now_cost)
        .sort((a, b) => score(b) - score(a))
        .slice(0, downgradeK),
  );

  for (let i = 0; i < current.length; i++) {
    const upgrades = upgradesFor[i];
    if (!upgrades.length) continue;
    for (let j = 0; j < current.length; j++) {
      if (j === i) continue;
      const downgrades = downgradesFor[j];
      if (!downgrades.length) continue;

      const rest = current.filter((_, k) => k !== i && k !== j);
      const restCost = squadCost(rest);

      for (const inI of upgrades) {
        for (const inJ of downgrades) {
          if (inI.id === inJ.id) continue;
          if (restCost + inI.now_cost + inJ.now_cost > budget) continue;
          const trial = [...rest, inI, inJ];
          if (!clubsLegal(trial)) continue;
          if (accept && !accept(trial)) continue;
          const s = scoreSquad(trial, opts);
          if (s > best + 1e-9 && (!bestMove || s > bestMove.score)) {
            bestMove = { score: s, squad: trial };
          }
        }
      }
    }
  }
  return bestMove;
}

function improve(squad, pool, { budget, lockedIds, opts, accept = null, maxPasses = 40 }) {
  let current = [...squad];
  let best = scoreSquad(current, opts);

  for (let pass = 0; pass < maxPasses; pass++) {
    // Cheap single swaps first — they resolve most of the gap.
    const single = bestSingleSwap(current, pool, { budget, lockedIds, opts, best, accept });
    if (single) {
      current = single.squad;
      best = single.score;
      continue;
    }
    // Only reach for the expensive paired search once singles are exhausted.
    const pair = bestPairSwap(current, pool, { budget, lockedIds, opts, best, accept });
    if (!pair) break;
    current = pair.squad;
    best = pair.score;
  }
  return { squad: current, score: best };
}

/**
 * Optimise a 15-man squad.
 * @param {Array} players projected player rows
 * @param {object} options budget, locked ids, excluded ids, restarts
 */
export function optimiseSquad(players, options = {}) {
  const {
    budget = BUDGET,
    lockedIds = [],
    excludedIds = [],
    restarts = 8,
    seed = 12345,
    /**
     * Squads to improve from in addition to the randomised greedy seeds.
     *
     * Randomised construction is not guaranteed to reach the optimum in a fixed
     * number of restarts — on one sample dataset eight restarts landed 1.6
     * points short of where sixteen converged. That is normally invisible, but
     * it becomes absurd when this result is shown beside a squad reached under
     * a TRANSFER limit: the benchmark can read lower than the thing it is
     * supposed to be the ceiling for. Handing the constrained result in as a
     * starting point removes the possibility by construction rather than by
     * raising the restart count and hoping.
     */
    seedSquads = [],
    ...opts
  } = options;

  // Deterministic PRNG so the same inputs always produce the same squad —
  // a suggestion that changes on every page load is impossible to act on.
  let s = seed >>> 0;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const exclude = new Set(excludedIds);
  const byId = new Map(players.map((p) => [p.id, p]));
  const locked = lockedIds.map((id) => byId.get(id)).filter(Boolean);
  const lockedSet = new Set(locked.map((p) => p.id));

  if (locked.length > 15) throw new Error('More than 15 players locked');
  for (const pos of [1, 2, 3, 4]) {
    const n = locked.filter((p) => p.element_type === pos).length;
    if (n > SELECT[pos]) throw new Error(`Too many locked players in position ${pos}`);
  }

  const pool = poolByPosition(players, { exclude });
  // Locked players must be available to the local search even if pruned out.
  for (const p of locked) {
    if (!pool[p.element_type].some((q) => q.id === p.id)) pool[p.element_type].push(p);
  }

  let best = null;
  for (let r = 0; r < restarts; r++) {
    const seedSquad = greedySquad(pool, {
      budget, locked, noise: r === 0 ? 0 : 0.35, rng,
    });
    if (!seedSquad) continue;
    const result = improve(seedSquad, pool, { budget, lockedIds: lockedSet, opts });
    if (!best || result.score > best.score) best = result;
  }

  /* Improve from any squad the caller supplies, on the same terms. Skipped
     rather than rejected if it does not fit the budget or the roster rules —
     a caller passing last week's squad after a price change should not lose
     the whole solve over it. */
  for (const given of seedSquads) {
    const sq = given.map((p) => byId.get(p?.id ?? p)).filter(Boolean);
    if (sq.length !== SQUAD_RULES.size) continue;
    if (squadCost(sq) > budget) continue;
    if (sq.some((p) => exclude.has(p.id))) continue;
    for (const p of sq) {
      if (!pool[p.element_type].some((q) => q.id === p.id)) pool[p.element_type].push(p);
    }
    const result = improve(sq, pool, { budget, lockedIds: lockedSet, opts });
    if (!best || result.score > best.score) best = result;
  }

  if (!best) return null;

  const squad = best.squad;
  const { xi, bench, captain, vice, formation } = bestXI(squad);
  return {
    squad: [...squad].sort((a, b) => a.element_type - b.element_type || b.proj - a.proj),
    xi, bench, captain, vice, formation,
    score: best.score,
    cost: squadCost(squad),
    remaining: budget - squadCost(squad),
    /* Reported, so expectation rather than utility — this is the number a
       reader sees as the squad's projected points. */
    projected: xi.reduce((t, p) => t + p.proj, 0) + captaincyBonus(xi, 'projByGW'),
  };
}

/**
 * The best squad you can actually REACH, given the transfers you have.
 *
 * `optimiseSquad` answers "what is the strongest fifteen for £100m". That is a
 * benchmark, not a plan: acting on it costs one transfer per player changed,
 * and on a real squad it usually differs by six or seven. At −4 a piece beyond
 * your free transfers, the theoretical gain is spent several times over before
 * you have finished buying it.
 *
 * This answers the question a manager actually has. Same search, two changes:
 *
 * 1. **The budget is what you hold**, `squadCost(yours) + bank` — not a fresh
 *    £100m. You can only spend what selling your own players raises.
 * 2. **A hard cap on how far the squad may drift from the one you own.**
 *
 * The cap counts the FINAL difference, not the moves made along the way. That
 * matters: the local search reaches good squads by passing through
 * intermediate ones, and a slot it moves away and later moves back has cost
 * nothing in the real game. Counting moves instead of difference would charge
 * for transfers that were never made and refuse squads that are plainly legal.
 *
 * No hits, ever. The cap is hard rather than priced, because a manager who has
 * decided not to take hits wants the best squad without them, not a solver
 * second-guessing that with a −4 it likes the look of.
 *
 * Deterministic, and no restarts: the starting point is your squad rather than
 * a randomised greedy seed, so there is nothing to average over.
 *
 * @param {number[]} squadIds the fifteen you own
 * @param {object[]} players  projected rows
 * @param {object} options    bank (tenths), transfers, plus scoreSquad options
 */
export function optimiseWithinTransfers(squadIds, players, options = {}) {
  const { bank = 0, transfers = 1, excludedIds = [], ...opts } = options;
  const byId = new Map(players.map((p) => [p.id, p]));
  const current = squadIds.map((id) => byId.get(id)).filter(Boolean);
  if (current.length !== SQUAD_RULES.size) {
    return { error: `Squad has ${current.length} players, need ${SQUAD_RULES.size}.` };
  }

  const budget = squadCost(current) + bank;
  const originIds = new Set(current.map((p) => p.id));
  const baseScore = scoreSquad(current, opts);

  const pool = poolByPosition(players, { exclude: new Set(excludedIds) });
  /* Your own players must be in the pool even if pruning dropped them, or the
     search cannot move a slot back to where it started and free a transfer. */
  for (const p of current) {
    if (!pool[p.element_type].some((q) => q.id === p.id)) pool[p.element_type].push(p);
  }

  const accept = (trial) => {
    let changed = 0;
    for (const p of trial) if (!originIds.has(p.id)) changed++;
    return changed <= transfers;
  };

  const { squad, score } = transfers > 0
    ? improve(current, pool, { budget, lockedIds: new Set(), opts, accept })
    : { squad: current, score: baseScore };

  /* Position quotas are fixed, so the players leaving and arriving match up
     position by position — which is what a transfer actually is. */
  const out = current.filter((p) => !squad.some((q) => q.id === p.id));
  const incoming = squad.filter((p) => !originIds.has(p.id));
  const moves = out.map((o) => {
    const i = incoming.findIndex((x) => x.element_type === o.element_type);
    return { out: o, in: i >= 0 ? incoming.splice(i, 1)[0] : null };
  }).filter((m) => m.in);

  const { xi, bench, captain, vice, formation } = bestXI(squad);
  return {
    squad: [...squad].sort((a, b) => a.element_type - b.element_type || b.proj - a.proj),
    xi, bench, captain, vice, formation,
    score,
    baseScore,
    gain: score - baseScore,
    moves,
    transfersUsed: moves.length,
    transfersAllowed: transfers,
    cost: squadCost(squad),
    remaining: budget - squadCost(squad),
    projected: xi.reduce((t, p) => t + p.proj, 0) + captaincyBonus(xi, 'projByGW'),
  };
}

/* ------------------------------------------------------------------ *
 * transfer suggestions
 * ------------------------------------------------------------------ */

/**
 * Rank every legal single transfer, then the best pairs.
 *
 * `hit` is the 4-point penalty per transfer beyond your free ones. Note the
 * 2026/27 rule: you can bank up to 5 free transfers, so `freeTransfers` is
 * often greater than 1.
 */
export function suggestTransfers(squadIds, players, options = {}) {
  const {
    bank = 0,
    freeTransfers = 1,
    maxSuggestions = 25,
    excludedIds = [],
    lockedIds = [],
    ...opts
  } = options;

  const byId = new Map(players.map((p) => [p.id, p]));
  const squad = squadIds.map((id) => byId.get(id)).filter(Boolean);
  if (squad.length !== 15) {
    return { error: `Squad has ${squad.length} recognised players, need 15.`, singles: [], pairs: [] };
  }

  const exclude = new Set(excludedIds);
  const locked = new Set(lockedIds);
  const squadSet = new Set(squad.map((p) => p.id));
  const baseline = scoreSquad(squad, opts);
  const pool = poolByPosition(players, { exclude, maxPool: 90 });

  const singles = [];
  for (const out of squad) {
    if (locked.has(out.id)) continue;
    const rest = squad.filter((p) => p.id !== out.id);
    const clubs = {};
    for (const p of rest) clubs[p.team] = (clubs[p.team] || 0) + 1;
    // Selling price already reflects the 50% sell-on fee if you pass purchase
    // prices in; with live prices only, now_cost is the best available estimate.
    const funds = bank + out.now_cost;

    for (const inc of pool[out.element_type]) {
      if (squadSet.has(inc.id)) continue;
      if (inc.now_cost > funds) continue;
      if ((clubs[inc.team] || 0) >= PER_CLUB) continue;

      const trial = [...rest, inc];
      const gain = scoreSquad(trial, opts) - baseline;
      const cost = freeTransfers >= 1 ? 0 : 4;
      singles.push({
        out, in: inc, gain, net: gain - cost, hit: cost,
        spend: inc.now_cost - out.now_cost,
        bankAfter: funds - inc.now_cost,
      });
    }
  }
  singles.sort((a, b) => b.net - a.net);

  // Pairs, built only from the strongest single moves — the full cross product
  // is ~15 × 90 × 15 × 90 and adds nothing but latency.
  const pairs = [];
  const top = singles.slice(0, 30);
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i];
      const b = top[j];
      if (a.out.id === b.out.id || a.in.id === b.in.id) continue;
      const rest = squad.filter((p) => p.id !== a.out.id && p.id !== b.out.id);
      if (rest.length !== 13) continue;
      const trial = [...rest, a.in, b.in];
      const cost = squadCost(trial);
      if (cost > squadCost(squad) + bank) continue;
      const clubs = {};
      let legal = true;
      for (const p of trial) {
        clubs[p.team] = (clubs[p.team] || 0) + 1;
        if (clubs[p.team] > PER_CLUB) { legal = false; break; }
      }
      if (!legal) continue;

      const gain = scoreSquad(trial, opts) - baseline;
      const hit = Math.max(0, 2 - freeTransfers) * 4;
      pairs.push({ moves: [a, b], gain, net: gain - hit, hit });
    }
  }
  pairs.sort((a, b) => b.net - a.net);

  return {
    baseline,
    singles: singles.slice(0, maxSuggestions),
    pairs: pairs.slice(0, 10),
  };
}
