/**
 * One vocabulary for club three-letter codes.
 *
 * Three feeds name the same twenty clubs three ways, and the disagreements are
 * few, stable and worth writing down by hand rather than inferring. FPL's
 * `short_name` is the canonical form here, because it is the vocabulary the
 * rest of this repository already speaks.
 *
 * This table earned its own file the moment a second consumer appeared: the
 * identity builder had it, the normaliser did not, and the result was that
 * Manchester United and Nottingham Forest silently failed to join their ESPN
 * and football-data records — two of six matches lost, with nothing to show it
 * had happened except a count that looked plausible.
 */

/** Source vocabulary → FPL `short_name`. */
export const TLA_ALIAS = {
  'football-data': {
    NOT: 'NFO',   // Nottingham Forest FC
    MUN: 'MUN',   // agrees; listed so the pair with ESPN below is visible
  },
  espn: {
    MAN: 'MUN',   // Manchester United
  },
};

/** Canonicalise a club code from a given source into FPL's vocabulary. */
export function canonicalTla(source, tla) {
  if (!tla) return null;
  const t = String(tla).toUpperCase();
  return TLA_ALIAS[source]?.[t] ?? t;
}

/** A stable, order-independent key for the pair of clubs in one fixture. */
export function fixtureKey(source, day, tlaA, tlaB) {
  return `${day}|${[canonicalTla(source, tlaA), canonicalTla(source, tlaB)].sort().join('-')}`;
}
