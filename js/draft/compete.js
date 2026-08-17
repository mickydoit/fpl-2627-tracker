/**
 * Whole-draft simulation, used only to prove the board is worth having.
 *
 * Every manager but me drafts by draft_rank with a little noise. I draft by
 * whichever strategy is under test. The score is the best legal XI I end up
 * with, since bench players contribute nothing directly in Draft.
 */
import { snakePicks, buildBoard } from './board.js';
import { positionsNeeded } from './live.js';
import { recommend } from './advise.js';
import { makeRng, picksBetween } from './simulate.js';
import { outstandingDemand, replacementLevel, attachVorp } from './replacement.js';
import { scarcityByPosition } from './scarcity.js';
import { evaluate } from './value.js';
import { ROUNDS } from './config.js';

/** Best legal XI from a 15: 1 GK, at least 3 DEF, 2 MID, 1 FWD, 11 total. */
function bestElevenTotal(roster) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of roster) byPos[p.element_type].push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj - a.proj);

  const min = { 1: 1, 2: 3, 3: 2, 4: 1 };
  const xi = [];
  for (const t of [1, 2, 3, 4]) xi.push(...byPos[t].slice(0, min[t]));
  const rest = [];
  for (const t of [2, 3, 4]) rest.push(...byPos[t].slice(min[t]));
  rest.sort((a, b) => b.proj - a.proj);
  xi.push(...rest.slice(0, 11 - xi.length));
  return xi.reduce((s, p) => s + p.proj, 0);
}

export const STRATEGIES = {
  /** Our board: VORP net of what survives to the next pick. */
  vorp: (pool, ctx) => recommend(pool, {
    myPicks: ctx.myPicks, currentPick: ctx.pick, roster: ctx.roster,
    seed: ctx.seed, trials: 120,
  })[0],
  /** Follow the game's own ranking, respecting quotas. */
  draftRank: (pool, ctx) => {
    const need = positionsNeeded(ctx.roster);
    return pool.filter((p) => need[p.element_type] > 0)
      .sort((a, b) => a.draft_rank - b.draft_rank)[0];
  },
  /** Highest raw projection, respecting quotas. */
  bestAvailable: (pool, ctx) => {
    const need = positionsNeeded(ctx.roster);
    return pool.filter((p) => need[p.element_type] > 0)
      .sort((a, b) => b.proj - a.proj)[0];
  },
  /**
   * The real decision engine: live outstanding demand -> replacement level ->
   * VORP -> scarcity -> the full decision score. Unlike `vorp` above (which
   * ranks off a VORP fixed once at draft start), this recomputes replacement
   * and scarcity fresh on every pick from the league's actual outstanding
   * demand, exactly as the live board does.
   */
  value: (pool, ctx) => {
    const { roster, pick, myPicks, rosters, leagueSize } = ctx;
    const types = new Map();
    for (const rows of rosters.values()) for (const r of rows) types.set(r.id, r.element_type);
    const idsBySlot = new Map([...rosters].map(([slot, rows]) => [slot, rows.map((r) => r.id)]));

    const demand = outstandingDemand(idsBySlot, leagueSize, types);
    const replacement = replacementLevel(pool, demand, { leagueSize });
    const withVorp = attachVorp(pool, replacement);
    const scarcity = scarcityByPosition(withVorp, demand, { leagueSize, replacement });

    const ranked = evaluate(withVorp, {
      replacement, demand, scarcity,
      needs: positionsNeeded(roster),
      picksRemaining: ROUNDS - roster.length,
      opponentPicksBeforeMyNext: picksBetween(pick, myPicks || []),
      round: Math.ceil(pick / leagueSize),
      leagueSize,
    });
    return ranked[0];
  },
};

/** Run one full snake draft and report what my strategy ended up with. */
export function runDraft(rows, { leagueSize = 6, mySlot = 3, strategy, seed = 12345 } = {}) {
  const { rows: board } = buildBoard(rows, leagueSize);
  const byId = new Map(board.map((r) => [r.id, r]));
  const myPicks = new Set(snakePicks(leagueSize, mySlot));
  const myPickList = snakePicks(leagueSize, mySlot);
  const rng = makeRng(seed);

  const taken = new Set();
  const rosters = new Map();
  for (let s = 1; s <= leagueSize; s++) rosters.set(s, []);

  const totalPicks = leagueSize * 15;
  for (let pick = 1; pick <= totalPicks; pick++) {
    const round = Math.ceil(pick / leagueSize);
    const inRound = pick - (round - 1) * leagueSize;
    const slot = round % 2 === 1 ? inRound : leagueSize - inRound + 1;
    const roster = rosters.get(slot);
    const pool = board.filter((r) => !taken.has(r.id));

    let choice;
    if (myPicks.has(pick)) {
      choice = strategy(pool, { myPicks: myPickList, pick, roster, seed, rosters, leagueSize });
    } else {
      const need = positionsNeeded(roster);
      const window = pool.filter((p) => need[p.element_type] > 0)
        .sort((a, b) => a.draft_rank - b.draft_rank).slice(0, 3);
      let idx = 0;
      while (idx < window.length - 1 && rng() > 0.55) idx++;
      choice = window[idx];
    }
    if (!choice) continue;
    taken.add(choice.id);
    roster.push(byId.get(choice.id));
  }

  const roster = rosters.get(mySlot);
  return { roster, total: bestElevenTotal(roster) };
}
