/**
 * Live draft state.
 *
 * The pick log is the single source of truth. Taken players, manager rosters,
 * the round, the current pick, remaining demand and my roster are all DERIVED
 * from it, never stored alongside it — so there is no second copy to fall out
 * of sync, and correcting a mis-entered pick fixes everything downstream at
 * once.
 *
 * Nothing here knows about leagues, entries or the Draft API. A draft is a
 * league size, a slot, and an ordered list of picks.
 */
import { QUOTA, ROUNDS, LEAGUE_SIZE_DEFAULT, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX } from './config.js';

export const SCHEMA_VERSION = 1;
const KEY = 'draftState.v1';
const LEGACY_KEYS = ['draftTaken', 'draftEntry'];

const clampSize = (n) => Math.max(LEAGUE_SIZE_MIN, Math.min(LEAGUE_SIZE_MAX, Math.round(n) || LEAGUE_SIZE_DEFAULT));

/** Which round an overall pick number falls in. One-indexed. */
export function roundForPick(overall, leagueSize) {
  return Math.floor((overall - 1) / leagueSize) + 1;
}

/**
 * Which slot owns an overall pick. Odd rounds run 1..N, even rounds N..1 —
 * this is the inverse of the snake pick list, and the two are asserted
 * consistent in the test suite.
 */
export function slotForPick(overall, leagueSize) {
  const round = roundForPick(overall, leagueSize);
  const indexInRound = overall - (round - 1) * leagueSize;
  return round % 2 === 1 ? indexInRound : leagueSize - indexInRound + 1;
}

/** Every overall pick number belonging to one slot. */
export function picksForSlot(leagueSize, slot, rounds = ROUNDS) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push(r % 2 === 1 ? (r - 1) * leagueSize + slot : r * leagueSize - slot + 1);
  }
  return out;
}

export function createDraft({ leagueSize = LEAGUE_SIZE_DEFAULT, mySlot = 1 } = {}) {
  const size = clampSize(leagueSize);
  return {
    version: SCHEMA_VERSION,
    leagueSize: size,
    mySlot: Math.max(1, Math.min(size, Math.round(mySlot) || 1)),
    log: [],
    finished: false,
  };
}

export function addPick(state, { elementId, mine = false }) {
  if (!Number.isFinite(elementId)) return state;
  return { ...state, log: [...state.log, { elementId, mine: !!mine }] };
}

export function undoLastPick(state) {
  if (!state.log.length) return state;
  return { ...state, log: state.log.slice(0, -1), finished: false };
}

/**
 * Correct an earlier pick in place. The board position is untouched — only who
 * was taken, and by whom, changes. Everything downstream recomputes.
 */
export function editPick(state, index, { elementId, mine }) {
  if (index < 0 || index >= state.log.length) return state;
  const log = state.log.map((p, i) => (i === index
    ? { elementId: Number.isFinite(elementId) ? elementId : p.elementId,
        mine: mine === undefined ? p.mine : !!mine }
    : p));
  return { ...state, log };
}

/** Remove a pick entirely, closing the gap. For a pick that never happened. */
export function removePick(state, index) {
  if (index < 0 || index >= state.log.length) return state;
  return { ...state, log: state.log.filter((_, i) => i !== index) };
}

/**
 * Everything the UI needs, computed from the log alone.
 *
 * `picksUntilMyTurn` is 0 when I am on the clock.
 * `opponentPicksBeforeMyNext` is how many rivals choose between my current
 * position and my next turn — the number the survival model needs.
 */
