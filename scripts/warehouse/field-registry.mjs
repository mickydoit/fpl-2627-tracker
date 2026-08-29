/**
 * Which external fields may reach a model, and on what evidence.
 *
 * Three ESPN fields have now been caught looking like football statistics and
 * not being them. Each was found by counting, none by reading a name:
 *
 *   attemptsInBox / attemptsOutBox  the TEAM's shots while the player was on
 *                                   the pitch. Every 90-minute player read 8
 *                                   and 2, including the goalkeeper.
 *   subbedIn / subbedOut            schema flags, not events. True for all
 *                                   twenty entries on every team, starters
 *                                   included.
 *   saves                           non-zero for 65% of DEFENDERS and 57% of
 *                                   midfielders across 4,133 player-seasons.
 *                                   Not a goalkeeper statistic.
 *
 * The pattern is the same every time: a plausibly named field in a player block
 * that is actually team-level or structural. The defence cannot be vigilance,
 * because the next one will look just as reasonable. So a field must be
 * explicitly registered MODEL_SAFE, with the population it was checked against,
 * before any model-facing code may consume it.
 *
 * Statuses:
 *   MODEL_SAFE          verified against a stated population; may be modelled
 *   RAW_ONLY            may be stored, must not be modelled
 *   REJECTED_SEMANTICS  the name does not describe the contents
 *   UNKNOWN             not yet checked; treated as unsafe
 */

