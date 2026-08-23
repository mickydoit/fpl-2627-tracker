/**
 * ESPN 2025/26 evidence for players the Premier League has never seen.
 *
 * A summer signing from La Liga arrives with no FPL history at all, and the
 * model's only remaining answer is a price prior. ESPN knows he played 2,668
 * minutes in Spain last season. That is real evidence about a real footballer,
 * and it is the difference between "we know nothing" and "we know what he did,
 * just not here".
 *
 * ── The season boundary is enforced at the door ──
 *
 * Only 2025/26 and 2026/27 may be requested, written or read. ESPN's discovery
 * endpoints happily list a player's whole career; seeing those seasons is
 * allowed, keeping them is not. Every record is validated through
 * js/seasons.js before it is written, so stale evidence cannot arrive by way of
 * a caller who forgot.
 *
 * ESPN names a European season by the calendar year it starts in — verified
 * against its own metadata, not assumed:
 *   eng.1/seasons/2025 -> "2025-26 English Premier League"
 *
 * ── Fail-soft, and cached ──
 *
 * ESPN is not a contracted API. It 403s, it returns "No stats found" for
 * seasons it has just listed, and the site.api host blocks this runner
 * permanently. So: every request is allowed to fail, the previous cache is kept
 * on failure, and a player already cached for this season is not re-fetched.
 * The tracker projects perfectly well with this file absent — it simply falls
 * back to the conservative prior, which is the behaviour it had before.
 */
import { getJSON } from './lib/http.mjs';
import { readJSON, writeJSONIfChanged } from './lib/io.mjs';
import { isAllowedSeason, seasonStartYear, CURRENT_SEASON } from '../js/seasons.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer';
const OUT = 'data/espn-history.json';
const PRIOR_SEASON = CURRENT_SEASON - 1; // 2025 => 2025/26

/**
 * Competitions whose minutes count as senior first-team evidence.
 *
 * Domestic top flights plus the Championship, because a promoted player's
 * 2025/26 was played there. Cups, friendlies, qualifiers and youth competitions
 * are excluded: they mix squad rotation and wildly uneven opposition into the
 * minutes figure, which is the one number this file exists to get right.
 */
const SENIOR_LEAGUES = new Set([
  'eng.1', 'eng.2', 'esp.1', 'ger.1', 'ita.1', 'fra.1', 'ned.1', 'por.1',
  'bel.1', 'sco.1', 'tur.1', 'aut.1', 'sui.1', 'den.1', 'gre.1', 'usa.1',
  'bra.1', 'arg.1', 'mex.1', 'jpn.1',
]);

const MAX_PLAYERS = Number(process.env.ESPN_HISTORY_MAX || 60);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const stat = (cats, cat, name) => {
  const c = cats.find((x) => x.name === cat);
  const s = c?.stats.find((x) => x.name === name);
  return s ? num(s.value) : null;
};

/** One season's line for one player, or null when ESPN has nothing usable. */
async function seasonLine(espnId, league, year) {
  // Belt and braces: never even request a season outside the window.
  if (!isAllowedSeason(year)) return null;
  const st = await getJSON(
    `${CORE}/leagues/${league}/seasons/${year}/types/1/athletes/${espnId}/statistics`,
    { browserUA: true },
  ).catch(() => null);
  const cats = st?.splits?.categories;
  if (!Array.isArray(cats) || !cats.length) return null;

  const minutes = stat(cats, 'general', 'minutes');
  const appearances = stat(cats, 'general', 'appearances');
  if (!(minutes > 0) || !(appearances > 0)) return null;

  return {
    season: year,
    competition: league,
    appearances,
    minutes,
    subIns: stat(cats, 'general', 'subIns') ?? 0,
    // Starts are not published directly; appearances minus substitute
    // appearances is the honest reconstruction, and it is the signal that
    // separates a 2,600-minute starter from a 1,000-minute impact substitute.
    starts: Math.max(0, appearances - (stat(cats, 'general', 'subIns') ?? 0)),
    goals: stat(cats, 'offensive', 'totalGoals') ?? 0,
    assists: stat(cats, 'offensive', 'goalAssists') ?? 0,
    shots: stat(cats, 'offensive', 'totalShots') ?? 0,
    shotsOnTarget: stat(cats, 'offensive', 'shotsOnTarget') ?? 0,
    tackles: stat(cats, 'defensive', 'totalTackles') ?? 0,
    interceptions: stat(cats, 'defensive', 'interceptions') ?? 0,
    clearances: stat(cats, 'defensive', 'totalClearance') ?? 0,
    saves: stat(cats, 'goalKeeping', 'saves') ?? 0,
    conceded: stat(cats, 'goalKeeping', 'goalsConceded') ?? 0,
    cleanSheets: stat(cats, 'goalKeeping', 'cleanSheet') ?? 0,
    yellowCards: stat(cats, 'general', 'yellowCards') ?? 0,
  };
}

