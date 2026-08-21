/**
 * Classic FPL transfer advice.
 *
 * The optimiser answers "what is the strongest fifteen under the budget". This
 * answers a different and much narrower question: **given the squad you own and
 * the one free transfer you get this week, is any single move worth making?**
 *
 * Most weeks the honest answer is no, and saying so is the point. A free
 * transfer can be banked, so a move has to beat three things, not one: the
 * player you already own, the model's own error, and the option value of
 * keeping the transfer. Treating a free transfer as costless because it carries
 * no points hit is how you end up churning a squad for +0.4 a week.
 *
 * Nothing here touches Draft. Draft has its own squad, its own pool and its own
 * decision engine.
 */

/**
 * Every threshold the advice depends on, named and documented, so it can be
 * tuned from evidence rather than by editing logic.
 *
 * The gain figures are in projected points over the standard five-gameweek
 * horizon. They were set against the real player pool: at £0.0m in the bank the
 * best available move scored +0.49 and the entire legal move set topped out
 * below +1.0, while genuine upgrades appeared at +3.9 and above the moment
 * money was available. A bar at 3.0 therefore separates the two populations
 * rather than splitting one arbitrarily.
 */
export const TRANSFER_CONFIG = {
  /** Below this, a move is inside the model's own error. Always HOLD. */
  negligible: 1.5,
  /** Below this, a move is real but not worth a transfer on its own. */
  marginal: 3.0,
  /** At or above this, a move can be recommended if confidence allows. */
  meaningful: 3.0,
  /** At or above this, and agreeing across horizons, a move is strong. */
  strong: 6.0,

  /**
   * What banking the transfer is worth.
   *
   * A saved transfer buys flexibility next week — to react to an injury, or to
   * pair with another move. It is not free to spend, so its value is added to
   * the bar every move must clear.
   */
  bankedTransferValue: 1.0,

  /**
   * Extra margin required above a points hit, on top of the hit itself.
   *
   * Requiring only `gain > 4` for a −4 leaves no room for the projection being
   * wrong, and the projection is often wrong by more than that.
   */
  hitMargin: 2.0,

  /**
   * The incumbent's advantage, in points.
   *
   * Hysteresis: a player already in the squad keeps a small edge, so two
   * near-identical players cannot swap back and forth as the data twitches. It
   * is the modelled cost of churn, and it is why the same comparison does not
   * flip from week to week.
   */
  incumbentEdge: 0.75,

  /** Horizons a move must survive to be trusted. */
  horizons: [3, 5, 8],
};

/**
 * Which horizon to plan on, and why.
 *
 * Not a fixed number: the right horizon depends on the decision. A short
 * absence is a two-or-three gameweek problem; losing a starting place is a
 * season-long one. Returned with its reason so the page can explain itself.
 */
export function recommendedHorizon({ squad = [], freeTransfers = 1 } = {}) {
  const flagged = squad.filter((p) => p.status && p.status !== 'a');
  const longTerm = flagged.filter((p) => (p.chance_of_playing_next_round ?? 100) === 0);

  if (longTerm.length) {
    return { horizon: 8, why: `${longTerm[0].web_name} has no return date, so the decision is a long one — judge it over 8 gameweeks.` };
  }
  if (flagged.length) {
    return { horizon: 3, why: `${flagged[0].web_name} is a short-term doubt; 3 gameweeks is the window that actually matters.` };
  }
  if (freeTransfers >= 3) {
    return { horizon: 8, why: 'With transfers banked you are making a structural change, not a weekly one — 8 gameweeks is the right frame.' };
  }
  return { horizon: 5, why: 'A standard weekly free transfer. Five gameweeks is long enough to see a fixture run and short enough that roles are still knowable.' };
}

/**
 * Score one candidate move across every horizon.
 *
 * @param {(h:number)=>number} gainAt squad-level gain at that horizon
 */
function crossHorizon(gainAt, horizons) {
  const gains = horizons.map((h) => ({ horizon: h, gain: gainAt(h) }));
  const positive = gains.filter((g) => g.gain > 0).length;
  return {
    gains,
    /** Agreement is what stops a move that only works at one horizon. */
    agreement: positive / gains.length,
    allPositive: positive === gains.length,
    anyNegative: gains.some((g) => g.gain < 0),
  };
}

/**
 * Classify a move.
 *
 * The order matters: a move is disqualified before it is praised. Size alone
 * never earns a recommendation — it has to survive the other horizons too.
 */
export function classify({ gain, cross, hit = 0, incumbentRisk = 0, cfg = TRANSFER_CONFIG }) {
  // The bar: the model's error, plus the value of the transfer being banked,
  // plus the incumbent's edge, plus any hit and its safety margin.
  const bar = cfg.bankedTransferValue + cfg.incumbentEdge + (hit ? hit + cfg.hitMargin : 0);
  const net = gain - bar;

  const reasons = [];
  if (gain < cfg.negligible) {
    reasons.push(`the ${gain >= 0 ? 'edge' : 'difference'} is inside the model's own error`);
    return { verdict: 'HOLD', confidence: 'LOW', net, bar, reasons };
  }
  if (cross.anyNegative) {
    const bad = cross.gains.find((g) => g.gain < 0);
    reasons.push(`the move is worse over ${bad.horizon} gameweeks, so it does not hold up across horizons`);
    return { verdict: 'HOLD', confidence: 'LOW', net, bar, reasons };
  }
  if (net <= 0) {
    reasons.push(`the gain does not clear the value of banking the transfer${hit ? ' and the points hit' : ''}`);
    return { verdict: 'HOLD', confidence: 'MEDIUM', net, bar, reasons };
  }
  if (gain < cfg.meaningful) {
    reasons.push('a real edge, but not enough on its own to spend a transfer');
    return { verdict: 'WATCH', confidence: 'MEDIUM', net, bar, reasons };
  }

  reasons.push(`projects +${gain.toFixed(1)} over the planning horizon`);
  if (cross.allPositive) reasons.push('the advantage holds at every horizon tested');
  if (incumbentRisk > 0.3) reasons.push('the player being replaced is carrying an availability flag');

  const strong = gain >= cfg.strong && cross.allPositive;
  return {
    verdict: strong ? 'STRONG TRANSFER' : 'GOOD TRANSFER',
    confidence: strong ? 'HIGH' : 'MEDIUM',
    net,
    bar,
    reasons,
  };
}

/**
 * The single best thing to do this week, or nothing.
 *
 * Deliberately returns ONE candidate. A page that lists five marginal swaps
 * invites you to make all of them, which is precisely the behaviour a one-
 * transfer week cannot support.
 *
 * @param {object[]} singles suggestTransfers() output at the planning horizon
 * @param {(move:object,h:number)=>number} gainAt re-score a move at horizon h
 */
export function bestMove(singles, gainAt, { hit = 0, cfg = TRANSFER_CONFIG } = {}) {
  if (!singles?.length) return null;

  const scored = singles.slice(0, 12).map((move) => {
    const cross = crossHorizon((h) => gainAt(move, h), cfg.horizons);
    const planning = cross.gains.find((g) => g.horizon === 5)?.gain ?? move.gain;
    const incumbentRisk = 1 - (move.out.availability ?? 1);
    return {
      move,
      cross,
      gain: planning,
      ...classify({ gain: planning, cross, hit, incumbentRisk, cfg }),
    };
  });

  const rank = { 'STRONG TRANSFER': 3, 'GOOD TRANSFER': 2, WATCH: 1, HOLD: 0 };
  scored.sort((a, b) => rank[b.verdict] - rank[a.verdict] || b.net - a.net);
  return scored[0];
}
