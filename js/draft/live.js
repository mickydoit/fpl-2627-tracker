/**
 * Live draft state.
 *
 * The board does not care whether picks arrived from the Draft API or were
 * typed in by hand — both reduce to one map of element id to owning entry.
 */
import { DRAFT_QUOTA } from './board.js';

/** Build the ownership map from the API's element_status array. */
export function ownershipFrom(elementStatus) {
  const map = new Map();
  for (const e of elementStatus || []) map.set(e.element, e.owner ?? null);
  return map;
}

/** Rows still on the board. A player missing from the map is available. */
export function availableRows(rows, ownership) {
  return rows.filter((r) => !ownership.get(r.id));
}

/**
 * Which slot is mine? The first round runs 1..N in pick order, so the entry's
 * first-round pick number is its slot. Returns null until that pick lands.
 */
export function deriveSlot(choices, myEntryId, leagueSize) {
  const mine = (choices || [])
    .filter((c) => c.entry === myEntryId && c.pick <= leagueSize)
    .sort((a, b) => a.pick - b.pick)[0];
  return mine ? mine.pick : null;
}

/** The rows I already own. */
export function myRoster(rows, ownership, myEntryId) {
  return rows.filter((r) => ownership.get(r.id) === myEntryId);
}

/** How many of each position I still have to draft. */
export function positionsNeeded(roster) {
  const need = { ...DRAFT_QUOTA };
  for (const p of roster) need[p.element_type] = Math.max(0, need[p.element_type] - 1);
  return need;
}
