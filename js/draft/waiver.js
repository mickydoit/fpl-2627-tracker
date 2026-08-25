/**
 * Draft season transactions — is any free agent worth a roster move?
 *
 * The post-draft counterpart to js/draft/advise.js, and deliberately a separate
 * decision problem. Draft night asks "who should I take, given who survives to
 * my next pick"; this asks "given the roster I own and the wire as it stands,
 * does any single add-drop make my team better". The two share projections and
 * nothing else — scarcity-to-next-pick has no meaning once the draft is over,
 * and HOLD logic has no place while the board is live.
 *
 * It borrows the shape of the Classic transfer adviser, because the shape is
 * about honesty rather than about Classic: evaluate the whole roster, agree
 * across horizons, require real evidence, and be willing to say no. It borrows
 * none of Classic's economics. There is no budget, no price, no captain, no
 * points hit and no banked transfer, so none of those appear here.
 *
 * **The Draft opportunity cost is different and larger.** A Classic transfer is
 * reversible next week for another transfer. Dropping a player in Draft hands
 * him to a league of rivals with unique ownership: if he is claimed you cannot
 * buy him back at any price. That asymmetry, not a points hit, is what the
 * incumbent advantage below is modelling.
 */
import { DRAFT_CONFIG } from './config.js';

export const WAIVER_CONFIG = {
  /**
   * Below this rest-of-season gain, a move is inside the model's own error.
   * Expressed over the planning horizon, like every other figure here.
   */
  negligible: 2.0,
  /** At or above this, a move can be recommended when confidence allows. */
  meaningful: 5.0,
  /** At or above this, and agreeing across horizons, a move is strong. */
  strong: 12.0,

  /**
   * What keeping the player you already own is worth, in projected points.
   *
   * Not a transfer cost — Draft has none. This is the price of irreversibility.
   * A dropped player enters a pool of managers who can claim him permanently,
   * and unique ownership means there is no market to buy him back from. A move
   * therefore has to beat the incumbent by enough to justify never being able
   * to undo it, which is a higher bar than Classic's, where the same player can
   * usually be bought again next week.
   */
  incumbentEdge: 3.0,

  /**
   * Extra margin required when the outgoing player is scarce at his position.
   *
   * Dropping the last startable goalkeeper is not the same decision as dropping
   * a fifth midfielder, even when the projections match. Scaled by how thin the
   * free-agent pool is at that position.
   */
  scarcityMargin: 4.0,

  /** Below this share of evidence, a projection is mostly a prior. */
  evidenceFloor: 0.5,

  /** Horizons a move must survive. */
  horizons: [1, 3, 5, 8],
  /** The one a recommendation is planned on. */
  planning: 5,
};

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The strongest legal Draft XI. No captain — Draft does not have one.
 *
 * Same formation rules as the main game: one keeper, at least three defenders,
 * two midfielders and one forward, eleven in total. The reserve keeper can
 * never start, so he is bench by construction rather than by rule.
 */
export function draftXI(roster, value = (r) => r.proj) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of roster) byPos[p.element_type]?.push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => value(b) - value(a));

  const min = { 1: 1, 2: 3, 3: 2, 4: 1 };
  const max = { 1: 1, 2: 5, 3: 5, 4: 3 };
  const xi = [];
  const used = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of [1, 2, 3, 4]) {
    for (const p of byPos[t].slice(0, min[t])) { xi.push(p); used[t] += 1; }
  }
  const rest = [];
  for (const t of [1, 2, 3, 4]) rest.push(...byPos[t].slice(used[t]));
  rest.sort((a, b) => value(b) - value(a));
  for (const p of rest) {
    if (xi.length >= 11) break;
    if (used[p.element_type] >= max[p.element_type]) continue;
    xi.push(p); used[p.element_type] += 1;
  }
  const bench = roster.filter((p) => !xi.includes(p));
  return { xi, bench, total: sum(xi, value), formation: `${used[2]}-${used[3]}-${used[4]}` };
}

/**
 * What the roster is worth, for the purpose of comparing two rosters.
 *
 * The starting eleven, plus the bench at a discount because only eleven score
 * and a bench player is worth what he might be promoted into. No captain
 * doubling: Draft has no captain, and adding one would silently import the
 * single biggest piece of Classic scoring into a game that does not have it.
 */
export function rosterValue(roster, value = (r) => r.proj, benchWeight = 0.15) {
  const { xi, bench } = draftXI(roster, value);
  return sum(xi, value) + sum(bench, value) * benchWeight;
}

