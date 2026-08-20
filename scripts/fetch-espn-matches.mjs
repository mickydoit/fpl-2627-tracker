/**
 * Collect per-match player and team detail from ESPN, once per match, forever.
 *
 * This is the incremental store. A finished match never changes, so it is
 * fetched exactly once and then read from the repository for the rest of the
 * season — the repo gradually becomes its own Premier League dataset rather
 * than re-downloading history every run.
 *
 * Two ESPN surfaces are used, because they carry different things:
 *
 *   site.web.api  /summary?event=      28 team stats per side, in one call
 *   sports.core.api  .../roster        formation, starter/sub, shirt position
 *   sports.core.api  .../statistics    94 fields for ONE player-match
 *
 * The core API is the reason this is worth doing at all. The site API returns
 * the same 14 fields for a keeper and a winger; the core API returns key
 * passes, passing volume, crosses, tackles, shot location and headed shots,
 * which is what role inference and expected-minutes actually need.
 *
 * Everything is joined to FPL through data/identity/players.json. A player who
 * is not in that map is stored with a null code rather than guessed at — his
 * match is still collected, he simply cannot be attributed yet.
 *
 * Nothing here is on the draft-night path. If ESPN disappears, the committed
 * store stays and every FPL-derived number is untouched.
 */
import { readdir } from 'node:fs/promises';
import { getJSON, mapLimit } from './lib/http.mjs';
import { readJSON, writeJSONIfChanged } from './lib/io.mjs';

const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.1';
const SITE = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const DIR = 'data/history/matches';

/** Season is named by its starting year: 2026/27 is `2026`. */
const SEASON = Number(process.env.ESPN_SEASON || new Date().getUTCFullYear() - (new Date().getUTCMonth() < 6 ? 1 : 0));
/** A cap so the first run of a backlog cannot spend an hour of runner time. */
const MAX_MATCHES = Number(process.env.ESPN_MAX_MATCHES || 12);

/**
 * The fields worth keeping out of the 94 available.
 *
 * Storing everything because the API offers it is how a store becomes
 * unreadable. Each of these earns its place against something the model wants
 * to answer: minutes and role security, shot volume and location, chance
 * creation, wide play, defensive contribution, keeper workload.
 */
const KEEP = {
  general: ['minutes', 'appearances', 'subIns', 'foulsCommitted', 'foulsSuffered',
    'yellowCards', 'redCards'],
  offensive: ['totalGoals', 'goalAssists', 'shotAssists', 'totalShots', 'shotsOnTarget',
    'headedGoals',
    'totalCrosses', 'accurateCrosses', 'totalPasses', 'accuratePasses',
    'totalLongBalls', 'accurateLongBalls', 'totalThroughBalls', 'offsides'],
  defensive: ['totalTackles', 'effectiveTackles', 'interceptions', 'blockedShots', 'totalClearance'],
  goalKeeping: ['saves', 'goalsConceded', 'crossesCaught', 'punches', 'cleanSheet'],
};

/**
 * Deliberately NOT kept, and this list matters more than the one above.
 *
 * `attemptsInBox` / `attemptsOutBox` sit in the player's own statistics block
 * and look exactly like his shot locations. They are not. They are the TEAM's
 * shots in and out of the box during the minutes that player was on the pitch.
 * Checked on Liverpool v Bournemouth: every player who lasted 90 minutes reads
 * 8 and 2 — including the goalkeeper, who took no shots at all — while players
 * introduced at 60' read 5 and 1. Stored as a player stat it would have made
 * every regular starter look like a penalty-box poacher, and the error would
 * have been invisible in every chart built on top of it.
 *
 * `shotsFaced` reads 0 for a keeper who conceded twice, so it is not what its
 * name suggests either. `avgRatingFromDataFeed` is 0 for every player in the
 * feed we can reach — the rating is simply not populated here.
 *
 * `shotsHeaded` is in the schema and never populated: zero across all 239
 * player-matches in an eight-match sample that contained 22 goals, three of
 * them headers. `headedGoals` does populate, so heading is only visible when it
 * produces a goal — far too sparse to profile a target forward on.
 *
 * The cost is real and worth stating plainly, because the audit promised more
 * than this feed delivers: without trustworthy shot location the box-striker
 * versus mobile-forward split is weak, and the target-forward archetype is not
 * buildable at all. Shot volume, crosses, key passes and defensive actions are
 * unaffected and still carry most of the role work.
 */
const REJECTED = ['attemptsInBox', 'attemptsOutBox', 'shotsFaced', 'avgRatingFromDataFeed', 'shotsHeaded'];

const identity = await readJSON('data/identity/players.json');
if (!identity?.players) {
  console.warn('no identity map — run scripts/build-identity.mjs first. Nothing collected.');
  process.exit(0);
}
/** espnId → FPL code. The map is keyed by code, so invert it once. */
const codeByEspnId = new Map(
  Object.values(identity.players).map((p) => [String(p.espnId), p.code]),
);

