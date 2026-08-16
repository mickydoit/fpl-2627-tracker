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

/**
 * Group each position's players into tiers, split where the gap to the next
 * player is unusually large. A tier boundary means "the drop after this one is
 * real" — the cue to take a player now rather than wait a round.
 */
export function assignTiers(rows, sdThreshold = 1.0) {
  const out = [];
  for (const type of [1, 2, 3, 4]) {
    const atPos = rows
      .filter((r) => r.element_type === type)
      .sort((a, b) => b.vorp - a.vorp);
    if (!atPos.length) continue;

    const gaps = [];
    for (let i = 1; i < atPos.length; i++) gaps.push(atPos[i - 1].vorp - atPos[i].vorp);
    const mean = gaps.reduce((s, g) => s + g, 0) / (gaps.length || 1);
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / (gaps.length || 1);
    const sd = Math.sqrt(variance);
    const cut = mean + sdThreshold * sd;

    let tier = 1;
    atPos.forEach((row, i) => {
      if (i > 0 && gaps[i - 1] > cut) tier++;
      out.push({ ...row, tier });
    });
  }
  return out;
}
