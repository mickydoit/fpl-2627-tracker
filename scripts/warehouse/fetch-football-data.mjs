/**
 * football-data.org — the structural spine.
 *
 * ── What this source is for, and what it is not ──
 *
 * Probed against the live free tier before any of this was designed. It carries
 * thirteen competitions on TIER_ONE, nine of which we want, with full
 * historical seasons: a 2023/24 Premier League request returns all 380 matches
 * with scores, matchday, stage, venue and referee.
 *
 * It does NOT carry lineups, formations, per-match team statistics, or coaches.
 * Every one of those reads null or absent on this plan, verified rather than
 * assumed. So this source is deliberately not the performance layer — ESPN is.
 * What it gives, and gives better than ESPN, is STRUCTURE:
 *
 *   - canonical club identity and TLA, stable across seasons and competitions,
 *     which is what lets a team be followed from the Championship into the
 *     Premier League;
 *   - a complete fixture and result spine per competition-season;
 *   - league tables, which is where promotion, relegation and a first honest
 *     measure of team quality come from;
 *   - season squad lists carrying date of birth and nationality — the two
 *     attributes that make player identity resolvable across leagues, and the
 *     reason a foreign signing can be recognised as the same human.
 *
 * ── Cost ──
 *
 * Ten requests per minute on the free tier, which is the entire operating
 * constraint. One competition-season costs three requests (matches, teams,
 * standings), so the whole six-season, nine-competition backfill is about 160
 * requests — roughly sixteen minutes of wall clock, done once.
 *
 * ── Failure ──
 *
 * No token, no network, or a plan change all produce the same outcome: a
 * warning, exit 0, and every committed file left exactly as it was.
 */
import { getJSON } from '../lib/http.mjs';
import { writeRows, paths, stamp } from './store.mjs';
import { COMPETITIONS, WAREHOUSE_SEASONS, assertWarehouseSeason, BUDGET, seasonsFor } from './config.mjs';

const API = 'https://api.football-data.org/v4';
const TOKEN = process.env.FOOTBALL_DATA_TOKEN || '';

if (!TOKEN) {
  console.warn('✗ FOOTBALL_DATA_TOKEN not set — leaving any committed structural data untouched');
  process.exit(0);
}

