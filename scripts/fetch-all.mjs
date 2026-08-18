/**
 * Pulls every data source into data/*.json.
 *
 * Runs on a GitHub Actions runner, never in the browser: the FPL API sends no
 * Access-Control-Allow-Origin and sets Cross-Origin-Resource-Policy: same-origin,
 * so a page on *.github.io cannot read it. Snapshotting server-side also removes
 * ESPN's Akamai user-agent filtering as a runtime failure mode for visitors.
 *
 * Env:
 *   FPL_ENTRY_ID   optional — your FPL team id, enables My Team + mini-leagues
 *   FPL_LEAGUE_IDS optional — comma-separated classic league ids to track
 *   DEEP           optional — "1" to sweep element-summary for every player
 */
import { getJSON, mapLimit } from './lib/http.mjs';
import { readJSON, writeJSON, writeJSONIfChanged } from './lib/io.mjs';

const FPL = 'https://fantasy.premierleague.com/api';
// site.web.api, not site.api. Both serve the identical payload, but the
// Akamai policy in front of site.api.espn.com began 403-ing this job on
// 16 Aug 2026 and never recovered — two days of scoreboard, standings and
// news silently frozen at the last good copy while every run "succeeded".
// It is not the user-agent (a browser UA 403s too) and not the query
// string; a bare URL 403s as well, and the block is sticky once tripped.
// site.web.api.espn.com answers the same requests with 200.
const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1';
const ESPN_STANDINGS = 'https://site.web.api.espn.com/apis/v2/sports/soccer/eng.1/standings';

