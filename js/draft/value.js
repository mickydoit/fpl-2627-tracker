/**
 * The draft decision score.
 *
 * "How good is this player" and "how important is it that I take him NOW" are
 * different questions. The first is a projection; the second accounts for who
 * else I could still get, how fast his position is drying up, and whether he
 * will survive until my next turn.
 *
 * Every component is computed and returned separately — for the UI, for the
 * diagnostics, and so that a bad recommendation can be traced to the term that
 * caused it rather than to one opaque number.
 */
import { DRAFT_CONFIG, ROUNDS } from './config.js';
import { scarcityByPosition, allowedPositions } from './scarcity.js';
import { survival } from './simulate.js';

const POS_NAME = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/**
 * Blend rest-of-season against near-term value. A first-round pick is a
 * season-long asset, so ROS dominates early; by the final rounds the marginal
 * player's short-term role matters relatively more.
 */
function blendHorizons(row, round, rounds = ROUNDS) {
  const t = Math.min(1, Math.max(0, (round - 1) / (rounds - 1)));
  const nearWeight = DRAFT_CONFIG.nearTermWeight * t;
  const rosWeight = DRAFT_CONFIG.rosWeight * (1 - t) + DRAFT_CONFIG.rosWeight * t * (1 - DRAFT_CONFIG.nearTermWeight);
  const ros = row.rosValue ?? row.proj ?? 0;
  const near = row.nearTermValue ?? 0;
  // Scale the near-term number onto the ROS scale before blending so the two
  // are comparable rather than the shorter horizon being structurally smaller.
  const nearScaled = near * (DRAFT_CONFIG.rosHorizon / DRAFT_CONFIG.nearTermHorizon);
  return (ros * rosWeight + nearScaled * nearWeight) / (rosWeight + nearWeight || 1);
}

/**
 * The scarcity component of the decision score.
 *
 * Derived from the position's relative LABEL (HIGH/MEDIUM/LOW), not from the
 * raw supply:demand ratio — see `DRAFT_CONFIG.scarcityLabelWeights` for why.
 */
function scarcityScoreFor(sc) {
  return DRAFT_CONFIG.scarcityLabelWeights[sc.label] ?? DRAFT_CONFIG.scarcityLabelWeights.LOW;
}

export function evaluate(available, ctx) {
  const {
    replacement = {}, demand = {}, needs = {}, picksRemaining = 15,
    opponentPicksBeforeMyNext = 0, round = 1, leagueSize = 8,
  } = ctx;

  const allowed = new Set(allowedPositions(needs, picksRemaining));
  const eligible = available.filter((r) => allowed.has(r.element_type));
  if (!eligible.length) return [];

  const forced = allowed.size === 1;
  const scarcity = ctx.scarcity || scarcityByPosition(eligible, demand, { leagueSize });
  const surv = survival(eligible, opponentPicksBeforeMyNext, {
    seed: DRAFT_CONFIG.survivalSeed,
    trials: DRAFT_CONFIG.survivalTrials,
    greed: DRAFT_CONFIG.opponentGreed,
  });

  // The best alternative still standing at each position if I pass now.
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of eligible) byPos[r.element_type].push(r);
  for (const t of Object.keys(byPos)) byPos[t].sort((a, b) => (b.proj ?? 0) - (a.proj ?? 0));

  const scored = eligible.map((row) => {
    const projectedPoints = row.proj ?? 0;
    const rosValue = row.rosValue ?? projectedPoints;
    const nearTermValue = row.nearTermValue ?? 0;
    const blended = blendHorizons(row, round);
    const vorp = blended - (replacement[row.element_type] ?? 0);

    const sc = scarcity[row.element_type] || { ratio: Infinity, beforeCliff: 0, available: 0, demand: 0, label: 'LOW' };
    const scarcityScore = scarcityScoreFor(sc);

    const survivalP = surv.get(row.id) ?? 1;

    /* Opportunity cost: what I expect to hold at this position next turn if I
       pass, each alternative weighted by the chance he is still there. */
    let expectedNext = 0;
    let carried = 1;
    for (const alt of byPos[row.element_type]) {
      if (alt.id === row.id) continue;
      const ps = surv.get(alt.id) ?? 0;
      const altVorp = blendHorizons(alt, round) - (replacement[alt.element_type] ?? 0);
      expectedNext += carried * ps * altVorp;
      carried *= 1 - ps;
      if (carried < DRAFT_CONFIG.urgencyCarriedCutoff) break;
    }
    const urgency = Math.max(0, vorp - (survivalP * vorp + (1 - survivalP) * expectedNext));

    const rosterNeed = (needs[row.element_type] ?? 0) / 5;

    const avail = row.availability ?? 1;
    const unproven = Math.max(0, 1 - (row.minutes ?? 0) / DRAFT_CONFIG.minutesConfidence);
    const risk = (1 - avail) * DRAFT_CONFIG.availabilityPenalty + unproven * DRAFT_CONFIG.unprovenWeight;

    const draftValue =
      vorp * DRAFT_CONFIG.vorpWeight
      + scarcityScore * DRAFT_CONFIG.scarcityWeight * Math.abs(vorp)
      + urgency * DRAFT_CONFIG.urgencyWeight
      + rosterNeed * DRAFT_CONFIG.rosterNeedWeight * Math.abs(vorp)
      - risk * DRAFT_CONFIG.riskWeight * Math.abs(vorp);

    return {
      ...row,
      projectedPoints, rosValue, nearTermValue,
      vorp, scarcity: scarcityScore, survival: survivalP,
      rosterNeed, risk, draftValue,
      reasons: buildReasons({ row, vorp, sc, survivalP, urgency, risk, needs, forced, opponentPicksBeforeMyNext }),
    };
  });

  return scored.sort((a, b) => b.draftValue - a.draftValue || b.vorp - a.vorp);
}