/**
 * How thin the wire is at one position, 0 (deep) to 1 (bare).
 *
 * Compares the best available free agent at that position with what the roster
 * already starts there. A position where the wire offers nothing close is one
 * you cannot afford to drop from.
 */
export function positionScarcity(freeAgents, roster, type, value = (r) => r.proj) {
  const wire = freeAgents.filter((p) => p.element_type === type).sort((a, b) => value(b) - value(a));
  const owned = roster.filter((p) => p.element_type === type).sort((a, b) => value(b) - value(a));
  if (!owned.length) return 1;
  const bestOwned = value(owned[0]);
  if (!(bestOwned > 0)) return 1;
  const bestWire = wire.length ? value(wire[0]) : 0;
  return clamp(1 - bestWire / bestOwned, 0, 1);
}

/** Agreement across horizons is what stops a move that only works at one. */
function crossHorizon(gainAt, horizons) {
  const gains = horizons.map((h) => ({ horizon: h, gain: gainAt(h) }));
  const positive = gains.filter((g) => g.gain > 0).length;
  return {
    gains,
    allPositive: positive === gains.length,
    anyNegative: gains.some((g) => g.gain < 0),
    agreement: positive / gains.length,
  };
}

/**
 * Classify one add-drop.
 *
 * Order matters: a move is disqualified before it is praised. Size alone never
 * earns a recommendation — it has to survive the other horizons, clear the cost
 * of giving up ownership permanently, and rest on evidence.
 */
export function classifyWaiver({ gain, cross, scarcity = 0, evidence = 1, outRisk = 0, cfg = WAIVER_CONFIG }) {
  const bar = cfg.incumbentEdge + scarcity * cfg.scarcityMargin;
  const net = gain - bar;
  const reasons = [];

  if (gain < cfg.negligible) {
    reasons.push(`the difference is inside the model's own error`);
    return { verdict: 'HOLD', confidence: 'LOW', net, bar, reasons };
  }
  if (cross.anyNegative) {
    const bad = cross.gains.find((g) => g.gain < 0);
    reasons.push(`it is worse over ${bad.horizon} gameweek${bad.horizon === 1 ? '' : 's'}, so it does not hold up across horizons`);
    return { verdict: 'HOLD', confidence: 'LOW', net, bar, reasons };
  }
  if (net <= 0) {
    reasons.push(scarcity > 0.3
      ? 'the gain does not cover giving up a player the wire cannot replace'
      : 'the gain does not cover losing this player permanently');
    return { verdict: 'HOLD', confidence: 'MEDIUM', net, bar, reasons };
  }
  if (gain < cfg.meaningful) {
    reasons.push('a real edge, but not enough to spend a roster spot on');
    return { verdict: 'WATCH', confidence: 'MEDIUM', net, bar, reasons };
  }

  reasons.push(`projects +${gain.toFixed(1)} over ${cfg.planning} gameweeks`);
  if (cross.allPositive) reasons.push('the advantage holds at every horizon tested');
  if (outRisk > 0.3) reasons.push('the player being dropped is carrying an availability flag');
  if (scarcity > 0.5) reasons.push('the wire is thin at this position, so the move is hard to undo');

  const strong = gain >= cfg.strong && cross.allPositive;
  let verdict = strong ? 'STRONG ADD' : 'GOOD ADD';
  let confidence = strong ? 'HIGH' : 'MEDIUM';

  /* Evidence is a separate axis from size. It cannot rescue a small gain and it
     does not shrink a large one — it decides how far to trust either.
     
     In Draft it also caps the verdict outright, which is stronger than the
     Classic adviser does, and deliberately so. The shared model applies a
     player's prior at full weight for every fixture while scaling his modelled
     components by expected minutes, so a player with no minutes at all is
     projected as a nailed starter and can out-project a proven one. Classic
     rarely shows this because its prior is a modest function of price; Draft's
     is a function of draft rank, and a highly ranked player who has not kicked
     a ball can top the board. Until that asymmetry is fixed in the model, a
     prior-heavy projection is not evidence enough to give away a player
     permanently — so it can be watched, never claimed. */
  if (evidence < cfg.evidenceFloor) {
    confidence = 'LOW';
    verdict = 'WATCH';
    reasons.push(`held at WATCH: the incoming player's projection is `
      + `${Math.round((1 - evidence) * 100)}% prior rather than his own football, and a Draft `
      + `drop cannot be undone`);
  }

  return { verdict, confidence, net, bar, reasons, evidence };
}

