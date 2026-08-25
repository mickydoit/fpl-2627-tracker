/**
 * The gameweek archive's storage contract, kept apart from the script that
 * writes it so it can be tested without a network fetch.
 *
 * The archive holds two very different kinds of evidence, and the difference
 * is the whole point:
 *
 *   PRE-DEADLINE   what was believed before a ball was kicked — the
 *                  projection, FPL's availability report, and the opportunity
 *                  model's own diagnostics. Written only while the deadline is
 *                  still ahead, and never revised afterwards.
 *   POST-MATCH     what actually happened. Attached later.
 *
 * Mixing them silently is the one failure this dataset cannot survive: a
 * backtest built on availability recorded after the team sheets were published
 * would look excellent and mean nothing.
 */

/** Schema 1: projected + actual. Schema 2 adds the pre-deadline evidence. */
export const ARCHIVE_SCHEMA = 2;

/** `availability[code]` field order. */
export const AVAILABILITY_FIELDS = [
  'elementId', 'status', 'chanceThisRound', 'chanceNextRound',
  'minutes', 'starts', 'newsAdded',
];

/** `diagnostics[code]` field order. */
export const DIAGNOSTIC_FIELDS = [
  'expMins', 'pStart', 'pPlay', 'p60', 'productionConfidence', 'minutesConfidence',
];

/**
 * What to persist for a field that is only ever captured before the deadline.
 *
 * `captured` is non-null only on a run that happened while the deadline was
 * still ahead. Every later run — the one that attaches actual points, the one
 * that marks the gameweek final — passes null, and must leave what is already
 * on disk alone. Without this the settlement pass would overwrite a genuine
 * pre-deadline snapshot with whatever FPL says today, which for an injured
 * player is frequently the opposite of what it said last week.
 *
 * @param {*} existing what is already archived for this gameweek, or null
 * @param {*} captured what this run captured, or null if it is not pre-deadline
 */
export function carryForward(existing, captured) {
  return captured ?? existing ?? null;
}

/**
 * The schema a file should declare. A gameweek archived before schema 2 keeps
 * declaring 1: it genuinely has no pre-deadline evidence, and claiming
 * otherwise would invite a reader to look for fields that are not there.
 * Backfilling them from today's data is the hindsight this file exists to stop.
 */
export function schemaFor(availability, existingSchema) {
  return availability ? ARCHIVE_SCHEMA : (existingSchema ?? 1);
}
