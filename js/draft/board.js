/**
 * Draft board maths: whose turn it is, what a position is worth, and what
 * "worth" means once you account for who you could get instead.
 */

/** Squad quotas — identical to the main game. */
export const DRAFT_QUOTA = { 1: 2, 2: 5, 3: 5, 4: 3 };

/**
 * The pick numbers belonging to one slot in a snake draft.
 * Odd rounds run 1..N, even rounds run N..1.
 */
export function snakePicks(leagueSize, slot, rounds = 15) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * leagueSize + slot : r * leagueSize - slot + 1);
  }
  return out;
}

/**
 * The rank of the first player at a position who will still be unowned once
 * the league has drafted its fill. This is the player you are really choosing
 * against, which is why raw projection is the wrong ranking.
 */
export function replacementRank(leagueSize, elementType) {
  return leagueSize * DRAFT_QUOTA[elementType] + 1;
}

/**
 * Attach VORP to every row and report the replacement level per position.
 * Rows must already carry a `proj` number.
 */
export function buildBoard(rows, leagueSize) {
  const replacement = {};
  for (const type of [1, 2, 3, 4]) {
    const atPos = rows
      .filter((r) => r.element_type === type)
      .sort((a, b) => b.proj - a.proj);
    const idx = replacementRank(leagueSize, type) - 1;
    replacement[type] = atPos[idx]?.proj ?? (atPos[atPos.length - 1]?.proj ?? 0);
  }
  const out = rows
    .map((r) => ({ ...r, vorp: r.proj - replacement[r.element_type] }))
    .sort((a, b) => b.vorp - a.vorp);
  return { rows: out, replacement };
}
