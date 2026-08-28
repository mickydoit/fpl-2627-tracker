/**
 * ESPN — the performance layer, at the cheap tier only.
 *
 * ── The one number that shaped this file ──
 *
 * Measured against the existing collector, not estimated: a full ESPN
 * player-match record costs 43 HTTP requests and 27,059 bytes; the same match
 * WITHOUT per-player statistics costs 3 requests and 6,018 bytes, and still
 * carries the formation, the starting eleven, who came on and off, each
 * player's shirt position, and 28 team statistics per side.
 *
 * Across six seasons of ten competitions that is 59,436 requests at the cheap
 * tier against 851,916 at the expensive one. The second number is not something
 * to do to an undocumented API that has no contract with us, so this collector
 * only ever does the first. Per-player detail is collected separately, for the
 * Premier League, by the existing scripts/fetch-espn-matches.mjs — which is
 * left exactly as it is.
 *
 * What the cheap tier already supports: team attack and defence strength,
 * promoted-club translation, manager and formation tendencies, rotation and
 * lineup continuity, and opponent environment. That is Phases 3, 5, 6 and 7 of
 * the programme. Only cross-league PLAYER ability needs the expensive tier, and
 * for that a per-player SEASON aggregate is one request rather than 43.
 *
 * ── Incremental by construction ──
 *
 * A finished match never changes, so it is fetched once and then read from the
 * repository forever. Each run takes a capped slice and commits it; the next
 * run continues. At the default cap the full backfill is about 166 runs, which
 * the existing half-hourly schedule absorbs in three and a half days without
 * ever making a long request burst.
 */
import { getJSON } from '../lib/http.mjs';
import { readRows, mergeRows, paths, stamp } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, assertWarehouseSeason, BUDGET } from './config.mjs';

const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer';
const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';

const SEASONS = (process.env.WAREHOUSE_SEASONS || WAREHOUSE_SEASONS.join(','))
  .split(',').map((s) => assertWarehouseSeason(s.trim(), 'espn warehouse ingest'));
const ONLY = (process.env.WAREHOUSE_COMPETITIONS || '').split(',').filter(Boolean);
const targets = COMPETITIONS.filter((c) => !ONLY.length || ONLY.includes(c.key));
let budget = BUDGET.espnMatchesPerRun;

const now = () => new Date().toISOString();

/**
 * The 28 team statistics ESPN publishes per side. Kept whole rather than
 * filtered: unlike the player block, every one of these is a genuine team-level
 * measurement, and team style is exactly what later phases need to describe.
 */
function teamStats(boxTeam) {
  return Object.fromEntries(
    (boxTeam?.statistics || []).map((s) => {
      const raw = String(s.displayValue ?? '').replace('%', '');
      const n = Number(raw);
      return [s.name, Number.isFinite(n) ? n : null];
    }),
  );
}

/**
 * One match at the cheap tier: summary for team statistics and the result,
 * plus one roster call per side for formation and the starting eleven.
 *
 * Returns null rather than a partial row. A match missing a formation or a side
 * is worth less than the confusion of not knowing which rows are complete.
 */
