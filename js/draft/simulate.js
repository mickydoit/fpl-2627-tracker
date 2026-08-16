/**
 * Survival probability across the snake gap.
 *
 * Because the live board is read exactly, there is no need to simulate a whole
 * draft — only the opponent picks that fall between one of my turns and the
 * next. Opponents are modelled as drafting near the top of the board by the
 * game's own draft_rank, with enough noise to represent real managers being
 * idiosyncratic.
 */

/** Deterministic LCG. Same seed, same board, every time. */
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** How many opponents pick before my next turn. */
export function picksBetween(currentPick, myPicks) {
  const next = myPicks.find((p) => p > currentPick);
  return next === undefined ? Infinity : next - currentPick - 1;
}

/**
 * Probability each available player is still there after `opponentPicks` more
 * selections.
 *
 * The opponent model: sort what is left by draft_rank, then pick from the top
 * `greed` candidates with probability falling off geometrically. `greed` is
 * the width of the window a typical manager chooses within — 1 would make
 * every manager a robot following the rankings exactly.
 */
export function survival(available, opponentPicks, { seed = 12345, trials = 400, greed = 3 } = {}) {
  const out = new Map(available.map((r) => [r.id, 0]));
  if (!Number.isFinite(opponentPicks) || opponentPicks <= 0) {
    for (const r of available) out.set(r.id, 1);
    return out;
  }
  const ranked = [...available].sort(
    (a, b) => (a.draft_rank || 9999) - (b.draft_rank || 9999));
  const rng = makeRng(seed);

  for (let t = 0; t < trials; t++) {
    const gone = new Set();
    for (let k = 0; k < opponentPicks; k++) {
      // Candidates = the top few still on the board.
      const window = [];
      for (const r of ranked) {
        if (gone.has(r.id)) continue;
        window.push(r);
        if (window.length >= greed) break;
      }
      if (!window.length) break;
      // Geometric-ish choice within the window.
      let idx = 0;
      while (idx < window.length - 1 && rng() > 0.55) idx++;
      gone.add(window[idx].id);
    }
    for (const r of available) if (!gone.has(r.id)) out.set(r.id, out.get(r.id) + 1);
  }
  for (const [id, n] of out) out.set(id, n / trials);
  return out;
}