export function derive(state, types) {
  const { leagueSize, mySlot, log } = state;
  const taken = new Set();
  const rosters = new Map();
  const myRoster = [];

  log.forEach((pick, i) => {
    const overall = i + 1;
    const slot = pick.mine ? mySlot : slotForPick(overall, leagueSize);
    taken.add(pick.elementId);
    if (!rosters.has(slot)) rosters.set(slot, []);
    rosters.get(slot).push(pick.elementId);
    if (pick.mine) myRoster.push(pick.elementId);
  });

  const currentPick = log.length + 1;
  const round = roundForPick(currentPick, leagueSize);
  const onClockSlot = slotForPick(currentPick, leagueSize);

  const mine = picksForSlot(leagueSize, mySlot);
  const myNextPick = mine.find((p) => p >= currentPick) ?? null;
  const picksUntilMyTurn = myNextPick === null ? null : myNextPick - currentPick;
  const afterThis = mine.find((p) => p > currentPick) ?? null;
  // If I'm on the clock right now, currentPick is mine and afterThis looks
  // past it to my FOLLOWING turn, so it must be excluded from the opponent
  // count. Otherwise currentPick belongs to an opponent and counts too.
  const onClockNow = onClockSlot === mySlot;
  const opponentPicksBeforeMyNext = afterThis === null
    ? Infinity
    : afterThis - currentPick - (onClockNow ? 1 : 0);

  return {
    taken,
    rosters,
    myRoster,
    currentPick,
    round,
    onClockSlot,
    myNextPick,
    picksUntilMyTurn,
    opponentPicksBeforeMyNext,
    needs: needsFor(myRoster, types),
    picksRemaining: 15 - myRoster.length,
  };
}

/**
 * How many of each position I still need. Takes an optional id→element_type
 * map; without one it can only count, so the caller supplies types when the
 * board dataset is loaded.
 */
export function needsFor(roster, types) {
  const need = { ...QUOTA };
  if (!types) return need;
  for (const id of roster) {
    const t = types.get ? types.get(id) : types[id];
    if (need[t] > 0) need[t] -= 1;
  }
  return need;
}

/**
 * Close the draft. Nothing is discarded — the log stays intact, because the
 * season-long waiver assistant is built from exactly this state.
 */
export function finishDraft(state) {
  return { ...state, finished: true };
}

/**
 * The Phase 2 handover: who owns what, and who nobody took.
 * `allPlayerIds` is every id in the board dataset, so the undrafted pool is the
 * complement of everything claimed rather than a separately maintained list.
 */
export function finalPools(state, allPlayerIds, types) {
  const d = derive(state, types);
  const drafted = [...d.taken];
  const draftedSet = new Set(drafted);
  return {
    mine: d.myRoster,
    bySlot: Object.fromEntries([...d.rosters].map(([slot, ids]) => [slot, ids])),
    drafted,
    undrafted: allPlayerIds.filter((id) => !draftedSet.has(id)),
  };
}

/* ------------------------------------------------------------------ *
 * persistence
 * ------------------------------------------------------------------ */
export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private browsing — the draft just won't survive a refresh */ }
  return state;
}

/** A corrupt or foreign payload must never blank the page mid-draft. */
export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.version !== SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.log)) return null;
    const leagueSize = clampSize(raw.leagueSize);
    // mySlot needs the same clamp createDraft() applies — an out-of-range or
    // missing slot doesn't throw, but it silently wrecks onClockSlot/
    // myNextPick/picksUntilMyTurn downstream, which a live pick clock relies on.
    const mySlot = Math.max(1, Math.min(leagueSize, Math.round(raw.mySlot) || 1));
    return {
      ...raw,
      leagueSize,
      mySlot,
      log: raw.log.filter((p) => p && Number.isFinite(p.elementId)),
    };
  } catch {
    return null;
  }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

/**
 * Discard the league-id-era keys. They stored a flat set of taken ids with no
 * ordering, so they cannot be replayed into a log — attribution would be
 * invented. Dropping them is the honest migration.
 */
export function migrateLegacy() {
  let found = false;
  for (const k of LEGACY_KEYS) {
    try {
      if (localStorage.getItem(k) !== null) { found = true; localStorage.removeItem(k); }
    } catch { /* ignore */ }
  }
  return found;
}
