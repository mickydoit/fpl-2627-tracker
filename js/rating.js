/**
 * Classic FPL squad rating.
 *
 * The rule this module keeps: **the headline number is a presentation of the
 * components, never a replacement for them.** Every score carries the parts it
 * was built from, in the units they were measured in, so the page can say why
 * a squad rates 84 without re-deriving anything.
 *
 * Deliberately Classic-specific rather than a reuse of js/draft/rating.js. The
 * two games rate different things: Draft has a closed pool of six rosters and
 * no money, so its natural reference is a percentile within the league. Classic
 * has a budget, a captain who doubles, a transfer market shared with millions,
 * and a squad you can only change one player at a time. The question here is
 * therefore not "how do I compare to my rivals" but:
 *
 *   **how much of what my money could buy am I actually getting?**
 *
 * That is why every dimension is measured against an achievable ceiling — the
 * optimiser's best legal squad at the same total spend — rather than against a
 * league or an abstract maximum. A rating of 100 means the money is already
 * working as hard as it can. It also makes the number honest for a small
 * budget: a £96m squad is not marked down for not being a £103m one.
 *
 * Nothing here knows about the DOM, the API, or Draft.
 */
import { bestXI, optimiseSquad, squadCost } from './optimiser.js';
import { SQUAD_RULES } from './model.js';

const POS = { 1: 'gk', 2: 'def', 3: 'mid', 4: 'fwd' };
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Turn "share of what was achievable" into a 0-100 score.
 *
 * A straight ratio is unreadable: real squads land between about 0.75 and 1.00
 * of the optimiser's total, so a raw percentage would put every squad in the
 * nineties and distinguish nothing. `floor` is the ratio treated as zero.
 *
 * 0.60 is not a taste decision — it is where a squad of median-priced,
 * median-projection players lands against the optimal squad at the same spend,
 * measured in scripts/test.mjs. Below that you are not really choosing players.
 */
export const RATING_FLOOR = 0.60;

export function scoreRatio(mine, best, floor = RATING_FLOOR) {
  if (!(best > 0)) return 0;
  const r = mine / best;
  return clamp(((r - floor) / (1 - floor)) * 100, 0, 100);
}

/**
 * The strongest set of `slots` players at one position costing no more than
 * `spend` in total.
 *
 * The honest benchmark for a line: not "what does the optimal squad field
 * there", which depends on how it chose to split money across positions, but
 * "what could this line have been for this money". Greedy from the top, taking
 * a player only while the cheapest remaining options still fit the slots left —
 * the same reservation the squad optimiser uses, for the same reason.
 *
 * The three-per-club cap is deliberately not applied: this is a yardstick for
 * one line, not a buildable squad, and imposing a squad-wide constraint on a
 * single line would understate what the money could do.
 */
export function bestLineTotal(pool, type, slots, spend) {
  if (!(slots > 0) || !(spend > 0)) return 0;
  const candidates = pool.filter((p) => p.element_type === type && p.now_cost > 0);
  if (candidates.length < slots) return 0;

  /* Exact, not greedy. Taking the highest projection first is wrong here: one
     expensive player can consume budget that two mid-priced ones would have
     used better, and a benchmark that loses to the squad it is judging is
     worse than no benchmark — it silently scores every line at the maximum.
     Prices are tenths of a million and a line is at most five players, so the
     table is small enough to solve properly. */
  const cap = Math.floor(spend);
  const NEG = -Infinity;
  // dp[k][b] = best projection using exactly k players costing exactly <= b
  let dp = Array.from({ length: slots + 1 }, () => new Float64Array(cap + 1).fill(NEG));
  dp[0].fill(0);
  for (const p of candidates) {
    const c = Math.floor(p.now_cost);
    if (c > cap) continue;
    for (let k = slots; k >= 1; k--) {
      const prev = dp[k - 1];
      const cur = dp[k];
      for (let b = cap; b >= c; b--) {
        const alt = prev[b - c];
        if (alt !== NEG && alt + p.proj > cur[b]) cur[b] = alt + p.proj;
      }
    }
  }
  const best = dp[slots][cap];
  return best === NEG ? 0 : best;
}

/**
 * How badly the XI degrades when a starter is missing.
 *
 * Measured, not assumed: remove each starter in turn, rebuild the best legal
 * eleven from what is left, and average the points lost. A squad whose bench
 * can step in loses little. Reported as points per absence so it stays
 * readable, and converted to a score against the XI's own scale so that
 * "how much do I lose" is expressed as "how much of my XI survives".
 *
 * Because the rebuild uses the real formation rules, a bench full of expensive
 * players in a position the XI cannot field earns nothing — which is the point.
 */