const existing = new Set(
  (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')),
);
console.log(`store holds ${existing.size} matches`);

/* ------------------------------------------------------------------ *
 * which matches are finished and not yet stored?
 * ------------------------------------------------------------------ */
console.log(`→ season ${SEASON} fixture list`);

// One call covers the entire season and reports completion per fixture. The
// first version of this walked a rolling six-week scoreboard window, which
// worked and was quietly wrong: a run missed for longer than the window would
// have skipped those matches permanently, with nothing to show it had. Asking
// for the whole season every time costs one request and cannot drift.
const seasonRange = `${SEASON}0801-${SEASON + 1}0601`;
const board = await getJSON(`${SITE}/scoreboard?dates=${seasonRange}&limit=400`, { browserUA: true })
  .catch((e) => { console.warn(`  scoreboard failed: ${e.message}`); return null; });
if (!board?.events?.length) {
  console.warn('✗ no fixture list — leaving the store untouched');
  process.exit(0);
}

const finished = board.events.filter((ev) => ev.competitions?.[0]?.status?.type?.completed);
const targets = finished.map((ev) => String(ev.id)).filter((id) => !existing.has(id)).slice(0, MAX_MATCHES);
console.log(`  ${board.events.length} fixtures, ${finished.length} finished, ${targets.length} to collect now`);
if (!targets.length) {
  console.log('✓ nothing new to collect');
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * collect one match
 * ------------------------------------------------------------------ */
function pick(categories) {
  const out = {};
  for (const cat of categories || []) {
    const wanted = KEEP[cat.name];
    if (!wanted) continue;
    for (const s of cat.stats || []) {
      if (wanted.includes(s.name) && s.value != null) out[s.name] = s.value;
    }
  }
  return out;
}

async function collect(eventId) {
  const summary = await getJSON(`${SITE}/summary?event=${eventId}`, { browserUA: true }).catch(() => null);
  const comp = summary?.header?.competitions?.[0];
  if (!comp) return null;

  const teams = [];
  for (const competitor of comp.competitors || []) {
    const teamId = competitor.id;
    const roster = await getJSON(
      `${CORE}/events/${eventId}/competitions/${eventId}/competitors/${teamId}/roster`,
      { browserUA: true },
    ).catch(() => null);
    if (!roster?.entries) continue;

    const players = await mapLimit(roster.entries, 4, async (entry) => {
      const ref = entry.statistics?.$ref;
      const stats = ref ? await getJSON(ref.replace(/^http:/, 'https:'), { browserUA: true }).catch(() => null) : null;
      const espnId = String(entry.playerId);
      return {
        espnId: Number(espnId),
        // null, never a guess: an unmapped player is still collected, he simply
        // cannot be attributed to an FPL registration yet.
        code: codeByEspnId.get(espnId) ?? null,
        starter: !!entry.starter,
        subbedIn: !!entry.subbedIn,
        subbedOut: !!entry.subbedOut,
        formationPlace: entry.formationPlace ?? null,
        jersey: entry.jersey ?? null,
        stats: pick(stats?.splits?.categories),
      };
    });

    const boxTeam = (summary.boxscore?.teams || []).find((t) => String(t.team?.id) === String(teamId));
    teams.push({
      espnTeamId: Number(teamId),
      name: competitor.team?.displayName ?? null,
      abbreviation: competitor.team?.abbreviation ?? null,
      homeAway: competitor.homeAway,
      score: Number(competitor.score ?? 0),
      // The core API returns an object here; the readable shape is `.name`
      // ("4-2-3-1"). Storing the object would put "[object Object]" in every
      // consumer that expects a string.
      formation: roster.formation?.name ?? roster.formation?.summary ?? null,
      teamStats: Object.fromEntries(
        (boxTeam?.statistics || []).map((s) => [s.name, Number(s.displayValue?.replace('%', '')) || 0]),
      ),
      players,
    });
  }
  if (teams.length !== 2) return null;

  return {
    eventId: Number(eventId),
    season: SEASON,
    date: comp.date ?? null,
    collectedAt: new Date().toISOString(),
    source: 'espn-core+site',
    teams,
  };
}

let collected = 0;
let unattributed = 0;
for (const id of targets) {
  const match = await collect(id);
  if (!match) { console.warn(`  ✗ ${id} incomplete, skipped`); continue; }
  const missing = match.teams.flatMap((t) => t.players).filter((p) => !p.code).length;
  unattributed += missing;
  await writeJSONIfChanged(`${DIR}/${id}.json`, match);
  collected += 1;
  const [a, b] = match.teams;
  console.log(`  ✓ ${id}  ${a.abbreviation} ${a.score}-${b.score} ${b.abbreviation}  `
    + `${a.formation} v ${b.formation}  ${match.teams.flatMap((t) => t.players).length} players`
    + (missing ? `, ${missing} unattributed` : ''));
}

console.log(`\n✓ ${collected} matches collected, store now holds ${existing.size + collected}`);
if (unattributed) console.log(`  ${unattributed} player-matches could not be attributed to an FPL code`);