/**
 * The best add-drops available, ranked, one row per player being ADDED.
 *
 * The old version returned exactly one, on the reasoning that a list of
 * marginal claims invites you to make all of them and every one costs a
 * player permanently. That reasoning is still right, and it is now carried by
 * the verdict rather than by the length of the list: HOLD rows are dropped
 * instead of padding the list out, so a quiet wire still shows one line or
 * none. What a waiver list has to answer is "who is worth claiming", and on
 * waiver day you submit an ordered set of claims, not one.
 *
 * Deduplicated on the player coming in, for the same reason as the classic
 * side: five rows differing only in who you drop are one suggestion.
 *
 * @param {object[]} roster    the manager's own players, projected
 * @param {object[]} freeAgents unowned players, projected
 * @param {(h:number)=>Map}  rowsAt  id -> projected row at horizon h
 */
export function topWaivers(roster, freeAgents, rowsAt, { cfg = WAIVER_CONFIG, maxCandidates = 40, limit = 5 } = {}) {
  if (!roster?.length || !freeAgents?.length) return [];

  const base = rosterValue(roster);
  const ids = roster.map((p) => p.id);

  /* Candidates: only moves that could plausibly matter. Every free agent
     against every roster player is 15 x hundreds and mostly obvious rubbish. */
  /* Unique ownership is the whole basis of Draft, so a player already on this
     roster is not an add — and offering one would build an illegal roster with
     him in it twice. Filtered here rather than trusted from the caller. */
  const ownHere = new Set(ids);
  const wire = [...freeAgents]
    .filter((p) => !ownHere.has(p.id))
    .sort((a, b) => b.proj - a.proj)
    .slice(0, maxCandidates);
  if (!wire.length) return [];
  const moves = [];
  for (const inc of wire) {
    for (const out of roster) {
      // Draft rosters are fixed 2/5/5/3, so a swap has to keep the shape.
      if (out.element_type !== inc.element_type) continue;
      const trial = roster.filter((p) => p.id !== out.id).concat(inc);
      const gain = rosterValue(trial) - base;
      if (gain <= 0) continue;
      moves.push({ out, in: inc, gain });
    }
  }
  if (!moves.length) return [];
  moves.sort((a, b) => b.gain - a.gain);

  const bestPerAdd = new Map();
  for (const m of moves) if (!bestPerAdd.has(m.in.id)) bestPerAdd.set(m.in.id, m);
  const distinct = [...bestPerAdd.values()];

  const gainAtFor = (move) => (h) => {
    const at = rowsAt(h);
    if (!at) return 0;
    const sq = ids.map((id) => at.get(id)).filter(Boolean);
    const inc = at.get(move.in.id);
    const out = at.get(move.out.id);
    if (sq.length !== roster.length || !inc || !out) return 0;
    const trial = sq.filter((p) => p.id !== move.out.id).concat(inc);
    return rosterValue(trial) - rosterValue(sq);
  };

  const scored = distinct.slice(0, Math.max(12, limit * 3)).map((move) => {
    const cross = crossHorizon(gainAtFor(move), cfg.horizons);
    const planning = cross.gains.find((g) => g.horizon === cfg.planning)?.gain ?? move.gain;
    const scarcity = positionScarcity(freeAgents, roster, move.out.element_type);
    const evidence = move.in.evidence ?? move.in.parts?.evidence ?? 1;
    const outRisk = 1 - (move.out.availability ?? 1);
    return {
      move, cross, gain: planning, scarcity,
      ...classifyWaiver({ gain: planning, cross, scarcity, evidence, outRisk, cfg }),
    };
  });

  const rank = { 'STRONG ADD': 3, 'GOOD ADD': 2, WATCH: 1, HOLD: 0 };
  scored.sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.net - a.net);
  /* Ranked, each carrying its own verdict — see the note on the classic side.
     A Draft drop is permanent, so the verdict on a row matters more here than
     anywhere: the list is a priority order for claims, not five things to do. */
  return scored.slice(0, limit);
}

/** The single best add-drop, or nothing. Kept for callers wanting one answer. */
export function bestWaiver(roster, freeAgents, rowsAt, opts = {}) {
  return topWaivers(roster, freeAgents, rowsAt, opts)[0] ?? null;
}