export function depthCost(squad) {
  const base = bestXI(squad);
  if (base.xi.length < 11) return { perAbsence: 0, worst: null, measurable: false };
  let worst = null;
  const drops = base.xi.map((starter) => {
    const without = squad.filter((p) => p.id !== starter.id);
    const rebuilt = bestXI(without);
    const drop = rebuilt.xi.length < 11
      ? base.xi.reduce((s, p) => s + p.proj, 0) // cannot field a legal XI at all
      : base.xi.reduce((s, p) => s + p.proj, 0) - rebuilt.xi.reduce((s, p) => s + p.proj, 0);
    if (!worst || drop > worst.drop) worst = { player: starter, drop };
    return drop;
  });
  return { perAbsence: sum(drops, (d) => d) / drops.length, worst, measurable: true };
}

/**
 * Projection-weighted minutes security.
 *
 * Three things make a projection fragile, and all three are already measured
 * elsewhere: the player may not be available, he may not play a full match, and
 * the projection may rest on a price prior rather than his own football. A
 * doubtful fifth defender barely matters and a doubtful captain matters a great
 * deal, so each player's security is weighted by the points at stake.
 */
export function minutesSecurity(squad) {
  const { xi, captain } = bestXI(squad);
  const weightOf = (p) => p.proj * (p === captain ? 2 : 1);
  const total = sum(xi, weightOf);
  if (!(total > 0)) return { score: 0, weakest: null };
  let weakest = null;
  const secured = sum(xi, (p) => {
    const avail = p.parts?.availability ?? 1;
    const starts = clamp((p.parts?.expMins ?? 90) / 70, 0, 1);
    // A prior-heavy projection is not unavailable, just less knowable.
    const known = 0.5 + 0.5 * clamp(p.parts?.evidence ?? 1, 0, 1);
    const s = avail * starts * known;
    if (!weakest || s < weakest.security) weakest = { player: p, security: s };
    return weightOf(p) * s;
  });
  return { score: clamp((secured / total) * 100, 0, 100), weakest };
}

/**
 * Budget and structural flexibility. Deliberately not a quality measure.
 *
 * Answers "how easily can this squad change?", which is a different question
 * from "how good is it". A squad can be excellent and rigid: no money, nothing
 * sellable, every transfer already spent.
 *
 * Money sitting on the bench is counted against you. A £6.0m fifth defender who
 * never starts is capital doing nothing, and in Classic that is the most common
 * way a squad quietly runs out of room.
 */
export function flexibility(squad, { bank = 0, freeTransfers = 1 } = {}) {
  const { bench } = bestXI(squad);
  const benchSpend = sum(bench.filter((p) => p.element_type !== 1), (p) => p.now_cost);
  const parts = {
    // £3.0m is roughly one premium upgrade of headroom.
    bank: clamp(bank / 30, 0, 1),
    // Four outfield bench players at the £4.0-4.5m floor is about £17m; more
    // than that is money that could have been in the XI.
    benchEfficiency: clamp(1 - (benchSpend - 170) / 130, 0, 1),
    // Banking transfers is the flexibility, up to the 2026/27 cap of five.
    transfers: clamp(freeTransfers / 5, 0, 1),
  };
  const score = clamp((parts.bank * 0.4 + parts.benchEfficiency * 0.35 + parts.transfers * 0.25) * 100, 0, 100);
  return { score, benchSpend, ...parts };
}

/**
 * How the dimensions combine.
 *
 * Anchored on where the points actually come from rather than on preference.
 * Decomposing real squads over five gameweeks: the starting eleven supplies
 * about 88% of a squad's expected return, the captain's doubling about 9%, and
 * the bench about 3% through autosubs. So the eleven and the captain carry most
 * of the weight, in that order.
 *
 * The remaining dimensions are not point shares — they are the probability that
 * the points survive contact with a season. Depth and minutes security earn
 * real weight because injuries and rotation are certain over 38 gameweeks, not
 * possible. Positional strength is scored separately per line but folded in
 * once, at a weight that reflects it being a re-cut of the same XI rather than
 * new information. Flexibility is smallest: it buys future points, not present
 * ones, and over-weighting it would rate a poor squad well for being easy to
 * fix.
 */
export const RATING_WEIGHTS = {
  xi: 0.38,
  captaincy: 0.14,
  positional: 0.15,
  depth: 0.13,
  minutes: 0.12,
  flexibility: 0.08,
};

/**
 * Rate one Classic squad.
 *
 * @param {object[]} squad 15 projected rows
 * @param {object[]} pool  every projected row, for the achievable ceiling
 */
