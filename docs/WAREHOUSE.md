# The research warehouse

A football-history store that the projection **cannot read**.

## Why it is separate

`js/seasons.js` allows the projection two seasons of evidence and nothing older,
because a player's output three seasons ago describes a different player. That
rule is not being relaxed.

Research is the opposite problem. Asking whether a Bundesliga xG translates to
the Premier League needs many seasons of players who made that move; one season
answers nothing. So the warehouse keeps a wider window, and keeps it in
`scripts/warehouse/config.mjs` where the model cannot import it by accident.

The separation is asserted mechanically in `scripts/test-warehouse.mjs`: no file
under `js/` may reference the warehouse, no production script may read
`data/warehouse/`, and the two season windows must stay different sizes. Data
earns its way into a projection by passing an evaluation, never by being on disk.

## Sources, and what each is actually for

| Source | Carries | Does not carry | Seasons |
|---|---|---|---|
| **football-data.org** | competitions, clubs and stable ids, fixtures, results, league tables, season squads with date of birth and nationality | lineups, formations, match statistics, coaches — all verified null on the free tier | 2023–2026 (403 below) |
| **ESPN** | formations, starting elevens, shirt positions, 28 team statistics a side | anything it charges 43 requests a match for; see below | 2021–2026 |

Neither publishes xG. `coverage.json` reports that as 0% rather than omitting it.

## The constraint that shaped everything

Measured, not estimated. One ESPN match costs:

| | requests | bytes | gzipped |
|---|---:|---:|---:|
| with per-player statistics | 43 | 27,059 | 1,467 |
| team + lineup only | 3 | 6,018 | 721 |

Six seasons of ten competitions is 59,436 requests at the cheap tier and 851,916
at the expensive one. Storage is not the binding constraint — gzip takes the
whole cheap tier to about 12 MB — **requests are**. So this collector only ever
does the cheap tier, and per-player detail stays with the existing Premier
League collector or, for cross-league work, with one-request season aggregates.

The cheap tier already supports team strength, promoted-club translation,
manager and formation tendency, rotation, and opponent environment.

## Identity

    FPL code ──(data/identity/players.json)──> ESPN athlete id + date of birth
    ESPN DOB + name ──(warehouse)──> football-data player id + nationality

FPL publishes no date of birth, which is why the chain runs through ESPN. A
cross-source join **must agree on date of birth**; names collide across leagues
far more than inside one. Name-only agreement is recorded as a proposal and
never as a mapping.

## Field traps found so far

Both were verified against real payloads, and both look correct until counted.

- `attemptsInBox` / `attemptsOutBox` are the **team's** shots while that player
  was on the pitch, not his. Documented in `scripts/fetch-espn-matches.mjs`.
- `subbedIn` / `subbedOut` are **not events**. Across 240 roster entries they
  read true for all twenty entries on every team, starters included. Stored as
  "came off the bench" they would have marked every starting eleven as
  substitutes. The warehouse does not keep them. `starter` is sound — exactly
  eleven a side — and `formationPlace` independently confirms it.

## Running it

    npm run warehouse:structural    # football-data.org  (needs FOOTBALL_DATA_TOKEN)
    npm run warehouse:performance   # ESPN, capped per run
    npm run warehouse:identity
    npm run warehouse:normalise
    npm run warehouse:coverage
    npm run test:warehouse

`.github/workflows/warehouse.yml` runs these daily. It is deliberately not part
of `refresh.yml`: warehouse collection talks to two external providers over long
backfills and must never be able to fail a deployment.

Every fetcher fails soft. No token, no network, or a plan change all produce a
warning, exit 0, and every committed file left exactly where it was. An empty
result never overwrites good data — `writeRows` refuses it.
