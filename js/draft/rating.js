/**
 * Squad and league ratings for season mode.
 *
 * The rule this module exists to enforce: **the headline number is a
 * presentation of the components, never a replacement for them.** Every score
 * returned here carries the parts it was built from, in the units they were
 * measured in, so the page can always answer "why is this manager second?"
 * without re-deriving anything.
 *
 * Nothing here knows about the draft, the API or the DOM. It takes projected
 * rows and rosters and returns numbers.
 */
import { QUOTA, STARTER_QUOTA, RATING_WEIGHTS } from './config.js';

/** Minimum legal shape of a Draft XI: 1 GK, 3 DEF, 2 MID, 1 FWD, eleven total. */
const XI_MIN = { 1: 1, 2: 3, 3: 2, 4: 1 };
const XI_SIZE = 11;

const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);

/**
 * The strongest legal eleven, and the bench it leaves behind.
 *
 * Fill each position's minimum first, then take the best remaining outfielders
 * regardless of position — a reserve keeper can never start, so he is bench by
 * construction rather than by rule.
 *
 * @param {object[]} roster projected rows
 * @param {(r:object)=>number} value which projection to optimise
 */
export function bestXI(roster, value = (r) => r.proj) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of roster) (byPos[p.element_type] ||= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => value(b) - value(a));

  const xi = [];
  for (const t of [1, 2, 3, 4]) xi.push(...byPos[t].slice(0, XI_MIN[t]));

  const rest = [];
  for (const t of [2, 3, 4]) rest.push(...byPos[t].slice(XI_MIN[t]));
  rest.sort((a, b) => value(b) - value(a));
  xi.push(...rest.slice(0, XI_SIZE - xi.length));

  const inXI = new Set(xi.map((p) => p.id));
  const bench = roster.filter((p) => !inXI.has(p.id)).sort((a, b) => value(b) - value(a));
  return { xi, bench, total: sum(xi, value) };
}

/**
 * How badly the XI degrades when a starter is unavailable.
 *
 * Measured, not assumed: each starter is removed in turn, the XI is rebuilt
 * from what remains, and the average points lost is the answer. A squad whose
 * bench can genuinely step in loses little; one carrying four unplayable
 * reserves loses a lot. Reported as points per absence, so it stays readable.
 */
export function depthCost(roster, value = (r) => r.proj) {
  const base = bestXI(roster, value);
  if (base.xi.length < XI_SIZE) return { perAbsence: 0, worst: null, measurable: false };

  let worst = null;
  const drops = base.xi.map((starter) => {
    const without = roster.filter((p) => p.id !== starter.id);
    const drop = base.total - bestXI(without, value).total;
    if (!worst || drop > worst.drop) worst = { player: starter, drop };
    return drop;
  });
  return { perAbsence: sum(drops) / drops.length, worst, measurable: true };
}

/**
 * Value over the best replacement actually available.
 *
 * Replacement level is the strongest *unowned* player at that position — the
 * genuine alternative, not a league-average abstraction. Computed over the XI
 * only: bench VORP flatters squads hoarding a position they cannot start.
 */
export function squadVorp(roster, pool, value = (r) => r.proj) {
  const bestFree = {};
  for (const p of pool) {
    const t = p.element_type;
    if (!bestFree[t] || value(p) > value(bestFree[t])) bestFree[t] = p;
  }
  const { xi } = bestXI(roster, value);
  const perPlayer = xi.map((p) => ({
    player: p,
    vorp: value(p) - (bestFree[p.element_type] ? value(bestFree[p.element_type]) : 0),
  }));
  return { total: sum(perPlayer, (x) => x.vorp), perPlayer, bestFree };
}

/**
 * Projection-weighted unavailability.
 *
 * A doubtful fifth defender barely matters; a doubtful captain does. Weighting
 * by projected points rather than counting flagged players is what makes the
 * number mean something. Returns 0–1, where 0 is a fully fit squad.
 */
export function riskScore(roster) {
  const total = sum(roster, (r) => r.proj);
  if (total <= 0) return { score: 0, flagged: [] };
  const flagged = roster
    .filter((r) => (r.availability ?? 1) < 1)
    .sort((a, b) => b.proj * (1 - (b.availability ?? 1)) - a.proj * (1 - (a.availability ?? 1)));
  const score = sum(roster, (r) => r.proj * (1 - (r.availability ?? 1))) / total;
  return { score, flagged };
}

/**
 * Near-term schedule quality, expressed as a ratio rather than a raw total so
 * a strong squad with poor fixtures is distinguishable from a weak one.
 *
 * >1 means the next five gameweeks project better than this squad's own
 * season-long average rate. It is a fixture signal, not a quality signal.
 */