/** Which senior competitions this athlete appears in. Discovery only. */
async function seniorLeagues(espnId) {
  const lg = await getJSON(`${CORE}/athletes/${espnId}/leagues?limit=60`, { browserUA: true })
    .catch(() => null);
  return (lg?.items || [])
    .map((i) => (String(i.$ref).match(/leagues\/([^?]+)/) || [])[1])
    .filter((s) => SENIOR_LEAGUES.has(s));
}

/* ------------------------------------------------------------------ */

const identity = await readJSON('data/identity/players.json');
const boot = await readJSON('data/bootstrap.json');
const prior = await readJSON('data/draft/prior-2526.json');

if (!identity?.players || !boot?.elements?.length) {
  console.warn('✗ no identity map or bootstrap — leaving any committed history untouched');
  process.exit(0);
}

const cache = (await readJSON(OUT).catch(() => null)) || { builtAt: null, season: PRIOR_SEASON, players: {} };
if (!isAllowedSeason(cache.season ?? PRIOR_SEASON)) cache.players = {};

/* Who needs this: a player the Premier League has no 2025/26 record of. Anyone
   with real FPL evidence already has better data than ESPN can offer, and
   FPL stays authoritative wherever the two overlap. */
const priorMins = (code) => num(prior?.players?.[code]?.minutes);
const needy = boot.elements
  .filter((e) => priorMins(e.code) < 450)
  .map((e) => ({ e, m: identity.players[e.code] }))
  .filter((x) => x.m?.espnId)
  .filter((x) => !cache.players[x.e.code])
  .sort((a, b) => b.e.now_cost - a.e.now_cost)
  .slice(0, MAX_PLAYERS);

console.log(`→ ESPN ${PRIOR_SEASON}/${String(PRIOR_SEASON + 1).slice(2)} history for ${needy.length} players `
  + `(${Object.keys(cache.players).length} already cached)`);

let added = 0; let empty = 0; let rejected = 0;
for (const { e, m } of needy) {
  const leagues = await seniorLeagues(m.espnId);
  const lines = [];
  for (const lg of leagues) {
    const line = await seasonLine(m.espnId, lg, PRIOR_SEASON);
    if (!line) continue;
    if (!isAllowedSeason(line.season)) { rejected += 1; continue; }
    lines.push(line);
  }
  if (!lines.length) {
    // Cache the miss too, so a player ESPN cannot help with is not re-probed
    // on every refresh for the rest of the season.
    cache.players[e.code] = { espnId: m.espnId, name: e.web_name, seasons: [], fetchedAt: new Date().toISOString() };
    empty += 1;
    continue;
  }
  // One player can have two competitions in a season after a winter move.
  lines.sort((a, b) => b.minutes - a.minutes);
  cache.players[e.code] = {
    espnId: m.espnId,
    name: e.web_name,
    match: m.method,
    confidence: m.confidence,
    seasons: lines,
    fetchedAt: new Date().toISOString(),
    source: 'sports.core.api.espn.com',
  };
  added += 1;
}

cache.builtAt = new Date().toISOString();
cache.season = PRIOR_SEASON;
cache.note = `Senior-competition ${PRIOR_SEASON}/${String(PRIOR_SEASON + 1).slice(2)} evidence only. `
  + 'Nothing older may be written here or read from it.';

/* Final gate before anything is committed. If a record for a disallowed season
   ever reaches this point the file is not written at all — a loud failure is
   better than quietly shipping evidence the model is forbidden to use. */
for (const [code, rec] of Object.entries(cache.players)) {
  for (const s of rec.seasons || []) {
    if (!isAllowedSeason(s.season)) {
      throw new Error(`refusing to write ${OUT}: player ${code} carries season ${s.season}, `
        + 'which is outside the model window');
    }
  }
}

await writeJSONIfChanged(OUT, cache);
const withEvidence = Object.values(cache.players).filter((p) => p.seasons?.length).length;
console.log(`✓ ${added} enriched, ${empty} had no usable ${PRIOR_SEASON}/${String(PRIOR_SEASON + 1).slice(2)} season`
  + `${rejected ? `, ${rejected} rejected by the season guard` : ''}`);
console.log(`  cache now holds ${Object.keys(cache.players).length} players, ${withEvidence} with evidence`);