export function rateSquad(squad, { pool = [], bank = 0, freeTransfers = 1, ceiling = null } = {}) {
  if (squad.length !== SQUAD_RULES.size) {
    return { error: `Squad has ${squad.length} players, need ${SQUAD_RULES.size}.` };
  }

  const mine = bestXI(squad);
  const xiPts = sum(mine.xi, (p) => p.proj);
  const capPts = mine.captain?.proj ?? 0;

  /* The reference: the strongest legal squad the same money could buy. Passed
     in where the caller already has one, because solving it is the expensive
     part and pages rate several squads at once. */
  const budget = squadCost(squad) + bank;
  const best = ceiling ?? optimiseSquad(pool, { budget });
  const bestSquad = best?.squad ?? [];
  const bestXi = bestSquad.length ? bestXI(bestSquad) : null;
  const bestXiPts = bestXi ? sum(bestXi.xi, (p) => p.proj) : 0;
  const bestCapPts = bestXi?.captain?.proj ?? 0;

  /* Positional strength is measured on the whole line, not the starters: your
     fifth defender is part of what the money bought even when he sits.
     Benchmarked against the best line buyable for the money spent on THAT line,
     not against the optimal squad's line. The optimiser allocates budget across
     positions differently, so comparing lines directly can score a line above
     100 simply because the optimiser chose to spend elsewhere — which says
     nothing about whether your defenders are good value. */
  const byPos = (sq, t) => sq.filter((p) => p.element_type === t);
  const positional = {};
  for (const t of [1, 2, 3, 4]) {
    const line = byPos(squad, t);
    const has = sum(line, (p) => p.proj);
    const spend = sum(line, (p) => p.now_cost);
    const could = bestLineTotal(pool, t, line.length, spend);
    positional[POS[t]] = { score: scoreRatio(has, could), proj: has, achievable: could, spend };
  }

  const depth = depthCost(squad);
  const bestDepth = bestSquad.length ? depthCost(bestSquad) : { perAbsence: 0 };
  /* Lower loss is better, so the ratio is inverted: what share of the XI
     survives an average absence, against what the best squad manages. */
  const survives = xiPts > 0 ? 1 - depth.perAbsence / xiPts : 0;
  const bestSurvives = bestXiPts > 0 ? 1 - bestDepth.perAbsence / bestXiPts : 0;
  const security = minutesSecurity(squad);
  const flex = flexibility(squad, { bank, freeTransfers });

  const dims = {
    xi: scoreRatio(xiPts, bestXiPts),
    captaincy: scoreRatio(capPts, bestCapPts),
    gk: positional.gk.score,
    def: positional.def.score,
    mid: positional.mid.score,
    fwd: positional.fwd.score,
    depth: bestSurvives > 0 ? clamp((survives / bestSurvives) * 100, 0, 100) : 0,
    minutes: security.score,
    flexibility: flex.score,
  };

  const positionalMean = (dims.gk + dims.def + dims.mid + dims.fwd) / 4;
  const overall = clamp(
    dims.xi * RATING_WEIGHTS.xi
    + dims.captaincy * RATING_WEIGHTS.captaincy
    + positionalMean * RATING_WEIGHTS.positional
    + dims.depth * RATING_WEIGHTS.depth
    + dims.minutes * RATING_WEIGHTS.minutes
    + dims.flexibility * RATING_WEIGHTS.flexibility,
    0, 100,
  );

  /* Strength and weakness come from the same numbers that produced the score,
     never from a separate opinion. Flexibility is excluded from "weakness"
     because the answer to it is a transfer, not a judgement on the squad. */
  const named = { xi: 'Best XI', captaincy: 'Captaincy', gk: 'GK', def: 'DEF', mid: 'MID', fwd: 'FWD',
    depth: 'Depth', minutes: 'Minutes security', flexibility: 'Flexibility' };
  const ranked = Object.entries(dims).sort((a, b) => b[1] - a[1]);
  const weakestPositional = [['gk', dims.gk], ['def', dims.def], ['mid', dims.mid], ['fwd', dims.fwd]]
    .sort((a, b) => a[1] - b[1])[0];

  return {
    overall: Math.round(overall),
    dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, Math.round(v)])),
    strongest: { key: ranked[0][0], label: named[ranked[0][0]], score: Math.round(ranked[0][1]) },
    weakest: { key: ranked[ranked.length - 1][0], label: named[ranked[ranked.length - 1][0]],
      score: Math.round(ranked[ranked.length - 1][1]) },
    weakestLine: { key: weakestPositional[0], label: named[weakestPositional[0]],
      score: Math.round(weakestPositional[1]) },
    parts: {
      xiPts, capPts, bestXiPts, bestCapPts, budget,
      captain: mine.captain, vice: mine.vice, formation: mine.formation,
      positional, depth, security, flex,
      ceiling: best,
    },
  };
}