export const FIELD_REGISTRY = {
  /* ---- verified safe ---- */
  minutes: { status: 'MODEL_SAFE', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons', semantics: 'minutes played by this player',
    evidence: 'Cross-checked against appearances and starts; starts never exceed appearances.' },
  starts: { status: 'MODEL_SAFE', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons', semantics: 'starts by this player',
    evidence: 'starts <= appearances holds on every row; agrees with roster starter flag.' },
  appearances: { status: 'MODEL_SAFE', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons', semantics: 'appearances by this player',
    evidence: 'Zero-appearance rows exist and are retained as measured zeros.' },
  shots: { status: 'MODEL_SAFE', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons', semantics: 'shots taken by this player',
    evidence: 'Non-zero for 88-92% of outfield players and only 11% of goalkeepers — the '
      + 'positional split a genuine player-level shot count must show.' },
  shotsOnTarget: { status: 'MODEL_SAFE', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons', semantics: 'shots on target by this player',
    evidence: 'Tracks shots; same positional split; never exceeds shots.' },
  keyPasses: { status: 'MODEL_SAFE', source: 'espn core athlete statistics (shotAssists)',
    population: '4,133 Tier B player-seasons', semantics: 'passes leading to a shot',
    evidence: 'Non-zero for 82% of players with a plausible midfield skew.' },
  goals: { status: 'MODEL_SAFE', source: 'espn core athlete statistics', population: '4,133 player-seasons',
    semantics: 'goals scored by this player', evidence: 'Positional distribution as expected.' },
  assists: { status: 'MODEL_SAFE', source: 'espn core athlete statistics', population: '4,133 player-seasons',
    semantics: 'assists by this player', evidence: 'Positional distribution as expected.' },
  starter: { status: 'MODEL_SAFE', source: 'espn core roster',
    population: '858 collected matches', semantics: 'named in the starting eleven',
    evidence: 'Exactly eleven per side on every collected lineup; agrees with formationPlace !== "0".' },
  formationPlace: { status: 'MODEL_SAFE', source: 'espn core roster',
    population: '858 collected matches', semantics: 'shirt position in the formation, "0" for bench',
    evidence: 'Independently cross-validates starter on every lineup.' },

  /* ---- caught lying ---- */
  saves: { status: 'REJECTED_SEMANTICS', source: 'espn core athlete statistics',
    population: '4,133 Tier B player-seasons',
    semantics: 'NOT goalkeeper saves. Non-zero for 65% of defenders and 57% of midfielders.',
    evidence: 'Measured by position, Milestone 3. Team-level quantity in a player block.',
    forbidden: 'Must never be read as a goalkeeper save count or used in GK production modelling.' },
  /* Same name, different endpoint, different verdict — which is exactly why the
     registry keys on the source and not just the word. The team boxscore
     publishes 28 statistics PER SIDE, and saves there is a team total, which is
     what it claims to be. The player-block field of the same name is not. */
  'team.saves': { status: 'MODEL_SAFE', source: 'espn site summary boxscore (team statistics)',
    population: '1,716 team-match rows', semantics: 'saves by the team in that match',
    evidence: 'A team-level block by construction; 100% populated on collected rows and used only '
      + 'as a team quantity in team-strength research.' },
  attemptsInBox: { status: 'REJECTED_SEMANTICS', source: 'espn core athlete statistics',
    population: 'Liverpool v Bournemouth, all players',
    semantics: 'NOT the player\'s shots in the box — the TEAM\'s, during his minutes.',
    evidence: 'Every 90-minute player read 8 and 2, including the goalkeeper.' },
  attemptsOutBox: { status: 'REJECTED_SEMANTICS', source: 'espn core athlete statistics',
    population: 'as attemptsInBox', semantics: 'as attemptsInBox', evidence: 'as attemptsInBox' },
  subbedIn: { status: 'REJECTED_SEMANTICS', source: 'espn core roster',
    population: '240 roster entries across six matches',
    semantics: 'NOT a substitution event — a schema flag, true for all twenty entries on every team.',
    evidence: 'Measured, Milestone 2. Starters included.' },
  subbedOut: { status: 'REJECTED_SEMANTICS', source: 'espn core roster',
    population: 'as subbedIn', semantics: 'as subbedIn', evidence: 'as subbedIn' },
  shotsFaced: { status: 'REJECTED_SEMANTICS', source: 'espn core athlete statistics',
    population: 'match-level sample', semantics: 'reads 0 for a keeper who conceded twice',
    evidence: 'Documented in scripts/fetch-espn-matches.mjs.' },
  shotsHeaded: { status: 'RAW_ONLY', source: 'espn core athlete statistics',
    population: '239 player-matches', semantics: 'in the schema, never populated',
    evidence: 'Zero across an eight-match sample containing three headed goals.' },

  /* ---- present, not yet verified ---- */
  goalsConceded: { status: 'UNKNOWN', source: 'espn core athlete statistics',
    population: '4,133 player-seasons',
    semantics: 'Non-zero for 90%+ of outfield players, so almost certainly team-level while on '
      + 'the pitch rather than a personal statistic. Not checked further; not modelled.' },
  cleanSheets: { status: 'UNKNOWN', source: 'espn core athlete statistics',
    population: '4,133 player-seasons',
    semantics: 'Non-zero for 79% of defenders and 70% of goalkeepers. Plausibly a team clean sheet '
      + 'during the player\'s minutes, which is what FPL scores — but unverified.' },
  tackles: { status: 'UNKNOWN', source: 'espn core athlete statistics', population: '4,133 player-seasons',
    semantics: 'Non-zero on only 30% of rows, and it shares a block with a field already proven '
      + 'team-level. Not modelled until checked by position.' },
  interceptions: { status: 'UNKNOWN', source: 'espn core athlete statistics', population: 'as tackles', semantics: 'as tackles' },
  clearances: { status: 'UNKNOWN', source: 'espn core athlete statistics', population: 'as tackles', semantics: 'as tackles' },
};

/** May a model-facing path consume this field? */
export function isModelSafe(field) {
  return FIELD_REGISTRY[field]?.status === 'MODEL_SAFE';
}

/**
 * Throws unless every field is registered MODEL_SAFE. Call this at the top of
 * any research module that models external fields, so an unregistered field
 * fails loudly rather than being modelled on the strength of its name.
 */
export function assertModelSafe(fields, context = 'model') {
  const bad = fields.filter((f) => !isModelSafe(f));
  if (bad.length) {
    throw new Error(`${context}: fields not registered MODEL_SAFE — ${bad.map((f) => {
      const s = FIELD_REGISTRY[f]?.status ?? 'UNREGISTERED';
      return `${f} (${s})`;
    }).join(', ')}`);
  }
  return true;
}