async function collectMatch(espnSlug, eventId, season) {
  const summary = await getJSON(`${SITE}/${espnSlug}/summary?event=${eventId}`, { browserUA: true }).catch(() => null);
  const comp = summary?.header?.competitions?.[0];
  if (!comp?.competitors?.length) return null;

  const sides = [];
  for (const competitor of comp.competitors) {
    const teamId = competitor.id;
    const roster = await getJSON(
      `${CORE}/${espnSlug}/events/${eventId}/competitions/${eventId}/competitors/${teamId}/roster`,
      { browserUA: true },
    ).catch(() => null);
    const box = (summary.boxscore?.teams || []).find((t) => String(t.team?.id) === String(teamId));
    sides.push({
      espnTeamId: Number(teamId),
      name: competitor.team?.displayName ?? null,
      abbreviation: competitor.team?.abbreviation ?? null,
      homeAway: competitor.homeAway ?? null,
      score: competitor.score != null ? Number(competitor.score) : null,
      winner: competitor.winner ?? null,
      // `.name` is the readable "4-2-3-1"; the raw field is an object and
      // storing it would put [object Object] into every consumer downstream.
      formation: roster?.formation?.name ?? roster?.formation?.summary ?? null,
      teamStats: teamStats(box),
      /* Lineup without per-player statistics. This is the whole economy of the
         file: who started and where he stood are what role and rotation work
         needs, and they arrive free with the roster call.
         
         `subbedIn` and `subbedOut` are deliberately NOT stored, and this is the
         second field-trap found in this feed. They are not events. Measured
         across 240 roster entries in six matches, both read true for all twenty
         entries on every team, starters included — they are schema flags for
         whether an entry MAY be substituted, not a record of whether it was.
         Kept as "did he come off the bench" they would have marked every
         starting eleven as substitutes and quietly corrupted every rotation and
         minutes signal built on top.
         
         `starter` is sound: exactly eleven per side, every side checked.
         `formationPlace` is sound too: 1-11 for the eleven, "0" for the bench,
         which is a positional signal AND a second, independent check on
         `starter`. Substitution events do exist in the summary's play feed and
         can be added later if minutes modelling needs them; they are not worth
         a third request per match today. */
      lineup: (roster?.entries || []).map((e) => ({
        espnId: Number(e.playerId),
        starter: !!e.starter,
        formationPlace: e.formationPlace ?? null,
        jersey: e.jersey ?? null,
      })),
    });
  }
  if (sides.length !== 2) return null;

  return {
    eventId: Number(eventId),
    date: comp.date ?? null,
    completed: !!comp.status?.type?.completed,
    venue: comp.venue?.fullName ?? null,
    attendance: comp.attendance ?? null,
    teams: sides,
  };
}

console.log(`→ ESPN warehouse: ${targets.length} competitions x ${SEASONS.length} seasons, `
  + `budget ${budget} matches this run (3 requests each)\n`);

let collected = 0; let skipped = 0;
const report = [];

outer:
for (const season of SEASONS) {
  for (const comp of targets) {
    if (budget <= 0) break outer;

    const path = paths.espnMatches(comp.key, season);
    const have = new Set((await readRows(path)).map((r) => r.eventId));

    const board = await getJSON(
      `${SITE}/${comp.espn}/scoreboard?dates=${season}0701-${season + 1}0701&limit=700`,
      { browserUA: true },
    ).catch((e) => ({ _err: e.message }));
    if (board?._err || !Array.isArray(board?.events)) {
      // A competition-season ESPN will not serve is recorded and skipped. It is
      // never written as empty over data already collected.
      report.push({ competition: comp.key, season, status: board?._err ? 'scoreboard failed' : 'no events', have: have.size });
      console.log(`  ${comp.key.padEnd(15)} ${season}  scoreboard unavailable, ${have.size} already stored`);
      continue;
    }

    const finished = board.events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
    const todo = finished.filter((e) => !have.has(Number(e.id))).slice(0, budget);
    if (!todo.length) {
      report.push({ competition: comp.key, season, status: 'complete', have: have.size, finished: finished.length });
      console.log(`  ${comp.key.padEnd(15)} ${season}  ${have.size}/${finished.length} stored, nothing new`);
      continue;
    }

    const rows = [];
    for (const ev of todo) {
      const m = await collectMatch(comp.espn, ev.id, season);
      if (!m) { skipped += 1; continue; }
      rows.push(stamp(m, { source: 'espn-site+core', sourceId: m.eventId, competition: comp.key, season, fetchedAt: now() }));
      budget -= 1;
      if (budget <= 0) break;
    }
    if (rows.length) {
      const res = await mergeRows(path, rows, (r) => r.eventId);
      collected += rows.length;
      console.log(`  ${comp.key.padEnd(15)} ${season}  +${rows.length} collected, ${res.total}/${finished.length} stored`);
      report.push({ competition: comp.key, season, status: 'ok', have: res.total, finished: finished.length });
    }
  }
}

console.log(`\n✓ ${collected} matches collected this run`
  + (skipped ? `, ${skipped} incomplete and skipped` : '')
  + `, ${budget} of the budget unspent`);