const DATA = 'data';
const ENTRY_ID = (process.env.FPL_ENTRY_ID || '').trim();
const LEAGUE_IDS = (process.env.FPL_LEAGUE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEEP = process.env.DEEP === '1';

const written = [];
const warnings = [];
const note = (path, changed) => {
  if (changed) written.push(path);
};

/* ------------------------------------------------------------------ *
 * 1. bootstrap-static — players, teams, gameweeks, chips, scoring
 * ------------------------------------------------------------------ */
console.log('→ bootstrap-static');
const boot = await getJSON(`${FPL}/bootstrap-static/`);

// Never commit a partial fetch. A truncated payload silently poisons every
// downstream projection, and the previous good snapshot is better than that.
if (!boot?.elements || boot.elements.length < 400) {
  throw new Error(`bootstrap-static looks incomplete: ${boot?.elements?.length ?? 0} elements`);
}
if (!boot?.teams || boot.teams.length !== 20) {
  throw new Error(`bootstrap-static teams looks wrong: ${boot?.teams?.length ?? 0}`);
}

// Slim the player records. bootstrap is ~1.2MB of which we need maybe a fifth,
// and this file is committed on every change.
const KEEP = [
  'id', 'code', 'web_name', 'first_name', 'second_name', 'team', 'team_code',
  'element_type', 'now_cost', 'status', 'news', 'news_added',
  'chance_of_playing_next_round', 'chance_of_playing_this_round',
  'cost_change_event', 'cost_change_start', 'selected_by_percent',
  'transfers_in_event', 'transfers_out_event',
  'form', 'ep_next', 'ep_this', 'points_per_game', 'total_points', 'event_points',
  'minutes', 'starts', 'goals_scored', 'assists', 'clean_sheets', 'goals_conceded',
  'own_goals', 'penalties_saved', 'penalties_missed', 'yellow_cards', 'red_cards',
  'saves', 'bonus', 'bps', 'influence', 'creativity', 'threat', 'ict_index',
  'clearances_blocks_interceptions', 'recoveries', 'tackles', 'defensive_contribution',
  'expected_goals', 'expected_assists', 'expected_goal_involvements', 'expected_goals_conceded',
  'expected_goals_per_90', 'expected_assists_per_90', 'expected_goal_involvements_per_90',
  'expected_goals_conceded_per_90', 'saves_per_90', 'goals_conceded_per_90',
  'starts_per_90', 'clean_sheets_per_90', 'defensive_contribution_per_90',
  'corners_and_indirect_freekicks_order', 'direct_freekicks_order', 'penalties_order',
  'penalties_text', 'corners_and_indirect_freekicks_text', 'direct_freekicks_text',
];

const elements = boot.elements.map((e) => {
  const o = {};
  for (const k of KEEP) if (e[k] !== undefined) o[k] = e[k];
  return o;
});

note('data/bootstrap.json', await writeJSONIfChanged(`${DATA}/bootstrap.json`, {
  elements,
  teams: boot.teams,
  element_types: boot.element_types,
  events: boot.events,
  chips: boot.chips,
  phases: boot.phases,
  game_settings: boot.game_settings,
  game_config: boot.game_config,
  element_stats: boot.element_stats,
  total_players: boot.total_players,
}));

const events = boot.events || [];
const currentGW = events.find((e) => e.is_current)?.id ?? null;
const nextGW = events.find((e) => e.is_next)?.id ?? null;

/* ------------------------------------------------------------------ *
 * 2. fixtures — full season, with FPL's own difficulty ratings
 * ------------------------------------------------------------------ */
console.log('→ fixtures');
const fixtures = await getJSON(`${FPL}/fixtures/`);
if (!Array.isArray(fixtures) || fixtures.length < 300) {
  throw new Error(`fixtures looks incomplete: ${fixtures?.length ?? 0}`);
}
note('data/fixtures.json', await writeJSONIfChanged(`${DATA}/fixtures.json`, fixtures));

/* ------------------------------------------------------------------ *
 * 3. event-status — the cheap poll that says whether a GW is settled
 * ------------------------------------------------------------------ */
console.log('→ event-status');
const eventStatus = await getJSON(`${FPL}/event-status/`).catch((e) => {
  warnings.push(`event-status: ${e.message}`);
  return null;
});
if (eventStatus) note('data/event-status.json', await writeJSONIfChanged(`${DATA}/event-status.json`, eventStatus));

/* ------------------------------------------------------------------ *
 * 4. live gameweek scoring
 * ------------------------------------------------------------------ */
const liveGW = currentGW ?? nextGW;
if (liveGW) {
  console.log(`→ event/${liveGW}/live`);
  const live = await getJSON(`${FPL}/event/${liveGW}/live/`).catch((e) => {
    warnings.push(`live: ${e.message}`);
    return null;
  });
  if (live?.elements) {
    // Keep only what the dashboard renders — the full payload carries every
    // element_stat for every player and is mostly zeroes.
    const slim = live.elements.map((el) => ({
      id: el.id,
      total_points: el.stats?.total_points ?? 0,
      minutes: el.stats?.minutes ?? 0,
      goals_scored: el.stats?.goals_scored ?? 0,
      assists: el.stats?.assists ?? 0,
      clean_sheets: el.stats?.clean_sheets ?? 0,
      saves: el.stats?.saves ?? 0,
      defensive_contribution: el.stats?.defensive_contribution ?? 0,
      bonus: el.stats?.bonus ?? 0,
      bps: el.stats?.bps ?? 0,
      yellow_cards: el.stats?.yellow_cards ?? 0,
      red_cards: el.stats?.red_cards ?? 0,
      // one entry per fixture — this is how double gameweeks surface
      fixtures: (el.explain || []).map((x) => x.fixture),
    }));
    note(`data/live.json`, await writeJSONIfChanged(`${DATA}/live.json`, { event: liveGW, elements: slim }));
  }
}

/* ------------------------------------------------------------------ *
 * 5. set-piece notes — official, per club
 * ------------------------------------------------------------------ */
console.log('→ set-piece notes');
const setPieces = await getJSON(`${FPL}/team/set-piece-notes/`).catch((e) => {
  warnings.push(`set-piece-notes: ${e.message}`);
  return null;
});
if (setPieces) note('data/set-pieces.json', await writeJSONIfChanged(`${DATA}/set-pieces.json`, setPieces));

/* ------------------------------------------------------------------ *
 * 6. your team + mini-leagues (optional)
 * ------------------------------------------------------------------ */
if (ENTRY_ID) {
  console.log(`→ entry ${ENTRY_ID}`);
  const entry = await getJSON(`${FPL}/entry/${ENTRY_ID}/`).catch((e) => {
    warnings.push(`entry: ${e.message}`);
    return null;
  });
  const history = await getJSON(`${FPL}/entry/${ENTRY_ID}/history/`).catch(() => null);
  const transfers = await getJSON(`${FPL}/entry/${ENTRY_ID}/transfers/`).catch(() => null);
  // picks 404 until that gameweek's deadline has passed
  const picks = currentGW
    ? await getJSON(`${FPL}/entry/${ENTRY_ID}/event/${currentGW}/picks/`).catch(() => null)
    : null;

  if (entry) {
    note('data/entry.json', await writeJSONIfChanged(`${DATA}/entry.json`, {
      entry, history, transfers, picks, picks_event: currentGW,
    }));
  }

  const ids = LEAGUE_IDS.length
    ? LEAGUE_IDS
    : (entry?.leagues?.classic || [])
        .filter((l) => l.league_type === 'x') // private leagues only — skip "Overall"
        .map((l) => String(l.id));

  const leagues = [];
  for (const id of ids.slice(0, 8)) {
    const standings = await getJSON(`${FPL}/leagues-classic/${id}/standings/`).catch(() => null);
    if (standings) leagues.push(standings);
  }
  if (leagues.length) note('data/leagues.json', await writeJSONIfChanged(`${DATA}/leagues.json`, leagues));
} else {
  warnings.push('FPL_ENTRY_ID not set — My Team and mini-league tracking are disabled.');
}

/* ------------------------------------------------------------------ *
 * 7. per-player match logs (optional, ~700 requests)
 * ------------------------------------------------------------------ */
if (DEEP) {
  console.log('→ element-summary sweep (deep)');
  // Only players with a realistic chance of being owned — the full 587-player
  // sweep costs ~10 minutes of runner time for data nobody reads.
  const targets = elements
    .filter((e) => e.status === 'a' || e.status === 'd')
    .filter((e) => parseFloat(e.selected_by_percent) > 0.3 || e.total_points > 40)
    .map((e) => e.id);
  console.log(`   ${targets.length} players`);
  const summaries = await mapLimit(targets, 4, async (id) => {
    const s = await getJSON(`${FPL}/element-summary/${id}/`).catch(() => null);
    if (!s) return null;
    return { id, history: s.history || [], fixtures: (s.fixtures || []).slice(0, 8) };
  });
  const map = {};
  for (const s of summaries) if (s) map[s.id] = s;
  note('data/summaries.json', await writeJSONIfChanged(`${DATA}/summaries.json`, map));
}

/* ------------------------------------------------------------------ *
 * 8. ESPN — live scores, standings, news
 * ------------------------------------------------------------------ */
console.log('→ ESPN scoreboard');
const today = new Date();
const from = new Date(today.getTime() - 3 * 864e5);
const to = new Date(today.getTime() + 10 * 864e5);
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

const scoreboard = await getJSON(
  `${ESPN}/scoreboard?dates=${ymd(from)}-${ymd(to)}&limit=200`,
  { browserUA: true },
).catch((e) => {
  warnings.push(`espn scoreboard: ${e.message}`);
  return null;
});
if (scoreboard) {
  const slim = (scoreboard.events || []).map((ev) => {
    const c = ev.competitions?.[0] || {};
    const side = (ha) => {
      const t = (c.competitors || []).find((x) => x.homeAway === ha) || {};
      return {
        id: t.team?.id, name: t.team?.displayName, short: t.team?.abbreviation,
        logo: t.team?.logo || t.team?.logos?.[0]?.href, score: t.score,
      };
    };
    return {
      id: ev.id, date: ev.date, name: ev.shortName,
      state: c.status?.type?.state, detail: c.status?.type?.shortDetail,
      clock: c.status?.displayClock, venue: c.venue?.fullName,
      home: side('home'), away: side('away'),
    };
  });
  note('data/espn-scoreboard.json', await writeJSONIfChanged(`${DATA}/espn-scoreboard.json`, {
    calendar: scoreboard.leagues?.[0]?.calendar || [],
    events: slim,
  }));
}

console.log('→ ESPN standings');
const standings = await getJSON(`${ESPN_STANDINGS}?season=${today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1}`, { browserUA: true }).catch((e) => {
  warnings.push(`espn standings: ${e.message}`);
  return null;
});
if (standings) {
  const entries = (standings.children?.[0]?.standings?.entries || []).map((en) => {
    const stat = (n) => en.stats?.find((s) => s.name === n)?.value ?? 0;
    return {
      team: en.team?.displayName, short: en.team?.abbreviation, id: en.team?.id,
      logo: en.team?.logos?.[0]?.href,
      rank: stat('rank'), played: stat('gamesPlayed'), wins: stat('wins'),
      draws: stat('ties'), losses: stat('losses'), gf: stat('pointsFor'),
      ga: stat('pointsAgainst'), gd: stat('pointDifferential'), points: stat('points'),
    };
  });
  note('data/espn-standings.json', await writeJSONIfChanged(`${DATA}/espn-standings.json`, entries));
}

console.log('→ ESPN news');
const news = await getJSON(`${ESPN}/news`, { browserUA: true }).catch(() => null);
if (news) {
  const slim = (news.articles || []).slice(0, 30).map((a) => ({
    headline: a.headline, description: a.description, published: a.published,
    link: a.links?.web?.href, image: a.images?.[0]?.url,
  }));
  note('data/espn-news.json', await writeJSONIfChanged(`${DATA}/espn-news.json`, slim));
}

/* ------------------------------------------------------------------ *
 * 9. price history — appended, never overwritten
 * ------------------------------------------------------------------ */
const priceFile = `${DATA}/price-history.json`;
const hist = (await readJSON(priceFile, { updated: null, players: {} })) || { players: {} };
hist.players ||= {};
const stamp = new Date().toISOString().slice(0, 10);
let priceChanges = 0;
for (const e of elements) {
  const series = (hist.players[e.id] ||= []);
  const last = series[series.length - 1];
  if (!last || last[1] !== e.now_cost) {
    series.push([stamp, e.now_cost]);
    if (last) priceChanges++;
  }
}
hist.updated = new Date().toISOString();
note('data/price-history.json', await writeJSONIfChanged(priceFile, hist));

/* ------------------------------------------------------------------ */
await writeJSON(`${DATA}/meta.json`, {
  source: 'live',
  fetched_at: new Date().toISOString(),
  current_gw: currentGW,
  next_gw: nextGW,
  next_deadline: events.find((e) => e.id === nextGW)?.deadline_time ?? null,
  player_count: elements.length,
  total_players: boot.total_players,
  entry_id: ENTRY_ID || null,
  price_changes_this_run: priceChanges,
  deep: DEEP,
  warnings,
});

console.log(`\n✓ done. changed: ${written.length ? written.join(', ') : 'nothing'}`);
if (warnings.length) console.log('warnings:\n  ' + warnings.join('\n  '));
