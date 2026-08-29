/**
 * ESPN player-MATCH outcomes -> player-EVENT rates, correct across double
 * gameweeks, blanks and rescheduled fixtures.
 *
 * ── The trap this exists to avoid ──
 *
 * ESPN outcomes are per MATCH. FPL minutes are per EVENT. Those coincide only
 * when a club plays exactly once in an event, which is the usual case and
 * therefore the dangerous one — a naive join looks right all season and then
 * silently double-counts the denominator in a double gameweek.
 *
 * Attaching an event's 150 minutes to each of two match rows would score a
 * player as 2 shots per 150 minutes AND 3 shots per 150 minutes, when the truth
 * is 5 shots per 150. So outcomes are SUMMED to the event grain first, and only
 * then joined to a single minutes total.
 *
 * ── Two minutes sources, one preferred ──
 *
 * ESPN publishes match-level minutes on the per-player statistics block, and it
 * has been audited: 40/40 present, totals exactly 1980 for a completed match,
 * and 25 of 25 agreement with FPL on a single-fixture gameweek. Where it exists
 * it is summed across the event's matches, which is exact.
 *
 * Where it does not (a player outside the frozen cohort, who never receives the
 * detail call), the FPL event total is used instead — one value per player-event,
 * never once per match.
 *
 * ── Absence is never zero, and a PARTIAL total is not a total ──
 *
 * A player with no fixture in an event has NOT been observed taking no shots.
 * He is absent from the output entirely, and a blank is reported as NO_FIXTURE
 * rather than as a measured zero.
 *
 * The subtler case is a double gameweek where one match was fetched and the
 * other was not. Summing 3 and null to 3 would publish a partial observation as
 * a complete event total, and nothing downstream could tell the difference — it
 * would simply read as a player who created three chances across two matches.
 *
 * So an aggregate becomes a numeric total ONLY when every constituent
 * observation is present, or when absence is semantically PROVEN to mean zero.
 * Otherwise the value is null and the partial sum is carried alongside it,
 * labelled, for diagnostics.
 *
 * ── When absence really does mean zero ──
 *
 * If the source establishes that a player played zero minutes in a match, then
 * he took zero shots in it — that is a fact about football, not a gap in the
 * data. Verified non-participation therefore counts as an observed zero. A
 * failed fetch never does, and the two are distinguishable because an unfetched
 * row carries `minutes: null` while a non-participant carries `minutes: 0`.
 */
import { readRows, paths } from '../store.mjs';

/**
 * @param {object[]} matchRows  ESPN player-match rows (one per player per match)
 * @param {Map} fplEventMinutes  `${espnId}|${event}` -> FPL minutes for that event
 * @returns {object[]} one row per player-event
 */
const METRIC_FIELDS = ['shots', 'shotsOnTarget', 'keyPasses'];

export function aggregateToEvent(matchRows, fplEventMinutes = new Map()) {
  const byKey = new Map();
  for (const r of matchRows) {
    if (r.gameweek == null || r.espnId == null) continue;
    const key = `${r.espnId}|${r.gameweek}`;
    const acc = byKey.get(key) || {
      espnId: r.espnId, gameweek: r.gameweek, name: r.name, position: r.position,
      matches: 0, eventIds: [],
      shots: null, shotsOnTarget: null, keyPasses: null,
      espnMinutes: null, minutesSource: null, starts: 0,
      _partial: {}, _observed: {}, _minutesObserved: 0,
    };
    acc.matches += 1;
    acc.eventIds.push(r.eventId);
    /* Verified non-participation: the player was on no pitch, so his outcome
       counts for this match are genuinely zero. Distinguishable from a failed
       fetch because that leaves minutes null, not 0. */
    const verifiedAbsent = r.minutes === 0;
    for (const f of METRIC_FIELDS) {
      const observed = r[f] != null ? r[f] : (verifiedAbsent ? 0 : null);
      if (observed != null) {
        acc._partial[f] = (acc._partial[f] ?? 0) + observed;
        acc._observed[f] = (acc._observed[f] ?? 0) + 1;
      }
    }
    if (r.minutes != null) { acc.espnMinutes = (acc.espnMinutes ?? 0) + r.minutes; acc._minutesObserved += 1; }
    if (r.starter) acc.starts += 1;
    byKey.set(key, acc);
  }

  const out = [];
  for (const acc of byKey.values()) {
    /* ONE minutes total per player-event, and only when every constituent match
       supplied one. A half-observed denominator is worse than none: it makes
       every rate built on it silently too large. */
    const fpl = fplEventMinutes.get(`${acc.espnId}|${acc.gameweek}`);
    const espnMinutesComplete = acc._minutesObserved === acc.matches && acc.espnMinutes != null;
    let minutes = null; let source = null; let minutesComplete = false;
    if (espnMinutesComplete) { minutes = acc.espnMinutes; source = 'espn-match-summed'; minutesComplete = true; }
    else if (fpl != null) {
      /* The FPL total covers the WHOLE event by construction, so it is complete
         even when ESPN's per-match minutes are not. */
      minutes = fpl; source = 'fpl-event-total'; minutesComplete = true;
    } else if (acc.espnMinutes != null) {
      source = 'espn-match-partial';   // carried for diagnostics, not used as a denominator
    }

    const coverage = {}; const partial = {};
    const value = {};
    for (const f of METRIC_FIELDS) {
      const observedMatches = acc._observed[f] ?? 0;
      const complete = observedMatches === acc.matches;
      coverage[f] = { observedMatches, expectedMatches: acc.matches, coverageComplete: complete };
      partial[f] = acc._partial[f] ?? null;
      /* The invariant: a numeric total only when fully observed. */
      value[f] = complete ? (acc._partial[f] ?? null) : null;
    }

    const per90 = (v) => (v != null && minutesComplete && minutes > 0 ? (v / minutes) * 90 : null);
    const { _partial, _observed, _minutesObserved, ...rest } = acc;
    out.push({
      ...rest,
      shots: value.shots, shotsOnTarget: value.shotsOnTarget, keyPasses: value.keyPasses,
      minutes: minutesComplete ? minutes : null,
      minutesSource: source, minutesComplete,
      partialTotals: partial,
      fieldCoverage: coverage,
      coverageComplete: METRIC_FIELDS.every((f) => coverage[f].coverageComplete) && minutesComplete,
      shots90: per90(value.shots), shotsOnTarget90: per90(value.shotsOnTarget), keyPasses90: per90(value.keyPasses),
      isDoubleGameweek: acc.matches > 1,
      espnMinutesPartial: espnMinutesComplete ? null : acc.espnMinutes,
    });
  }
  return out.sort((a, b) => a.espnId - b.espnId || a.gameweek - b.gameweek);
}

