/**
 * One vocabulary for club three-letter codes.
 *
 * Three feeds name the same clubs three ways. The disagreements are few and
 * stable, so they are written down and verified by hand rather than inferred —
 * a fuzzy club join is the fastest way to attribute one team's season to
 * another and never notice.
 *
 * This table earned its own file the moment a second consumer appeared: the
 * identity builder had it, the normaliser did not, and Manchester United and
 * Nottingham Forest silently failed to join — two of six matches lost, with
 * nothing to show for it but a plausible-looking count.
 *
 * ── Why canonicalisation is competition-aware ──
 *
 * Because one source is genuinely ambiguous and the other is not.
 * football-data gives Sheffield United AND Sheffield Wednesday the same TLA,
 * `SHE`, distinguishing them only by which competition the row came from. ESPN
 * separates them properly as `SHU` and `SHW`. So resolving `SHE` requires
 * knowing the competition, and a source-only lookup cannot be correct.
 *
 * Every entry below was confirmed against collected payloads by matching club
 * NAMES across the two feeds, not by guessing at the letters.
 */

/**
 * Source vocabulary → canonical. Canonical follows FPL's `short_name` wherever
 * FPL has the club, and the football-data code otherwise.
 */
const ALIAS = {
  espn: {
    MAN: 'MUN',   // Manchester United
    MNC: 'MCI',   // Manchester City
    LTN: 'LUT',   // Luton Town
    BLK: 'BLA',   // Blackburn Rovers
    BRC: 'BRI',   // Bristol City
    // SHU / SHW already distinguish the two Sheffield clubs correctly.
  },
  'football-data': {
    NOT: 'NFO',   // Nottingham Forest
  },
};

/**
 * Codes one source cannot disambiguate on its own. Keyed source → code →
 * competition → canonical.
 */
const ALIAS_BY_COMPETITION = {
  'football-data': {
    SHE: {
      'eng.1': 'SHU',   // Sheffield United FC
      'eng.2': 'SHW',   // Sheffield Wednesday FC
    },
  },
};

/**
 * Canonicalise a club code from a given source.
 *
 * @param {string} source        'espn' | 'football-data'
 * @param {string|null} tla
 * @param {string|null} competition  required to resolve an ambiguous code
 */
export function canonicalTla(source, tla, competition = null) {
  if (!tla) return null;
  const t = String(tla).toUpperCase();
  const scoped = ALIAS_BY_COMPETITION[source]?.[t];
  if (scoped) {
    const hit = competition ? scoped[competition] : null;
    /* No competition supplied for a code that needs one. Returning the raw code
       is wrong but silent; returning a marked value makes the omission visible
       in any join that depends on it rather than producing a near-miss. */
    if (!hit) return `${t}?`;
    return hit;
  }
  return ALIAS[source]?.[t] ?? t;
}

/** A stable, order-independent key for the pair of clubs in one fixture. */
export function fixtureKey(source, day, tlaA, tlaB, competition = null) {
  const a = canonicalTla(source, tlaA, competition);
  const b = canonicalTla(source, tlaB, competition);
  return `${day}|${[a, b].sort().join('-')}`;
}