export function fixtureOutlook(roster, horizon, seasonLength) {
  const nearRate = sum(roster, (r) => r.nearTermValue) / horizon;
  const rosRate = sum(roster, (r) => r.proj) / seasonLength;
  return rosRate > 0 ? nearRate / rosRate : 1;
}

/** Every component for one squad, in real units. No scaling, no weighting. */
export function rateSquad(roster, { pool = [], horizon = 5, seasonLength = 38 } = {}) {
  const xiRos = bestXI(roster);
  const xiNear = bestXI(roster, (r) => r.nearTermValue);
  const depth = depthCost(roster);
  const vorp = squadVorp(roster, pool);
  const risk = riskScore(roster);

  const byPos = {};
  for (const t of [1, 2, 3, 4]) {
    const at = roster.filter((r) => r.element_type === t);
    byPos[t] = {
      count: at.length,
      quota: QUOTA[t],
      starters: STARTER_QUOTA[t],
      ros: sum(at, (r) => r.proj),
      // Only the players who would actually start; a fifth midfielder's points
      // are real but they are not in the XI most weeks.
      startersRos: sum(at.sort((a, b) => b.proj - a.proj).slice(0, STARTER_QUOTA[t]), (r) => r.proj),
    };
  }

  return {
    size: roster.length,
    ros: sum(roster, (r) => r.proj),
    nearTerm: sum(roster, (r) => r.nearTermValue),
    xi: { total: xiRos.total, players: xiRos.xi, bench: xiRos.bench },
    xiNear: { total: xiNear.total, players: xiNear.xi },
    byPos,
    depth,
    vorp,
    risk,
    fixtures: fixtureOutlook(roster, horizon, seasonLength),
  };
}

/**
 * Rank every squad in the league and produce the headline number.
 *
 * The headline is a weighted blend of each squad's PERCENTILE within this
 * league, not of raw points. Two reasons. Percentiles make components with
 * different units commensurable without inventing a conversion, and a league
 * rating should answer "how do I compare here", which is what a percentile is.
 * The cost is that ratings are only meaningful within one league and cannot be
 * compared across leagues — an acceptable trade for a six-manager draft.
 *
 * With six managers the percentile is coarse by construction. That is honest:
 * the underlying components are always shown alongside.
 */
export function rateLeague(rostersBySlot, { pool = [], horizon = 5, seasonLength = 38 } = {}) {
  const slots = [...rostersBySlot.keys()].sort((a, b) => a - b);
  const rated = slots.map((slot) => ({
    slot,
    components: rateSquad(rostersBySlot.get(slot) || [], { pool, horizon, seasonLength }),
  }));
  if (!rated.length) return [];

  // Higher is better for every axis except risk, which is inverted here so one
  // ranking direction applies throughout.
  const axes = {
    xi: (c) => c.xi.total,
    ros: (c) => c.ros,
    depth: (c) => -c.depth.perAbsence,
    vorp: (c) => c.vorp.total,
    risk: (c) => -c.risk.score,
  };

  const pct = {};
  for (const [name, get] of Object.entries(axes)) {
    const vals = rated.map((r) => get(r.components));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    pct[name] = vals.map((v) => (hi === lo ? 0.5 : (v - lo) / (hi - lo)));
  }

  rated.forEach((r, i) => {
    r.percentiles = Object.fromEntries(Object.keys(axes).map((k) => [k, pct[k][i]]));
    r.rating = Math.round(
      100 * Object.entries(RATING_WEIGHTS).reduce((s, [k, w]) => s + w * (r.percentiles[k] ?? 0), 0),
    );
  });

  // Positional ranks, which is what "your midfield is 1st" actually means.
  for (const t of [1, 2, 3, 4]) {
    const order = [...rated].sort((a, b) => b.components.byPos[t].startersRos - a.components.byPos[t].startersRos);
    order.forEach((r, i) => { (r.posRank ||= {})[t] = i + 1; });
  }
  const byRating = [...rated].sort((a, b) => b.rating - a.rating || b.components.xi.total - a.components.xi.total);
  byRating.forEach((r, i) => { r.rank = i + 1; });
  const byXI = [...rated].sort((a, b) => b.components.xi.total - a.components.xi.total);
  byXI.forEach((r, i) => { r.xiRank = i + 1; });
  const byDepth = [...rated].sort((a, b) => a.components.depth.perAbsence - b.components.depth.perAbsence);
  byDepth.forEach((r, i) => { r.depthRank = i + 1; });

  return byRating;
}