/**
 * Map an ESPN match to the FPL event that actually scores it.
 *
 * Keyed on the FPL fixture, never inferred from the calendar week — a
 * rescheduled match keeps its original FPL event even when it is played weeks
 * later, and a date-derived guess would file it under the wrong gameweek.
 */
export function buildEventMap(fplFixtures, espnEvents) {
  const byDayTeams = new Map();
  for (const f of fplFixtures) {
    if (f.event == null || !f.kickoff_time) continue;
    byDayTeams.set(`${String(f.kickoff_time).slice(0, 10)}|${f.team_h}|${f.team_a}`, f.event);
  }
  return { byDayTeams, resolve: (day, teamH, teamA) => byDayTeams.get(`${day}|${teamH}|${teamA}`) ?? null };
}

/** Coverage, with every gap named rather than defaulted. */
export function coverage(eventRows, expected) {
  const cov = {};
  for (const gw of Object.keys(expected)) {
    const rows = eventRows.filter((r) => String(r.gameweek) === String(gw));
    cov[gw] = {
      eligibleMatches: expected[gw].eligible, settledMatches: expected[gw].settled,
      summariesArchived: expected[gw].archived,
      playerEventRows: rows.length,
      shotsCoverage: rows.filter((r) => r.shots != null).length,
      sotCoverage: rows.filter((r) => r.shotsOnTarget != null).length,
      keyPassCoverage: rows.filter((r) => r.keyPasses != null).length,
      minutesCoverage: rows.filter((r) => r.minutes != null).length,
      doubleGameweekRows: rows.filter((r) => r.isDoubleGameweek).length,
      status: expected[gw].archived < expected[gw].settled ? 'COVERAGE INCOMPLETE' : 'complete',
    };
  }
  return cov;
}

/* Run directly for a coverage snapshot. */
if (process.argv[1] && process.argv[1].endsWith('prospective-aggregate.mjs')) {
  const fs = await import('node:fs');
  const J = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const man = J('data/warehouse/research/EXPERIMENT-MANIFEST.json');
  const boot = J('data/bootstrap.json');
  const settled = (boot?.events || []).filter((e) => e.finished && e.id >= (man?.firstScorableGW ?? 3));
  if (!settled.length) {
    console.log(`no settled gameweek at or after GW${man?.firstScorableGW ?? 3} — nothing to aggregate.`);
  } else {
    let all = [];
    for (const e of settled) all = all.concat(await readRows(paths.prospectiveRaw(2026, e.id)));
    const rows = aggregateToEvent(all);
    console.log(`aggregated ${all.length} player-match rows -> ${rows.length} player-event rows`);
    console.log(`  double-gameweek rows: ${rows.filter((r) => r.isDoubleGameweek).length}`);
    console.log(`  minutes source: ${JSON.stringify(rows.reduce((a, r) => { a[r.minutesSource ?? 'none'] = (a[r.minutesSource ?? 'none'] || 0) + 1; return a; }, {}))}`);
  }
}
