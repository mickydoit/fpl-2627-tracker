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
 * Which slot is mine? A snake draft's first round runs in slot order, so the
 * entry's round-1 pick number IS its slot. `pick` is per-round, not global —
 * hence the explicit round check rather than a pick-number comparison.
 */
export function deriveSlot(choices, myEntryId) {
  const mine = (choices || []).find((c) => c.entry === myEntryId && c.round === 1);
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
