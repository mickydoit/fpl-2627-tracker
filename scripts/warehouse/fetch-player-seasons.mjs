/**
 * `player_season` — historical player ability and opportunity evidence.
 *
 * ── Two routes, measured, with very different economics ──
 *
 * ESPN exposes season-aggregate player statistics two ways, and they are not
 * the same data:
 *
 *   A. site  /{league}/teams/{teamId}/roster?season={y}
 *      ONE request returns the whole squad — 33 of 35 athletes carrying
 *      statistics — plus date of birth, position, citizenship and shirt number.
 *      But only 15 statistical fields, and `minutes` and `starts` are NOT among
 *      them. Verified on David Raya 2024/25: the roster route reports
 *      appearances 38 and no minutes at all.
 *
 *   B. core  /leagues/{league}/seasons/{y}/types/1/athletes/{id}/statistics
 *      ONE request per player per league-season, returning 95 fields across
 *      four categories — including `minutes` 3420 and `starts` 38 for the same
 *      player. This is the only route that carries opportunity.
 *
 * So route A is a cheap census and route B is expensive truth. Using A alone
 * would leave the model without minutes, which is the single most important
 * quantity in it; using B alone for every player in every league-season is tens
 * of thousands of requests for players nobody will ever ask about.
 *
 * This file therefore runs A across everything and B only against a target
 * list. A completed season never changes, so both are cached permanently and a
 * cached player-season is never re-fetched.
 *
 * ── No expected goals, anywhere ──
 *
 * Route B's 95 fields were read in full. There is no xG, no xA, and no
 * chances-created field. `shotAssists` (key passes) exists and is the closest
 * available proxy. The coverage report states this as 0% rather than omitting
 * the row, because a later phase must not assume otherwise.
 *
 * ── null is not zero ──
 *
 * A field route A does not carry is written `null`, never 0. `minutes: null`
 * means "this player-season has not been fetched at the detailed tier";
 * `minutes: 0` would mean "he played none", which is a completely different
 * claim and would silently destroy every per-90 rate computed from it.
 */
import { getJSON } from '../lib/http.mjs';
import { readRows, mergeRows, writeRows, paths, stamp } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, assertWarehouseSeason, seasonsFor } from './config.mjs';

const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';

const SEASONS = (process.env.WAREHOUSE_SEASONS || seasonsFor('espn').join(','))
  .split(',').map((s) => assertWarehouseSeason(s.trim(), 'player-season ingest'));
const ONLY = (process.env.WAREHOUSE_COMPETITIONS || '').split(',').filter(Boolean);
const targets = COMPETITIONS.filter((c) => !ONLY.length || ONLY.includes(c.key));
const TIER = process.env.WAREHOUSE_PS_TIER || 'A';           // 'A', 'B', or 'AB'
let budgetA = Number(process.env.WAREHOUSE_PS_TEAMS || 260);  // team-seasons this run
let budgetB = Number(process.env.WAREHOUSE_PS_PLAYERS || 400);// player-league-seasons this run

const now = () => new Date().toISOString();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Pull a named stat out of ESPN's category structure, or null if absent. */
const pick = (cats, cat, name) => {
  const c = (cats || []).find((x) => x.name === cat);
  const s = c?.stats?.find((x) => x.name === name);
  return s ? num(s.value) : null;
};

/**
 * The fields worth normalising, and where each lives.
 *
 * `minutes` and `starts` head the list deliberately: they are what route A
 * cannot supply and what the opportunity model cannot do without.
 */
const FIELDS = [
  ['minutes', 'general', 'minutes'],
  ['starts', 'general', 'starts'],
  ['appearances', 'general', 'appearances'],
  ['subIns', 'general', 'subIns'],
  ['subOuts', 'general', 'subOuts'],
  ['goals', 'offensive', 'totalGoals'],
  ['assists', 'offensive', 'goalAssists'],
  ['shots', 'offensive', 'totalShots'],
  ['shotsOnTarget', 'offensive', 'shotsOnTarget'],
  /* Key passes. The nearest thing to chance creation this feed has, and the
     reason xA's absence is survivable rather than fatal. */
  ['keyPasses', 'offensive', 'shotAssists'],
  ['crosses', 'offensive', 'totalCrosses'],
  ['accurateCrosses', 'offensive', 'accurateCrosses'],
  ['passes', 'offensive', 'totalPasses'],
  ['accuratePasses', 'offensive', 'accuratePasses'],
  ['penaltyGoals', 'offensive', 'penaltyKickGoals'],
  ['penaltyShots', 'offensive', 'penaltyKickShots'],
  ['freeKickGoals', 'offensive', 'freeKickGoals'],
  ['headedGoals', 'offensive', 'headedGoals'],
  ['offsides', 'offensive', 'offsides'],
  ['tackles', 'defensive', 'totalTackles'],
  ['interceptions', 'defensive', 'interceptions'],
  ['clearances', 'defensive', 'totalClearance'],
  ['blockedShots', 'defensive', 'blockedShots'],
  ['saves', 'goalKeeping', 'saves'],
  ['goalsConceded', 'goalKeeping', 'goalsConceded'],
  ['cleanSheets', 'goalKeeping', 'cleanSheet'],
  ['penaltiesSaved', 'goalKeeping', 'penaltyKicksSaved'],
  ['yellowCards', 'general', 'yellowCards'],
  ['redCards', 'general', 'redCards'],
  ['ownGoals', 'general', 'ownGoals'],
  ['foulsCommitted', 'general', 'foulsCommitted'],
];