/** The free tier allows ten requests a minute. Stay under it deliberately. */
const GAP_MS = Math.ceil(60000 / BUDGET.footballDataPerMinute) + 500;
let lastCall = 0;
async function fd(path) {
  const wait = Math.max(0, GAP_MS - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return getJSON(`${API}${path}`, { headers: { 'X-Auth-Token': TOKEN }, retries: 2 });
}

/* The free tier answers 403 below 2023, so asking is not politeness, it is
   three wasted retries per competition-season. Requested seasons are filtered
   to what this source can serve and the difference is reported, not hidden. */
const REQUESTED = (process.env.WAREHOUSE_SEASONS || WAREHOUSE_SEASONS.join(','))
  .split(',').map((s) => assertWarehouseSeason(s.trim(), 'football-data ingest'));
const SEASONS = seasonsFor('football-data', REQUESTED);
const dropped = REQUESTED.filter((y) => !SEASONS.includes(y));
if (dropped.length) {
  console.log(`  skipping ${dropped.join(', ')} — outside this plan's history (measured: 403)`);
}
const ONLY = (process.env.WAREHOUSE_COMPETITIONS || '').split(',').filter(Boolean);
const targets = COMPETITIONS.filter((c) => c.footballData).filter((c) => !ONLY.length || ONLY.includes(c.key));

console.log(`→ football-data.org: ${targets.length} competitions x ${SEASONS.length} seasons`);
console.log(`  ${BUDGET.footballDataPerMinute} req/min ceiling, ${GAP_MS}ms between calls\n`);

const now = () => new Date().toISOString();
let requests = 0; let wrote = 0; let skipped = 0;
const report = [];

for (const comp of targets) {
  for (const season of SEASONS) {
    const prov = { source: 'football-data.org', competition: comp.key, season, fetchedAt: now() };
    const line = { competition: comp.key, season, matches: 0, teams: 0, squad: 0, standings: 0, status: 'ok' };

    /* --- matches: the fixture and result spine ------------------------- */
    const mj = await fd(`/competitions/${comp.footballData}/matches?season=${season}`).catch((e) => ({ _err: e.message }));
    requests += 1;
    if (mj?._err || !Array.isArray(mj?.matches)) {
      line.status = mj?._err ? `matches failed: ${mj._err}` : 'no matches';
      // Not fatal and not an overwrite: whatever is on disk stays.
      report.push(line); skipped += 1;
      console.log(`  ${comp.key.padEnd(15)} ${season}  ${line.status}`);
      continue;
    }
    const matchRows = mj.matches.map((m) => stamp({
      matchId: m.id,
      utcDate: m.utcDate,
      status: m.status,
      matchday: m.matchday ?? null,
      stage: m.stage ?? null,
      group: m.group ?? null,
      venue: m.venue ?? null,
      homeTeamId: m.homeTeam?.id ?? null,
      homeTeamName: m.homeTeam?.name ?? null,
      homeTeamTla: m.homeTeam?.tla ?? null,
      awayTeamId: m.awayTeam?.id ?? null,
      awayTeamName: m.awayTeam?.name ?? null,
      awayTeamTla: m.awayTeam?.tla ?? null,
      // Nulls, never zeros: an unplayed or postponed match has no score, and
      // storing 0-0 for it would read as a genuine goalless draw downstream.
      homeGoals: m.score?.fullTime?.home ?? null,
      awayGoals: m.score?.fullTime?.away ?? null,
      homeGoalsHT: m.score?.halfTime?.home ?? null,
      awayGoalsHT: m.score?.halfTime?.away ?? null,
      winner: m.score?.winner ?? null,
      duration: m.score?.duration ?? null,
      referee: m.referees?.[0]?.name ?? null,
    }, { ...prov, sourceId: m.id }));
    const r1 = await writeRows(paths.fdMatches(comp.key, season), matchRows);
    line.matches = matchRows.length;
    if (r1.written) wrote += 1;

    /* --- teams and squads: identity, DOB, nationality ------------------ */
    const tj = await fd(`/competitions/${comp.footballData}/teams?season=${season}`).catch((e) => ({ _err: e.message }));
    requests += 1;
    if (Array.isArray(tj?.teams)) {
      const teamRows = tj.teams.map((t) => stamp({
        teamId: t.id,
        name: t.name,
        shortName: t.shortName ?? null,
        tla: t.tla ?? null,
        founded: t.founded ?? null,
        venue: t.venue ?? null,
        areaName: t.area?.name ?? null,
        // Verified null on this plan for every club checked. Kept as a field so
        // the shape does not change if the plan ever starts populating it.
        coachName: t.coach?.name ?? null,
        coachId: t.coach?.id ?? null,
        squad: (t.squad || []).map((p) => ({
          playerId: p.id, name: p.name, position: p.position ?? null,
          dateOfBirth: p.dateOfBirth ?? null, nationality: p.nationality ?? null,
        })),
      }, { ...prov, sourceId: t.id }));
      const r2 = await writeRows(paths.fdTeams(comp.key, season), teamRows);
      line.teams = teamRows.length;
      line.squad = teamRows.reduce((a, t) => a + t.squad.length, 0);
      if (r2.written) wrote += 1;
    } else line.status = 'teams unavailable';

    /* --- standings: promotion, relegation, and a first team-quality read */
    const sj = await fd(`/competitions/${comp.footballData}/standings?season=${season}`).catch((e) => ({ _err: e.message }));
    requests += 1;
    const table = (sj?.standings || []).find((s) => s.type === 'TOTAL' && s.stage === 'REGULAR_SEASON')?.table;
    if (Array.isArray(table)) {
      const rows = table.map((r) => stamp({
        position: r.position,
        teamId: r.team?.id ?? null,
        teamName: r.team?.name ?? null,
        teamTla: r.team?.tla ?? null,
        played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost,
        points: r.points, goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst,
        goalDifference: r.goalDifference,
      }, prov));
      const r3 = await writeRows(paths.fdStandings(comp.key, season), rows);
      line.standings = rows.length;
      if (r3.written) wrote += 1;
    }

    report.push(line);
    console.log(`  ${comp.key.padEnd(15)} ${season}  matches ${String(line.matches).padStart(3)}`
      + `  teams ${String(line.teams).padStart(2)}  squad ${String(line.squad).padStart(4)}`
      + `  table ${String(line.standings).padStart(2)}  ${line.status === 'ok' ? '' : line.status}`);
  }
}

console.log(`\n✓ ${requests} requests, ${wrote} files written, ${skipped} competition-seasons unavailable`);
