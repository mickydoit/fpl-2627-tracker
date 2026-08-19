/**
 * One-off coverage probe for API-Football. READ ONLY — writes no files and
 * commits nothing.
 *
 * The question this answers, and nothing else: does the FREE plan actually
 * expose 2026/27 Premier League fixtures, lineups, team stats and player
 * stats? The free tier limits which seasons you get and does not enumerate
 * them anywhere public, so documentation cannot settle it. Six requests can.
 *
 * Budget note: the free plan is 100 requests/day, resetting 00:00 UTC. This
 * script is capped at 8 and prints its own consumption at the end.
 *
 * Run from the Action, never locally — the key lives in Actions secrets.
 */
const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) {
  console.error('API_FOOTBALL_KEY is not set. Add it with:');
  console.error('  gh secret set API_FOOTBALL_KEY --repo mickydoit/fpl-2627-tracker');
  process.exit(1);
}

const HOST = 'https://v3.football.api-sports.io';
const PL = 39;        // England · Premier League, confirmed below rather than assumed
const SEASON = 2026;  // API-Football names a season by its starting year

let spent = 0;
const MAX = 8;

/**
 * API-Football signals plan restrictions with HTTP 200 and a populated
 * `errors` object, so a naive `res.ok` check reports success on a refusal.
 * Every call goes through here for that reason.
 */
async function call(path) {
  if (spent >= MAX) throw new Error(`request cap (${MAX}) reached — refusing to spend more quota`);
  spent += 1;
  const res = await fetch(`${HOST}${path}`, { headers: { 'x-apisports-key': KEY } });
  const body = await res.json().catch(() => null);
  const errors = body?.errors;
  const hasErrors = errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length);
  return {
    http: res.status,
    ok: res.ok && !hasErrors,
    errors: hasErrors ? errors : null,
    results: body?.results ?? 0,
    response: body?.response ?? null,
    raw: body,
  };
}

const line = (s = '') => console.log(s);
const rule = (t) => { line(); line(`── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`); };
const verdict = (ok, t) => line(`  ${ok ? '✓' : '✗'} ${t}`);

/* ------------------------------------------------------------------ *
 * 1. account + plan
 * ------------------------------------------------------------------ */
rule('ACCOUNT');
const status = await call('/status');
if (!status.ok) {
  line(`  ✗ /status failed — http ${status.http} ${JSON.stringify(status.errors)}`);
  line('  The key is probably wrong or not yet active. Nothing else can be tested.');
  process.exit(1);
}
const sub = status.response?.subscription || {};
const req = status.response?.requests || {};
line(`  plan            ${sub.plan}`);
line(`  active          ${sub.active}   ends ${sub.end}`);
line(`  requests today  ${req.current} / ${req.limit_day}`);

/* ------------------------------------------------------------------ *
 * 2. league identity + per-season coverage
 *
 * This is the decisive call. /leagues returns, for every season, a `coverage`
 * object stating which endpoints are available for that league and season on
 * THIS plan. It answers the whole question in one request.
 * ------------------------------------------------------------------ */