const statsFrom = (cats) => Object.fromEntries(FIELDS.map(([k, c, n]) => [k, pick(cats, c, n)]));

/* ------------------------------------------------------------------ *
 * Tier A — the census
 * ------------------------------------------------------------------ */
async function tierA() {
  console.log(`→ Tier A: squad census, 1 request per team-season (budget ${budgetA})\n`);
  let teamSeasons = 0; let rowsTotal = 0;

  outer:
  for (const season of SEASONS) {
    for (const comp of targets) {
      if (budgetA <= 0) break outer;
      const path = paths.espnRosters(comp.key, season);
      const have = new Set((await readRows(path)).map((r) => `${r.espnTeamId}:${r.espnId}`));
      const haveTeams = new Set((await readRows(path)).map((r) => r.espnTeamId));

      const tl = await getJSON(`${SITE}/${comp.espn}/teams?season=${season}`, { browserUA: true })
        .catch((e) => ({ _err: e.message }));
      const teams = tl?.sports?.[0]?.leagues?.[0]?.teams?.map((t) => t.team) || [];
      if (!teams.length) {
        console.log(`  ${comp.key.padEnd(15)} ${season}  team list unavailable, ${haveTeams.size} teams already stored`);
        continue;
      }

      const todo = teams.filter((t) => !haveTeams.has(Number(t.id)));
      if (!todo.length) {
        console.log(`  ${comp.key.padEnd(15)} ${season}  ${haveTeams.size}/${teams.length} teams stored, nothing new`);
        continue;
      }

      const rows = [];
      for (const t of todo) {
        if (budgetA <= 0) break;
        const r = await getJSON(`${SITE}/${comp.espn}/teams/${t.id}/roster?season=${season}`, { browserUA: true })
          .catch(() => null);
        budgetA -= 1; teamSeasons += 1;
        if (!r?.athletes?.length) continue;
        for (const a of r.athletes) {
          rows.push(stamp({
            espnId: Number(a.id),
            name: a.displayName ?? a.fullName ?? null,
            dateOfBirth: a.dateOfBirth ? String(a.dateOfBirth).slice(0, 10) : null,
            position: a.position?.displayName ?? null,
            positionAbbr: a.position?.abbreviation ?? null,
            citizenship: a.citizenship ?? null,
            jersey: a.jersey ?? null,
            espnTeamId: Number(t.id),
            teamAbbr: t.abbreviation ?? null,
            teamName: t.displayName ?? null,
            /* Route A carries 15 of the 32 fields below. The rest come back
               null, and null means unfetched — not zero. */
            tier: 'A',
            ...statsFrom(a.statistics?.splits?.categories),
          }, { source: 'espn-site-roster', sourceId: a.id, competition: comp.key, season, fetchedAt: now() }));
        }
      }
      if (rows.length) {
        const res = await mergeRows(path, rows, (r) => `${r.espnTeamId}:${r.espnId}`);
        rowsTotal += rows.length;
        console.log(`  ${comp.key.padEnd(15)} ${season}  +${todo.length} teams, ${rows.length} player-seasons, ${res.total} stored`);
      }
    }
  }
  console.log(`\n  Tier A: ${teamSeasons} team-seasons fetched, ${rowsTotal} player-season rows`);
}

/* ------------------------------------------------------------------ *
 * Tier B — minutes and starts, for players we actually need
 * ------------------------------------------------------------------ */
