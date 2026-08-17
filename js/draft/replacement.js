/**
 * Replacement level and VORP.
 *
 * The player you are really choosing against is not the best available and not
 * the worst in the database — it is the player sitting at the edge of what the
 * league still has to fill at that position. In an eight-manager league there
 * are 24 forward slots; once 16 forwards are gone and 8 slots remain
 * outstanding, the ninth-best forward left (the first one nobody needs) is
 * the baseline. Everyone beyond that point is free.
 *
 * It has to be recomputed after every pick. A baseline fixed before the draft
 * makes VORP meaningless by the second round.
 */
import { QUOTA, STARTER_QUOTA, DRAFT_CONFIG, LEAGUE_SIZE_DEFAULT } from './config.js';

const TYPES = [1, 2, 3, 4];

/**
 * How many slots at each position the whole league still has to fill.
 * @param {Map<number, number[]>} rosters slot -> element ids
 * @param {Map<number, number>|object} types element id -> element_type
 */
export function outstandingDemand(rosters, leagueSize, types) {
  const out = {};
  for (const t of TYPES) out[t] = QUOTA[t] * leagueSize;
  const typeOf = (id) => (types.get ? types.get(id) : types[id]);
  for (const ids of rosters.values()) {
    for (const id of ids) {
      const t = typeOf(id);
      if (out[t] > 0) out[t] -= 1;
    }
  }
  return out;
}

/**
 * The projected points of the replacement-level player at each position.
 *
 * `basis: 'demand'` uses outstanding league-wide roster demand — the default,
 * and the one that responds to the draft. `basis: 'starters'` measures against
 * starting slots only, which stops bench positions earning early picks; it is
 * kept for comparison in the diagnostics.
 */
export function replacementLevel(rows, demand, { basis = DRAFT_CONFIG.replacementBasis, leagueSize = LEAGUE_SIZE_DEFAULT } = {}) {
  const out = {};
  for (const t of TYPES) {
    const pool = rows
      .filter((r) => r.element_type === t)
      .sort((a, b) => b.proj - a.proj);
    if (!pool.length) { out[t] = 0; continue; }

    const edge = basis === 'starters'
      ? STARTER_QUOTA[t] * leagueSize
      : (demand?.[t] ?? pool.length);

    // The player just past the edge of demand is the first one nobody needs.
    const idx = Math.max(0, Math.min(pool.length - 1, edge));
    out[t] = pool[idx].proj;
  }
  return out;
}

/** Attach VORP to every row. Rows must already carry `proj`. */
export function attachVorp(rows, replacement) {
  return rows.map((r) => ({ ...r, vorp: r.proj - (replacement[r.element_type] ?? 0) }));
}
