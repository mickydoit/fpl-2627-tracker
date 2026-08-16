/**
 * The pick recommendation.
 *
 * Ranking by value alone drafts the best player; ranking by value net of what
 * you could still get next turn drafts the player who will not come back. The
 * second is the decision actually in front of you.
 */
import { survival, picksBetween } from './simulate.js';
import { positionsNeeded } from './live.js';

/**
 * Score every available player by VORP net of the opportunity cost of passing.
 *
 * netValue = vorp - E[best vorp at this position still available next turn]
 *
 * A player certain to survive scores near zero: passing costs nothing. A
 * player certain to be gone scores his full VORP over the next man up.
 */
export function recommend(available, {
  myPicks, currentPick, roster = [], seed = 12345, trials = 400,
} = {}) {
  const need = positionsNeeded(roster);
  const eligible = available.filter((r) => (need[r.element_type] ?? 0) > 0);
  const gap = picksBetween(currentPick, myPicks || []);
  const surv = survival(eligible, gap, { seed, trials });

  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of eligible) byPos[r.element_type].push(r);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.vorp - a.vorp);

  return eligible
    .map((r) => {
      const p = surv.get(r.id) ?? 0;
      // What I would expect to hold at this position next turn if I pass now:
      // each rival candidate weighted by the chance he is still there.
      const alternatives = byPos[r.element_type].filter((o) => o.id !== r.id);
      let expectedNext = 0;
      let carried = 1;
      for (const alt of alternatives) {
        const ps = surv.get(alt.id) ?? 0;
        expectedNext += carried * ps * alt.vorp;
        carried *= 1 - ps;
        if (carried < 1e-6) break;
      }
      // Passing only costs me when he does not survive.
      const netValue = r.vorp - (p * r.vorp + (1 - p) * expectedNext);
      return { ...r, survivalP: p, netValue };
    })
    .sort((a, b) => b.netValue - a.netValue || b.vorp - a.vorp);
}