/**
 * Explanations generated from the same numbers that produced the ranking, so
 * the two cannot drift apart. Each answers one of: why this player, why this
 * position, why now.
 */
function buildReasons({ row, vorp, sc, survivalP, urgency, risk, needs, forced, opponentPicksBeforeMyNext }) {
  const out = [];
  const pos = POS_NAME[row.element_type];

  out.push({ kind: 'value', text: `+${vorp.toFixed(0)} ROS points above ${pos} replacement` });

  // `sc.beforeCliff` (from playersBeforeCliff) is not used here: it degenerates
  // on large pools — one outsized gap at the top dominates the standard
  // deviation and can return a tiny count almost regardless of real depth. It
  // stays available as a diagnostic on `sc`, just not asserted as a fact to
  // the user. Only the relative label and the demand/survival numbers we
  // trust drive this copy.
  if (sc.label === 'HIGH') {
    let text = `${pos} is currently high scarcity — ${sc.demand} ${pos} slots are still required league-wide`;
    if (survivalP < DRAFT_CONFIG.scarcitySurvivalReasonThreshold) {
      text += ', and comparable options are less likely to remain until your next pick';
    }
    out.push({ kind: 'scarcity', text });
  } else if (sc.label === 'LOW') {
    out.push({ kind: 'scarcity', text: `${pos} is deep — ${sc.available} comparable options remain` });
  }

  if (Number.isFinite(opponentPicksBeforeMyNext) && opponentPicksBeforeMyNext > 0) {
    out.push({
      kind: 'timing',
      text: `${Math.round(survivalP * 100)}% chance he lasts the ${opponentPicksBeforeMyNext} picks before your next turn`,
    });
  }

  if (urgency > DRAFT_CONFIG.urgencyReasonThreshold) {
    out.push({ kind: 'urgency', text: `passing costs about ${urgency.toFixed(0)} points against the best likely alternative` });
  }

  if (forced) {
    out.push({ kind: 'constraint', text: `you must fill ${pos} with your remaining picks — no other position is legal` });
  } else if ((needs[row.element_type] ?? 0) > 0) {
    out.push({ kind: 'need', text: `you still need ${needs[row.element_type]} ${pos}` });
  }

  if (risk > DRAFT_CONFIG.riskReasonThreshold) {
    out.push({ kind: 'risk', text: row.news ? `availability risk — ${row.news}` : 'availability or minutes risk' });
  }

  return out;
}