rule('PREMIER LEAGUE COVERAGE');
const leagues = await call(`/leagues?id=${PL}`);
if (!leagues.ok || !leagues.results) {
  line(`  ✗ /leagues?id=${PL} returned nothing — http ${leagues.http} ${JSON.stringify(leagues.errors)}`);
} else {
  const entry = leagues.response[0];
  line(`  league          ${entry.league.name} (id ${entry.league.id}) · ${entry.country.name}`);
  const seasons = entry.seasons || [];
  line(`  seasons on plan ${seasons.map((s) => s.year).join(', ') || 'none'}`);

  const target = seasons.find((s) => s.year === SEASON);
  if (!target) {
    line();
    line(`  ✗✗ SEASON ${SEASON} IS NOT AVAILABLE ON THIS PLAN.`);
    line('     Phase 2D (player role profiles) cannot be built on API-Football.');
  } else {
    const c = target.coverage || {};
    const f = c.fixtures || {};
    line();
    line(`  season ${SEASON} coverage:`);
    verdict(f.events, 'fixture events');
    verdict(f.lineups, 'lineups + formations');
    verdict(f.statistics_fixtures, 'team match statistics');
    verdict(f.statistics_players, 'PLAYER match statistics  ← the reason we are here');
    verdict(c.players, 'players');
    verdict(c.injuries, 'injuries');
    verdict(c.odds, 'odds (unused)');
    line(`     current season flag: ${target.current}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. do 2026/27 fixtures actually exist yet?
 * ------------------------------------------------------------------ */
rule(`FIXTURES · season ${SEASON}`);
const fx = await call(`/fixtures?league=${PL}&season=${SEASON}`);
if (!fx.ok) {
  line(`  ✗ http ${fx.http} ${JSON.stringify(fx.errors)}`);
} else {
  line(`  fixtures returned  ${fx.results}`);
  const finished = (fx.response || []).filter((x) => x.fixture?.status?.short === 'FT');
  line(`  finished so far    ${finished.length}`);
  const first = (fx.response || [])[0];
  if (first) {
    line(`  first fixture      ${first.fixture.date.slice(0, 16)}  ${first.teams.home.name} v ${first.teams.away.name}`);
  }

  /* 4. If nothing has been played this season we cannot prove the match-detail
   *    endpoints against it. Fall back to the most recent FINISHED fixture on
   *    the plan so the endpoints themselves are still tested for real. */
  const probeId = finished.at(-1)?.fixture?.id ?? null;
  if (probeId) {
    rule(`MATCH DETAIL · fixture ${probeId} (this season)`);
    await matchDetail(probeId);
  } else {
    line();
    line('  Nothing has kicked off in 2026/27 yet, so match-detail endpoints are');
    line('  tested against the previous season instead — that proves the endpoints,');
    line('  not the season. Season-2026 coverage is what the flags above report.');
    const prev = await call(`/fixtures?league=${PL}&season=${SEASON - 1}&round=Regular Season - 38`);
    const prevId = prev.ok ? prev.response?.[0]?.fixture?.id : null;
    if (prevId) {
      rule(`MATCH DETAIL · fixture ${prevId} (season ${SEASON - 1})`);
      await matchDetail(prevId);
    } else {
      line(`  ✗ could not find a finished fixture in season ${SEASON - 1} either`);
      line(`    (http ${prev.http} ${JSON.stringify(prev.errors)})`);
    }
  }
}

async function matchDetail(fixtureId) {
  const lineups = await call(`/fixtures/lineups?fixture=${fixtureId}`);
  verdict(lineups.ok && lineups.results > 0, `lineups — ${lineups.results} teams` +
    (lineups.ok && lineups.results ? `, formation ${lineups.response[0].formation}` : ` ${JSON.stringify(lineups.errors || '')}`));

  const teamStats = await call(`/fixtures/statistics?fixture=${fixtureId}`);
  verdict(teamStats.ok && teamStats.results > 0, `team statistics — ${teamStats.results} teams` +
    (teamStats.ok && teamStats.results ? `, ${teamStats.response[0].statistics.length} stats each` : ` ${JSON.stringify(teamStats.errors || '')}`));

  const players = await call(`/fixtures/players?fixture=${fixtureId}`);
  const sample = players.ok && players.results ? players.response[0]?.players?.[0]?.statistics?.[0] : null;
  verdict(players.ok && players.results > 0, `PLAYER statistics — ${players.results} teams` +
    (players.ok && players.results ? '' : ` ${JSON.stringify(players.errors || '')}`));
  if (sample) {
    // The whole justification for this provider is per-player detail FPL and
    // ESPN do not carry. Print the actual field groups rather than claiming it.
    line(`      groups: ${Object.keys(sample).join(', ')}`);
    line(`      passes: ${JSON.stringify(sample.passes)}`);
    line(`      dribbles: ${JSON.stringify(sample.dribbles)}`);
    line(`      duels: ${JSON.stringify(sample.duels)}`);
    line(`      tackles: ${JSON.stringify(sample.tackles)}`);
    line(`      shots: ${JSON.stringify(sample.shots)}  rating: ${sample.games?.rating}`);
  }
}

rule('BUDGET');
line(`  requests spent by this probe  ${spent}`);
const after = await call('/status').catch(() => null);
if (after?.ok) {
  const r = after.response.requests;
  line(`  account now reports           ${r.current} / ${r.limit_day} used today`);
}
line();