async function tierB() {
  console.log(`\n→ Tier B: full statistics incl. minutes, 1 request per player-league-season (budget ${budgetB})\n`);

  /* Who needs the detailed tier.
   *
   * `WAREHOUSE_PS_TARGET` selects the population, because Milestone 3 needs a
   * different one from Milestone 2 and getting this wrong is expensive in both
   * directions — too wide and it is thousands of pointless requests, too narrow
   * and the transfer cohort has no minutes on one side of the move.
   *
   *   fpl     current FPL players plus promoted-club squads. What the tracker
   *           projects; the right set for continuity work.
   *   cohort  every player in a derived transfer episode, on BOTH sides of the
   *           move. Most of these are not in today's bootstrap — a 2023
   *           Bundesliga arrival who has since left the league is exactly the
   *           evidence cross-league translation is built from, and the `fpl`
   *           target excludes him.
   *   both    the union.
   */
  const TARGET = process.env.WAREHOUSE_PS_TARGET || 'fpl';
  const identity = await readRows(paths.players());
  const wanted = new Set();
  const promotedEspnIds = new Set();

  if (TARGET === 'fpl' || TARGET === 'both') {
    for (const p of identity) if (p.espnId) wanted.add(p.espnId);
    for (const season of seasonsFor('espn')) {
      for (const r of await readRows(paths.espnRosters('eng.2', season))) promotedEspnIds.add(r.espnId);
    }
  }

  if (TARGET === 'cohort' || TARGET === 'both') {
    /* The transfer cohort, bridged to ESPN ids through player_xref — the wide
       bridge, not the FPL-keyed identity map. */
    const xref = await readRows(paths.playerXref());
    const espnByFd = new Map(xref.map((p) => [p.footballDataPlayerId, p.espnId]));
    const moves = await readRows(paths.transfers());
    let bridged = 0;
    for (const m of moves) {
      const espnId = espnByFd.get(m.footballDataPlayerId);
      if (!espnId) continue;
      /* Both sides. A move is only evidence if the source season AND the
         destination season are both fetched, so the target set is the player,
         not the player-season — the season filter is applied by the loop below
         against the census for each competition-season. */
      wanted.add(espnId);
      bridged += 1;
    }
    console.log(`  cohort target: ${moves.length} moves, ${bridged} bridged to an ESPN id`);
  }

  console.log(`  target='${TARGET}', ${wanted.size} players wanted`
    + (promotedEspnIds.size ? ` (+${promotedEspnIds.size} promoted-squad)` : ''));

  let fetched = 0;
  outer:
  for (const season of SEASONS) {
    for (const comp of targets) {
      if (budgetB <= 0) break outer;
      const rosterPath = paths.espnRosters(comp.key, season);
      const census = await readRows(rosterPath);
      if (!census.length) continue;

      const path = paths.espnPlayerSeasons(comp.key, season);
      const have = new Set((await readRows(path)).map((r) => r.espnId));

      /* Only players in the target set, and only those not already cached. A
         completed season is immutable, so a cached row is never re-fetched. */
      const todo = census
        .filter((r) => wanted.has(r.espnId) || promotedEspnIds.has(r.espnId))
        .filter((r) => !have.has(r.espnId))
        .slice(0, budgetB);
      if (!todo.length) continue;

      const rows = [];
      for (const c of todo) {
        if (budgetB <= 0) break;
        const st = await getJSON(
          `${CORE}/${comp.espn}/seasons/${season}/types/1/athletes/${c.espnId}/statistics`,
          { browserUA: true },
        ).catch(() => null);
        budgetB -= 1;
        const cats = st?.splits?.categories;
        /* No statistics block at all means ESPN cannot describe this
           player-season. That is UNKNOWN, and skipping it is correct — storing
           nulls would be indistinguishable from a measurement. */
        if (!Array.isArray(cats) || !cats.length) continue;
        const s = statsFrom(cats);
        /* A statistics block that reads zero is a MEASUREMENT, and it is kept.
        
           This line previously skipped it, on the reasoning that "a season with
           no appearances is not evidence". For production translation that was
           defensible — a per-90 rate needs a denominator. For OPPORTUNITY
           translation it is the single most damaging thing the collector could
           do: a player who joined a Premier League club and never played is the
           outcome the experiment exists to learn from, and dropping him leaves a
           cohort of arrivals who all got minutes.
        
           That is the same selection bias as filtering the cohort on
           destination minutes, applied one layer earlier where it is much
           harder to see — the cohort builder cannot retain a row the fetcher
           never wrote. Measured against the collected data it was total: the
           opportunity cohort contained 146 episodes and ZERO zero-minute
           outcomes, which is not a plausible transfer market.
        
           Unknown is null. Measured zero is zero. The distinction is the whole
           point and it is now preserved end to end. */
        rows.push(stamp({
          espnId: c.espnId,
          name: c.name,
          dateOfBirth: c.dateOfBirth,
          position: c.position,
          positionAbbr: c.positionAbbr,
          espnTeamId: c.espnTeamId,
          teamAbbr: c.teamAbbr,
          teamName: c.teamName,
          tier: 'B',
          ...s,
        }, { source: 'espn-core-athlete', sourceId: c.espnId, competition: comp.key, season, fetchedAt: now() }));
        fetched += 1;
      }
      if (rows.length) {
        const res = await mergeRows(path, rows, (r) => r.espnId);
        console.log(`  ${comp.key.padEnd(15)} ${season}  +${rows.length} detailed player-seasons, ${res.total} stored`);
      }
    }
  }
  console.log(`\n  Tier B: ${fetched} player-league-seasons fetched`);
}

if (TIER.includes('A')) await tierA();
if (TIER.includes('B')) await tierB();
